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
from app.scraping.clubs import get_club_roster, get_club_teams
from app.scraping.teams import get_player_league_games, get_team_encounter, get_team_season
from app.platform.accounts import save_user_activity
from app.platform.admin import get_usage_stats
from app.platform.budget import budget_guard, restore_function_capacity
from app.platform.favorites import toggle_favorite
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
    "get_club_roster",
    "get_club_teams",
    "get_team_season",
    "get_team_encounter",
    "get_player_league_games",
    "save_user_activity",
    "get_usage_stats",
    "budget_guard",
    "restore_function_capacity",
    "toggle_favorite",
    "submit_feedback",
    "ping",
]
