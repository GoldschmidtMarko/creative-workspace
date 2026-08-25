// Compare Players page. Search adds up to six players; each is loaded from the
// same callables the single-player page uses (get_player_bax → identity + BAX
// history; get_player_dbv_stats → win/loss). Two comparisons are rendered: a
// combined BAX line chart (one line per player, one discipline at a time) and a
// games-played / win-rate breakdown. The selection lives in the URL (?p=…) and
// in localStorage, so it is shareable and the player page can add to it.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions } from "./util/firebase.js";

const getPlayerBax = httpsCallable(functions, "get_player_bax", { timeout: 120000 });
const getPlayerDbvStats = httpsCallable(functions, "get_player_dbv_stats", { timeout: 120000 });
const getPlayerNetwork = httpsCallable(functions, "get_player_network", { timeout: 120000 });
const searchPlayers = httpsCallable(functions, "search_players", { timeout: 60000 });

// Cap how many DBV win/loss lookups run at once. A full comparison would
// otherwise fire up to six get_player_dbv_stats calls simultaneously, and
// dbv.turnier.de rate-limits bursts — so we stagger them to at most two.
function limitConcurrency(max) {
    let active = 0;
    const queue = [];
    const pump = () => {
        if (active >= max || !queue.length) return;
        active++;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); });
    };
    return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}
const dbvLimit = limitConcurrency(2);

const CATS = ["Einzel", "Doppel", "Mixed"];
const DISC_LABEL = { Einzel: "Singles", Doppel: "Doubles", Mixed: "Mixed" };
const MAX_PLAYERS = 6;
const LS_KEY = "bax_compare_players";

const $ = (id) => document.getElementById(id);
function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}
function num(n) { return (n == null ? 0 : n).toLocaleString(); }
const seasonStart = (s) => parseInt((s || "").slice(0, 4), 10) || 0;
const normName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */
// Fixed slot pool (0..5) → the categorical palette. Colour follows the player,
// so removing one never repaints the rest; a freed slot is reused by the next add.
const usedSlots = new Set();
function takeSlot() { for (let i = 0; i < MAX_PLAYERS; i++) if (!usedSlots.has(i)) { usedSlots.add(i); return i; } return 0; }
function freeSlot(i) { usedSlots.delete(i); }

let uidSeq = 0;
// netStatus/teammates/opponents feed the recommendations panel (computeRecs).
const players = [];   // { uid, slot, sp_code, profile_id, name, club, status, wlStatus, history, winLoss, error, netStatus, teammates, opponents }
const baxHidden = new Set();  // uids hidden from the BAX chart via legend toggle

let discipline = "Einzel";  // combined-BAX discipline
let baxView = "chart";       // "chart" | "table"
let wlScope = "total";       // "total" | "Einzel" | "Doppel" | "Mixed"
let wlTime = "career";       // "career" | "year"

function sameIdentity(a, b) {
    if (a.profile_id && b.profile_id) return a.profile_id.toLowerCase() === b.profile_id.toLowerCase();
    if (a.sp_code && b.sp_code) return a.sp_code.toLowerCase() === b.sp_code.toLowerCase();
    return !!normName(a.name) && normName(a.name) === normName(b.name);
}
const readyPlayers = () => players.filter((p) => p.status === "ready");

