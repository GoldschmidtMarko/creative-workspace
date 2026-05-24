from firebase_functions import https_fn
from firebase_functions.options import set_global_options
from firebase_admin import initialize_app, firestore
import requests
from bs4 import BeautifulSoup
import pandas as pd
import time
import re
import os
import hashlib
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
        session = requests.Session()
        session.cookies.update(COOKIES)
        response = session.get(url, headers=HEADERS, timeout=15)
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
                    entries.append({"url": full_url, "status": status, "group": group_id})
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
                    return {**data['details'], "status": player_entry['status'], "group": player_entry['group']}
        except: pass

    try:
        session = requests.Session()
        session.cookies.update(COOKIES)
        response = session.get(player_entry['url'], headers=HEADERS, timeout=10)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        
        container = soup.find(class_='media__body') or soup.find(class_='media')
        if not container:
            for h in soup.find_all(['h2', 'h1', 'h3']):
                if re.search(r'\(\d+-\d+\)', h.get_text()):
                    container = h
                    break
        
        full_text = container.get_text(" ", strip=True) if container else ""
        match = re.search(r'\((\d+-\d+)\)', full_text)
        if not match:
            match = re.search(r'\((\d+-\d+)\)', response.text)
        player_id = match.group(1) if match else "N/A"
        
        name_link = soup.find('a', class_='media__link')
        name_part = name_link.get_text(strip=True) if name_link else full_text.split('(')[0].strip()
        
        details = {
            "id": player_id,
            "full_name": name_part,
            "last_name": name_part.split()[-1] if len(name_part.split()) >= 2 else name_part,
            "first_name": " ".join(name_part.split()[:-1]) if len(name_part.split()) >= 2 else "",
        }
        
        if db:
            try:
                db.collection("player_profile_cache").document(url_hash).set({
                    "details": details,
                    "expires_at": datetime.now(timezone.utc) + timedelta(days=1)
                })
            except: pass
        return {**details, "status": player_entry['status'], "group": player_entry['group']}
    except Exception as e:
        print(f"Error fetching player: {e}")
        return None

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

    url = "https://www.badminton-bax.de/index.php/bax-portal/spieler-entwicklung"
    params = {'sp_code': player_info['id'], 'name': player_info['last_name'], 'vorname': player_info['first_name'], 'zeig_historie': ''}
    
    results = {"Einzel": 0, "Doppel": 0, "Mixed": 0}
    try:
        response = requests.get(url, params=params, headers=HEADERS, timeout=10)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        
        current_cat = None
        for element in soup.find_all(['td', 'tr']):
            text = element.get_text(strip=True)
            if text in ["Einzel", "Doppel", "Mixed"]:
                current_cat = text
                continue
            if current_cat and element.name == 'tr' and element.get('id') == 'liste':
                if results[current_cat] == 0:
                    cells = [td.get_text(strip=True) for td in element.find_all('td')]
                    if len(cells) >= 5 and cells[4].isdigit():
                        results[current_cat] = int(cells[4])
        
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

@https_fn.on_call()
def get_player_bax_data(req: https_fn.CallableRequest) -> dict:
    try:
        tournament_url = req.data.get("url")
        job_id = req.data.get("job_id")
        
        if not tournament_url:
            return {"error": "Missing tournament URL"}

        print(f"--- Starting Scrape for: {tournament_url} (Job: {job_id}) ---")
        
        # 1. Get Player List
        player_entries = get_tournament_player_links(tournament_url)
        if not player_entries:
            return {"error": "No players found on page."}
        
        total_players = len(player_entries)
        
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

        all_player_data = []
        processed_links = set()
        
        for i, entry in enumerate(player_entries):
            if entry['url'] in processed_links: 
                # Still update progress even if skipped
                if db and job_id:
                    try: db.collection("jobs").document(job_id).update({"processed_players": i + 1})
                    except: pass
                continue
                
            processed_links.add(entry['url'])
            
            # Scrape Player & BAX
            info = get_player_details(entry)
            if info:
                bax_data = get_bax_values(info)
                all_player_data.append(bax_data)
            
            # Update Progress every player
            if db and job_id:
                try:
                    db.collection("jobs").document(job_id).update({
                        "processed_players": i + 1,
                        "updated_at": datetime.now(timezone.utc)
                    })
                except: pass
            
            time.sleep(0.1)
            
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
        
        return {
            "players": df.to_dict(orient='records'),
            "count": len(all_player_data)
        }
    except Exception as e:
        import traceback
        print(f"CRITICAL ERROR: {str(e)}")
        print(traceback.format_exc())
        return {"error": f"Internal Error: {str(e)}"}

@https_fn.on_call()
def ping(req: https_fn.CallableRequest) -> dict:
    return {"status": "pong", "time": str(datetime.now(timezone.utc))}