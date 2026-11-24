// Home: search-first. One field for player / club search (or a pasted
// dbv.turnier.de tournament link), then the visitor's starred items, the
// tournaments of the next 10 days, and the players viewed in this tab.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions } from "./util/firebase.js";
import { onFavoritesChange, toggleFavorite } from "./util/favorites.js";

const findTournaments = httpsCallable(functions, "find_tournaments", { timeout: 60000 });
const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return iso || "";
    const d = new Date(iso + "T12:00:00");
    return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
}
const CHEV = '<svg class="home-row__chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const ICONS = {
    tournament: '<path d="M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M12 13v4M8 20h8M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
    discipline: '<path d="M4 6h16M4 12h10M4 18h6"/>',
    player: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    club: '<path d="M3 20h18M5 20V9l7-5 7 5v11"/><path d="M10 20v-5h4v5"/>',
};
const icon = (type) => `<span class="home-row__ic" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[type] || ICONS.player}</svg></span>`;

/* ---------------- search ---------------------------------------------- */
const input = $("home-q");
function go(kind) {
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    // A pasted dbv.turnier.de link opens the tournament (and discipline) directly.
    const gid = q.match(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/);
    if (gid && /turnier\.de|tournamentsoftware/i.test(q)) {
        const params = new URLSearchParams({ id: gid[0].toUpperCase() });
        const ev = q.match(/[?&]event=(\d+)/i);
        if (ev) params.set("event", ev[1]);
        location.href = "/html/tournament.html?" + params.toString();
        return;
    }
    location.href = `${kind === "club" ? "/html/club.html" : "/html/player.html"}?${new URLSearchParams({ q }).toString()}`;
}
input.addEventListener("keydown", (e) => { if (e.key === "Enter") go("player"); });
input.addEventListener("input", () => {
    const link = /turnier\.de|tournamentsoftware/i.test(input.value);
    $("home-hint").textContent = link
        ? "Press Enter to open this tournament."
        : "Press Enter to search players. A pasted tournament link opens that tournament.";
});
document.querySelectorAll("[data-search]").forEach((b) => b.addEventListener("click", () => go(b.dataset.search)));

/* ---------------- pinned (favorites) ---------------------------------- */
function linkFor(type, id, f) {
    if (type === "tournament") return "/html/tournament.html?" + new URLSearchParams({ id, name: f.name || "" }).toString();
    if (type === "discipline") {
        const q = new URLSearchParams({ id: f.tournamentId || "", event: f.event || "" });
        if (f.tournamentName) q.set("name", f.tournamentName);
        return "/html/tournament.html?" + q.toString();
    }
    if (type === "player") {
        const q = new URLSearchParams();
        if (f.sp_code) q.set("sp", f.sp_code);
        if (f.profile_id) q.set("pid", f.profile_id);
        if (f.name) q.set("name", f.name);
        return "/html/player.html?" + q.toString();
    }
    if (type === "club") return "/html/club.html?" + new URLSearchParams({ cl_code: id }).toString();
    return "#";
}
const TYPE_SUB = { tournament: "Tournament", discipline: "Discipline", player: "Player", club: "Club" };
function renderPinned(favorites) {
    const rows = [];
    for (const type of ["player", "tournament", "discipline", "club"]) {
        Object.entries(favorites[type] || {})
            .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""))
            .forEach(([id, f]) => rows.push({ type, id, f }));
    }
    $("favorites-empty").classList.toggle("hidden", rows.length > 0);
    $("home-pinned").innerHTML = rows.map(({ type, id, f }) => {
        const sub = type === "discipline" && f.tournamentName ? f.tournamentName
            : type === "player" && f.club ? f.club
            : type === "tournament" && f.start ? `${TYPE_SUB[type]}, ${shortDate(f.start)}${f.city ? `, ${f.city}` : ""}`
            : TYPE_SUB[type];
        return `<div class="home-row">
            <a class="home-row__link" href="${escapeHtml(linkFor(type, id, f))}">${icon(type)}
                <span class="home-row__main"><span class="home-row__t">${escapeHtml(f.name || "—")}</span><span class="home-row__s">${escapeHtml(sub)}</span></span>${CHEV}</a>
            <button class="home-row__x" type="button" data-type="${type}" data-id="${escapeHtml(id)}" title="Remove star" aria-label="Remove ${escapeHtml(f.name || "")} from pinned">&times;</button>
        </div>`;
    }).join("");
}
$("home-pinned").addEventListener("click", (e) => {
    const b = e.target.closest(".home-row__x");
    if (b) toggleFavorite(b.dataset.type, b.dataset.id);
});
onFavoritesChange(renderPinned);

/* ---------------- next 10 days ---------------------------------------- */
(async function loadUpcoming() {
    const box = $("home-upcoming");
    const iso = (d) => d.toISOString().slice(0, 10);
    const today = new Date(), later = new Date();
    later.setDate(later.getDate() + 10);
    try {
        const res = await findTournaments({ q: "", start_date: iso(today), end_date: iso(later), registration_only: false, page: 1 });
        if (res.data.error) throw new Error(res.data.error);
        const list = (res.data.tournaments || []).slice(0, 7);
        box.innerHTML = list.length ? list.map((t) => {
            const q = new URLSearchParams({ id: t.id });
            ["name", "start", "end", "city"].forEach((k) => { if (t[k]) q.set(k, t[k]); });
            return `<div class="home-row"><a class="home-row__link" href="/html/tournament.html?${escapeHtml(q.toString())}">
                <span class="home-row__date">${escapeHtml(shortDate(t.start))}</span>
                <span class="home-row__main"><span class="home-row__t">${escapeHtml(t.name)}</span><span class="home-row__s">${escapeHtml([t.city, t.tag].filter(Boolean).join(", "))}</span></span>${CHEV}</a></div>`;
        }).join("") : `<p class="home-empty">No tournaments in the next 10 days.</p>`;
    } catch (err) {
        console.error("Upcoming tournaments failed:", err);
        box.innerHTML = `<p class="home-empty">Couldn't load tournaments. <a href="/html/tournaments.html">Browse tournaments</a> instead.</p>`;
    }
})();

/* ---------------- viewed in this tab ---------------------------------- */
(function renderRecent() {
    let list = [];
    try { list = JSON.parse(sessionStorage.getItem("bax_recent_players") || "[]") || []; } catch (e) { list = []; }
    if (!list.length) return;
    $("recent-section").classList.remove("hidden");
    $("home-recent").innerHTML = list.slice(0, 6).map((r) => {
        const q = new URLSearchParams();
        if (r.sp) q.set("sp", r.sp);
        if (r.pid) q.set("pid", r.pid);
        if (r.name) q.set("name", r.name);
        return `<div class="home-row"><a class="home-row__link" href="/html/player.html?${escapeHtml(q.toString())}">${icon("player")}
            <span class="home-row__main"><span class="home-row__t">${escapeHtml(r.name || r.sp || "Player")}</span></span>${CHEV}</a></div>`;
    }).join("");
})();
