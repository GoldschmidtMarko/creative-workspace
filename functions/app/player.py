"""Player-focused insights.

Aggregates a single player's data from the two upstream sources already scraped
elsewhere in the app:

  * badminton-bax.de spieler-entwicklung — full per-season BAX history (Einzel /
    Doppel / Mixed) and the relative-standing histograms (Landesverband + DBV).
  * dbv.turnier.de player-profile — career + this-season win/loss, titles/finals,
    and the list of tournaments played. League history is served by the existing
    get_player_leagues callable and reused as-is.

A player has two keys, both resolved during any tournament analysis:
  * sp_code   (NN-NNNNNN)  -> badminton-bax.de
  * profile_id (36-char GUID) -> dbv.turnier.de
The player_index collection remembers the mapping (written by every analysis and
by these callables) so a name search can light up the dbv-only sections and reuse
the BAX cache.
"""

import re
import hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, date, timedelta, timezone

import requests
from bs4 import BeautifulSoup
from firebase_admin import firestore
from firebase_functions import https_fn
from google.cloud.firestore_v1.base_query import FieldFilter

from app.analytics import bump_entity, bump_summary, name_key, upsert_player_index
from app.auth import rate_key
from app.bax import _bax_update_date, get_tournament_player_links
from app.common import BASE, COOKIES, HEADERS, MAX_WORKERS
from app.firebase_app import db
from app.rate_limiting import check_rate_limit
from app.tournaments import is_tournament_resolved

BAX_DEV = "https://www.badminton-bax.de/index.php/bax-portal/spieler-entwicklung"
CATS = ("Einzel", "Doppel", "Mixed")


# --------------------------------------------------------------------------- #
# badminton-bax.de: history, identity, relative-standing histograms
# --------------------------------------------------------------------------- #

def _parse_history_and_identity(html):
    """Full per-category BAX history + identity (name, birth year, club, sp_code).

    The development page renders one table.tabelle3 with a category header row
    ('Einzel'/'Doppel'/'Mixed'), a sub-header, then one class="liste" row per
    season: Verein | Saison | Niveau | Erfolg | BAX. The sp_code is only in a
    hidden form input (never visible text), which is how a name search recovers
    it.
    """
    soup = BeautifulSoup(html, "html.parser")
    ident = {"name": None, "birth_year": None, "club": None, "sp_code": None}

    inp = soup.find("input", {"name": "sp_code"})
    if inp and inp.get("value"):
        ident["sp_code"] = inp["value"].strip()

    # "Marko Goldschmidt (Jg 1996)" — anchor each name token as capitalized so the
    # surrounding lowercase UI words and the header labels aren't swept in.
    m = re.search(r"([A-ZÄÖÜ][\wÀ-ÿ.'\-]+(?:\s+[A-ZÄÖÜ][\wÀ-ÿ.'\-]+){0,3})\s*\(Jg\s*(\d{4})\)",
                  soup.get_text(" ", strip=True))
    if m:
        ident["name"] = re.sub(r"\s+", " ", m.group(1)).strip()
        ident["birth_year"] = int(m.group(2))

    history = {c: [] for c in CATS}
    table = next((t for t in soup.find_all("table", class_="tabelle3")
                  if any(c in t.get_text() for c in CATS)), None)
    if table is None:
        return ident, history

    current = None
    for row in table.find_all("tr"):
        cells = [c.get_text(" ", strip=True).replace("\xa0", " ") for c in row.find_all(["td", "th"])]
        nonempty = [c for c in cells if c]
        if len(nonempty) == 1 and nonempty[0] in CATS:
            current = nonempty[0]
            continue
        if "liste" in (row.get("class") or []) and current and len(cells) >= 5:
            verein, saison, niveau, erfolg, bax = cells[:5]
            if not re.match(r"\d{4}/\d{2}", saison):
                continue
            if not ident["club"]:
                ident["club"] = verein
            wl = re.match(r"(\d+)\s*/\s*(\d+)", erfolg)
            history[current].append({
                "season": saison,
                "club": verein,
                "niveau": int(niveau) if niveau.isdigit() else None,
                "erfolg": erfolg,
                "won": int(wl.group(1)) if wl else None,
                "lost": int(wl.group(2)) if wl else None,
                "bax": int(bax) if bax.isdigit() else None,
            })
    return ident, history


