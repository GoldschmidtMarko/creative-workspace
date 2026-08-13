"""Shared scraping config and a pooled HTTP session used across modules."""

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE = "https://dbv.turnier.de"

# In-process memory cache fallback (used when Firestore is unavailable).
MEMORY_CACHE = {
    "tournaments": {},
    "profiles": {},
    "bax": {}
}

# Configuration for scraping
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}
COOKIES = {
    "st": "l=1031&exp=46509.8685846875&c=1&cp=23&s=2"
}

# How many players to scrape concurrently. Each player = a few upstream
# requests, so keep this modest to stay polite.
MAX_WORKERS = 8

# A single pooled session shared across threads. requests.Session is
# thread-safe for issuing requests, and a large connection pool lets the
# thread pool reuse keep-alive connections instead of opening a socket per
# call. Retries smooth over the occasional flaky upstream response.
_SESSION = requests.Session()
_adapter = HTTPAdapter(
    pool_connections=MAX_WORKERS,
    pool_maxsize=MAX_WORKERS * 2,
    # read=0: never retry a read timeout. dbv.turnier.de's anti-bot defence
    # answers a throttled client by completing TLS then holding the connection
    # open and sending nothing (a read timeout) — retrying that just triples
    # the load exactly when we're already being rate-limited. Connect errors
    # and genuine 5xx are still retried.
    max_retries=Retry(total=2, read=0, backoff_factor=0.3,
                      status_forcelist=(500, 502, 503, 504)),
)
_SESSION.mount("https://", _adapter)
_SESSION.mount("http://", _adapter)


def _get(url, **kwargs):
    """GET via the shared pooled session with default headers/timeout."""
    kwargs.setdefault("headers", HEADERS)
    kwargs.setdefault("timeout", 15)
    return _SESSION.get(url, **kwargs)
