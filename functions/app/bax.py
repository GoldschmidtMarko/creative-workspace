"""Tournament entry scraping, per-player BAX values, and the analysis callable."""

import re
import time
import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import pandas as pd
from bs4 import BeautifulSoup
from firebase_functions import https_fn

from app.analytics import bump_entity, bump_summary, parse_event_url, record_registrations
from app.auth import rate_key
from app.common import BASE, COOKIES, HEADERS, MAX_WORKERS, _get
from app.firebase_app import db
from app.leagues import _scrape_leagues
from app.rate_limiting import check_rate_limit


def get_tournament_player_links(url):
    # NOT cached: the participant list of a discipline changes as players
    # register or withdraw, so it must be scraped fresh each analysis. (The
    # per-player BAX and league data it leads to are cached downstream.)
    print(f"Scraping tournament page: {url}")
    try:
        response = _get(url, cookies=COOKIES)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')

        tables = soup.find_all('table', class_='ruler')
        if not tables: return []

        entries = []
        group_id = 1
        for table in tables:
            for row in table.find_all('tr'):
                cells = row.find_all('td')
                if len(cells) < 2: continue
                status = cells[0].get_text(strip=True)
                if not status or "Spieler" in status: continue

                player_links = cells[1].find_all('a', href=re.compile(r'player\.aspx'))
                if not player_links: continue

                for a in player_links:
                    href = a['href']
                    full_url = "https://dbv.turnier.de/sport/" + href if not href.startswith('http') else href
                    # Capture the name from the entry-list link text. This is
                    # authoritative — some players (guests/foreign) have no
                    # linked DBV profile, so their profile page must not be
                    # trusted for the name.
                    entries.append({"url": full_url, "name": a.get_text(strip=True), "status": status, "group": group_id})
                group_id += 1

        return entries
    except Exception as e:
        print(f"Error fetching tournament: {e}")
        return []


def _resolve_profile_id(html):
    """The player's *global* profile GUID (the one the /player-profile/<id>/leagues
    pages use), from a scraped player.aspx page.

    Two link forms appear:
      * /player-profile/<guid>      — already the canonical global profile.
      * /player/<guid>/<base64>     — a tournament-scoped link whose <guid> is
                                      NOT the profile id; it 302-redirects to the
                                      real /player-profile/<guid>. Most players
                                      only expose this form, so we must follow the
                                      redirect (Location header only — no body) to
                                      recover the true profile id. Using the
                                      tournament-scoped guid directly lands on an
                                      empty leagues page, which is why players
                                      wrongly showed no league history before.
    """
    # GUIDs are case-insensitive; dbv writes them in mixed case across pages, so we
    # canonicalize to UPPER everywhere (matching tournament ids and the find/player
    # search results) — otherwise the same player keys two different Firestore docs.
    m = re.search(r'/player-profile/([0-9a-fA-F-]{36})', html)
    if m:
        return m.group(1).upper()
    m = re.search(r'/player/([0-9a-fA-F-]{36})/([A-Za-z0-9_=-]+)', html)
    if not m:
        return None
    try:
        r = _get(f"{BASE}/player/{m.group(1)}/{m.group(2)}",
                 cookies=COOKIES, allow_redirects=False)
        loc = r.headers.get("Location", "")
        mm = re.search(r'/player-profile/([0-9a-fA-F-]{36})', loc)
        if mm:
            return mm.group(1).upper()
    except Exception as e:
        print(f"Error resolving profile id: {e}")
    return None


