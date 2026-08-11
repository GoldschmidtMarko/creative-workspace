// Shareable tournament page. URL: tournament.html?id=<GUID>[&event=<N>][&name&start&end&city].
// Loads the tournament's disciplines, then ranks each discipline's field by BAX.
// The event in the URL is the deep-link — copy it to share a specific discipline.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { onSnapshot, doc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { functions, db } from "./util/firebase.js";

const getBaxData = httpsCallable(functions, "get_player_bax_data", { timeout: 540000 });
const getDisciplines = httpsCallable(functions, "get_tournament_disciplines", { timeout: 60000 });

const $ = (id) => document.getElementById(id);
const loader = $("loader");
const progressBar = $("progress-bar");
const loaderText = $("loader-text");
const loaderStage = $("loader-stage");
const viewControls = $("view-controls");
const resultsContainer = $("results-container");
const chartContainer = $("chart-container");
const resultsGrid = $("results-grid");
const chartBody = $("chart-body");
const toggleTableBtn = $("toggle-table");
const toggleChartBtn = $("toggle-chart");
const disciplineFilter = $("discipline-filter");
const emptyState = $("empty-state");
const disciplineBar = $("discipline-bar");

const params = new URLSearchParams(location.search);
const tournamentId = (params.get("id") || "").toUpperCase();
const qName = params.get("name") || "";
const qStart = params.get("start") || "";
const qEnd = params.get("end") || "";
const qCity = params.get("city") || "";

let disciplines = [];
let tournamentName = qName || "Tournament";
let tournamentStart = qStart || "";
let currentPlayers = [];
let currentDiscipline = "all";
let currentView = "table";
let currentChartTitle = "";
let currentAnalysis = null;
const analysisCache = new Map();

/* ---------------- helpers (shared look with the tournament tool) --------- */
function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}
const DISC_LABEL = { Einzel: "Singles", Doppel: "Doubles", Mixed: "Mixed", all: "All" };
function disciplineLabel(k) { return DISC_LABEL[k] || k; }
function disciplineToFilter(name) {
    const n = (name || "").toLowerCase();
    const c = ((name || "").match(/^\s*([A-Za-z]+)/) || [, ""])[1].toUpperCase();
    if (n.includes("mixed") || c === "MX" || c === "GD") return "Mixed";
    if (n.includes("doppel") || c.endsWith("D")) return "Doppel";
    if (n.includes("einzel") || c.endsWith("E")) return "Einzel";
    return "all";
}
function statusLabel(status) {
    const s = String(status || "").trim();
    const m = s.match(/Nachr[üu]ckerliste\s*(\d+)/i);
    if (m) return `Reserve ${m[1]}`;
    if (/nachr[üu]cker/i.test(s)) return "Reserve";
    if (/warteliste/i.test(s)) return "Waiting list";
    if (/starterliste/i.test(s)) return "Starter";
    return s;
}
function isWaitlisted(status) { return !!status && !/starter/i.test(String(status)); }

// Player name links straight to the unified Player Insights page (same-tab
// left-click, new-tab on ctrl/middle). Guests with no id fall back to DBV.
function playerLinkAttrs(m) {
    const hasSp = m.id && m.id !== "N/A";
    if (hasSp || m.profile_id) {
        const q = new URLSearchParams();
        if (m.profile_id) q.set("pid", m.profile_id);
        if (hasSp) q.set("sp", m.id);
        if (m.full_name) q.set("name", m.full_name);
        // Carry the tournament context so the player page can offer a way back
        // (both to this analysis and to the player's dbv tournament page).
        if (tournamentId) q.set("from_t", tournamentId);
        if (currentAnalysis && currentAnalysis.event) q.set("from_e", currentAnalysis.event);
        if (tournamentName) q.set("from_tn", tournamentName);
        const pl = /[?&]player=(\d+)/i.exec(m.profile_url || "");
        if (pl) q.set("from_pi", pl[1]);
        return `href="${escapeHtml("/html/player.html?" + q.toString())}"`;
    }
    return `href="${escapeHtml(m.profile_url || "#")}" target="_blank" rel="noopener"`;
}
function leagueTagsHtml(m) {
    if (!m.leagues || !m.leagues.length) return "";
    return m.leagues.map((l) => {
        const title = [l.division, l.team, l.record].filter(Boolean).join(" · ");
        return `<span class="league-tag" title="${escapeHtml(title)}">${escapeHtml(l.abbr)}</span>`;
    }).join("");
}

