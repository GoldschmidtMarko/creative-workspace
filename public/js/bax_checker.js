import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { onSnapshot, doc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { functions, db } from "./util/firebase.js";

const getBaxData = httpsCallable(functions, 'get_player_bax_data', { timeout: 540000 });
const findTournaments = httpsCallable(functions, 'find_tournaments', { timeout: 60000 });
const getDisciplines = httpsCallable(functions, 'get_tournament_disciplines', { timeout: 60000 });

// DOM Elements
const urlInput = document.getElementById('tournament-url');
const checkBtn = document.getElementById('check-btn');
const loader = document.getElementById('loader');
const viewControls = document.getElementById('view-controls');
const resultsContainer = document.getElementById('results-container');
const chartContainer = document.getElementById('chart-container');
const resultsGrid = document.getElementById('results-grid');
const chartBody = document.getElementById('chart-body');
const toggleTableBtn = document.getElementById('toggle-table');
const toggleChartBtn = document.getElementById('toggle-chart');

const disciplineFilter = document.getElementById('discipline-filter');

const progressBar = document.getElementById('progress-bar');
const loaderStage = document.getElementById('loader-stage');
const loaderText = document.getElementById('loader-text');

let currentPlayers = [];
let currentDiscipline = 'all';
let currentView = 'table';
let progressInterval = null;
let currentChartTitle = '';   // set when analysis is launched (tournament · discipline)

// Admin-only shortcut to the usage dashboard. This visibility check is a
// client-side convenience only — the dashboard is enforced server-side by the
// get_usage_stats admin allow-list — so it just shows/hides the link.
// On localhost (the emulator) any signed-in account may see it, mirroring the
// backend's emulator bypass; in production only the admin email does.
const ADMIN_EMAIL = 'mgoldschmidt01@gmail.com';
const IS_DEV_HOST = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const usageLink = document.getElementById('usage-link');
function updateUsageLink(user) {
    const allowed = !!user && (IS_DEV_HOST || user.email === ADMIN_EMAIL);
    if (usageLink) usageLink.classList.toggle('hidden', !allowed);
}
document.addEventListener('authchange', (e) => updateUsageLink(e.detail && e.detail.user));
updateUsageLink(window.currentUser);   // handle the case where auth already resolved

// Default URL for convenience
urlInput.value = "https://dbv.turnier.de/sport/event.aspx?id=1EB702E0-4333-44F8-BBEB-FE5DE2E91269&event=62";

// View Toggling
toggleTableBtn.addEventListener('click', () => switchView('table'));
toggleChartBtn.addEventListener('click', () => switchView('chart'));
disciplineFilter.addEventListener('change', (e) => {
    currentDiscipline = e.target.value;
    updateDisplay();
});

// Map a tournament discipline name (e.g. "HD-B", "GD U15", "Mixed Elite",
// "HE Elite") to the results filter value (Einzel / Doppel / Mixed / all).
// German codes: H/D = Herren/Damen, J/M = Jungen/Mädchen (youth);
// second letter E = Einzel (singles), D = Doppel (doubles); GD/MX = Mixed.
function disciplineToFilter(name) {
    const n = (name || '').toLowerCase();
    const code = (name || '').match(/^\s*([A-Za-z]+)/);
    const c = code ? code[1].toUpperCase() : '';
    if (n.includes('mixed') || c === 'MX' || c === 'GD') return 'Mixed';
    if (n.includes('doppel') || c.endsWith('D')) return 'Doppel';   // HD, DD, JD, MD
    if (n.includes('einzel') || c.endsWith('E')) return 'Einzel';   // HE, DE, JE, ME
    return 'all';
}

// Set the discipline dropdown + current filter together.
function setDisciplineFilter(value) {
    currentDiscipline = value;
    if (disciplineFilter) disciplineFilter.value = value;
}

// English display labels. Internal keys stay German to match the BAX/tournament
// data sources; only what the user sees is translated.
const DISC_LABEL = { Einzel: 'Singles', Doppel: 'Doubles', Mixed: 'Mixed', all: 'All' };
function disciplineLabel(key) { return DISC_LABEL[key] || key; }

// Translate a scraped German entry status to English for display.
function statusLabel(status) {
    const s = String(status || '').trim();
    const m = s.match(/Nachr[üu]ckerliste\s*(\d+)/i);
    if (m) return `Reserve ${m[1]}`;
    if (/nachr[üu]cker/i.test(s)) return 'Reserve';
    if (/warteliste/i.test(s)) return 'Waiting list';
    if (/starterliste/i.test(s)) return 'Starter';
    return s;
}

function switchView(view) {
    currentView = view;
    updateDisplay();
}

function updateDisplay() {
    if (currentView === 'table') {
        resultsContainer.style.display = 'block';
        chartContainer.style.display = 'none';
        toggleTableBtn.classList.add('active');
        toggleChartBtn.classList.remove('active');
        renderResults(currentPlayers);
    } else {
        resultsContainer.style.display = 'none';
        chartContainer.style.display = 'block';
        toggleTableBtn.classList.remove('active');
        toggleChartBtn.classList.add('active');
        renderChart(currentPlayers);
    }
}

function trackProgress(jobId) {
    progressBar.style.width = '0%';
    loaderText.innerText = "Initializing job...";
    loaderStage.innerText = "Stage 1/4: Connecting";

    // Listen to the job document for real-time updates
    const unsub = onSnapshot(doc(db, "jobs", jobId), (snap) => {
        if (!snap.exists()) return;
        
        const data = snap.data();
        const total = data.total_players || 0;
        const processed = data.processed_players || 0;
        
        if (total > 0) {
            const percent = Math.min(Math.round((processed / total) * 100), 98);
            progressBar.style.width = `${percent}%`;
            loaderText.innerText = `Scraping player ${processed} of ${total}...`;
            loaderStage.innerText = `Stage 3/4: Processing (${percent}%)`;
        } else {
            loaderText.innerText = "Fetching player list...";
            loaderStage.innerText = "Stage 2/4: Indexing";
        }

        if (data.status === 'completed') {
            unsub(); // Stop listening
        }
    });

    return unsub;
}

// Foldable input card
const inputCard = document.getElementById('input-card');
const foldToggle = document.getElementById('fold-toggle');
const resultsCard = document.getElementById('results-card');

function setFold(collapsed) {
    inputCard.classList.toggle('collapsed', collapsed);
    foldToggle.setAttribute('aria-expanded', String(!collapsed));
}
foldToggle.addEventListener('click', () => setFold(!inputCard.classList.contains('collapsed')));

// Client-side result cache: an already-analyzed discipline URL renders straight
// from memory — no backend call, no cost, no rate-limit hit. Cleared on reload.
const analysisCache = new Map();

function showResults(players) {
    resultsCard.classList.remove('hidden');
    setFold(true);
    currentPlayers = players;
    viewControls.style.display = 'flex';
    loader.style.display = 'none';
    updateDisplay();
}

// The analysis currently on screen, so the "Update Live" button can re-run it
// with force (bypassing every cache).
let currentAnalysis = null;

async function runAnalysis(url, meta = {}) {
    if (!url) {
        alert("Please enter a valid tournament URL.");
        return;
    }
    currentAnalysis = { url, meta };
    const force = !!meta.force;

    // Reuse a previously-computed result for this exact discipline URL — unless
    // the user asked for a live update, which drops the cached copy.
    if (force) {
        analysisCache.delete(url);
    } else if (analysisCache.has(url)) {
        showResults(analysisCache.get(url));
        return;
    }

    const jobId = `job_${Date.now()}`;
    const stopTracking = trackProgress(jobId);

    // UI State: Loading — reveal the (separate) results card and collapse the
    // input card so results take focus as soon as fetching starts.
    resultsCard.classList.remove('hidden');
    setFold(true);
    checkBtn.disabled = true;
    loader.style.display = 'block';
    resultsContainer.style.display = 'none';
    chartContainer.style.display = 'none';
    viewControls.style.display = 'none';
    resultsGrid.innerHTML = '';
    chartBody.innerHTML = '';

    try {
        const result = await getBaxData({
            url, job_id: jobId,
            source: meta.source || 'url',
            tournament_name: meta.tournamentName || '',
            discipline_name: meta.disciplineName || '',
            tournament_start: meta.tournamentStart || '',
            force,
        });
        if (result.data.error) throw new Error(result.data.error);

        // Finish progress
        stopTracking();
        progressBar.style.width = '100%';
        loaderText.innerText = "Analysis Complete!";

        setTimeout(() => {
            analysisCache.set(url, result.data.players);
            showResults(result.data.players);
        }, 500);

    } catch (error) {
        stopTracking();
        console.error("Scraping failed:", error);
        alert("Scraping failed: " + error.message);
        loader.style.display = 'none';
    } finally {
        checkBtn.disabled = false;
    }
}

checkBtn.addEventListener('click', () => {
    currentChartTitle = 'Team BAX by group';
    setDisciplineFilter('all');   // pasted URL — discipline unknown
    categoryBar.classList.add('hidden');   // no tournament category context
    runAnalysis(urlInput.value.trim(), { source: 'url' });
});

// "Update Live" (analysis view) — re-run the current analysis, bypassing every
// cache. Backend rate-limits the force path, so misuse just returns a message.
const updateLiveBtn = document.getElementById('update-live-btn');
if (updateLiveBtn) {
    updateLiveBtn.addEventListener('click', () => {
        if (!currentAnalysis) return;
        runAnalysis(currentAnalysis.url, { ...currentAnalysis.meta, force: true });
    });
}

// A player is "waiting" (not in the active participating set) when their entry
// status is anything other than the Starterliste — e.g. Warteliste or
// Nachrückerliste (reserves waiting to move up).
function isWaitlisted(status) {
    return !!status && !/starter/i.test(String(status));
}

// A player name links straight to the unified Player Insights page — a plain
// href, so a left-click navigates there in the same tab and a ctrl/cmd/middle
// click opens it in a new tab, no JS needed. Guests/foreign players with no id
// fall back to their DBV entry link (there is no player page for them).
function playerLinkAttrs(m) {
    const hasSp = m.id && m.id !== 'N/A';
    if (hasSp || m.profile_id) {
        const q = new URLSearchParams();
        if (m.profile_id) q.set('pid', m.profile_id);
        if (hasSp) q.set('sp', m.id);
        if (m.full_name) q.set('name', m.full_name);
        return `href="${escapeHtml('/html/player.html?' + q.toString())}"`;
    }
    return `href="${escapeHtml(m.profile_url || '#')}" target="_blank" rel="noopener"`;
}

// A chip per league the player played this season (e.g. "VL" "BL").
function leagueTagsHtml(m) {
    if (!m.leagues || !m.leagues.length) return '';
    return m.leagues.map(l => {
        const title = [l.division, l.team, l.record].filter(Boolean).join(' · ');
        return `<span class="league-tag" title="${escapeHtml(title)}">${escapeHtml(l.abbr)}</span>`;
    }).join('');
}

function renderResults(players) {
    resultsGrid.innerHTML = '';

    // Group players into teams (one per starting group), carrying the team sums
    // and the entry status.
    const teams = {};
    players.forEach(p => {
        if (!teams[p.group]) {
            teams[p.group] = {
                group: p.group, members: [], status: p.status || '',
                Einzel: p.Sum_Einzel || 0, Doppel: p.Sum_Doppel || 0, Mixed: p.Sum_Mixed || 0
            };
        }
        teams[p.group].members.push(p);
    });

    // Sort teams by the selected discipline's team BAX (or total) — matches the chart.
    const metric = t => currentDiscipline === 'all'
        ? t.Einzel + t.Doppel + t.Mixed
        : t[currentDiscipline];
    const sorted = Object.values(teams).sort((a, b) => metric(b) - metric(a));

    // Active participants first (ranked), waiting/reserve teams after.
    const starters = sorted.filter(t => !isWaitlisted(t.status));
    const waiters = sorted.filter(t => isWaitlisted(t.status));

    const discs = ['Einzel', 'Doppel', 'Mixed'];
    const metricLabel = currentDiscipline === 'all' ? 'Total' : currentDiscipline;

    const renderCard = (team, rank) => {
        const waiting = isWaitlisted(team.status);
        const card = document.createElement('div');
        card.className = 'team-card'
            + (waiting ? ' team-card--waiting' : '')
            + (rank === 1 ? ' team-card--top' : '');

        const membersHtml = team.members.map(m => {
            const val = currentDiscipline === 'all'
                ? (m.Einzel + m.Doppel + m.Mixed)
                : m[currentDiscipline];
            const name = escapeHtml(m.full_name);
            return `<div class="tm"><span class="tm__lead">` +
                   `<a class="tm__name player-link" ${playerLinkAttrs(m)}>${name}</a>${leagueTagsHtml(m)}` +
                   `</span><span class="tm__val">${Math.round(val)}</span></div>`;
        }).join('');

        const chipsHtml = discs.map(d => {
            const active = currentDiscipline === d ? ' active' : '';
            return `<span class="team-chip${active}" title="${disciplineLabel(d)}"><span class="team-chip__k">${disciplineLabel(d)[0]}</span>${Math.round(team[d])}</span>`;
        }).join('');

        // Left side of the head: a rank number for starters, the (English)
        // status label (e.g. "Reserve 1") for waiting teams.
        const headLeft = waiting
            ? `<span class="waiting-tag">${escapeHtml(statusLabel(team.status))}</span>`
            : `<span class="rank-badge">${rank}</span>`;

        card.innerHTML = `
            <div class="team-card__head">
                <div class="team-card__head-left">${headLeft}</div>
                <span class="team-card__metric" title="${metricLabel} team BAX">${Math.round(metric(team))}</span>
            </div>
            <div class="team-card__members">${membersHtml}</div>
            <div class="team-card__stats">${chipsHtml}</div>
        `;
        resultsGrid.appendChild(card);
    };

    let rank = 0;
    starters.forEach(team => renderCard(team, ++rank));
    waiters.forEach(team => renderCard(team, null));
}

/* The chart is drawn client-side as inline SVG — vector, so it stays crisp at
 * any zoom/DPI, recolors instantly on theme toggle (colors come from CSS
 * variables), and needs no backend round-trip. */

const DISC_CLASS = { Einzel: 'bar-einzel', Doppel: 'bar-doppel', Mixed: 'bar-mixed' };

// Round an axis maximum up to a tidy value so bars fill the plot well.
function niceMax(v) {
    if (v <= 0) return 1;
    const base = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / base;
    const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    return (steps.find(s => n <= s) || 10) * base;
}

function renderChart(players) {
    const chartBody = document.getElementById('chart-body');
    if (!players || !players.length) {
        chartBody.innerHTML = '<div class="browse-status">No data to plot.</div>';
        return;
    }

    // Aggregate players into teams, carrying sums + status.
    const teams = {};
    players.forEach(p => {
        if (!teams[p.group]) {
            teams[p.group] = {
                members: [], status: p.status || '',
                Einzel: p.Sum_Einzel || 0, Doppel: p.Sum_Doppel || 0, Mixed: p.Sum_Mixed || 0
            };
        }
        teams[p.group].members.push(p);
    });

    const grouped = currentDiscipline === 'all';
    const discs = grouped ? ['Einzel', 'Doppel', 'Mixed'] : [currentDiscipline];
    const metric = t => grouped ? t.Einzel + t.Doppel + t.Mixed : t[currentDiscipline];
    const all = Object.values(teams);
    const starters = all.filter(t => !isWaitlisted(t.status)).sort((a, b) => metric(b) - metric(a));
    const waiters = all.filter(t => isWaitlisted(t.status)).sort((a, b) => metric(b) - metric(a));
    const rows = starters.concat(waiters);

    // Layout in SVG user units (the SVG scales to the container width).
    const W = 900, padL = 260, padR = 48, padT = 6, padB = 26;
    const plotW = W - padL - padR;
    const lineH = 17, barThick = grouped ? 11 : 18, barGap = 3, rowPad = 14;
    const groupH = grouped ? discs.length * barThick + (discs.length - 1) * barGap : barThick;

    let yc = padT;
    rows.forEach(r => {
        const nameH = Math.max(1, r.members.length) * lineH;
        r._h = Math.max(nameH, groupH) + rowPad;
        r._y = yc;
        yc += r._h;
    });
    const plotBottom = yc;
    const H = yc + padB;

    const rawMax = Math.max(1, ...rows.flatMap(r => discs.map(d => r[d])));
    const axisMax = niceMax(rawMax);
    const xs = v => (v / axisMax) * plotW;

    // Gridlines + x tick labels.
    const ticks = 4;
    let grid = '';
    for (let i = 0; i <= ticks; i++) {
        const tv = axisMax * i / ticks;
        const x = padL + xs(tv);
        grid += `<line class="chart-grid" x1="${x}" y1="${padT}" x2="${x}" y2="${plotBottom}"/>`;
        grid += `<text class="chart-tick" x="${x}" y="${plotBottom + 16}" text-anchor="middle">${Math.round(tv)}</text>`;
    }

    // Rows: stacked member names + bars + value labels.
    let body = '';
    rows.forEach(r => {
        const waiting = isWaitlisted(r.status);
        const nameCls = waiting ? 'chart-name waiting' : 'chart-name';
        const namesTotalH = r.members.length * lineH;
        const nameY0 = r._y + (r._h - rowPad - namesTotalH) / 2 + lineH * 0.72;
        let names = '';
        r.members.forEach((m, mi) => {
            const ty = nameY0 + mi * lineH;
            const rightX = padL - 10;
            let inner = '';
            let nameEnd = rightX;
            // One chip per league, flush against the bars in order; the name is
            // right-aligned just left of them, reading "name → VL BL".
            const leagues = m.leagues || [];
            if (leagues.length) {
                const gap = 3, chipH = 13, chipY = ty - 10.5;
                const widths = leagues.map(l => String(l.abbr).length * 6.2 + 9);
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
            // Truncate to fit the space left of the chips (SVG has no ellipsis).
            const maxChars = Math.max(6, Math.floor((nameEnd - 4) / 6.3));
            let display = m.full_name || '';
            if (display.length > maxChars) display = display.slice(0, maxChars - 1) + '…';
            inner += `<text class="${nameCls}" x="${nameEnd}" y="${ty}" text-anchor="end">${escapeHtml(display)}</text>`;
            names += `<a class="player-link" ${playerLinkAttrs(m)}>${inner}</a>`;
        });

        const barsTop = r._y + (r._h - rowPad - groupH) / 2;
        let bars = '';
        discs.forEach((d, di) => {
            const val = r[d];
            const w = Math.max(0, xs(val));
            const by = grouped ? barsTop + di * (barThick + barGap) : barsTop;
            const tip = `${r.members.map(m => m.full_name).join(' / ')} — ${disciplineLabel(d)}: ${Math.round(val)}`;
            bars += `<rect class="bar ${DISC_CLASS[d]}${waiting ? ' waiting' : ''}" x="${padL}" y="${by}" ` +
                    `width="${w}" height="${barThick}" rx="3" data-tip="${escapeHtml(tip)}"></rect>`;
            if (val > 0) {
                bars += `<text class="chart-val" x="${padL + w + 5}" y="${by + barThick * 0.78}">${Math.round(val)}</text>`;
            }
        });
        body += names + bars;
    });

    // Legend (HTML for crisp native text).
    let legend = '';
    if (grouped) {
        legend += discs.map(d =>
            `<span class="lg"><span class="lg-sw" style="background:var(--disc-${d.toLowerCase()})"></span>${disciplineLabel(d)}</span>`
        ).join('');
    }
    if (waiters.length) {
        legend += `<span class="lg"><span class="lg-sw lg-sw--waiting"></span>Reserve</span>`;
    }

    const titleHtml = currentChartTitle ? `<div class="chart-heading">${escapeHtml(currentChartTitle)}</div>` : '';
    const xlabel = grouped ? 'Team BAX (summed per group)'
                           : `${disciplineLabel(currentDiscipline)} — team BAX (summed per group)`;

    chartBody.innerHTML = `
        <div class="chart-header">${titleHtml}<div class="chart-legend">${legend}</div></div>
        <div class="chart-svg-wrap">
            <svg class="bax-svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Team BAX chart">
                ${grid}${body}
            </svg>
            <div class="chart-tooltip hidden"></div>
        </div>
        <div class="chart-xlabel">${escapeHtml(xlabel)}</div>
    `;

    // Hover tooltip.
    const wrap = chartBody.querySelector('.chart-svg-wrap');
    const svg = wrap.querySelector('.bax-svg');
    const tip = wrap.querySelector('.chart-tooltip');
    svg.addEventListener('mousemove', e => {
        const el = e.target.closest('[data-tip]');
        if (!el) { tip.classList.add('hidden'); return; }
        tip.textContent = el.getAttribute('data-tip');
        tip.classList.remove('hidden');
        const box = wrap.getBoundingClientRect();
        tip.style.left = (e.clientX - box.left + 12) + 'px';
        tip.style.top = (e.clientY - box.top + 12) + 'px';
    });
    svg.addEventListener('mouseleave', () => tip.classList.add('hidden'));
}

/* ---------------------------------------------------------------------------
 * Tournament browsing: tabs, filters, results, discipline modal
 * ------------------------------------------------------------------------- */

// Tab switching (Paste URL | Browse)
const tabUrl = document.getElementById('tab-url');
const tabBrowse = document.getElementById('tab-browse');
const modeUrl = document.getElementById('mode-url');
const modeBrowse = document.getElementById('mode-browse');

function setMode(mode) {
    const browse = mode === 'browse';
    tabBrowse.classList.toggle('active', browse);
    tabUrl.classList.toggle('active', !browse);
    modeBrowse.classList.toggle('hidden', !browse);
    modeUrl.classList.toggle('hidden', browse);
}
tabUrl.addEventListener('click', () => { setMode('url'); setFold(false); });
tabBrowse.addEventListener('click', () => { setMode('browse'); setFold(false); });

// Filter inputs
const filterQ = document.getElementById('filter-q');
const filterStart = document.getElementById('filter-start');
const filterEnd = document.getElementById('filter-end');
const filterPlz = document.getElementById('filter-plz');
const filterDistance = document.getElementById('filter-distance');
const filterRegOpen = document.getElementById('filter-reg-open');
const searchBtn = document.getElementById('search-btn');
const browseStatus = document.getElementById('browse-status');
const tournamentList = document.getElementById('tournament-list');

// Default the date range to today .. +3 months.
(function initDates() {
    const today = new Date();
    const later = new Date();
    later.setMonth(later.getMonth() + 3);
    const iso = (d) => d.toISOString().slice(0, 10);
    filterStart.value = iso(today);
    filterEnd.value = iso(later);
})();

function setStatus(msg) {
    if (!msg) {
        browseStatus.classList.add('hidden');
        return;
    }
    browseStatus.textContent = msg;
    browseStatus.classList.remove('hidden');
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

async function searchTournaments(force = false) {
    searchBtn.disabled = true;
    tournamentList.innerHTML = '';
    setStatus(force ? 'Fetching live tournament listings…' : 'Searching tournaments…');
    try {
        const payload = {
            q: filterQ.value.trim(),
            start_date: filterStart.value,
            end_date: filterEnd.value,
            postal_code: filterPlz.value.trim(),
            distance: Number(filterDistance.value),
            registration_only: filterRegOpen.checked,
            page: 1,
            force,
        };
        const res = await findTournaments(payload);
        if (res.data.error) throw new Error(res.data.error);
        renderTournaments(res.data.tournaments || []);
    } catch (err) {
        console.error('Tournament search failed:', err);
        setStatus('Search failed: ' + err.message);
    } finally {
        searchBtn.disabled = false;
    }
}

function renderTournaments(tournaments) {
    if (!tournaments.length) {
        setStatus('No tournaments found for these filters.');
        return;
    }
    setStatus(`${tournaments.length} tournament${tournaments.length === 1 ? '' : 's'} found.`);
    tournamentList.innerHTML = '';

    tournaments.forEach((t) => {
        const card = document.createElement('div');
        card.className = 'tournament-card';

        const dateText = t.start
            ? (t.end && t.end !== t.start
                ? `${formatDate(t.start)} – ${formatDate(t.end)}`
                : formatDate(t.start))
            : (t.date_text || '');

        const tags = [];
        if (t.tag) tags.push(`<span class="mini-tag">${escapeHtml(t.tag)}</span>`);
        if (t.registration_open) {
            tags.push(`<span class="mini-tag mini-tag--open">Registration open${t.deadline ? ' · ' + escapeHtml(t.deadline) : ''}</span>`);
        }

        const logo = t.logo
            ? `<img class="tournament-card__logo" src="${escapeHtml(t.logo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
            : `<div class="tournament-card__logo"></div>`;

        card.innerHTML = `
            ${logo}
            <div class="tournament-card__body">
                <div class="tournament-card__name">${escapeHtml(t.name)}</div>
                <div class="tournament-card__meta">
                    ${t.city ? `<span>📍 ${escapeHtml(t.city)}</span>` : ''}
                    ${dateText ? `<span>📅 ${escapeHtml(dateText)}</span>` : ''}
                </div>
                <div class="tournament-card__tags">${tags.join('')}</div>
            </div>
        `;
        card.addEventListener('click', () => openDisciplineModal(t));
        tournamentList.appendChild(card);
    });
}

function formatDate(iso) {
    // iso is YYYY-MM-DD
    const parts = iso.split('-');
    if (parts.length !== 3) return iso;
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

searchBtn.addEventListener('click', () => searchTournaments(false));
[filterQ, filterPlz].forEach((el) => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchTournaments(false);
}));

// "Update Live" (browse) — re-run the search bypassing the listings cache.
const browseUpdateLiveBtn = document.getElementById('browse-update-live-btn');
if (browseUpdateLiveBtn) {
    browseUpdateLiveBtn.addEventListener('click', () => searchTournaments(true));
}

/* --- Discipline modal --- */
const disciplineModal = document.getElementById('discipline-modal');
const modalTitle = document.getElementById('modal-title');
const modalSubtitle = document.getElementById('modal-subtitle');
const modalClose = document.getElementById('modal-close');
const disciplineListEl = document.getElementById('discipline-list');

function closeModal() {
    disciplineModal.classList.add('hidden');
}
modalClose.addEventListener('click', closeModal);
disciplineModal.addEventListener('click', (e) => {
    if (e.target === disciplineModal) closeModal();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !disciplineModal.classList.contains('hidden')) closeModal();
});

async function openDisciplineModal(tournament) {
    modalTitle.textContent = tournament.name;
    modalSubtitle.textContent = [tournament.city, tournament.date_text].filter(Boolean).join(' · ');
    disciplineListEl.innerHTML = '<div class="browse-status">Loading disciplines…</div>';
    disciplineModal.classList.remove('hidden');

    try {
        const res = await getDisciplines({ id: tournament.id, name: tournament.name || '' });
        if (res.data.error) throw new Error(res.data.error);
        renderDisciplines(res.data.disciplines || [], tournament);
    } catch (err) {
        console.error('Failed to load disciplines:', err);
        disciplineListEl.innerHTML = `<div class="browse-status">Could not load disciplines: ${escapeHtml(err.message)}</div>`;
    }
}

function renderDisciplines(disciplines, tournament) {
    if (!disciplines.length) {
        disciplineListEl.innerHTML = '<div class="browse-status">No disciplines published for this tournament yet.</div>';
        return;
    }
    disciplineListEl.innerHTML = '';
    disciplines.forEach((d) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'discipline-item';
        item.innerHTML = `<span>${escapeHtml(d.name)}</span><i data-lucide="chevron-right"></i>`;
        item.addEventListener('click', () => {
            closeModal();
            selectCategory(tournament, disciplines, d);
        });
        disciplineListEl.appendChild(item);
    });
    if (window.lucide) lucide.createIcons();
}

/* --- Persistent category (tournament discipline) selector -------------------
 * After a tournament + discipline is picked, keep the tournament's full
 * discipline list on screen so the user can switch to another category
 * without going back through Browse → modal. */
const categoryBar = document.getElementById('category-bar');
const categoryTournament = document.getElementById('category-tournament');
const categorySelect = document.getElementById('category-select');
let activeDisciplines = [];
let activeTournamentName = '';
let activeTournamentStart = '';

function runCategory(d) {
    currentChartTitle = `${d.name} · ${activeTournamentName}`;
    setDisciplineFilter(disciplineToFilter(d.name));   // default the BAX filter
    urlInput.value = d.url;
    runAnalysis(d.url, {
        source: 'browse', tournamentName: activeTournamentName,
        disciplineName: d.name, tournamentStart: activeTournamentStart,
    });
}

function selectCategory(tournament, disciplines, d) {
    activeTournamentName = tournament.name;
    activeTournamentStart = tournament.start || '';
    activeDisciplines = disciplines;
    categoryTournament.textContent = tournament.name;
    categorySelect.innerHTML = disciplines
        .map(x => `<option value="${escapeHtml(x.url)}">${escapeHtml(x.name)}</option>`).join('');
    categorySelect.value = d.url;
    categoryBar.classList.remove('hidden');
    runCategory(d);
}

categorySelect.addEventListener('change', () => {
    const d = activeDisciplines.find(x => x.url === categorySelect.value);
    if (d) runCategory(d);
});
