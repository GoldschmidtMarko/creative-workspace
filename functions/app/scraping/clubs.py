"""Club-focused insights — badminton-bax.de's "Verein" roster plus a
derived view of a club's teams and their league standings over time.

badminton-bax.de exposes a real club lookup
(index.php/bax-portal/verein?verein=<name>&verein_start=anzeigen) that
returns a season+discipline roster (name, Niveau, win/loss, BAX) once a
club name resolves uniquely, or a "Bitte auswählen!" list of candidate
clubs (each carrying a durable `cl_code`) when it doesn't. See
_parse_club_page for the exact markup this depends on.

dbv.turnier.de has no NAME-based "find this club" search (its own
`/find/club` is a *tournament-organizer* search, not a participant-club
one) — but it does have a club-SCOPED team list once you already know its
internal identity: sport/clubteams.aspx?id=<league_guid>&cid=<dbv club id>
lists exactly that club's own teams for one season (name, division, no
name-matching or misresolution risk, since every row already IS that
club's own team), and sport/clubstandings.aspx (same id/cid) gives every
one of those teams' real standing on the same page. See
_fetch_club_teams_page / _fetch_club_standings_page.

The one thing still needed to get IN is a "door": one real (league_guid,
team_id) belonging to this club, which only a resolved roster player's own
/leagues page can provide (reusing player.py's name-based resolution
machinery + leagues._scrape_leagues — see _find_club_anchor). Unlike the
per-player aggregation this used to do, only ONE resolved player needs to
land on a genuine team of this club; once in, the rest of the roster is
irrelevant — a lagging or misresolved player elsewhere on the roster can
no longer leak a stray/defunct team into the result (confirmed live: SV
Bergfried Lev., cl_code 01-0163 — the old approach dragged in a defunct
"SV Bergfried Lev. 7" Kreisklasse team from one inactive rostered player's
own stale 2024-25 /leagues page; the real 2026-27 clubteams.aspx list has
no such team at all).
"""

import re
import hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from bs4 import BeautifulSoup
from firebase_functions import https_fn

from app.scraping.analytics import bump_entity, bump_summary, name_key, upsert_player_index
from app.core.auth import rate_key
from app.scraping.bax import _bax_update_date
from app.core.cache_config import CLUB_ROSTER_FALLBACK_TTL, CLUB_SEARCH_TTL, CLUB_TEAMS_FALLBACK_TTL
from app.core.common import BASE, COOKIES, HEADERS, MAX_WORKERS, _get
from app.core.firebase_app import db
from app.scraping.leagues import _league_tier, _leagues_update_date, _scrape_leagues
from app.scraping.player import _cached_search_players, _index_lookup
from app.core.rate_limiting import check_rate_limit

BAX_VEREIN_URL = "https://www.badminton-bax.de/index.php/bax-portal/verein"
_DISCIPLINE_CODES = {"Einzel": "e", "Doppel": "d", "Mixed": "x"}
_ANCHOR_TRY_LIMIT = 5  # resolved roster players to try before giving up on finding a real team of this club


# --------------------------------------------------------------------------- #
# Season code helpers ("2526" <-> "2025/26"). badminton-bax.de's own season
# cutover doesn't line up with a simple calendar guess (confirmed live: on
# 2026-09-06 the site still reported "2025/26" as current), so the *current*
# season always comes from the page itself (see _parse_club_page /
# _fetch_club_roster) — these helpers only ever offset a season we already
# have, or convert to/from the `saison_n` query param.
# --------------------------------------------------------------------------- #

def _season_code_from_label(label):
    m = re.match(r"(\d{4})/(\d{2})", (label or "").strip())
    return f"{int(m.group(1)) % 100:02d}{m.group(2)}" if m else None


def _season_offset(label, n):
    """"2025/26" offset by n seasons back -> "2023/24" (n=2)."""
    m = re.match(r"(\d{4})/(\d{2})", (label or "").strip())
    if not m:
        return None
    start = int(m.group(1)) - n
    return f"{start}/{(start + 1) % 100:02d}"


# --------------------------------------------------------------------------- #
# badminton-bax.de Verein: search, resolve, roster
# --------------------------------------------------------------------------- #

