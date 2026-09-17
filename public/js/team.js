// Team season page — one league team's played results, upcoming fixtures,
// and its division's current standings, read straight from dbv.turnier.de
// via get_team_season (see functions/app/scraping/teams.py). Reached from
// club.html's Teams tab, which links each team pill/name here instead of
// straight out to dbv (see club.js renderTeams()).
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions } from "./util/firebase.js";

const getTeamSeason = httpsCallable(functions, "get_team_season", { timeout: 30000 });

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

function render(data) {
    const team = data.team || {};
    const name = team.name || qName || "Team";
    $("tm-name").textContent = name;
    document.title = `${name} | BAX Checker`;
    $("tm-meta").innerHTML = [team.division, team.season].filter(Boolean).map(escapeHtml).join(" &middot; ");

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
    const trs = rows.map((r) => `
        <tr class="${r.is_this_team ? "is-us" : ""}">
            <td class="is-num">${r.standing ? "#" + escapeHtml(r.standing) : "—"}</td>
            <td class="name">${escapeHtml(r.team)}</td>
            <td class="is-num">${r.played != null ? r.played : "—"}</td>
            <td class="is-num">${r.won != null ? `${r.won}-${r.drawn}-${r.lost}` : "—"}</td>
        </tr>`).join("");
    body.innerHTML = `<div class="table-scroll"><table class="pl-table team-standings">
        <thead><tr><th>#</th><th>Team</th><th class="is-num">Pld</th><th class="is-num">W-D-L</th></tr></thead>
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

function matchRow(m) {
    const opponent = m.is_home ? m.away_team : m.home_team;
    const venue = m.is_home ? "Home" : "Away";
    const dateLabel = m.date ? new Date(`${m.date}T00:00:00`).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
    const timeLabel = m.time ? ` ${escapeHtml(m.time)}` : "";
    const opponentCell = m.opponent_team_id
        ? `<a href="/html/team.html?id=${encodeURIComponent(leagueGuid)}&team=${encodeURIComponent(m.opponent_team_id)}&name=${encodeURIComponent(opponent)}">${escapeHtml(opponent)}</a>`
        : escapeHtml(opponent);
    const scoreCell = m.played && m.score
        ? `<span class="${matchResultClass(m.score, m.is_home)}">${escapeHtml(m.score)}</span>`
        : "—";
    return `<tr>
        <td class="when">${escapeHtml(dateLabel)}${timeLabel}</td>
        <td class="is-num">${venue}</td>
        <td class="name">${opponentCell}</td>
        <td class="is-num">${scoreCell}</td>
    </tr>`;
}

function matchesTable(rows) {
    if (!rows.length) return `<div class="pl-empty">None.</div>`;
    return `<div class="table-scroll"><table class="pl-table">
        <thead><tr><th>Date</th><th class="is-num">H/A</th><th>Opponent</th><th class="is-num">Score</th></tr></thead>
        <tbody>${rows.map(matchRow).join("")}</tbody>
    </table></div>`;
}

function renderMatches(matches) {
    $("results-body").innerHTML = matchesTable(matches.played || []);
    $("upcoming-body").innerHTML = matchesTable(matches.upcoming || []);
}
