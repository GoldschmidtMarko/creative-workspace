// Club Overview page. get_club_roster resolves a free-text club name (or an
// already-known cl_code) to a season's roster across all three disciplines;
// get_club_teams derives one season's worth of that club's teams + real
// league standings by reusing get_player_leagues under the hood (see
// functions/app/scraping/clubs.py). Only the current season (slot 0) is
// fetched eagerly, right after the club resolves — its result feeds both
// the top-of-page stat tiles and the Teams tab's first column. The two
// prior seasons (slot 1/2) are fetched only when their column is clicked,
// since each slot costs roughly one dbv request per resolved player.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions } from "./util/firebase.js";
import { mountFavoriteStar, onFavoritesChange } from "./util/favorites.js";
import { bindSearchForm } from "./util/search-form.js";

const getClubRoster = httpsCallable(functions, "get_club_roster", { timeout: 60000 });
const getClubTeams = httpsCallable(functions, "get_club_teams", { timeout: 120000 });

const DISC_LABEL = { Einzel: "Singles", Doppel: "Doubles", Mixed: "Mixed" };

const $ = (id) => document.getElementById(id);
function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

const skelRows = (n) => Array.from({ length: n }, () => `<div class="skel skel-block" style="height:46px;margin-bottom:0.5rem"></div>`).join("");
const skelTiles = (n) => Array.from({ length: n }, () => `<div class="skel skel-block" style="height:56px;flex:1;min-width:100px"></div>`).join("");

const state = {
    club: null,            // {cl_code, name}
    season: null,
    seasons: [],           // [current, -1, -2] season labels, from the roster call
    categories: { Einzel: [], Doppel: [], Mixed: [] },
    activeCat: "Doppel",
    activePlayers: null,
    // Teams, per season slot (0 = current, 1/2 = prior): null = not
    // requested yet, {loading:true}, {season, teams}, or {error}.
    teamsSlots: [null, null, null],
    rosterSort: { key: "bax", dir: "desc" },
};

