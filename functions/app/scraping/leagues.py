"""Player league history — dbv.turnier.de /player-profile/<id>/leagues."""

import re
import time
import hashlib
import threading
from datetime import datetime, timezone

from bs4 import BeautifulSoup
from firebase_functions import https_fn

from app.scraping.analytics import bump_entity, bump_summary
from app.core.auth import rate_key
from app.core.cache_config import LEAGUE_PLAYER_PAGE_TTL, LIGEN_DATE_CHECK_SECONDS, PLAYER_LEAGUES_FALLBACK_TTL
from app.core.common import BASE, COOKIES, _get
from app.core.firebase_app import db
from app.core.rate_limiting import check_rate_limit

# German league tiers, highest → lowest, with the abbreviation shown on the tag.
LEAGUE_TIERS = [
    ("Bundesliga", "BuLi", 1),
    ("Regionalliga", "RL", 2),
    ("Oberliga", "OL", 3),
    ("Verbandsliga", "VL", 4),
    ("Landesliga", "LL", 5),
    ("Bezirksliga", "BL", 6),
    ("Bezirksklasse", "BK", 7),
    ("Kreisliga", "KL", 8),
    ("Kreisklasse", "KK", 9),
]


def _league_tier(division):
    d = (division or "").lower()
    for word, abbr, rank in LEAGUE_TIERS:
        if word.lower() in d:
            return abbr, rank
    return None, 99


# League standings only change when badminton-bax.de recomputes them, reported on
# the index page as "Stand der Aktualisierung … (Ligen)". We tag each cached entry
# with that date so it stays valid until the site actually updates — mirroring the
# "(Turniere)" mechanism used for BAX values (see bax._bax_update_date).
_LIGEN_DATE = {"date": None, "at": 0.0}
_LIGEN_DATE_TTL = LIGEN_DATE_CHECK_SECONDS
_LIGEN_DATE_LOCK = threading.Lock()


def _leagues_update_date():
    """The badminton-bax.de leagues 'last updated' date (e.g. '15.05.2026'), or
    None if it can't be read. Memoized in-process."""
    now = time.time()
    if _LIGEN_DATE["date"] and now - _LIGEN_DATE["at"] < _LIGEN_DATE_TTL:
        return _LIGEN_DATE["date"]
    with _LIGEN_DATE_LOCK:
        now = time.time()
        if _LIGEN_DATE["date"] and now - _LIGEN_DATE["at"] < _LIGEN_DATE_TTL:
            return _LIGEN_DATE["date"]
        try:
            resp = _get("https://www.badminton-bax.de/index.php")
            resp.raise_for_status()
            txt = BeautifulSoup(resp.text, "html.parser").get_text(" ", strip=True)
            m = re.search(r"(\d{2}\s*\.\s*\d{2}\s*\.\s*\d{4})\s*\(Ligen\)", txt)
            date = re.sub(r"\s+", "", m.group(1)) if m else None
            if date:
                _LIGEN_DATE.update(date=date, at=now)
            return date
        except Exception as e:
            print(f"Could not read Ligen update date: {e}")
            return _LIGEN_DATE["date"]