def _parse_distribution(html):
    """One histogram page (LV or DBV) -> per-category standing.

    Each category block is: a header cell 'BAX Häufigkeiten <scope> <total>
    <cat> <season>', a row of td.sauleBack frequency columns, a row of td.fs-9
    BAX bucket labels, then a row with the player's own value + name.
    """
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", class_="tabelle3")
    out = {}
    if not table:
        return out

    header = freqs = buckets = None
    for row in table.find_all("tr"):
        head_cell = row.find("td", attrs={"colspan": True})
        htext = (head_cell.get_text(" ", strip=True).replace("\xa0", " ")) if head_cell else ""
        hm = re.search(r"BAX H[äa]ufigkeiten\s+(\S+)\s+(\d+)\s+(Einzel|Doppel|Mixed)\s+(\d{4}/\d{2})", htext)
        if hm:
            header = {"scope": hm.group(1), "total": int(hm.group(2)),
                      "category": hm.group(3), "season": hm.group(4)}
            freqs = buckets = None
            continue
        saule = row.find_all("td", class_="sauleBack")
        if saule:
            freqs = [int(re.sub(r"\D", "", c.get_text()) or 0) for c in saule]
            continue
        labels = row.find_all("td", class_="fs-9")
        if labels:
            buckets = [int(re.sub(r"\D", "", c.get_text()) or 0) for c in labels]
            continue
        # Player-marker row = the player's value + their name. The value/name cell
        # ORDER flips depending on where the value falls in the histogram (e.g.
        # ['Fabio Voit','586'] vs ['524','Fabio Voit']), so pick the numeric cell
        # out rather than assuming it is first — otherwise a category is dropped.
        nz = [c.get_text(" ", strip=True) for c in row.find_all("td") if c.get_text(strip=True)]
        player_val = next((int(x) for x in nz if x.isdigit()), None) if (header and freqs and buckets) else None
        if player_val is not None and any(not x.isdigit() for x in nz):
            n = min(len(buckets), len(freqs))
            b, f = buckets[:n], freqs[:n]
            total = header["total"] or sum(f)
            below = sum(f[i] for i in range(n) if b[i] < player_val)
            out[header["category"]] = {
                "scope": header["scope"], "total": total, "season": header["season"],
                "buckets": b, "freqs": f, "player": player_val,
                "stronger_than_pct": round(100 * below / total, 1) if total else None,
            }
            header = freqs = buckets = None
    return out


def _fetch_bax(sp_code=None, last_name="", first_name=""):
    """Fetch history + both distribution histograms in one session (the diagram
    view only renders after the player has been loaded in the same session).
    Returns (identity, history, {'lv':…, 'dbv':…})."""
    s = requests.Session()
    s.headers.update(HEADERS)
    if sp_code:
        params = {"sp_code": sp_code, "name": "", "vorname": "", "zeig_historie": ""}
    else:
        params = {"name": last_name, "vorname": first_name, "zeig_historie": ""}
    resp = s.get(BAX_DEV, params=params, timeout=20)
    resp.raise_for_status()
    ident, history = _parse_history_and_identity(resp.text)
    code = sp_code or ident.get("sp_code")

    distribution = {"lv": {}, "dbv": {}}
    if code:
        for key, trigger in (("lv", "zum_dia_lv"), ("dbv", "zum_dia_dbv")):
            try:
                r = s.get(BAX_DEV, params={trigger: "", "sp_code": code, "name": "", "vorname": ""}, timeout=20)
                r.raise_for_status()
                distribution[key] = _parse_distribution(r.text)
            except Exception as e:
                print(f"distribution {key} error: {e}")
    return ident, history, distribution


# --------------------------------------------------------------------------- #
# dbv.turnier.de: win/loss, titles/finals, tournaments played
# --------------------------------------------------------------------------- #

