import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { getFirestore, onSnapshot, doc, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { firebaseConfig } from "./util/firebaseConfig.js";

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const functions = getFunctions(app);
const db = getFirestore(app);

// Use Emulator if running locally to avoid CORS issues
if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    console.log("Connecting to local Emulators...");
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

const getBaxData = httpsCallable(functions, 'get_player_bax_data', { timeout: 540000 });
const findTournaments = httpsCallable(functions, 'find_tournaments', { timeout: 60000 });
const getDisciplines = httpsCallable(functions, 'get_tournament_disciplines', { timeout: 60000 });
const renderChartFn = httpsCallable(functions, 'render_bax_chart', { timeout: 60000 });

// DOM Elements
const urlInput = document.getElementById('tournament-url');
const checkBtn = document.getElementById('check-btn');
const loader = document.getElementById('loader');
const viewControls = document.getElementById('view-controls');
const resultsContainer = document.getElementById('results-container');
const chartContainer = document.getElementById('chart-container');
const resultsTableBody = document.querySelector('#results-table tbody');
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

// Default URL for convenience
urlInput.value = "https://dbv.turnier.de/sport/event.aspx?id=1EB702E0-4333-44F8-BBEB-FE5DE2E91269&event=62";

// View Toggling
toggleTableBtn.addEventListener('click', () => switchView('table'));
toggleChartBtn.addEventListener('click', () => switchView('chart'));
disciplineFilter.addEventListener('change', (e) => {
    currentDiscipline = e.target.value;
    updateDisplay();
});

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

async function runAnalysis(url) {
    if (!url) {
        alert("Please enter a valid tournament URL.");
        return;
    }

    const jobId = `job_${Date.now()}`;
    const stopTracking = trackProgress(jobId);

    // New analysis — invalidate any cached chart from the previous run.
    chartCache = {};

    // UI State: Loading — reveal the (separate) results card
    resultsCard.classList.remove('hidden');
    checkBtn.disabled = true;
    loader.style.display = 'block';
    resultsContainer.style.display = 'none';
    chartContainer.style.display = 'none';
    viewControls.style.display = 'none';
    resultsTableBody.innerHTML = '';
    chartBody.innerHTML = '';

    try {
        const result = await getBaxData({ url, job_id: jobId });
        if (result.data.error) throw new Error(result.data.error);

        // Finish progress
        stopTracking();
        progressBar.style.width = '100%';
        loaderText.innerText = "Analysis Complete!";

        setTimeout(() => {
            currentPlayers = result.data.players;
            viewControls.style.display = 'flex';
            updateDisplay();
            loader.style.display = 'none';
            // Collapse the input card so results take focus (still re-openable).
            setFold(true);
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
    runAnalysis(urlInput.value.trim());
});

function renderResults(players) {
    let lastGroupId = null;
    let groupCount = 0;
    resultsTableBody.innerHTML = '';

    // Handle column visibility
    const headers = document.querySelectorAll('#results-table th');
    const disciplineCols = {
        'Einzel': [4, 7], // 0-indexed: Individual, Team
        'Doppel': [5, 8],
        'Mixed': [6, 9]
    };

    headers.forEach((th, i) => {
        if (i < 4) return; // Keep Grp, Status, Name, ID
        if (currentDiscipline === 'all') {
            th.style.display = '';
        } else {
            const isMatch = disciplineCols[currentDiscipline].includes(i);
            th.style.display = isMatch ? '' : 'none';
        }
    });

    players.forEach(player => {
        const tr = document.createElement('tr');
        const isNewGroup = player.group !== lastGroupId;
        if (isNewGroup) {
            tr.classList.add('new-group');
            groupCount++;
            lastGroupId = player.group;
        }
        if (groupCount % 2 === 0) tr.classList.add('group-even');

        tr.innerHTML = `
            <td data-label="Group" style="font-weight: bold; color: var(--text-muted);">${player.group}</td>
            <td data-label="Status"><span class="status-badge">${player.status}</span></td>
            <td data-label="Player" style="font-weight: 500;">${player.full_name}</td>
            <td data-label="ID" style="font-family: monospace; color: var(--text-muted); font-size: 0.75rem;">${player.id}</td>
            
            <td data-label="Einzel" class="bax-val" data-col="Einzel">${Math.round(player.Einzel)}</td>
            <td data-label="Doppel" class="bax-val" data-col="Doppel">${Math.round(player.Doppel)}</td>
            <td data-label="Mixed" class="bax-val" data-col="Mixed">${Math.round(player.Mixed)}</td>
            
            <td data-label="Team Einzel" class="team-sum-val" data-col="Sum_Einzel">${Math.round(player.Sum_Einzel)}</td>
            <td data-label="Team Doppel" class="team-sum-val" data-col="Sum_Doppel">${Math.round(player.Sum_Doppel)}</td>
            <td data-label="Team Mixed" class="team-sum-val" data-col="Sum_Mixed">${Math.round(player.Sum_Mixed)}</td>
        `;

        // Filter cells
        tr.querySelectorAll('td[data-col]').forEach(td => {
            const colType = td.getAttribute('data-col').replace('Sum_', '');
            if (currentDiscipline !== 'all' && colType !== currentDiscipline) {
                td.style.display = 'none';
            }
        });

        resultsTableBody.appendChild(tr);
    });
}

// The chart is now rendered server-side (matplotlib) and served as a PNG.
// We cache the last rendered image per theme so toggling views is instant,
// and re-render when the theme changes.
let chartCache = {};      // theme -> data URI
let chartRenderToken = 0; // guards against out-of-order async responses

function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

async function renderChart(players) {
    const chartBody = document.getElementById('chart-body');
    if (!players || !players.length) {
        chartBody.innerHTML = '<div class="browse-status">No data to plot.</div>';
        return;
    }

    const theme = currentTheme();
    if (chartCache[theme]) {
        chartBody.innerHTML = `<img class="bax-chart-img" alt="Team BAX chart" src="${chartCache[theme]}">`;
        return;
    }

    const token = ++chartRenderToken;
    chartBody.innerHTML = '<div class="browse-status"><span class="spinner"></span> Rendering chart…</div>';
    try {
        const res = await renderChartFn({ players, theme, title: currentChartTitle });
        if (res.data.error) throw new Error(res.data.error);
        chartCache[theme] = res.data.image;
        if (token === chartRenderToken && currentView === 'chart') {
            chartBody.innerHTML = `<img class="bax-chart-img" alt="Team BAX chart" src="${res.data.image}">`;
        }
    } catch (err) {
        console.error('Chart render failed:', err);
        chartBody.innerHTML = `<div class="browse-status">Could not render chart: ${escapeHtml(err.message)}</div>`;
    }
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

async function searchTournaments() {
    searchBtn.disabled = true;
    tournamentList.innerHTML = '';
    setStatus('Searching tournaments…');
    try {
        const payload = {
            q: filterQ.value.trim(),
            start_date: filterStart.value,
            end_date: filterEnd.value,
            postal_code: filterPlz.value.trim(),
            distance: Number(filterDistance.value),
            registration_only: filterRegOpen.checked,
            page: 1,
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

searchBtn.addEventListener('click', searchTournaments);
[filterQ, filterPlz].forEach((el) => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchTournaments();
}));

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
        const res = await getDisciplines({ id: tournament.id });
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
            setMode('url');
            currentChartTitle = `${d.name} · ${tournament.name}`;
            urlInput.value = d.url;
            runAnalysis(d.url);
        });
        disciplineListEl.appendChild(item);
    });
    if (window.lucide) lucide.createIcons();
}

// Re-render the server-side chart when the theme changes, so its colours match.
new MutationObserver(() => {
    if (currentView === 'chart' && currentPlayers.length) {
        renderChart(currentPlayers);
    }
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