const params = new URLSearchParams(location.search);
const initial = {
    clCode: (params.get("cl_code") || "").trim(),
    q: (params.get("q") || "").trim(),
};
const yearEl = $("copyright-year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

if (initial.clCode) {
    showClubView();
    loadClub({ cl_code: initial.clCode });
} else if (initial.q) {
    $("search-q").value = initial.q;
    showSearchView();
    resolveOrSearch(initial.q);
} else {
    showSearchView();
}

bindSearchForm("search-form", "search-q", (value) => {
    const q = value.trim();
    if (q.length < 2) return;
    history.replaceState(null, "", location.pathname + "?q=" + encodeURIComponent(q));
    resolveOrSearch(q);
});

function showSearchView() {
    $("club-view").classList.add("hidden");
    $("error-view").classList.add("hidden");
    $("search-view").classList.remove("hidden");
    const ph = $("page-header"); if (ph) ph.classList.remove("hidden");
}

function showClubView() {
    $("search-view").classList.add("hidden");
    $("error-view").classList.add("hidden");
    $("club-view").classList.remove("hidden");
    const ph = $("page-header"); if (ph) ph.classList.add("hidden");
    $("c-name").innerHTML = `<span class="skel skel-line" style="display:inline-block;width:220px;height:1.4rem;border-radius:6px"></span>`;
    $("c-meta").innerHTML = "";
    $("c-stats").innerHTML = skelTiles(3);
    $("roster-body").innerHTML = skelRows(4);
    $("teams-body").innerHTML = `<div class="skeleton"><span class="spinner"></span> Resolving players' league history… this can take a moment.</div>`;
    state.teamsSlots = [null, null, null];
}

function showError(msg) {
    $("search-view").classList.add("hidden");
    $("club-view").classList.add("hidden");
    $("error-view").classList.remove("hidden");
    $("error-msg").textContent = msg;
}

/* A free-text club search either resolves straight into the club view (the
   common case — most searches are specific enough) or, if ambiguous, falls
   back to a candidate list the same way player search shows results. */
async function resolveOrSearch(q) {
    const st = $("search-status");
    st.textContent = "Searching…";
    st.classList.remove("hidden");
    $("search-results").innerHTML = "";
    try {
        const res = await getClubRoster({ query: q });
        const data = res.data || {};
        if (data.error) { st.textContent = data.error; return; }
        if (data.resolved === false) {
            st.classList.add("hidden");
            renderCandidates(data.candidates || [], q);
            return;
        }
        showClubView();
        applyRoster(data);
    } catch (err) {
        console.error("club search failed:", err);
        st.textContent = "Search failed: " + err.message;
    }
}

function renderCandidates(list, q) {
    const box = $("search-results");
    if (!list.length) {
        $("search-status").textContent = `No club found for “${q}”.`;
        $("search-status").classList.remove("hidden");
        return;
    }
    box.innerHTML = list.map((c) => `
        <a class="search-result" href="/html/club.html?cl_code=${encodeURIComponent(c.cl_code)}" data-cl-code="${escapeHtml(c.cl_code)}">
            <span class="search-result__avatar">${escapeHtml((c.name || "?").slice(0, 2).toUpperCase())}</span>
            <span class="search-result__body">
                <span class="search-result__name">${escapeHtml(c.name || "Club")}</span>
            </span>
            <i data-lucide="chevron-right" class="search-result__chev"></i>
        </a>`).join("");
    if (window.lucide) lucide.createIcons();
    box.querySelectorAll("a[data-cl-code]").forEach((a) => {
        a.addEventListener("click", (e) => {
            e.preventDefault();
            const clCode = a.getAttribute("data-cl-code");
            history.replaceState(null, "", location.pathname + "?cl_code=" + encodeURIComponent(clCode));
            showClubView();
            loadClub({ cl_code: clCode });
        });
    });
}

// Starred clubs, shown above the search results the same way player.html
// surfaces "Favorite players" — a quick way back into a club without typing
// its name again. Only relevant on the search view (hidden once a club is
// resolved), and only for a signed-in user with at least one starred club.
function renderFavoriteClubs(favorites) {
    const wrap = $("favorite-clubs-wrap");
    if (!wrap) return;
    const entries = Object.entries((favorites && favorites.club) || {});
    if (!entries.length) { wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    $("favorite-clubs").innerHTML = entries
        .sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""))
        .map(([clCode, f]) => `
            <a class="search-result" href="/html/club.html?cl_code=${encodeURIComponent(clCode)}" data-cl-code="${escapeHtml(clCode)}">
                <span class="search-result__avatar">${escapeHtml((f.name || "?").slice(0, 2).toUpperCase())}</span>
                <span class="search-result__body">
                    <span class="search-result__name">${escapeHtml(f.name || "Club")}</span>
                </span>
                <i data-lucide="chevron-right" class="search-result__chev"></i>
            </a>`).join("");
    if (window.lucide) lucide.createIcons();
    $("favorite-clubs").querySelectorAll("a[data-cl-code]").forEach((a) => {
        a.addEventListener("click", (e) => {
            e.preventDefault();
            const clCode = a.getAttribute("data-cl-code");
            history.replaceState(null, "", location.pathname + "?cl_code=" + encodeURIComponent(clCode));
            showClubView();
            loadClub({ cl_code: clCode });
        });
    });
}
onFavoritesChange(renderFavoriteClubs);

async function loadClub(payload) {
    try {
        const res = await getClubRoster(payload);
        const data = res.data || {};
        if (data.error) throw new Error(data.error);
        if (data.resolved === false) {
            // Only reachable if someone hand-edits the URL to an ambiguous query.
            showSearchView();
            renderCandidates(data.candidates || [], payload.query || "");
            return;
        }
        applyRoster(data);
    } catch (err) {
        console.error("loadClub failed:", err);
        showError(err.message || String(err));
    }
}

function applyRoster(data) {
    const isNewClub = !state.club || state.club.cl_code !== data.club.cl_code;
    state.club = data.club;
    state.season = data.season;
    if (data.seasons) state.seasons = data.seasons;
    state.categories = data.categories || { Einzel: [], Doppel: [], Mixed: [] };
    state.activePlayers = data.active_players != null ? data.active_players : null;
    history.replaceState(null, "", location.pathname + "?cl_code=" + encodeURIComponent(state.club.cl_code));
    renderIdentity();
    renderSeasonSelect();
    renderRoster();
    if (isNewClub) {
        state.teamsSlots = [null, null, null];
        renderClubStats();
        loadTeamsSlot(0);   // current season only — the other two load on click
    } else {
        renderClubStats();
    }
}

