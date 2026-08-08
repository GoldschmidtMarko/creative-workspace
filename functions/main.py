from firebase_functions import https_fn
from firebase_functions.options import set_global_options
from firebase_admin import initialize_app, firestore
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from bs4 import BeautifulSoup
import pandas as pd
import time
import re
import os
import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

# Initialize the Firebase App
# In the emulator, this will automatically pick up emulator settings
try:
    initialize_app()
    db = firestore.client()
    print("✅ Firestore initialized successfully.")
except Exception as e:
    print(f"⚠️  Firestore initialization failed: {e}. Using memory cache instead.")
    db = None

# Simple Memory Cache Fallback
MEMORY_CACHE = {
    "tournaments": {},
    "profiles": {},
    "bax": {}
}

# Set global options
set_global_options(max_instances=10, timeout_sec=540, memory=512)

# Configuration for scraping
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}
COOKIES = {
    "st": "l=1031&exp=46509.8685846875&c=1&cp=23&s=2"
}

# How many players to scrape concurrently. Each player = 2 upstream requests
# (DBV profile + badminton-bax.de), so keep this modest to stay polite.
MAX_WORKERS = 8

# A single pooled session shared across threads. requests.Session is
# thread-safe for issuing requests, and a large connection pool lets the
# thread pool reuse keep-alive connections instead of opening a socket per
# call. Retries smooth over the occasional flaky upstream response.
_SESSION = requests.Session()
_adapter = HTTPAdapter(
    pool_connections=MAX_WORKERS,
    pool_maxsize=MAX_WORKERS * 2,
    max_retries=Retry(total=2, backoff_factor=0.3,
                      status_forcelist=(500, 502, 503, 504)),
)
_SESSION.mount("https://", _adapter)
_SESSION.mount("http://", _adapter)


def _get(url, **kwargs):
    """GET via the shared pooled session with default headers/timeout."""
    kwargs.setdefault("headers", HEADERS)
    kwargs.setdefault("timeout", 15)
    return _SESSION.get(url, **kwargs)

def get_tournament_player_links(url):
    url_hash = hashlib.md5(url.encode()).hexdigest()
    
    # Check Firestore Cache
    if db:
        try:
            cache = db.collection("tournament_cache").document(url_hash).get()
            if cache.exists:
                data = cache.to_dict()
                if datetime.now(timezone.utc) < data['expires_at'] and data.get('entries'):
                    return data['entries']
        except: pass
    
    # Check Memory Cache
    if url_hash in MEMORY_CACHE["tournaments"] and MEMORY_CACHE["tournaments"][url_hash]:
        return MEMORY_CACHE["tournaments"][url_hash]

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
        
        # Save to Cache
        if db:
            try:
                db.collection("tournament_cache").document(url_hash).set({
                    "entries": entries,
                    "expires_at": datetime.now(timezone.utc) + timedelta(hours=1)
                })
            except: pass
        MEMORY_CACHE["tournaments"][url_hash] = entries
        return entries
    except Exception as e:
        print(f"Error fetching tournament: {e}")
        return []

def get_player_details(player_entry):
    url_hash = hashlib.md5(player_entry['url'].encode()).hexdigest()
    
    if db:
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

        # The player.aspx page links to the global /player-profile/<guid>, which
        # is the id used by the league pages.
        prof = re.search(r'/player-profile/([0-9a-fA-F-]{36})', response.text)
        profile_id = prof.group(1) if prof else None

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


def get_bax_values(player_info):
    if player_info['id'] == "N/A":
        return {**player_info, "Einzel": 0, "Doppel": 0, "Mixed": 0}

    if db:
        try:
            cache = db.collection("bax_values_cache").document(player_info['id']).get()
            if cache.exists:
                data = cache.to_dict()
                if datetime.now(timezone.utc) < data['expires_at']:
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
                    "expires_at": datetime.now(timezone.utc) + timedelta(hours=12)
                })
            except: pass
    except Exception as e:
        print(f"Error fetching BAX: {e}")

    return {**player_info, **results}


# --- Player league history (dbv.turnier.de /player-profile/<id>/leagues) ------

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


def _scrape_leagues(profile_id, year=None):
    """Scrape a player's leagues for one season, grouped by league. Returns
    (leagues, available_years). Each league carries one shared record/season
    plus its divisions (one league can span several divisions/draws, each with
    its own team):
    {season, record, standing, divisions: [{abbr, division, tier, team}]}."""
    if not profile_id:
        return [], []
    cache_key = f"{profile_id}_{year or 'current'}"
    if db:
        try:
            cache = db.collection("player_leagues_cache").document(cache_key).get()
            if cache.exists:
                data = cache.to_dict()
                if datetime.now(timezone.utc) < data["expires_at"]:
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
        years = sorted(set(re.findall(r"/leagues/(\d{4})", resp.text)), reverse=True)
    except Exception as e:
        print(f"Error scraping leagues: {e}")

    if db:
        try:
            db.collection("player_leagues_cache").document(cache_key).set({
                "leagues": leagues, "years": years,
                "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
            })
        except Exception:
            pass
    return leagues, years


