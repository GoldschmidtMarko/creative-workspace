// Tournaments browse/search. Each result links to a shareable tournament page
// (tournament.html?id=<GUID>), which holds the disciplines + BAX analysis.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions } from "./util/firebase.js";
import { onFavoritesChange, toggleFavorite } from "./util/favorites.js";

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
    if (t.event) q.set("event", t.event);
    return `/html/tournament.html?${q.toString()}`;
}

// Collapsible card + two modes (search filters | direct link).
const filterCard = document.getElementById("filter-card");
const filterToggle = document.getElementById("filter-toggle");
function setFilters(collapsed) {
    filterCard.classList.toggle("collapsed", collapsed);
    if (filterToggle) filterToggle.setAttribute("aria-expanded", String(!collapsed));
}
if (filterToggle) filterToggle.addEventListener("click", () => setFilters(!filterCard.classList.contains("collapsed")));

// Three tabs share the filter card: Favorites (the initial view — a quick way
// back to starred tournaments/disciplines), Search filters, and Direct link.
const TABS = {
    favorites: { tab: document.getElementById("tab-favorites"), mode: document.getElementById("mode-favorites") },
    filters: { tab: document.getElementById("tab-filters"), mode: document.getElementById("mode-filters") },
    url: { tab: document.getElementById("tab-url"), mode: document.getElementById("mode-url") },
};
function setMode(name) {
    Object.entries(TABS).forEach(([key, { tab, mode }]) => {
        tab.classList.toggle("active", key === name);
        mode.classList.toggle("hidden", key !== name);
    });
    setFilters(false);   // switching modes always opens the card
    if (name === "url") { const p = document.getElementById("paste-url"); if (p) p.focus(); }
}
TABS.favorites.tab.addEventListener("click", () => setMode("favorites"));
TABS.filters.tab.addEventListener("click", () => setMode("filters"));
TABS.url.tab.addEventListener("click", () => setMode("url"));
// Search filters is the default view (the auto-loaded upcoming list sits
// right under it); Favorites is one click away.
setMode("filters");

/* ---------------- Favorites tab: starred tournaments + disciplines ------- */
function renderFavoritesTab(favorites) {
    const tEntries = Object.entries(favorites.tournament || {})
        .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));
    const dEntries = Object.entries(favorites.discipline || {})
        .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));

    const tGroup = document.getElementById("fav-tournaments-group");
    tGroup.classList.toggle("hidden", !tEntries.length);
    document.getElementById("fav-tournaments-list").innerHTML = tEntries.map(([id, f]) => {
        const href = tournamentHref({ id, name: f.name, start: f.start, end: f.end, city: f.city });
        return `<span class="fav-chip">
            <a class="fav-chip__link" href="${escapeHtml(href)}" title="${escapeHtml(f.name || "")}">
                <span>${escapeHtml(f.name || "—")}</span>
            </a>
            <button class="fav-chip__remove" type="button" data-type="tournament" data-id="${escapeHtml(id)}" title="Remove from favorites">&times;</button>
        </span>`;
    }).join("");

    const dGroup = document.getElementById("fav-disciplines-group");
    dGroup.classList.toggle("hidden", !dEntries.length);
    document.getElementById("fav-disciplines-list").innerHTML = dEntries.map(([id, f]) => {
        const href = tournamentHref({ id: f.tournamentId, event: f.event, name: f.tournamentName });
        const sub = f.tournamentName ? ` <span class="fav-chip__sub">· ${escapeHtml(f.tournamentName)}</span>` : "";
        const title = f.tournamentName ? `${f.name} · ${f.tournamentName}` : (f.name || "");
        return `<span class="fav-chip">
            <a class="fav-chip__link" href="${escapeHtml(href)}" title="${escapeHtml(title)}">
                <span>${escapeHtml(f.name || "—")}${sub}</span>
            </a>
            <button class="fav-chip__remove" type="button" data-type="discipline" data-id="${escapeHtml(id)}" title="Remove from favorites">&times;</button>
        </span>`;
    }).join("");

    document.getElementById("fav-tab-empty").classList.toggle("hidden", !!(tEntries.length || dEntries.length));

    document.querySelectorAll("#mode-favorites .fav-chip__remove").forEach((btn) => {
        btn.addEventListener("click", () => toggleFavorite(btn.dataset.type, btn.dataset.id));
    });
    if (window.lucide) lucide.createIcons();
}
onFavoritesChange(renderFavoritesTab);

