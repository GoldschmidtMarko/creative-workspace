"""One league team's own season — dbv.turnier.de's team page plus its full
match schedule, addressed purely by (league_guid, team_id) with no club
lookup needed (unlike clubs.py's club-scoped pages, which need a club's own
dbv id first).

sport/league/team?id=<league_guid>&team=<team_id> ("Allgemein") carries the
team's own division's FULL standings table (table.teamstandings — every
competing team, not just this one) but only a 2-row PREVIEW of matches.
sport/teammatches.aspx?id=<league_guid>&tid=<team_id> ("Spiele") has the
complete season schedule instead — played results and upcoming fixtures
together, no pagination (confirmed live: 14 rows for an 8-team single
round-robin-plus-return division). Each match row marks OUR side with
class="teamname highlighted" on whichever of the Heim/Gast links is us —
the reliable way to tell home from away, since the row otherwise carries no
team id for either side (only a shared teammatch.aspx?...&match=<n> link,
which is the "encounter" id get_team_encounter below keys off).

sport/teammatch.aspx?id=<league_guid>&match=<match_id> is one team
encounter's own 8 individual games (Herrendoppel/Damendoppel/Herreneinzel/
Dameneinzel/Gemischtes Doppel — HD/DD/HE/DE/GD), each with its own
score and dbv's own <strong> marking the winning side. Its player links
(player.aspx?id=<league_guid>&player=<n>) carry no dbv profile GUID
anywhere — confirmed live, even following the redirect to
/sport/league/player?id=...&player=<n> — so there is no shortcut around
resolving these players by NAME, the same way clubs.py's
_resolve_roster_profile_ids already resolves a roster (see
_resolve_match_player).
"""

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from bs4 import BeautifulSoup
from firebase_functions import https_fn

from app.core.auth import rate_key
from app.core.cache_config import (
    CURRENT_SEASON_MAX_AGE, PLAYER_LEAGUE_GAMES_FALLBACK_TTL, TEAM_ENCOUNTER_FALLBACK_TTL, TEAM_SEASON_FALLBACK_TTL)
from app.core.common import BASE, COOKIES, MAX_WORKERS, _get
from app.core.firebase_app import db
from app.scraping.analytics import bump_entity, bump_summary, name_key, upsert_player_index
from app.scraping.bax import get_bax_values
from app.scraping.leagues import _league_tier, _leagues_update_date, _ligen_cache_fresh, _scrape_leagues
from app.scraping.player import _cached_search_players, _index_lookup
from app.core.rate_limiting import check_rate_limit


def _parse_team_standings_page(html, team_id):
    """table.teamstandings on the team's own "Allgemein" page -> (division,
    abbr, tier, season, [{standing, team, team_id, played, points_won,
    points_lost, won, drawn, lost, is_this_team}]). Same GEW/REM/VER cell
    positions as every other standings table this app parses (clubs.py's
    _fetch_club_standings_page, the now-removed _parse_team_standing) —
    cells[0]=rank, cells[6..8]=GEW/REM/VER, cells[2]=gespielt (played-match
    count). cells[3]/[5] are the "Punkte" (league points, "2:0" — what
    actually orders the standings) — distinct from "Spielpunkte" (raw game
    points played, cells[15]/[17]), which this doesn't surface."""
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", class_="teamstandings")
    if not table:
        return None, None, None, None, []

    caption = table.find("caption")
    division_text = caption.get_text(" ", strip=True) if caption else ""
    # Strips a leading "(<n>) " group code, same as leagues.py's own
    # division parsing (see its "(007)" group-code note).
    division = re.sub(r"^.*\(\d+\)\s*", "", division_text).strip()
    abbr, tier = _league_tier(division)

    season_m = re.search(r"Ligen NRW (\d{4}-\d{2})", html)
    season = season_m.group(1) if season_m else None

    needle = re.compile(r"[?&]team=(\d+)")
    rows = []
    for tr in table.find_all("tr"):
        a = tr.find("a", href=needle)
        if not a:
            continue
        cells = tr.find_all("td")
        if len(cells) < 9:
            continue
        row_team_id = needle.search(a["href"]).group(1)
        played = cells[2].get_text(strip=True)
        points_won = cells[3].get_text(strip=True)
        points_lost = cells[5].get_text(strip=True)
        gew = cells[6].get_text(strip=True)
        rem = cells[7].get_text(strip=True)
        ver = cells[8].get_text(strip=True)
        rows.append({
            "standing": cells[0].get_text(strip=True) or None,
            "team": a.get_text(" ", strip=True), "team_id": row_team_id,
            "played": int(played) if played.isdigit() else None,
            "points_won": int(points_won) if points_won.isdigit() else None,
            "points_lost": int(points_lost) if points_lost.isdigit() else None,
            "won": int(gew) if gew.isdigit() else None,
            "drawn": int(rem) if rem.isdigit() else None,
            "lost": int(ver) if ver.isdigit() else None,
            "is_this_team": row_team_id == team_id,
        })
    return division, abbr, tier, season, rows


