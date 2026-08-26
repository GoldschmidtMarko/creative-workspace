// Player Insights page. Loads a single player's data from three callables
// (get_player_bax = badminton-bax.de history + distribution; get_player_dbv_stats
// = win/loss + titles + tournaments; get_player_leagues = league history, reused
// from the tournament tool) and get_player_upcoming (implicit registrations).
// Sections render progressively, each with its own skeleton.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions } from "./util/firebase.js";
import { mountFavoriteStar, onFavoritesChange } from "./util/favorites.js";

const getPlayerBax = httpsCallable(functions, "get_player_bax", { timeout: 120000 });
const getPlayerDbvStats = httpsCallable(functions, "get_player_dbv_stats", { timeout: 120000 });
const getPlayerLeagues = httpsCallable(functions, "get_player_leagues", { timeout: 60000 });
const getPlayerUpcoming = httpsCallable(functions, "get_player_upcoming", { timeout: 60000 });
const getPlayerNetwork = httpsCallable(functions, "get_player_network", { timeout: 120000 });
const searchPlayers = httpsCallable(functions, "search_players", { timeout: 60000 });

const CATS = ["Einzel", "Doppel", "Mixed"];
const DISC_LABEL = { Einzel: "Singles", Doppel: "Doubles", Mixed: "Mixed" };
const NETWORK_PAGE_SIZE = 10;
// Recently viewed (sessionStorage) — declared up here since showSearchView()
// below reads it on the very first, synchronous pass through this script.
const RECENT_KEY = "bax_recent_players";
const RECENT_MAX = 8;
// Same reason: showSearchView() -> renderRecentPlayers() reads this on that
// same first pass, before the `let` further down would otherwise initialize.
let favoritePlayers = [];

const $ = (id) => document.getElementById(id);
function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}
function num(n) { return (n == null ? 0 : n).toLocaleString(); }

/* Skeleton placeholders (shimmer) shown while each section loads. */
const skelChart = () => `<div class="skel skel-block" style="height:280px"></div>`;
const skelRows = (n) => Array.from({ length: n }, () => `<div class="skel skel-block" style="height:46px;margin-bottom:0.5rem"></div>`).join("");
const skelTiles = (n) => Array.from({ length: n }, () => `<div class="skel skel-block" style="height:56px;flex:1;min-width:100px"></div>`).join("");
function showProfileSkeleton() {
    $("p-name").innerHTML = `<span class="skel skel-line" style="display:inline-block;width:240px;height:1.4rem;border-radius:6px"></span>`;
    $("p-bax-tiles").innerHTML = skelTiles(3);
    $("p-wl-tiles").innerHTML = skelTiles(2);
    $("hist-body").innerHTML = skelChart();
    $("dist-body").innerHTML = skelChart();
    $("winloss-body").innerHTML = skelRows(3);
    $("leagues-body").innerHTML = skelRows(3);
    $("tournaments-body").innerHTML = skelRows(4);
    $("titles-body").innerHTML = skelRows(4);
    $("upcoming-body").innerHTML = skelRows(3);
    $("network-teammates").innerHTML = skelRows(3);
    $("network-opponents").innerHTML = skelRows(3);
}

// Page state kept for re-renders (legend toggles, view/scope/category switches).
const state = {
    history: null, distribution: null,
    histView: "chart", histHidden: new Set(),
    distScope: "lv", distCat: "Einzel",
    profileId: null,
    // Network tab: teammates/opponents sort & expand state independently.
    network: {
        teammates: { list: [], sort: "played", dir: "desc", shown: NETWORK_PAGE_SIZE },
        opponents: { list: [], sort: "played", dir: "desc", shown: NETWORK_PAGE_SIZE },
    },
};

/* ------------------------------------------------------------------ */
/* Bootstrap                                                          */
/* ------------------------------------------------------------------ */
const params = new URLSearchParams(location.search);
const initial = {
    sp: (params.get("sp") || "").trim(),
    pid: (params.get("pid") || "").trim(),
    name: (params.get("name") || "").trim(),
    q: (params.get("q") || "").trim(),
};
// Tournament context, present when the user arrived by clicking a player inside
// a tournament analysis — powers the "back to tournament" button.
const from = {
    t: (params.get("from_t") || "").trim(),
    e: (params.get("from_e") || "").trim(),
    tn: (params.get("from_tn") || "").trim(),
    pi: (params.get("from_pi") || "").trim(),
};
const yearEl = $("copyright-year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

if (initial.sp || initial.pid) {
    showProfileView();
    loadPlayer({ sp: initial.sp, pid: initial.pid, name: initial.name });
} else {
    showSearchView();
    if (initial.q) { $("search-q").value = initial.q; runSearch(initial.q); }
}

$("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("search-q").value.trim();
    if (q.length < 2) return;
    history.replaceState(null, "", location.pathname + "?q=" + encodeURIComponent(q));
    runSearch(q);
});

function showSearchView() {
    $("profile-view").classList.add("hidden");
    $("error-view").classList.add("hidden");
    $("search-view").classList.remove("hidden");
    const ph = $("page-header"); if (ph) ph.classList.remove("hidden");
    renderRecentPlayers();
}

/* Recently viewed — sessionStorage only (cleared with the tab), so it's a
   quick way back to whoever you were just looking at, not a permanent log. */
