"""User accounts and activity tracking.

The signed-in user's profile lives at users/{uid}. `save_user_activity` upserts it
on login and bumps a login counter — a simple activity-tracking hook that also
proves out the auth + rate-limiting stack. Future account features (saved
tournaments, linked badminton account, watchlist) hang off this same collection.
"""

from firebase_admin import firestore
from firebase_functions import https_fn

from app.core.auth import Err, authenticate_user
from app.core.firebase_app import db
from app.core.rate_limiting import check_firestore_rate_limit


@https_fn.on_call()
def save_user_activity(req: https_fn.CallableRequest) -> dict:
    """Record the signed-in user's login. Gated by auth + a light rate limit."""
    authenticate_user(req.auth)
    uid = req.auth.uid

    if not check_firestore_rate_limit(uid, "save_user_activity", 30, 60000):
        raise https_fn.HttpsError(Err.RESOURCE_EXHAUSTED, "Too many requests. Please slow down.")

    token = req.auth.token or {}
    profile = {
        "uid": uid,
        "name": token.get("name", "Unknown"),
        "email": token.get("email", ""),
        "lastLogin": firestore.SERVER_TIMESTAMP,
        "loginCount": firestore.Increment(1),
    }

    if db is None:
        return {"success": True, "persisted": False}

    try:
        ref = db.collection("users").document(uid)
        if not ref.get().exists:
            profile["registrationDate"] = firestore.SERVER_TIMESTAMP
        ref.set(profile, merge=True)
        return {"success": True, "persisted": True}
    except Exception as error:
        print(f"save_user_activity error: {error}")
        raise https_fn.HttpsError(Err.INTERNAL, "Failed to save activity.")
