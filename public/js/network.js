// Network graph — a player's teammates & opponents, visualized, expandable
// by clicking anyone in it. URL: network.html[?sp=<code>&pid=<guid>&name=<name>].
// Reuses get_player_network (the same data behind the profile page's
// "Matchups" tab).
//
// Rendered with Cytoscape.js (canvas-based graph library) rather than
// hand-rolled SVG — it gives us proper zoom/pan, drag, and a breadthfirst
// layout that natively avoids node overlap and keeps a branch's whole
// subtree nested near its parent instead of free-floating.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions } from "./util/firebase.js";
import cytoscape from "https://esm.sh/cytoscape@3.30.2";

const searchPlayers = httpsCallable(functions, "search_players", { timeout: 60000 });
const getPlayerNetwork = httpsCallable(functions, "get_player_network", { timeout: 120000 });
const getPlayerBax = httpsCallable(functions, "get_player_bax", { timeout: 120000 });

const $ = (id) => document.getElementById(id);
function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

const params = new URLSearchParams(location.search);
const initial = { sp: (params.get("sp") || "").trim(), pid: (params.get("pid") || "").trim(), name: (params.get("name") || "").trim() };

const yearEl = $("copyright-year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

const state = { showTeammates: true, showOpponents: false, groupByClub: true, topPct: 20 };
// Raw fetched data per expanded node, id -> {teammates, opponents}. "center"
// is always the root. Persists across filter/toggle changes so those never
// need to re-fetch; only reset on a brand new player load.
let fetched = new Map();
let expansionOrder = [];     // ids in the order they were successfully expanded (root implicit first)
let manualPos = new Map();   // node id -> {x,y}, for dragged nodes

let cy = null;                        // the Cytoscape instance, created once and reused
let nodeById = new Map();             // latest render()'s plain node-data objects, for event handlers
let edgeById = new Map();             // ditto for links

if (initial.sp || initial.pid) {
    showGraphView();
    loadNetwork(initial);
} else {
    showSearchView();
}

/* ---------------- search view (same pattern as player.html) -------------- */
$("search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("search-q").value.trim();
    if (q.length < 2) return;
    runSearch(q);
});

function showSearchView() {
    $("graph-view").classList.add("hidden");
    $("error-view").classList.add("hidden");
    $("search-view").classList.remove("hidden");
    const ph = $("page-header"); if (ph) ph.classList.remove("hidden");
}
function showGraphView() {
    $("search-view").classList.add("hidden");
    $("error-view").classList.add("hidden");
    $("graph-view").classList.remove("hidden");
    const ph = $("page-header"); if (ph) ph.classList.add("hidden");
}

