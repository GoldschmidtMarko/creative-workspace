"""Per-user rate limiting.

`check_firestore_rate_limit` is a distributed counter (a Firestore transaction on
rateLimits/{uid}_{action}) shared across function instances; it falls back to an
in-process counter if Firestore is unavailable. Callables raise RESOURCE_EXHAUSTED
when a limit is exceeded.
"""

import threading

from firebase_admin import firestore

from app.core.auth import now_ms
from app.core.firebase_app import db, log_firestore_error

_rate_limit_store: dict[str, dict] = {}
_rate_limit_lock = threading.Lock()


def check_rate_limit(user_id: str, action: str, max_requests: int = 10, window_ms: int = 60000) -> bool:
    """In-process sliding-window limiter (per instance). Used as a fallback."""
    key = f"{user_id}:{action}"
    now = now_ms()
    with _rate_limit_lock:
        entry = _rate_limit_store.get(key)
        if entry is None or now > entry["reset_time"]:
            _rate_limit_store[key] = {"count": 1, "reset_time": now + window_ms}
            return True
        if entry["count"] < max_requests:
            entry["count"] += 1
            return True
        return False


def check_firestore_rate_limit(user_id: str, action: str, max_requests: int = 10, window_ms: int = 60000) -> bool:
    """Distributed limiter backed by a Firestore transaction; falls back to the
    in-process limiter when Firestore is unavailable."""
    if db is None:
        return check_rate_limit(user_id, action, max_requests, window_ms)

    ref = db.collection("rateLimits").document(f"{user_id}_{action}")
    now = now_ms()

    @firestore.transactional
    def _run(transaction: firestore.Transaction) -> bool:
        snapshot = ref.get(transaction=transaction)
        if not snapshot.exists:
            transaction.set(ref, {"count": 1, "resetTime": now + window_ms, "lastRequest": now})
            return True
        data = snapshot.to_dict()
        if now > data["resetTime"]:
            transaction.update(ref, {"count": 1, "resetTime": now + window_ms, "lastRequest": now})
            return True
        if data["count"] < max_requests:
            transaction.update(ref, {"count": data["count"] + 1, "lastRequest": now})
            return True
        return False

    try:
        return _run(db.transaction())
    except Exception as error:
        log_firestore_error("check_firestore_rate_limit", error)
        return check_rate_limit(user_id, action, max_requests, window_ms)
