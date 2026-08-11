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
from datetime import datetime, date, timedelta, timezone

import requests
from bs4 import BeautifulSoup
from firebase_functions import https_fn
from google.cloud.firestore_v1.base_query import FieldFilter

from app.analytics import bump_entity, bump_summary, name_key, upsert_player_index
from app.auth import rate_key
from app.bax import _bax_update_date
from app.common import BASE, COOKIES, HEADERS
from app.firebase_app import db
from app.rate_limiting import check_rate_limit

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
        nz = [c.get_text(" ", strip=True) for c in row.find_all("td") if c.get_text(strip=True)]
        if header and freqs and buckets and nz and nz[0].isdigit():
            player_val = int(nz[0])
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
        profile_id = pm.group(1) if pm else ""

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
        profile_id = m.group(1)

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


@https_fn.on_call()
def get_player_upcoming(req: https_fn.CallableRequest) -> dict:
    """Tournaments this player is currently registered for, collected implicitly
    from every tournament analysis (see analytics.record_registrations).

    A registration is 'upcoming' when its tournament start date is today or later;
    entries whose date is unknown but were seen recently are kept (entry lists are
    published for future tournaments), and clearly past ones are dropped."""
    try:
        m = re.search(r"([0-9a-fA-F-]{36})", (req.data or {}).get("profile_id") or "")
        if not m:
            return {"error": "Missing or invalid profile id"}
        profile_id = m.group(1)
        if db is None:
            return {"upcoming": [], "count": 0}

        today = datetime.now(timezone.utc).date()
        recent_cutoff = datetime.now(timezone.utc) - timedelta(days=45)
        rows = []
        # Equality-only query (automatic single-field index); sorted in Python so
        # no composite index is required to read.
        for doc in db.collection("player_registrations").where(filter=FieldFilter("profile_id", "==", profile_id)).stream():
            r = doc.to_dict()
            start = _parse_ddmmyyyy(r.get("start_date"))
            if start and start < today:
                continue  # tournament already happened
            if not start:
                last_seen = r.get("last_seen")
                seen_dt = last_seen if isinstance(last_seen, datetime) else None
                if seen_dt and seen_dt < recent_cutoff:
                    continue  # undated and stale
            rows.append({
                "tournament_id": r.get("tournament_id"),
                "tournament_name": r.get("tournament_name"),
                "tournament_url": r.get("tournament_url"),
                "discipline_name": r.get("discipline_name"),
                "discipline_event": r.get("discipline_event"),
                "status": r.get("status"),
                "start_date": start.isoformat() if start else None,
            })
        # Dated first (soonest first), undated after.
        rows.sort(key=lambda x: (x["start_date"] is None, x["start_date"] or ""))
        return {"upcoming": rows, "count": len(rows)}
    except Exception as e:
        import traceback
        print(f"get_player_upcoming error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}
