// Admin usage dashboard. Requires Google sign-in; the backend callable
// (get_usage_stats) enforces the admin allow-list, so a non-admin just gets a
// PERMISSION_DENIED which we render as "access denied". Client gating here is
// only UX — the real gate is server-side.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { functions, auth } from "./util/firebase.js";

const getUsageStats = httpsCallable(functions, "get_usage_stats", { timeout: 60000 });

const gateSignin = document.getElementById("gate-signin");
const gateDenied = document.getElementById("gate-denied");
const gateLoading = document.getElementById("gate-loading");
const dashboard = document.getElementById("dashboard");

function show(el) {
    [gateSignin, gateDenied, gateLoading, dashboard].forEach((n) => {
        if (n) n.classList.toggle("hidden", n !== el);
    });
}

// The summary counters we surface, in display order. Each has *_total /
// *_authed / *_anon keys on usage/summary.
const SUMMARY_METRICS = [
    { key: "analyses", label: "Analyses run" },
    { key: "urlAnalyses", label: "…from pasted URL" },
    { key: "browseAnalyses", label: "…from browse" },
    { key: "browseSearches", label: "Tournament searches" },
    { key: "tournamentQueries", label: "Tournament opens" },
    { key: "disciplineQueries", label: "Discipline queries" },
    { key: "playerQueries", label: "Player lookups" },
];

function num(n) {
    return (n == null ? 0 : n).toLocaleString();
}

function fmtDate(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    const date = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    // The time sits in its own inline span so mobile CSS can drop it onto a
    // second line (`.when-time { display: block }`) without affecting the
    // single-line desktop layout, where it just renders inline after a space.
    return `${date} <span class="when-time">${time}</span>`;
}

function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

function renderSummary(summary) {
    const el = document.getElementById("summary-cards");
    el.innerHTML = SUMMARY_METRICS.map((m) => {
        const total = summary[`${m.key}_total`] || 0;
        const authed = summary[`${m.key}_authed`] || 0;
        const anon = summary[`${m.key}_anon`] || 0;
        return `
            <div class="stat">
                <div class="stat__label">${escapeHtml(m.label)}</div>
                <div class="stat__value">${num(total)}</div>
                <div class="stat__split">
                    <span title="Signed-in">👤 ${num(authed)}</span>
                    <span title="Anonymous">🕶 ${num(anon)}</span>
                </div>
            </div>`;
    }).join("");
}

// Compare two cell values for one column. Strings compare
// case-insensitively/naturally; numbers and dates compare numerically with
// blank/missing values (null) sinking to the bottom regardless of direction.
function compareBy(a, b, type) {
    if (type === "string") {
        return String(a == null ? "" : a).localeCompare(
            String(b == null ? "" : b), undefined, { sensitivity: "base", numeric: true });
    }
    const av = a == null ? -Infinity : a;
    const bv = b == null ? -Infinity : b;
    return av === bv ? 0 : av < bv ? -1 : 1;
}

