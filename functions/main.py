"""Entry point Firebase Functions loads.

Only re-exports the callables from the domain modules below; the deployed
Cloud Function names come from each callable's __name__, and the frontend
(public/js/bax_checker.js) calls them by exact string, so the names stay as-is.
"""

from app.bax import get_player_bax_data
from app.tournaments import find_tournaments, get_tournament_disciplines
from app.leagues import get_player_leagues
from app.accounts import save_user_activity
from app.admin import get_usage_stats
from app.health import ping

__all__ = [
    "get_player_bax_data",
    "find_tournaments",
    "get_tournament_disciplines",
    "get_player_leagues",
    "save_user_activity",
    "get_usage_stats",
    "ping",
]