function recentPlayersList() {
    try { return JSON.parse(sessionStorage.getItem(RECENT_KEY) || "[]") || []; } catch (e) { return []; }
}
function recordRecentPlayer(sp, pid, name) {
    if (!sp && !pid && !name) return;
    const token = pid ? "pid:" + pid : (sp || "name:" + name);
    const list = recentPlayersList().filter((r) => r.token !== token);
    list.unshift({ token, sp: sp || "", pid: pid || "", name: name || "" });
    try { sessionStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch (e) { /* ignore */ }
}
// Favorite players — mirrors the "Recently viewed" list/markup but sourced
// from the shared favorites store (see util/favorites.js), so it updates live
// as stars are toggled anywhere on the site. favoritePlayers itself is
// declared near RECENT_KEY above — see the comment there.
function sameAsFavorite(recent, fav) {
    if (recent.pid && fav.profile_id) return recent.pid.toLowerCase() === fav.profile_id.toLowerCase();
    if (recent.sp && fav.sp_code) return recent.sp.toLowerCase() === fav.sp_code.toLowerCase();
    const rn = (recent.name || "").trim().toLowerCase();
    const fn = (fav.name || "").trim().toLowerCase();
    return !!rn && rn === fn;
}
function renderFavoritePlayers(favorites) {
    const wrap = $("favorite-players-wrap");
    favoritePlayers = Object.values((favorites && favorites.player) || {});
    if (!wrap) return;
    if (!favoritePlayers.length) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    $("favorite-players").innerHTML = favoritePlayers
        .slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""))
        .map((f) => {
            const qp = new URLSearchParams();
            if (f.sp_code) qp.set("sp", f.sp_code);
            if (f.profile_id) qp.set("pid", f.profile_id);
            if (f.name) qp.set("name", f.name);
            return `<a class="search-result" href="/html/player.html?${qp.toString()}">
                <span class="search-result__avatar">${escapeHtml(initials(f.name).toUpperCase())}</span>
                <span class="search-result__body">
                    <span class="search-result__name">${escapeHtml(f.name || "Player")}</span>
                </span>
                <i data-lucide="chevron-right" class="search-result__chev"></i>
            </a>`;
        }).join("");
    if (window.lucide) lucide.createIcons();
}
onFavoritesChange((f) => { renderFavoritePlayers(f); renderRecentPlayers(); });

// Recently viewed, minus anyone already starred — they already have their
// own section above, so listing them twice would just be noise.
function renderRecentPlayers() {
    const wrap = $("recent-players-wrap");
    if (!wrap) return;
    const list = recentPlayersList().filter((r) => !favoritePlayers.some((f) => sameAsFavorite(r, f)));
    if (!list.length) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    $("recent-players").innerHTML = list.map((r) => {
        const qp = new URLSearchParams();
        if (r.sp) qp.set("sp", r.sp);
        if (r.pid) qp.set("pid", r.pid);
        if (r.name) qp.set("name", r.name);
        return `<a class="search-result" href="/html/player.html?${qp.toString()}">
            <span class="search-result__avatar">${escapeHtml(initials(r.name).toUpperCase())}</span>
            <span class="search-result__body">
                <span class="search-result__name">${escapeHtml(r.name || r.sp || "Player")}</span>
            </span>
            <i data-lucide="chevron-right" class="search-result__chev"></i>
        </a>`;
    }).join("");
    if (window.lucide) lucide.createIcons();
}

// dbv.turnier.de player search → a clickable list of candidates. Each result
// carries both ids, so opening one loads a full, robust profile.
async function runSearch(q) {
    const st = $("search-status");
    const box = $("search-results");
    const recentWrap = $("recent-players-wrap");
    if (recentWrap) recentWrap.classList.add("hidden");
    st.textContent = "Searching…";
    st.classList.remove("hidden");
    box.innerHTML = Array.from({ length: 5 }, () => `
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

function initials(name) {
    const p = (name || "").trim().split(/\s+/);
    return ((p[0] || "")[0] || "") + (p.length > 1 ? (p[p.length - 1][0] || "") : "");
}

function renderSearchResults(list, q) {
    const st = $("search-status");
    const box = $("search-results");
    if (!list.length) {
        box.innerHTML = "";
        st.textContent = `No players found for “${q}”.`;
        st.classList.remove("hidden");
        return;
    }
    st.classList.add("hidden");
    box.innerHTML = list.map((r) => {
        const qp = new URLSearchParams();
        if (r.sp_code) qp.set("sp", r.sp_code);
        if (r.profile_id) qp.set("pid", r.profile_id);
        if (r.name) qp.set("name", r.name);
        const sub = [r.club, r.sp_code].filter(Boolean).map(escapeHtml).join(" · ");
        return `<a class="search-result" href="/html/player.html?${qp.toString()}">
            <span class="search-result__avatar">${escapeHtml(initials(r.name).toUpperCase())}</span>
            <span class="search-result__body">
                <span class="search-result__name">${escapeHtml(r.name)}</span>
                ${sub ? `<span class="search-result__sub">${sub}</span>` : ""}
            </span>
            <i data-lucide="chevron-right" class="search-result__chev"></i>
        </a>`;
    }).join("");
    if (window.lucide) lucide.createIcons();
}

function showProfileView() {
    $("search-view").classList.add("hidden");
    $("error-view").classList.add("hidden");
    $("profile-view").classList.remove("hidden");
    const ph = $("page-header"); if (ph) ph.classList.add("hidden");   // identity card is the header now
    showProfileSkeleton();
    setupTournamentReturn();
}

// Reveal the "back to tournament" button (and the dbv tournament-player link)
// when we arrived from a tournament.
function setupTournamentReturn() {
    if (!from.t) return;
    const rb = $("tournament-return");
    if (rb) {
        const q = new URLSearchParams({ id: from.t });
        if (from.e) q.set("event", from.e);
        if (from.tn) q.set("name", from.tn);
        rb.href = `/html/tournament.html?${q.toString()}`;
        $("tournament-return-name").textContent = from.tn || "Tournament";
        rb.classList.remove("hidden");
    }
    // Direct link to this player's page within the tournament on dbv.turnier.de.
    if (from.pi) {
        const tl = $("p-dbv-tournament");
        if (tl) {
            tl.href = `https://dbv.turnier.de/tournament/${from.t}/player/${from.pi}`;
            tl.classList.remove("hidden");
        }
    }
}

function showError(msg) {
    $("profile-view").classList.add("hidden");
    $("search-view").classList.remove("hidden");
    const ph = $("page-header"); if (ph) ph.classList.remove("hidden");
    document.title = "Player Insights | BAX Checker";
    const st = $("search-status");
    st.textContent = msg;
    st.classList.remove("hidden");
}

/* Sub-navigation: switch which section panel is visible (no scrolling). */
const _tabs = document.querySelectorAll(".subnav__tab");
const _panels = document.querySelectorAll(".tab-panel");
function activateTab(name) {
    if (!Array.from(_tabs).some((t) => t.getAttribute("data-tab") === name)) return;
    _tabs.forEach((t) => t.classList.toggle("is-active", t.getAttribute("data-tab") === name));
    _panels.forEach((p) => p.classList.toggle("is-active", p.getAttribute("data-panel") === name));
}
_tabs.forEach((t) => t.addEventListener("click", () => {
    const name = t.getAttribute("data-tab");
    activateTab(name);
    history.replaceState(null, "", location.pathname + location.search + "#" + name);
}));
if (location.hash) activateTab(location.hash.slice(1));