def get_player_details(player_entry, force=False):
    url_hash = hashlib.md5(player_entry['url'].encode()).hexdigest()

    if db and not force:
        try:
            cache = db.collection("player_profile_cache").document(url_hash).get()
            if cache.exists:
                data = cache.to_dict()
                if datetime.now(timezone.utc) < data['expires_at']:
                    return {**data['details'], "status": player_entry['status'], "group": player_entry['group'], "profile_url": player_entry['url']}
        except: pass

    try:
        response = _get(player_entry['url'], cookies=COOKIES)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')

        # DBV player code lives in the "(NN-NNNNNN)" aside next to the name.
        # Read it from that specific element; only players with a linked DBV
        # profile have one (guests/foreign players legitimately do not).
        player_id = "N/A"
        aside = soup.find(class_='media__title-aside')
        code_match = re.search(r'\((\d+-\d+)\)', aside.get_text()) if aside else None
        if code_match:
            player_id = code_match.group(1)

        # Name: prefer the profile's canonical link, otherwise fall back to the
        # name captured from the entry list (never the tournament header card).
        name_link = soup.find('a', class_='media__link')
        name_part = (name_link.get_text(strip=True) if name_link
                     else player_entry.get('name', '')).strip() or "Unknown"

        # The player's global profile GUID (used by the league pages). Most
        # players only expose a tournament-scoped /player/<guid>/<base64> link
        # that must be resolved via its redirect — see _resolve_profile_id.
        profile_id = _resolve_profile_id(response.text)

        details = {
            "id": player_id,
            "full_name": name_part,
            "last_name": name_part.split()[-1] if len(name_part.split()) >= 2 else name_part,
            "first_name": " ".join(name_part.split()[:-1]) if len(name_part.split()) >= 2 else "",
            "profile_id": profile_id,
        }
        
        if db:
            try:
                db.collection("player_profile_cache").document(url_hash).set({
                    "details": details,
                    "expires_at": datetime.now(timezone.utc) + timedelta(days=1)
                })
            except: pass
        return {**details, "status": player_entry['status'], "group": player_entry['group'], "profile_url": player_entry['url']}
    except Exception as e:
        print(f"Error fetching player: {e}")
        return None


def _parse_bax_table(html):
    """Extract the current-season BAX value per category from the
    badminton-bax.de development page.

    Layout (per category): a header cell naming the category, a sub-header row
    (Verein | Saison | Niveau | Erfolg | BAX | …), then one or more data rows
    with class="liste" — the most recent season first. The value lives in the
    column under the "BAX" header. NOTE: the site uses class="liste" (an
    earlier version used id="liste", which is why the old parser silently
    returned 0 for everyone).
    """
    results = {"Einzel": 0, "Doppel": 0, "Mixed": 0}
    soup = BeautifulSoup(html, 'html.parser')

    table = None
    for t in soup.find_all('table'):
        txt = t.get_text()
        if 'BAX' in txt and any(cat in txt for cat in results):
            table = t
            break
    if table is None:
        return results

    current_cat = None
    bax_col = 4  # observed default column index for the BAX value
    for row in table.find_all('tr'):
        cells = [c.get_text(strip=True) for c in row.find_all(['td', 'th'])]
        for cat in results:
            if cat in cells:
                current_cat = cat
        if 'BAX' in cells:
            bax_col = cells.index('BAX')
        classes = row.get('class') or []
        if 'liste' in classes and current_cat and results[current_cat] == 0:
            if len(cells) > bax_col and cells[bax_col].isdigit():
                results[current_cat] = int(cells[bax_col])
    return results


# BAX values change only when badminton-bax.de recomputes them, which the index
# page reports as "Stand der Aktualisierung … (Turniere)". We cache each player's
# values tagged with that date, so a cache entry stays valid until the site
# actually updates — instead of expiring on a fixed timer.
_BAX_DATE = {"date": None, "at": 0.0}
_BAX_DATE_TTL = 600          # re-check the index page at most every 10 minutes
_BAX_DATE_LOCK = threading.Lock()


def _bax_update_date():
    """The badminton-bax.de tournaments 'last updated' date (e.g. '10.07.2026'),
    or None if it can't be read. Memoized in-process so an analysis run reads the
    index page once, not once per player."""
    now = time.time()
    if _BAX_DATE["date"] and now - _BAX_DATE["at"] < _BAX_DATE_TTL:
        return _BAX_DATE["date"]
    with _BAX_DATE_LOCK:
        now = time.time()
        if _BAX_DATE["date"] and now - _BAX_DATE["at"] < _BAX_DATE_TTL:
            return _BAX_DATE["date"]
        try:
            resp = _get("https://www.badminton-bax.de/index.php")
            resp.raise_for_status()
            txt = BeautifulSoup(resp.text, "html.parser").get_text(" ", strip=True)
            m = re.search(r"(\d{2}\s*\.\s*\d{2}\s*\.\s*\d{4})\s*\(Turniere\)", txt)
            date = re.sub(r"\s+", "", m.group(1)) if m else None
            if date:
                _BAX_DATE.update(date=date, at=now)
            return date
        except Exception as e:
            print(f"Could not read BAX update date: {e}")
            return _BAX_DATE["date"]  # last known date, if any