def _scrape_leagues(profile_id, year=None, force=False):
    """Scrape a player's leagues for one season, grouped by league. Returns
    (leagues, available_years). Each league carries one shared record/season
    plus its divisions (one league can span several divisions/draws, each with
    its own team):
    {season, record, standing, divisions: [{abbr, division, tier, team}]}."""
    if not profile_id:
        return [], []
    cache_key = f"{profile_id}_{year or 'current'}"
    site_date = _leagues_update_date()
    if db and not force:
        try:
            cache = db.collection("player_leagues_cache").document(cache_key).get()
            if cache.exists:
                data = cache.to_dict()
                # Valid until the site's "(Ligen)" date changes; if that date
                # can't be read, fall back to the stored TTL.
                if site_date:
                    fresh = data.get("ligen_date") == site_date
                else:
                    exp = data.get("expires_at")
                    fresh = exp is not None and datetime.now(timezone.utc) < exp
                if fresh:
                    return data["leagues"], data.get("years", [])
        except Exception:
            pass

    url = f"{BASE}/player-profile/{profile_id}/leagues" + (f"/{year}" if year else "")
    leagues, years = [], []
    try:
        resp = _get(url, cookies=COOKIES)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        by_league, seen = {}, set()
        for draw in soup.find_all("a", href=re.compile(r"/league/([0-9A-F-]+)/draw/", re.I)):
            m = re.search(r"/league/([0-9A-F-]+)/draw/(\d+)", draw["href"], re.I)
            if not m:
                continue
            lg, draw_no = m.group(1), m.group(2)
            if (lg, draw_no) in seen:
                continue
            seen.add((lg, draw_no))
            division = re.sub(r"^.*\(\d+\)\s*", "", draw.get_text(" ", strip=True)).strip()
            abbr, tier = _league_tier(division)
            # The team for THIS division is the team link that follows this draw.
            team_link = draw.find_next("a", href=re.compile(rf"/league/{lg}/team/", re.I))
            team = team_link.get_text(" ", strip=True) if team_link else None

            if lg not in by_league:
                # The record/season/standing are per-league (one aggregate), read
                # once from the membership card that also holds "Siege…".
                card = draw
                for _ in range(6):
                    card = card.parent
                    if card is None or "Siege" in card.get_text():
                        break
                ct = card.get_text(" ", strip=True) if card else ""
                rec = re.search(r"Siege-Niederlagen\s*(\d+-\d+\s*\(\d+\))", ct)
                season = re.search(r"(\d{4}-\d{2})", ct)
                standing = re.search(r"\bPL\s*(\d+)", ct)
                by_league[lg] = {
                    "season": season.group(1) if season else (str(year) if year else None),
                    "record": rec.group(1) if rec else None,
                    "standing": standing.group(1) if standing else None,
                    "divisions": [],
                }
                leagues.append(by_league[lg])
            by_league[lg]["divisions"].append(
                {"abbr": abbr, "division": division, "tier": tier, "team": team})

        # One "Matches of {name}" link per league card (shared across all of
        # that league's divisions, not per-division) — the Spielübersicht page
        # it points to lists every match this player played in that whole
        # league competition. Used by the player-network feature.
        for a in soup.find_all("a", href=re.compile(r"/league/([0-9A-F-]+)/player/(\d+)", re.I)):
            pm = re.search(r"/league/([0-9A-F-]+)/player/(\d+)", a["href"], re.I)
            if pm and pm.group(1) in by_league:
                by_league[pm.group(1)]["match_url"] = f"{BASE}/league/{pm.group(1)}/player/{pm.group(2)}"

        years = sorted(set(re.findall(r"/leagues/(\d{4})", resp.text)), reverse=True)
    except Exception as e:
        print(f"Error scraping leagues: {e}")

    if db:
        try:
            db.collection("player_leagues_cache").document(cache_key).set({
                "leagues": leagues, "years": years,
                "ligen_date": site_date,
                # The ligen_date is the real validity signal; this only bounds
                # staleness for the fallback case where the date is unreadable.
                "expires_at": datetime.now(timezone.utc) + PLAYER_LEAGUES_FALLBACK_TTL,
            })
        except Exception:
            pass
    return leagues, years


def _fetch_league_player_page(url, force=False):
    """Raw HTML of a league "Spielübersicht" page (a league's /player/<id>
    page — its match_url), cached so the network feature's per-match parse
    and the upcoming-tournaments parse (see _parse_league_tournaments) can
    both read one fetch instead of scraping the same page twice."""
    key = hashlib.md5(url.encode()).hexdigest()
    if db and not force:
        try:
            cache = db.collection("league_player_page_cache").document(key).get()
            if cache.exists:
                data = cache.to_dict()
                if datetime.now(timezone.utc) < data["expires_at"]:
                    return data["html"]
        except Exception:
            pass
    resp = _get(url, cookies=COOKIES)
    resp.raise_for_status()
    if db:
        try:
            db.collection("league_player_page_cache").document(key).set({
                "html": resp.text,
                "expires_at": datetime.now(timezone.utc) + LEAGUE_PLAYER_PAGE_TTL,
            })
        except Exception:
            pass
    return resp.text