function updateUrl(sp, pid, name) {
    const q = new URLSearchParams();
    if (sp) q.set("sp", sp);
    if (pid) q.set("pid", pid);
    if (name) q.set("name", name);
    history.replaceState(null, "", location.pathname + "?" + q.toString());
}

/* "Add to comparison": appends this player to the shared compare selection
   (localStorage, same key + token format as compare.js) and opens the page. */
const COMPARE_LS_KEY = "bax_compare_players";
const COMPARE_MAX = 6;
function compareToken(sp, pid, name) {
    if (sp) return sp;
    if (pid) return "pid:" + pid;
    return name ? "name:" + name : "";
}
function setupAddCompare(sp, pid, name) {
    const btn = $("p-add-compare");
    if (!btn) return;
    const token = compareToken(sp, pid, name);
    if (!token) { btn.classList.add("hidden"); return; }
    btn.classList.remove("hidden");
    btn.onclick = () => {
        let list = [];
        try { list = JSON.parse(localStorage.getItem(COMPARE_LS_KEY) || "[]") || []; } catch (e) { list = []; }
        const has = list.some((t) => t === token || (pid && t === "pid:" + pid) || (sp && t === sp));
        if (!has && list.length < COMPARE_MAX) {
            list.push(token);
            try { localStorage.setItem(COMPARE_LS_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
        }
        location.href = "/html/compare.html?p=" + list.map(encodeURIComponent).join(",");
    };
}

// Reuses the same identity token as "Add to comparison" (sp_code, else
// pid:<profile_id>, else name:<name>) as the favorite's stable id.
function setupFavoriteStar(sp, pid, name) {
    const el = $("p-star");
    if (!el) return;
    const id = compareToken(sp, pid, name);
    mountFavoriteStar(el, {
        type: "player", id, name,
        meta: { sp_code: sp || "", profile_id: pid || "" },
        label: { off: "Star", on: "Starred" },
    });
}

/* ------------------------------------------------------------------ */
/* Load pipeline                                                      */
/* ------------------------------------------------------------------ */
async function loadPlayer({ sp = "", pid = "", name = "", vorname = "" }) {
    try {
        const res = await getPlayerBax({ sp_code: sp, profile_id: pid, name, vorname });
        if (res.data.error) {
            // badminton-bax.de (BAX ratings) and dbv.turnier.de (leagues,
            // tournaments, profiles) are two separate systems — someone only
            // ever seen as a league opponent can have a resolved dbv profile
            // (pid) with no badminton-bax.de match at all. That's not a dead
            // end if we already have their pid: show what dbv itself has
            // (leagues, matchups, upcoming, tournaments) instead of a hard
            // error, same spirit as markDbvUnavailable's inverse case below.
            if (!pid) { showError(res.data.error); return; }
            renderIdentity({ name, profile_id: pid, sp_code: sp });
            state.history = { Einzel: [], Doppel: [], Mixed: [] };
            state.distribution = {};
            renderBaxTiles(state.history);
            renderHistory();
            renderDistribution();
            state.profileId = pid;
            updateUrl(sp, pid, name);
            recordRecentPlayer(sp, pid, name);
            setupAddCompare(sp, pid, name);
            setupFavoriteStar(sp, pid, name);
            if (window.lucide) lucide.createIcons();
            loadDbvStats(pid, name);
            loadLeagues(pid, name);
            loadUpcoming(pid);
            loadNetwork(pid, sp, name);
            return;
        }
        const { identity, history, distribution } = res.data;
        state.history = history;
        state.distribution = distribution;

        renderIdentity(identity);
        renderBaxTiles(history);
        renderHistory();
        renderDistribution();

        const rpid = (identity && identity.profile_id) || pid || "";
        const rsp = (identity && identity.sp_code) || sp || "";
        state.profileId = rpid;
        updateUrl(rsp, rpid, identity && identity.name);
        recordRecentPlayer(rsp, rpid, identity && identity.name);
        setupAddCompare(rsp, rpid, identity && identity.name);
        setupFavoriteStar(rsp, rpid, identity && identity.name);
        if (window.lucide) lucide.createIcons();

        if (rpid) {
            loadDbvStats(rpid, identity && identity.name);
            loadLeagues(rpid, identity && identity.name);
            loadUpcoming(rpid);
            loadNetwork(rpid, rsp, identity && identity.name);
        } else {
            markDbvUnavailable();
        }
    } catch (err) {
        console.error("loadPlayer failed:", err);
        showError(err.message || String(err));
    }
}

function markDbvUnavailable() {
    const msg = '<div class="pl-unavailable">Open this player from a tournament analysis once to link their ' +
        'DBV profile — then leagues, tournaments, titles, win/loss and upcoming tournaments appear here.</div>';
    ["winloss-body", "upcoming-body", "titles-body", "leagues-body", "tournaments-body",
        "network-teammates", "network-opponents"].forEach((id) => {
        $(id).innerHTML = msg;
    });
    $("p-wl-tiles").innerHTML = "";
}

/* ------------------------------------------------------------------ */
/* Identity + current BAX tiles                                       */
/* ------------------------------------------------------------------ */
function renderIdentity(id) {
    id = id || {};
    $("p-name").textContent = id.name || "Player";
    if (id.name) document.title = `${id.name} | BAX Checker`;
    const meta = [];
    if (id.club) meta.push(`<span>${escapeHtml(id.club)}</span>`);
    if (id.birth_year) meta.push(`<span>Jg ${id.birth_year}</span>`);
    if (id.sp_code) meta.push(`<code>${escapeHtml(id.sp_code)}</code>`);
    $("p-meta").innerHTML = meta.join("");
    const dbv = $("p-dbv");
    if (id.profile_id) {
        dbv.href = `https://dbv.turnier.de/player-profile/${id.profile_id}`;
        dbv.classList.remove("hidden");
    } else {
        dbv.classList.add("hidden");
    }
    // The graph needs a resolved dbv profile_id (same requirement as the
    // Matchups tab itself, which only loads when rpid is known) — hide it
    // rather than link to a page that can only error out.
    const graphLink = $("p-open-network-graph");
    if (graphLink) {
        if (id.profile_id) {
            const q = new URLSearchParams({ pid: id.profile_id });
            if (id.sp_code) q.set("sp", id.sp_code);
            if (id.name) q.set("name", id.name);
            graphLink.href = "/html/network.html?" + q.toString();
            graphLink.classList.remove("hidden");
        } else {
            graphLink.classList.add("hidden");
        }
    }
}

function renderBaxTiles(history) {
    const cls = { Einzel: "stat--einzel", Doppel: "stat--doppel", Mixed: "stat--mixed" };
    $("p-bax-tiles").innerHTML = CATS.map((c) => {
        const cur = (history[c] || [])[0];
        const val = cur && cur.bax != null ? cur.bax : "–";
        const sub = cur ? `${escapeHtml(cur.season)}${cur.erfolg ? " · " + escapeHtml(cur.erfolg) : ""}` : "no data";
        return `<div class="stat ${cls[c]}">
            <div class="stat__label">${DISC_LABEL[c]} BAX</div>
            <div class="stat__value">${val}</div>
            <div class="stat__sub">${sub}</div>
        </div>`;
    }).join("");
}

/* ------------------------------------------------------------------ */
/* BAX history — multi-line SVG chart + table                         */
/* ------------------------------------------------------------------ */
const seasonStart = (s) => parseInt((s || "").slice(0, 4), 10) || 0;

document.querySelectorAll("[data-hview]").forEach((btn) => {
    btn.addEventListener("click", () => {
        state.histView = btn.getAttribute("data-hview");
        document.querySelectorAll("[data-hview]").forEach((b) => b.classList.toggle("active", b === btn));
        renderHistory();
    });
});

function renderHistory() {
    const legend = $("hist-legend");
    legend.innerHTML = CATS.map((c) => {
        const off = state.histHidden.has(c) ? " off" : "";
        return `<span class="lg${off}" data-series="${c}"><span class="lg-sw" style="background:var(--disc-${c.toLowerCase()})"></span>${DISC_LABEL[c]}</span>`;
    }).join("");
    legend.querySelectorAll("[data-series]").forEach((el) => {
        el.addEventListener("click", () => {
            const c = el.getAttribute("data-series");
            if (state.histHidden.has(c)) state.histHidden.delete(c); else state.histHidden.add(c);
            renderHistory();
        });
    });
    if (state.histView === "table") renderHistoryTable();
    else renderHistoryChart();
}

// Redraws the history chart when its container's width actually changes —
// both real resizes (window resize / phone rotation) and the moment the
// "BAX history" tab is switched into view (it renders off-screen at 0 width
// while another tab is active, since display:none tabs report zero size).
let histResizeObserver = null, histLastW = 0;
function ensureHistResizeObserver() {
    const body = $("hist-body");
    if (histResizeObserver || !body || typeof ResizeObserver === "undefined") return;
    let raf = null;
    histResizeObserver = new ResizeObserver((entries) => {
        const w = Math.round(entries[0].contentRect.width);
        if (!w || w === histLastW) return;
        histLastW = w;
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { raf = null; if (state.histView === "chart") renderHistoryChart(); });
    });
    histResizeObserver.observe(body);
}
ensureHistResizeObserver();

function renderHistoryChart() {
    const body = $("hist-body");
    const h = state.history || {};
    const seasons = Array.from(new Set(CATS.flatMap((c) => (h[c] || []).map((r) => r.season))))
        .sort((a, b) => seasonStart(a) - seasonStart(b));
    const visible = CATS.filter((c) => !state.histHidden.has(c) && (h[c] || []).length);
    const points = visible.flatMap((c) => (h[c] || []).map((r) => r.bax).filter((v) => v != null));
    if (!seasons.length || !points.length) {
        body.innerHTML = '<div class="pl-empty">No BAX history to plot.</div>';
        return;
    }

    // The viewBox is sized to the container's real rendered width so the fixed
    // px font sizes below stay legible at any screen size (see chart-svg-wrap
    // CSS) instead of shrinking along with a fixed-900 canvas. Falls back to
    // 900 while the panel is still hidden (0 width) — the ResizeObserver above
    // redraws it for real the moment its tab becomes visible.
    const W = Math.max(280, Math.round(body.clientWidth) || 900), padL = 44, padR = 16, padT = 12, padB = 30;
    const plotW = W - padL - padR;
    const H = 320, plotH = H - padT - padB;
    const xs = seasons.length > 1 ? (i) => padL + (i / (seasons.length - 1)) * plotW : () => padL + plotW / 2;

    let lo = Math.min(...points), hi = Math.max(...points);
    const pad = Math.max(10, Math.round((hi - lo) * 0.15));
    lo = Math.floor((lo - pad) / 10) * 10; hi = Math.ceil((hi + pad) / 10) * 10;
    if (hi === lo) hi = lo + 10;
    const ys = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

    // Y gridlines + ticks.
    let grid = "";
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
        const v = lo + ((hi - lo) * i) / ticks;
        const y = ys(v);
        grid += `<line class="pl-grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>`;
        grid += `<text class="pl-axis" x="${padL - 8}" y="${y + 3}" text-anchor="end">${Math.round(v)}</text>`;
    }
    // X labels — shown at a stride that keeps them from crowding into each
    // other, however wide or narrow the chart actually is (a fixed "skip every
    // other" only worked for the old fixed-900 canvas).
    let xlabels = "";
    const longestLabel = Math.max(4, ...seasons.map((s) => String(s).length));
    const labelStride = Math.max(1, Math.ceil((seasons.length * (longestLabel * 6.2 + 10)) / plotW));
    seasons.forEach((s, i) => {
        if (labelStride > 1 && i % labelStride !== 0 && i !== seasons.length - 1) return;
        xlabels += `<text class="pl-axis" x="${xs(i)}" y="${H - 10}" text-anchor="middle">${escapeHtml(s)}</text>`;
    });

    let lines = "", dots = "";
    visible.forEach((c) => {
        const byS = new Map((h[c] || []).map((r) => [r.season, r]));
        const pts = seasons.map((s, i) => ({ s, i, r: byS.get(s) })).filter((p) => p.r && p.r.bax != null);
        if (pts.length > 1) {
            const d = pts.map((p) => `${xs(p.i)},${ys(p.r.bax)}`).join(" ");
            lines += `<polyline class="pl-line pl-line--${c.toLowerCase()}" points="${d}"/>`;
        }
        pts.forEach((p) => {
            const tip = `${DISC_LABEL[c]} · ${p.s}: BAX ${p.r.bax}${p.r.erfolg ? " · " + p.r.erfolg : ""}`;
            dots += `<circle class="pl-dot--${c.toLowerCase()}" cx="${xs(p.i)}" cy="${ys(p.r.bax)}" r="4" data-tip="${escapeHtml(tip)}"/>`;
        });
    });

    body.innerHTML = `
        <div class="chart-svg-wrap">
            <svg class="pl-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="BAX history">
                ${grid}${lines}${dots}${xlabels}
            </svg>
            <div class="chart-tooltip hidden"></div>
        </div>`;
    wireTooltip(body);
}

