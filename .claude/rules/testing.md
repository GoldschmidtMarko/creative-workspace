# Testing against the Firestore/functions emulator

When testing backend callables against the emulator (fake service-account +
`FIRESTORE_EMULATOR_HOST`, per the `baxchecker-project-map` memory), avoid
making many live scraping requests to `https://dbv.turnier.de/` in one
session — repeated calls risk tripping its anti-bot/rate-limit defenses
(see `common.py`'s note on throttled reads going silent).

- Fetch each distinct page (tournament/event/winners/etc.) via `curl`
  **once**, save it to a scratchpad file, and reuse that saved HTML for
  repeat runs or parsing-logic checks — don't re-request the same URL every
  time a test is re-run.
- Prefer Firestore-cache hits over fresh scrapes: after the first live call
  for a given id, subsequent test calls should read from the emulator's
  cache, not hit dbv again.
- If a live call is genuinely needed (e.g. one end-to-end check of a new
  callable), keep it to a handful of distinct tournament ids for the whole
  session — never a loop over many ids, and never the same URL fetched
  repeatedly (including inside retry/polling loops).
