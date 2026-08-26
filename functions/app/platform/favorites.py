"""Signed-in users' starred tournaments/disciplines/players.

Favorites live at users/{uid}.favorites.<type>.<id>, written here via the
Admin SDK (same "writes go through the backend" rule as the rest of the
users/{uid} document — see firestore.rules) and read directly by the client,
since the existing rule already lets a signed-in user read their own
users/{uid} doc. See public/js/util/favorites.js for the client side.
"""

from firebase_admin import firestore
from firebase_functions import https_fn

from app.core.auth import Err, authenticate_user
from app.core.firebase_app import db, log_firestore_error
from app.core.rate_limiting import check_firestore_rate_limit

FAVORITE_TYPES = {"tournament", "discipline", "player"}
MAX_PER_TYPE = 200
MAX_NAME_LENGTH = 200
MAX_ID_LENGTH = 200
# Per-type metadata the client may attach, echoed back verbatim in the
# favorites list so it can render/link without a re-fetch. Kept to plain
# display/link data, nothing sensitive.
META_FIELDS = {
    "tournament": {"start", "end", "city"},
    "discipline": {"tournamentId", "tournamentName", "event"},
    "player": {"sp_code", "profile_id"},
}


@https_fn.on_call()
def toggle_favorite(req: https_fn.CallableRequest) -> dict:
    """Star or unstar one tournament/discipline/player for the signed-in user."""
    authenticate_user(req.auth)
    uid = req.auth.uid

    d = req.data or {}
    kind = (d.get("type") or "").strip()
    item_id = (d.get("id") or "").strip()[:MAX_ID_LENGTH]
    starred = bool(d.get("starred"))
    name = (d.get("name") or "").strip()[:MAX_NAME_LENGTH]
    meta = d.get("meta") or {}

    if kind not in FAVORITE_TYPES:
        raise https_fn.HttpsError(Err.INVALID_ARGUMENT, "Unknown favorite type.")
    if not item_id:
        raise https_fn.HttpsError(Err.INVALID_ARGUMENT, "Missing favorite id.")
    if starred and not name:
        raise https_fn.HttpsError(Err.INVALID_ARGUMENT, "Missing favorite name.")

    if not check_firestore_rate_limit(uid, "toggle_favorite", 60, 60000):
        raise https_fn.HttpsError(Err.RESOURCE_EXHAUSTED, "Too many requests. Please slow down.")

    if db is None:
        return {"success": True, "persisted": False, "starred": starred}

    ref = db.collection("users").document(uid)
    try:
        if starred:
            snap = ref.get()
            existing = ((snap.to_dict() or {}).get("favorites") or {}).get(kind) or {}
            if item_id not in existing and len(existing) >= MAX_PER_TYPE:
                raise https_fn.HttpsError(Err.RESOURCE_EXHAUSTED, f"You can only star up to {MAX_PER_TYPE} {kind}s.")
            allowed_meta = {
                k: v for k, v in meta.items()
                if k in META_FIELDS.get(kind, set()) and isinstance(v, (str, int, float))
            }
            # A nested-dict `set(merge=True)` only touches this one leaf
            # (favorites.<kind>.<item_id>) — sibling favorites, and even
            # sibling keys under the same kind, are left untouched.
            ref.set({"favorites": {kind: {item_id: {
                "name": name,
                **allowed_meta,
                "addedAt": firestore.SERVER_TIMESTAMP,
            }}}}, merge=True)
        else:
            ref.set({"favorites": {kind: {item_id: firestore.DELETE_FIELD}}}, merge=True)
        return {"success": True, "persisted": True, "starred": starred}
    except https_fn.HttpsError:
        raise
    except Exception as error:
        log_firestore_error("toggle_favorite", error)
        raise https_fn.HttpsError(Err.INTERNAL, "Failed to update favorites.")