def _get(url, session, **kwargs):
    kwargs.setdefault("timeout", 25)
    return session.get(url, **kwargs)


def _wl(text):
    m = re.search(r"(\d+)\s*/\s*(\d+)\s*\((\d+)\)", text or "")
    return {"won": int(m.group(1)), "lost": int(m.group(2)), "total": int(m.group(3))} if m else None


def _parse_winloss(html):
    """Career + this-year win/loss for Total / Einzel / Doppel / Mixed from the
    'Statistiken' module (tabs #tabStatsTotal/Singles/Doubles/Mixed; each with a
    'Karriere' and 'Dieses Jahr' row formatted 'W / L (T)')."""
    soup = BeautifulSoup(html, "html.parser")
    tab_ids = {"total": "tabStatsTotal", "Einzel": "tabStatsSingles",
               "Doppel": "tabStatsDoubles", "Mixed": "tabStatsMixed"}
    out = {}
    for key, tid in tab_ids.items():
        tab = soup.find(id=tid)
        if not tab:
            continue
        rec = {}
        for item in tab.find_all(class_="list__item"):
            label = item.find(class_="list__label")
            value = item.find(class_="list__value-start") or item.find(class_="list__value")
            if not label or not value:
                continue
            wl = _wl(value.get_text(" ", strip=True))
            if not wl:
                continue
            pb = item.find(class_="progress-bar__line")
            if pb and pb.get("aria-valuenow"):
                try:
                    wl["pct"] = int(pb["aria-valuenow"])
                except ValueError:
                    pass
            lab = label.get_text(strip=True)
            if "Karriere" in lab or "Career" in lab:
                rec["career"] = wl
            elif "Jahr" in lab or "year" in lab.lower():
                rec["year"] = wl
        if rec:
            out[key] = rec
    return out


def _parse_titles(html):
    """Titles/Finals grouped by year -> [{year, text}] (newest first, as served)."""
    soup = BeautifulSoup(html, "html.parser")
    items, year = [], None
    for el in soup.find_all(["dt", "li"]):
        cls = " ".join(el.get("class") or [])
        if "list__label" in cls:
            ym = re.search(r"(\d{4})", el.get_text())
            if ym:
                year = ym.group(1)
        elif "list__item" in cls:
            t = re.sub(r"\s+", " ", el.get_text(" ", strip=True))
            if t:
                items.append({"year": year, "text": t})
    return items


def _parse_tournaments(html):
    """Played tournaments -> [{id, name, location, start, end}] (as listed)."""
    soup = BeautifulSoup(html, "html.parser")
    out, seen = [], set()
    for a in soup.find_all("a", href=re.compile(r"/sport/tournament\?id=", re.I)):
        m = re.search(r"id=([0-9A-Fa-f-]{36})", a["href"])
        if not m:
            continue
        gid = m.group(1).upper()
        if gid in seen:
            continue
        seen.add(gid)
        card = a
        for _ in range(6):
            card = card.parent
            if card is None:
                break
            if card.name in ("li", "div") and re.search(r"\d{2}\.\d{2}\.\d{4}", card.get_text()):
                break
        text = re.sub(r"\s+", " ", card.get_text(" ", strip=True)) if card else a.get_text(" ", strip=True)
        # The name link is a sibling tournament link with visible text (the first
        # /sport/tournament link is often the logo, which has none).
        name = ""
        if card:
            for la in card.find_all("a", href=re.compile(r"/sport/tournament\?id=", re.I)):
                lt = la.get_text(" ", strip=True)
                if lt and len(lt) > len(name):
                    name = lt
        name = name or a.get_text(" ", strip=True)
        dm = re.search(r"(\d{2}\.\d{2}\.\d{4})(?:\s*bis\s*(\d{2}\.\d{2}\.\d{4}))?", text)
        loc = ""
        if name:
            lm = re.search(re.escape(name) + r"\s+(.+?)\s+\d{2}\.\d{2}\.\d{4}", text)
            if lm:
                loc = lm.group(1).strip(" -|")
        out.append({
            "id": gid, "name": name, "location": loc,
            "start": dm.group(1) if dm else None,
            "end": (dm.group(2) or dm.group(1)) if dm else None,
        })
    return out


