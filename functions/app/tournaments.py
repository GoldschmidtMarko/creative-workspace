"""Tournament browsing (find) and per-tournament disciplines."""

import re
import hashlib
from datetime import datetime, timedelta, timezone

import requests
from bs4 import BeautifulSoup
from firebase_functions import https_fn

from app.analytics import bump_entity, bump_summary
from app.auth import rate_key
from app.common import BASE, COOKIES, HEADERS, _get
from app.firebase_app import db
from app.rate_limiting import check_rate_limit


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
        bump_summary(["browseSearches"], req.auth is not None)
        d = req.data or {}
        force = bool(d.get("force"))
        if force and not check_rate_limit(rate_key(req), "force_search", 20, 3600000):
            return {"error": "Live update limit reached. Please wait before refreshing again."}
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
        if db and not force:
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

        force = bool((req.data or {}).get("force"))
        if force and not check_rate_limit(rate_key(req), "force_disc", 20, 3600000):
            return {"error": "Live update limit reached. Please wait before refreshing again."}

        authed = req.auth is not None
        bump_summary(["tournamentQueries"], authed)
        bump_entity("usage_tournaments", gid, authed, name=(req.data or {}).get("name"))

        if db and not force:
            try:
                cache = db.collection("tournament_disciplines_cache").document(gid).get()
                if cache.exists:
                    data = cache.to_dict()
                    if datetime.now(timezone.utc) < data["expires_at"]:
                        return {"disciplines": data["disciplines"], "count": len(data["disciplines"]),
                                "name": data.get("name", ""), "start": data.get("start", ""),
                                "end": data.get("end", ""), "city": data.get("city", "")}
            except Exception:
                pass

        session = requests.Session()
        session.cookies.update(COOKIES)
        resp = session.get(f"{BASE}/sport/events.aspx?id={gid}", headers=HEADERS, timeout=20)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        # Tournament identity (so a bare shared link — id only — still renders a
        # proper header). Name is in the .media__title; fall back to the <title>
        # "… - <name> - Konkurrenzen". Dates are the first two dd.mm.yyyy on page.
        tname_el = soup.find(class_="media__title")
        tname = tname_el.get_text(" ", strip=True) if tname_el else ""
        if not tname:
            tt = soup.find("title")
            m = re.search(r"-\s*(.+?)\s*-\s*Konkurrenzen", tt.get_text()) if tt else None
            tname = m.group(1).strip() if m else ""
        dates = re.findall(r"\d{2}\.\d{2}\.\d{4}", soup.get_text(" ", strip=True))
        tstart = dates[0] if dates else ""
        tend = dates[1] if len(dates) > 1 else tstart

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
                    "name": tname, "start": tstart, "end": tend,
                    "expires_at": datetime.now(timezone.utc) + timedelta(hours=6),
                })
            except Exception:
                pass

        return {"disciplines": disciplines, "count": len(disciplines),
                "name": tname, "start": tstart, "end": tend}
    except Exception as e:
        import traceback
        print(f"get_tournament_disciplines error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}


def _parse_winners_html(html):
    """Parse dbv.turnier.de/sport/winners.aspx into per-discipline placements.

    Each discipline/group's rows sit in one <table class="ruler seeding">,
    headed by a <th><a href="event.aspx?...&event=N">GROUP-NAME</a></th> row
    that carries the same event id used by get_tournament_disciplines.
    Placement rows follow: rank text ("1", "5/8", ...) in the first <td>, one
    or more player links in the second (two for doubles/mixed). Returns
    {event: {name, rows: [{rank, players: [{name, seed, url}]}]}}.
    """
    soup = BeautifulSoup(html, "html.parser")
    groups = {}
    current = None
    for row in soup.select("table.ruler.seeding tr"):
        th = row.find("th")
        if th is not None:
            current = None
            a = th.find("a", href=re.compile(r"event\.aspx\?.*event=\d+", re.I))
            if a:
                em = re.search(r"event=(\d+)", a["href"])
                if em:
                    current = groups.setdefault(em.group(1), {"name": a.get_text(strip=True), "rows": []})
            continue
        if current is None:
            continue
        cells = row.find_all("td")
        if len(cells) < 2:
            continue
        rank = cells[0].get_text(strip=True)
        players = []
        for a in cells[1].find_all("a", href=re.compile(r"player\.aspx", re.I)):
            name = a.get_text(strip=True)
            seed = None
            sm = re.search(r"\s*\[(\d+)\]\s*$", name)
            if sm:
                seed = sm.group(1)
                name = name[:sm.start()].strip()
            href = a["href"]
            players.append({"name": name, "seed": seed,
                             "url": href if href.startswith("http") else BASE + href})
        if players:
            current["rows"].append({"rank": rank, "players": players})
    return groups


def _fetch_tournament_winners(gid, force=False):
    """Final placements per discipline, with Firestore caching. A discipline
    with no published rows means dbv hasn't finished/posted results yet — the
    absence of any table on the winners page is itself the "not resolved"
    signal (there is no separate status flag upstream)."""
    if db and not force:
        try:
            cache = db.collection("tournament_winners_cache").document(gid).get()
            if cache.exists:
                data = cache.to_dict()
                if datetime.now(timezone.utc) < data["expires_at"]:
                    return {"resolved": data.get("resolved", False), "groups": data.get("groups", {})}
        except Exception:
            pass

    session = requests.Session()
    session.cookies.update(COOKIES)
    resp = session.get(f"{BASE}/sport/winners.aspx?id={gid}", headers=HEADERS, timeout=20)
    resp.raise_for_status()
    groups = _parse_winners_html(resp.text)
    resolved = any(g["rows"] for g in groups.values())

    if db:
        try:
            db.collection("tournament_winners_cache").document(gid).set({
                "resolved": resolved,
                "groups": groups,
                # Published results never change, so cache them long; an
                # unresolved tournament is rechecked sooner so freshly-posted
                # results show up promptly.
                "expires_at": datetime.now(timezone.utc) + (timedelta(days=14) if resolved else timedelta(hours=2)),
            })
        except Exception:
            pass
    return {"resolved": resolved, "groups": groups}


def is_tournament_resolved(gid):
    """Best-effort: has dbv already published final results for this
    tournament? Used elsewhere as a fallback signal for "this is clearly over"
    when no reliable date is on hand."""
    try:
        return bool(_fetch_tournament_winners(gid).get("resolved"))
    except Exception:
        return False


@https_fn.on_call()
def get_tournament_winners(req: https_fn.CallableRequest) -> dict:
    """Final placements per discipline, scraped from dbv's winners page.
    {resolved, groups: {event: {name, rows: [{rank, players}]}}}."""
    try:
        gid = (req.data or {}).get("id", "")
        m = re.search(r"([0-9A-Fa-f-]{36})", gid or "")
        if not m:
            return {"error": "Missing or invalid tournament id"}
        gid = m.group(1).upper()

        force = bool((req.data or {}).get("force"))
        if force and not check_rate_limit(rate_key(req), "force_winners", 20, 3600000):
            return {"error": "Live update limit reached. Please wait before refreshing again."}

        return _fetch_tournament_winners(gid, force=force)
    except Exception as e:
        import traceback
        print(f"get_tournament_winners error: {e}\n{traceback.format_exc()}")
        return {"error": f"Internal Error: {str(e)}"}
