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
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) +
        " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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

// One ranked table of entities (tournaments / disciplines / players).
function renderEntityTable(id, rows, nameHeader, showId) {
    const el = document.getElementById(id);
    if (!rows || !rows.length) {
        el.innerHTML = `<div class="usage-empty">No data yet.</div>`;
        return;
    }
    const body = rows.map((r, i) => `
        <tr>
            <td class="rank">${i + 1}</td>
            <td class="name">${escapeHtml(r.name || (showId ? r.id : "—"))}${
                showId && r.name ? `<span class="sub">${escapeHtml(r.id)}</span>` : ""
            }</td>
            <td class="n">${num(r.count)}</td>
            <td class="n dim">${num(r.count_authed)}</td>
            <td class="n dim">${num(r.count_anon)}</td>
            <td class="when">${fmtDate(r.lastQueried)}</td>
        </tr>`).join("");
    el.innerHTML = `
        <table class="usage-table">
            <thead><tr>
                <th>#</th><th>${escapeHtml(nameHeader)}</th>
                <th class="n">Total</th><th class="n">👤</th><th class="n">🕶</th><th>Last queried</th>
            </tr></thead>
            <tbody>${body}</tbody>
        </table>`;
}

function renderUsers(users) {
    document.getElementById("users-total").textContent = num(users.total);
    const el = document.getElementById("users-table");
    if (!users.top || !users.top.length) {
        el.innerHTML = `<div class="usage-empty">No users yet.</div>`;
        return;
    }
    const body = users.top.map((u, i) => `
        <tr>
            <td class="rank">${i + 1}</td>
            <td class="name">${escapeHtml(u.name || "—")}<span class="sub">${escapeHtml(u.email)}</span></td>
            <td class="n">${num(u.loginCount)}</td>
            <td class="when">${fmtDate(u.lastLogin)}</td>
            <td class="when">${fmtDate(u.registrationDate)}</td>
        </tr>`).join("");
    el.innerHTML = `
        <table class="usage-table">
            <thead><tr>
                <th>#</th><th>User</th><th class="n">Logins</th><th>Last login</th><th>Registered</th>
            </tr></thead>
            <tbody>${body}</tbody>
        </table>`;
}

function render(data) {
    renderSummary(data.summary || {});
    renderEntityTable("table-tournaments", data.tournaments, "Tournament", true);
    renderEntityTable("table-disciplines", data.disciplines, "Discipline", true);
    renderEntityTable("table-players", data.players, "Player", true);
    renderUsers(data.users || { total: 0, top: [] });
    show(dashboard);
}

let loading = false;
async function load() {
    if (loading) return;
    loading = true;
    show(gateLoading);
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
