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
which is the "encounter" id a future per-match BAX page would key off).
"""

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from bs4 import BeautifulSoup
from firebase_functions import https_fn

from app.core.auth import rate_key
from app.core.cache_config import TEAM_SEASON_FALLBACK_TTL
from app.core.common import BASE, COOKIES, _get
from app.core.firebase_app import db
from app.scraping.analytics import bump_summary
from app.scraping.leagues import _league_tier, _leagues_update_date
from app.core.rate_limiting import check_rate_limit


def _parse_team_standings_page(html, team_id):
    """table.teamstandings on the team's own "Allgemein" page -> (division,
    abbr, tier, season, [{standing, team, team_id, played, won, drawn,
    lost, is_this_team}]). Same GEW/REM/VER cell positions as every other
    standings table this app parses (clubs.py's _fetch_club_standings_page,
    the now-removed _parse_team_standing) — cells[0]=rank, cells[6..8]=
    GEW/REM/VER, cells[2]=gespielt (played-match count)."""
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
        gew = cells[6].get_text(strip=True)
        rem = cells[7].get_text(strip=True)
        ver = cells[8].get_text(strip=True)
        rows.append({
            "standing": cells[0].get_text(strip=True) or None,
            "team": a.get_text(" ", strip=True), "team_id": row_team_id,
            "played": int(played) if played.isdigit() else None,
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

        bump_summary(["teamSeasonQueries"], req.auth is not None)
        return result
    except Exception as e:
        import traceback
        print(f"get_team_season error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}
