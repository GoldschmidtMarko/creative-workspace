// Team season page — one league team's played results, upcoming fixtures,
// and its division's current standings, read straight from dbv.turnier.de
// via get_team_season (see functions/app/scraping/teams.py). Reached from
// club.html's Teams tab, which links each team pill/name here instead of
// straight out to dbv (see club.js renderTeams()).
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions } from "./util/firebase.js";

const getTeamSeason = httpsCallable(functions, "get_team_season", { timeout: 30000 });
const getClubRoster = httpsCallable(functions, "get_club_roster", { timeout: 30000 });

const $ = (id) => document.getElementById(id);
function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

const params = new URLSearchParams(location.search);
const leagueGuid = (params.get("id") || "").trim();
const teamId = (params.get("team") || "").trim();
const qName = (params.get("name") || "").trim();
const clCode = (params.get("cl_code") || "").trim();
const clubName = (params.get("club_name") || "").trim();

const yearEl = $("copyright-year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

// Instant display from the query params (same trick tournament.js uses for
// name/start/end/city) — the header reads right away, before the callable
// resolves.
if (qName) {
    $("tm-name").textContent = qName;
    document.title = `${qName} | BAX Checker`;
}
setupClubReturn();
loadTeam();

function setupClubReturn() {
    if (!clCode) return;
    const rb = $("club-return");
    if (!rb) return;
    rb.href = `/html/club.html?cl_code=${encodeURIComponent(clCode)}`;
    $("club-return-name").textContent = clubName || "Club";
    rb.classList.remove("hidden");
}

// Every internal link on this page carries the SAME cl_code/club_name it
// arrived with (when any), rather than just the target team's own id/name
// — otherwise "Back to club" would disappear after the first hop (e.g.
// clicking an opponent or another standings row), since dbv's own pages
// carry no badminton-bax club code to re-derive it from on the far side
// (feedback: "always in the header, give the option to return to the
// club page").
function teamLinkUrl(otherLeagueGuid, otherTeamId, otherName) {
    const q = new URLSearchParams({ id: otherLeagueGuid, team: otherTeamId, name: otherName || "" });
    if (clCode) q.set("cl_code", clCode);
    if (clubName) q.set("club_name", clubName);
    return `/html/team.html?${q.toString()}`;
}

function showError(msg) {
    $("tm-skeleton").classList.add("hidden");
    $("tm-view").classList.add("hidden");
    $("error-view").classList.remove("hidden");
    $("error-msg").textContent = msg;
}

async function loadTeam() {
    if (!leagueGuid || !teamId) {
        showError("Missing team.");
        return;
    }
    try {
        const res = await getTeamSeason({ league_guid: leagueGuid, team_id: teamId });
        const data = res.data || {};
        if (data.error) throw new Error(data.error);
        render(data);
    } catch (err) {
        console.error("get_team_season failed:", err);
        showError(err.message || String(err));
    }
}

// dbv's own team names have no badminton-bax club code attached (that's a
// wholly separate site/id system — see clubs.py's module docstring), so
// this team's OWN club (not the one we may have arrived from) can only be
// reached by best-guessing its name and resolving it the same way the
// search box does (get_club_roster with a `query`). The guess: strip a
// trailing squad label ("1", "2", "J1", "M2", ...) the same shape
// clubs.py/club.js already recognize elsewhere, e.g. "1. CfB Köln 2" ->
// "1. CfB Köln".
function guessClubName(teamName) {
    return (teamName || "").replace(/\s+(?:[A-Za-z]{1,2}\d{1,2}|\d{1,2})$/, "").trim() || teamName;
}

// badminton-bax.de's own search is a plain substring match against its
// stored club name, which doesn't always spell a leading ordinal the same
// way dbv does — confirmed live: dbv's team names read "1. CfB Köln 2"
// (space after the period), but badminton-bax stores the club itself as
// "1.CfB Köln" (no space), so a query carrying that space matches nothing
// even though the club exists. If the guessed name (with the leading
// ordinal kept) draws a blank, retry once without it — "CfB Köln" alone
// IS a substring of "1.CfB Köln" and resolves fine.
async function resolveClubHref(guessedName) {
    const fallback = `/html/club.html?q=${encodeURIComponent(guessedName)}`;
    const withoutOrdinal = guessedName.replace(/^\d+\.\s*/, "").trim();
    const queries = withoutOrdinal && withoutOrdinal !== guessedName
        ? [guessedName, withoutOrdinal] : [guessedName];
    for (const query of queries) {
        try {
            const res = await getClubRoster({ query });
            const data = res.data || {};
            if (data.club && data.club.cl_code) {
                return `/html/club.html?cl_code=${encodeURIComponent(data.club.cl_code)}`;
            }
            if (data.resolved === false && data.candidates && data.candidates.length === 1) {
                return `/html/club.html?cl_code=${encodeURIComponent(data.candidates[0].cl_code)}`;
            }
        } catch (err) {
            console.error(`club resolve failed for "${query}":`, err);
        }
    }
    // Ambiguous or not found either way — hand off to the search box's own
    // flow (candidate picker, or its own "no club found" message) rather
    // than a dead link.
    return fallback;
}

function render(data) {
    const team = data.team || {};
    const name = team.name || qName || "Team";
    $("tm-name").textContent = name;
    document.title = `${name} | BAX Checker`;
    $("tm-meta").innerHTML = [team.division, team.season].filter(Boolean).map(escapeHtml).join(" &middot; ");

    const clubLink = $("tm-club");
    if (clubLink && name) {
        const guessed = guessClubName(name);
        // Shown immediately with the search-flow fallback so the button
        // works right away; upgraded to a direct cl_code link once
        // resolveClubHref's own lookup (which can retry once — see its own
        // note) comes back, without making the reader wait on it first.
        clubLink.href = `/html/club.html?q=${encodeURIComponent(guessed)}`;
        clubLink.classList.remove("hidden");
        resolveClubHref(guessed).then((href) => { clubLink.href = href; });
    }

    const dbvLink = $("tm-dbv");
    if (dbvLink) {
        dbvLink.href = `https://dbv.turnier.de/league/${encodeURIComponent(leagueGuid)}/team/${encodeURIComponent(teamId)}`;
        dbvLink.classList.remove("hidden");
    }

    renderStandings(data.standings || [], team.division);
    renderMatches(data.matches || { played: [], upcoming: [] });

    $("tm-skeleton").classList.add("hidden");
    $("error-view").classList.add("hidden");
    $("tm-view").classList.remove("hidden");
    if (window.lucide) lucide.createIcons();
}

function renderStandings(rows, division) {
    $("standings-hint").textContent = division || "";
    const body = $("standings-body");
    if (!rows.length) {
        body.innerHTML = `<div class="pl-empty">No standings found.</div>`;
        return;
    }
    const trs = rows.map((r) => {
        // Every other team in the division is one click away — the current
        // one just isn't a link to itself.
        const nameCell = (!r.is_this_team && r.team_id)
            ? `<a href="${escapeHtml(teamLinkUrl(leagueGuid, r.team_id, r.team))}">${escapeHtml(r.team)}</a>`
            : escapeHtml(r.team);
        const points = r.points_won != null && r.points_lost != null ? `${r.points_won}:${r.points_lost}` : "—";
        return `
        <tr class="${r.is_this_team ? "is-us" : ""}">
            <td class="is-num">${r.standing ? "#" + escapeHtml(r.standing) : "—"}</td>
            <td class="name">${nameCell}</td>
            <td class="is-num">${r.played != null ? r.played : "—"}</td>
            <td class="is-num">${points}</td>
            <td class="is-num">${r.won != null ? `${r.won}-${r.drawn}-${r.lost}` : "—"}</td>
        </tr>`;
    }).join("");
    body.innerHTML = `<div class="table-scroll"><table class="pl-table team-standings">
        <thead><tr><th>#</th><th>Team</th><th class="is-num">Pld</th><th class="is-num">Points</th><th class="is-num">W-D-L</th></tr></thead>
        <tbody>${trs}</tbody>
    </table></div>`;
}

// dbv's own "Ergebnis" is always "Heim-Gast" (home-away), regardless of
// which side is us — is_home says which number in that pair is ours.
function matchResultClass(score, isHome) {
    const m = /^(\d+)-(\d+)$/.exec(score || "");
    if (!m) return "";
    const home = parseInt(m[1], 10), away = parseInt(m[2], 10);
    const us = isHome ? home : away, them = isHome ? away : home;
    return us > them ? "match-result--win" : us < them ? "match-result--loss" : "match-result--draw";
}

// This match's own encounter page — the whole reason match_id/match_url
// were captured in the first place (see teams.py's module docstring).
// Carries the SAME context (team/club) this page itself arrived with, so
// encounter.html's own "Back to team" banner has somewhere to return to.
function encounterUrl(matchId) {
    const q = new URLSearchParams({ id: leagueGuid, match: matchId, team: teamId, team_name: qName });
    if (clCode) q.set("cl_code", clCode);
    if (clubName) q.set("club_name", clubName);
    return `/html/encounter.html?${q.toString()}`;
}

function matchRow(m) {
    const opponent = m.is_home ? m.away_team : m.home_team;
    // "H"/"A", not "Home"/"Away" — the column header already says which,
    // and every character here is one this table can't afford to spend on
    // a narrow screen (feedback: "the games button require[s] horizontal
    // scrolling"). Same reason the date drops its year below.
    const venue = m.is_home ? "H" : "A";
    const dateLabel = m.date ? new Date(`${m.date}T00:00:00`).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" }) : "—";
    const timeLabel = m.time ? ` ${escapeHtml(m.time)}` : "";
    const opponentCell = m.opponent_team_id
        ? `<a href="${escapeHtml(teamLinkUrl(leagueGuid, m.opponent_team_id, opponent))}">${escapeHtml(opponent)}</a>`
        : escapeHtml(opponent);
    const scoreCell = m.played && m.score
        ? `<span class="${matchResultClass(m.score, m.is_home)}">${escapeHtml(m.score)}</span>`
        : "—";
    // A dedicated button, not the date itself, is the link to this
    // encounter's own page (feedback: "a button to get to the encounter
    // ... not the date as a link").
    const encounterCell = m.match_id
        ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(encounterUrl(m.match_id))}" title="See this encounter's individual games">Games</a>`
        : "";
    return `<tr>
        <td class="when">${escapeHtml(dateLabel)}${timeLabel}</td>
        <td class="is-num">${venue}</td>
        <td class="name">${opponentCell}</td>
        <td class="is-num">${scoreCell}</td>
        <td class="is-num">${encounterCell}</td>
    </tr>`;
}

function matchesTable(rows) {
    if (!rows.length) return `<div class="pl-empty">None.</div>`;
    return `<div class="table-scroll"><table class="pl-table">
        <thead><tr><th>Date</th><th class="is-num">H/A</th><th>Opponent</th><th class="is-num">Score</th><th></th></tr></thead>
        <tbody>${rows.map(matchRow).join("")}</tbody>
    </table></div>`;
}

function renderMatches(matches) {
    $("results-body").innerHTML = matchesTable(matches.played || []);
    $("upcoming-body").innerHTML = matchesTable(matches.upcoming || []);
}