/* One season's teams (slot 0 = current, fetched eagerly; 1/2 = prior,
   fetched only when their Teams-tab column is clicked). Slot 0 also feeds
   the top-of-page stat tiles. */
async function loadTeamsSlot(slot) {
    state.teamsSlots[slot] = { loading: true };
    if (slot === 0) renderClubStats();
    renderTeams();
    try {
        const res = await getClubTeams({ cl_code: state.club.cl_code, slot });
        const data = res.data || {};
        if (data.error) throw new Error(data.error);
        state.teamsSlots[slot] = { season: data.season, teams: data.teams || [] };
    } catch (err) {
        console.error(`get_club_teams (slot ${slot}) failed:`, err);
        state.teamsSlots[slot] = { error: err.message };
    }
    if (slot === 0) renderClubStats();
    renderTeams();
}

function renderIdentity() {
    $("c-name").textContent = state.club.name || "Club";
    if (state.club.name) document.title = `${state.club.name} | BAX Checker`;
    $("c-meta").innerHTML = `<code>${escapeHtml(state.club.cl_code)}</code>`;
    mountFavoriteStar($("c-star"), {
        type: "club", id: state.club.cl_code, name: state.club.name || "Club",
        label: { off: "Star", on: "Starred" },
    });
}

function renderSeasonSelect() {
    const sel = $("season-select");
    sel.innerHTML = state.seasons.map((s) =>
        `<option value="${escapeHtml(s)}" ${s === state.season ? "selected" : ""}>${escapeHtml(s)}</option>`).join("");
}

/* Top-of-page KPIs — deliberately all scoped to the CURRENT season only
   (active players from the roster call; team count + best rank from
   get_club_teams's slot 0), even once a prior season gets loaded in the
   Teams tab below. "Best" = the club's highest-league team (lowest tier
   number), tie-broken by its own numeric rank. */
function renderClubStats() {
    const box = $("c-stats");
    const activeTile = `
        <div class="stat">
            <div class="stat__label">Active Players</div>
            <div class="stat__value">${state.activePlayers != null ? state.activePlayers : "—"}</div>
        </div>`;

    const slot0 = state.teamsSlots[0];
    if (!slot0 || slot0.loading) {
        box.innerHTML = activeTile + skelTiles(2);
        return;
    }
    if (slot0.error || !slot0.teams.length) {
        box.innerHTML = activeTile + `
            <div class="stat"><div class="stat__label">Teams</div><div class="stat__value">—</div><div class="stat__sub">${slot0.error ? "could not load" : "no league data found"}</div></div>`;
        return;
    }
    const best = slot0.teams.slice().sort((a, b) =>
        (a.tier ?? 99) - (b.tier ?? 99) || (parseInt(a.standing, 10) || 99) - (parseInt(b.standing, 10) || 99)
    )[0];
    box.innerHTML = activeTile + `
        <div class="stat">
            <div class="stat__label">Teams &middot; ${escapeHtml(slot0.season || "")}</div>
            <div class="stat__value">${slot0.teams.length}</div>
        </div>
        <div class="stat">
            <div class="stat__label">Best rank &middot; ${escapeHtml(slot0.season || "")}</div>
            <div class="stat__value">${best && best.standing ? "#" + escapeHtml(best.standing) : "—"}</div>
            <div class="stat__sub" title="${best ? escapeHtml(best.division || "") : ""}">${best ? escapeHtml([best.abbr, best.division].filter(Boolean).join(" · ")) : ""}</div>
        </div>`;
}

/* Sortable roster columns — one shared sort applied to both gender tables,
   so they always read in the same order. */
const ROSTER_SORT_VALUE = {
    name: (r) => `${r.last_name} ${r.first_name}`.trim().toLowerCase(),
    born: (r) => (r.birth_year != null ? r.birth_year : -Infinity),
    wl: (r) => (r.won != null ? r.won : -Infinity),
    winrate: (r) => (r.winrate != null ? r.winrate : -Infinity),
    bax: (r) => (r.bax != null ? r.bax : -Infinity),
};
function compareRosterRows(a, b) {
    const { key, dir } = state.rosterSort;
    const va = ROSTER_SORT_VALUE[key](a);
    const vb = ROSTER_SORT_VALUE[key](b);
    const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return dir === "asc" ? cmp : -cmp;
}
function sortHeader(label, key, extraClass) {
    const active = state.rosterSort.key === key;
    const arrow = active ? `<span class="sort-arrow">${state.rosterSort.dir === "asc" ? "▲" : "▼"}</span>` : "";
    return `<th class="${extraClass || ""}${active ? " is-sorted" : ""}" data-sort="${key}">${label}${arrow}</th>`;
}