/* ------------------------------------------------------------------ */
/* Persistence: URL (?p=) + localStorage                              */
/* ------------------------------------------------------------------ */
// Once a player has both ids resolved, carry both in the token — otherwise a
// reload or a shared link falls back to sp_code-only, which only re-resolves
// a profile_id for free if player_index still happens to have it cached (see
// the fallback search in loadPlayerData). "@" is safe in both halves: sp
// codes are digits/dashes/letters, profile ids are GUIDs.
function tokenFor(p) {
    if (p.sp_code && p.profile_id) return p.sp_code + "@" + p.profile_id;
    if (p.sp_code) return p.sp_code;
    if (p.profile_id) return "pid:" + p.profile_id;
    return "name:" + p.name;
}
function decodeToken(tok) {
    if (tok.includes("@")) {
        const [sp, pid] = tok.split("@");
        return { sp_code: sp, profile_id: pid };
    }
    if (tok.startsWith("pid:")) return { profile_id: tok.slice(4) };
    if (tok.startsWith("name:")) return { name: tok.slice(5) };
    return { sp_code: tok };
}
function persist() {
    const tokens = players.map(tokenFor);
    try { localStorage.setItem(LS_KEY, JSON.stringify(tokens)); } catch (e) { /* ignore */ }
    const url = tokens.length
        ? location.pathname + "?p=" + tokens.map(encodeURIComponent).join(",")
        : location.pathname;
    history.replaceState(null, "", url);
}
function initialTokens() {
    const p = (new URLSearchParams(location.search).get("p") || "").trim();
    if (p) return p.split(",").map((t) => decodeURIComponent(t)).filter(Boolean);
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]") || []; } catch (e) { return []; }
}

/* ------------------------------------------------------------------ */
/* Add / remove players                                               */
/* ------------------------------------------------------------------ */
function addPlayer(seed) {
    if (players.length >= MAX_PLAYERS) return false;
    if (players.some((p) => sameIdentity(p, seed))) return false;
    const p = {
        uid: ++uidSeq, slot: takeSlot(),
        sp_code: seed.sp_code || "", profile_id: seed.profile_id || "",
        name: seed.name || "", club: seed.club || "",
        status: "loading", wlStatus: "idle", history: {}, winLoss: null, error: "",
        netStatus: "idle", teammates: [], opponents: [],
    };
    players.push(p);
    persist();
    renderAll();
    loadPlayerData(p);
    return true;
}
function removePlayer(uid) {
    const i = players.findIndex((p) => p.uid === uid);
    if (i < 0) return;
    freeSlot(players[i].slot);
    baxHidden.delete(uid);
    players.splice(i, 1);
    persist();
    renderAll();
}

async function loadPlayerData(p) {
    try {
        const res = await getPlayerBax({ sp_code: p.sp_code, profile_id: p.profile_id, name: p.name });
        if (res.data.error) throw new Error(res.data.error);
        const id = res.data.identity || {};
        p.name = id.name || p.name;
        p.club = id.club || p.club;
        p.sp_code = id.sp_code || p.sp_code;
        p.profile_id = id.profile_id || p.profile_id;
        p.history = res.data.history || {};
        p.status = "ready";

        // badminton-bax.de (BAX ratings, what we just fetched) and
        // dbv.turnier.de (win/loss, recommendations) are separate systems —
        // get_player_bax only resolves a dbv profile_id for free when
        // player_index already has it cached for this sp_code. If not, fall
        // back to a dbv name search (returns both ids together, same as the
        // search box above) instead of leaving win/loss and recommendations
        // permanently unavailable for someone we very much do have a real
        // profile for.
        if (!p.profile_id && p.sp_code && p.name) {
            try {
                const sres = await searchPlayers({ q: p.name });
                const hit = (sres.data.players || []).find((r) =>
                    r.sp_code && r.sp_code.toLowerCase() === p.sp_code.toLowerCase());
                if (hit) { p.profile_id = hit.profile_id || p.profile_id; p.club = p.club || hit.club; }
            } catch (e) { /* best-effort — leave profile_id unresolved */ }
        }

        p.wlStatus = p.profile_id ? "loading" : "none";
        p.netStatus = p.profile_id ? "loading" : "none";
        persist();  // identity may have filled in ids → refresh the shareable token
        renderAll();
        if (p.profile_id) { loadWinLoss(p); loadPlayerNetwork(p); }
    } catch (err) {
        p.status = "error";
        p.error = err.message || String(err);
        renderAll();
    }
}
async function loadWinLoss(p) {
    try {
        const res = await dbvLimit(() => getPlayerDbvStats({ profile_id: p.profile_id, name: p.name }));
        if (res.data.error) throw new Error(res.data.error);
        p.winLoss = res.data.win_loss || {};
        p.wlStatus = "ready";
    } catch (err) {
        p.winLoss = null;
        p.wlStatus = "error";
    }
    renderGames();
}
// Powers the "Suggested — teammates & opponents" panel below the chips —
// reuses the same get_player_network data the Player page's Matchups tab
// and the Network graph are built on, staggered the same way as win/loss so
// a full six-player comparison doesn't burst dbv.turnier.de.
async function loadPlayerNetwork(p) {
    try {
        const res = await dbvLimit(() => getPlayerNetwork({ sp_code: p.sp_code, profile_id: p.profile_id, name: p.name }));
        if (res.data.error) throw new Error(res.data.error);
        p.teammates = res.data.teammates || [];
        p.opponents = res.data.opponents || [];
        p.netStatus = "ready";
    } catch (err) {
        p.teammates = []; p.opponents = [];
        p.netStatus = "error";
    }
    renderRecs();
}