def _fetch_dbv_stats(profile_id):
    """win/loss + titles/finals + tournaments played, in parallel."""
    s = requests.Session()
    s.headers.update(HEADERS)
    s.cookies.update(COOKIES)
    win_loss, titles, tournaments = {}, [], []
    try:
        main = _get(f"{BASE}/player-profile/{profile_id}", s)
        win_loss = _parse_winloss(main.text)
    except Exception as e:
        print(f"dbv win/loss error: {e}")
    try:
        tf = _get(f"{BASE}/player-profile/{profile_id}/PersonHome/TitlesFinals", s,
                  headers={**HEADERS, "X-Requested-With": "XMLHttpRequest",
                           "Referer": f"{BASE}/player-profile/{profile_id}"})
        titles = _parse_titles(tf.text)
    except Exception as e:
        print(f"dbv titles error: {e}")
    try:
        tr = _get(f"{BASE}/player-profile/{profile_id}/tournaments", s)
        tournaments = _parse_tournaments(tr.text)
    except Exception as e:
        print(f"dbv tournaments error: {e}")
    return {"win_loss": win_loss, "titles": titles, "tournaments": tournaments}


# --------------------------------------------------------------------------- #
# dbv.turnier.de player search (find/player) — a name-substring lookup that
# returns candidates with BOTH ids (profile GUID + sp_code), name and club.
# --------------------------------------------------------------------------- #

def _search_players(q, limit=60):
    s = requests.Session()
    s.headers.update(HEADERS)
    s.cookies.update(COOKIES)
    resp = s.get(f"{BASE}/find/player", params={"q": q}, timeout=25)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    out, seen = [], set()
    for card in soup.select(".media__wrapper"):
        link = card.find("a", href=re.compile(r"/player-profile/([0-9a-fA-F-]{36})", re.I))
        if not link:
            continue
        gid = re.search(r"/player-profile/([0-9a-fA-F-]{36})", link["href"], re.I).group(1).upper()
        if gid in seen:
            continue
        seen.add(gid)
        name_el = card.find(class_="media__link") or card.find(class_="media__title")
        name = name_el.get_text(" ", strip=True) if name_el else ""
        aside = card.find(class_="media__title-aside")
        m = re.search(r"(\d+-\d+)", aside.get_text()) if aside else None
        sub = card.find(class_="media__subheading")
        club = sub.get_text(" ", strip=True) if sub else None
        if name:
            out.append({"profile_id": gid, "sp_code": (m.group(1) if m else None),
                        "name": name, "club": club})
        if len(out) >= limit:
            break
    return out


# --------------------------------------------------------------------------- #
# player_index lookups (name/sp_code -> ids)
# --------------------------------------------------------------------------- #

def _index_lookup(sp_code=None, name_search=None):
    """Resolve known ids for a player from player_index. Equality queries only, so
    Firestore's automatic single-field indexes serve them."""
    if db is None:
        return None
    try:
        if sp_code:
            docs = list(db.collection("player_index").where(filter=FieldFilter("sp_code", "==", sp_code)).limit(1).stream())
            if docs:
                return docs[0].to_dict()
        if name_search:
            docs = list(db.collection("player_index").where(filter=FieldFilter("name_key", "==", name_search)).limit(1).stream())
            if docs:
                return docs[0].to_dict()
    except Exception as e:
        print(f"player_index lookup error: {e}")
    return None


# --------------------------------------------------------------------------- #
# Callables
# --------------------------------------------------------------------------- #