def _parse_roster_rows(table):
    """One tabelle3 roster -> [{sp_code, last_name, first_name, gender,
    birth_year, won, lost, winrate, bax}]. Column order is driven by which
    optional columns the request checked (see _fetch_club_roster, which
    always requests SpielerID + Jahrgang instead of the site's defaults):
    gender-icon, marker, SpielerID, Name, Vorname, Jahrgang, Alt, Erfolg
    ("W/T"), BAX — confirmed live (a plain `verein_start`/`zeig_verein`
    request ignores the check_*_v params entirely; only the "aktualisieren"
    refresh (`neu_liste`) submit respects a custom column set). SpielerID is
    the same sp_code badminton-bax.de/player.html and this app's own
    player.html?sp= use, so a roster row can deep-link straight to a
    player's profile with no name-search round trip.

    Rows are grouped by gender via a rowspan'd icon cell that BeautifulSoup
    doesn't reconstruct (only the first row of each gender block has the
    <img alt="w"|"m">), but every data row's own <tr class="Fx"|"Mx"> (age
    category as the second letter, gender as the first — confirmed against
    several real rosters) carries gender regardless of row position. Header
    and blank separator rows have no class at all, so filtering on that
    conveniently skips both.
    """
    rows = []
    for tr in table.find_all("tr"):
        row_class = tr.get("class")
        if not row_class:
            continue
        gender = "w" if row_class[0].startswith("F") else ("m" if row_class[0].startswith("M") else None)
        cells = tr.find_all("td")
        if len(cells) < 9:
            continue
        sp_code = cells[2].get_text(strip=True)
        last = cells[3].get_text(" ", strip=True)
        first = cells[4].get_text(" ", strip=True)
        if not last and not first:
            continue
        jahrgang = cells[5].get_text(strip=True)
        erfolg = cells[7].get_text(strip=True)
        bax = cells[8].get_text(strip=True)
        # "Erfolg" is "wins/TOTAL games", not "wins/losses" — confirmed
        # against badminton-bax.de's own help text ("5/10 steht für 5 Siege
        # aus 10 Spielen" = "5 wins out of 10 games"). Dividing by won+total
        # here instead of won+lost would silently halve the win rate.
        wl = re.match(r"(\d+)\s*/\s*(\d+)", erfolg)
        won = int(wl.group(1)) if wl else None
        total = int(wl.group(2)) if wl else None
        lost = (total - won) if won is not None and total is not None else None
        rows.append({
            "sp_code": sp_code or None,
            "last_name": last, "first_name": first, "gender": gender,
            "birth_year": int(jahrgang) if jahrgang.isdigit() else None,
            "won": won, "lost": lost,
            "winrate": round(100 * won / total, 1) if won is not None and total else None,
            "bax": int(bax) if bax.isdigit() else None,
        })
    return rows


def _parse_club_page(html):
    """One bax-portal/verein response -> (club_or_None, candidates, rows).

    Three shapes, distinguished by what's on the page (see module docstring):
      * ambiguous match  -> a "Bitte auswählen!" form of `cl_code` radios;
        each radio's label is "<verband-abbr> <club name>" (order/boldness of
        the two differs from the resolved header below, so we don't rely on
        which one is <b> — just split off the first whitespace-separated
        token and keep the rest).
      * resolved, has data -> a `span.uber2` header ("<verband> <b>Club
        Name</b> <Discipline> <Season>") plus a `table.tabelle3` roster.
      * resolved, no data for this discipline/season -> the same header, but
        no tabelle3 (just an "Es wurden keine BAX Werte gefunden!" message) —
        still a valid resolution, just with an empty roster.
    """
    soup = BeautifulSoup(html, "html.parser")

    radios = soup.find_all("input", {"name": "cl_code", "type": "radio"})
    if radios:
        candidates = []
        for radio in radios:
            label = radio.find_parent("label")
            text = label.get_text(" ", strip=True) if label else ""
            parts = text.split(None, 1)
            name = parts[1] if len(parts) > 1 else text
            if name:
                candidates.append({"cl_code": radio.get("value"), "name": name})
        return None, candidates, []

    header = soup.find("span", class_="uber2")
    cl_code_input = soup.find("input", {"name": "cl_code", "type": "hidden"})
    if not header or not cl_code_input or not cl_code_input.get("value"):
        return None, [], []

    bold = header.find("b")
    name = bold.get_text(strip=True) if bold else ""
    season_m = re.search(r"(\d{4}/\d{2})", header.get_text(" ", strip=True))
    club = {"cl_code": cl_code_input["value"], "name": name,
            "season": season_m.group(1) if season_m else None}

    table = soup.find("table", class_="tabelle3")
    rows = _parse_roster_rows(table) if table else []
    return club, [], rows