def _fetch_team_standings_page(league_guid, team_id):
    try:
        resp = _get(f"{BASE}/sport/league/team", params={"id": league_guid, "team": team_id}, cookies=COOKIES)
        resp.raise_for_status()
        return _parse_team_standings_page(resp.text, team_id)
    except Exception as e:
        print(f"team standings page fetch error ({league_guid}/{team_id}): {e}")
        return None, None, None, None, []


def _parse_team_matches_page(html, league_guid):
    """table.matches on teammatches.aspx -> every match this team plays
    this season, in the page's own chronological order: [{date (ISO),
    time, matchday, round, home_team, away_team, is_home, score, played,
    match_id, match_url, location}]. `is_home` comes from which of the
    Heim/Gast <a class="teamname"> links carries "highlighted" — the only
    way the row identifies which side is us (see module docstring)."""
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", class_="matches")
    if not table:
        return []
    body = table.find("tbody") or table
    match_needle = re.compile(r"[?&]match=(\d+)")
    out = []
    for tr in body.find_all("tr"):
        cells = tr.find_all("td")
        if len(cells) < 10:
            continue
        date_text = cells[1].get_text(" ", strip=True)
        dm = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", date_text)
        date = f"{dm.group(3)}-{dm.group(2)}-{dm.group(1)}" if dm else None
        time_el = cells[1].find("span", class_="time")
        time_str = time_el.get_text(strip=True) if time_el else None
        matchday = cells[3].get_text(strip=True) or None
        round_ = cells[4].get_text(strip=True) or None
        home_link = cells[6].find("a", class_="teamname")
        away_link = cells[8].find("a", class_="teamname")
        if not home_link or not away_link:
            continue
        home_team = home_link.get_text(" ", strip=True)
        away_team = away_link.get_text(" ", strip=True)
        is_home = "highlighted" in (home_link.get("class") or [])
        score_span = cells[9].find("span", class_="score")
        score = score_span.get_text(strip=True) if score_span else None
        mm = match_needle.search(home_link.get("href") or "")
        match_id = mm.group(1) if mm else None
        location = cells[11].get_text(" ", strip=True) if len(cells) > 11 else None
        out.append({
            "date": date, "time": time_str, "matchday": matchday, "round": round_,
            "home_team": home_team, "away_team": away_team, "is_home": is_home,
            "score": score, "played": bool(score),
            # This match's own "encounter" id — what a future per-match BAX
            # page would key off (not built yet, see module docstring).
            "match_id": match_id,
            "match_url": f"{BASE}/sport/teammatch.aspx?id={league_guid}&match={match_id}" if match_id else None,
            "location": location,
        })
    return out