@https_fn.on_call()
def get_player_bax_data(req: https_fn.CallableRequest) -> dict:
    try:
        tournament_url = req.data.get("url")
        job_id = req.data.get("job_id")
        
        if not tournament_url:
            return {"error": "Missing tournament URL"}

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
            info = get_player_details(entry)
            if not info:
                return None
            result = get_bax_values(info)
            # All leagues played this season → one tag per distinct division
            # tier, highest first.
            try:
                leagues_data, _ = _scrape_leagues(info.get("profile_id"))
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
                # Progress is updated from this single consumer thread, so no
                # lock is needed. Throttle writes to avoid hammering Firestore.
                if db and job_id and (processed == total_players or processed % 3 == 0):
                    try:
                        db.collection("jobs").document(job_id).update({
                            "processed_players": processed,
                            "updated_at": datetime.now(timezone.utc)
                        })
                    except: pass

        if not all_player_data:
            return {"error": "Failed to collect any player data"}

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

# --- Tournament browsing (dbv.turnier.de find) -------------------------------

BASE = "https://dbv.turnier.de"


def _search_tournaments(filters):
    """POST the dbv.turnier.de find form and parse the tournament result cards.

    `filters` keys: q, start_date, end_date, postal_code, distance,
    registration_only (bool), page.
    """
    session = requests.Session()
    session.cookies.update(COOKIES)
    # Prime the session (some cookie state is set on the initial GET).
    try:
        session.get(f"{BASE}/find", headers=HEADERS, timeout=15)
    except Exception:
        pass

    form = {
        "Page": str(filters.get("page", 1)),
        "TournamentFilter.Q": filters.get("q", "") or "",
        "TournamentFilter.DateFilterType": "0",
        "TournamentFilter.StartDate": filters.get("start_date", "") or "",
        "TournamentFilter.EndDate": filters.get("end_date", "") or "",
    }
    if filters.get("postal_code"):
        form["TournamentFilter.PostalCode"] = filters["postal_code"]
        form["TournamentFilter.Distance"] = str(filters.get("distance", 25))
    # StatusFilterID 2 == "Meldeschluss" (registration open). Omit to list all.
    if filters.get("registration_only"):
        form["TournamentExtendedFilter.StatusFilterID"] = "2"

    ajax_headers = {
        **HEADERS,
        "X-Requested-With": "XMLHttpRequest",
        "Referer": f"{BASE}/find",
        "Origin": BASE,
    }
    resp = session.post(
        f"{BASE}/find/tournament/DoSearch",
        headers=ajax_headers, data=form, timeout=25,
    )
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    results = []
    seen = set()
    for link in soup.find_all("a", href=re.compile(r"tournament\?id=", re.I)):
        m = re.search(r"id=([0-9A-Fa-f-]{36})", link["href"])
        if not m:
            continue
        gid = m.group(1).upper()
        if gid in seen:
            continue
        # Walk up to the enclosing card.
        card = link.find_parent(class_="media") or link.find_parent("li")
        if not card:
            continue
        seen.add(gid)

        title_el = card.find(class_="media__title")
        name = (title_el.get_text(" ", strip=True) if title_el
                else link.get("title") or link.get_text(" ", strip=True))

        # Subheadings: first is location (marker icon), muted one holds dates.
        location = ""
        for sub in card.find_all(class_="media__subheading"):
            if "media__subheading--muted" in (sub.get("class") or []):
                continue
            location = sub.get_text(" ", strip=True)
            break
        club, city = location, ""
        if "|" in location:
            club, city = [p.strip() for p in location.split("|", 1)]

        times = card.select(".media__subheading--muted time")
        start = times[0].get("datetime", "")[:10] if len(times) >= 1 else ""
        end = times[1].get("datetime", "")[:10] if len(times) >= 2 else start
        date_text = ""
        muted = card.find(class_="media__subheading--muted")
        if muted:
            date_text = muted.get_text(" ", strip=True)

        tag_el = card.find(class_="tag")
        tag = tag_el.get_text(strip=True) if tag_el else ""

        img_el = card.find("img", class_="media__img-element")
        logo = img_el.get("src", "") if img_el else ""
        if logo.startswith("//"):
            logo = "https:" + logo

        entry_link = card.find("a", href=re.compile(r"onlineentry", re.I))
        registration_open = entry_link is not None
        deadline = ""
        if entry_link:
            label = entry_link.find_next(class_="btn__label")
            if label:
                deadline = label.get_text(" ", strip=True)

        results.append({
            "id": gid,
            "name": name,
            "club": club,
            "city": city,
            "start": start,
            "end": end,
            "date_text": date_text,
            "tag": tag,
            "logo": logo,
            "registration_open": registration_open,
            "deadline": deadline,
        })
    return results