function rosterTableHtml(rows) {
    return `
        <div style="overflow-x:auto;">
        <table class="club-roster">
            <thead><tr>
                ${sortHeader("Name", "name")}
                ${sortHeader("Born", "born", "is-num")}
                ${sortHeader("W–L", "wl", "is-num")}
                ${sortHeader("Win rate", "winrate")}
                ${sortHeader("BAX", "bax", "is-num")}
            </tr></thead>
            <tbody>
                ${rows.map((r) => {
        const fullName = `${r.first_name} ${r.last_name}`.trim();
        const wl = (r.won != null && r.lost != null) ? `${r.won}–${r.lost}` : "—";
        const wr = r.winrate != null ? `${r.winrate}%` : "—";
        // Green for a winning record, red for a losing one — mirrors the
        // Teams tab's W/D/L coloring (won === lost stays neutral ink).
        const wrClass = r.won == null || r.lost == null ? "" : r.won > r.lost ? "wr-pos" : r.won < r.lost ? "wr-neg" : "";
        // sp_code (see clubs._parse_roster_rows) takes the reader straight
        // to the player's profile, same as tournament.js's playerLinkAttrs
        // — falls back to a name search only for the rare row without one.
        const qp = r.sp_code ? new URLSearchParams({ sp: r.sp_code, name: fullName }) : new URLSearchParams({ q: fullName });
        return `<tr>
                        <td><a class="roster-name" href="/html/player.html?${qp.toString()}">${escapeHtml(fullName)}</a></td>
                        <td class="is-num">${r.birth_year != null ? r.birth_year : "—"}</td>
                        <td class="is-num">${wl}</td>
                        <td>${r.winrate != null ? `<span class="winrate-bar"><span class="${wrClass}" style="width:${Math.min(100, r.winrate)}%"></span></span>` : ""}<span class="${wrClass}">${wr}</span></td>
                        <td class="is-num">${r.bax != null ? r.bax : "—"}</td>
                    </tr>`;
    }).join("")}
            </tbody>
        </table>
        </div>`;
}

function renderRoster() {
    const all = (state.categories[state.activeCat] || []).slice().sort(compareRosterRows);
    const body = $("roster-body");
    if (!all.length) {
        body.innerHTML = `<div class="pl-empty">No ${DISC_LABEL[state.activeCat].toLowerCase()} players found for ${escapeHtml(state.season || "this season")}.</div>`;
        return;
    }
    const women = all.filter((r) => r.gender === "w");
    const men = all.filter((r) => r.gender === "m");
    const other = all.filter((r) => r.gender !== "w" && r.gender !== "m");
    const groups = [
        ["Women", women, "w"], ["Men", men, "m"], ["Other", other, "o"],
    ].filter(([, rows]) => rows.length);
    body.innerHTML = `<div class="roster-groups">${groups.map(([label, rows, mod]) => `
        <div class="roster-group">
            <div class="roster-group__title roster-group__title--${mod}">${escapeHtml(label)} &middot; ${rows.length}</div>
            ${rosterTableHtml(rows)}
        </div>`).join("")}</div>`;
}

// Event delegation: #roster-body itself persists across renders even though
// its innerHTML (and every <th>) is replaced each time.
$("roster-body").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (!th) return;
    const key = th.getAttribute("data-sort");
    if (state.rosterSort.key === key) {
        state.rosterSort.dir = state.rosterSort.dir === "asc" ? "desc" : "asc";
    } else {
        state.rosterSort = { key, dir: key === "name" ? "asc" : "desc" };
    }
    renderRoster();
});

$("season-select").addEventListener("change", async (e) => {
    const season = e.target.value;
    $("roster-body").innerHTML = skelRows(4);
    try {
        const res = await getClubRoster({ cl_code: state.club.cl_code, season });
        const data = res.data || {};
        if (data.error) throw new Error(data.error);
        state.season = data.season;
        state.categories = data.categories || { Einzel: [], Doppel: [], Mixed: [] };
        renderRoster();
    } catch (err) {
        console.error("season switch failed:", err);
        $("roster-body").innerHTML = `<div class="pl-empty">Could not load: ${escapeHtml(err.message)}</div>`;
    }
});