/* ---------------- header + discipline bar -------------------------------- */
function renderHeader(name, start, end, city) {
    $("t-name").textContent = name;
    document.title = `${name} | BAX Checker`;
    const meta = [];
    const dt = start ? (end && end !== start ? `${fmt(start)} – ${fmt(end)}` : fmt(start)) : "";
    if (dt) meta.push(`📅 ${dt}`);
    if (city) meta.push(`📍 ${city}`);
    $("t-meta").innerHTML = meta.map((m) => `<span>${escapeHtml(m)}</span>`).join("");
}
function fmt(iso) {
    if (!iso) return "";
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(iso)) return iso;      // already dd.mm.yyyy
    const p = iso.split("-");
    return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : iso;
}

function renderDisciplineBar() {
    if (!disciplines.length) {
        disciplineBar.innerHTML = '<div class="browse-status" style="padding:0.5rem 0;">No disciplines published for this tournament yet.</div>';
        return;
    }
    disciplineBar.innerHTML = disciplines.map((d) =>
        `<button class="disc-chip" type="button" data-event="${escapeHtml(d.event)}">${escapeHtml(d.name)}</button>`
    ).join("");
    disciplineBar.querySelectorAll("[data-event]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const d = disciplines.find((x) => x.event === btn.getAttribute("data-event"));
            if (d) selectDiscipline(d);
        });
    });
}
function markActiveChip(event) {
    disciplineBar.querySelectorAll(".disc-chip").forEach((b) =>
        b.classList.toggle("is-active", b.getAttribute("data-event") === event));
}

function selectDiscipline(d) {
    markActiveChip(d.event);
    const q = new URLSearchParams({ id: tournamentId, event: d.event });
    if (qName || tournamentName) q.set("name", qName || tournamentName);
    if (qStart) q.set("start", qStart);
    if (qEnd) q.set("end", qEnd);
    if (qCity) q.set("city", qCity);
    history.replaceState(null, "", location.pathname + "?" + q.toString());
    runAnalysis(d);
}

/* ---------------- analysis ---------------------------------------------- */
function trackProgress(jobId) {
    progressBar.style.width = "0%";
    loaderText.innerText = "Initializing job…";
    loaderStage.innerText = "Stage 1/4: Connecting";
    const unsub = onSnapshot(doc(db, "jobs", jobId), (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        const total = data.total_players || 0;
        const processed = data.processed_players || 0;
        if (total > 0) {
            const pct = Math.min(Math.round((processed / total) * 100), 98);
            progressBar.style.width = `${pct}%`;
            loaderText.innerText = `Scraping player ${processed} of ${total}…`;
            loaderStage.innerText = `Stage 3/4: Processing (${pct}%)`;
        } else {
            loaderText.innerText = "Fetching player list…";
            loaderStage.innerText = "Stage 2/4: Indexing";
        }
        if (data.status === "completed") unsub();
    });
    return unsub;
}

function showResults(players) {
    currentPlayers = players;
    loader.style.display = "none";
    emptyState.style.display = "none";
    viewControls.style.display = "flex";
    updateDisplay();
}

async function runAnalysis(disc, force = false) {
    const url = disc.url;
    currentChartTitle = `${disc.name} · ${tournamentName}`;
    setDisciplineFilter(disciplineToFilter(disc.name));
    currentAnalysis = disc;

    if (force) analysisCache.delete(url);
    else if (analysisCache.has(url)) { showResults(analysisCache.get(url)); return; }

    const jobId = `job_${Date.now()}`;
    const stop = trackProgress(jobId);
    emptyState.style.display = "none";
    loader.style.display = "block";
    resultsContainer.style.display = "none";
    chartContainer.style.display = "none";
    viewControls.style.display = "none";
    resultsGrid.innerHTML = "";
    chartBody.innerHTML = "";

    try {
        const res = await getBaxData({
            url, job_id: jobId, source: "browse",
            tournament_name: tournamentName, discipline_name: disc.name,
            tournament_start: tournamentStart, force,
        });
        if (res.data.error) throw new Error(res.data.error);
        stop();
        progressBar.style.width = "100%";
        loaderText.innerText = "Analysis Complete!";
        setTimeout(() => { analysisCache.set(url, res.data.players); showResults(res.data.players); }, 400);
    } catch (err) {
        stop();
        console.error("Scraping failed:", err);
        loader.style.display = "none";
        emptyState.style.display = "block";
        emptyState.textContent = "Scraping failed: " + err.message;
    }
}