def _fetch_club_page(params, disziplin=None, season_code=None):
    q = dict(params)
    if disziplin:
        q["disziplin"] = disziplin
    if season_code:
        q["saison_n"] = season_code
    resp = _get(BAX_VEREIN_URL, params=q, headers=HEADERS)
    resp.raise_for_status()
    return _parse_club_page(resp.text)


def _search_club(query):
    """Resolve a free-text club name. Cached by query text — the same
    free-text search (e.g. from the club search box) recurs often."""
    key = hashlib.md5(query.lower().encode()).hexdigest()
    if db:
        try:
            snap = db.collection("club_search_cache").document(key).get()
            if snap.exists:
                data = snap.to_dict()
                if datetime.now(timezone.utc) < data["expires_at"]:
                    return data.get("club"), data.get("candidates", [])
        except Exception:
            pass

    club, candidates, _rows = _fetch_club_page({"verein": query, "verein_start": "anzeigen"})
    if db:
        try:
            db.collection("club_search_cache").document(key).set({
                "club": club, "candidates": candidates,
                "expires_at": datetime.now(timezone.utc) + CLUB_SEARCH_TTL,
            })
        except Exception:
            pass
    return club, candidates


def _fetch_club_roster(cl_code, season_code=None):
    """A club's full roster (all three disciplines) for one season, keyed by
    the durable cl_code so re-navigating to an already-resolved club never
    needs the free-text search again. The season label is read back from the
    page itself (see _parse_club_page) rather than computed from today's
    date — badminton-bax.de's own season cutover doesn't line up with a
    simple calendar guess, but every resolved response (even an empty-roster
    one — see module docstring) carries its season in the header. Returns
    (name, season_label, {category: [rows]})."""
    cache_key = f"{cl_code}_{season_code or 'current'}"
    site_date = _bax_update_date()
    if db:
        try:
            snap = db.collection("club_roster_cache").document(cache_key).get()
            if snap.exists:
                data = snap.to_dict()
                if site_date:
                    fresh = data.get("bax_date") == site_date
                else:
                    exp = data.get("expires_at")
                    fresh = exp is not None and datetime.now(timezone.utc) < exp
                if fresh:
                    return data.get("name"), data.get("season"), data.get("categories", {})
        except Exception:
            pass

    def _one(cat, code):
        # "neu_liste" (the "aktualisieren" refresh submit) is the only submit
        # that respects a custom check_*_v column set — verein_start/
        # zeig_verein always fall back to the site's own default columns
        # (Alt/Niveau/Erfolg), confirmed live. SpielerID + Jahrgang instead
        # of Niveau (sp_code enables a direct player.html deep-link; birth
        # year is more useful than the internal seeding number) needs this
        # exact param combination.
        club, _candidates, rows = _fetch_club_page(
            {"cl_code": cl_code, "neu_liste": "", "order_v": "ob",
             "check_id_v": "on", "check_jahrgang_v": "on", "check_alt_v": "on", "check_erfolg_v": "on"},
            disziplin=code, season_code=season_code)
        return cat, club, rows

    name, season, categories = None, None, {}
    with ThreadPoolExecutor(max_workers=len(_DISCIPLINE_CODES)) as pool:
        futs = [pool.submit(_one, cat, code) for cat, code in _DISCIPLINE_CODES.items()]
        for f in as_completed(futs):
            cat, club, rows = f.result()
            categories[cat] = rows
            if club and club.get("name"):
                name = club["name"]
            if club and club.get("season"):
                season = club["season"]

    if db:
        try:
            db.collection("club_roster_cache").document(cache_key).set({
                "season": season,
                "name": name, "categories": categories, "bax_date": site_date,
                "expires_at": datetime.now(timezone.utc) + CLUB_ROSTER_FALLBACK_TTL,
            })
        except Exception:
            pass
    return name, season, categories