def get_bax_values(player_info, force=False):
    if player_info['id'] == "N/A":
        return {**player_info, "Einzel": 0, "Doppel": 0, "Mixed": 0}

    site_date = _bax_update_date()

    if db and not force:
        try:
            cache = db.collection("bax_values_cache").document(player_info['id']).get()
            if cache.exists:
                data = cache.to_dict()
                # Valid if the site hasn't updated since we cached; if the site
                # date can't be read, fall back to the stored TTL.
                if site_date:
                    fresh = data.get("bax_date") == site_date
                else:
                    exp = data.get("expires_at")
                    fresh = exp is not None and datetime.now(timezone.utc) < exp
                if fresh:
                    return {**player_info, "Einzel": data['Einzel'], "Doppel": data['Doppel'], "Mixed": data['Mixed']}
        except: pass

    # badminton-bax.de has no JSON/POST API — it is a server-rendered Joomla
    # page. The data view is only returned when sp_code AND the (possibly
    # empty) name/vorname/zeig_historie params are all present.
    url = "https://www.badminton-bax.de/index.php/bax-portal/spieler-entwicklung"
    params = {'sp_code': player_info['id'], 'name': player_info['last_name'], 'vorname': player_info['first_name'], 'zeig_historie': ''}

    results = {"Einzel": 0, "Doppel": 0, "Mixed": 0}
    try:
        response = _get(url, params=params)
        response.raise_for_status()
        results = _parse_bax_table(response.text)

        if db:
            try:
                db.collection("bax_values_cache").document(player_info['id']).set({
                    **results,
                    "bax_date": site_date,
                    # The bax_date is the real validity signal; this only bounds
                    # staleness for the fallback case where the date is unreadable.
                    "expires_at": datetime.now(timezone.utc) + timedelta(days=30),
                })
            except: pass
    except Exception as e:
        print(f"Error fetching BAX: {e}")

    return {**player_info, **results}