const updateLiveBtn = $("update-live-btn");
if (updateLiveBtn) updateLiveBtn.addEventListener("click", () => { if (currentAnalysis) runAnalysis(currentAnalysis, true); });

/* ---------------- view + rendering (ported) ------------------------------ */
toggleTableBtn.addEventListener("click", () => switchView("table"));
toggleChartBtn.addEventListener("click", () => switchView("chart"));
disciplineFilter.addEventListener("change", (e) => { currentDiscipline = e.target.value; updateDisplay(); });
function setDisciplineFilter(v) { currentDiscipline = v; if (disciplineFilter) disciplineFilter.value = v; }
function switchView(v) { currentView = v; updateDisplay(); }
function updateDisplay() {
    if (currentView === "table") {
        resultsContainer.style.display = "block";
        chartContainer.style.display = "none";
        toggleTableBtn.classList.add("active");
        toggleChartBtn.classList.remove("active");
        renderResults(currentPlayers);
    } else {
        resultsContainer.style.display = "none";
        chartContainer.style.display = "block";
        toggleTableBtn.classList.remove("active");
        toggleChartBtn.classList.add("active");
        renderChart(currentPlayers);
    }
}

function renderResults(players) {
    resultsGrid.innerHTML = "";
    const teams = {};
    players.forEach((p) => {
        if (!teams[p.group]) teams[p.group] = { group: p.group, members: [], status: p.status || "", Einzel: p.Sum_Einzel || 0, Doppel: p.Sum_Doppel || 0, Mixed: p.Sum_Mixed || 0 };
        teams[p.group].members.push(p);
    });
    const metric = (t) => currentDiscipline === "all" ? t.Einzel + t.Doppel + t.Mixed : t[currentDiscipline];
    const sorted = Object.values(teams).sort((a, b) => metric(b) - metric(a));
    const starters = sorted.filter((t) => !isWaitlisted(t.status));
    const waiters = sorted.filter((t) => isWaitlisted(t.status));
    const discs = ["Einzel", "Doppel", "Mixed"];
    const metricLabel = currentDiscipline === "all" ? "Total" : currentDiscipline;

    const renderCard = (team, rank) => {
        const waiting = isWaitlisted(team.status);
        const card = document.createElement("div");
        card.className = "team-card" + (waiting ? " team-card--waiting" : "") + (rank === 1 ? " team-card--top" : "");
        const membersHtml = team.members.map((m) => {
            const val = currentDiscipline === "all" ? (m.Einzel + m.Doppel + m.Mixed) : m[currentDiscipline];
            return `<div class="tm"><span class="tm__lead">` +
                `<a class="tm__name player-link" ${playerLinkAttrs(m)}>${escapeHtml(m.full_name)}</a>${leagueTagsHtml(m)}` +
                `</span><span class="tm__val">${Math.round(val)}</span></div>`;
        }).join("");
        const chipsHtml = discs.map((d) => {
            const active = currentDiscipline === d ? " active" : "";
            return `<span class="team-chip${active}" title="${disciplineLabel(d)}"><span class="team-chip__k">${disciplineLabel(d)[0]}</span>${Math.round(team[d])}</span>`;
        }).join("");
        const headLeft = waiting
            ? `<span class="waiting-tag">${escapeHtml(statusLabel(team.status))}</span>`
            : `<span class="rank-badge">${rank}</span>`;
        card.innerHTML = `
            <div class="team-card__head">
                <div class="team-card__head-left">${headLeft}</div>
                <span class="team-card__metric" title="${metricLabel} team BAX">${Math.round(metric(team))}</span>
            </div>
            <div class="team-card__members">${membersHtml}</div>
            <div class="team-card__stats">${chipsHtml}</div>`;
        resultsGrid.appendChild(card);
    };
    let rank = 0;
    starters.forEach((t) => renderCard(t, ++rank));
    waiters.forEach((t) => renderCard(t, null));
}