@https_fn.on_call()
def get_player_bax(req: https_fn.CallableRequest) -> dict:
    """Identity + full BAX history + relative-standing histograms.

    Accepts either a sp_code (click-through from a tournament) or a name/vorname
    (name search). Returns the resolved sp_code and, when known, the dbv
    profile_id so the frontend can load the dbv-only sections.
    """
    try:
        d = req.data or {}
        sp_code = (d.get("sp_code") or "").strip()
        sp_code = sp_code if re.match(r"^\d+-\d+$", sp_code) else ""
        last_name = (d.get("name") or d.get("last_name") or "").strip()
        first_name = (d.get("vorname") or d.get("first_name") or "").strip()
        profile_id = (d.get("profile_id") or "").strip()
        pm = re.search(r"([0-9a-fA-F-]{36})", profile_id)
        profile_id = pm.group(1).upper() if pm else ""

        if not sp_code and not last_name:
            return {"error": "Provide a player code or a name."}

        force = bool(d.get("force"))
        if force and not check_rate_limit(rate_key(req), "force_player", 20, 3600000):
            return {"error": "Live update limit reached. Please wait before refreshing again."}
        if not check_rate_limit(rate_key(req), "get_player_bax", 90, 3600000):
            return {"error": "You're looking up players too quickly. Please wait a bit."}

        # A name search can hit the BAX cache without an upstream fetch if we have
        # already mapped this name to a sp_code.
        if not sp_code and last_name:
            hit = _index_lookup(name_search=name_key(last_name, first_name))
            if hit and hit.get("sp_code"):
                sp_code = hit["sp_code"]
                if not profile_id:
                    profile_id = hit.get("profile_id") or ""

        cached = None
        site_date = _bax_update_date()
        if db and sp_code and not force:
            try:
                snap = db.collection("player_bax_cache").document(sp_code).get()
                if snap.exists:
                    data = snap.to_dict()
                    if site_date:
                        fresh = data.get("bax_date") == site_date
                    else:
                        exp = data.get("expires_at")
                        fresh = exp is not None and datetime.now(timezone.utc) < exp
                    if fresh:
                        cached = data
            except Exception:
                pass

        if cached:
            ident, history, distribution = cached["identity"], cached["history"], cached["distribution"]
        else:
            ident, history, distribution = _fetch_bax(sp_code or None, last_name, first_name)
            sp_code = sp_code or ident.get("sp_code") or ""
            if db and sp_code:
                try:
                    db.collection("player_bax_cache").document(sp_code).set({
                        "identity": ident, "history": history, "distribution": distribution,
                        "bax_date": site_date,
                        "expires_at": datetime.now(timezone.utc) + timedelta(days=30),
                    })
                except Exception:
                    pass

        if not any(history.get(c) for c in CATS) and not ident.get("name"):
            return {"error": "No BAX data found for this player."}

        # Resolve the dbv profile id (from the caller, or the index) so the
        # frontend knows whether the dbv sections are available.
        if not profile_id and sp_code:
            hit = _index_lookup(sp_code=sp_code)
            if hit:
                profile_id = hit.get("profile_id") or ""
        ident = {**ident, "sp_code": sp_code or ident.get("sp_code"), "profile_id": profile_id or None}

        upsert_player_index(profile_id, sp_code=sp_code, name=ident.get("name"))
        authed = req.auth is not None
        bump_summary(["playerProfiles"], authed)
        if profile_id:
            bump_entity("usage_players", profile_id, authed, name=ident.get("name"))

        return {"identity": ident, "history": history, "distribution": distribution}
    except Exception as e:
        import traceback
        print(f"get_player_bax error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}


@https_fn.on_call()
def get_player_dbv_stats(req: https_fn.CallableRequest) -> dict:
    """Career + this-season win/loss, titles/finals, and tournaments played."""
    try:
        d = req.data or {}
        m = re.search(r"([0-9a-fA-F-]{36})", d.get("profile_id") or "")
        if not m:
            return {"error": "Missing or invalid profile id"}
        profile_id = m.group(1).upper()

        force = bool(d.get("force"))
        if force and not check_rate_limit(rate_key(req), "force_player", 20, 3600000):
            return {"error": "Live update limit reached. Please wait before refreshing again."}
        if not check_rate_limit(rate_key(req), "get_player_dbv_stats", 90, 3600000):
            return {"error": "You're looking up players too quickly. Please wait a bit."}

        if db and not force:
            try:
                snap = db.collection("player_dbv_stats_cache").document(profile_id).get()
                if snap.exists:
                    data = snap.to_dict()
                    if datetime.now(timezone.utc) < data["expires_at"]:
                        return data["stats"]
            except Exception:
                pass

        stats = _fetch_dbv_stats(profile_id)
        if db:
            try:
                db.collection("player_dbv_stats_cache").document(profile_id).set({
                    "stats": stats,
                    # dbv is the live source (updates right after tournaments), so
                    # a short TTL keeps it fresh without hammering.
                    "expires_at": datetime.now(timezone.utc) + timedelta(hours=12),
                })
            except Exception:
                pass
        upsert_player_index(profile_id, name=d.get("name"))
        return stats
    except Exception as e:
        import traceback
        print(f"get_player_dbv_stats error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}


def _parse_ddmmyyyy(s):
    for fmt in ("%Y-%m-%d", "%d.%m.%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except (ValueError, TypeError):
            continue
    return None


def _norm_name(s):
    return re.sub(r"\s+", " ", (s or "").strip()).lower()


def _entry_list_members(url):
    """Current entry-list members of a tournament discipline, as
    [{name, status, url}]. Cached ~30 min so re-checking a player's Upcoming list
    stays cheap and doesn't hammer dbv. Returns None if the scrape fails (so the
    caller keeps the stored state instead of wrongly marking a player as left)."""
    if not url:
        return None
    key = hashlib.md5(url.encode()).hexdigest()
    if db:
        try:
            snap = db.collection("entrylist_cache").document(key).get()
            if snap.exists:
                data = snap.to_dict()
                if datetime.now(timezone.utc) < data["expires_at"]:
                    return data["entries"]
        except Exception:
            pass
    try:
        entries = get_tournament_player_links(url)
    except Exception as e:
        print(f"entry-list re-check error: {e}")
        return None
    members = [{"name": e.get("name"), "status": e.get("status"), "url": e.get("url")}
               for e in (entries or [])]
    if db:
        try:
            db.collection("entrylist_cache").document(key).set({
                "entries": members,
                "expires_at": datetime.now(timezone.utc) + timedelta(minutes=30),
            })
        except Exception:
            pass
    return members


def _find_member(members, reg):
    """Locate this player in an entry list — by their exact entry link first,
    then by normalised name. Returns the entry dict or None (= no longer in it)."""
    purl = reg.get("profile_url")
    if purl:
        for e in members:
            if e.get("url") == purl:
                return e
    nm = _norm_name(reg.get("name"))
    if nm:
        for e in members:
            if _norm_name(e.get("name")) == nm:
                return e
    return None


@https_fn.on_call()
def get_player_upcoming(req: https_fn.CallableRequest) -> dict:
    """Tournaments a player is currently registered for.

    Captured implicitly from every tournament analysis, then RE-VALIDATED on read:
    each stored (non-past) registration's live entry list is re-scraped (cached
    ~30 min) to confirm the player is still entered. Players who have withdrawn are
    flagged and dropped; waiting-list/reserve entries are kept with their status.
    Clearly-past tournaments are hidden as a guard — by start date, or (when no
    date was recorded) by dbv having already published final results."""
    try:
        m = re.search(r"([0-9a-fA-F-]{36})", (req.data or {}).get("profile_id") or "")
        if not m:
            return {"error": "Missing or invalid profile id"}
        profile_id = m.group(1).upper()
        if db is None:
            return {"upcoming": [], "count": 0}
        if not check_rate_limit(rate_key(req), "get_player_upcoming", 60, 3600000):
            return {"error": "Please wait a moment before refreshing."}

        today = datetime.now(timezone.utc).date()

        # 1. Candidate registrations (skip clearly-past tournaments). Older
        #    registrations may have no start_date (captured before the
        #    frontend reliably passed one through) — backfill it from the
        #    disciplines cache, then as a last resort drop the row if dbv has
        #    already published final results (unambiguously over regardless
        #    of any date).
        candidates = []
        for doc in db.collection("player_registrations").where(
                filter=FieldFilter("profile_id", "==", profile_id)).stream():
            r = doc.to_dict()
            start = _parse_ddmmyyyy(r.get("start_date"))
            backfill_start = None
            if not start and r.get("tournament_id"):
                try:
                    dcache = db.collection("tournament_disciplines_cache").document(r["tournament_id"]).get()
                    if dcache.exists:
                        backfill_start = dcache.to_dict().get("start")
                        start = _parse_ddmmyyyy(backfill_start)
                except Exception:
                    pass
            if start and start < today:
                continue  # already happened
            if not start and r.get("tournament_id") and is_tournament_resolved(r["tournament_id"]):
                continue  # no known date, but results are already final
            r["_ref"] = doc.reference
            r["_start"] = start
            if backfill_start:
                r["_backfill_start"] = backfill_start
            candidates.append(r)

        # 2. Re-scrape each distinct entry list once (concurrently, cached 30 min).
        urls = {r.get("tournament_url") for r in candidates if r.get("tournament_url")}
        members_by_url = {}
        if urls:
            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
                futs = {pool.submit(_entry_list_members, u): u for u in urls}
                for f in as_completed(futs):
                    try:
                        members_by_url[futs[f]] = f.result()
                    except Exception:
                        members_by_url[futs[f]] = None

        # 3. Confirm membership; persist withdrawn/status; keep those still entered.
        rows = []
        batch = db.batch()
        writes = 0
        for r in candidates:
            members = members_by_url.get(r.get("tournament_url"))
            withdrawn = bool(r.get("withdrawn"))
            status = r.get("status")
            update_fields = {}
            if r.get("_backfill_start"):
                update_fields["start_date"] = r["_backfill_start"]
            if members is not None:                      # scrape succeeded → authoritative
                entry = _find_member(members, r)
                if entry:
                    withdrawn = False
                    status = entry.get("status") or status
                else:
                    withdrawn = True
                update_fields["withdrawn"] = withdrawn
                update_fields["status"] = status
                update_fields["last_checked"] = firestore.SERVER_TIMESTAMP
            if update_fields:
                try:
                    batch.update(r["_ref"], update_fields)
                    writes += 1
                    if writes % 400 == 0:
                        batch.commit()
                        batch = db.batch()
                except Exception:
                    pass
            if withdrawn:
                continue                                 # left the position → not upcoming
            rows.append({
                "tournament_id": r.get("tournament_id"),
                "tournament_name": r.get("tournament_name"),
                "tournament_url": r.get("tournament_url"),
                "discipline_name": r.get("discipline_name"),
                "discipline_event": r.get("discipline_event"),
                "status": status,
                "start_date": r["_start"].isoformat() if r["_start"] else None,
            })
        if writes % 400:
            try:
                batch.commit()
            except Exception:
                pass

        rows.sort(key=lambda x: (x["start_date"] is None, x["start_date"] or ""))
        return {"upcoming": rows, "count": len(rows)}
    except Exception as e:
        import traceback
        print(f"get_player_upcoming error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}


@https_fn.on_call()
def search_players(req: https_fn.CallableRequest) -> dict:
    """Search dbv.turnier.de for players by name (substring match), returning
    candidates with both ids so the profile loads robustly."""
    try:
        q = ((req.data or {}).get("q") or "").strip()
        if len(q) < 2:
            return {"players": [], "count": 0}
        if not check_rate_limit(rate_key(req), "search_players", 60, 3600000):
            return {"error": "You're searching too quickly. Please wait a bit."}

        key = hashlib.md5(q.lower().encode()).hexdigest()
        if db:
            try:
                snap = db.collection("player_search_cache").document(key).get()
                if snap.exists:
                    data = snap.to_dict()
                    if datetime.now(timezone.utc) < data["expires_at"]:
                        return {"players": data["players"], "count": len(data["players"])}
            except Exception:
                pass

        players = _search_players(q)
        if db:
            try:
                db.collection("player_search_cache").document(key).set({
                    "players": players,
                    "expires_at": datetime.now(timezone.utc) + timedelta(hours=12),
                })
            except Exception:
                pass
        bump_summary(["playerSearches"], req.auth is not None)
        return {"players": players, "count": len(players)}
    except Exception as e:
        import traceback
        print(f"search_players error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}
