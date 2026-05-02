import requests
from bs4 import BeautifulSoup
import pandas as pd
import time
import re
import os

# Configuration
TOURNAMENT_URL = "https://dbv.turnier.de/sport/event.aspx?id=1EB702E0-4333-44F8-BBEB-FE5DE2E91269&event=62"
OUTPUT_FILENAME = "player_bax_values.csv"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}
# Cookie to bypass the 'cookiewall'
COOKIES = {
    "st": "l=1031&exp=46509.8685846875&c=1&cp=23&s=2"
}

def get_tournament_player_links(url):
    """Extracts player profile links, status, and grouping from the tournament page."""
    print(f"Fetching tournament page: {url}")
    try:
        session = requests.Session()
        session.cookies.update(COOKIES)
        
        response = session.get(url, headers=HEADERS, timeout=15)
        response.raise_for_status()
        
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Find the main player table
        table = soup.find('table', class_='ruler')
        if not table:
            print("  Could not find player table (class='ruler').")
            return []
            
        entries = []
        group_id = 1
        
        for row in table.find_all('tr'):
            cells = row.find_all('td')
            if len(cells) < 2:
                continue
                
            # Status is in the first cell
            status = cells[0].get_text(strip=True)
            if not status or "Spieler" in status: # Skip headers
                continue
            
            # Players are in the second cell
            player_links = cells[1].find_all('a', href=re.compile(r'player\.aspx'))
            if not player_links:
                continue
                
            for a in player_links:
                href = a['href']
                if href.startswith('/'):
                    full_url = "https://dbv.turnier.de" + href
                elif href.startswith('http'):
                    full_url = href
                else:
                    full_url = "https://dbv.turnier.de/sport/" + href
                
                entries.append({
                    "url": full_url,
                    "status": status,
                    "group": group_id
                })
            
            group_id += 1
        
        print(f"Found {len(entries)} player entries in {group_id - 1} groups.")
        return entries
    except Exception as e:
        print(f"Error fetching tournament page: {e}")
        return []

def get_player_details(player_entry):
    """Extracts player name and ID from their turnier.de profile page."""
    profile_url = player_entry['url']
    try:
        session = requests.Session()
        session.cookies.update(COOKIES)
        
        response = session.get(profile_url, headers=HEADERS, timeout=10)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        
        container = soup.find(class_='media__body') or soup.find(class_='media')
        
        if not container:
            for h in soup.find_all(['h2', 'h1', 'h3']):
                if re.search(r'\(\d+-\d+\)', h.get_text()):
                    container = h
                    break
        
        if not container:
            container = soup.find('body')
            
        full_text = container.get_text(" ", strip=True) if container else ""
        
        match = re.search(r'\((\d+-\d+)\)', full_text)
        if not match:
            match = re.search(r'\((\d+-\d+)\)', response.text)
            
        player_id = match.group(1) if match else "N/A"
        
        name_link = soup.find('a', class_='media__link')
        if name_link:
            name_part = name_link.get_text(strip=True)
        else:
            name_part = full_text.split('(')[0].strip()
            if any(x in name_part for x in ["Cup", "Tournament", "Alemannen"]):
                 for h in soup.find_all(['h2', 'h3']):
                     txt = h.get_text(strip=True)
                     if txt and not any(x in txt for x in ["Cup", "Turnier", "Spieler", "Player", "Alemannen"]):
                         name_part = txt
                         break
        
        return {
            "id": player_id,
            "first_name": " ".join(name_part.split()[:-1]) if len(name_part.split()) >= 2 else name_part,
            "last_name": name_part.split()[-1] if len(name_part.split()) >= 2 else "",
            "full_name": name_part,
            "status": player_entry['status'],
            "group": player_entry['group']
        }
    except Exception as e:
        print(f"Error fetching player profile {profile_url}: {e}")
        return None

def get_bax_values(player_info):
    """Fetches BAX values from badminton-bax.de, taking the most recent available."""
    if not player_info['id'] or player_info['id'] == "N/A":
        return {
            "Name": player_info['full_name'],
            "ID": "N/A",
            "Group": player_info['group'],
            "Status": player_info['status'],
            "Einzel": "N/A",
            "Doppel": "N/A",
            "Mixed": "N/A"
        }

    url = "https://www.badminton-bax.de/index.php/bax-portal/spieler-entwicklung"
    params = {
        'sp_code': player_info['id'],
        'name': player_info['last_name'],
        'vorname': player_info['first_name'],
        'zeig_historie': ''
    }
    
    print(f"  Scraping BAX for {player_info['full_name']} ({player_info['id']})...")
    
    results = {
        "Name": player_info['full_name'],
        "ID": player_info['id'],
        "Group": player_info['group'],
        "Status": player_info['status'],
        "Einzel": "N/A",
        "Doppel": "N/A",
        "Mixed": "N/A"
    }
    
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
                if results[current_cat] == "N/A":
                    cells = [td.get_text(strip=True) for td in element.find_all('td')]
                    if len(cells) >= 5 and cells[4].isdigit():
                        results[current_cat] = cells[4]
                        season = cells[1]
                        print(f"    Found {current_cat}: {cells[4]} (Season {season})")
                    
    except Exception as e:
        print(f"    Error fetching BAX for {player_info['full_name']}: {e}")
        
    return results

