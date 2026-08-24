"""Player network — who a player has played with (teammates) and against
(opponents), in tournaments and league matches, aggregated with counts and
win rate.

Two data sources, both extensions of pages already scraped elsewhere:

  * dbv.turnier.de /player-profile/<id>/tournaments — already fetched by
    player.py's _parse_tournaments() for the "Tournaments played" tab. It
    also embeds every match the player has played, as repeated
    <div class="match"> blocks — one HTTP request covers a player's entire
    tournament match history. Each match's "H2H" link carries both sides'
    real sp_codes as query params, so identity is free here: no extra
    per-opponent fetch is needed to know who a tournament teammate/opponent
    actually is.
  * dbv.turnier.de /league/<league_guid>/player/<local_id> — one such link
    per league competition, captured by leagues.py's _scrape_leagues(). This
    "Spielübersicht" page lists every league fixture the player took part in
    for that whole competition. League opponents only expose a league-scoped
    local id + name here, and resolving that to a real dbv profile would cost
    one extra HTTP request per unknown person — by design (see
    .claude/rules/testing.md and the approved plan) we do NOT spend that
    cost. League peers are always shown by name only, linking out to
    dbv.turnier.de instead of the internal player page.

History is bounded to the last LOOKBACK_YEARS years on both sides to keep a
first-time computation cheap. The aggregated result is cached in Firestore
(player_network/{profile_id}) for a day; `force` bypasses that but still
only re-fetches what's in the lookback window — never a per-opponent scrape.
"""

import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

from bs4 import BeautifulSoup
from firebase_functions import https_fn

from app.scraping.analytics import bump_entity, bump_summary, name_key
from app.core.auth import rate_key
from app.core.cache_config import PLAYER_NETWORK_TTL
from app.core.common import BASE, COOKIES, MAX_WORKERS, _get
from app.core.firebase_app import db
from app.scraping.leagues import _scrape_leagues, _fetch_league_player_page
from app.scraping.player import _index_lookup, _parse_ddmmyyyy
from app.core.rate_limiting import check_rate_limit

LOOKBACK_YEARS = 3

_DISC_CODE = {
    "HD": "Doppel", "DD": "Doppel", "MX": "Mixed", "GD": "Mixed",
    "HE": "Einzel", "DE": "Einzel",
}


def _discipline_from_code(text):
    c = re.match(r"[A-Za-z]+", text or "")
    c = c.group(0).upper() if c else ""
    if c in _DISC_CODE:
        return _DISC_CODE[c]
    if c.endswith("D"):
        return "Doppel"
    if c.endswith("E"):
        return "Einzel"
    return "Mixed"


def _row_player_name(value_el):
    a = value_el.find("a")
    txt = (a.get_text(" ", strip=True) if a else value_el.get_text(" ", strip=True))
    return re.sub(r"\s*\[\d+\]\s*$", "", txt).strip()


# --------------------------------------------------------------------------- #
# Tournament matches — one page, every tournament, real sp_codes via H2H
# --------------------------------------------------------------------------- #