async function runSearch(q) {
    const st = $("search-status");
    const box = $("search-results");
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
        return `<a class="search-result" href="/html/network.html?${qp.toString()}">
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

$("ng-change-player").addEventListener("click", () => {
    history.replaceState(null, "", location.pathname);
    document.title = "Network | BAX Checker";
    showSearchView();
});

/* ---------------- load -------------------------------------------------- */
async function loadNetwork({ sp, pid, name }) {
    $("network-loader").classList.remove("hidden");
    $("network-empty").classList.add("hidden");
    if (cy) cy.elements().remove();
    fetched = new Map();
    expansionOrder = [];
    manualPos = new Map();
    try {
        const [netRes, idRes] = await Promise.all([
            getPlayerNetwork({ sp_code: sp, profile_id: pid, name }),
            // Best-effort: only used for the center node's club (falls back to
            // "Unknown club" if this fails or there's nothing to look up).
            (sp || name) ? getPlayerBax({ sp_code: sp, profile_id: pid, name }).catch(() => null) : Promise.resolve(null),
        ]);
        if (netRes.data.error) throw new Error(netRes.data.error);
        const identity = (idRes && idRes.data && !idRes.data.error) ? idRes.data.identity : null;
        fetched.set("center", {
            name: (identity && identity.name) || name || "Player",
            club: identity && identity.club,
            sp_code: (identity && identity.sp_code) || sp || null,
            profile_id: (identity && identity.profile_id) || netRes.data.profile_id || pid || null,
            teammates: netRes.data.teammates || [],
            opponents: netRes.data.opponents || [],
        });
        updateUrlAndHeader();
        render();
    } catch (err) {
        console.error("network load failed:", err);
        $("network-empty").classList.remove("hidden");
        $("network-empty").textContent = "Could not load this network: " + err.message;
    } finally {
        $("network-loader").classList.add("hidden");
    }
}

function updateUrlAndHeader() {
    const center = fetched.get("center");
    const q = new URLSearchParams();
    if (center.sp_code) q.set("sp", center.sp_code);
    if (center.profile_id) q.set("pid", center.profile_id);
    if (center.name) q.set("name", center.name);
    history.replaceState(null, "", location.pathname + "?" + q.toString());
    document.title = `${center.name} — Network | BAX Checker`;
    $("ng-center-name").textContent = center.name;
    $("ng-open-profile").href = "/html/player.html?" + q.toString();
}

/* ---------------- sidebar interactions ------------------------------------ */
function toggleBtn(id, key) {
    $(id).addEventListener("click", () => {
        state[key] = !state[key];
        $(id).classList.toggle("is-active", state[key]);
        $(id).setAttribute("aria-pressed", String(state[key]));
        render();
    });
}
toggleBtn("ng-toggle-teammates", "showTeammates");
toggleBtn("ng-toggle-opponents", "showOpponents");
$("ng-group-club").addEventListener("change", (e) => { state.groupByClub = e.target.checked; render(); });
$("ng-top-pct").addEventListener("input", (e) => {
    state.topPct = parseInt(e.target.value, 10) || 100;
    $("ng-pct-val").textContent = state.topPct;
    render();
});
let resizeTimer = null;
window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (fetched.has("center")) { manualPos = new Map(); render(); } }, 200);
});

/* ---------------- data -> visible nodes/edges ------------------------------ */
function topPctFilter(list) {
    const played = (list || []).filter((p) => p.played > 0);
    if (!played.length) return [];
    const sorted = [...played].sort((a, b) => b.played - a.played);
    const keep = state.topPct >= 100 ? sorted.length : Math.max(1, Math.ceil(sorted.length * state.topPct / 100));
    return sorted.slice(0, keep);
}

// Walks `fetched` breadth-first from the root, applying the current filters,
// deduping anyone already placed (adding a cross-link instead of a second
// node). This rebuilds the whole visible graph on every filter change, but
// only from already-fetched data — no network calls here.
function buildVisible() {
    const centerRaw = fetched.get("center");
    const nodes = new Map();
    const links = [];
    const root = { id: "center", name: centerRaw.name, club: centerRaw.club, sp_code: centerRaw.sp_code,
                    profile_id: centerRaw.profile_id, isCenter: true, depth: 0, parentId: null,
                    totalPlayed: 0, teammatePlayed: 0, opponentPlayed: 0, expanded: true, expanding: false };
    nodes.set("center", root);
    if (root.sp_code) nodes.set(root.sp_code, root);   // alias so peers referencing the root by sp_code dedupe onto it

    const seenPairs = new Set();   // "idA|idB|kind" (sorted) — one edge per real-world relationship, even if it's recorded from both sides
    const queue = ["center", ...expansionOrder.filter((id) => fetched.has(id))];
    queue.forEach((parentId) => {
        const parent = nodes.get(parentId);
        const raw = fetched.get(parentId);
        if (!parent || !raw) return;
        parent.expanded = true;

        const addPeers = (list, kind) => {
            topPctFilter(list).forEach((p) => {
                const existing = nodes.get(p.key);
                if (existing) {
                    if (existing.id === parent.id) return;
                    // A cross-link can come back the other way too — this
                    // same pair already expanded from the far side and
                    // recorded the identical relationship in reverse (it's
                    // one shared history, counted from both people's own
                    // data). Keep the first one, skip the mirror.
                    const pairKey = [parent.id, existing.id].sort().join("|") + "|" + kind;
                    if (seenPairs.has(pairKey)) return;
                    seenPairs.add(pairKey);
                    links.push({ id: `${parent.id}>${kind}:${p.key}`, parentId: parent.id, targetId: existing.id, kind, played: p.played, winrate: p.winrate });
                    return;
                }
                const node = {
                    id: p.key, name: p.name, club: p.club, sp_code: p.sp_code, url: p.url,
                    depth: parent.depth + 1, parentId: parent.id,
                    totalPlayed: 0, teammatePlayed: 0, opponentPlayed: 0,
                    expanded: expansionOrder.includes(p.key), expanding: false,
                };
                nodes.set(p.key, node);
                seenPairs.add([parent.id, p.key].sort().join("|") + "|" + kind);
                links.push({ id: `${parent.id}>${kind}:${p.key}`, parentId: parent.id, targetId: p.key, kind, played: p.played, winrate: p.winrate });
            });
        };
        if (state.showTeammates) addPeers(raw.teammates, "teammate");
        if (state.showOpponents) addPeers(raw.opponents, "opponent");
    });

    // Aggregate per-node totals from whichever links actually reached them
    // (a node can be linked from more than one parent via a cross-link).
    links.forEach((l) => {
        const n = nodes.get(l.targetId);
        if (!n || n.isCenter) return;
        n.totalPlayed += l.played;
        n[l.kind === "teammate" ? "teammatePlayed" : "opponentPlayed"] += l.played;
    });

    return { nodes: Array.from(new Set(nodes.values())), links };
}

/* ---------------- Cytoscape rendering ----------------------------------------
 * Node/edge visuals are just data + a stylesheet; Cytoscape's own
 * breadthfirst layout (radiating out from the root, one ring per hop,
 * avoidOverlap on) does the positioning instead of a hand-rolled layout, so
 * it can't produce the branch-crossing/node-overlap layouts the old SVG
 * renderer sometimes did. ---------------------------------------------------- */
function nodeRadius(n) { return n.isCenter ? 24 : 9 + Math.min(14, Math.sqrt(n.totalPlayed || 1) * 3.5); }
function nodeKind(n) {
    if (n.isCenter) return "center";
    if (n.teammatePlayed && n.opponentPlayed) return "mixed";
    return n.teammatePlayed ? "teammate" : "opponent";
}
function shortName(name) {
    const parts = (name || "").trim().split(/\s+/);
    if (parts.length < 2) return name || "";
    return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

// Resolved colours read live from the CSS tokens in network.css, so the
// graph follows the light/dark toggle instead of baking in one theme.
function cssVar(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
function palette() {
    return {
        accent: cssVar("--accent", "#0f766e"), accentInk: cssVar("--accent-ink", "#0f766e"),
        ink: cssVar("--ink", "#1a1a1a"), inkFaint: cssVar("--ink-faint", "#94a3b8"),
        card: cssVar("--card", "#fff"), border: cssVar("--border", "#e2e8f0"),
        teammate: cssVar("--net-teammate", "#1baf7a"), opponent: cssVar("--net-opponent", "#c9971f"),
        mixed: cssVar("--net-mixed", "#8b5cf6"),
    };
}

function buildStyle() {
    const c = palette();
    const FONT = "Inter, sans-serif";
    return [
        { selector: "node[kind]", style: {
            "width": "data(size)", "height": "data(size)",
            "background-color": c.teammate,
            "border-width": 2.5, "border-color": c.card,
            "label": "data(label)", "color": c.ink, "font-family": FONT,
            "font-size": 11, "font-weight": 600,
            "text-valign": "bottom", "text-margin-y": 6,
            "text-outline-width": 3, "text-outline-color": c.card, "text-outline-opacity": 1,
        } },
        { selector: 'node[kind="opponent"]', style: { "background-color": c.opponent } },
        { selector: 'node[kind="mixed"]', style: { "background-color": c.mixed } },
        { selector: 'node[kind="center"]', style: {
            "background-color": c.accent, "border-color": c.accentInk, "border-width": 3,
            "font-weight": 800, "font-size": 12,
        } },
        { selector: "node.expanded", style: { "border-width": 3.5, "border-style": "dashed", "border-color": c.inkFaint } },
        { selector: "node.busy", style: { "opacity": 0.5 } },
        { selector: "node.hover", style: { "overlay-color": c.ink, "overlay-opacity": 0.1, "overlay-padding": 4 } },
        { selector: "edge", style: {
            "width": "data(width)", "line-color": c.teammate, "target-arrow-shape": "none",
            "curve-style": "bezier", "opacity": 0.55,
            "label": "data(label)", "font-size": 9, "font-family": FONT, "font-weight": 700, "color": c.teammate,
            "text-background-color": c.card, "text-background-opacity": 1, "text-background-padding": 2,
        } },
        { selector: 'edge[kind="opponent"]', style: { "line-color": c.opponent, "color": c.opponent } },
        { selector: "edge.hover", style: { "opacity": 1 } },
    ];
}

// "Group by club" clusters the root's direct connections by club, ordering
// them adjacently so breadthfirst's angular placement puts club-mates next
// to each other. (Cytoscape compound-node boxes were tried here first, but
// breadthfirst doesn't lay out compound children close enough together to
// keep the box tight — it ends up spanning far enough to swallow unrelated
// nodes in between, which looked worse than no grouping at all. A per-club
// cluster without a drawn boundary is the reliable middle ground; the club
// is still one hover away in the tooltip.)
function buildElements(nodes, links) {
    const grouping = state.groupByClub;
    const els = [];

    const ordered = grouping
        ? nodes.filter((n) => n.depth !== 1).concat(
            nodes.filter((n) => n.depth === 1).sort((a, b) => (a.club || "Unknown club").localeCompare(b.club || "Unknown club")))
        : nodes;

    ordered.forEach((n) => {
        const data = { id: n.id, label: n.isCenter ? n.name : shortName(n.name), size: nodeRadius(n) * 2, kind: nodeKind(n) };
        const classes = [];
        if (n.expanded && !n.isCenter) classes.push("expanded");
        if (n.expanding) classes.push("busy");
        const ele = { group: "nodes", data, classes: classes.join(" ") };
        const manual = manualPos.get(n.id);
        if (manual) { ele.position = { x: manual.x, y: manual.y }; ele.locked = true; }
        els.push(ele);
    });

    links.forEach((l) => {
        els.push({ group: "edges", data: {
            id: l.id, source: l.parentId, target: l.targetId, kind: l.kind,
            width: 1 + Math.min(6, Math.sqrt(l.played) * 1.6), label: String(l.played),
        } });
    });
    return els;
}

// Created once; every render() after that just swaps its elements and
// re-runs layout. All node/edge interaction is wired here rather than
// per-element, since Cytoscape dispatches events by selector.
function ensureCy() {
    if (cy) return cy;
    cy = cytoscape({
        container: $("network-svg"),
        style: buildStyle(),
        elements: [],
        minZoom: 0.1,
        maxZoom: 3,
        boxSelectionEnabled: false,
    });

    cy.on("tap", "node", (evt) => onNodeClick(nodeById.get(evt.target.id()), evt.originalEvent));
    cy.on("mouseover", "node", (evt) => {
        evt.target.addClass("hover");
        showTooltip(evt.originalEvent, nodeTooltip(nodeById.get(evt.target.id())));
    });
    cy.on("mouseout", "node", (evt) => { evt.target.removeClass("hover"); hideTooltip(); });
    cy.on("mousemove", "node", (evt) => moveTooltip(evt.originalEvent));

    cy.on("mouseover", "edge", (evt) => {
        evt.target.addClass("hover");
        showTooltip(evt.originalEvent, linkTooltip(edgeById.get(evt.target.id())));
    });
    cy.on("mouseout", "edge", (evt) => { evt.target.removeClass("hover"); hideTooltip(); });
    cy.on("mousemove", "edge", (evt) => moveTooltip(evt.originalEvent));

    // Persist a drag so the next render() (a filter toggle, an expand
    // elsewhere) keeps this node right where it was left.
    cy.on("dragfree", "node", (evt) => {
        const p = evt.target.position();
        manualPos.set(evt.target.id(), { x: p.x, y: p.y });
    });
    return cy;
}

function render() {
    if (!fetched.has("center")) return;
    const { nodes, links } = buildVisible();
    nodeById = new Map(nodes.map((n) => [n.id, n]));
    edgeById = new Map(links.map((l) => [l.id, l]));

    $("ng-stats").innerHTML = `<div class="ns-label">People: ${nodes.length - 1} &middot; Connections: ${links.length}</div>`;

    if (nodes.length <= 1) {
        $("network-empty").classList.remove("hidden");
        $("network-empty").textContent = "No matches for this filter yet.";
        if (cy) cy.elements().remove();
        renderLegend();
        return;
    }
    $("network-empty").classList.add("hidden");
    renderLegend();

    const instance = ensureCy();
    instance.resize();
    instance.style(buildStyle());
    instance.elements().remove();
    instance.add(buildElements(nodes, links));
    instance.layout({
        name: "breadthfirst",
        roots: "#center",
        circle: true,
        avoidOverlap: true,
        spacingFactor: 1.35,
        animate: false,
        fit: true,
        padding: 36,
    }).run();
}

// Redraw with fresh colours whenever the light/dark toggle flips — the
// stylesheet bakes in resolved colours rather than living CSS var()
// references, since Cytoscape draws to a <canvas>.
new MutationObserver(() => { if (cy) cy.style(buildStyle()); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

// Click = select this player and expand their own 1-hop neighborhood into
// the graph (per-click, not a toggle — already-expanded people just re-open
// their profile on a second click since there's nothing more to add).
async function onNodeClick(n, e) {
    if (n.isCenter || n.expanding) return;
    if (n.expanded) { goToPlayer(n); return; }
    if (!n.sp_code) {
        if (n.url) window.open(n.url, "_blank", "noopener");
        return;
    }
    n.expanding = true;
    render();
    try {
        const res = await getPlayerNetwork({ sp_code: n.sp_code, profile_id: n.profile_id || "", name: n.name, url: n.url || "" });
        if (res.data.error) throw new Error(res.data.error);
        fetched.set(n.id, {
            profile_id: res.data.profile_id,
            teammates: res.data.teammates || [],
            opponents: res.data.opponents || [],
        });
        expansionOrder.push(n.id);
    } catch (err) {
        console.warn("expand failed, falling back:", err.message);
        // get_player_network already tries to analyse an unresolved peer on
        // our behalf (via the url we just sent it, tournament- or
        // league-scoped) before giving up, so a failure here means that
        // didn't work either — someone with no real dbv profile at all (a
        // guest/foreign entrant), or no url in the first place. Not a real
        // failure on our end; fall back to their external dbv link when we
        // have one instead of just showing an error.
        hideTooltip();
        if (n.url) {
            window.open(n.url, "_blank", "noopener");
            if (e) showTooltip(e, "No graph preview for them yet — opened their dbv page instead.");
        } else if (e) {
            showTooltip(e, `Couldn't expand: ${escapeHtml(err.message)}`);
        }
        if (e) setTimeout(hideTooltip, 3000);
    } finally {
        n.expanding = false;
        render();
    }
}

