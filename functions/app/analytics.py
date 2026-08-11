"""Best-effort usage analytics written to Firestore.

Records how much each functionality is used — split by logged-in vs anonymous —
plus per-tournament / per-discipline / per-player query counts. Every write is
best-effort: wrapped in try/except so analytics never blocks or fails the
calling function. Written by the backend only (Admin SDK bypasses rules).

Firestore layout:
  usage/summary                    aggregate counters, each *_authed / *_anon / *_total
  usage_tournaments/{tournamentId} {count, count_authed, count_anon, name, lastQueried}
  usage_disciplines/{tid__event}   same shape (one discipline of a tournament)
  usage_players/{profileId}        same shape (a player looked up)
"""

import re
from datetime import datetime, timezone

from firebase_admin import firestore

from app.firebase_app import db


def _suffix(authed):
    return "authed" if authed else "anon"


def _bump_daily(authed):
    """One usage action -> one increment on usage_daily/{YYYY-MM-DD} (UTC), so
    the admin dashboard can plot activity over time."""
    if db is None:
        return
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        db.collection("usage_daily").document(day).set({
            "date": day,
            "count": firestore.Increment(1),
            f"count_{_suffix(authed)}": firestore.Increment(1),
        }, merge=True)
    except Exception as e:
        print(f"analytics daily error: {e}")


def bump_summary(fields, authed):
    """Increment named counters on usage/summary — each as *_authed/_anon/_total —
    and the per-day usage bucket. Called once per user action."""
    if db is None:
        return
    payload = {}
    for f in fields:
        payload[f"{f}_{_suffix(authed)}"] = firestore.Increment(1)
        payload[f"{f}_total"] = firestore.Increment(1)
    try:
        db.collection("usage").document("summary").set(payload, merge=True)
    except Exception as e:
        print(f"analytics summary error: {e}")
    _bump_daily(authed)


def bump_entity(collection, doc_id, authed, name=None):
    """Increment a per-entity query counter (tournament / discipline / player)."""
    if db is None or not doc_id:
        return
    payload = {
        "count": firestore.Increment(1),
        f"count_{_suffix(authed)}": firestore.Increment(1),
        "lastQueried": firestore.SERVER_TIMESTAMP,
    }
    if name:
        payload["name"] = name
    try:
        db.collection(collection).document(doc_id).set(payload, merge=True)
    except Exception as e:
        print(f"analytics entity error: {e}")


def parse_event_url(url):
    """Extract (tournament_id, event) from an event.aspx analysis URL."""
    tid = re.search(r"[?&]id=([0-9A-Fa-f-]{36})", url or "")
    ev = re.search(r"[?&]event=(\d+)", url or "")
    return (tid.group(1).upper() if tid else None, ev.group(1) if ev else None)


def name_key(*parts):
    """A collision-tolerant, order-independent search key for a player name.
    'Marko Goldschmidt' and last='Goldschmidt' first='Marko' both map to the
    same key, so the badminton-bax.de (last, first) form and the dbv 'First Last'
    form resolve to one another."""
    toks = []
    for p in parts:
        toks += re.findall(r"\w+", (p or "").lower())
    return " ".join(sorted(toks))


def upsert_player_index(profile_id, sp_code=None, name=None):
    """Best-effort: remember a player's id mapping (dbv GUID <-> badminton-bax.de
    sp_code <-> name), so a name search can light up the dbv-only sections and
    reuse the BAX cache. Written whenever both ids are seen together (every
    tournament analysis) or a profile is opened."""
    if db is None or not profile_id:
        return
    payload = {"profile_id": profile_id, "updated_at": firestore.SERVER_TIMESTAMP}
    if sp_code and sp_code != "N/A":
        payload["sp_code"] = sp_code
    if name:
        payload["name"] = name
        payload["name_key"] = name_key(name)
    try:
        db.collection("player_index").document(profile_id).set(payload, merge=True)
    except Exception as e:
        print(f"player_index upsert error: {e}")


def record_registrations(players, tid, event, tournament_name=None,
                         tournament_url=None, discipline_name=None, start_date=None):
    """Best-effort: persist that each listed player is currently registered for
    this tournament+discipline (with a link), powering the per-player 'upcoming
    tournaments' section. Keyed by profile_id+tournament+event so re-analyses
    just refresh last_seen. Guests without a dbv profile id are skipped. Batched
    into one commit to keep the write cheap for big entry lists."""
    if db is None or not tid:
        return
    try:
        batch = db.batch()
        n = 0
        for p in players:
            pid = p.get("profile_id")
            if not pid:
                continue
            reg = db.collection("player_registrations").document(f"{pid}__{tid}__{event or '0'}")
            batch.set(reg, {
                "profile_id": pid,
                "sp_code": p.get("id"),
                "name": p.get("full_name"),
                "tournament_id": tid,
                "tournament_name": tournament_name,
                "tournament_url": tournament_url,
                "discipline_event": event,
                "discipline_name": discipline_name,
                "start_date": start_date,
                "status": p.get("status"),
                "last_seen": firestore.SERVER_TIMESTAMP,
            }, merge=True)
            # Also remember the id mapping so a later name search resolves the dbv
            # profile — analyses are where both ids are known together.
            idx = db.collection("player_index").document(pid)
            idx_payload = {"profile_id": pid, "updated_at": firestore.SERVER_TIMESTAMP}
            if p.get("id") and p.get("id") != "N/A":
                idx_payload["sp_code"] = p["id"]
            if p.get("full_name"):
                idx_payload["name"] = p["full_name"]
                idx_payload["name_key"] = name_key(p["full_name"])
            batch.set(idx, idx_payload, merge=True)
            n += 2
            # Firestore batches cap at 500 writes; flush well under that.
            if n % 400 == 0:
                batch.commit()
                batch = db.batch()
        if n % 400:
            batch.commit()
    except Exception as e:
        print(f"registration write error: {e}")