function renderHistoryTable() {
    const h = state.history || {};
    const seasons = Array.from(new Set(CATS.flatMap((c) => (h[c] || []).map((r) => r.season))))
        .sort((a, b) => seasonStart(b) - seasonStart(a)); // newest first
    if (!seasons.length) { $("hist-body").innerHTML = '<div class="pl-empty">No BAX history.</div>'; return; }
    const byCS = {};
    CATS.forEach((c) => { byCS[c] = new Map((h[c] || []).map((r) => [r.season, r])); });
    const rows = seasons.map((s) => {
        const cells = CATS.map((c) => {
            const r = byCS[c].get(s);
            if (!r) return `<td>–</td>`;
            return `<td><b>${r.bax != null ? r.bax : "–"}</b>${r.erfolg ? ` <span class="when">${escapeHtml(r.erfolg)}</span>` : ""}</td>`;
        }).join("");
        return `<tr><td class="name">${escapeHtml(s)}</td>${cells}</tr>`;
    }).join("");
    $("hist-body").innerHTML = `
        <div class="table-scroll"><table class="pl-table">
            <thead><tr><th>Season</th><th>Singles</th><th>Doubles</th><th>Mixed</th></tr></thead>
            <tbody>${rows}</tbody>
        </table></div>`;
}

/* ------------------------------------------------------------------ */
/* Relative standing — distribution histogram                         */
/* ------------------------------------------------------------------ */
document.querySelectorAll("#dist-scope [data-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
        state.distScope = btn.getAttribute("data-scope");
        document.querySelectorAll("#dist-scope [data-scope]").forEach((b) => b.classList.toggle("active", b === btn));
        renderDistribution();
    });
});
document.querySelectorAll("#dist-cat [data-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
        state.distCat = btn.getAttribute("data-cat");
        document.querySelectorAll("#dist-cat [data-cat]").forEach((b) => b.classList.toggle("active", b === btn));
        renderDistribution();
    });
});

