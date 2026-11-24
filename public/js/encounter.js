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
// won the overall encounter, so the header can bold the winning team and
// mute the losing one (same treatment as each game row — see team.css's
// .encounter-won/.encounter-loser for why not a background tint).
function encounterWinner(score) {
    const m = /^(\d+)-(\d+)$/.exec(score || "");
    if (!m) return null;
    const home = parseInt(m[1], 10), away = parseInt(m[2], 10);
    return home > away ? "home" : home < away ? "away" : null;
}

function render(data) {
    const meta = data.meta || {};
    const games = data.games || [];
    const winner = encounterWinner(meta.score);
    const plainName = meta.home_team && meta.away_team ? `${meta.home_team} – ${meta.away_team}` : "Encounter";
    matchLabel = plainName;
    document.title = `${plainName} | BAX Checker`;
    // The identity card carries the context line; the scoreboard below it
    // carries the teams and the result.
    $("en-name").textContent = meta.division || plainName;
    $("en-meta").innerHTML = [meta.date, meta.location].filter(Boolean).map(escapeHtml).join(" &middot; ");

    const dbvLink = $("en-dbv");
    if (dbvLink) {
        dbvLink.href = `https://dbv.turnier.de/sport/teammatch.aspx?id=${encodeURIComponent(leagueGuid)}&match=${encodeURIComponent(matchId)}`;
        dbvLink.classList.remove("hidden");
    }

    lastMeta = meta;
    renderBoard(meta, games, winner);
    renderGames(games);

    $("en-skeleton").classList.add("hidden");
    $("error-view").classList.add("hidden");
    $("en-view").classList.remove("hidden");
    if (window.lucide) lucide.createIcons();
}

// Per game: which side BAX favours (by summed rating) and whether the
// result went against it. A gap under UPSET_MIN isn't called an upset.
const UPSET_MIN = 5;
function gameOutlook(g) {
    const home = sideStrength(g.home), away = sideStrength(g.away);
    const homeWon = typeof g.home_won === "boolean" ? g.home_won : null;
    if (home == null || away == null) return { home, away, fav: null, diff: null, upset: false, homeWon };
    const diff = Math.round(Math.abs(home - away));
    const fav = home === away ? null : (home > away ? "home" : "away");
    const upset = homeWon !== null && fav !== null && diff >= UPSET_MIN && (homeWon ? fav === "away" : fav === "home");
    return { home, away, fav, diff, upset, homeWon };
}

function renderBoard(meta, games, winner) {
    const m = /^(\d+)-(\d+)$/.exec(meta.score || "");
    const outlooks = games.map(gameOutlook);
    const favH = outlooks.filter((o) => o.fav === "home").length, favA = outlooks.filter((o) => o.fav === "away").length;
    const rated = outlooks.filter((o) => o.fav !== null || o.diff === 0).length;
    const upsets = outlooks.filter((o) => o.upset).length;
    const teamLink = (name, id) => (id ? `<a class="mx-team" href="${escapeHtml(teamPageUrl(id, name))}">${escapeHtml(name)}</a>` : `<span class="mx-team">${escapeHtml(name || "")}</span>`);
    const sum = [];
    if (rated) sum.push(`BAX expected <b>${favH}:${favA}</b>${favH !== favA ? ` for ${escapeHtml(favH > favA ? meta.home_team : meta.away_team)}` : ""}.`);
    if (m) sum.push(`Result <b>${m[1]}:${m[2]}</b>.`);
    if (m && rated) sum.push(upsets ? `<b>${upsets}</b> ${upsets === 1 ? "game was an upset" : "games were upsets"}.` : "No upsets.");
    if (!m) sum.push("Not played yet.");
    $("en-board").innerHTML = `<section class="pcard mx-card">
        <div class="mx-board">
            <div class="mx-side ${winner === "away" ? "is-lost" : ""}">${teamLink(meta.home_team, meta.home_team_id)}<small>Home</small></div>
            <div class="mx-score ${m ? "" : "is-tbd"}" aria-label="${m ? `Score ${m[1]} to ${m[2]}` : "Not played yet"}"><span>${m ? m[1] : "–"}</span><i aria-hidden="true"></i><span>${m ? m[2] : "–"}</span></div>
            <div class="mx-side is-away ${winner === "home" ? "is-lost" : ""}">${teamLink(meta.away_team, meta.away_team_id)}<small>Away</small></div>
        </div>
        ${sum.length ? `<div class="mx-sum">${sum.map((x) => `<span>${x}</span>`).join("")}</div>` : ""}
    </section>`;
}