function skeletonTournaments(n = 6) {
    return `<section class="t-day is-skel" aria-hidden="true"><h2 class="t-day__h"><span class="skel skel-line" style="width:3.5rem;height:1.1rem"></span></h2><div class="t-day__rows">` +
        Array.from({ length: n }, () => `
        <div class="t-row">
            <span class="skel" style="width:36px;height:36px;border-radius:var(--radius-sm)"></span>
            <span class="t-row__main"><span class="skel skel-line" style="width:70%;height:0.9rem"></span><span class="skel skel-line" style="width:40%"></span></span>
            <span></span><span></span>
        </div>`).join("") + `</div></section>`;
}

/* ---------------- Upcoming / Past ------------------------------------ */
// dbv returns 20 tournaments per page, oldest first. Upcoming pages forward
// with "Show more". Past loads a 30-day window (every page of it), sorted
// newest first; "Show earlier" adds the 30 days before that.
const PAGE_SIZE = 20;
const PAST_WINDOW_DAYS = 30;
const MAX_PAGES_PER_WINDOW = 6;
const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const moreBtn = document.getElementById("load-more");
const regToggle = filterRegOpen.closest(".reg-toggle");
let when = new URLSearchParams(location.search).get("when") === "past" ? "past" : "upcoming";
let shown = [];
let upcomingPage = 1;
let canMore = false;

function currentFilters(extra = {}) {
    return {
        q: filterQ.value.trim(),
        start_date: filterStart.value,
        end_date: filterEnd.value,
        postal_code: filterPlz.value.trim(),
        distance: Number(filterDistance.value),
        registration_only: when === "upcoming" && filterRegOpen.checked,
        ...extra,
    };
}
async function fetchPage(filters, page, force = false) {
    const res = await findTournaments({ ...filters, page, force });
    if (res.data.error) throw new Error(res.data.error);
    return res.data.tournaments || [];
}
async function fetchWindow(filters, force = false) {
    const all = [];
    for (let page = 1; page <= MAX_PAGES_PER_WINDOW; page++) {
        const batch = await fetchPage(filters, page, force);
        all.push(...batch);
        if (batch.length < PAGE_SIZE) break;
    }
    return all;
}
function mergeSorted(list) {
    const byId = new Map();
    list.forEach((t) => { if (!byId.has(t.id)) byId.set(t.id, t); });
    const out = [...byId.values()];
    out.sort((a, b) => when === "past"
        ? (b.start || "").localeCompare(a.start || "")
        : (a.start || "").localeCompare(b.start || ""));
    return out;
}
function setMoreButton() {
    // An empty past window can still have older tournaments before it.
    moreBtn.hidden = !canMore || (!shown.length && when !== "past");
    moreBtn.disabled = false;
    moreBtn.textContent = when === "past" ? `Show ${PAST_WINDOW_DAYS} days earlier` : "Show more";
}

function setWhen(next) {
    when = next;
    document.querySelectorAll("[data-when]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.when === when)));
    const today = new Date();
    if (when === "past") {
        filterStart.value = isoDate(addDays(today, -PAST_WINDOW_DAYS));
        filterEnd.value = isoDate(addDays(today, -1));
    } else {
        const later = new Date(); later.setMonth(later.getMonth() + 3);
        filterStart.value = isoDate(today);
        filterEnd.value = isoDate(later);
    }
    // Registration can't be open for a tournament that already happened.
    if (regToggle) regToggle.hidden = when === "past";
    const q = new URLSearchParams(location.search);
    if (when === "past") q.set("when", "past"); else q.delete("when");
    const qs = q.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
    setMode("filters");
    searchTournaments(false);
}
document.querySelectorAll("[data-when]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.when !== when) setWhen(b.dataset.when);
}));

async function searchTournaments(force = false, userInitiated = false) {
    searchBtn.disabled = true;
    moreBtn.hidden = true;
    tournamentList.innerHTML = skeletonTournaments();
    setStatus(force ? "Fetching live tournament listings…" : "Searching tournaments…");
    try {
        const filters = currentFilters();
        const batch = when === "past" ? await fetchWindow(filters, force) : await fetchPage(filters, 1, force);
        upcomingPage = 1;
        shown = mergeSorted(batch);
        canMore = when === "past" ? true : batch.length >= PAGE_SIZE;
        renderTournaments(shown);
        setMoreButton();
        // Fold the filter fields away whenever results come back (including the
        // initial auto-load), so the list is what you see first — on a phone the
        // open form pushed it below the fold. Empty results keep the form open.
        if (shown.length) setFilters(true);
    } catch (err) {
        console.error("Tournament search failed:", err);
        tournamentList.innerHTML = "";
        setStatus("Search failed: " + err.message);
    } finally {
        searchBtn.disabled = false;
    }
}