// Render a table whose column headers can be clicked to re-sort it in place.
// `columns` describe how to render and sort each column; a column with a
// `field` is sortable (clicking toggles asc/desc, first click uses defaultDir).
// A column with `mobileHide` folds away below the narrow-screen breakpoint
// (see the CSS `.mobile-hide` rule) to keep the table from forcing horizontal
// scroll on a phone. The leading rank column has no field, so it always
// reflects position in the current sort order. `state` holds the initial
// { key, dir }. `opts.limit`, if set, truncates the table to that many rows
// with a "Show N more" footer that expands it in place.
function mountSortableTable(el, columns, rows, state, opts = {}) {
    const limit = opts.limit || null;
    let expanded = false;
    function draw() {
        const col = columns.find((c) => c.field && c.field === state.key);
        const data = rows.slice();
        if (col) {
            data.sort((a, b) => {
                const r = compareBy(a[col.field], b[col.field], col.type);
                return state.dir === "asc" ? r : -r;
            });
        }
        const visible = limit && !expanded ? data.slice(0, limit) : data;
        const head = columns.map((c) => {
            const sortable = c.field != null;
            const active = sortable && c.field === state.key;
            const cls = [c.numeric ? "n" : null, sortable ? "th-sort" : null, active ? "is-sorted" : null, c.mobileHide ? "mobile-hide" : null]
                .filter(Boolean).join(" ");
            const arrow = active
                ? `<span class="sort-arrow">${state.dir === "asc" ? "▲" : "▼"}</span>`
                : (sortable ? `<span class="sort-arrow sort-arrow--idle">↕</span>` : "");
            const attrs = sortable
                ? ` data-field="${escapeHtml(c.field)}" role="button" tabindex="0"` +
                  ` aria-sort="${active ? (state.dir === "asc" ? "ascending" : "descending") : "none"}"`
                : "";
            return `<th class="${cls}"${attrs}>${c.label}${arrow}</th>`;
        }).join("");
        const body = visible.map((row, i) =>
            `<tr>${columns.map((c) => c.cell(row, i)).join("")}</tr>`).join("");
        const table = `<div class="table-scroll"><table class="usage-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
        const more = (limit && data.length > limit)
            ? `<div class="table-more"><button type="button" class="table-more__btn" data-action="toggle-more">` +
              (expanded ? "Show less" : `Show ${data.length - limit} more`) +
              `</button></div>`
            : "";
        el.innerHTML = table + more;

        el.querySelectorAll("th[data-field]").forEach((th) => {
            const sortHere = () => {
                const field = th.getAttribute("data-field");
                if (state.key === field) {
                    state.dir = state.dir === "asc" ? "desc" : "asc";
                } else {
                    state.key = field;
                    state.dir = columns.find((c) => c.field === field).defaultDir || "desc";
                }
                draw();
            };
            th.addEventListener("click", sortHere);
            th.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sortHere(); }
            });
        });

        const moreBtn = el.querySelector('[data-action="toggle-more"]');
        if (moreBtn) moreBtn.addEventListener("click", () => { expanded = !expanded; draw(); });
    }
    draw();
}

// One ranked table of entities (tournaments / disciplines / players).
function renderEntityTable(id, rows, nameHeader, showId) {
    const el = document.getElementById(id);
    if (!rows || !rows.length) {
        el.innerHTML = `<div class="usage-empty">No data yet.</div>`;
        return;
    }
    const columns = [
        { label: "#", cell: (r, i) => `<td class="rank">${i + 1}</td>` },
        {
            label: escapeHtml(nameHeader), field: "name", type: "string", defaultDir: "asc",
            cell: (r) => `<td class="name">${escapeHtml(r.name || (showId ? r.id : "—"))}${
                showId && r.name ? `<span class="sub">${escapeHtml(r.id)}</span>` : ""}</td>`,
        },
        { label: "Total", field: "count", type: "number", numeric: true, defaultDir: "desc",
            cell: (r) => `<td class="n">${num(r.count)}</td>` },
        { label: "👤", field: "count_authed", type: "number", numeric: true, defaultDir: "desc", mobileHide: true,
            cell: (r) => `<td class="n dim mobile-hide">${num(r.count_authed)}</td>` },
        { label: "🕶", field: "count_anon", type: "number", numeric: true, defaultDir: "desc", mobileHide: true,
            cell: (r) => `<td class="n dim mobile-hide">${num(r.count_anon)}</td>` },
        { label: "Last queried", field: "lastQueried", type: "date", defaultDir: "desc",
            cell: (r) => `<td class="when">${fmtDate(r.lastQueried)}</td>` },
    ];
    mountSortableTable(el, columns, rows, { key: "lastQueried", dir: "desc" }, { limit: 10 });
}

function renderUsers(users) {
    document.getElementById("users-total").textContent = num(users.total);
    const el = document.getElementById("users-table");
    if (!users.top || !users.top.length) {
        el.innerHTML = `<div class="usage-empty">No users yet.</div>`;
        return;
    }
    const columns = [
        { label: "#", cell: (u, i) => `<td class="rank">${i + 1}</td>` },
        {
            label: "User", field: "name", type: "string", defaultDir: "asc",
            cell: (u) => `<td class="name">${escapeHtml(u.name || "—")}<span class="sub">${escapeHtml(u.email)}</span></td>`,
        },
        { label: "Logins", field: "loginCount", type: "number", numeric: true, defaultDir: "desc",
            cell: (u) => `<td class="n">${num(u.loginCount)}</td>` },
        { label: "Last login", field: "lastLogin", type: "date", defaultDir: "desc",
            cell: (u) => `<td class="when">${fmtDate(u.lastLogin)}</td>` },
        { label: "Registered", field: "registrationDate", type: "date", defaultDir: "desc", mobileHide: true,
            cell: (u) => `<td class="when mobile-hide">${fmtDate(u.registrationDate)}</td>` },
    ];
    mountSortableTable(el, columns, users.top, { key: "lastLogin", dir: "desc" }, { limit: 10 });
}

const FEEDBACK_CATEGORY_LABEL = { bug: "Bug", feature: "Feature", data: "Data", other: "Other" };

function renderFeedback(rows) {
    const el = document.getElementById("table-feedback");
    if (!rows || !rows.length) {
        el.innerHTML = `<div class="usage-empty">No feedback yet.</div>`;
        return;
    }
    const columns = [
        { label: "#", cell: (r, i) => `<td class="rank">${i + 1}</td>` },
        {
            label: "Category", field: "category", type: "string", defaultDir: "asc",
            cell: (r) => `<td><span class="fb-cat fb-cat--${escapeHtml(r.category)}">${escapeHtml(FEEDBACK_CATEGORY_LABEL[r.category] || "Other")}</span></td>`,
        },
        { label: "Message", field: "message", type: "string", defaultDir: "asc",
            cell: (r) => `<td class="msg">${escapeHtml(r.message)}</td>` },
        {
            label: "From", field: "userName", type: "string", defaultDir: "asc", mobileHide: true,
            cell: (r) => `<td class="name mobile-hide">${escapeHtml(r.userName || "Anonymous")}</td>`,
        },
        { label: "When", field: "createdAt", type: "date", defaultDir: "desc",
            cell: (r) => `<td class="when">${fmtDate(r.createdAt)}</td>` },
    ];
    mountSortableTable(el, columns, rows, { key: "createdAt", dir: "desc" }, { limit: 10 });
}

// --- Usage-over-time bar chart (SVG) ---------------------------------------
const TL_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function tlFmt(key) { const p = key.split("-"); return TL_MON[(+p[1]) - 1] + " " + (+p[2]); }
function tlNiceCeil(v) {
    if (v <= 5) return 5;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p, step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * p;
}

function renderTimeline(daily) {
    const el = document.getElementById("usage-timeline");
    const DAYS = 30;
    const byDate = new Map((daily || []).map(d => [d.date, d]));
    // Continuous window ending today; UTC keys to match the backend buckets.
    const now = new Date();
    const days = [];
    for (let i = DAYS - 1; i >= 0; i--) {
        const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
        const key = dt.toISOString().slice(0, 10);
        const r = byDate.get(key);
        days.push({ key, count: r ? (r.count || 0) : 0, authed: r ? (r.count_authed || 0) : 0, anon: r ? (r.count_anon || 0) : 0 });
    }
    if (days.reduce((s, d) => s + d.count, 0) === 0) {
        el.innerHTML = '<div class="tl-empty">No usage recorded yet — the timeline fills as the site is used.</div>';
        return;
    }
    const maxV = tlNiceCeil(Math.max(1, ...days.map(d => d.count)));

    const W = 900, H = 210, padL = 30, padR = 10, padT = 10, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const slot = plotW / DAYS, barW = Math.max(3, slot * 0.68);
    const x0 = i => padL + i * slot + (slot - barW) / 2;
    const y = v => padT + plotH - (v / maxV) * plotH;
    const baseline = padT + plotH;

    let grid = "", ticks = "";
    [0, 0.5, 1].forEach(f => {
        const gy = baseline - f * plotH;
        grid += `<line class="tl-grid" x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}"/>`;
        ticks += `<text class="tl-axis" x="${padL - 6}" y="${gy + 3}" text-anchor="end">${Math.round(maxV * f)}</text>`;
    });

    let bars = "", xlabels = "", hits = "";
    days.forEach((d, i) => {
        const bx = x0(i), yAnon = y(d.anon), yTop = y(d.count);
        if (d.anon > 0) bars += `<rect class="tl-bar tl-bar-anon" x="${bx}" y="${yAnon}" width="${barW}" height="${baseline - yAnon}" rx="1.5"/>`;
        if (d.authed > 0) bars += `<rect class="tl-bar tl-bar-authed" x="${bx}" y="${yTop}" width="${barW}" height="${yAnon - yTop}" rx="1.5"/>`;
        if (i % 6 === 0 || i === DAYS - 1) xlabels += `<text class="tl-axis" x="${bx + barW / 2}" y="${H - 8}" text-anchor="middle">${tlFmt(d.key)}</text>`;
        const tip = `${tlFmt(d.key)}: ${d.count} action${d.count === 1 ? "" : "s"} (signed-in ${d.authed} · anon ${d.anon})`;
        hits += `<rect class="tl-hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}" data-tip="${tip.replace(/"/g, "&quot;")}"/>`;
    });

    const legend = '<div class="tl-legend"><span><i style="background:var(--accent)"></i>Signed-in</span><span><i style="background:var(--border-strong)"></i>Anonymous</span></div>';
    el.innerHTML = legend +
        `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Usage over time">` +
        grid + bars + ticks + xlabels + hits + "</svg>" +
        '<div class="tl-tooltip hidden"></div>';

    const svg = el.querySelector("svg"), tip = el.querySelector(".tl-tooltip"), wrap = el.parentElement;
    svg.addEventListener("mousemove", e => {
        const h = e.target.closest("[data-tip]");
        if (!h) { tip.classList.add("hidden"); return; }
        tip.textContent = h.getAttribute("data-tip");
        tip.classList.remove("hidden");
        const r = wrap.getBoundingClientRect();
        tip.style.left = (e.clientX - r.left) + "px";
        tip.style.top = (e.clientY - r.top) + "px";
    });
    svg.addEventListener("mouseleave", () => tip.classList.add("hidden"));
}