# --------------------------------------------------------------------------- #
# Club teams + league standings, derived from the roster + leagues.py
# --------------------------------------------------------------------------- #

def _resolve_roster_profile_ids(full_names, club_name):
    """Best-effort name -> dbv profile_id for a list of roster names. Tries
    the free player_index read first; only falls back to a live dbv name
    search for names not already known. Skips (rather than guesses) a name
    that matches more than one unrelated dbv profile with no club match —
    the same "skip rather than guess" rule player.py uses throughout, since
    a wrong guess here would misattribute a stranger's league history to
    this club. Returns [(full_name, profile_id), ...] for resolved names
    only."""
    resolved, unresolved = [], []
    for full_name in full_names:
        hit = _index_lookup(name_search=name_key(full_name))
        if hit and hit.get("profile_id"):
            resolved.append((full_name, hit["profile_id"]))
        else:
            unresolved.append(full_name)

    def _resolve_one(full_name):
        last = full_name.split()[-1] if full_name.split() else full_name
        try:
            candidates = _cached_search_players(last)
        except Exception as e:
            print(f"club roster resolution error for {full_name!r}: {e}")
            return full_name, None
        nk = name_key(full_name)
        matches = [c for c in candidates if name_key(c.get("name") or "") == nk]
        if len(matches) > 1:
            matches = [c for c in matches
                       if c.get("club") and club_name and club_name.lower() in c["club"].lower()]
        if len(matches) != 1:
            return full_name, None
        m = matches[0]
        upsert_player_index(m["profile_id"], sp_code=m.get("sp_code"), name=m.get("name") or full_name)
        return full_name, m["profile_id"]

    if unresolved:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            for full_name, profile_id in pool.map(_resolve_one, unresolved):
                if profile_id:
                    resolved.append((full_name, profile_id))
    return resolved


def _belongs_to_club(team_name, club_name):
    """A team's name starts with the club's own name (dbv's convention is
    "<Club Name> <squad number>", e.g. "BV Aachen 2") — the cheap, reliable
    way to tell an actual club team apart from a stray unrelated entry a
    misresolved player's own league history can otherwise drag in (a wrong
    same-name-different-person match, or a one-off individual-event page
    leagues.py mis-parses as a pseudo-league — see its own module note).

    Compared token-by-token rather than as one prefix string, because each
    league's own admin types its teams' names independently and doesn't
    consistently spell out the club name the same way badminton-bax.de does
    — confirmed live for SV Bergfried Lev. (cl_code 01-0163): its OWN
    roster page calls it "SV Bergfried Lev.", but its real dbv divisions
    spell the very same club "SV Bergfried Leverkusen" in most divisions
    and "SV Bergfried Lev." (badminton-bax's abbreviation) in a few others,
    all for the current season. A whole-string prefix check only matched
    the abbreviated form and silently dropped every "Leverkusen"-spelled
    team — token-prefix matching (each club-name word is a PREFIX of the
    corresponding team-name word, e.g. "lev" of "leverkusen") recognizes
    both spellings, in either direction of abbreviation."""
    if not team_name or not club_name:
        return False
    club_tokens = [t.rstrip(".").lower() for t in club_name.strip().split()]
    team_tokens = [t.lower() for t in team_name.strip().split()]
    if len(team_tokens) < len(club_tokens):
        return False
    return all(team_tok.startswith(club_tok) or club_tok.startswith(team_tok)
               for club_tok, team_tok in zip(club_tokens, team_tokens))


def _squad_suffix(team_name, club_name):
    """The squad label after a team's own club-name prefix — "4" from "SV
    Bergfried Leverkusen 4", "J2" from "SV Bergfried Lev. J2" — for ordering
    squads by that label instead of by the team's full name. Sorting on the
    full name instead puts a team ahead or behind its siblings based on
    which of the club's own spellings ITS OWN division happened to use (see
    _belongs_to_club: "SV Bergfried Lev. J2" sorts before "SV Bergfried
    Leverkusen 4" purely because "." < "e", even though J2 has no real
    claim to coming first). Falls back to the full name if the club-name
    prefix can't be matched, which shouldn't happen for anything that's
    already passed _belongs_to_club."""
    if not team_name or not club_name:
        return team_name or ""
    club_tokens = [t.rstrip(".").lower() for t in club_name.strip().split()]
    team_tokens = team_name.strip().split()
    if len(team_tokens) <= len(club_tokens):
        return team_name
    for club_tok, team_tok in zip(club_tokens, team_tokens):
        tt = team_tok.rstrip(".").lower()
        if not (tt.startswith(club_tok) or club_tok.startswith(tt)):
            return team_name
    return " ".join(team_tokens[len(club_tokens):])


