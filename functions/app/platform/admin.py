"""Admin-only usage dashboard.

`get_usage_stats` returns the analytics written by app.scraping.analytics
(usage/summary plus the usage_tournaments / usage_disciplines / usage_players
collections) and a small users overview. It is gated to a fixed allow-list of
admin emails and reads via the Admin SDK, so the Firestore security rules
stay fully locked and the client never touches the usage collections directly.
"""

import os

from firebase_admin import firestore
from firebase_functions import https_fn

from app.core.auth import Err, authenticate_user
from app.core.firebase_app import db, log_firestore_error

# Emails allowed to view the usage dashboard. Add more here if needed.
ADMIN_EMAILS = {"mgoldschmidt01@gmail.com"}


def _is_emulator() -> bool:
    """True when running under the local Functions emulator, which sets
    FUNCTIONS_EMULATOR=true. Lets any signed-in test account view the dashboard
    locally without being on the production admin allow-list."""
    return os.environ.get("FUNCTIONS_EMULATOR", "").lower() == "true"


def _is_admin(req) -> bool:
    if _is_emulator():
        return True
    token = (req.auth.token or {}) if req.auth else {}
    email = (token.get("email") or "").lower()
    return bool(email) and email in {e.lower() for e in ADMIN_EMAILS}


def _ms(ts):
    """Firestore timestamp -> epoch millis (JSON-safe), or None."""
    if ts is None:
        return None
    try:
        return int(ts.timestamp() * 1000)
    except Exception:
        return None


def _top_entities(collection, limit=50):
    """Top entities of a usage_* collection, most-queried first."""
    out = []
    if db is None:
        return out
    try:
        q = (db.collection(collection)
               .order_by("count", direction=firestore.Query.DESCENDING)
               .limit(limit))
        for doc in q.stream():
            d = doc.to_dict() or {}
            out.append({
                "id": doc.id,
                "name": d.get("name") or "",
                "count": d.get("count", 0),
                "count_authed": d.get("count_authed", 0),
                "count_anon": d.get("count_anon", 0),
                "lastQueried": _ms(d.get("lastQueried")),
            })
    except Exception as e:
        log_firestore_error(f"usage _top_entities({collection})", e)
    return out


def _daily_series(limit=120):
    """Per-day usage counts (from usage_daily), oldest first, for the timeline."""
    out = []
    if db is None:
        return out
    try:
        q = (db.collection("usage_daily")
               .order_by("date", direction=firestore.Query.DESCENDING)
               .limit(limit))
        for doc in q.stream():
            d = doc.to_dict() or {}
            out.append({
                "date": d.get("date") or doc.id,
                "count": d.get("count", 0),
                "count_authed": d.get("count_authed", 0),
                "count_anon": d.get("count_anon", 0),
            })
        out.reverse()  # oldest -> newest for plotting
    except Exception as e:
        log_firestore_error("usage _daily_series", e)
    return out


def _users_overview(limit=15):
    """Total registered users + the most active by login count."""
    result = {"total": 0, "top": []}
    if db is None:
        return result
    try:
        rows = []
        for doc in db.collection("users").stream():
            d = doc.to_dict() or {}
            rows.append({
                "name": d.get("name") or "",
                "email": d.get("email") or "",
                "loginCount": d.get("loginCount", 0),
                "lastLogin": _ms(d.get("lastLogin")),
                "registrationDate": _ms(d.get("registrationDate")),
            })
        result["total"] = len(rows)
        rows.sort(key=lambda r: r["loginCount"], reverse=True)
        result["top"] = rows[:limit]
    except Exception as e:
        log_firestore_error("usage _users_overview", e)
    return result


def _recent_feedback(limit=100):
    """Most recent submissions from submit_feedback (app.platform.feedback),
    newest first."""
    out = []
    if db is None:
        return out
    try:
        q = (db.collection("feedback")
               .order_by("createdAt", direction=firestore.Query.DESCENDING)
               .limit(limit))
        for doc in q.stream():
            d = doc.to_dict() or {}
            out.append({
                "id": doc.id,
                "message": d.get("message") or "",
                "category": d.get("category") or "other",
                "createdAt": _ms(d.get("createdAt")),
                "userName": d.get("userName"),
                "userId": d.get("userId"),
            })
    except Exception as e:
        log_firestore_error("usage _recent_feedback", e)
    return out


@https_fn.on_call()
def get_usage_stats(req: https_fn.CallableRequest) -> dict:
    """Return the aggregated usage analytics. Admin-only."""
    authenticate_user(req.auth)
    if not _is_admin(req):
        raise https_fn.HttpsError(Err.PERMISSION_DENIED, "Not authorized.")

    summary = {}
    if db is not None:
        try:
            snap = db.collection("usage").document("summary").get()
            if snap.exists:
                summary = snap.to_dict() or {}
        except Exception as e:
            log_firestore_error("usage summary", e)

    return {
        "summary": summary,
        "daily": _daily_series(),
        "tournaments": _top_entities("usage_tournaments"),
        "disciplines": _top_entities("usage_disciplines"),
        "players": _top_entities("usage_players"),
        "users": _users_overview(),
        "feedback": _recent_feedback(),
    }