function render(data) {
    renderSummary(data.summary || {});
    renderTimeline(data.daily || []);
    renderEntityTable("table-tournaments", data.tournaments, "Tournament", true);
    renderEntityTable("table-disciplines", data.disciplines, "Discipline", true);
    renderEntityTable("table-players", data.players, "Player", true);
    renderUsers(data.users || { total: 0, top: [] });
    renderFeedback(data.feedback || []);
    show(dashboard);
}

// Fill the dashboard with shimmer placeholders while stats load.
function showLoadingSkeleton() {
    const card = () => `<div class="stat">
        <div class="skel skel-line" style="width:60%"></div>
        <div class="skel skel-block" style="height:1.7rem;margin-top:0.45rem"></div>
        <div class="skel skel-line" style="width:42%;margin-top:0.45rem"></div>
    </div>`;
    document.getElementById("summary-cards").innerHTML = Array.from({ length: 7 }, card).join("");
    document.getElementById("usage-timeline").innerHTML = `<div class="skel skel-block" style="height:200px"></div>`;
    const table = () => `<div style="padding:0.7rem 0.8rem">` +
        Array.from({ length: 6 }, () => `<div class="skel skel-block" style="height:34px;margin-bottom:0.45rem"></div>`).join("") + `</div>`;
    ["table-tournaments", "table-disciplines", "table-players", "users-table", "table-feedback"].forEach((id) => {
        const el = document.getElementById(id); if (el) el.innerHTML = table();
    });
    show(dashboard);
}

let loading = false;
async function load() {
    if (loading) return;
    loading = true;
    showLoadingSkeleton();
    try {
        const res = await getUsageStats();
        render(res.data);
    } catch (err) {
        if (err?.code === "functions/permission-denied") {
            show(gateDenied);
        } else {
            console.error("Failed to load usage stats:", err);
            const el = document.getElementById("gate-error-msg");
            if (el) el.textContent = err?.message || String(err);
            show(document.getElementById("gate-error"));
        }
    } finally {
        loading = false;
    }
}

const refreshBtn = document.getElementById("refresh-btn");
if (refreshBtn) refreshBtn.addEventListener("click", load);

onAuthStateChanged(auth, (user) => {
    if (user) {
        load();
    } else {
        show(gateSignin);
    }
});
