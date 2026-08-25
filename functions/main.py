"""Entry point Firebase Functions loads.

Only re-exports the callables from the domain modules below; the deployed
Cloud Function names come from each callable's __name__, and the frontend
(public/js/bax_checker.js) calls them by exact string, so the names stay as-is.
"""

from app.scraping.bax import get_player_bax_data
from app.scraping.tournaments import find_tournaments, get_tournament_disciplines, get_tournament_winners
from app.scraping.leagues import get_player_leagues
from app.scraping.network import get_player_network
from app.scraping.player import get_player_bax, get_player_dbv_stats, get_player_upcoming, search_players
from app.platform.accounts import save_user_activity
from app.platform.admin import get_usage_stats
from app.platform.feedback import submit_feedback
from app.platform.health import ping

__all__ = [
    "get_player_bax_data",
    "find_tournaments",
    "get_tournament_disciplines",
    "get_tournament_winners",
    "get_player_leagues",
    "get_player_network",
    "get_player_bax",
    "get_player_dbv_stats",
    "get_player_upcoming",
    "search_players",
    "save_user_activity",
    "get_usage_stats",
    "submit_feedback",
    "ping",
]