/* ------------------------------------------------------------------ */
/* Search                                                             */
/* ------------------------------------------------------------------ */
$("cmp-search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("cmp-search-q").value.trim();
    if (q.length < 2) return;
    runSearch(q);
});

function initials(name) {
    const p = (name || "").trim().split(/\s+/);
    return ((p[0] || "")[0] || "") + (p.length > 1 ? (p[p.length - 1][0] || "") : "");
}

async function runSearch(q) {
    const st = $("cmp-search-status");
    const box = $("cmp-search-results");
    st.textContent = "Searching…";
    st.classList.remove("hidden");
    box.innerHTML = Array.from({ length: 4 }, () => `
        <div class="search-result is-skel" aria-hidden="true">
            <span class="skel" style="width:2.2rem;height:2.2rem;border-radius:50%;flex-shrink:0"></span>
            <span class="search-result__body">
                <span class="skel skel-line" style="width:42%;height:0.9rem"></span>
                <span class="skel skel-line" style="width:62%;margin-top:0.45rem"></span>
            </span>
        </div>`).join("");
    try {
        const res = await searchPlayers({ q });
        if (res.data.error) throw new Error(res.data.error);
        renderSearchResults(res.data.players || [], q);
    } catch (err) {
        console.error("player search failed:", err);
        box.innerHTML = "";
        st.textContent = "Search failed: " + err.message;
    }
}

function renderSearchResults(list, q) {
    const st = $("cmp-search-status");
    const box = $("cmp-search-results");
    if (!list.length) {
        box.innerHTML = "";
        st.textContent = `No players found for “${q}”.`;
        st.classList.remove("hidden");
        return;
    }
    st.classList.add("hidden");
    const full = players.length >= MAX_PLAYERS;
    box.innerHTML = list.map((r, i) => {
        const added = players.some((p) => sameIdentity(p, r));
        const disabled = added || (full && !added);
        const sub = [r.club, r.sp_code].filter(Boolean).map(escapeHtml).join(" · ");
        const icon = added ? "check" : "plus";
        return `<div class="search-result cmp-result" data-i="${i}" role="button" tabindex="0"
                ${disabled ? 'aria-disabled="true"' : ""}
                title="${added ? "Already added" : full ? "Remove a player first" : "Add to comparison"}">
            <span class="search-result__avatar">${escapeHtml(initials(r.name).toUpperCase())}</span>
            <span class="search-result__body">
                <span class="search-result__name">${escapeHtml(r.name)}</span>
                ${sub ? `<span class="search-result__sub">${sub}</span>` : ""}
            </span>
            <i data-lucide="${icon}" class="cmp-result__add"></i>
        </div>`;
    }).join("");
    box.querySelectorAll(".cmp-result").forEach((el) => {
        const r = list[+el.getAttribute("data-i")];
        const activate = () => {
            if (el.getAttribute("aria-disabled") === "true") return;
            if (addPlayer(r)) renderSearchResults(list, q);  // refresh added/disabled state
        };
        el.addEventListener("click", activate);
        el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } });
    });
    if (window.lucide) lucide.createIcons();
}

