// Team encounter page — one league match's 8 individual games, each with
// its score and both sides' players resolved to their own BAX for that
// game's discipline (see functions/app/scraping/teams.py's
// get_team_encounter). Reached from team.html's Results/Upcoming rows.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions } from "./util/firebase.js";

const getTeamEncounter = httpsCallable(functions, "get_team_encounter", { timeout: 30000 });

const $ = (id) => document.getElementById(id);
function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

const params = new URLSearchParams(location.search);
const leagueGuid = (params.get("id") || "").trim();
const matchId = (params.get("match") || "").trim();
const qTeamId = (params.get("team") || "").trim();
const qTeamName = (params.get("team_name") || "").trim();
const clCode = (params.get("cl_code") || "").trim();
const clubName = (params.get("club_name") || "").trim();
let matchLabel = "";   // set once render() knows both team names — see playerLinkUrl

const yearEl = $("copyright-year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

setupTeamReturn();
loadEncounter();

// The team the reader clicked FROM (not necessarily "home") — carries the
// same cl_code/club_name a team.html page would need for ITS OWN back
// link, the same "propagate context forward" fix team.html's own
// back-to-club banner needed (see team.js).
function setupTeamReturn() {
    if (!qTeamId) return;
    const rb = $("team-return");
    if (!rb) return;
    const q = new URLSearchParams({ id: leagueGuid, team: qTeamId, name: qTeamName });
    if (clCode) q.set("cl_code", clCode);
    if (clubName) q.set("club_name", clubName);
    rb.href = `/html/team.html?${q.toString()}`;
    $("team-return-name").textContent = qTeamName || "Team";
    rb.classList.remove("hidden");
}

function showError(msg) {
    $("en-skeleton").classList.add("hidden");
    $("en-view").classList.add("hidden");
    $("error-view").classList.remove("hidden");
    $("error-msg").textContent = msg;
}

async function loadEncounter() {
    if (!leagueGuid || !matchId) {
        showError("Missing match.");
        return;
    }
    try {
        const res = await getTeamEncounter({ league_guid: leagueGuid, match_id: matchId });
        const data = res.data || {};
        if (data.error) throw new Error(data.error);
        render(data);
    } catch (err) {
        console.error("get_team_encounter failed:", err);
        showError(err.message || String(err));
    }
}

// Discipline code -> full German name, just for the header tooltip — the
// code itself (HD1, DD, ...) is what every table/scoresheet on dbv itself
// uses, so it stays the primary label.
const DISCIPLINE_NAME = {
    HD: "Herrendoppel", DD: "Damendoppel", GD: "Gemischtes Doppel",
    HE: "Herreneinzel", DE: "Dameneinzel",
};
function disciplineTitle(code) {
    const prefix = (code || "").replace(/\d+$/, "");
    return DISCIPLINE_NAME[prefix] || code;
}

// meta.score is always "home-away" (see teams.py) — which side actually
// won the overall encounter, for highlighting in the header (feedback:
// "highlight the winning pair for the encounter" — the per-GAME winner
// was already bolded per row; this is the same treatment one level up,
// for whichever team won the encounter as a whole).
function encounterWinner(score) {
    const m = /^(\d+)-(\d+)$/.exec(score || "");
    if (!m) return null;
    const home = parseInt(m[1], 10), away = parseInt(m[2], 10);
    return home > away ? "home" : home < away ? "away" : null;
}

function render(data) {
    const meta = data.meta || {};
    const winner = encounterWinner(meta.score);
    const plainName = meta.home_team && meta.away_team ? `${meta.home_team} – ${meta.away_team}` : "Encounter";
    matchLabel = plainName;
    if (meta.home_team && meta.away_team) {
        const homeCls = winner === "home" ? "encounter-winner" : "";
        const awayCls = winner === "away" ? "encounter-winner" : "";
        $("en-name").innerHTML = `<span class="${homeCls}">${escapeHtml(meta.home_team)}</span> – <span class="${awayCls}">${escapeHtml(meta.away_team)}</span>`;
    } else {
        $("en-name").textContent = plainName;
    }
    document.title = `${plainName} | BAX Checker`;
    const scoreLabel = meta.score ? `Result ${meta.score}` : null;
    $("en-meta").innerHTML = [scoreLabel, meta.division, meta.date, meta.location]
        .filter(Boolean).map(escapeHtml).join(" &middot; ");

    const dbvLink = $("en-dbv");
    if (dbvLink) {
        dbvLink.href = `https://dbv.turnier.de/sport/teammatch.aspx?id=${encodeURIComponent(leagueGuid)}&match=${encodeURIComponent(matchId)}`;
        dbvLink.classList.remove("hidden");
    }

    renderGames(data.games || []);

    $("en-skeleton").classList.add("hidden");
    $("error-view").classList.add("hidden");
    $("en-view").classList.remove("hidden");
    if (window.lucide) lucide.createIcons();
}

// player.html's own "back to match" banner (see player.js's from_league/
// from_match handling) needs this same context back — the same
// "propagate context forward" fix team.html's back-to-club banner needed.
function playerLinkUrl(sp, name) {
    const q = new URLSearchParams({ sp, name, from_league: leagueGuid, from_match: matchId, from_mn: matchLabel });
    if (qTeamId) q.set("from_team", qTeamId);
    if (qTeamName) q.set("from_team_name", qTeamName);
    if (clCode) q.set("from_cl_code", clCode);
    if (clubName) q.set("from_club_name", clubName);
    return `/html/player.html?${q.toString()}`;
}

// One side's players, each with its own BAX badge (reusing bax_checker.css's
// .tm/.tm__lead/.tm__name/.tm__val — the same "name + number" row the
// tournament team-cards already use) — unresolved (no sp_code) just shows
// the name, no badge, rather than a misleading "0".
function sideCell(players, won) {
    const rows = (players || []).map((p) => {
        const nameInner = p.sp_code
            ? `<a class="tm__name player-link" href="${escapeHtml(playerLinkUrl(p.sp_code, p.name))}">${escapeHtml(p.name)}</a>`
            : `<span class="tm__name">${escapeHtml(p.name)}</span>`;
        const bax = p.bax != null ? `<span class="tm__val">${escapeHtml(p.bax)}</span>` : "";
        return `<div class="tm"><span class="tm__lead">${nameInner}</span>${bax}</div>`;
    }).join("");
    return `<td class="${won ? "encounter-winner" : ""}">${rows}</td>`;
}

function gameRow(g) {
    return `<tr>
        <td class="name" title="${escapeHtml(disciplineTitle(g.discipline))}">${escapeHtml(g.discipline)}</td>
        ${sideCell(g.home, g.home_won === true)}
        <td class="is-num when">${escapeHtml(g.score || "—")}</td>
        ${sideCell(g.away, g.home_won === false)}
    </tr>`;
}

function renderGames(games) {
    const body = $("games-body");
    if (!games.length) {
        body.innerHTML = `<div class="pl-empty">No games found.</div>`;
        return;
    }
    body.innerHTML = `<div class="table-scroll"><table class="pl-table">
        <thead><tr><th>Game</th><th>Home</th><th class="is-num">Score</th><th>Away</th></tr></thead>
        <tbody>${games.map(gameRow).join("")}</tbody>
    </table></div>`;
}
