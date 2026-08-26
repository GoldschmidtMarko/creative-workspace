// Landing page: renders the signed-in user's starred tournaments/disciplines/
// players (see public/js/util/favorites.js) as a clickable, removable list.
import { onFavoritesChange, toggleFavorite } from "./util/favorites.js";

function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

const ICON = { tournament: "trophy", discipline: "medal", player: "user-round" };

function linkFor(type, id, f) {
    if (type === "tournament") {
        return "/html/tournament.html?" + new URLSearchParams({ id, name: f.name || "" }).toString();
    }
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
    return "#";
}

function labelFor(type, f) {
    if (type === "discipline" && f.tournamentName) {
        return { main: f.name || "Discipline", sub: f.tournamentName };
    }
    return { main: f.name || "—", sub: "" };
}

function renderGroup(type, entries) {
    const group = document.getElementById(`fav-group-${type}`);
    const list = document.getElementById(`fav-list-${type}`);
    if (!entries.length) { group.classList.add("hidden"); list.innerHTML = ""; return; }
    group.classList.remove("hidden");
    list.innerHTML = entries.map(([id, f]) => {
        const { main, sub } = labelFor(type, f);
        return `<span class="fav-chip">
            <a class="fav-chip__link" href="${escapeHtml(linkFor(type, id, f))}" title="${escapeHtml(sub ? `${main} · ${sub}` : main)}">
                <i data-lucide="${ICON[type]}"></i>
                <span>${escapeHtml(main)}${sub ? ` <span class="fav-chip__sub">· ${escapeHtml(sub)}</span>` : ""}</span>
            </a>
            <button class="fav-chip__remove" type="button" data-type="${type}" data-id="${escapeHtml(id)}" title="Remove from favorites">&times;</button>
        </span>`;
    }).join("");
    list.querySelectorAll(".fav-chip__remove").forEach((btn) => {
        btn.addEventListener("click", () => toggleFavorite(btn.dataset.type, btn.dataset.id));
    });
}

function render(favorites) {
    let total = 0;
    for (const type of ["tournament", "discipline", "player"]) {
        const entries = Object.entries(favorites[type] || {})
            .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));
        total += entries.length;
        renderGroup(type, entries);
    }
    document.getElementById("favorites-empty").classList.toggle("hidden", total > 0);
    if (window.lucide) lucide.createIcons();
}

// Per-group fold state (localStorage, so a collapsed group stays collapsed
// across visits). The toggle buttons are static markup, wired once — only
// the chip lists inside them are re-rendered on favorites changes.
const FOLD_KEY = "bax_favorites_collapsed";
function getFolded() {
    try { return JSON.parse(localStorage.getItem(FOLD_KEY) || "{}"); } catch (e) { return {}; }
}
function setFolded(map) {
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
}
document.querySelectorAll(".fav-group__head").forEach((head) => {
    const type = head.dataset.favToggle;
    const group = head.closest(".fav-group");
    if (getFolded()[type]) group.classList.add("is-collapsed");
    head.addEventListener("click", () => {
        const collapsed = group.classList.toggle("is-collapsed");
        setFolded({ ...getFolded(), [type]: collapsed });
    });
});

onFavoritesChange(render);
