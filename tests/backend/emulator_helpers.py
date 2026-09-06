"""Reusable helpers for exercising Cloud Functions callables against the
Firestore emulator, without going through an HTTP server at all.

See ../README.md for the full setup (mint a fake service account, start the
Firestore emulator, set env vars) and .claude/rules/testing.md for the
ground rules around live upstream requests (dbv.turnier.de /
badminton-bax.de) while doing this — cache scraped HTML under a scratch
directory and reuse it instead of re-requesting the same page.

Typical usage (from the repo root, with the functions/ venv active and the
Firestore emulator + env vars from env.sh already set up):

    import sys
    sys.path.insert(0, "functions")
    sys.path.insert(0, "tests/backend")
    import main
    from emulator_helpers import call_callable

    result = call_callable(main.get_club_roster, {"query": "BC Trier"})
    print(result)
"""
import json

import flask
from firebase_functions import https_fn

_flask_app = flask.Flask(__name__)


def call_callable(fn, data):
    """Invoke an `@https_fn.on_call()` callable directly (no HTTP round
    trip). `fn` is the decorated callable as imported from functions/main.py
    (e.g. `main.get_club_roster`).

    firebase_functions wraps the user function in two layers
    (functools.wraps-preserving CORS handling, then dispatch), so the actual
    target sits two levels down the __wrapped__ chain — confirmed by
    inspecting main.get_club_roster.__wrapped__.__wrapped__ live against a
    real firebase_functions 0.5.x install. If a firebase_functions upgrade
    changes that wrapping depth, this is the one place to fix it.
    """
    with _flask_app.test_request_context("/", method="POST", json={"data": data}):
        req = https_fn.CallableRequest(data=data, raw_request=flask.request)
        return fn.__wrapped__.__wrapped__(req)


def mint_fake_service_account(path="tests/backend/.fake-service-account.json"):
    """Write a throwaway but structurally-valid service-account JSON (a real
    RSA key, fake everything else) so firebase_admin.initialize_app()
    succeeds against the Firestore emulator without real GCP credentials —
    the checked-in firebase-dev.sh path only exists on the maintainer's
    Windows/WSL machine. Safe to regenerate any time; the output is
    gitignored."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    sa = {
        "type": "service_account",
        "project_id": "creative-workspace-359a0",
        "private_key_id": "fake",
        "private_key": pem,
        "client_email": "fake@creative-workspace-359a0.iam.gserviceaccount.com",
        "client_id": "123",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
        "client_x509_cert_url": (
            "https://www.googleapis.com/robot/v1/metadata/x509/"
            "fake%40creative-workspace-359a0.iam.gserviceaccount.com"
        ),
    }
    with open(path, "w") as f:
        json.dump(sa, f)
    return path


if __name__ == "__main__":
    print(mint_fake_service_account())