def _squad_sort_key(suffix):
    """Order a squad suffix (see _squad_suffix) numbered squads first, in
    numeric order ("1", "2", "4" ...), then lettered squads grouped by
    their own letter and numbered within it ("J1", "J2", "M1", "S1" ...),
    so a club's plain-numbered team doesn't get sorted after a youth/mixed
    squad just because its team name happened to sort alphabetically
    earlier."""
    m = re.match(r"^(\d+)$", suffix or "")
    if m:
        return (0, int(m.group(1)), "")
    m = re.match(r"^([A-Za-z]+)\s*(\d+)$", suffix or "")
    if m:
        return (1, m.group(1).upper(), int(m.group(2)))
    return (2, suffix or "", 0)


def _team_of_club(leagues_list, club_name):
    """The first division in a /leagues response that's genuinely this
    club's own team (see _belongs_to_club) — used only to find a real
    (league_guid, team_id) to anchor off of (see _find_club_anchor), not to
    source any display data itself. Returns (league_guid, team_id, season)
    or None."""
    for lg in leagues_list or []:
        for div in lg.get("divisions", []) or []:
            team = div.get("team")
            if team and div.get("team_id") and div.get("league_guid") and _belongs_to_club(team, club_name):
                return div["league_guid"], div["team_id"], lg.get("season")
    return None


def _find_club_anchor(resolved, club_name, slot):
    """One (league_guid, team_id, season) anchor into dbv's own club-scoped
    pages (see module docstring), from a handful of resolved roster
    players whose own /leagues page actually names a team of this club.

    `slot`: 0 = current season — every candidate's own "current" pointer
    can point at a DIFFERENT real season (confirmed live: mid-transition, a
    rostered player who hasn't played yet this season still reads last
    season as their own "current" while another player's own squad has
    already started the new one), so all tried candidates are checked and
    the FRESHEST season among their hits wins — stopping at the first hit
    could otherwise anchor on a lagging player and make the whole club look
    a season behind one that's already live on dbv. 1/2 = that many seasons
    back, taken from each candidate's own `years` tabs — the 1st/2nd
    DISTINCT season different from their own current (a dbv year tab can
    just alias the current season: confirmed live, on 2026-09-06 a
    player's years[0] was "2026" and returned identical data to the
    unseasoned "current" fetch) — stops at the first hit, since there's no
    single "freshest" notion for a season that's already in the past."""
    if slot == 0:
        hits = []
        for _name, profile_id in resolved[:_ANCHOR_TRY_LIMIT]:
            try:
                current, _years = _scrape_leagues(profile_id)
            except Exception as e:
                print(f"club teams: league fetch error for {profile_id}: {e}")
                continue
            hit = _team_of_club(current, club_name)
            if hit:
                hits.append(hit)
        return max(hits, key=lambda h: h[2] or "") if hits else None

    for _name, profile_id in resolved[:_ANCHOR_TRY_LIMIT]:
        try:
            current, years = _scrape_leagues(profile_id)
        except Exception as e:
            print(f"club teams: league fetch error for {profile_id}: {e}")
            continue
        current_season = next((lg.get("season") for lg in current if lg.get("season")), None)
        seen = {current_season} if current_season else set()
        distinct_prior = []
        for y in years or []:
            try:
                past, _ = _scrape_leagues(profile_id, y)
            except Exception as e:
                print(f"club teams: league fetch error for {profile_id}/{y}: {e}")
                continue
            past_season = next((lg.get("season") for lg in past if lg.get("season")), None)
            if past_season in seen:
                continue
            seen.add(past_season)
            distinct_prior.append(past)
            if len(distinct_prior) >= 2:   # slot is only ever 1 or 2 here
                break
        idx = slot - 1
        if idx < len(distinct_prior):
            hit = _team_of_club(distinct_prior[idx], club_name)
            if hit:
                return hit
    return None


