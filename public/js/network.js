// Network graph — a player's teammates & opponents, visualized, expandable
// by clicking anyone in it. URL: network.html[?sp=<code>&pid=<guid>&name=<name>].
// Reuses get_player_network (the same data behind the profile page's
// "Matchups" tab).
//
// Layout is a hand-rolled deterministic radial tree, not a physics
// simulation. The root's direct connections sit on one ring, grouped into
// club sectors; expanding someone adds their own connections one ring
// further out, fanned across an arc facing away from their parent. Every
// edge is a straight line between two rings at different angles from a
// shared origin, so nothing needs to physically settle — the layout is
// recomputed once per change and stays put. Two branches can still share a
// person (a cross-link, drawn as an extra edge to the existing node rather
// than a duplicate) — that's the one case that can still cross another edge,
// but it's rare and it's an honest depiction of a real shared connection.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions } from "./util/firebase.js";

const searchPlayers = httpsCallable(functions, "search_players", { timeout: 60000 });
const getPlayerNetwork = httpsCallable(functions, "get_player_network", { timeout: 120000 });
const getPlayerBax = httpsCallable(functions, "get_player_bax", { timeout: 120000 });

const $ = (id) => document.getElementById(id);
function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}
const SVGNS = "http://www.w3.org/2000/svg";
const el = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in (attrs || {})) n.setAttribute(k, attrs[k]);
    return n;
};

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
    $("network-svg").innerHTML = "";
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

/* ---------------- deterministic radial-tree layout -------------------------- */
function groupKeyOf(n) {
    if (state.groupByClub) return n.club || "Unknown club";
    if (n.teammatePlayed && n.opponentPlayed) return "Mixed";
    return n.teammatePlayed ? "Teammates" : "Opponents";
}

// Places every depth-1 node around the full circle (grouped into club
// sectors if enabled) and every deeper node in an arc facing away from its
// own parent, one ring further out. Radius depends only on depth — not on
// frequency — so busy nodes don't collapse in on the center (node size and
// edge thickness already encode frequency).
function layout(nodes, links, W, H) {
    const cx = W / 2, cy = H / 2;
    const ring = Math.min(W, H) * 0.16;
    const root = nodes.find((n) => n.isCenter);
    root.x = cx; root.y = cy; root.angle = -Math.PI / 2;

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const childrenOf = new Map();
    const placedChildIds = new Set();   // a node can have 2 links from the same parent (teammate + opponent) — only place it once
    links.forEach((l) => {
        const child = byId.get(l.targetId);
        if (child && child.parentId === l.parentId && !placedChildIds.has(child.id)) {
            if (!childrenOf.has(l.parentId)) childrenOf.set(l.parentId, []);
            childrenOf.get(l.parentId).push(child);
            placedChildIds.add(child.id);
        }
    });

    const sectors = [];   // only the root's own direct sectors (for the club dividers/labels)

    // Auto-placed kids get a fresh angle below; a manually-dragged kid keeps
    // its own x/y but still needs *an* angle so ITS children (if expanded)
    // fan out from the right direction — derive it from where it actually is.
    function placeChildren(parent) {
        const allKids = childrenOf.get(parent.id) || [];
        if (!allKids.length) return;
        const kids = allKids.filter((k) => manualPos.get(k.id) == null);
        allKids.forEach((k) => {
            const manual = manualPos.get(k.id);
            if (manual) { k.x = manual.x; k.y = manual.y; k.angle = Math.atan2(k.y - cy, k.x - cx); }
        });
        const r = ring * (parent.depth + 1);

        if (parent.isCenter) {
            const groups = new Map();
            kids.forEach((n) => {
                const k = groupKeyOf(n);
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k).push(n);
            });
            const order = Array.from(groups.keys()).sort((a, b) => {
                const ta = groups.get(a).reduce((s, n) => s + n.totalPlayed, 0);
                const tb = groups.get(b).reduce((s, n) => s + n.totalPlayed, 0);
                return tb - ta || a.localeCompare(b);
            });
            const GAP = order.length > 1 ? 0.08 : 0;
            const usable = Math.PI * 2 - GAP * order.length;
            let cursor = -Math.PI / 2;
            order.forEach((key) => {
                const members = groups.get(key).sort((a, b) => b.totalPlayed - a.totalPlayed);
                const span = Math.max(0.25, (members.length / kids.length) * usable);
                const start = cursor;
                members.forEach((n, i) => {
                    const t = members.length === 1 ? 0.5 : i / (members.length - 1);
                    n.angle = start + t * span;
                    n.x = cx + Math.cos(n.angle) * r;
                    n.y = cy + Math.sin(n.angle) * r;
                });
                sectors.push({ key, start, end: start + span, mid: start + span / 2, r });
                cursor = start + span + GAP;
            });
        } else {
            // Fan across an arc centered on the ray from this node's own
            // parent through it — i.e. keep growing outward, not folding back.
            const span = Math.min(Math.PI * 0.85, 0.5 + kids.length * 0.35);
            const sorted = kids.slice().sort((a, b) => b.totalPlayed - a.totalPlayed);
            sorted.forEach((n, i) => {
                const t = sorted.length === 1 ? 0.5 : i / (sorted.length - 1);
                n.angle = parent.angle - span / 2 + t * span;
                n.x = cx + Math.cos(n.angle) * r;
                n.y = cy + Math.sin(n.angle) * r;
            });
        }
        allKids.forEach((n) => placeChildren(n));
    }
    placeChildren(root);

    return { cx, cy, sectors };
}