let distResizeObserver = null, distLastW = 0;
function ensureDistResizeObserver() {
    const body = $("dist-body");
    if (distResizeObserver || !body || typeof ResizeObserver === "undefined") return;
    let raf = null;
    distResizeObserver = new ResizeObserver((entries) => {
        const w = Math.round(entries[0].contentRect.width);
        if (!w || w === distLastW) return;
        distLastW = w;
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { raf = null; renderDistribution(); });
    });
    distResizeObserver.observe(body);
}
ensureDistResizeObserver();

function renderDistribution() {
    const body = $("dist-body");
    const dist = state.distribution || {};
    const d = ((dist[state.distScope] || {})[state.distCat]) || null;
    if (!d || !d.buckets || !d.buckets.length) {
        body.innerHTML = '<div class="pl-empty">No distribution data for this selection.</div>';
        return;
    }
    const { buckets, freqs, player, total, scope, season } = d;
    const n = Math.min(buckets.length, freqs.length);
    const step = buckets.length > 1 ? (buckets[1] - buckets[0]) : 20;

    // See renderHistoryChart for why W tracks the container's real width.
    const W = Math.max(280, Math.round(body.clientWidth) || 900), padL = 40, padR = 12, padT = 12, padB = 28;
    const plotW = W - padL - padR, H = 300, plotH = H - padT - padB;
    const maxF = Math.max(1, ...freqs.slice(0, n));
    const slot = plotW / n, barW = Math.max(2, slot * 0.82);
    const x0 = (i) => padL + i * slot + (slot - barW) / 2;
    const y = (v) => padT + plotH - (v / maxF) * plotH;
    const baseline = padT + plotH;

    let grid = "";
    [0, 0.5, 1].forEach((f) => {
        const gy = baseline - f * plotH;
        grid += `<line class="pl-grid" x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}"/>`;
        grid += `<text class="pl-axis" x="${padL - 6}" y="${gy + 3}" text-anchor="end">${Math.round(maxF * f)}</text>`;
    });

    // Label stride: only every Nth bucket gets an x-axis number, N chosen so
    // labels (~4 digits wide) don't crowd into each other at the current slot
    // width (a fixed "every 3rd" only worked for the old fixed-900 canvas).
    const labelStride = Math.max(1, Math.ceil(34 / slot));
    let bars = "", xlabels = "";
    for (let i = 0; i < n; i++) {
        const b = buckets[i], f = freqs[i];
        const mine = player >= b && player < b + step;
        const yy = y(f);
        const tip = `BAX ${b}–${b + step - 1}: ${num(f)} player${f === 1 ? "" : "s"}`;
        bars += `<rect class="pl-bar${mine ? " pl-bar--me" : ""}" x="${x0(i)}" y="${yy}" width="${barW}" height="${baseline - yy}" rx="1.5" data-tip="${escapeHtml(tip)}"/>`;
        if (i % labelStride === 0 || i === n - 1) xlabels += `<text class="pl-axis" x="${x0(i) + barW / 2}" y="${H - 10}" text-anchor="middle">${b}</text>`;
    }
    // Player marker line.
    let marker = "";
    if (player != null && buckets.length) {
        const idx = Math.max(0, Math.min(n - 1, Math.round((player - buckets[0]) / step)));
        const mx = x0(idx) + barW / 2;
        marker = `<line class="pl-marker" x1="${mx}" y1="${padT}" x2="${mx}" y2="${baseline}"/>` +
            `<text class="pl-marker-label" x="${mx}" y="${padT + 10}" text-anchor="middle">You · ${player}</text>`;
    }

    body.innerHTML = `
        <div class="chart-svg-wrap">
            <svg class="pl-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="BAX distribution">
                ${grid}${bars}${marker}${xlabels}
            </svg>
            <div class="chart-tooltip hidden"></div>
        </div>
        <div class="dist-caption">
            Stronger than <b>${d.stronger_than_pct != null ? d.stronger_than_pct : "–"}%</b>
            of ${escapeHtml(scope || (state.distScope === "lv" ? "LV" : "DBV"))}
            ${DISC_LABEL[state.distCat]} players (${num(total)} total${season ? ", " + escapeHtml(season) : ""})
        </div>`;
    wireTooltip(body);
}

