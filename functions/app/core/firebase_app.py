"""Firebase Admin / Firestore initialization + global options.

Shared by every callable module. In the emulator this picks up emulator
settings automatically; when Firestore is unavailable (e.g. local scripts)
`db` is None and callers fall back to the in-process memory cache.
"""

from firebase_admin import initialize_app, firestore
from firebase_functions.options import set_global_options

try:
    initialize_app()
    db = firestore.client()
    print("✅ Firestore initialized successfully.")
except Exception as e:
    print(f"⚠️  Firestore initialization failed: {e}. Using memory cache instead.")
    db = None

set_global_options(max_instances=10, timeout_sec=540, memory=512)
