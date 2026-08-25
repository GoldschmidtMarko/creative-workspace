"""Firebase Admin / Firestore initialization + global options.

Shared by every callable module. In the emulator this picks up emulator
settings automatically; when Firestore is unavailable (e.g. local scripts)
`db` is None and callers fall back to the in-process memory cache.
"""

from firebase_admin import initialize_app, firestore
from firebase_functions.options import set_global_options

try:
    # Explicit projectId rather than relying on implicit detection.
    initialize_app(options={"projectId": "creative-workspace-359a0"})
    db = firestore.client()
    print("✅ Firestore initialized successfully. "
          f"client.project={getattr(db, 'project', '?')!r} "
          f"client.database={getattr(db, '_database_string', '?')!r}")
except Exception as e:
    print(f"⚠️  Firestore initialization failed: {e}. Using memory cache instead.")
    db = None

set_global_options(max_instances=10, timeout_sec=540, memory=512)


def log_firestore_error(context: str, error: Exception) -> None:
    """Richer error logging for a failed Firestore call than str(error) alone
    gives you — the exception type, structured gRPC/API-core attributes
    (code/reason/domain/details/metadata) when present, and what the client
    itself believes its project/database/target are. Callers already have
    their own fallback behavior; this only adds detail to the log line."""
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
