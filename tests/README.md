# Manual testing scaffolding

Reusable helpers for exercising this app locally — against the Firebase
emulators, not production — instead of re-deriving the same boilerplate
(minting a fake service account, finding a working Chromium build, wiring
up a callable-invocation shim) each session. See
`.claude/rules/testing.md` for the ground rules around live upstream
requests (dbv.turnier.de / badminton-bax.de) while doing any of this.

These are **not** an automated CI suite — nothing here runs on a schedule
or a git hook. They're scripts to run by hand while developing, and they
talk to a live emulator (and sometimes live upstream sites), so treat them
accordingly.

## Layout

```
tests/
├── backend/     Python — call a Cloud Functions callable directly, no HTTP
│                needed, against the Firestore emulator
└── browser/     Playwright — drive the actual site in a real browser
                 against the Hosting/Functions/Firestore/Auth emulators
```

## Backend: calling a callable directly

```bash
# One-time per machine: mint a throwaway service-account credential (the
# checked-in firebase-dev.sh path only exists on the maintainer's machine).
functions/venv/bin/python tests/backend/emulator_helpers.py

# Start the Firestore emulator (or the full suite) in another terminal:
firebase emulators:start --only firestore
# — or the full stack (needed for the browser tests below too):
firebase emulators:start

# Point this shell at it:
source tests/backend/env.sh

# Call any callable and see its raw JSON result:
functions/venv/bin/python tests/backend/example_call.py get_club_roster '{"query": "BC Trier"}'
```

For anything more involved than a one-liner, import the helper directly in
a scratch script instead of editing `example_call.py`:

```python
import sys
sys.path.insert(0, "functions")
sys.path.insert(0, "tests/backend")
import main
from emulator_helpers import call_callable

result = call_callable(main.get_club_teams, {"cl_code": "10-0790", "slot": 0})
```

`call_callable` skips the Flask HTTP layer entirely (calls the decorated
function's own handler in-process), so it's fast enough to iterate with.

## Browser: driving the actual site

```bash
cd tests/browser && npm install   # first time only
cd ../..

# Needs the full emulator suite running (hosting + functions + firestore + auth):
firebase emulators:start

node tests/browser/examples/check_club.mjs        # BC Trier by default
node tests/browser/examples/check_club.mjs 08-0035 # or a specific cl_code
```

`driver.mjs` exports `launchBrowser()` (auto-discovers whatever Chromium
build is cached under `~/.cache/ms-playwright`, so it doesn't matter if the
installed playwright version and the cached browser revision drift apart)
and `newPageWithErrorLog()` (a page pre-wired to collect console errors and
uncaught exceptions — check this before declaring anything working, since a
page can render its shell fine while every data fetch 500s).

Copy `examples/check_club.mjs` as the starting point for testing a
different page or flow, rather than growing one script to cover everything.
Screenshots go to `tests/browser/.out/` (gitignored).

## What NOT to build here

- Don't add a test runner / CI wiring for these — they hit an emulator (and
  sometimes live upstream sites), so they're not safe to run unattended or
  on every push.
- Don't commit scraped HTML fixtures or screenshots here — those belong in
  your own scratch space for the session that needed them, per
  `.claude/rules/testing.md`.
