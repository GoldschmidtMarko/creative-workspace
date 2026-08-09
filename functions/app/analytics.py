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
