"""Every cache-freshness knob in one place.

Each Firestore `*_cache` collection (see knowledge/bax_checker/architecture.md
§4) writes an `expires_at` using one of the constants below instead of a
hardcoded `timedelta(...)` — tune a cache by changing the value here, nothing
else needs to change. Two caches (`bax_values_cache`, `player_bax_cache`,
`player_leagues_cache`) primarily key off a source "last updated" date
instead of a timer; their constant here is only the fallback used when that
date can't be read. The two *_DATE_CHECK_SECONDS values are a separate,
in-process (not Firestore) memoization of how often that source date itself
gets re-read.
"""

from datetime import timedelta

# --- dbv.turnier.de ------------------------------------------------------- #
TOURNAMENT_SEARCH_TTL = timedelta(hours=12)              # tournaments.py: find_tournaments
TOURNAMENT_DISCIPLINES_TTL = timedelta(hours=24)         # tournaments.py: _get_tournament_disciplines
TOURNAMENT_WINNERS_RESOLVED_TTL = timedelta(days=14)     # tournaments.py: _fetch_tournament_winners (results published)
TOURNAMENT_WINNERS_UNRESOLVED_TTL = timedelta(hours=2)   # tournaments.py: _fetch_tournament_winners (not yet resolved)
PLAYER_PROFILE_TTL = timedelta(days=1)                   # bax.py: get_player_details
TOURNAMENT_PLAYER_CARD_TTL = timedelta(hours=12)         # bax.py: _fetch_tournament_player_card
PLAYER_LEAGUES_FALLBACK_TTL = timedelta(days=60)         # leagues.py: _scrape_leagues (fallback only)
LEAGUE_PLAYER_PAGE_TTL = timedelta(hours=12)             # leagues.py: _fetch_league_player_page
PLAYER_DBV_STATS_TTL = timedelta(hours=12)               # player.py: get_player_dbv_stats
PLAYER_SEARCH_TTL = timedelta(hours=12)                  # player.py: search_players
ENTRYLIST_TTL = timedelta(hours=12)                      # player.py: _entry_list_members
PLAYER_NETWORK_TTL = timedelta(hours=24)                 # network.py: get_player_network

# --- badminton-bax.de ------------------------------------------------------ #
BAX_VALUES_FALLBACK_TTL = timedelta(days=30)             # bax.py: get_bax_values (fallback only)
PLAYER_BAX_FALLBACK_TTL = timedelta(days=30)             # player.py: get_player_bax (fallback only)

# --- in-process memoization (seconds, not Firestore) ----------------------- #
BAX_DATE_CHECK_SECONDS = 600    # bax.py: _bax_update_date — re-check badminton-bax.de's "(Turniere)" date at most this often
LIGEN_DATE_CHECK_SECONDS = 600  # leagues.py: _leagues_update_date — re-check its "(Ligen)" date at most this often
