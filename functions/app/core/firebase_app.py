"""Firebase Admin / Firestore initialization + global options.

Shared by every callable module. In the emulator this picks up emulator
settings automatically; when Firestore is unavailable (e.g. local scripts)
`db` is None and callers fall back to the in-process memory cache.
"""

import os

from firebase_admin import initialize_app, firestore
from firebase_functions.options import set_global_options

try:
    # Explicit projectId: relying on implicit detection produced a client that
    # constructed fine but then failed every real request with "400 Invalid
    # database id (default)" — the client not resolving the right project at
    # request time is the likely cause, so pin it instead of guessing again.
    initialize_app(options={"projectId": "creative-workspace-359a0"})
    db = firestore.client()
    print("✅ Firestore initialized successfully. "
          f"client.project={getattr(db, 'project', '?')!r} "
          f"client.database={getattr(db, '_database_string', '?')!r} "
          f"GOOGLE_CLOUD_PROJECT={os.environ.get('GOOGLE_CLOUD_PROJECT')!r} "
          f"GCLOUD_PROJECT={os.environ.get('GCLOUD_PROJECT')!r} "
          f"K_SERVICE={os.environ.get('K_SERVICE')!r}")
except Exception as e:
    print(f"⚠️  Firestore initialization failed: {e}. Using memory cache instead.")
    db = None

set_global_options(max_instances=10, timeout_sec=540, memory=512)


def log_firestore_error(context: str, error: Exception) -> None:
    """TEMPORARY diagnostic logging for the "Invalid database id (default)"
    investigation — str(error) alone wasn't revealing enough. Safe to delete
    once the root cause is found; callers already have their own fallback
    behavior, this only adds detail to the printed log line."""
    parts = [f"[{context}] {type(error).__name__}: {error}"]
    for attr in ("code", "reason", "domain", "grpc_status_code", "error_info"):
        val = getattr(error, attr, None)
        if val is not None:
            parts.append(f"{attr}={val!r}")
    details = getattr(error, "details", None)
    if callable(details):
        try:
            details = details()
        except Exception:
            details = None
    if details:
        parts.append(f"details={details!r}")
    metadata = getattr(error, "metadata", None)
    if metadata:
        parts.append(f"metadata={metadata!r}")
    if db is not None:
        parts.append(f"client.project={getattr(db, 'project', '?')!r}")
        parts.append(f"client.database={getattr(db, '_database_string', '?')!r}")
        parts.append(f"client.target={getattr(db, '_target', '?')!r}")
    print(" | ".join(parts))