def _fetch_club_dbv_id(league_guid, team_id):
    """dbv's own internal club id (the "cid"/"club" query param on its
    club-scoped pages — clubteams.aspx, clubstandings.aspx, club.aspx,
    etc.), read off any one real team of this club's own team page. dbv has
    no name-based club lookup (see module docstring), so this is the only
    way in: once we have ANY real team of this club, its own page links
    back to the club's "Allgemein" page carrying this id."""
    try:
        resp = _get(f"{BASE}/league/{league_guid}/team/{team_id}", cookies=COOKIES)
        resp.raise_for_status()
        m = re.search(r"club\.aspx\?id=[0-9A-Fa-f-]+(?:&amp;|&)club=(\d+)", resp.text)
        return m.group(1) if m else None
    except Exception as e:
        print(f"club dbv-id fetch error ({league_guid}/{team_id}): {e}")
        return None


def _parse_club_teams_page(html):
    """dbv's own club-scoped team list (sport/clubteams.aspx?id=<league_guid>
    &cid=<dbv club id>) — the authoritative list of exactly this club's own
    teams for one season, straight from dbv (see module docstring for why
    this replaced resolving individual roster players). Returns
    [{team, team_id, division, tier, abbr}]."""
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", class_="clubteams")
    if not table:
        return []
    out = []
    for tr in (table.find("tbody") or table).find_all("tr"):
        cells = tr.find_all("td")
        if len(cells) < 2:
            continue
        team_link = cells[0].find("a")
        if not team_link:
            continue
        m = re.search(r"[?&]team=(\d+)", team_link.get("href") or "")
        if not m:
            continue
        division_link = cells[1].find("a")
        division_text = division_link.get_text(" ", strip=True) if division_link else cells[1].get_text(" ", strip=True)
        # Strips a leading "(<n>) " group/pool code, same as leagues.py's
        # own division parsing (see its "(007)" group-code note).
        division = re.sub(r"^.*\(\d+\)\s*", "", division_text).strip()
        abbr, tier = _league_tier(division)
        out.append({
            "team": team_link.get_text(" ", strip=True), "team_id": m.group(1),
            "division": division, "tier": tier, "abbr": abbr,
        })
    return out


def _fetch_club_teams_page(league_guid, cid):
    try:
        resp = _get(f"{BASE}/sport/clubteams.aspx", params={"id": league_guid, "cid": cid}, cookies=COOKIES)
        resp.raise_for_status()
        return _parse_club_teams_page(resp.text)
    except Exception as e:
        print(f"club teams page fetch error ({league_guid}/{cid}): {e}")
        return []


def _parse_club_standings_page(html, team_ids):
    """Every one of THIS club's own rows across every division's table on
    dbv's own club standings page (sport/clubstandings.aspx?id=<league_guid>
    &cid=<dbv club id>) — one table per division, each listing every
    competing club in it, matched down to just this club's own rows by
    team_id (from _fetch_club_teams_page) rather than by name. Same row
    shape (rank/GEW/REM/VER) as a single team's own standings page — just
    every one of this club's divisions on one page instead of one fetch
    per team. Returns {team_id: {standing, won, drawn, lost}}."""
    soup = BeautifulSoup(html, "html.parser")
    needle = re.compile(r"[?&]team=(\d+)")
    out = {}
    for table in soup.find_all("table", class_="ruler"):
        for tr in table.find_all("tr"):
            a = tr.find("a", href=needle)
            if not a:
                continue
            team_id = needle.search(a["href"]).group(1)
            if team_id not in team_ids:
                continue
            cells = tr.find_all("td")
            if len(cells) < 9:
                continue
            rank = cells[0].get_text(strip=True)
            gew = cells[6].get_text(strip=True)
            rem = cells[7].get_text(strip=True)
            ver = cells[8].get_text(strip=True)
            out[team_id] = {
                "standing": rank or None,
                "won": int(gew) if gew.isdigit() else None,
                "drawn": int(rem) if rem.isdigit() else None,
                "lost": int(ver) if ver.isdigit() else None,
            }
    return out