/* ------------------------------------------------------------------ */
/* Render: chips + count                                              */
/* ------------------------------------------------------------------ */
function renderAll() {
    renderChips();
    renderBax();
    renderGames();
    renderRecs();
}

function renderChips() {
    const hint = $("cmp-count-hint");
    hint.textContent = players.length
        ? `${players.length} / ${MAX_PLAYERS} players` + (players.length >= MAX_PLAYERS ? " · limit reached" : "")
        : "add up to 6 players to compare";
    const el = $("cmp-chips");
    el.innerHTML = players.map((p) => {
        const label = p.name || p.sp_code || "Loading…";
        const cls = "cmp-chip" + (p.status === "loading" ? " is-loading" : "") + (p.status === "error" ? " is-error" : "");
        const title = p.status === "error" ? ` title="${escapeHtml(p.error)}"` : "";
        return `<span class="${cls}"${title}>
            <span class="cmp-chip__sw" style="background:var(--cmp-${p.slot})"></span>
            <span class="cmp-chip__name">${escapeHtml(label)}</span>
            <button class="cmp-chip__x" type="button" data-uid="${p.uid}" aria-label="Remove ${escapeHtml(label)}">
                <i data-lucide="x"></i>
            </button>
        </span>`;
    }).join("");
    el.querySelectorAll(".cmp-chip__x").forEach((b) =>
        b.addEventListener("click", () => removePlayer(+b.getAttribute("data-uid"))));
    if (window.lucide) lucide.createIcons();
}

const emptyPrompt = () => `<div class="cmp-empty">Search for players above and add them to build a comparison.</div>`;

/* ------------------------------------------------------------------ */
/* Recommendations: teammates/opponents of the players already added  */
/* ------------------------------------------------------------------ */
const REC_LIMIT = 6;

// Pools every added (resolved) player's teammates/opponents, drops anyone
// already in the comparison, merges the same person seen from more than one
// source player (their played counts add up — someone who's a shared
// connection of several added players naturally floats to the top), and
// keeps the most-played handful.
function computeRecs(kind) {
    const byKey = new Map();
    readyPlayers().forEach((p) => {
        (p[kind] || []).forEach((e) => {
            if (!e || !e.name) return;
            if (players.some((existing) => sameIdentity(existing, e))) return;   // already added
            const key = e.key || e.sp_code || "name:" + normName(e.name);
            const cur = byKey.get(key);
            if (cur) { cur.played += e.played || 0; cur.sources.add(p.uid); }
            else byKey.set(key, { name: e.name, sp_code: e.sp_code || "", club: e.club || "", played: e.played || 0, sources: new Set([p.uid]) });
        });
    });
    return Array.from(byKey.values()).sort((a, b) => b.played - a.played).slice(0, REC_LIMIT);
}

function renderRecList(id, kind) {
    const el = $(id);
    const recs = computeRecs(kind);
    const full = players.length >= MAX_PLAYERS;
    el.innerHTML = recs.map((r, i) => {
        const sub = [r.club, r.sources.size > 1 ? `shared by ${r.sources.size}` : `${num(r.played)} matches`]
            .filter(Boolean).map(escapeHtml).join(" · ");
        return `<div class="search-result cmp-result" data-i="${i}" role="button" tabindex="0"
                ${full ? 'aria-disabled="true"' : ""}
                title="${full ? "Remove a player first" : "Add to comparison"}">
            <span class="search-result__avatar">${escapeHtml(initials(r.name).toUpperCase())}</span>
            <span class="search-result__body">
                <span class="search-result__name">${escapeHtml(r.name)}</span>
                <span class="search-result__sub cmp-recs__sub">${sub}</span>
            </span>
            <i data-lucide="plus" class="cmp-result__add"></i>
        </div>`;
    }).join("");
    el.querySelectorAll(".cmp-result").forEach((node) => {
        const r = recs[+node.getAttribute("data-i")];
        const activate = () => {
            if (node.getAttribute("aria-disabled") === "true") return;
            addPlayer(r);
        };
        node.addEventListener("click", activate);
        node.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } });
    });
}