/* ------------------------------------------------------------------ */
/* dbv stats: win/loss + titles + tournaments                         */
/* ------------------------------------------------------------------ */
async function loadDbvStats(pid, name) {
    try {
        const res = await getPlayerDbvStats({ profile_id: pid, name: name || "" });
        if (res.data.error) throw new Error(res.data.error);
        renderWinLoss(res.data.win_loss || {});
        renderTitles(res.data.titles || []);
        renderTournaments(res.data.tournaments || []);
    } catch (err) {
        console.error("dbv stats failed:", err);
        const msg = `<div class="pl-empty">Could not load: ${escapeHtml(err.message)}</div>`;
        $("winloss-body").innerHTML = msg;
        $("titles-body").innerHTML = msg;
        $("tournaments-body").innerHTML = msg;
        $("p-wl-tiles").innerHTML = "";
    }
}

function wlCell(rec) {
    if (!rec) return "–";
    return `<span class="w">${rec.won}</span><span class="sep">–</span><span class="l">${rec.lost}</span>`;
}

function pct(rec) { return rec.pct != null ? rec.pct : (rec.total ? Math.round((rec.won / rec.total) * 100) : 0); }

function renderWinLoss(wl) {
    const t = wl.total || {};

    // Compact glance tiles in the right-aligned win/loss group of the header.
    const stats = $("p-wl-tiles");
    if (stats) {
        const statTile = (label, rec) => rec ? `<div class="stat stat--wl">
            <div class="stat__label">${label}</div>
            <div class="stat__value"><span class="w">${rec.won}</span><span class="sep">–</span><span class="l">${rec.lost}</span></div>
            <div class="stat__sub">${pct(rec)}% won · ${num(rec.total)} matches</div>
        </div>` : "";
        stats.innerHTML = (t.career || t.year) ? statTile("Career W–L", t.career) + statTile("Season W–L", t.year) : "";
    }

    // Full breakdown in the Win / Loss tab.
    const el = $("winloss-body");
    if (!t.career && !t.year) { el.innerHTML = '<div class="pl-empty">No win/loss data.</div>'; return; }
    const bigTile = (label, rec) => rec ? `<div class="wl">
            <div class="wl__label">${label}</div>
            <div class="wl__value"><span class="w">${rec.won}</span><span class="sep">–</span><span class="l">${rec.lost}</span></div>
            <div class="wl__bar"><span style="width:${pct(rec)}%"></span></div>
            <div class="wl__pct">${pct(rec)}% won · ${num(rec.total)} matches</div>
        </div>` : "";
    const rows = CATS.map((c) => {
        const r = wl[c] || {};
        return `<tr><td>${DISC_LABEL[c]}</td><td>${wlCell(r.career)}</td><td>${wlCell(r.year)}</td></tr>`;
    }).join("");
    el.innerHTML = `
        <div class="wl-grid">${bigTile("Career", t.career)}${bigTile("This year", t.year)}</div>
        <table class="wl-table">
            <thead><tr><th>Discipline</th><th>Career W–L</th><th>This year W–L</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

const PLACE_LABEL = { 1: "1.", 2: "2.", 3: "3." };
function renderTitles(titles) {
    const el = $("titles-body");
    if (!titles.length) { el.innerHTML = '<div class="pl-empty">No titles or finals recorded.</div>'; return; }
    const byYear = new Map();
    titles.forEach((t) => {
        const y = t.year || "—";
        if (!byYear.has(y)) byYear.set(y, []);
        byYear.get(y).push(t);
    });
    el.innerHTML = Array.from(byYear.entries()).map(([year, items]) => `
        <div class="titles-year">
            <div class="titles-year__label">${escapeHtml(year)}</div>
            ${items.map((t) => {
                const place = PLACE_LABEL[t.place] || (t.place ? `${t.place}.` : "");
                const rankCls = t.place >= 1 && t.place <= 3 ? ` title-item--rank-${t.place}` : "";
                const badge = place ? `<span class="title-item__place">${escapeHtml(place)}</span>` : "";
                return `<div class="title-item${rankCls}">
                <i data-lucide="trophy" class="title-item__icon" style="width:16px;height:16px;"></i>
                <span class="title-item__text" style="flex:1;">${escapeHtml(t.text)}</span>
                ${badge}
            </div>`;
            }).join("")}
        </div>`).join("");
    if (window.lucide) lucide.createIcons();
}

function renderTournaments(tours) {
    const el = $("tournaments-body");
    if (!tours.length) { el.innerHTML = '<div class="pl-empty">No tournaments listed.</div>'; return; }
    const rows = tours.map((t) => {
        const url = `https://dbv.turnier.de/sport/tournament?id=${t.id}`;
        const date = t.start ? (t.end && t.end !== t.start ? `${t.start} – ${t.end}` : t.start) : "";
        return `<tr>
            <td class="name"><a href="${url}" target="_blank" rel="noopener">${escapeHtml(t.name || "Tournament")}</a>
                ${t.location ? `<div class="when">${escapeHtml(t.location)}</div>` : ""}</td>
            <td class="when">${escapeHtml(date)}</td>
        </tr>`;
    }).join("");
    el.innerHTML = `<div class="table-scroll"><table class="pl-table">
        <thead><tr><th>Tournament</th><th>Date</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
}

/* ------------------------------------------------------------------ */
/* Upcoming registrations                                             */
/* ------------------------------------------------------------------ */
async function loadUpcoming(pid) {
    try {
        const res = await getPlayerUpcoming({ profile_id: pid });
        if (res.data.error) throw new Error(res.data.error);
        renderUpcoming(res.data.upcoming || []);
    } catch (err) {
        console.error("upcoming failed:", err);
        $("upcoming-body").innerHTML = `<div class="pl-empty">Could not load: ${escapeHtml(err.message)}</div>`;
    }
}

function fmtISO(iso) {
    if (!iso) return "";
    const p = iso.split("-");
    return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : iso;
}

// Translate a scraped German entry status to a short English label.
function statusLabel(status) {
    const s = String(status || "").trim();
    const m = s.match(/Nachr[üu]ckerliste\s*(\d+)/i);
    if (m) return `Reserve ${m[1]}`;
    if (/nachr[üu]cker/i.test(s)) return "Reserve";
    if (/warteliste/i.test(s)) return "Waiting list";
    if (/starterliste|starter/i.test(s)) return "Starter";
    return s;
}
function isWaitlisted(status) { return /nachr[üu]cker|warteliste/i.test(String(status || "")); }

function renderUpcoming(list) {
    const el = $("upcoming-body");
    if (!list.length) {
        el.innerHTML = '<div class="pl-empty">No tournaments yet discovered. This list fills in ' +
            'automatically as tournaments the player has entered are analysed on the site.</div>';
        return;
    }
    // Group by tournament so multiple disciplines collapse into one entry, each
    // carrying its own current status (starter / reserve / waiting list).
    const byT = new Map();
    list.forEach((r) => {
        const key = r.tournament_id || r.tournament_name;
        if (!byT.has(key)) byT.set(key, { ...r, disciplines: [] });
        if (r.discipline_name) byT.get(key).disciplines.push({ name: r.discipline_name, status: r.status, event: r.discipline_event });
    });
    el.innerHTML = `<div class="upcoming-list">` + Array.from(byT.values()).map((r) => {
        // Base query for our tournament page; adding &event deep-links a discipline.
        const baseQuery = () => {
            const q = new URLSearchParams({ id: r.tournament_id });
            if (r.tournament_name) q.set("name", r.tournament_name);
            return q;
        };
        // Each discipline badge jumps straight to that discipline's analysis
        // (the tournament page auto-runs the matching &event). Falls back to a
        // plain badge when we lack the tournament id or the discipline's event.
        const discs = r.disciplines.map((d) => {
            const wl = isWaitlisted(d.status);
            const cls = `disc-badge${wl ? " disc-badge--wait" : ""}`;
            const label = `${escapeHtml(d.name)}${wl ? ` · ${escapeHtml(statusLabel(d.status))}` : ""}`;
            if (r.tournament_id && d.event) {
                const q = baseQuery();
                q.set("event", d.event);
                return `<a class="${cls} disc-badge--link" href="/html/tournament.html?${escapeHtml(q.toString())}"` +
                    ` title="Jump to ${escapeHtml(d.name)}">${label}</a>`;
            }
            return `<span class="${cls}">${label}</span>`;
        }).join("");
        // Tournament name links to the tournament overview (all disciplines).
        const nameText = escapeHtml(r.tournament_name || "Tournament");
        const nameEl = r.tournament_id
            ? `<a class="upcoming-item__name" href="/html/tournament.html?${escapeHtml(baseQuery().toString())}">${nameText}</a>`
            : `<div class="upcoming-item__name">${nameText}</div>`;
        const main = `<div class="upcoming-item__main">
                ${nameEl}
                ${discs ? `<div class="upcoming-item__discs">${discs}</div>` : ""}
            </div>
            <div class="upcoming-item__date">${escapeHtml(fmtISO(r.start_date))}</div>`;
        // Secondary: a small link out to the entry on dbv.turnier.de.
        const dbvPart = r.tournament_url
            ? `<a class="upcoming-item__dbv" href="${escapeHtml(r.tournament_url)}" target="_blank" rel="noopener" title="Open on dbv.turnier.de"><i data-lucide="external-link"></i></a>`
            : "";
        return `<div class="upcoming-item"><div class="upcoming-item__link">${main}</div>${dbvPart}</div>`;
    }).join("") + `</div>`;
    if (window.lucide) lucide.createIcons();
}

/* ------------------------------------------------------------------ */
/* Network — teammates & opponents, tournaments + leagues              */
/* ------------------------------------------------------------------ */
const NETWORK_EMPTY_MSG = {
    teammates: "No shared teammates found in the last 3 years.",
    opponents: "No opponents found in the last 3 years.",
};

async function loadNetwork(pid, sp, name) {
    try {
        const res = await getPlayerNetwork({ profile_id: pid, sp_code: sp, name });
        if (res.data.error) throw new Error(res.data.error);
        state.network.teammates.list = res.data.teammates || [];
        state.network.opponents.list = res.data.opponents || [];
        renderNetworkColumn("teammates");
        renderNetworkColumn("opponents");
    } catch (err) {
        console.error("network failed:", err);
        const msg = `<div class="pl-empty">Could not load: ${escapeHtml(err.message)}</div>`;
        $("network-teammates").innerHTML = msg;
        $("network-opponents").innerHTML = msg;
    }
}

// A peer's own entry here never carries their dbv profile_id (network.py's
// aggregation only tracks sp_code, for whoever it happens to know) — so even
// when sp_code IS known, navigating with just `sp` can strand the page with
// no profile_id and the whole dbv-sourced half (leagues, matchups, upcoming,
// titles, standing) silently unavailable. Every peer click instead resolves
// on demand — same url-based lookup the Network graph's click-to-expand
// uses — and only falls back to sp-only (still gets BAX data) or an
// external dbv.turnier.de link if that genuinely can't find a profile.
function wireNetworkPeerResolve(container) {
    container.querySelectorAll("[data-resolve-name]").forEach((a) => {
        a.addEventListener("click", async (ev) => {
            ev.preventDefault();
            if (a.classList.contains("is-loading")) return;
            const name = a.dataset.resolveName, url = a.dataset.resolveUrl, spCode = a.dataset.resolveSp || "";
            a.classList.add("is-loading");
            a.insertAdjacentHTML("beforeend", ' <span class="spinner"></span>');
            try {
                const res = await getPlayerNetwork({ sp_code: spCode, profile_id: "", name, url: url || "" });
                const sp = (res.data && res.data.sp_code) || spCode;
                const pid = (res.data && !res.data.error) ? res.data.profile_id : "";
                if (!sp && !pid) throw new Error((res.data && res.data.error) || "Could not resolve this player.");
                const q = new URLSearchParams();
                if (sp) q.set("sp", sp);
                if (pid) q.set("pid", pid);
                if (name) q.set("name", name);
                location.href = "/html/player.html?" + q.toString();
            } catch (err) {
                console.warn("peer resolve failed, opening dbv page instead:", err.message);
                if (url) window.open(url, "_blank", "noopener");
                a.classList.remove("is-loading");
                const sp2 = a.querySelector(".spinner"); if (sp2) sp2.remove();
            }
        });
    });
}

function renderNetworkColumn(kind) {
    const el = $(`network-${kind}`);
    const col = state.network[kind];
    if (!col.list.length) { el.innerHTML = `<div class="pl-empty">${escapeHtml(NETWORK_EMPTY_MSG[kind])}</div>`; return; }

    const sorted = [...col.list].sort((a, b) => {
        const av = a[col.sort] == null ? -1 : a[col.sort];
        const bv = b[col.sort] == null ? -1 : b[col.sort];
        return col.dir === "asc" ? av - bv : bv - av;
    });
    const shown = sorted.slice(0, col.shown);

    const rows = shown.map((e) => {
        const nameHtml = (e.url || e.sp_code)
            ? `<a href="#" data-resolve-name="${escapeHtml(e.name)}" data-resolve-url="${escapeHtml(e.url || "")}" data-resolve-sp="${escapeHtml(e.sp_code || "")}">${escapeHtml(e.name)}</a>`
            : escapeHtml(e.name);
        const pills = Object.entries(e.disciplines || {}).filter(([, n]) => n > 0)
            .map(([k, n]) => `<span class="disc-pill" title="${escapeHtml(DISC_LABEL[k] || k)}">${k[0]}${n}</span>`).join("");
        const wrCls = e.winrate == null ? "" : e.winrate >= 50 ? "winrate--good" : "winrate--bad";
        const wrText = e.winrate == null ? "–" : `${e.winrate}%`;
        return `<tr>
            <td class="name">${nameHtml}${pills ? `<div class="disc-pills">${pills}</div>` : ""}</td>
            <td>${e.played}</td>
            <td class="when">${e.wins}-${e.losses}</td>
            <td class="winrate ${wrCls}">${wrText}</td>
        </tr>`;
    }).join("");

    const th = (field, label) => {
        if (!field) return `<th>${label}</th>`;
        const arrow = col.sort === field ? (col.dir === "asc" ? " ▲" : " ▼") : "";
        return `<th class="sortable${col.sort === field ? " is-sorted" : ""}" data-sort="${field}">${label}${arrow}</th>`;
    };
    const remaining = sorted.length - col.shown;
    const expandHtml = remaining > 0
        ? `<div class="network-expand"><button type="button" class="btn btn-secondary btn-sm" data-expand-toggle>` +
          `Show ${Math.min(NETWORK_PAGE_SIZE, remaining)} more</button></div>`
        : "";

    el.innerHTML = `<div class="table-scroll"><table class="pl-table">
        <thead><tr>${th(null, "Name")}${th("played", "Played")}${th(null, "W-L")}${th("winrate", "Win%")}</tr></thead>
        <tbody>${rows}</tbody>
    </table></div>${expandHtml}`;
    if (window.lucide) lucide.createIcons();
    wireNetworkPeerResolve(el);

    el.querySelectorAll("th.sortable").forEach((h) => {
        h.addEventListener("click", () => {
            const field = h.getAttribute("data-sort");
            col.dir = col.sort === field ? (col.dir === "asc" ? "desc" : "asc") : "desc";
            col.sort = field;
            col.shown = NETWORK_PAGE_SIZE;
            renderNetworkColumn(kind);
        });
    });
    const expandBtn = el.querySelector("[data-expand-toggle]");
    if (expandBtn) expandBtn.addEventListener("click", () => {
        col.shown += NETWORK_PAGE_SIZE;
        renderNetworkColumn(kind);
    });
}

/* ------------------------------------------------------------------ */
/* Leagues (reused render, ported from the tournament tool)           */
/* ------------------------------------------------------------------ */
async function loadLeagues(pid, name) {
    try {
        const res = await getPlayerLeagues({ profile_id: pid, name: name || "" });
        if (res.data.error) throw new Error(res.data.error);
        renderPlayerLeagues(res.data.seasons || [], pid);
    } catch (err) {
        console.error("leagues failed:", err);
        $("leagues-body").innerHTML = `<div class="pl-empty">Could not load: ${escapeHtml(err.message)}</div>`;
    }
}

function seasonLeagueUrl(profileId, season) {
    if (!profileId) return null;
    const y = /(\d{4})/.exec(season || "");
    const year = y ? parseInt(y[1], 10) + 1 : null;
    return `https://dbv.turnier.de/player-profile/${profileId}/leagues${year ? "/" + year : ""}`;
}