def main():
    print("=== Badminton Player BAX Scraper ===")
    
    # Check if we already have the data
    if os.path.exists(OUTPUT_FILENAME):
        print(f"--- Loading existing data from {OUTPUT_FILENAME} ---")
        df = pd.read_csv(OUTPUT_FILENAME)
        
        # Check if post-processing is needed (if sum columns are missing)
        if "Sum_Einzel" not in df.columns:
            print("--- Adding missing group sum columns ---")
            # Convert BAX columns to numeric for calculation
            for cat in ["Einzel", "Doppel", "Mixed"]:
                df[cat] = pd.to_numeric(df[cat], errors='coerce').fillna(0)
            
            # Calculate Group Sums
            group_sums = df.groupby('Group')[["Einzel", "Doppel", "Mixed"]].sum().reset_index()
            group_sums.columns = ["Group", "Sum_Einzel", "Sum_Doppel", "Sum_Mixed"]
            
            # Merge sums back into the main dataframe
            df = pd.merge(df, group_sums, on="Group")
            
            # Reorder columns
            cols = ["Group", "Status", "Name", "ID", "Einzel", "Doppel", "Mixed", "Sum_Einzel", "Sum_Doppel", "Sum_Mixed"]
            df = df[cols]
            df.to_csv(OUTPUT_FILENAME, index=False)
            print(f"Updated {OUTPUT_FILENAME} with group sums.")
    else:
        # 1. Get player entries (links + status + group)
        player_entries = get_tournament_player_links(TOURNAMENT_URL)
        if not player_entries:
            print("No players found. Exiting.")
            return
            
        all_player_data = []
        seen_ids = set()
        processed_links = set()
        
        # 2. Iterate through players
        for entry in player_entries:
            if entry['url'] in processed_links:
                continue
            processed_links.add(entry['url'])
                
            info = get_player_details(entry)
            if not info:
                continue
                
            if info['id'] != "N/A":
                seen_ids.add(info['id'])
            
            bax_data = get_bax_values(info)
            all_player_data.append(bax_data)
            time.sleep(0.5)
            
        if not all_player_data:
            print("No data collected.")
            return

        df = pd.DataFrame(all_player_data)
        
        # Post-processing: Convert BAX columns to numeric and calculate Group Sums
        for cat in ["Einzel", "Doppel", "Mixed"]:
            df[cat] = pd.to_numeric(df[cat], errors='coerce').fillna(0)
        
        group_sums = df.groupby('Group')[["Einzel", "Doppel", "Mixed"]].sum().reset_index()
        group_sums.columns = ["Group", "Sum_Einzel", "Sum_Doppel", "Sum_Mixed"]
        
        df = pd.merge(df, group_sums, on="Group")
        
        # Reorder columns
        cols = ["Group", "Status", "Name", "ID", "Einzel", "Doppel", "Mixed", "Sum_Einzel", "Sum_Doppel", "Sum_Mixed"]
        df = df[cols]
        df.to_csv(OUTPUT_FILENAME, index=False)
        print(f"\nSuccessfully scraped {len(all_player_data)} players.")
        print(f"Results saved to {OUTPUT_FILENAME}")

    # --- Print Summary (Same for both cached and new data) ---
    print("\nSummary (including Group Totals):")
    print("="*125)
    print(f"{'Grp':<4} | {'Status':<15} | {'Name':<25} | {'ID':<12} | {'Einzel':<6} (Sum) | {'Doppel':<6} (Sum) | {'Mixed':<6} (Sum)")
    print("-"*125)
    
    last_group = None
    for _, row in df.iterrows():
        # Only print group sums on the first line of each group for clarity
        e_sum = f"({int(row['Sum_Einzel']):<4})" if row['Group'] != last_group else " "*6
        d_sum = f"({int(row['Sum_Doppel']):<4})" if row['Group'] != last_group else " "*6
        m_sum = f"({int(row['Sum_Mixed']):<4})" if row['Group'] != last_group else " "*6
        
        print(f"{row['Group']:<4} | {row['Status']:<15} | {row['Name']:<25} | {row['ID']:<12} | {int(row['Einzel']):<6} {e_sum} | {int(row['Doppel']):<6} {d_sum} | {int(row['Mixed']):<6} {m_sum}")
        last_group = row['Group']
    print("="*125)

if __name__ == "__main__":
    main()