def _parse_tournament_matches(html, my_sp_code, my_name_key, cutoff_date):
    """Every match this player played across all their tournaments, from the
    single /player-profile/<id>/tournaments response.

    Returns [{tournament_id, tournament_name, date, discipline,
              teammates: [{name, sp_code, url}], opponents: [...],
              decided, won}]."""
    soup = BeautifulSoup(html, "html.parser")
    matches = []
    cur_tid = cur_tname = cur_date = cur_disc = None

    for el in soup.select("h4.media__title, h4.module-divider, div.match"):
        classes = el.get("class") or []
        if el.name == "h4" and "module-divider" in classes:
            cur_disc = _discipline_from_code(
                re.sub(r"^\s*Konkurrenz:\s*", "", el.get_text(" ", strip=True)))
            continue
        if el.name == "h4":
            a = el.find("a", href=re.compile(r"/sport/tournament\?id=", re.I))
            m = re.search(r"id=([0-9A-Fa-f-]{36})", a["href"]) if a else None
            cur_tid = m.group(1).upper() if m else None
            cur_tname = a.get_text(" ", strip=True) if a else None
            time_el = el.parent.select_one(".media__subheading--muted time") if el.parent else None
            cur_date = time_el["datetime"][:10] if time_el and time_el.get("datetime") else None
            cur_disc = None
            continue

        # el is a .match div
        if not cur_tid:
            continue
        if cutoff_date and cur_date:
            d = _parse_ddmmyyyy(cur_date)
            if d and d < cutoff_date:
                continue

        wrapper = el.select_one(".match__row-wrapper")
        if not wrapper:
            continue
        rows = wrapper.select(":scope > .match__row")
        if len(rows) != 2:
            continue

        sides = [[None, None], [None, None]]
        h2h = el.select_one(".match__btn-h2h")
        if h2h and h2h.get("href"):
            qs = parse_qs(urlsplit(h2h["href"]).query)
            sides[0] = [qs.get("T1P1MemberID", [None])[0], qs.get("T1P2MemberID", [None])[0]]
            sides[1] = [qs.get("T2P1MemberID", [None])[0], qs.get("T2P2MemberID", [None])[0]]

        my_idx = my_pos = None
        for i, ids in enumerate(sides):
            for j, sp in enumerate(ids):
                if sp and my_sp_code and sp == my_sp_code:
                    my_idx, my_pos = i, j
        if my_idx is None and my_name_key:
            for i, row in enumerate(rows):
                for j, v in enumerate(row.select(".match__row-title-value")):
                    if name_key(_row_player_name(v)) == my_name_key:
                        my_idx, my_pos = i, j
        if my_idx is None:
            continue  # can't tell which side is "me" — skip rather than miscount

        my_row, opp_row = rows[my_idx], rows[1 - my_idx]
        my_ids, opp_ids = sides[my_idx], sides[1 - my_idx]

        def _people(row, ids, skip_pos=None):
            out = []
            for i, v in enumerate(row.select(".match__row-title-value")):
                if i == skip_pos:
                    continue
                a = v.find("a")
                out.append({
                    "name": _row_player_name(v),
                    "sp_code": ids[i] if i < len(ids) else None,
                    "url": (BASE + a["href"]) if a and a.get("href") else None,
                })
            return out

        decided = el.select_one(".has-won") is not None
        won = "has-won" in (my_row.get("class") or [])
        matches.append({
            "tournament_id": cur_tid, "tournament_name": cur_tname, "date": cur_date,
            "discipline": cur_disc or "Doppel",
            "teammates": _people(my_row, my_ids, skip_pos=my_pos),
            "opponents": _people(opp_row, opp_ids),
            "decided": decided, "won": won if decided else None,
        })
    return matches


# --------------------------------------------------------------------------- #
# League matches — one page per league competition, name-only identity
# --------------------------------------------------------------------------- #

def _club_from_team(team_name):
    """"BV Aachen 2" -> "BV Aachen" (strip a trailing squad number/roman
    numeral) so the Network graph can group same-club teams together instead
    of splitting them by squad."""
    if not team_name:
        return None
    return re.sub(r"\s+(\d+|[IVXLCDM]+)$", "", team_name.strip()) or team_name.strip()


def _parse_league_matches(html, page_url, cutoff_date):
    """Every fixture on a /league/<lg>/player/<N> 'Spielübersicht' page.

    Returns [{date, discipline, teammates: [{name, url, club}],
              opponents: [{name, url, club}], decided, won}]. No sp_code —
    see module docstring. `club` is derived from the team name already on
    this page (see _club_from_team) — free, no extra request."""
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", class_="matches")
    if not table:
        return []

    # Row links are like "../player.aspx?id=...&player=N" — resolving that
    # relative to page_url per RFC 3986 gives a URL dbv's own site 404s on (a
    # genuine relative-link bug upstream, confirmed live). The path-style form
    # this exact page itself uses (/league/<lg>/player/<N>) is the one that
    # actually works, so rebuild it from the league guid + the row's local id
    # instead of trusting the href's path.
    lg_m = re.search(r"/league/([0-9A-F-]+)/", page_url, re.I)
    league_guid = lg_m.group(1) if lg_m else None

    out = []
    for tr in table.select("tbody tr"):
        tds = tr.find_all("td", recursive=False)
        if len(tds) < 6:
            continue
        date_td, disc_td, _staffel_td, heim_td, _sep_td, gast_td = tds[:6]
        dm = re.search(r"(\d{2}\.\d{2}\.\d{4})", date_td.get_text(" ", strip=True))
        date_obj = _parse_ddmmyyyy(dm.group(1)) if dm else None
        if cutoff_date and date_obj and date_obj < cutoff_date:
            continue
        discipline = _discipline_from_code(disc_td.get_text(strip=True))

        def _team(td):
            team_a = td.find("a", class_="teamname")
            club = _club_from_team(team_a.get_text(" ", strip=True)) if team_a else None
            people = []
            for a in td.find_all("a"):
                if "teamname" in (a.get("class") or []):
                    continue
                pid_m = re.search(r"[?&]player=(\d+)", a.get("href") or "")
                url = (f"{BASE}/league/{league_guid}/player/{pid_m.group(1)}"
                       if pid_m and league_guid else None)
                people.append({
                    "name": a.get_text(" ", strip=True),
                    "mine": "highlighted" in (a.get("class") or []),
                    "won": a.find_parent("strong") is not None,
                    "url": url,
                    "club": club,
                })
            return people

        heim, gast = _team(heim_td), _team(gast_td)
        if any(p["mine"] for p in heim):
            my_team, opp_team = heim, gast
        elif any(p["mine"] for p in gast):
            my_team, opp_team = gast, heim
        else:
            continue  # couldn't tell which side is "me" — skip

        decided = any(p["won"] for p in heim) or any(p["won"] for p in gast)
        out.append({
            "date": date_obj.isoformat() if date_obj else None,
            "discipline": discipline,
            "teammates": [p for p in my_team if not p["mine"]],
            "opponents": opp_team,
            "decided": decided, "won": (any(p["won"] for p in my_team) if decided else None),
        })
    return out