// This app's own team page for either side, when the backend resolved its id.
function teamPageUrl(teamId, name) {
    const q = new URLSearchParams({ id: leagueGuid, team: teamId, name: name || "" });
    if (clCode) q.set("cl_code", clCode);
    if (clubName) q.set("club_name", clubName);
    return `/html/team.html?${q.toString()}`;
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

// One side's players with their BAX for this game's discipline. Unresolved
// players (no sp_code) show the name only, never a misleading "0".
function sideHtml(players, cls, label) {
    const rows = (players || []).map((p) => {
        const name = p.sp_code
            ? `<a href="${escapeHtml(playerLinkUrl(p.sp_code, p.name))}">${escapeHtml(p.name)}</a>`
            : `<span>${escapeHtml(p.name)}</span>`;
        const bax = p.bax != null && Number(p.bax) > 0 ? `<span class="g-bax">${escapeHtml(p.bax)}</span>` : "";
        return `<span class="g-p">${name}${bax}</span>`;
    }).join("");
    return `<div class="g-side ${cls}" data-side="${escapeHtml(label)}">${rows}</div>`;
}

// Pair/player strength = the SUM of that side's BAX for this game's
// discipline (same "summed per group" convention as the tournament
// team-cards). A side only counts when EVERY player on it has a real BAX —
// null is unresolved, and 0 is bax.py's "no rating found" default, so
// summing around a gap would understate that side and fake a big lead.
function sideStrength(players) {
    if (!players || !players.length) return null;
    let sum = 0;
    for (const p of players) {
        const v = Number(p.bax);
        if (p.bax == null || !(v > 0)) return null;
        sum += v;
    }
    return sum;
}

const CAT_VAR = { Einzel: "var(--disc-einzel)", Doppel: "var(--disc-doppel)", Mixed: "var(--disc-mixed)" };
function gameRow(g, meta) {
    const o = gameOutlook(g);
    const sets = String(g.score || "").trim().split(/\s+/).filter(Boolean).map((set) => {
        const m = /^(\d+)-(\d+)$/.exec(set);
        if (!m) return `<span class="g-set g-set--raw">${escapeHtml(set)}</span>`;
        const h = +m[1], a = +m[2];
        return `<span class="g-set">${h > a ? `<b>${h}</b><i>${a}</i>` : `<i>${h}</i><b>${a}</b>`}</span>`;
    }).join("");
    const edge = o.fav ? `<span class="g-edge">BAX: ${o.fav === "home" ? "home" : "away"} by ${o.diff}</span>` : (o.diff === 0 ? `<span class="g-edge">BAX: even</span>` : "");
    const mid = `${sets ? `<div class="g-sets">${sets}</div>` : `<span class="g-edge">Not played</span>`}${o.upset ? `<span class="g-up">Upset</span>` : edge}`;
    const homeLost = o.homeWon === false, awayLost = o.homeWon === true;
    return `<div class="g-row" style="--gc:${CAT_VAR[g.category] || "var(--border-strong)"}">
        <span class="g-code" title="${escapeHtml(disciplineTitle(g.discipline))}">${escapeHtml(g.discipline)}</span>
        ${sideHtml(g.home, `is-home${homeLost ? " is-lost" : ""}`, meta.home_team || "Home")}
        <div class="g-mid">${mid}</div>
        ${sideHtml(g.away, `is-away${awayLost ? " is-lost" : ""}`, meta.away_team || "Away")}
    </div>`;
}

let lastMeta = {};
function renderGames(games) {
    const body = $("games-body");
    if (!games.length) {
        body.innerHTML = `<div class="pl-empty">No games found.</div>`;
        return;
    }
    body.innerHTML = `<div class="g-list">${games.map((g) => gameRow(g, lastMeta)).join("")}</div>
        <p class="g-note">Numbers next to names are each player's BAX for that game's discipline. An upset is a game won by the side with at least ${UPSET_MIN} less summed BAX.</p>`;
}