// Folded state persists across visits (same spirit as the player selection
// itself) — someone who's decided they don't want suggestions shouldn't have
// to re-collapse the panel every time they come back.
const RECS_COLLAPSED_KEY = "bax_compare_recs_collapsed";
function setRecsCollapsed(collapsed) {
    const wrap = $("cmp-recs");
    wrap.classList.toggle("is-collapsed", collapsed);
    $("cmp-recs-toggle").setAttribute("aria-expanded", String(!collapsed));
    try { localStorage.setItem(RECS_COLLAPSED_KEY, collapsed ? "1" : "0"); } catch (e) { /* ignore */ }
}
$("cmp-recs-toggle").addEventListener("click", () => {
    setRecsCollapsed(!$("cmp-recs").classList.contains("is-collapsed"));
});

function renderRecs() {
    const wrap = $("cmp-recs");
    const anyNetwork = readyPlayers().some((p) => p.netStatus === "ready" || p.netStatus === "loading");
    if (!anyNetwork) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    renderRecList("cmp-recs-teammates", "teammates");
    renderRecList("cmp-recs-opponents", "opponents");
    if (window.lucide) lucide.createIcons();
}
try { setRecsCollapsed(localStorage.getItem(RECS_COLLAPSED_KEY) === "1"); } catch (e) { /* ignore */ }

/* ------------------------------------------------------------------ */
/* Combined BAX — legend + chart / table                             */
/* ------------------------------------------------------------------ */
document.querySelectorAll("#cmp-disc [data-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
        discipline = btn.getAttribute("data-cat");
        document.querySelectorAll("#cmp-disc [data-cat]").forEach((b) => b.classList.toggle("active", b === btn));
        renderBax();
    });
});
document.querySelectorAll("[data-cview]").forEach((btn) => {
    btn.addEventListener("click", () => {
        baxView = btn.getAttribute("data-cview");
        document.querySelectorAll("[data-cview]").forEach((b) => b.classList.toggle("active", b === btn));
        renderBax();
    });
});

function renderBaxLegend() {
    const el = $("cmp-bax-legend");
    const ps = readyPlayers();
    el.innerHTML = ps.map((p) => {
        const off = baxHidden.has(p.uid) ? " off" : "";
        return `<span class="lg${off}" data-uid="${p.uid}">
            <span class="lg-sw" style="background:var(--cmp-${p.slot})"></span>${escapeHtml(p.name || p.sp_code || "Player")}</span>`;
    }).join("");
    el.querySelectorAll("[data-uid]").forEach((n) => n.addEventListener("click", () => {
        const uid = +n.getAttribute("data-uid");
        if (baxHidden.has(uid)) baxHidden.delete(uid); else baxHidden.add(uid);
        renderBax();
    }));
}

function renderBax() {
    renderBaxLegend();
    if (baxView === "table") renderBaxTable(); else renderBaxChart();
}

