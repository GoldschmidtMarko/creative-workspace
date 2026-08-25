"""User-submitted feedback — bug reports, feature requests, general notes,
from the feedback widget on every page (see public/js/util/feedback.js)."""

from firebase_admin import firestore
from firebase_functions import https_fn

from app.core.auth import Err, rate_key
from app.core.firebase_app import db, log_firestore_error
from app.core.rate_limiting import check_firestore_rate_limit
from app.scraping.analytics import bump_summary

MAX_MESSAGE_LENGTH = 2000
CATEGORIES = {"bug", "feature", "data", "other"}


@https_fn.on_call()
def submit_feedback(req: https_fn.CallableRequest) -> dict:
    """Feedback doesn't require signing in — attributed to the signed-in user
    when there is one, else just rate-limited by IP like the other ungated
    callables (see rate_key)."""
    d = req.data or {}
    message = (d.get("message") or "").strip()
    if not message:
        raise https_fn.HttpsError(Err.INVALID_ARGUMENT, "Please write a message.")
    if len(message) > MAX_MESSAGE_LENGTH:
        raise https_fn.HttpsError(Err.INVALID_ARGUMENT, f"Message is too long (max {MAX_MESSAGE_LENGTH} characters).")

    category = (d.get("category") or "other").strip().lower()
    if category not in CATEGORIES:
        category = "other"

    if not check_firestore_rate_limit(rate_key(req), "submit_feedback", 10, 600000):
        raise https_fn.HttpsError(Err.RESOURCE_EXHAUSTED, "You're submitting feedback too quickly. Please try again later.")

    authed = req.auth is not None
    token = req.auth.token if authed else {}
    user_name = (token.get("name") or token.get("email")) if authed else None

    if db is not None:
        try:
            db.collection("feedback").document().set({
                "message": message,
                "category": category,
                "createdAt": firestore.SERVER_TIMESTAMP,
                "userId": req.auth.uid if authed else None,
                "userName": user_name,
            })
        except Exception as error:
            log_firestore_error("submit_feedback", error)
            raise https_fn.HttpsError(Err.INTERNAL, "Failed to save feedback.")

    bump_summary(["feedback"], authed)
    return {"success": True}
