# Source this (not execute) after minting the fake service account once:
#   functions/venv/bin/python tests/backend/emulator_helpers.py
#   source tests/backend/env.sh
#
# Assumes the Firestore emulator is already running:
#   firebase emulators:start --only firestore
# (or the full `firebase emulators:start` — functions/hosting/auth too).
export GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/tests/backend/.fake-service-account.json"
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export GOOGLE_CLOUD_PROJECT=creative-workspace-359a0