function renderBaxChart() {
    const body = $("cmp-bax-body");
    if (!players.length) { body.innerHTML = emptyPrompt(); return; }
    const active = readyPlayers().filter((p) => !baxHidden.has(p.uid) && (p.history[discipline] || []).length);
    const seasons = Array.from(new Set(active.flatMap((p) => (p.history[discipline] || []).map((r) => r.season))))
        .sort((a, b) => seasonStart(a) - seasonStart(b));
    const values = active.flatMap((p) => (p.history[discipline] || []).map((r) => r.bax).filter((v) => v != null));
    if (!seasons.length || !values.length) {
        body.innerHTML = `<div class="cmp-empty">No ${DISC_LABEL[discipline]} BAX history for the selected players.</div>`;
        return;
    }

    const W = 900, padL = 44, padR = 16, padT = 12, padB = 30;
    const plotW = W - padL - padR, H = 320, plotH = H - padT - padB;
    const xs = seasons.length > 1 ? (i) => padL + (i / (seasons.length - 1)) * plotW : () => padL + plotW / 2;

    let lo = Math.min(...values), hi = Math.max(...values);
    const pad = Math.max(10, Math.round((hi - lo) * 0.15));
    lo = Math.floor((lo - pad) / 10) * 10; hi = Math.ceil((hi + pad) / 10) * 10;
    if (hi === lo) hi = lo + 10;
    const ys = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

    let grid = "";
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
        const v = lo + ((hi - lo) * i) / ticks, y = ys(v);
        grid += `<line class="pl-grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>`;
        grid += `<text class="pl-axis" x="${padL - 8}" y="${y + 3}" text-anchor="end">${Math.round(v)}</text>`;
    }
    let xlabels = "";
    seasons.forEach((s, i) => {
        if (seasons.length > 8 && i % 2 === 1 && i !== seasons.length - 1) return;
        xlabels += `<text class="pl-axis" x="${xs(i)}" y="${H - 10}" text-anchor="middle">${escapeHtml(s)}</text>`;
    });

    let lines = "", dots = "";
    active.forEach((p) => {
        const byS = new Map((p.history[discipline] || []).map((r) => [r.season, r]));
        const pts = seasons.map((s, i) => ({ s, i, r: byS.get(s) })).filter((q) => q.r && q.r.bax != null);
        const stroke = `var(--cmp-${p.slot})`;
        if (pts.length > 1) {
            const d = pts.map((q) => `${xs(q.i)},${ys(q.r.bax)}`).join(" ");
            lines += `<polyline class="pl-line" style="stroke:${stroke}" points="${d}"/>`;
        }
        pts.forEach((q) => {
            const tip = `${p.name || "Player"} · ${q.s}: BAX ${q.r.bax}${q.r.erfolg ? " · " + q.r.erfolg : ""}`;
            dots += `<circle class="cmp-dot" style="fill:${stroke}" cx="${xs(q.i)}" cy="${ys(q.r.bax)}" r="4.5" data-tip="${escapeHtml(tip)}"/>`;
        });
    });

    body.innerHTML = `
        <div class="chart-svg-wrap">
            <svg class="pl-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Combined BAX history">
                ${grid}${lines}${dots}${xlabels}
            </svg>
            <div class="chart-tooltip hidden"></div>
        </div>`;
    wireTooltip(body);
}

function renderBaxTable() {
    const body = $("cmp-bax-body");
    if (!players.length) { body.innerHTML = emptyPrompt(); return; }
    const ps = readyPlayers().filter((p) => (p.history[discipline] || []).length);
    if (!ps.length) {
        body.innerHTML = `<div class="cmp-empty">No ${DISC_LABEL[discipline]} BAX history for the selected players.</div>`;
        return;
    }
    const seasons = Array.from(new Set(ps.flatMap((p) => (p.history[discipline] || []).map((r) => r.season))))
        .sort((a, b) => seasonStart(b) - seasonStart(a));  // newest first
    const maps = ps.map((p) => new Map((p.history[discipline] || []).map((r) => [r.season, r])));
    const head = ps.map((p) => `<th><span class="cmp-chip__sw" style="background:var(--cmp-${p.slot})"></span>${escapeHtml(p.name || p.sp_code || "Player")}</th>`).join("");
    const rows = seasons.map((s) => {
        const cells = maps.map((m) => {
            const r = m.get(s);
            return r && r.bax != null ? `<td class="cur">${r.bax}</td>` : `<td>–</td>`;
        }).join("");
        return `<tr><td>${escapeHtml(s)}</td>${cells}</tr>`;
    }).join("");
    body.innerHTML = `<div class="table-scroll"><table class="cmp-table">
        <thead><tr><th>Season</th>${head}</tr></thead>
        <tbody>${rows}</tbody></table></div>`;
}

/* ------------------------------------------------------------------ */
/* Games played & win rate                                           */
/* ------------------------------------------------------------------ */
document.querySelectorAll("#cmp-wl-scope [data-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
        wlScope = btn.getAttribute("data-scope");
        document.querySelectorAll("#cmp-wl-scope [data-scope]").forEach((b) => b.classList.toggle("active", b === btn));
        renderGames();
    });
});
document.querySelectorAll("#cmp-wl-time [data-time]").forEach((btn) => {
    btn.addEventListener("click", () => {
        wlTime = btn.getAttribute("data-time");
        document.querySelectorAll("#cmp-wl-time [data-time]").forEach((b) => b.classList.toggle("active", b === btn));
        renderGames();
    });
});