def _fetch_club_standings_page(league_guid, cid, team_ids):
    try:
        resp = _get(f"{BASE}/sport/clubstandings.aspx", params={"id": league_guid, "cid": cid}, cookies=COOKIES)
        resp.raise_for_status()
        return _parse_club_standings_page(resp.text, team_ids)
    except Exception as e:
        print(f"club standings page fetch error ({league_guid}/{cid}): {e}")
        return {}


def _club_teams_for_slot(club_name, full_names, slot):
    """One season's worth of this club's teams with real standings, read
    straight from dbv's own club-scoped pages (see module docstring) rather
    than assembled from individual roster players. `slot`: 0 = current
    season, 1/2 = that many seasons back (see _find_club_anchor). Returns
    (season_label, [{team, division, tier, abbr, standing, won, drawn,
    lost, url}]), sorted by tier then squad (see _squad_sort_key)."""
    resolved = _resolve_roster_profile_ids(full_names, club_name)
    anchor = _find_club_anchor(resolved, club_name, slot)
    if not anchor:
        return None, []
    league_guid, team_id, season = anchor

    cid = _fetch_club_dbv_id(league_guid, team_id)
    if not cid:
        return season, []

    club_teams = _fetch_club_teams_page(league_guid, cid)
    if not club_teams:
        return season, []
    team_ids = {t["team_id"] for t in club_teams}
    standings = _fetch_club_standings_page(league_guid, cid, team_ids)

    teams = []
    for t in club_teams:
        st = standings.get(t["team_id"]) or {}
        teams.append({
            "team": t["team"], "division": t["division"], "tier": t["tier"], "abbr": t["abbr"],
            "standing": st.get("standing"), "won": st.get("won"), "drawn": st.get("drawn"), "lost": st.get("lost"),
            # league_guid/team_id let the frontend link straight to this
            # app's own team.html (see teams.py) without parsing them back
            # out of `url`; `url` itself still lets it also offer a direct
            # link to dbv's own team page.
            "league_guid": league_guid, "team_id": t["team_id"],
            "url": f"{BASE}/league/{league_guid}/team/{t['team_id']}",
        })

    # Squad number/label order (1, 2, 3 ... then J1, J2, M1 ...), not league
    # tier — a club's own squad numbering doesn't track tier one-for-one (a
    # lower-numbered squad can land in a lower tier than a youth/mixed squad
    # in a given season, confirmed live: SV Bergfried Lev., cl_code
    # 01-0163 — squad "4" sits in Bezirksklasse this season while J1/J2 sit
    # a tier higher in Bezirksliga; feedback: sorting by tier first put "4"
    # well after J1/J2, which read as "still off" since a club roster is
    # naturally read in its own squad order, not by which is winning more).
    # Tier is still the tiebreaker for two divisions sharing a suffix (a
    # cup alongside the regular league — see _squad_suffix's own note).
    teams.sort(key=lambda t: (
        _squad_sort_key(_squad_suffix(t.get("team"), club_name)),
        t.get("tier") if t.get("tier") is not None else 99,
        int(t["standing"]) if t.get("standing") and t["standing"].isdigit() else 99,
    ))
    return season, teams


def _count_active_players(categories):
    """Unique roster players (by name, across all three disciplines) who
    have actually played at least one match this season — a merely
    registered-but-idle player has an Erfolg of "0/0" or blank."""
    active = set()
    for rows in categories.values():
        for r in rows:
            if r.get("won") is not None and (r["won"] + (r.get("lost") or 0)) > 0:
                active.add((r.get("first_name"), r.get("last_name")))
    return len(active)


# --------------------------------------------------------------------------- #
# Callables
# --------------------------------------------------------------------------- #