# --------------------------------------------------------------------------- #
# Fetch + aggregate + callable
# --------------------------------------------------------------------------- #

def _fetch_tournament_matches(profile_id, my_sp_code, my_name_key, cutoff_date):
    try:
        resp = _get(f"{BASE}/player-profile/{profile_id}/tournaments", cookies=COOKIES)
        resp.raise_for_status()
        return _parse_tournament_matches(resp.text, my_sp_code, my_name_key, cutoff_date)
    except Exception as e:
        print(f"network: tournament fetch error: {e}")
        return []


def _fetch_league_matches(profile_id, cutoff_date):
    cutoff_year = cutoff_date.year
    try:
        current, years = _scrape_leagues(profile_id)
    except Exception as e:
        print(f"network: league membership error: {e}")
        return []

    season_sets = [current]
    for y in years:
        try:
            if int(y) >= cutoff_year:
                season_sets.append(_scrape_leagues(profile_id, y)[0])
        except Exception as e:
            print(f"network: league year {y} error: {e}")

    urls = {lg["match_url"] for leagues in season_sets for lg in (leagues or []) if lg.get("match_url")}
    if not urls:
        return []

    out = []

    def _one(url):
        html = _fetch_league_player_page(url)
        return _parse_league_matches(html, url, cutoff_date)

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs = {pool.submit(_one, u): u for u in urls}
        for f in as_completed(futs):
            try:
                out.extend(f.result())
            except Exception as e:
                print(f"network: league match fetch error: {e}")
    return out


def _aggregate(tournament_matches, league_matches):
    # A league appearance never carries a sp_code (see module docstring), but
    # the SAME real person may also show up as a tournament peer, where the
    # H2H link does give one. Build a name -> sp_code map from every
    # tournament peer first, so a league-only sighting of that same name
    # still merges into one entry instead of creating a duplicate "no id"
    # entry alongside the identified one.
    known_sp = {}
    for m in tournament_matches:
        for p in m["teammates"] + m["opponents"]:
            if p.get("sp_code"):
                known_sp[name_key(p["name"])] = p["sp_code"]

    # Second fallback for a league-only peer this app has simply seen before
    # (their own profile viewed, or a tournament they were analysed in) —
    # player_index is a plain Firestore equality read (no extra scrape), so
    # this stays free even though it wasn't a teammate/opponent match here.
    # Memoized per name_key since the same peer can recur across many matches.
    index_sp = {}

    def _known_sp(nk):
        if nk in index_sp:
            return index_sp[nk]
        hit = _index_lookup(name_search=nk)
        sp = (hit or {}).get("sp_code")
        index_sp[nk] = sp
        return sp

    teammates, opponents = {}, {}

    def _bucket(d, peer, discipline, decided, won, date):
        nk = name_key(peer["name"])
        sp = peer.get("sp_code") or known_sp.get(nk) or _known_sp(nk)
        key = sp or ("name:" + nk)
        e = d.get(key)
        if e is None:
            e = d[key] = {
                "key": key, "sp_code": sp, "name": peer["name"], "club": peer.get("club"),
                "url": peer.get("url"), "played": 0, "wins": 0, "losses": 0,
                "disciplines": {"Einzel": 0, "Doppel": 0, "Mixed": 0}, "last_played": None,
            }
        e["played"] += 1
        e["disciplines"][discipline] = e["disciplines"].get(discipline, 0) + 1
        if decided:
            e["wins" if won else "losses"] += 1
        if peer.get("name"):
            e["name"] = peer["name"]
        # club is only known from league matches (see _club_from_team); a
        # tournament sighting of the same person carries none, so only
        # overwrite when this sighting actually has one.
        if peer.get("club"):
            e["club"] = peer["club"]
        # Once identified (sp_code known), the frontend always links
        # internally by sp_code and ignores `url` — so `url` only needs to
        # stay meaningful for the name-only case, where it's the external
        # dbv fallback link.
        if not sp and peer.get("url"):
            e["url"] = peer["url"]
        if date and (not e["last_played"] or date > e["last_played"]):
            e["last_played"] = date

    for m in tournament_matches:
        for p in m["teammates"]:
            _bucket(teammates, p, m["discipline"], m["decided"], m["won"], m["date"])
        for p in m["opponents"]:
            _bucket(opponents, p, m["discipline"], m["decided"], m["won"], m["date"])
    for m in league_matches:
        for p in m["teammates"]:
            _bucket(teammates, p, m["discipline"], m["decided"], m["won"], m["date"])
        for p in m["opponents"]:
            _bucket(opponents, p, m["discipline"], m["decided"], m["won"], m["date"])

    def _finish(d):
        out = list(d.values())
        for e in out:
            decided_n = e["wins"] + e["losses"]
            e["winrate"] = round(100 * e["wins"] / decided_n, 1) if decided_n else None
        out.sort(key=lambda e: e["played"], reverse=True)
        return out

    return _finish(teammates), _finish(opponents)