def _fetch_team_matches_page(league_guid, team_id):
    try:
        resp = _get(f"{BASE}/sport/teammatches.aspx", params={"id": league_guid, "tid": team_id}, cookies=COOKIES)
        resp.raise_for_status()
        return _parse_team_matches_page(resp.text, league_guid)
    except Exception as e:
        print(f"team matches page fetch error ({league_guid}/{team_id}): {e}")
        return []


def _track_team_view(cache_key, result, authed):
    """Count one team-page view — called on the cache-hit path too, not just
    after a fresh scrape (a cached team is the common case, and counting only
    misses badly undercounted). Also feeds the dashboard's "most viewed
    teams" table (usage_teams); best-effort, never affects the response."""
    try:
        bump_summary(["teamSeasonQueries"], authed)
        team = (result or {}).get("team") or {}
        name = team.get("name")
        if name and team.get("division"):
            name = f"{name} · {team['division']}"   # a bare "BV Aachen 2" repeats every season
        bump_entity("usage_teams", cache_key, authed, name=name)
    except Exception as e:
        print(f"team view tracking error: {e}")


def _track_encounter_view(cache_key, result, authed):
    """Same as _track_team_view, for one encounter (usage_encounters). The
    date disambiguates the two legs of the same pairing."""
    try:
        bump_summary(["teamEncounterQueries"], authed)
        meta = (result or {}).get("meta") or {}
        name = f"{meta['home_team']} – {meta['away_team']}" if meta.get("home_team") and meta.get("away_team") else None
        if name and meta.get("date"):
            name = f"{name} · {meta['date']}"
        bump_entity("usage_encounters", cache_key, authed, name=name)
    except Exception as e:
        print(f"encounter view tracking error: {e}")