@https_fn.on_call()
def find_tournaments(req: https_fn.CallableRequest) -> dict:
    """Return a filtered list of tournaments from dbv.turnier.de."""
    try:
        d = req.data or {}
        filters = {
            "q": (d.get("q") or "").strip(),
            "start_date": d.get("start_date") or "",
            "end_date": d.get("end_date") or "",
            "postal_code": (d.get("postal_code") or "").strip(),
            "distance": d.get("distance") or 25,
            "registration_only": bool(d.get("registration_only")),
            "page": int(d.get("page") or 1),
        }
        cache_key = hashlib.md5(str(sorted(filters.items())).encode()).hexdigest()

        # Firestore cache (short TTL — listings change often).
        if db:
            try:
                cache = db.collection("tournament_search_cache").document(cache_key).get()
                if cache.exists:
                    data = cache.to_dict()
                    if datetime.now(timezone.utc) < data["expires_at"]:
                        return {"tournaments": data["tournaments"], "count": len(data["tournaments"])}
            except Exception:
                pass

        tournaments = _search_tournaments(filters)

        if db:
            try:
                db.collection("tournament_search_cache").document(cache_key).set({
                    "tournaments": tournaments,
                    "expires_at": datetime.now(timezone.utc) + timedelta(minutes=15),
                })
            except Exception:
                pass

        return {"tournaments": tournaments, "count": len(tournaments)}
    except Exception as e:
        import traceback
        print(f"find_tournaments error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}


@https_fn.on_call()
def get_tournament_disciplines(req: https_fn.CallableRequest) -> dict:
    """Return the disciplines (events) of a tournament plus the URL to analyze
    each one. Each item: {event, name, url}."""
    try:
        gid = (req.data or {}).get("id", "")
        m = re.search(r"([0-9A-Fa-f-]{36})", gid or "")
        if not m:
            return {"error": "Missing or invalid tournament id"}
        gid = m.group(1).upper()

        if db:
            try:
                cache = db.collection("tournament_disciplines_cache").document(gid).get()
                if cache.exists:
                    data = cache.to_dict()
                    if datetime.now(timezone.utc) < data["expires_at"]:
                        return {"disciplines": data["disciplines"], "count": len(data["disciplines"])}
            except Exception:
                pass

        session = requests.Session()
        session.cookies.update(COOKIES)
        resp = session.get(f"{BASE}/sport/events.aspx?id={gid}", headers=HEADERS, timeout=20)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        disciplines = []
        seen = set()
        for a in soup.find_all("a", href=re.compile(r"event\.aspx\?id=.*event=\d+", re.I)):
            em = re.search(r"event=(\d+)", a["href"])
            if not em:
                continue
            ev = em.group(1)
            if ev in seen:
                continue
            name = a.get_text(" ", strip=True)
            if not name:
                continue
            seen.add(ev)
            disciplines.append({
                "event": ev,
                "name": name,
                "url": f"{BASE}/sport/event.aspx?id={gid}&event={ev}",
            })

        if db:
            try:
                db.collection("tournament_disciplines_cache").document(gid).set({
                    "disciplines": disciplines,
                    "expires_at": datetime.now(timezone.utc) + timedelta(hours=6),
                })
            except Exception:
                pass

        return {"disciplines": disciplines, "count": len(disciplines)}
    except Exception as e:
        import traceback
        print(f"get_tournament_disciplines error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}



@https_fn.on_call()
def get_player_leagues(req: https_fn.CallableRequest) -> dict:
    """Return a player's league memberships across all available seasons,
    newest first — used by the player-profile popup."""
    try:
        pid = (req.data or {}).get("profile_id", "")
        m = re.search(r"([0-9a-fA-F-]{36})", pid or "")
        if not m:
            return {"error": "Missing or invalid profile id"}
        pid = m.group(1)

        current, years = _scrape_leagues(pid)
        seasons, seen_labels = [], set()

        def add(league_list):
            if not league_list:
                return
            label = league_list[0].get("season") or "?"
            if label in seen_labels:
                return
            seen_labels.add(label)
            seasons.append({"season": label, "leagues": league_list})

        add(current)  # base page == current season
        for y in years:
            lg, _ = _scrape_leagues(pid, y)
            add(lg)
        seasons.sort(key=lambda s: s["season"] or "", reverse=True)
        return {"seasons": seasons}
    except Exception as e:
        import traceback
        print(f"get_player_leagues error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}


@https_fn.on_call()
def ping(req: https_fn.CallableRequest) -> dict:
    return {"status": "pong", "time": str(datetime.now(timezone.utc))}