def _compute_network(profile_id, sp_code, name):
    cutoff_date = datetime.now(timezone.utc).date() - timedelta(days=365 * LOOKBACK_YEARS)
    my_name_key = name_key(name) if name else None

    tmatches = _fetch_tournament_matches(profile_id, sp_code or None, my_name_key, cutoff_date)
    lmatches = _fetch_league_matches(profile_id, cutoff_date)
    teammates, opponents = _aggregate(tmatches, lmatches)

    result = {
        "teammates": teammates, "opponents": opponents,
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "stats": {"tournament_matches": len(tmatches), "league_matches": len(lmatches)},
    }
    if db:
        try:
            db.collection("player_network").document(profile_id).set({
                **result,
                "expires_at": datetime.now(timezone.utc) + PLAYER_NETWORK_TTL,
            })
        except Exception:
            pass
    return {"profile_id": profile_id, **result}


@https_fn.on_call()
def get_player_network(req: https_fn.CallableRequest) -> dict:
    """Teammates + opponents (with counts and win rate) from this player's
    tournament and league matches over the last few years. Cached ~1 day.

    profile_id is normally required (it's the dbv key everything below is
    keyed on), but the Network graph's click-to-expand needs to look someone
    up from just the sp_code a teammate/opponent entry carries — so when
    profile_id is missing, try to resolve one from sp_code via player_index
    first (a plain Firestore read, no extra scrape)."""
    try:
        d = req.data or {}
        sp_code = (d.get("sp_code") or "").strip()
        name = (d.get("name") or "").strip()
        m = re.search(r"([0-9a-fA-F-]{36})", d.get("profile_id") or "")
        profile_id = m.group(1).upper() if m else None
        if not profile_id and sp_code:
            hit = _index_lookup(sp_code=sp_code)
            profile_id = (hit or {}).get("profile_id")
        if not profile_id:
            return {"error": "No dbv profile found for this player yet — analyse one of their tournaments or open their profile once first."}

        force = bool(d.get("force"))
        if force and not check_rate_limit(rate_key(req), "force_network", 10, 3600000):
            return {"error": "Live update limit reached. Please wait before refreshing again."}
        if not check_rate_limit(rate_key(req), "get_player_network", 60, 3600000):
            return {"error": "You're looking up players too quickly. Please wait a bit."}

        if db and not force:
            try:
                snap = db.collection("player_network").document(profile_id).get()
                if snap.exists:
                    data = snap.to_dict()
                    if datetime.now(timezone.utc) < data["expires_at"]:
                        return {"profile_id": profile_id, "teammates": data["teammates"], "opponents": data["opponents"],
                                "computed_at": data["computed_at"], "stats": data.get("stats", {})}
            except Exception:
                pass

        authed = req.auth is not None
        bump_summary(["networkQueries"], authed)
        bump_entity("usage_players", profile_id, authed, name=name or None)

        return _compute_network(profile_id, sp_code, name)
    except Exception as e:
        import traceback
        print(f"get_player_network error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}