const DISC_CLASS = { Einzel: "bar-einzel", Doppel: "bar-doppel", Mixed: "bar-mixed" };
function niceMax(v) {
    if (v <= 0) return 1;
    const base = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / base;
    const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    return (steps.find((s) => n <= s) || 10) * base;
}
function renderChart(players) {
    if (!players || !players.length) { chartBody.innerHTML = '<div class="browse-status">No data to plot.</div>'; return; }
    const teams = {};
    players.forEach((p) => {
        if (!teams[p.group]) teams[p.group] = { members: [], status: p.status || "", Einzel: p.Sum_Einzel || 0, Doppel: p.Sum_Doppel || 0, Mixed: p.Sum_Mixed || 0 };
        teams[p.group].members.push(p);
    });
    const grouped = currentDiscipline === "all";
    const discs = grouped ? ["Einzel", "Doppel", "Mixed"] : [currentDiscipline];
    const metric = (t) => grouped ? t.Einzel + t.Doppel + t.Mixed : t[currentDiscipline];
    const all = Object.values(teams);
    const starters = all.filter((t) => !isWaitlisted(t.status)).sort((a, b) => metric(b) - metric(a));
    const waiters = all.filter((t) => isWaitlisted(t.status)).sort((a, b) => metric(b) - metric(a));
    const rows = starters.concat(waiters);

    const W = 900, padL = 260, padR = 48, padT = 6, padB = 26;
    const plotW = W - padL - padR;
    const lineH = 17, barThick = grouped ? 11 : 18, barGap = 3, rowPad = 14;
    const groupH = grouped ? discs.length * barThick + (discs.length - 1) * barGap : barThick;
    let yc = padT;
    rows.forEach((r) => { const nameH = Math.max(1, r.members.length) * lineH; r._h = Math.max(nameH, groupH) + rowPad; r._y = yc; yc += r._h; });
    const plotBottom = yc, H = yc + padB;
    const rawMax = Math.max(1, ...rows.flatMap((r) => discs.map((d) => r[d])));
    const axisMax = niceMax(rawMax);
    const xs = (v) => (v / axisMax) * plotW;

    const ticks = 4;
    let grid = "";
    for (let i = 0; i <= ticks; i++) {
        const tv = axisMax * i / ticks, x = padL + xs(tv);
        grid += `<line class="chart-grid" x1="${x}" y1="${padT}" x2="${x}" y2="${plotBottom}"/>`;
        grid += `<text class="chart-tick" x="${x}" y="${plotBottom + 16}" text-anchor="middle">${Math.round(tv)}</text>`;
    }
    let body = "";
    rows.forEach((r) => {
        const waiting = isWaitlisted(r.status);
        const nameCls = waiting ? "chart-name waiting" : "chart-name";
        const namesTotalH = r.members.length * lineH;
        const nameY0 = r._y + (r._h - rowPad - namesTotalH) / 2 + lineH * 0.72;
        let names = "";
        r.members.forEach((m, mi) => {
            const ty = nameY0 + mi * lineH, rightX = padL - 10;
            let inner = "", nameEnd = rightX;
            const leagues = m.leagues || [];
            if (leagues.length) {
                const gap = 3, chipH = 13, chipY = ty - 10.5;
                const widths = leagues.map((l) => String(l.abbr).length * 6.2 + 9);
                const totalW = widths.reduce((a, b) => a + b, 0) + gap * (leagues.length - 1);
                let x = rightX - totalW;
                leagues.forEach((l, li) => {
                    const abbr = String(l.abbr), cw = widths[li];
                    inner += `<rect class="svg-league-chip" x="${x}" y="${chipY}" width="${cw}" height="${chipH}" rx="6.5"></rect>`;
                    inner += `<text class="svg-league-chip-text" x="${x + cw / 2}" y="${chipY + chipH * 0.74}" text-anchor="middle">${escapeHtml(abbr)}</text>`;
                    x += cw + gap;
                });
                nameEnd = rightX - totalW - 6;
            }
            const maxChars = Math.max(6, Math.floor((nameEnd - 4) / 6.3));
            let display = m.full_name || "";
            if (display.length > maxChars) display = display.slice(0, maxChars - 1) + "…";
            inner += `<text class="${nameCls}" x="${nameEnd}" y="${ty}" text-anchor="end">${escapeHtml(display)}</text>`;
            names += `<a class="player-link" ${playerLinkAttrs(m)}>${inner}</a>`;
        });
        const barsTop = r._y + (r._h - rowPad - groupH) / 2;
        let bars = "";
        discs.forEach((d, di) => {
            const val = r[d], w = Math.max(0, xs(val));
            const by = grouped ? barsTop + di * (barThick + barGap) : barsTop;
            const tip = `${r.members.map((m) => m.full_name).join(" / ")} — ${disciplineLabel(d)}: ${Math.round(val)}`;
            bars += `<rect class="bar ${DISC_CLASS[d]}${waiting ? " waiting" : ""}" x="${padL}" y="${by}" width="${w}" height="${barThick}" rx="3" data-tip="${escapeHtml(tip)}"></rect>`;
            if (val > 0) bars += `<text class="chart-val" x="${padL + w + 5}" y="${by + barThick * 0.78}">${Math.round(val)}</text>`;
        });
        body += names + bars;
    });
    let legend = "";
    if (grouped) legend += discs.map((d) => `<span class="lg"><span class="lg-sw" style="background:var(--disc-${d.toLowerCase()})"></span>${disciplineLabel(d)}</span>`).join("");
    if (waiters.length) legend += `<span class="lg"><span class="lg-sw lg-sw--waiting"></span>Reserve</span>`;
    const titleHtml = currentChartTitle ? `<div class="chart-heading">${escapeHtml(currentChartTitle)}</div>` : "";
    const xlabel = grouped ? "Team BAX (summed per group)" : `${disciplineLabel(currentDiscipline)} — team BAX (summed per group)`;
    chartBody.innerHTML = `
        <div class="chart-header">${titleHtml}<div class="chart-legend">${legend}</div></div>
        <div class="chart-svg-wrap">
            <svg class="bax-svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Team BAX chart">${grid}${body}</svg>
            <div class="chart-tooltip hidden"></div>
        </div>
        <div class="chart-xlabel">${escapeHtml(xlabel)}</div>`;
    const wrap = chartBody.querySelector(".chart-svg-wrap");
    const svg = wrap.querySelector(".bax-svg");
    const tip = wrap.querySelector(".chart-tooltip");
    svg.addEventListener("mousemove", (e) => {
        const el = e.target.closest("[data-tip]");
        if (!el) { tip.classList.add("hidden"); return; }
        tip.textContent = el.getAttribute("data-tip");
        tip.classList.remove("hidden");
        const box = wrap.getBoundingClientRect();
        tip.style.left = (e.clientX - box.left + 12) + "px";
        tip.style.top = (e.clientY - box.top + 12) + "px";
    });
    svg.addEventListener("mouseleave", () => tip.classList.add("hidden"));
}