function goToPlayer(n) {
    if (n.isCenter) return;
    if (n.sp_code) {
        const q = new URLSearchParams({ sp: n.sp_code });
        // Reaching here means this node's own expand already succeeded (see
        // onNodeClick), so their profile_id was already resolved — it just
        // lives in `fetched`, not on the per-render node object. Carry it
        // along so the player page doesn't have to re-resolve it (or worse,
        // land with sp only and show "no dbv profile linked" until it does).
        const raw = fetched.get(n.id);
        if (raw && raw.profile_id) q.set("pid", raw.profile_id);
        if (n.name) q.set("name", n.name);
        location.href = "/html/player.html?" + q.toString();
    } else if (n.url) {
        window.open(n.url, "_blank", "noopener");
    }
}

/* ---------------- tooltip -------------------------------------------------- */
function showTooltip(e, html) {
    const tip = $("ng-tooltip");
    tip.innerHTML = html;
    tip.classList.remove("hidden");
    if (e.clientX || e.clientY) moveTooltip(e);
}
function moveTooltip(e) {
    const tip = $("ng-tooltip");
    const box = $("network-svg").closest(".network-canvas-wrap").getBoundingClientRect();
    tip.style.left = (e.clientX - box.left + 12) + "px";
    tip.style.top = (e.clientY - box.top + 12) + "px";
}
function hideTooltip() { $("ng-tooltip").classList.add("hidden"); }