def _parse_league_tournaments(html):
    """Every tournament/league-competition listed in a league/player page's
    "Turniere mit <Name>" widget — past AND future, across every year tab —
    as [{id, name, start, end}] (dd.mm.yyyy). This is the one place dbv
    actually exposes a player's upcoming (not-yet-played) tournaments; see
    get_player_upcoming for how it's combined with the implicit-registration
    capture. `id` is a tournament guid for a normal event, or a LEAGUE guid
    for a "Ligen ..." row — callers should drop rows whose id is a league
    they already know about.

    Each row's dates are "dd.mm bis dd.mm" with no year; the enclosing
    table's id (…_tblTournaments_<year>) anchors the START date to that year.
    When the range wraps past New Year's (start month > end month, e.g. a
    league season "05.09 bis 14.03"), the end date lands in <year>+1 — this
    was confirmed against a real "Ligen NRW 2026-27" row filed under the
    2026 tab with exactly that shape."""
    soup = BeautifulSoup(html, "html.parser")
    block = soup.find(class_="tabbedtournamentlist")
    if not block:
        return []
    out, seen = [], set()
    for table in block.select("table.ruler"):
        ym = re.search(r"tblTournaments_(\d{4})", table.get("id") or "")
        year = int(ym.group(1)) if ym else None
        for tr in table.find_all("tr"):
            a = tr.find("a", href=re.compile(r"[?&]id=([0-9A-Fa-f-]{36})", re.I))
            if not a:
                continue
            m = re.search(r"[?&]id=([0-9A-Fa-f-]{36})[^\"']*[?&]player=(\d+)", a["href"], re.I)
            if not m:
                m = re.search(r"[?&]id=([0-9A-Fa-f-]{36})", a["href"])
            gid = m.group(1).upper()
            local_id = m.group(2) if m.lastindex and m.lastindex >= 2 else None
            if gid in seen:
                continue
            date_td = tr.find("td", class_="dates")
            dm = re.search(r"(\d{2})\.(\d{2})\s*bis\s*(\d{2})\.(\d{2})",
                            date_td.get_text(strip=True) if date_td else "")
            start = end = None
            if dm and year:
                sd, sm, ed, em = dm.groups()
                start = f"{sd}.{sm}.{year}"
                end_year = year + 1 if int(em) < int(sm) else year
                end = f"{ed}.{em}.{end_year}"
            seen.add(gid)
            # player_local_id is this player's own competition-scoped numeric id
            # (the "&player=" query param) — combined with `id`, it's a direct
            # link to their own card in that one tournament (see
            # bax._parse_tournament_player_card), which is far cheaper than
            # scanning every discipline's entry list to find them.
            out.append({"id": gid, "name": a.get_text(" ", strip=True), "start": start, "end": end,
                        "player_local_id": local_id})
    return out


@https_fn.on_call()
def get_player_leagues(req: https_fn.CallableRequest) -> dict:
    """Return a player's league memberships across all available seasons,
    newest first — used by the player-profile popup."""
    try:
        pid = (req.data or {}).get("profile_id", "")
        m = re.search(r"([0-9a-fA-F-]{36})", pid or "")
        if not m:
            return {"error": "Missing or invalid profile id"}
        pid = m.group(1).upper()

        # "Update Live" forces a fresh scrape past the cache — tightly limited.
        force = bool((req.data or {}).get("force"))
        if force and not check_rate_limit(rate_key(req), "force_leagues", 20, 3600000):
            return {"error": "Live update limit reached. Please wait before refreshing again."}

        authed = req.auth is not None
        bump_summary(["playerQueries"], authed)
        bump_entity("usage_players", pid, authed, name=(req.data or {}).get("name"))

        current, years = _scrape_leagues(pid, force=force)
        seasons, seen = [], set()

        def add(league_list):
            if not league_list:
                return
            # Dedup by league *content*, not by season label. The no-year base
            # page repeats the current season, and a seasonless individual event
            # (e.g. a "Classics" tournament, which sorts first) can leave the
            # base page's first league without a parseable label — so a
            # label-based key misses that duplicate. The set of
            # (division, team, record) is identical for the true duplicate but
            # differs across real seasons.
            key = tuple(sorted(
                (d.get("division"), d.get("team"), lg.get("record"))
                for lg in league_list for d in lg.get("divisions", [])
            ))
            if key in seen:
                return
            seen.add(key)
            # Prefer a full "YYYY-YY" league season for the header over a bare
            # year (individual events only carry the bare year), so seasons read
            # consistently and sort correctly.
            labels = [lg.get("season") for lg in league_list if lg.get("season")]
            label = (next((s for s in labels if re.match(r"\d{4}-\d{2}$", s)), None)
                     or (labels[0] if labels else "?"))
            seasons.append({"season": label, "leagues": league_list})

        # Add the per-year pages first (each carries a season label), then the
        # base page last — it is skipped when a year page already covered the
        # current season.
        for y in years:
            lg, _ = _scrape_leagues(pid, y, force=force)
            add(lg)
        add(current)
        seasons.sort(key=lambda s: s["season"] or "", reverse=True)
        return {"seasons": seasons}
    except Exception as e:
        import traceback
        print(f"get_player_leagues error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}