@https_fn.on_call()
def get_club_roster(req: https_fn.CallableRequest) -> dict:
    """Resolve a club (by free-text query, or an already-known cl_code) and
    return its roster for one season across all three disciplines."""
    try:
        d = req.data or {}
        cl_code = (d.get("cl_code") or "").strip()
        query = (d.get("query") or "").strip()
        season = (d.get("season") or "").strip()  # e.g. "2025/26"; blank = current

        if not check_rate_limit(rate_key(req), "get_club_roster", 60, 3600000):
            return {"error": "You're looking up clubs too quickly. Please wait a bit."}

        club = None
        if cl_code and not re.match(r"^\d{2}-\d+$", cl_code):
            return {"error": "Missing or invalid club code"}
        if not cl_code:
            if len(query) < 2:
                return {"error": "Provide a club name."}
            bump_summary(["clubSearches"], req.auth is not None)
            club, candidates = _search_club(query)
            if not club:
                if candidates:
                    return {"resolved": False, "candidates": candidates}
                return {"error": "No club found with that name."}
            cl_code = club["cl_code"]

        season_code = _season_code_from_label(season) if season else None
        name, observed_season, categories = _fetch_club_roster(cl_code, season_code)
        name = name or (club and club.get("name"))
        if not name:
            return {"error": "Could not load this club's roster."}

        # The dropdown's [current, -1, -2] list is only well-defined relative
        # to the site's own "current" season, so it's only (re)computed on an
        # unseasoned request — the frontend keeps it from that first load.
        result = {
            "resolved": True,
            "club": {"cl_code": cl_code, "name": name},
            "season": season or observed_season,
            "categories": categories,
            "active_players": _count_active_players(categories),
        }
        if not season_code and observed_season:
            result["seasons"] = [observed_season, _season_offset(observed_season, 1), _season_offset(observed_season, 2)]

        authed = req.auth is not None
        bump_summary(["clubQueries"], authed)
        bump_entity("usage_clubs", cl_code, authed, name=name)
        return result
    except Exception as e:
        import traceback
        print(f"get_club_roster error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}


@https_fn.on_call()
def get_club_teams(req: https_fn.CallableRequest) -> dict:
    """One season's worth of a club's teams + real league standings (see
    _club_teams_for_slot). `slot` selects current (0, default), one season
    back (1) or two (2) — the frontend fetches slot 0 eagerly (right after
    the club resolves, since the identity card's stat tiles need it) and 1/2
    only when the user asks for that season, since each slot costs roughly
    one dbv request per resolved player plus one per distinct team found."""
    try:
        d = req.data or {}
        cl_code = (d.get("cl_code") or "").strip()
        if not re.match(r"^\d{2}-\d+$", cl_code):
            return {"error": "Missing or invalid club code"}
        slot = d.get("slot", 0)
        if slot not in (0, 1, 2):
            return {"error": "Invalid season slot"}

        force = bool(d.get("force"))
        if force and not check_rate_limit(rate_key(req), "force_club_teams", 15, 3600000):
            return {"error": "Live update limit reached. Please wait before refreshing again."}
        if not check_rate_limit(rate_key(req), "get_club_teams", 40, 3600000):
            return {"error": "You're looking up clubs too quickly. Please wait a bit."}

        cache_key = f"{cl_code}_{slot}"
        site_date = _leagues_update_date()
        if db and not force:
            try:
                snap = db.collection("club_teams_cache").document(cache_key).get()
                if snap.exists:
                    data = snap.to_dict()
                    if site_date:
                        fresh = data.get("ligen_date") == site_date
                    else:
                        exp = data.get("expires_at")
                        fresh = exp is not None and datetime.now(timezone.utc) < exp
                    if fresh:
                        return {"season": data.get("season"), "slot": slot, "teams": data["teams"]}
            except Exception:
                pass

        club_name, _season, categories = _fetch_club_roster(cl_code)
        if not club_name:
            return {"error": "Could not load this club's roster."}
        names = sorted({f"{r['first_name']} {r['last_name']}".strip()
                         for rows in categories.values() for r in rows if r.get("last_name")})

        season_label, teams = _club_teams_for_slot(club_name, names, slot) if names else (None, [])

        if db:
            try:
                db.collection("club_teams_cache").document(cache_key).set({
                    "season": season_label, "teams": teams, "ligen_date": site_date,
                    "expires_at": datetime.now(timezone.utc) + CLUB_TEAMS_FALLBACK_TTL,
                })
            except Exception:
                pass

        bump_summary(["clubTeamQueries"], req.auth is not None)
        return {"season": season_label, "slot": slot, "teams": teams}
    except Exception as e:
        import traceback
        print(f"get_club_teams error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}