document.querySelectorAll("#roster-disc [data-cat]").forEach((btn) => {
    btn.addEventListener("click", () => {
        state.activeCat = btn.getAttribute("data-cat");
        document.querySelectorAll("#roster-disc [data-cat]").forEach((b) => b.classList.toggle("active", b === btn));
        renderRoster();
    });
});

/* ------------------------------------------------------------------ */
/* Teams tab — a team x season heatmap (see loadTeams for the fetch).  */
/* ------------------------------------------------------------------ */

function slotColumnLabel(slot) {
    const data = state.teamsSlots[slot];
    if (data && data.season) return data.season;
    if (state.seasons[slot]) return state.seasons[slot];   // roster-derived preview, before this slot's own fetch resolves it
    return slot === 0 ? "Current" : `${slot} season${slot > 1 ? "s" : ""} back`;
}

/* Explicit, labeled W/D/L — a bare "7-4-3" doesn't say which number is
   which (feedback: "not clear from the numbers what win loss and draw
   are"). Returns {html, plain} — plain is a short string for the title
   tooltip / other non-HTML contexts. */
function renderTeamsRecord(t) {
    if (t.won == null && t.lost == null) return null;
    const w = t.won != null ? t.won : 0;
    const d = t.drawn != null ? t.drawn : 0;
    const l = t.lost != null ? t.lost : 0;
    const html = `<span class="club-team-grid__wdl">
        <span><b class="w">${w}</b><span class="club-team-grid__wdl-label">W</span></span>
        <span><b class="d">${d}</b><span class="club-team-grid__wdl-label">D</span></span>
        <span><b class="l">${l}</b><span class="club-team-grid__wdl-label">L</span></span>
    </span>`;
    return { html, plain: `${w}W ${d}D ${l}L` };
}