@https_fn.on_call()
def get_player_bax_data(req: https_fn.CallableRequest) -> dict:
    try:
        tournament_url = req.data.get("url")
        job_id = req.data.get("job_id")

        if not tournament_url:
            return {"error": "Missing tournament URL"}

        # Abuse guard: the analysis is by far the most expensive call (dozens of
        # upstream requests + Firestore ops). Cap it per user/IP with the free
        # in-process limiter (no Firestore cost). The frontend caches results per
        # discipline URL, so normal exploring rarely re-hits the backend.
        if not check_rate_limit(rate_key(req), "get_player_bax_data", 60, 3600000):
            return {"error": "You're running analyses too quickly. Please wait a bit before trying again."}

        # "Update Live" forces a full fresh scrape past every per-player cache;
        # it is the most expensive path, so it gets its own tight limit.
        force = bool(req.data.get("force"))
        if force and not check_rate_limit(rate_key(req), "force_bax", 10, 3600000):
            return {"error": "Live update limit reached. Please wait before refreshing again."}

        # Usage analytics: this analysis is a discipline query (and, for a pasted
        # URL, also a tournament query — browse-flow tournaments are already
        # counted when their disciplines are opened).
        authed = req.auth is not None
        source = "url" if (req.data.get("source") == "url") else "browse"
        tid, event = parse_event_url(tournament_url)
        bump_summary(["analyses", f"{source}Analyses", "disciplineQueries"], authed)
        if tid and event:
            bump_entity("usage_disciplines", f"{tid}__{event}", authed,
                        name=req.data.get("discipline_name"))
        if source == "url" and tid:
            bump_entity("usage_tournaments", tid, authed, name=req.data.get("tournament_name"))

        print(f"--- Starting Scrape for: {tournament_url} (Job: {job_id}) ---")
        
        # 1. Get Player List (deduplicated — a player can appear in multiple
        #    starting groups, but we only need to scrape each profile once).
        player_entries = get_tournament_player_links(tournament_url)
        if not player_entries:
            return {"error": "No players found on page."}

        unique_entries = list({e['url']: e for e in player_entries}.values())
        total_players = len(unique_entries)

        # Initialize Progress in Firestore
        if db and job_id:
            try:
                db.collection("jobs").document(job_id).set({
                    "status": "running",
                    "total_players": total_players,
                    "processed_players": 0,
                    "updated_at": datetime.now(timezone.utc)
                })
            except: pass

        def process_player(entry):
            info = get_player_details(entry, force=force)
            if not info:
                return None
            result = get_bax_values(info, force=force)
            # All leagues played this season → one tag per distinct division
            # tier, highest first.
            try:
                leagues_data, _ = _scrape_leagues(info.get("profile_id"), force=force)
                divs = [(dv, lg) for lg in leagues_data for dv in lg.get("divisions", [])]
                divs.sort(key=lambda pair: pair[0].get("tier", 99))
                seen_abbr, tags = set(), []
                for dv, lg in divs:
                    ab = dv.get("abbr")
                    if ab and ab not in seen_abbr:
                        seen_abbr.add(ab)
                        tags.append({
                            "abbr": ab, "division": dv.get("division"),
                            "team": dv.get("team"), "record": lg.get("record"),
                        })
                if tags:
                    result["leagues"] = tags
            except Exception:
                pass
            return result

        # 2. Scrape profiles + BAX concurrently. The two upstream sites are the
        #    bottleneck, so a thread pool cuts wall-clock time roughly
        #    MAX_WORKERS-fold vs. the old sequential loop.
        # Progress is written at ~25% steps only (not per player) to keep
        # Firestore writes low — one progress write per quarter instead of ~N/3.
        progress_step = max(1, total_players // 4)
        all_player_data = []
        processed = 0
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = [pool.submit(process_player, e) for e in unique_entries]
            for future in as_completed(futures):
                try:
                    data = future.result()
                    if data:
                        all_player_data.append(data)
                except Exception as e:
                    print(f"Player task failed: {e}")

                processed += 1
                # Updated from this single consumer thread, so no lock is needed.
                if db and job_id and (processed == total_players or processed % progress_step == 0):
                    try:
                        db.collection("jobs").document(job_id).update({
                            "processed_players": processed,
                            "updated_at": datetime.now(timezone.utc)
                        })
                    except: pass

        if not all_player_data:
            return {"error": "Failed to collect any player data"}

        # Implicit capture: record that each listed player is currently registered
        # for this tournament+discipline (with a link), powering the per-player
        # "upcoming tournaments" section. Best-effort, one batched commit.
        record_registrations(
            all_player_data, tid, event,
            tournament_name=req.data.get("tournament_name"),
            tournament_url=tournament_url,
            discipline_name=req.data.get("discipline_name"),
            start_date=(req.data.get("tournament_start") or None),
        )

        # Finalize Job Status
        if db and job_id:
            try:
                db.collection("jobs").document(job_id).update({
                    "status": "completed",
                    "processed_players": total_players
                })
            except: pass

        df = pd.DataFrame(all_player_data)
        group_sums = df.groupby('group')[["Einzel", "Doppel", "Mixed"]].sum().reset_index()
        group_sums.columns = ["group", "Sum_Einzel", "Sum_Doppel", "Sum_Mixed"]
        df = pd.merge(df, group_sums, on="group")
        # Replace pandas NaN (from players missing optional league columns) with
        # None so the payload is valid JSON / null in the frontend.
        df = df.astype(object).where(pd.notnull(df), None)

        return {
            "players": df.to_dict(orient='records'),
            "count": len(all_player_data)
        }
    except Exception as e:
        import traceback
        print(f"CRITICAL ERROR: {str(e)}")
        print(traceback.format_exc())
        return {"error": f"Internal Error: {str(e)}"}
