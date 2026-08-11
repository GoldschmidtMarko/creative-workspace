// Tournaments browse/search. Each result links to a shareable tournament page
// (tournament.html?id=<GUID>), which holds the disciplines + BAX analysis.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions } from "./util/firebase.js";

const findTournaments = httpsCallable(functions, "find_tournaments", { timeout: 60000 });

const filterQ = document.getElementById("filter-q");
const filterStart = document.getElementById("filter-start");
const filterEnd = document.getElementById("filter-end");
const filterPlz = document.getElementById("filter-plz");
const filterDistance = document.getElementById("filter-distance");
const filterRegOpen = document.getElementById("filter-reg-open");
const searchBtn = document.getElementById("search-btn");
const browseStatus = document.getElementById("browse-status");
const tournamentList = document.getElementById("tournament-list");

function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

function setStatus(msg) {
    if (!msg) { browseStatus.classList.add("hidden"); return; }
    browseStatus.textContent = msg;
    browseStatus.classList.remove("hidden");
}

function formatDate(iso) {
    const p = (iso || "").split("-");
    return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : iso;
}

// Default the date range to today .. +3 months.
(function initDates() {
    const today = new Date();
    const later = new Date();
    later.setMonth(later.getMonth() + 3);
    const iso = (d) => d.toISOString().slice(0, 10);
    filterStart.value = iso(today);
    filterEnd.value = iso(later);
})();

function tournamentHref(t) {
    const q = new URLSearchParams({ id: t.id });
    if (t.name) q.set("name", t.name);
    if (t.start) q.set("start", t.start);
    if (t.end) q.set("end", t.end);
    if (t.city) q.set("city", t.city);
    return `/html/tournament.html?${q.toString()}`;
}

// Collapsible "Search & filters" card.
const filterCard = document.getElementById("filter-card");
const filterHead = document.getElementById("filter-head");
function setFilters(collapsed) {
    filterCard.classList.toggle("collapsed", collapsed);
    filterHead.setAttribute("aria-expanded", String(!collapsed));
}
filterHead.addEventListener("click", () => setFilters(!filterCard.classList.contains("collapsed")));
filterHead.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFilters(!filterCard.classList.contains("collapsed")); }
});

async function searchTournaments(force = false, userInitiated = false) {
    searchBtn.disabled = true;
    tournamentList.innerHTML = "";
    setStatus(force ? "Fetching live tournament listings…" : "Searching tournaments…");
    try {
        const res = await findTournaments({
            q: filterQ.value.trim(),
            start_date: filterStart.value,
            end_date: filterEnd.value,
            postal_code: filterPlz.value.trim(),
            distance: Number(filterDistance.value),
            registration_only: filterRegOpen.checked,
            page: 1,
            force,
        });
        if (res.data.error) throw new Error(res.data.error);
        const tournaments = res.data.tournaments || [];
        renderTournaments(tournaments);
        // Fold the filter fields away once a user search returns results, so the
        // list takes focus. Keep them open on the initial auto-load or empty results.
        if (userInitiated && tournaments.length) setFilters(true);
    } catch (err) {
        console.error("Tournament search failed:", err);
        setStatus("Search failed: " + err.message);
    } finally {
        searchBtn.disabled = false;
    }
}

function renderTournaments(tournaments) {
    if (!tournaments.length) {
        setStatus("No tournaments found for these filters.");
        return;
    }
    setStatus(`${tournaments.length} tournament${tournaments.length === 1 ? "" : "s"} found.`);
    tournamentList.innerHTML = "";

    tournaments.forEach((t) => {
        const card = document.createElement("a");
        card.className = "tournament-card";
        card.href = tournamentHref(t);

        const dateText = t.start
            ? (t.end && t.end !== t.start ? `${formatDate(t.start)} – ${formatDate(t.end)}` : formatDate(t.start))
            : (t.date_text || "");

        const tags = [];
        if (t.tag) tags.push(`<span class="mini-tag">${escapeHtml(t.tag)}</span>`);
        if (t.registration_open) {
            tags.push(`<span class="mini-tag mini-tag--open">Registration open${t.deadline ? " · " + escapeHtml(t.deadline) : ""}</span>`);
        }

        const logo = t.logo
            ? `<img class="tournament-card__logo" src="${escapeHtml(t.logo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
            : `<div class="tournament-card__logo"></div>`;

        card.innerHTML = `
            ${logo}
            <div class="tournament-card__body">
                <div class="tournament-card__name">${escapeHtml(t.name)}</div>
                <div class="tournament-card__meta">
                    ${t.city ? `<span>📍 ${escapeHtml(t.city)}</span>` : ""}
                    ${dateText ? `<span>📅 ${escapeHtml(dateText)}</span>` : ""}
                </div>
                <div class="tournament-card__tags">${tags.join("")}</div>
            </div>`;
        tournamentList.appendChild(card);
    });
}

searchBtn.addEventListener("click", () => searchTournaments(false, true));
[filterQ, filterPlz].forEach((el) => el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchTournaments(false, true);
}));
const liveBtn = document.getElementById("browse-update-live-btn");
if (liveBtn) liveBtn.addEventListener("click", () => searchTournaments(true, true));

// Paste a dbv.turnier.de link → jump straight to the tournament page.
const pasteUrl = document.getElementById("paste-url");
const pasteGo = document.getElementById("paste-go");
function openPasted() {
    const v = pasteUrl.value.trim();
    const id = /[?&]id=([0-9A-Fa-f-]{36})/i.exec(v) || /([0-9A-Fa-f]{8}-[0-9A-Fa-f-]{27})/.exec(v);
    if (!id) { pasteUrl.classList.add("field--error"); return; }
    const ev = /[?&]event=(\d+)/i.exec(v);
    const q = new URLSearchParams({ id: id[1].toUpperCase() });
    if (ev) q.set("event", ev[1]);
    location.href = `/html/tournament.html?${q.toString()}`;
}
if (pasteGo) pasteGo.addEventListener("click", openPasted);
if (pasteUrl) pasteUrl.addEventListener("keydown", (e) => { if (e.key === "Enter") openPasted(); });

// Auto-run an initial search so the page isn't empty on arrival.
searchTournaments(false);