function recFor(p) {
    if (!p.winLoss) return null;
    const cat = p.winLoss[wlScope] || {};
    return cat[wlTime] || null;
}
function pct(rec) { return rec.pct != null ? rec.pct : (rec.total ? Math.round((rec.won / rec.total) * 100) : 0); }

// The status cell when a player has no comparable win/loss record yet.
function gamesNote(p) {
    if (p.status === "loading" || p.wlStatus === "loading") return "loading…";
    if (p.wlStatus === "none") return "no DBV profile linked";
    if (p.wlStatus === "error") return "couldn’t load";
    return `no ${wlScope === "total" ? "" : DISC_LABEL[wlScope] + " "}matches recorded`;
}

function renderGames() {
    const body = $("cmp-games-body");
    if (!players.length) { body.innerHTML = emptyPrompt(); return; }
    const rows = players.map((p) => ({ p, rec: recFor(p) }));
    const maxGames = Math.max(1, ...rows.map((r) => (r.rec && r.rec.total) || 0));

    const head = `<div class="cmp-games__head"><span>Player</span><span>Games played</span><span>Win rate</span></div>`;
    const bodyRows = rows.map(({ p, rec }) => {
        const name = `<span class="cmp-grow__name"><span class="cmp-chip__sw" style="background:var(--cmp-${p.slot})"></span><span>${escapeHtml(p.name || p.sp_code || "Player")}</span></span>`;
        if (!rec) {
            return `<div class="cmp-grow">${name}<span class="cmp-grow__na">${escapeHtml(gamesNote(p))}</span><span></span></div>`;
        }
        const gPct = Math.round(((rec.total || 0) / maxGames) * 100);
        const wPct = pct(rec);
        const games = `<span class="cmp-measure">
            <span class="cmp-bar"><span class="cmp-bar__fill" style="width:${gPct}%;background:var(--cmp-${p.slot})"></span></span>
            <span class="cmp-measure__val">${num(rec.total || 0)}</span></span>`;
        const winrate = `<span class="cmp-measure">
            <span class="cmp-bar"><span class="cmp-bar__fill" style="width:${wPct}%;background:var(--cmp-${p.slot})"></span></span>
            <span class="cmp-measure__val">${wPct}%<span class="sub"> · ${num(rec.won)}–${num(rec.lost)}</span></span></span>`;
        return `<div class="cmp-grow">${name}${games}${winrate}</div>`;
    }).join("");

    body.innerHTML = `<div class="cmp-games">${head}${bodyRows}</div>`;
}

/* ------------------------------------------------------------------ */
/* Shared SVG hover tooltip (ported from player.js)                  */
/* ------------------------------------------------------------------ */
function wireTooltip(container) {
    const wrap = container.querySelector(".chart-svg-wrap");
    if (!wrap) return;
    const svg = wrap.querySelector("svg");
    const tip = wrap.querySelector(".chart-tooltip");
    svg.addEventListener("mousemove", (e) => {
        const el = e.target.closest("[data-tip]");
        if (!el) { tip.classList.add("hidden"); return; }
        tip.textContent = el.getAttribute("data-tip");
        tip.classList.remove("hidden");
        const box = wrap.getBoundingClientRect();
        tip.style.left = (e.clientX - box.left + 12) + "px";
        tip.style.top = (e.clientY - box.top + 12) + "px";
    });
    svg.addEventListener("mouseleave", () => tip.classList.add("hidden"));
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                          */
/* ------------------------------------------------------------------ */
const yearEl = $("copyright-year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

renderAll();  // paint empty prompts first
initialTokens().slice(0, MAX_PLAYERS).forEach((tok) => addPlayer(decodeToken(tok)));