/* ---------------- render ---------------------------------------------------- */
function nodeRadius(n) { return n.isCenter ? 24 : 9 + Math.min(14, Math.sqrt(n.totalPlayed || 1) * 3.5); }
function nodeColor(n) {
    if (n.isCenter) return "var(--accent)";
    if (n.teammatePlayed && n.opponentPlayed) return "var(--net-mixed)";
    return n.teammatePlayed ? "var(--net-teammate)" : "var(--net-opponent)";
}
function shortName(name) {
    const parts = (name || "").trim().split(/\s+/);
    if (parts.length < 2) return name || "";
    return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

function render() {
    if (!fetched.has("center")) return;
    const { nodes, links } = buildVisible();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    links.forEach((l) => { l.source = byId.get(l.parentId); l.target = byId.get(l.targetId); });

    $("ng-stats").innerHTML = `<div class="ns-label">People: ${nodes.length - 1} &middot; Connections: ${links.length}</div>`;

    const svg = $("network-svg");
    if (nodes.length <= 1) {
        $("network-empty").classList.remove("hidden");
        $("network-empty").textContent = "No matches for this filter yet.";
        svg.innerHTML = "";
        renderLegend();
        return;
    }
    $("network-empty").classList.add("hidden");
    renderLegend();

    const rect = svg.getBoundingClientRect();
    const W = Math.max(320, Math.round(rect.width) || 900), H = Math.max(420, Math.round(rect.height) || 640);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const { sectors } = layout(nodes, links, W, H);

    svg.innerHTML = "";
    const sectorLayer = el("g", { class: "ng-sectors" });
    const linkLayer = el("g", { class: "ng-links" });
    const labelLayer = el("g", { class: "ng-edge-labels" });
    const nodeLayer = el("g", { class: "ng-nodes" });
    svg.append(sectorLayer, linkLayer, labelLayer, nodeLayer);

    if (sectors.length > 1) {
        const root = byId.get("center");
        sectors.forEach((s) => {
            const x1 = root.x + Math.cos(s.start) * (s.r + 26), y1 = root.y + Math.sin(s.start) * (s.r + 26);
            sectorLayer.appendChild(el("line", { class: "ng-sector-line", x1: root.x, y1: root.y, x2: x1, y2: y1 }));
            const lx = root.x + Math.cos(s.mid) * (s.r + 30), ly = root.y + Math.sin(s.mid) * (s.r + 30);
            const t = el("text", {
                class: "ng-sector-label", x: lx, y: ly,
                "text-anchor": Math.cos(s.mid) > 0.15 ? "start" : Math.cos(s.mid) < -0.15 ? "end" : "middle",
            });
            t.textContent = s.key;
            sectorLayer.appendChild(t);
        });
    }

    const linkEls = links.map((l) => {
        const line = el("line", {
            class: `ng-link ng-link--${l.kind}`,
            "stroke-width": 1 + Math.min(6, Math.sqrt(l.played) * 1.6),
            x1: l.source.x, y1: l.source.y, x2: l.target.x, y2: l.target.y,
        });
        line.addEventListener("pointerenter", (e) => showTooltip(e, linkTooltip(l)));
        line.addEventListener("pointermove", moveTooltip);
        line.addEventListener("pointerleave", hideTooltip);
        linkLayer.appendChild(line);

        const mx = (l.source.x + l.target.x) / 2, my = (l.source.y + l.target.y) / 2;
        const label = el("text", { class: `ng-edge-label ng-edge-label--${l.kind}`, x: mx, y: my });
        label.textContent = l.played;
        labelLayer.appendChild(label);

        return { data: l, line, label };
    });
    // Two labels landing on the same spot (e.g. a teammate+opponent pair, or
    // a cross-link doubling up) — nudge the later one apart.
    const seenMid = new Map();
    linkEls.forEach(({ data, label }) => {
        const key = data.parentId + ">" + data.targetId;
        const n = (seenMid.get(key) || 0);
        seenMid.set(key, n + 1);
        if (n > 0) label.setAttribute("dy", 12 * n);
    });

    nodes.forEach((n) => {
        const g = el("g", { class: "ng-node" + (n.isCenter ? " ng-node--center" : "") + (n.expanding ? " ng-node--busy" : ""), transform: `translate(${n.x},${n.y})` });
        const r = nodeRadius(n);
        g.appendChild(el("circle", { r, fill: nodeColor(n) }));
        if (!n.isCenter && n.expanded) g.appendChild(el("circle", { class: "ng-node__ring", r: r + 3.5 }));
        const label = el("text", { class: "ng-node__label", y: r + 13 });
        label.textContent = n.isCenter ? n.name : shortName(n.name);
        g.appendChild(label);
        nodeLayer.appendChild(g);
        wireNodeInteractions(g, n, linkEls);
    });
}

/* ---------------- node interactions: drag + click(=expand) + hover -------- */
function wireNodeInteractions(g, n, linkEls) {
    if (n.isCenter) {
        g.addEventListener("pointerenter", (e) => showTooltip(e, nodeTooltip(n)));
        g.addEventListener("pointermove", moveTooltip);
        g.addEventListener("pointerleave", hideTooltip);
        return;
    }
    const svg = $("network-svg");
    const toSvgPoint = (e) => {
        const pt = svg.createSVGPoint();
        pt.x = e.clientX; pt.y = e.clientY;
        const m = svg.getScreenCTM();
        return m ? pt.matrixTransform(m.inverse()) : { x: n.x, y: n.y };
    };
    const myLinks = linkEls.filter((l) => l.data.targetId === n.id);

    let moved = false, downAt = null;
    g.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        moved = false;
        downAt = toSvgPoint(e);
        g.setPointerCapture(e.pointerId);

        const onMove = (ev) => {
            const p = toSvgPoint(ev);
            if (Math.abs(p.x - downAt.x) > 3 || Math.abs(p.y - downAt.y) > 3) moved = true;
            n.x = p.x; n.y = p.y;
            manualPos.set(n.id, { x: p.x, y: p.y });
            g.setAttribute("transform", `translate(${n.x},${n.y})`);
            myLinks.forEach(({ line, label }) => {
                line.setAttribute("x2", n.x); line.setAttribute("y2", n.y);
                label.setAttribute("x", (line.x1.baseVal.value + n.x) / 2);
                label.setAttribute("y", (line.y1.baseVal.value + n.y) / 2);
            });
        };
        const onUp = () => {
            g.removeEventListener("pointermove", onMove);
            g.removeEventListener("pointerup", onUp);
            if (!moved) onNodeClick(n);
        };
        g.addEventListener("pointermove", onMove);
        g.addEventListener("pointerup", onUp);
    });

    g.addEventListener("pointerenter", (e) => showTooltip(e, nodeTooltip(n)));
    g.addEventListener("pointermove", moveTooltip);
    g.addEventListener("pointerleave", hideTooltip);
}