@https_fn.on_call()
def get_team_season(req: https_fn.CallableRequest) -> dict:
    """One team's season: its division's full current standings (every
    competing team, not just this one) plus its complete match schedule,
    split into played results and upcoming fixtures. See module docstring
    for the two dbv pages this reads."""
    try:
        d = req.data or {}
        league_guid = (d.get("league_guid") or "").strip()
        team_id = (d.get("team_id") or "").strip()
        if not re.match(r"^[0-9A-Fa-f-]{36}$", league_guid) or not re.match(r"^\d+$", team_id):
            return {"error": "Missing or invalid team"}

        if not check_rate_limit(rate_key(req), "get_team_season", 60, 3600000):
            return {"error": "You're looking up teams too quickly. Please wait a bit."}

        cache_key = f"{league_guid}_{team_id}"
        authed = req.auth is not None
        site_date = _leagues_update_date()
        if db:
            try:
                snap = db.collection("team_season_cache").document(cache_key).get()
                if snap.exists:
                    data = snap.to_dict()
                    if site_date:
                        fresh = data.get("ligen_date") == site_date
                    else:
                        exp = data.get("expires_at")
                        fresh = exp is not None and datetime.now(timezone.utc) < exp
                    if fresh:
                        _track_team_view(cache_key, data["result"], authed)
                        return data["result"]
            except Exception:
                pass

        with ThreadPoolExecutor(max_workers=2) as pool:
            standings_fut = pool.submit(_fetch_team_standings_page, league_guid, team_id)
            matches_fut = pool.submit(_fetch_team_matches_page, league_guid, team_id)
            division, abbr, tier, season, standings = standings_fut.result()
            matches = matches_fut.result()

        team_row = next((r for r in standings if r["is_this_team"]), None)
        if not division and not team_row:
            return {"error": "Could not load this team's season."}

        # Best-effort opponent team_id, cross-referenced by name against the
        # standings rows just fetched (both pages come from dbv, so names
        # should match verbatim) — left None on a miss rather than guessed.
        by_name = {r["team"]: r["team_id"] for r in standings}
        for m in matches:
            opponent = m["away_team"] if m["is_home"] else m["home_team"]
            m["opponent_team_id"] = by_name.get(opponent)

        result = {
            "team": {
                "name": team_row["team"] if team_row else None,
                "division": division, "abbr": abbr, "tier": tier, "season": season,
            },
            "standings": standings,
            "matches": {
                "played": [m for m in matches if m["played"]],
                "upcoming": [m for m in matches if not m["played"]],
            },
        }

        if db:
            try:
                db.collection("team_season_cache").document(cache_key).set({
                    "result": result, "ligen_date": site_date,
                    "expires_at": datetime.now(timezone.utc) + TEAM_SEASON_FALLBACK_TTL,
                })
            except Exception:
                pass

        _track_team_view(cache_key, result, authed)
        return result
    except Exception as e:
        import traceback
        print(f"get_team_season error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}


def _discipline_category(discipline):
    """A game's discipline code (HD1, DD, HE2, GD, ...) -> which of a
    player's three BAX numbers it's actually about. HD/DD (Herren-/
    Damendoppel) and GD (gemischtes Doppel) look alike but aren't the same
    BAX category — GD is Mixed, not Doppel. Unrecognized code -> None,
    degrading gracefully rather than guessing."""
    d = (discipline or "").upper()
    if d.startswith("GD"):
        return "Mixed"
    if d.startswith("HD") or d.startswith("DD"):
        return "Doppel"
    if d.startswith("HE") or d.startswith("DE"):
        return "Einzel"
    return None


def _parse_teammatch_page(html):
    """One team encounter (sport/teammatch.aspx) -> (meta, games). meta =
    {home_team, away_team, score, date, time, division, location}, read
    from the plain info <table> right after the page's own <h3> (same
    Spieltermin/Staffel/Spielort/Ergebnis rows _parse_team_matches_page's
    caller already knows the shape of). games = [{discipline, category,
    home_players, away_players, home_won, score}] from table.matches
    ("Spielübersicht") — each side's cell is a nested <table> of 1-2
    player links; dbv wraps the WINNING side's links in <strong>, read
    directly rather than re-derived from the per-set score text."""
    soup = BeautifulSoup(html, "html.parser")

    meta = {"home_team": None, "away_team": None, "score": None,
            "date": None, "time": None, "division": None, "location": None}
    # NOT soup.find("h3") — the page's share/"Link erstellen" modal markup
    # has its own earlier, unrelated <h3> (confirmed live) that would win a
    # plain first-match. The real header is the only one with a score span.
    h3 = next((h for h in soup.find_all("h3") if h.find("span", class_="score")), None)
    if h3:
        team_links = h3.find_all("a")
        if len(team_links) >= 2:
            # Each link's own text carries a trailing "(<cl_code>-<squad>)"
            # id dbv doesn't show anywhere else in this app — stripped for
            # display, same team name shape team.py's other pages already use.
            meta["home_team"] = re.sub(r"\s*\([^)]*\)\s*$", "", team_links[0].get_text(" ", strip=True))
            meta["away_team"] = re.sub(r"\s*\([^)]*\)\s*$", "", team_links[1].get_text(" ", strip=True))
        score_span = h3.find("span", class_="score")
        if score_span:
            meta["score"] = score_span.get_text(strip=True)

    info_table = soup.find("table")
    if info_table:
        for tr in info_table.find_all("tr"):
            th, td = tr.find("th"), tr.find("td")
            if not th or not td:
                continue
            label = th.get_text(strip=True)
            if label == "Spieltermin:":
                dm = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", td.get_text(" ", strip=True))
                meta["date"] = f"{dm.group(3)}-{dm.group(2)}-{dm.group(1)}" if dm else None
                time_el = td.find("span", class_="time")
                meta["time"] = time_el.get_text(strip=True) if time_el else None
            elif label == "Staffel:":
                # Strips a leading "(<n>) " group code, same as leagues.py's
                # own division parsing (see its "(007)" group-code note).
                meta["division"] = re.sub(r"^.*\(\d+\)\s*", "", td.get_text(" ", strip=True)).strip()
            elif label == "Spielort:":
                meta["location"] = td.get_text(" ", strip=True)
            elif label == "Ergebnis:" and not meta["score"]:
                sp = td.find("span", class_="score")
                meta["score"] = sp.get_text(strip=True) if sp else td.get_text(strip=True)

    games = []
    table = soup.find("table", class_="matches")
    if table:
        # recursive=False on both — each side's cell nests its OWN <table>
        # of per-player <tr>/<td>s (1-2 players), and a plain find_all
        # would flatten those into this row's own cell list too (confirmed
        # live: silently pulled a player name into the wrong column).
        for tr in (table.find("tbody") or table).find_all("tr", recursive=False):
            cells = tr.find_all("td", recursive=False)
            if len(cells) < 5:
                continue
            discipline = cells[0].get_text(strip=True)
            home_cell, away_cell, score_cell = cells[1], cells[3], cells[4]
            home_players = [a.get_text(" ", strip=True) for a in home_cell.find_all("a")]
            away_players = [a.get_text(" ", strip=True) for a in away_cell.find_all("a")]
            home_won, away_won = bool(home_cell.find("strong")), bool(away_cell.find("strong"))
            score_span = score_cell.find("span", class_="score")
            games.append({
                "discipline": discipline, "category": _discipline_category(discipline),
                "home_players": home_players, "away_players": away_players,
                # Not yet played (or a walkover with neither side bolded)
                # -> None, not a guessed False.
                "home_won": home_won if (home_won or away_won) else None,
                "score": score_span.get_text(" ", strip=True) if score_span else None,
            })
    return meta, games


def _fetch_teammatch_page(league_guid, match_id):
    try:
        resp = _get(f"{BASE}/sport/teammatch.aspx", params={"id": league_guid, "match": match_id}, cookies=COOKIES)
        resp.raise_for_status()
        return _parse_teammatch_page(resp.text)
    except Exception as e:
        print(f"team encounter page fetch error ({league_guid}/{match_id}): {e}")
        return {"home_team": None, "away_team": None, "score": None,
                "date": None, "time": None, "division": None, "location": None}, []


def _guess_club_name(team_name):
    """A team's display name -> its club's own name, for feeding into a
    name search's club-disambiguation the same way club.js's
    guessClubName does for club.html's search box — strip a trailing
    squad label ("1", "2", "J1", "M2", ...), e.g. "BV Aachen 1" -> "BV
    Aachen"."""
    stripped = re.sub(r"\s+(?:[A-Za-z]{1,2}\d{1,2}|\d{1,2})$", "", team_name or "").strip()
    return stripped or team_name


def _resolve_match_player(name, team_name):
    """One encounter player's identity — mirrors the resolution half of
    clubs.py's _resolve_roster_profile_ids (the free/cached player_index
    lookup first, then a live dbv name search disambiguated by
    _guess_club_name(team_name) when there's more than one same-name
    match), just for a single (name, team) pair instead of a whole
    roster. Returns the resolved candidate dict ({profile_id, sp_code,
    name, club}, though sp_code can still be None — an index entry
    written without one) or None. Skips (never guesses) on zero or
    still-ambiguous matches, same rule as the roster resolver — a wrong
    guess here would attribute a stranger's BAX to this game."""
    if not name:
        return None
    hit = _index_lookup(name_search=name_key(name))
    if hit and hit.get("profile_id"):
        return hit
    # The FULL name, not just the last name — confirmed live: querying a
    # common surname alone ("Roth") returns a broad, alphabetically-capped
    # (60 max) substring match across every name containing it, and a
    # first name starting late in the alphabet ("Thurid") never makes that
    # cut; querying the full name is a far narrower search and returns
    # exactly the one real match instead.
    try:
        candidates = _cached_search_players(name)
    except Exception as e:
        print(f"match player resolution error for {name!r}: {e}")
        return None
    nk = name_key(name)
    matches = [c for c in candidates if name_key(c.get("name") or "") == nk]
    if len(matches) > 1:
        club_guess = _guess_club_name(team_name)
        matches = [c for c in matches
                   if c.get("club") and club_guess and club_guess.lower() in c["club"].lower()]
    if len(matches) != 1:
        return None
    m = matches[0]
    upsert_player_index(m["profile_id"], sp_code=m.get("sp_code"), name=m.get("name") or name)
    return m


def _player_with_bax(resolved, category):
    """A resolved candidate (see _resolve_match_player) + the ONE BAX
    number relevant to this specific game's category (confirmed with the
    user: just the relevant discipline, not the full Einzel/Doppel/Mixed
    profile every time) — {sp_code, bax}, both None if unresolved or
    lacking an sp_code to look up."""
    if not resolved or not resolved.get("sp_code") or not category:
        return {"sp_code": resolved.get("sp_code") if resolved else None, "bax": None}
    full_name = resolved.get("name") or ""
    parts = full_name.rsplit(" ", 1)
    first_name, last_name = (parts[0], parts[1]) if len(parts) == 2 else ("", full_name)
    try:
        values = get_bax_values({"id": resolved["sp_code"], "first_name": first_name, "last_name": last_name})
        return {"sp_code": resolved["sp_code"], "bax": values.get(category)}
    except Exception as e:
        print(f"bax fetch error for {full_name!r}: {e}")
        return {"sp_code": resolved["sp_code"], "bax": None}


@https_fn.on_call()
def get_team_encounter(req: https_fn.CallableRequest) -> dict:
    """One team encounter's 8 individual games, each with its score and
    both sides' players resolved to their own BAX for that game's own
    discipline (Doppel for HD/DD, Mixed for GD, Einzel for HE/DE — see
    _discipline_category). See module docstring for the source page."""
    try:
        d = req.data or {}
        league_guid = (d.get("league_guid") or "").strip()
        match_id = (d.get("match_id") or "").strip()
        if not re.match(r"^[0-9A-Fa-f-]{36}$", league_guid) or not re.match(r"^\d+$", match_id):
            return {"error": "Missing or invalid match"}

        if not check_rate_limit(rate_key(req), "get_team_encounter", 60, 3600000):
            return {"error": "You're looking up matches too quickly. Please wait a bit."}

        cache_key = f"{league_guid}_{match_id}"
        authed = req.auth is not None
        site_date = _leagues_update_date()
        if db:
            try:
                snap = db.collection("team_encounter_cache").document(cache_key).get()
                if snap.exists:
                    data = snap.to_dict()
                    if site_date:
                        fresh = data.get("ligen_date") == site_date
                    else:
                        exp = data.get("expires_at")
                        fresh = exp is not None and datetime.now(timezone.utc) < exp
                    if fresh:
                        _track_encounter_view(cache_key, data["result"], authed)
                        return data["result"]
            except Exception:
                pass

        meta, games = _fetch_teammatch_page(league_guid, match_id)
        if not meta["home_team"] or not games:
            return {"error": "Could not load this match."}

        # Resolve each UNIQUE (name, side) once — a player can appear in
        # more than one game (e.g. a singles AND a doubles game) — then
        # pick out just that specific game's own relevant BAX per
        # appearance, via _player_with_bax.
        unique = {}
        for g in games:
            for name in g["home_players"]:
                unique.setdefault((name, meta["home_team"]), None)
            for name in g["away_players"]:
                unique.setdefault((name, meta["away_team"]), None)
        for name, team_name in unique:
            unique[(name, team_name)] = _resolve_match_player(name, team_name)

        for g in games:
            g["home"] = [{"name": n, **_player_with_bax(unique[(n, meta["home_team"])], g["category"])}
                         for n in g["home_players"]]
            g["away"] = [{"name": n, **_player_with_bax(unique[(n, meta["away_team"])], g["category"])}
                         for n in g["away_players"]]
            del g["home_players"], g["away_players"]

        result = {"meta": meta, "games": games}

        if db:
            try:
                db.collection("team_encounter_cache").document(cache_key).set({
                    "result": result, "ligen_date": site_date,
                    "expires_at": datetime.now(timezone.utc) + TEAM_ENCOUNTER_FALLBACK_TTL,
                })
            except Exception:
                pass

        _track_encounter_view(cache_key, result, authed)
        return result
    except Exception as e:
        import traceback
        print(f"get_team_encounter error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}


_RECENT_GAMES_CAP = 8  # per side (played/upcoming) — "recent", not the whole season


@https_fn.on_call()
def get_player_league_games(req: https_fn.CallableRequest) -> dict:
    """A player's own recent/upcoming league encounters — fast links
    straight to this app's encounter.html, across EVERY team they're
    currently on (a player can be on more than one squad/discipline at
    once). Reads leagues.py's _scrape_leagues (the same un-seasoned
    "current" fetch used elsewhere) for which (league_guid, team_id) pairs
    are theirs this season, then each one's full schedule via
    _fetch_team_matches_page — no season-slot ambiguity to resolve here
    the way clubs.py's anchor logic has to, since this is one player's own
    single fetch, not aggregated across a roster of different players."""
    try:
        d = req.data or {}
        profile_id = (d.get("profile_id") or "").strip()
        if not re.match(r"^[0-9A-Fa-f-]{36}$", profile_id):
            return {"error": "Missing or invalid player"}

        if not check_rate_limit(rate_key(req), "get_player_league_games", 60, 3600000):
            return {"error": "You're looking up players too quickly. Please wait a bit."}

        # Counted up front: the cache-hit and "no teams" paths below return
        # early and used to slip past a count at the end.
        bump_summary(["playerLeagueGamesQueries"], req.auth is not None)

        site_date = _leagues_update_date()
        if db:
            try:
                snap = db.collection("player_league_games_cache").document(profile_id).get()
                if snap.exists and _ligen_cache_fresh(snap, site_date, CURRENT_SEASON_MAX_AGE):
                    return snap.to_dict()["result"]
            except Exception:
                pass

        current, _years = _scrape_leagues(profile_id)

        # Dedup by (league_guid, team_id) — the same team can recur across
        # more than one division entry (e.g. league + cup, see clubs.py's
        # own note on this).
        teams_by_key = {}
        for lg in current or []:
            for div in lg.get("divisions", []) or []:
                if not div.get("league_guid") or not div.get("team_id"):
                    continue
                teams_by_key.setdefault((div["league_guid"], div["team_id"]), div)

        if not teams_by_key:
            return {"played": [], "upcoming": []}

        def _fetch_one(div):
            matches = _fetch_team_matches_page(div["league_guid"], div["team_id"])
            for m in matches:
                m["team"] = div.get("team")
                m["division"] = div.get("division")
                m["tier"] = div.get("tier")
                m["abbr"] = div.get("abbr")
                m["league_guid"] = div["league_guid"]
                m["team_id"] = div["team_id"]
            return matches

        all_matches = []
        with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(teams_by_key))) as pool:
            for matches in pool.map(_fetch_one, teams_by_key.values()):
                all_matches.extend(matches)

        for m in all_matches:
            m["opponent"] = m["away_team"] if m["is_home"] else m["home_team"]
            del m["home_team"], m["away_team"]

        played = sorted((m for m in all_matches if m["played"]), key=lambda m: m["date"] or "", reverse=True)
        upcoming = sorted((m for m in all_matches if not m["played"]), key=lambda m: m["date"] or "")

        result = {"played": played[:_RECENT_GAMES_CAP], "upcoming": upcoming[:_RECENT_GAMES_CAP]}

        if db:
            try:
                db.collection("player_league_games_cache").document(profile_id).set({
                    "result": result, "ligen_date": site_date,
                    "expires_at": datetime.now(timezone.utc) + PLAYER_LEAGUE_GAMES_FALLBACK_TTL,
                })
            except Exception:
                pass

        return result
    except Exception as e:
        import traceback
        print(f"get_player_league_games error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}
