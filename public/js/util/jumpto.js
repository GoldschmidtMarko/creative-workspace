// Site-wide "Jump to…" quick panel (⌘K / Ctrl+K). Lives in the nav on every
// page (button #jumpto-btn / panel #jumpto-panel) and is also opened from the
// mobile bottom tab bar's Search item via [data-jumpto-trigger].
//
// It does not reimplement search: the Players/Clubs tabs deep-link into the
// existing search pages (player.html?q=…, club.html?q=…, which already
// auto-run a search on load — see player.js/club.js), and all three tabs
// show real starred favorites (favorites.js) rather than invented results —
// per the "never a blank search" pattern, but with real data, not filler.
import { onFavoritesChange } from "./favorites.js";

const TABS = [
    { type: "player", label: "Players", placeholder: "Search players…" },
    { type: "tournament", label: "Tournaments", placeholder: null },
    { type: "club", label: "Clubs", placeholder: "Search clubs…" },
];

let activeTab = "player";
let favorites = { tournament: {}, player: {}, club: {} };

function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

function linkFor(type, id, f) {
    if (type === "tournament") {
        return "/html/tournament.html?" + new URLSearchParams({ id, name: f.name || "" }).toString();
    }
    if (type === "player") {
        const q = new URLSearchParams();
        if (f.sp_code) q.set("sp", f.sp_code);
        if (f.profile_id) q.set("pid", f.profile_id);
        if (f.name) q.set("name", f.name);
        return "/html/player.html?" + q.toString();
    }
    if (type === "club") {
        return "/html/club.html?" + new URLSearchParams({ cl_code: id }).toString();
    }
    return "#";
}

function favoriteRows(type) {
    return Object.entries(favorites[type] || {})
        .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""))
        .slice(0, 6);
}

function renderPanel(panel) {
    const tab = TABS.find((t) => t.type === activeTab);
    const rows = favoriteRows(activeTab);

    const tabsHtml = `<div class="jumpto__tabs" role="tablist">${TABS.map((t) => (
        `<button class="jumpto__tab${t.type === activeTab ? " is-active" : ""}" role="tab" data-tab="${t.type}">${t.label}</button>`
    )).join("")}</div>`;

    const fieldHtml = tab.placeholder
        ? `<input class="jumpto__field" type="search" placeholder="${tab.placeholder}" autocomplete="new-password" autocorrect="off" autocapitalize="off" spellcheck="false" data-jumpto-input>`
        : "";

    const rowsHtml = rows.length
        ? `<div class="jumpto__group">Starred ${tab.label.toLowerCase()}</div>` + rows.map(([id, f]) => {
            const sub = tab.type === "club" ? "" : (f.club || f.tournamentName || "");
            return `<a class="jumpto__row" href="${escapeHtml(linkFor(tab.type, id, f))}">
                <span>${escapeHtml(f.name || "—")}</span>
                ${sub ? `<span class="mut">${escapeHtml(sub)}</span>` : ""}
            </a>`;
        }).join("")
        : `<p class="jumpto__empty">Star a ${tab.type} to see it here.</p>`;

    const browseHtml = tab.type === "tournament"
        ? `<a class="jumpto__browse" href="/html/tournaments.html">Browse tournaments →</a>`
        : "";

    panel.innerHTML = tabsHtml + fieldHtml + rowsHtml + browseHtml;

    panel.querySelectorAll("[data-tab]").forEach((btn) => {
        btn.addEventListener("click", () => { activeTab = btn.dataset.tab; renderPanel(panel); });
    });
    const input = panel.querySelector("[data-jumpto-input]");
    if (input) {
        input.addEventListener("keydown", (e) => {
            if (e.key !== "Enter" || !input.value.trim()) return;
            const dest = activeTab === "club" ? "/html/club.html" : "/html/player.html";
            location.href = `${dest}?${new URLSearchParams({ q: input.value.trim() }).toString()}`;
        });
    }
}

function setOpen(panel, btn, open) {
    panel.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
        renderPanel(panel);
        const input = panel.querySelector("[data-jumpto-input]");
        if (input) requestAnimationFrame(() => input.focus());
    }
}

function initPanel(btn, panel) {
    if (!btn || !panel || panel.dataset.jumptoInit) return;
    panel.dataset.jumptoInit = "1";

    const toggle = (e) => {
        e.stopPropagation();
        setOpen(panel, btn, !panel.classList.contains("is-open"));
    };
    btn.addEventListener("click", toggle);
    document.querySelectorAll("[data-jumpto-trigger]").forEach((el) => el.addEventListener("click", toggle));

    document.addEventListener("click", (e) => {
        if (panel.classList.contains("is-open") && !panel.contains(e.target) && e.target !== btn) {
            setOpen(panel, btn, false);
        }
    });
    document.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
            e.preventDefault();
            setOpen(panel, btn, !panel.classList.contains("is-open"));
        } else if (e.key === "Escape" && panel.classList.contains("is-open")) {
            setOpen(panel, btn, false);
        }
    });

    onFavoritesChange((f) => {
        favorites = f;
        if (panel.classList.contains("is-open")) renderPanel(panel);
    });
}

initPanel(document.getElementById("jumpto-btn"), document.getElementById("jumpto-panel"));
