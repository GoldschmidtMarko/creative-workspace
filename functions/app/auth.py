"""Auth + small shared helpers for the callable modules."""

import time

from firebase_functions import https_fn

Err = https_fn.FunctionsErrorCode


def now_ms() -> int:
    return int(time.time() * 1000)


def authenticate_user(auth) -> None:
    """Raise UNAUTHENTICATED unless the request carries a signed-in user."""
    if auth is None:
        raise https_fn.HttpsError(Err.UNAUTHENTICATED, "You must be signed in.")


def rate_key(req) -> str:
    """A stable identity for rate limiting an ungated endpoint: the signed-in
    user's uid, else the client IP."""
    if getattr(req, "auth", None) is not None:
        return f"uid:{req.auth.uid}"
    ip = "unknown"
    try:
        raw = req.raw_request
        fwd = raw.headers.get("X-Forwarded-For", "") if raw else ""
        ip = fwd.split(",")[0].strip() if fwd else (raw.remote_addr or "unknown")
    except Exception:
        pass
    return f"ip:{ip}"