/* ---------------- share --------------------------------------------------- */
const shareBtn = $("share-btn");
if (shareBtn) shareBtn.addEventListener("click", async () => {
    const label = $("share-label");
    try {
        await navigator.clipboard.writeText(location.href);
        if (label) { label.textContent = "Copied!"; setTimeout(() => (label.textContent = "Share"), 1500); }
    } catch {
        if (navigator.share) navigator.share({ url: location.href }).catch(() => {});
    }
});

/* ---------------- boot ---------------------------------------------------- */
async function boot() {
    if (!/^[0-9A-F-]{36}$/.test(tournamentId)) {
        disciplineBar.innerHTML = '<div class="browse-status">Missing or invalid tournament id.</div>';
        emptyState.innerHTML = 'Open a tournament from <a href="/html/tournaments.html">Tournaments</a>.';
        return;
    }
    renderHeader(tournamentName, qStart, qEnd, qCity);
    try {
        const res = await getDisciplines({ id: tournamentId, name: qName });
        if (res.data.error) throw new Error(res.data.error);
        disciplines = res.data.disciplines || [];
        tournamentName = qName || res.data.name || "Tournament";
        renderHeader(tournamentName, qStart || res.data.start, qEnd || res.data.end, qCity);
        renderDisciplineBar();
        const ev = params.get("event");
        if (ev) {
            const d = disciplines.find((x) => x.event === ev);
            if (d) { markActiveChip(ev); runAnalysis(d); }
        }
    } catch (err) {
        console.error("Failed to load disciplines:", err);
        disciplineBar.innerHTML = `<div class="browse-status">Could not load disciplines: ${escapeHtml(err.message)}</div>`;
    }
}
boot();