async function loadMore() {
    moreBtn.disabled = true;
    moreBtn.textContent = "Loading…";
    try {
        if (when === "past") {
            const oldStart = new Date(filterStart.value + "T12:00:00");
            const newStart = addDays(oldStart, -PAST_WINDOW_DAYS);
            const batch = await fetchWindow(currentFilters({ start_date: isoDate(newStart), end_date: isoDate(addDays(oldStart, -1)) }));
            filterStart.value = isoDate(newStart);
            shown = mergeSorted(shown.concat(batch));
            canMore = true;
        } else {
            const batch = await fetchPage(currentFilters(), upcomingPage + 1);
            upcomingPage += 1;
            shown = mergeSorted(shown.concat(batch));
            canMore = batch.length >= PAGE_SIZE;
        }
        renderTournaments(shown);
    } catch (err) {
        console.error("Loading more tournaments failed:", err);
        setStatus("Couldn't load more: " + err.message);
    }
    setMoreButton();
}
moreBtn.addEventListener("click", loadMore);

function renderTournaments(tournaments) {
    if (!tournaments.length) {
        tournamentList.innerHTML = "";
        setStatus("No tournaments found for these filters.");
        return;
    }
    setStatus("");
    // One list grouped by start date (a date column, then that day's rows):
    // scouting reads by date, which a three-column card grid scrambled.
    const days = new Map();
    tournaments.forEach((t) => {
        const k = t.start || t.date_text || "";
        if (!days.has(k)) days.set(k, []);
        days.get(k).push(t);
    });
    const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const dayHead = (iso) => {
        const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + "T12:00:00") : null;
        return d ? `<span class="t-day__dow">${DOW[d.getDay()]}</span><span class="t-day__d">${d.getDate()} ${MON[d.getMonth()]}</span>`
                 : `<span class="t-day__d">${escapeHtml(iso || "Date unknown")}</span>`;
    };
    const span = (t) => {
        if (!t.start || !t.end || t.end === t.start) return "";
        const n = Math.round((new Date(t.end) - new Date(t.start)) / 864e5) + 1;
        return n > 1 ? `${n} days` : "";
    };
    tournamentList.className = "t-list";
    const range = `${formatDate(filterStart.value)} – ${formatDate(filterEnd.value)}`;
    tournamentList.innerHTML = `<p class="t-count">${tournaments.length} tournament${tournaments.length === 1 ? "" : "s"}${when === "past" ? `, newest first (${range})` : ""}</p>` +
        [...days.entries()].map(([iso, ts]) => `<section class="t-day">
            <h2 class="t-day__h">${dayHead(iso)}</h2>
            <div class="t-day__rows">${ts.map((t) => {
                const closes = t.registration_open ? (deadlineText(t.deadline) || "Registration open") : "";
                const meta = [t.city, span(t), t.tag].filter(Boolean).map((x) => `<span>${escapeHtml(x)}</span>`).join("");
                const logo = t.logo
                    ? `<img class="t-row__logo" src="${escapeHtml(t.logo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
                    : `<span class="t-row__logo" aria-hidden="true"></span>`;
                return `<a class="t-row" href="${escapeHtml(tournamentHref(t))}">
                    ${logo}
                    <span class="t-row__main"><span class="t-row__name">${escapeHtml(t.name)}</span><span class="t-row__meta">${meta}</span></span>
                    ${closes ? `<span class="mini-tag mini-tag--open t-row__reg">${escapeHtml(closes.replace("Registration closes", "Closes"))}</span>` : `<span></span>`}
                    <svg class="t-row__chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
                </a>`;
            }).join("")}</div>
        </section>`).join("");
}

// dbv.turnier.de's registration countdown label is terse German ("2t" = 2
// Tage, "Noch eine Tag" = one day left, "4s" = 4 Stunden — seen live on
// 2026-11-23 for an event whose deadline was closer than its siblings' "5t";
// "s" as hours is inferred, not documented). Turn the shapes we recognise into
// plain English and drop anything else rather than show it raw.
function deadlineText(raw) {
    const s = String(raw || "").trim().toLowerCase();
    if (!s) return "";
    let m = s.match(/^(\d+)\s*t/);
    if (m) return +m[1] === 1 ? "Registration closes tomorrow" : `Registration closes in ${m[1]} days`;
    m = s.match(/^(\d+)\s*(s|std|h)/);
    if (m) return +m[1] === 1 ? "Registration closes in 1 hour" : `Registration closes in ${m[1]} hours`;
    m = s.match(/^(\d+)\s*m/);
    if (m) return `Registration closes in ${m[1]} min`;
    if (/noch\s+ein/.test(s)) return "Registration closes in 1 day";
    return "";
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
if (pasteUrl) pasteUrl.addEventListener("input", () => pasteUrl.classList.remove("field--error"));

// Auto-run an initial search (upcoming, or past for ?when=past) so the page
// isn't empty on arrival.
setWhen(when);