// Click = select this player and expand their own 1-hop neighborhood into
// the graph (per-click, not a toggle — already-expanded people just re-open
// their profile on a second click since there's nothing more to add).
async function onNodeClick(n) {
    if (n.isCenter || n.expanding) return;
    if (n.expanded) { goToPlayer(n); return; }
    if (!n.sp_code) {
        if (n.url) window.open(n.url, "_blank", "noopener");
        return;
    }
    n.expanding = true;
    render();
    try {
        const res = await getPlayerNetwork({ sp_code: n.sp_code, profile_id: n.profile_id || "", name: n.name });
        if (res.data.error) throw new Error(res.data.error);
        fetched.set(n.id, {
            profile_id: res.data.profile_id,
            teammates: res.data.teammates || [],
            opponents: res.data.opponents || [],
        });
        expansionOrder.push(n.id);
    } catch (err) {
        console.error("expand failed:", err);
        hideTooltip();
        showTooltip({ clientX: 0, clientY: 0 }, `Couldn't expand: ${escapeHtml(err.message)}`);
        setTimeout(hideTooltip, 3000);
    } finally {
        n.expanding = false;
        render();
    }
}

function goToPlayer(n) {
    if (n.isCenter) return;
    if (n.sp_code) {
        const q = new URLSearchParams({ sp: n.sp_code });
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
