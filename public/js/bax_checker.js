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

const getBaxData = httpsCallable(functions, 'get_player_bax_data', { timeout: 120000 });

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

checkBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) {
        alert("Please enter a valid tournament URL.");
        return;
    }

    const jobId = `job_${Date.now()}`;
    const stopTracking = trackProgress(jobId);

    // UI State: Loading
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
        }, 500);
        
    } catch (error) {
        stopTracking();
        console.error("Scraping failed:", error);
        alert("Scraping failed: " + error.message);
        loader.style.display = 'none';
    } finally {
        checkBtn.disabled = false;
    }
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

function renderChart(players) {
    const chartBody = document.getElementById('chart-body');
    chartBody.innerHTML = '';
    
    // 1. Group and Aggregate Data
    const groupsMap = {};
    players.forEach(p => {
        if (!groupsMap[p.group]) {
            groupsMap[p.group] = { 
                id: p.group, 
                members: [], 
                einzel: p.Sum_Einzel, 
                doppel: p.Sum_Doppel, 
                mixed: p.Sum_Mixed,
                total: p.Sum_Einzel + p.Sum_Doppel + p.Sum_Mixed
            };
        }
        groupsMap[p.group].members.push({
            name: p.full_name,
            einzel: p.Einzel,
            doppel: p.Doppel,
            mixed: p.Mixed,
            total: p.Einzel + p.Doppel + p.Mixed
        });
    });

    let sortedGroups = Object.values(groupsMap);

    // 2. Sort groups based on selected discipline (Leaderboard logic)
    if (currentDiscipline === 'all') {
        sortedGroups.sort((a, b) => b.total - a.total);
    } else {
        const key = currentDiscipline.toLowerCase();
        sortedGroups.sort((a, b) => b[key] - a[key]);
    }

    // 3. Find global max for scaling
    const maxVal = Math.max(...sortedGroups.flatMap(g => [g.einzel, g.doppel, g.mixed]), 100);

    // 4. Render Rows
    sortedGroups.forEach(g => {
        const row = document.createElement('div');
        row.className = 'chart-row';
        
        // Build names with individual BAX
        const namesHtml = g.members.map(m => {
            let val = 0;
            if (currentDiscipline === 'all') val = Math.round(m.total);
            else val = Math.round(m[currentDiscipline.toLowerCase()]);
            return `${m.name} <span style="opacity: 0.5; font-size: 0.65rem;">(${val})</span>`;
        }).join('<br>');
        
        let barsHtml = '';
        const categories = [
            { id: 'Einzel', val: g.einzel, class: 'bar-einzel' },
            { id: 'Doppel', val: g.doppel, class: 'bar-doppel' },
            { id: 'Mixed',  val: g.mixed,  class: 'bar-mixed' }
        ];

        categories.forEach(cat => {
            if (currentDiscipline === 'all' || currentDiscipline === cat.id) {
                barsHtml += `
                    <div class="bar-row">
                        <span class="bar-label">${cat.id}</span>
                        <div class="bar-track"><div class="bar-fill ${cat.class}" style="width: 0%" data-target="${(cat.val / maxVal) * 100}"></div></div>
                        <span class="bar-value">${Math.round(cat.val)}</span>
                    </div>
                `;
            }
        });

        row.innerHTML = `
            <div class="group-info">
                <h4 style="margin: 0; color: white; font-size: 0.8rem; line-height: 1.1;">${namesHtml}</h4>
                <div>
                    <span style="font-size: 0.6rem; color: var(--text-muted); font-weight: 700;">GRP ${g.id}</span>
                </div>
            </div>
            <div class="bar-container">${barsHtml}</div>
        `;
        chartBody.appendChild(row);

        // Animate
        requestAnimationFrame(() => {
            row.querySelectorAll('.bar-fill').forEach(fill => {
                fill.style.width = `${fill.getAttribute('data-target')}%`;
            });
        });
    });
}