function nodeTooltip(n) {
    if (n.isCenter) return `<b>${escapeHtml(n.name)}</b>`;
    const club = n.club ? escapeHtml(n.club) : "Unknown club";
    const kind = n.teammatePlayed && n.opponentPlayed ? "teammate &amp; opponent" : n.teammatePlayed ? "teammate" : "opponent";
    const action = n.expanding ? "loading…" : n.expanded ? "click to open profile" : "click to expand their network";
    return `<b>${escapeHtml(n.name)}</b><br>${club} &middot; ${kind} &middot; ${n.totalPlayed} match${n.totalPlayed === 1 ? "" : "es"}<br><span style="opacity:0.7">${action}</span>`;
}
function linkTooltip(l) {
    const kind = l.kind === "teammate" ? "Played with" : "Played against";
    const wr = l.winrate == null ? "" : ` &middot; ${l.winrate}% win rate`;
    return `${kind} &middot; ${l.played} match${l.played === 1 ? "" : "es"}${wr}`;
}

/* ---------------- legend --------------------------------------------------- */
function renderLegend() {
    const rows = [
        `<div class="ns-legend-row"><span class="ns-swatch" style="background:var(--net-teammate)"></span>Teammate</div>`,
        `<div class="ns-legend-row"><span class="ns-swatch" style="background:var(--net-opponent)"></span>Opponent</div>`,
        `<div class="ns-legend-row"><span class="ns-swatch" style="background:var(--net-mixed)"></span>Both</div>`,
    ];
    $("ng-legend").innerHTML = `<div class="ns-label">Node colour</div>${rows.join("")}` +
        `<div class="ns-label" style="margin-top:0.6rem;">Click anyone to expand their own network. Each ring out is one more hop.</div>`;
}