function renderTeams() {
    const el = $("teams-body");
    const slot0 = state.teamsSlots[0];
    const anyLoaded = state.teamsSlots.some((s) => s && s.teams);
    if ((!slot0 || slot0.loading) && !anyLoaded) {
        el.innerHTML = `<div class="skeleton"><span class="spinner"></span> Resolving players' league history… this can take a moment.</div>`;
        return;
    }
    if (!anyLoaded) {
        el.innerHTML = slot0 && slot0.error
            ? `<div class="pl-empty">Could not load team history: ${escapeHtml(slot0.error)}</div>`
            : '<div class="pl-empty">No league team data found for this club’s current roster.</div>';
        return;
    }

    // Column order left(current, slot 0) -> right(oldest, slot 2) — the
    // current season sits right next to the team name; older seasons expand
    // rightward as they're added (feedback: "have the newest league more
    // right" meant *leftmost*, immediately after the team column). Only
    // ever-activated slots become columns — an inactive prior season is a
    // small "+ Add previous season" button below the table, not a big empty
    // placeholder column (feedback: "the other leagues ... not too visible").
    const columns = [0, 1, 2].filter((slot) => state.teamsSlots[slot] !== null);

    const byTeam = new Map();   // dedupe key -> { name, bySlot: { [slot]: teamRow } }
    columns.forEach((slot) => {
        const data = state.teamsSlots[slot];
        (data && data.teams ? data.teams : []).forEach((t) => {
            // Team name is the natural key for lining up the same team
            // across seasons, but a club can field the same squad number in
            // more than one competition at once — league + cup — with the
            // exact same name (confirmed live). When that collides within a
            // single slot, disambiguate by URL instead of letting the
            // second entry silently clobber the first in the map.
            let key = t.team;
            if (byTeam.has(key) && byTeam.get(key).bySlot[slot]) {
                key = `${t.team}__${t.url || t.abbr || slot}`;
            }
            if (!byTeam.has(key)) byTeam.set(key, { name: t.team, bySlot: {} });
            byTeam.get(key).bySlot[slot] = t;
        });
    });

    const rows = Array.from(byTeam.values()).map(({ name, bySlot }) => {
        const bestTier = Math.min(99, ...Object.values(bySlot).map((t) => (t.tier != null ? t.tier : 99)));
        return { name, bySlot, bestTier };
    }).sort((a, b) => a.bestTier - b.bestTier || a.name.localeCompare(b.name));

    // Season columns split whatever's left after the (fixed-width) team
    // column, so 1 or 2 activated seasons don't leave a stray, near-empty
    // stretch of table before the next "+ Add" button.
    const seasonColWidth = (72 / columns.length).toFixed(2);
    const headCells = columns.map((slot) => {
        const data = state.teamsSlots[slot];   // never null — columns already filters those out
        const label = escapeHtml(slotColumnLabel(slot));
        const style = ` style="width:${seasonColWidth}%"`;
        if (data.loading) return `<th${style}>${label}<br><span class="spinner" style="width:0.8em;height:0.8em;"></span></th>`;
        if (data.error) return `<th${style}><button type="button" class="club-team-grid__load" data-slot="${slot}" title="${escapeHtml(data.error)}">Retry ${label}</button></th>`;
        return `<th${style}>${label}</th>`;
    }).join("");

    const bodyRows = rows.map((r) => {
        const cells = columns.map((slot) => {
            const data = state.teamsSlots[slot];
            const t = r.bySlot[slot];
            if (t) {
                const tag = t.abbr ? `<span class="league-tag">${escapeHtml(t.abbr)}</span>` : "";
                const record = renderTeamsRecord(t);
                const title = [t.division, record ? record.plain : null, t.url ? "Open on dbv.turnier.de" : null]
                    .filter(Boolean).join(" · ");
                const pillTag = t.url ? "a" : "span";
                const pillAttrs = t.url ? ` href="${escapeHtml(t.url)}" target="_blank" rel="noopener"` : "";
                return `<td class="club-team-grid__cell">
                    <${pillTag} class="club-team-grid__pill" title="${escapeHtml(title)}"${pillAttrs}>
                        <span class="club-team-grid__pill-top">${tag}<span class="club-team-grid__rank">${t.standing ? "#" + escapeHtml(t.standing) : "—"}</span></span>
                        ${record ? record.html : ""}
                    </${pillTag}>
                </td>`;
            }
            // Not (yet) loaded for this slot vs. genuinely absent that season.
            return (data && data.teams)
                ? `<td class="club-team-grid__cell"><span class="club-team-grid__empty">–</span></td>`
                : `<td class="club-team-grid__cell"><span class="club-team-grid__empty">·</span></td>`;
        }).join("");
        // Team name links to whichever loaded season is most recent for
        // this row (columns is current-first) — a team page is inherently
        // season-scoped, so there's no single URL that covers every season.
        const anyTeam = columns.map((slot) => r.bySlot[slot]).find((t) => t && t.url);
        const nameInner = escapeHtml(r.name);
        const nameCell = anyTeam
            ? `<a class="club-team-grid__name" href="${escapeHtml(anyTeam.url)}" target="_blank" rel="noopener" title="${escapeHtml(r.name)} — open on dbv.turnier.de">${nameInner}</a>`
            : `<span class="club-team-grid__name" title="${escapeHtml(r.name)}">${nameInner}</span>`;
        return `<tr><td>${nameCell}</td>${cells}</tr>`;
    }).join("");

    // The next not-yet-activated slot (if any) gets one small, deliberately
    // low-key button rather than a whole extra placeholder column (feedback:
    // "the other leagues ... not too visible ... just add a small button").
    const nextSlot = [1, 2].find((slot) => state.teamsSlots[slot] === null);

    el.innerHTML = `
        <div class="club-team-grid-wrap">
            <table class="club-team-grid">
                <thead><tr><th>Team</th>${headCells}</tr></thead>
                <tbody>${bodyRows}</tbody>
            </table>
        </div>
        ${nextSlot !== undefined ? `
        <button type="button" class="btn btn-ghost btn-sm club-team-grid__add" data-slot="${nextSlot}">
            <i data-lucide="plus" style="width:14px;height:14px;"></i> Add previous season
        </button>` : ""}`;

    el.querySelectorAll(".club-team-grid__load, .club-team-grid__add").forEach((btn) => {
        btn.addEventListener("click", () => {
            const slot = parseInt(btn.getAttribute("data-slot"), 10);
            loadTeamsSlot(slot);
        });
    });
    if (window.lucide) lucide.createIcons();
}

document.querySelectorAll(".subnav__tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        document.querySelectorAll(".subnav__tab").forEach((t) => t.classList.toggle("is-active", t === tab));
        const name = tab.getAttribute("data-tab");
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("is-active", p.getAttribute("data-panel") === name));
    });
});
