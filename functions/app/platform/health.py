"""Simple health-check callable."""

from datetime import datetime, timezone

from firebase_functions import https_fn


@https_fn.on_call()
def ping(req: https_fn.CallableRequest) -> dict:
    return {"status": "pong", "time": str(datetime.now(timezone.utc))}