function formatRecordHtml(record) {
    if (!record) return "";
    const m = /(\d+)\s*-\s*(\d+)\s*\((\d+)\)/.exec(record);
    if (!m) return `<div class="league-record"><span class="league-record__wl">${escapeHtml(record)}</span></div>`;
    const [, w, l, t] = m;
    return `<div class="league-record">
                <span class="league-record__label">Win–Loss</span>
                <span class="league-record__wl">${w}<span class="wl-sep">–</span>${l}</span>
                <span class="league-record__total">${t} games</span>
            </div>`;
}

function renderPlayerLeagues(seasons, profileId) {
    const el = $("leagues-body");
    if (!seasons.length) { el.innerHTML = '<div class="pl-empty">No league history found.</div>'; return; }
    el.innerHTML = seasons.map((s) => {
        const rows = (s.leagues || []).map((lg) => {
            const divs = (lg.divisions || []).map((d) => {
                const tag = d.abbr ? `<span class="league-tag">${escapeHtml(d.abbr)}</span>` : "";
                const team = d.team ? `<span class="league-team">${escapeHtml(d.team)}</span>` : "";
                return `<div class="league-div-line">${tag}<span class="league-div">${escapeHtml(d.division || "League")}</span>${team}</div>`;
            }).join("");
            return `<div class="league-row"><div class="league-row__divisions">${divs}</div>${formatRecordHtml(lg.record)}</div>`;
        }).join("");
        const inner = `<div class="league-season__year">${escapeHtml(s.season || "")}</div>${rows}`;
        const url = seasonLeagueUrl(profileId, s.season);
        return url
            ? `<a class="league-season league-season--link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${inner}</a>`
            : `<div class="league-season">${inner}</div>`;
    }).join("");
}

/* ------------------------------------------------------------------ */
/* Shared SVG hover tooltip                                           */
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
