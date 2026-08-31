'use strict';

// ---------------- Utilities ----------------

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || 'Fehler bei ' + path);
    error.status = res.status;
    Object.assign(error, data);
    throw error;
  }
  return data;
}

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.appendChild(c);
  return e;
}

let state = {
  shooters: [],
  disciplines: [],
  eventTitle: '',
};

const dashboardState = {
  snapshot: null,
  disciplineId: null,
  refreshTimer: null,
  rotationTimer: null,
  clockTimer: null,
  isLoading: false,
};

function renderEventTitle() {
  const printEventTitle = document.getElementById('printEventTitle');
  printEventTitle.textContent = state.eventTitle;
  printEventTitle.style.display = state.eventTitle ? '' : 'none';
}

async function loadEventTitle() {
  const season = await api('/api/season');
  state.eventTitle = season.title || '';
  document.getElementById('seasonTitle').value = state.eventTitle;
  renderEventTitle();
}

// ---------------- Tabs ----------------

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'dashboard') startDashboard();
    else stopDashboard();
    if (btn.dataset.tab === 'results') refreshResultSelectors();
    if (btn.dataset.tab === 'rankings') refreshRankingSelector();
    if (btn.dataset.tab === 'season') refreshSeasonInfo();
  });
});

function activateTab(tabName) {
  const button = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (button) button.click();
}

// ---------------- Live Dashboard ----------------

function formatPoints(points) {
  return Number(points).toLocaleString('de-DE', { maximumFractionDigits: 1 });
}

function updateDashboardClock() {
  document.getElementById('dashboardClock').textContent = new Date().toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function setDashboardStatus(online) {
  const status = document.getElementById('dashboardStatus');
  status.classList.toggle('offline', !online);
  status.lastChild.textContent = online ? ' LIVE' : ' VERBINDUNG';
}

function renderDashboardNavigation(disciplines) {
  const nav = document.getElementById('dashboardDisciplineNav');
  nav.innerHTML = '';
  for (const discipline of disciplines) {
    nav.appendChild(el('button', {
      type: 'button',
      class: String(discipline.id) === String(dashboardState.disciplineId) ? 'active' : '',
      text: discipline.name,
      onclick: () => {
        dashboardState.disciplineId = discipline.id;
        renderDashboard();
        scheduleDashboardRotation();
      },
    }));
  }
}

function renderDashboardRanking(discipline) {
  document.getElementById('dashboardDisciplineTitle').textContent = discipline ? discipline.name : 'Noch keine Disziplin';
  const container = document.getElementById('dashboardRanking');
  container.innerHTML = '';

  if (!discipline || !discipline.ranking.length) {
    container.appendChild(el('div', { class: 'dashboard-empty', text: 'Sobald Ergebnisse erfasst sind, erscheint hier die Rangliste.' }));
    return;
  }

  const list = el('ol', { class: 'ranking-list' });
  for (const entry of discipline.ranking.slice(0, 8)) {
    const medal = entry.rank <= 3 ? ` rank-${entry.rank}` : '';
    list.appendChild(el('li', { class: `ranking-row${medal}` }, [
      el('span', { class: 'rank-number', text: entry.rank }),
      el('span', { class: 'rank-name', text: `Nr. ${entry.start_number} – ${entry.name}` }),
      el('span', { class: 'rank-rounds', text: entry.all_rounds.slice(0, 3).map(formatPoints).join(' · ') }),
      el('strong', { class: 'rank-score', text: formatPoints(entry.best_points) }),
    ]));
  }
  container.appendChild(list);
}

function renderLatestResults(results) {
  const container = document.getElementById('dashboardLatestResults');
  container.innerHTML = '';
  if (!results.length) {
    container.appendChild(el('div', { class: 'dashboard-empty', text: 'Die neuesten Wertungen werden hier live eingeblendet.' }));
    return;
  }

  for (const result of results.slice(0, 8)) {
    container.appendChild(el('div', { class: 'result-ticker-row' }, [
      el('div', {}, [
        el('strong', { text: `Nr. ${result.start_number} – ${result.shooter_name}` }),
        el('span', { text: `${result.discipline_name} · Durchgang ${result.round_number}` }),
      ]),
      el('strong', { class: 'result-score', text: formatPoints(result.points) }),
    ]));
  }
}

function renderDashboard() {
  const data = dashboardState.snapshot;
  if (!data) return;
  const disciplines = data.disciplines || [];
  if (!disciplines.some((d) => String(d.id) === String(dashboardState.disciplineId))) {
    dashboardState.disciplineId = disciplines[0] ? disciplines[0].id : null;
  }
  const selected = disciplines.find((d) => String(d.id) === String(dashboardState.disciplineId));

  document.getElementById('dashboardEventTitle').textContent = data.event_title || 'Schützen-Wettkampf';
  document.getElementById('dashboardShooterCount').textContent = data.stats.shooters;
  document.getElementById('dashboardDisciplineCount').textContent = data.stats.disciplines;
  document.getElementById('dashboardResultCount').textContent = data.stats.results;
  document.getElementById('dashboardUpdated').textContent = 'Aktualisiert ' + new Date(data.updated_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  renderDashboardNavigation(disciplines);
  renderDashboardRanking(selected);
  renderLatestResults(data.latest_results || []);
}

async function refreshDashboard() {
  if (dashboardState.isLoading) return;
  dashboardState.isLoading = true;
  try {
    dashboardState.snapshot = await api('/api/dashboard');
    renderDashboard();
    setDashboardStatus(true);
  } catch (err) {
    setDashboardStatus(false);
    document.getElementById('dashboardUpdated').textContent = 'Keine Verbindung – nächster Versuch läuft';
  } finally {
    dashboardState.isLoading = false;
  }
}

function scheduleDashboardRotation() {
  clearInterval(dashboardState.rotationTimer);
  const seconds = Number(document.getElementById('dashboardRotation').value);
  const progress = document.getElementById('dashboardRotationProgress');
  progress.style.setProperty('--rotation-seconds', `${seconds}s`);
  progress.classList.toggle('running', seconds > 0);
  if (!seconds) return;

  dashboardState.rotationTimer = setInterval(() => {
    const disciplines = dashboardState.snapshot?.disciplines || [];
    if (disciplines.length < 2) return;
    const index = disciplines.findIndex((d) => String(d.id) === String(dashboardState.disciplineId));
    dashboardState.disciplineId = disciplines[(index + 1) % disciplines.length].id;
    renderDashboard();
    progress.classList.remove('running');
    void progress.offsetWidth;
    progress.classList.add('running');
  }, seconds * 1000);
}

function startDashboard() {
  clearInterval(dashboardState.refreshTimer);
  clearInterval(dashboardState.clockTimer);
  updateDashboardClock();
  refreshDashboard();
  dashboardState.refreshTimer = setInterval(refreshDashboard, 5000);
  dashboardState.clockTimer = setInterval(updateDashboardClock, 1000);
  scheduleDashboardRotation();
}

function stopDashboard() {
  if (document.body.classList.contains('tv-mode')) return;
  clearInterval(dashboardState.refreshTimer);
  clearInterval(dashboardState.rotationTimer);
  clearInterval(dashboardState.clockTimer);
}

document.getElementById('dashboardRotation').addEventListener('change', scheduleDashboardRotation);
document.getElementById('openTvDashboardBtn').addEventListener('click', () => window.open('/dashboard', '_blank'));
document.getElementById('exitTvDashboardBtn').addEventListener('click', () => { window.location.href = '/'; });

// ---------------- Shooters ----------------

let editingShooterId = null;

async function loadShooters() {
  state.shooters = await api('/api/shooters');
  const body = document.getElementById('shooterTableBody');
  body.innerHTML = '';
  for (const s of state.shooters) {
    body.appendChild(s.id === editingShooterId ? renderShooterEditRow(s) : renderShooterRow(s));
  }
  if (!editingShooterId) await refreshStartNumberSuggestion();
}

async function refreshStartNumberSuggestion() {
  const input = document.getElementById('shooterStartNumber');
  if (document.activeElement === input && input.value) return;
  const suggestion = await api('/api/shooters/next-start-number');
  input.value = suggestion.start_number;
}

function renderShooterRow(s) {
  return el('tr', {}, [
    el('td', { class: 'start-number-cell', text: s.start_number }),
    el('td', { text: s.name }),
    el('td', { text: s.gender === 'w' ? 'weiblich' : 'männlich' }),
    el('td', { class: 'row-actions' }, [
      el('button', {
        class: 'link',
        text: 'Bearbeiten',
        onclick: () => {
          editingShooterId = s.id;
          loadShooters();
        },
      }),
      el('button', {
        class: 'link danger-text',
        text: 'Löschen',
        onclick: async () => {
          if (!confirm(`"${s.name}" wirklich löschen? Auch alle Ergebnisse dieses Schützen werden entfernt.`)) return;
          await api(`/api/shooters/${s.id}`, { method: 'DELETE' });
          loadShooters();
        },
      }),
    ]),
  ]);
}

function renderShooterEditRow(s) {
  const startNumberInput = el('input', { class: 'edit-start-number', type: 'number', min: '1', step: '1', value: s.start_number });
  startNumberInput.value = s.start_number;
  const nameInput = el('input', { type: 'text', value: s.name });
  nameInput.value = s.name;
  const genderSelect = el('select', {}, [
    el('option', { value: 'm', text: 'männlich' }),
    el('option', { value: 'w', text: 'weiblich' }),
  ]);
  genderSelect.value = s.gender;

  const save = async () => {
    const name = nameInput.value.trim();
    const start_number = Number(startNumberInput.value);
    if (!name) { alert('Name darf nicht leer sein.'); return; }
    if (!Number.isSafeInteger(start_number) || start_number < 1) { alert('Die Startnummer muss eine positive ganze Zahl sein.'); return; }
    const payload = { name, gender: genderSelect.value, start_number };
    try {
      await api(`/api/shooters/${s.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      editingShooterId = null;
      loadShooters();
    } catch (error) {
      if (error.code !== 'START_NUMBER_CONFLICT') { alert(error.message); return; }
      const other = error.conflicting_shooter;
      const shouldSwap = confirm(
        `Startnummer ${start_number} gehört bereits ${other.name}.\n\n` +
        `Sollen die Nummern getauscht werden? ${other.name} erhält dann Startnummer ${s.start_number}.`
      );
      if (!shouldSwap) return;
      await api(`/api/shooters/${s.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...payload, conflict_resolution: 'swap' }),
      });
      editingShooterId = null;
      loadShooters();
    }
  };
  const cancel = () => {
    editingShooterId = null;
    loadShooters();
  };
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); });

  return el('tr', {}, [
    el('td', {}, [startNumberInput]),
    el('td', {}, [nameInput]),
    el('td', {}, [genderSelect]),
    el('td', { class: 'row-actions' }, [
      el('button', { text: 'Speichern', onclick: save }),
      el('button', { class: 'link', text: 'Abbrechen', onclick: cancel }),
    ]),
  ]);
}

document.getElementById('shooterForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('shooterName').value.trim();
  const gender = document.getElementById('shooterGender').value;
  const startNumberInput = document.getElementById('shooterStartNumber');
  const start_number = Number(startNumberInput.value);
  if (!name) return;
  if (!Number.isSafeInteger(start_number) || start_number < 1) { alert('Die Startnummer muss eine positive ganze Zahl sein.'); return; }
  try {
    await api('/api/shooters', { method: 'POST', body: JSON.stringify({ name, gender, start_number }) });
    document.getElementById('shooterName').value = '';
    await loadShooters();
    document.getElementById('shooterName').focus();
  } catch (error) {
    if (error.code === 'START_NUMBER_CONFLICT' && error.suggested_start_number) {
      startNumberInput.value = error.suggested_start_number;
      alert(`${error.message}. Als nächste freie Startnummer wurde ${error.suggested_start_number} eingesetzt.`);
      return;
    }
    alert(error.message);
  }
});

// ---------------- Disciplines ----------------

let editingDisciplineId = null;

async function loadDisciplines() {
  state.disciplines = await api('/api/disciplines');
  const body = document.getElementById('disciplineTableBody');
  body.innerHTML = '';
  for (const d of state.disciplines) {
    body.appendChild(d.id === editingDisciplineId ? renderDisciplineEditRow(d) : renderDisciplineRow(d));
  }
}

function renderDisciplineRow(d) {
  return el('tr', {}, [
    el('td', { text: d.name }),
    el('td', { class: 'row-actions' }, [
      el('button', {
        class: 'link',
        text: 'Bearbeiten',
        onclick: () => {
          editingDisciplineId = d.id;
          loadDisciplines();
        },
      }),
      el('button', {
        class: 'link danger-text',
        text: 'Löschen',
        onclick: async () => {
          if (!confirm(`Disziplin "${d.name}" wirklich löschen? Auch alle Ergebnisse dieser Disziplin werden entfernt.`)) return;
          await api(`/api/disciplines/${d.id}`, { method: 'DELETE' });
          loadDisciplines();
        },
      }),
    ]),
  ]);
}

function renderDisciplineEditRow(d) {
  const nameInput = el('input', { type: 'text' });
  nameInput.value = d.name;

  const save = async () => {
    const name = nameInput.value.trim();
    if (!name) { alert('Name darf nicht leer sein.'); return; }
    await api(`/api/disciplines/${d.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
    editingDisciplineId = null;
    loadDisciplines();
  };
  const cancel = () => {
    editingDisciplineId = null;
    loadDisciplines();
  };
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); });

  return el('tr', {}, [
    el('td', {}, [nameInput]),
    el('td', { class: 'row-actions' }, [
      el('button', { text: 'Speichern', onclick: save }),
      el('button', { class: 'link', text: 'Abbrechen', onclick: cancel }),
    ]),
  ]);
}

document.getElementById('disciplineForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('disciplineName').value.trim();
  if (!name) return;
  await api('/api/disciplines', { method: 'POST', body: JSON.stringify({ name }) });
  document.getElementById('disciplineName').value = '';
  loadDisciplines();
});

// ---------------- Results ----------------

function fillSelect(selectEl, items, valueKey, labelFn) {
  selectEl.innerHTML = '';
  for (const item of items) {
    selectEl.appendChild(el('option', { value: item[valueKey], text: labelFn(item) }));
  }
}

async function refreshResultSelectors() {
  if (!state.shooters.length) await loadShooters();
  if (!state.disciplines.length) await loadDisciplines();
  fillSelect(document.getElementById('resultShooterSelect'), state.shooters, 'id', (s) => `Nr. ${s.start_number} – ${s.name}`);
  fillSelect(document.getElementById('resultDisciplineSelect'), state.disciplines, 'id', (d) => d.name);
  await loadResultsList();
}

async function loadResultsList() {
  const shooterId = document.getElementById('resultShooterSelect').value;
  const disciplineId = document.getElementById('resultDisciplineSelect').value;
  const body = document.getElementById('resultTableBody');
  body.innerHTML = '';
  if (!shooterId || !disciplineId) return;
  const results = await api(`/api/results?shooter_id=${shooterId}&discipline_id=${disciplineId}`);
  for (const r of results) {
    body.appendChild(
      el('tr', {}, [
        el('td', { text: r.round_number }),
        el('td', { text: r.points }),
        el('td', {}, [
          el('button', {
            class: 'link danger-text',
            text: 'Löschen',
            onclick: async () => {
              await api(`/api/results/${r.id}`, { method: 'DELETE' });
              loadResultsList();
            },
          }),
        ]),
      ])
    );
  }
}

document.getElementById('resultShooterSelect').addEventListener('change', loadResultsList);
document.getElementById('resultDisciplineSelect').addEventListener('change', loadResultsList);

document.getElementById('resultForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const shooter_id = Number(document.getElementById('resultShooterSelect').value);
  const discipline_id = Number(document.getElementById('resultDisciplineSelect').value);
  const points = document.getElementById('resultPoints').value;
  if (!shooter_id || !discipline_id || points === '') return;
  await api('/api/results', { method: 'POST', body: JSON.stringify({ shooter_id, discipline_id, points }) });
  document.getElementById('resultPoints').value = '';
  loadResultsList();
});

// ---------------- Rankings ----------------

async function refreshRankingSelector() {
  if (!state.disciplines.length) await loadDisciplines();
  fillSelect(document.getElementById('rankingDisciplineSelect'), state.disciplines, 'id', (d) => d.name);
  await loadRanking();
}

async function loadRanking() {
  const disciplineId = document.getElementById('rankingDisciplineSelect').value;
  const body = document.getElementById('rankingTableBody');
  body.innerHTML = '';
  if (!disciplineId) return;
  const discipline = state.disciplines.find((d) => String(d.id) === String(disciplineId));
  document.getElementById('printTitle').textContent = 'Rangliste – ' + (discipline ? discipline.name : '');
  document.getElementById('printDate').textContent = 'Stand: ' + new Date().toLocaleDateString('de-DE');
  const ranking = await api(`/api/rankings/${disciplineId}`);
  for (const r of ranking) {
    body.appendChild(
      el('tr', {}, [
        el('td', { text: r.rank }),
        el('td', { text: r.start_number }),
        el('td', { text: r.name }),
        el('td', { text: r.gender === 'w' ? 'weiblich' : 'männlich' }),
        el('td', { text: r.best_points }),
        el('td', { text: r.all_rounds.join(', ') }),
      ])
    );
  }
}

document.getElementById('rankingDisciplineSelect').addEventListener('change', loadRanking);
document.getElementById('printRankingBtn').addEventListener('click', () => window.print());

// ---------------- Import ----------------

let importRows = []; // array of objects keyed by detected column header (manueller Modus)
let importHeaders = [];
let detectedExtraction = null; // { rows, disciplineNames, shooterCount } vom Startmeldung-Auto-Import
let detectedArchive = null;

function parseCSV(text) {
  // Trennzeichen erkennen (Komma, Semikolon, Tab)
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delimiter = [';', ',', '\t'].reduce((best, d) =>
    (firstLine.split(d).length > firstLine.split(best).length ? d : best), ';');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = lines.map((line) => line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, '')));
  return rows;
}

function loadSheetJS() {
  return new Promise((resolve, reject) => {
    if (window.XLSX) return resolve();
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Konnte Excel-Bibliothek nicht laden (Internetverbindung nötig für .xlsx-Import). Bitte als CSV exportieren und erneut versuchen.'));
    document.head.appendChild(script);
  });
}

// ---- Automatische Erkennung des "Startmeldung"-Vorlagenformats ----
// Erwartet: eine Kopfzeile mit "geschlecht", "Name..." und mind. einer Spalte "Beste Serie"
// (optional gefolgt von einer Spalte "Folgeserien"). Der Disziplinname steht als
// zusammengeführte Zelle einige Zeilen darüber in derselben Spalte.

function normalizeHeaderCell(v) {
  return String(v ?? '').trim().toLowerCase();
}

function isStartNumberHeader(value) {
  return /^start\s*[-_.]?\s*(nummer|nr\.?)/.test(normalizeHeaderCell(value));
}

function isPureNumber(v) {
  const s = String(v ?? '').trim();
  if (s === '') return false;
  return !Number.isNaN(parseFloat(s.replace(',', '.'))) && /^-?[\d.,]+$/.test(s);
}

// Findet das am naechsten liegende Merge, das Spalte `col` einschliesst und
// oberhalb von `headerRowIdx` beginnt (0-indexed, wie SheetJS "!merges").
function findMergedLabel(rowsAsArrays, merges, col, headerRowIdx) {
  if (!merges || !merges.length) return '';
  let best = null;
  for (const m of merges) {
    if (m.s.r >= headerRowIdx) continue;
    if (col < m.s.c || col > m.e.c) continue;
    if (!best || m.s.r > best.s.r) best = m;
  }
  if (!best) return '';
  const row = rowsAsArrays[best.s.r] || [];
  return String(row[best.s.c] ?? '').trim();
}

// Fallback ohne Merge-Info: naechste nicht-leere UND nicht rein-numerische Zelle
// oberhalb in derselben Spalte (rein numerische Zwischenzeilen wie Punktwerte werden uebersprungen).
function findLabelByScanning(rowsAsArrays, col, headerRowIdx) {
  for (let rr = headerRowIdx - 1; rr >= 0; rr--) {
    const val = rowsAsArrays[rr] && rowsAsArrays[rr][col];
    if (val === undefined || val === null || String(val).trim() === '') continue;
    if (isPureNumber(val)) continue;
    return String(val).trim();
  }
  return '';
}

function detectStartmeldung(rowsAsArrays, merges) {
  for (let r = 0; r < rowsAsArrays.length; r++) {
    const row = rowsAsArrays[r] || [];
    const normalized = row.map(normalizeHeaderCell);
    const genderColIdx = normalized.indexOf('geschlecht');
    const nameColIdx = normalized.findIndex((h) => h.startsWith('name'));
    const startNumberColIdx = row.findIndex(isStartNumberHeader);
    const hasBesteSerie = normalized.includes('beste serie');
    if (genderColIdx === -1 || nameColIdx === -1 || !hasBesteSerie) continue;

    const groups = [];
    for (let c = 0; c < normalized.length; c++) {
      if (normalized[c] !== 'beste serie') continue;
      let label = findMergedLabel(rowsAsArrays, merges, c, r);
      if (!label) label = findLabelByScanning(rowsAsArrays, c, r);
      if (!label) label = `Disziplin (Spalte ${c + 1})`;
      const folgeCol = normalized[c + 1] === 'folgeserien' ? c + 1 : null;
      groups.push({ disciplineName: label, bestCol: c, folgeCol });
    }
    if (groups.length > 0) {
      return { headerRowIdx: r, nameCol: nameColIdx, genderCol: genderColIdx, startNumberCol: startNumberColIdx, groups };
    }
  }
  return null;
}

function normalizeShooterName(raw) {
  let s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return s;
  if (s.includes(',')) return s.replace(/\s*,\s*/, ', ');
  const m = s.match(/^([^.\s]+)\.(\S.*)$/); // z.B. "Nachname.Vorname" -> "Nachname, Vorname"
  if (m) return `${m[1]}, ${m[2]}`;
  return s;
}

function normalizeGenderCell(raw) {
  const g = String(raw ?? '').trim().toLowerCase();
  return g.startsWith('w') || g.startsWith('f') ? 'w' : 'm';
}

function parseNumericToken(tok) {
  const n = parseFloat(String(tok).replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

function extractStartmeldungRows(rowsAsArrays, detection) {
  const { headerRowIdx, nameCol, genderCol, startNumberCol, groups } = detection;
  const outRows = [];
  const disciplineNamesSet = new Set();
  let shooterCount = 0;
  let shootersWithoutResult = 0;

  for (let r = headerRowIdx + 1; r < rowsAsArrays.length; r++) {
    const row = rowsAsArrays[r] || [];
    const rawName = row[nameCol];
    if (!rawName || String(rawName).trim() === '') continue;
    shooterCount++;
    const name = normalizeShooterName(rawName);
    const gender = normalizeGenderCell(row[genderCol]);
    const start_number = startNumberCol >= 0 ? String(row[startNumberCol] ?? '').trim() : '';
    let hasAnyResult = false;

    for (const g of groups) {
      const values = [];
      const bestVal = row[g.bestCol];
      if (bestVal !== undefined && bestVal !== null && String(bestVal).trim() !== '') {
        const n = parseNumericToken(bestVal);
        if (n !== null) values.push(n);
      }
      const folgeVal = g.folgeCol !== null ? row[g.folgeCol] : undefined;
      if (folgeVal !== undefined && folgeVal !== null && String(folgeVal).trim() !== '') {
        String(folgeVal).trim().split(/\s+/).forEach((tok) => {
          const n = parseNumericToken(tok);
          if (n !== null) values.push(n);
        });
      }
      if (values.length === 0) continue;
      hasAnyResult = true;
      disciplineNamesSet.add(g.disciplineName);
      values.forEach((points, idx) => {
        outRows.push({ start_number, name, gender, discipline: g.disciplineName, round: idx + 1, points });
      });
    }
    if (!hasAnyResult) shootersWithoutResult++;
  }

  return {
    rows: outRows,
    disciplineNames: [...disciplineNamesSet],
    shooterCount,
    shootersWithoutResult,
  };
}

document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const resultEl = document.getElementById('importResult');
  resultEl.textContent = '';
  document.getElementById('importDetectedWrap').style.display = 'none';
  document.getElementById('importPreviewWrap').style.display = 'none';
  document.getElementById('importArchiveWrap').style.display = 'none';
  detectedExtraction = null;
  detectedArchive = null;

  let sheets = null; // { name: { rows: rowsAsArrays, merges } } für alle Blätter (nur bei xlsx)
  let rowsAsArrays; // Fallback: einzelnes Blatt/CSV

  try {
    if (file.name.match(/\.json$/i)) {
      const archive = JSON.parse(await file.text());
      if (!archive || !Array.isArray(archive.shooters) || !Array.isArray(archive.disciplines) || !Array.isArray(archive.results)) {
        throw new Error('Die JSON-Datei ist kein gültiges Saisonarchiv.');
      }
      detectedArchive = archive;
      const title = typeof archive.event_title === 'string' && archive.event_title.trim()
        ? `„${archive.event_title.trim()}“`
        : 'ohne Eventtitel';
      document.getElementById('archiveImportSummary').textContent =
        `${title}: ${archive.shooters.length} Schütze(n), ${archive.disciplines.length} Disziplin(en), ${archive.results.length} Ergebnis(se).`;
      document.getElementById('importArchiveWrap').style.display = 'block';
      return;
    } else if (file.name.match(/\.(xlsx|xls|xlsm)$/i)) {
      resultEl.textContent = 'Lade Excel-Bibliothek...';
      await loadSheetJS();
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array' });
      sheets = {};
      for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        sheets[name] = {
          rows: window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }),
          merges: ws['!merges'] || [],
        };
      }
      rowsAsArrays = sheets[wb.SheetNames[0]].rows;
      resultEl.textContent = '';
    } else {
      const text = await file.text();
      rowsAsArrays = parseCSV(text);
    }
  } catch (err) {
    resultEl.textContent = 'Fehler: ' + err.message;
    return;
  }

  if (!rowsAsArrays || !rowsAsArrays.length) {
    resultEl.textContent = 'Datei enthält keine Daten.';
    return;
  }

  // Versuche automatische Erkennung des "Startmeldung"-Formats über alle Blätter,
  // bevorzugt ein Blatt, das "Startmeldung" heißt.
  if (sheets) {
    const orderedNames = Object.keys(sheets).sort((a, b) => {
      const aMatch = a.toLowerCase().includes('startmeldung') ? 0 : 1;
      const bMatch = b.toLowerCase().includes('startmeldung') ? 0 : 1;
      return aMatch - bMatch;
    });
    for (const name of orderedNames) {
      const { rows, merges } = sheets[name];
      const detection = detectStartmeldung(rows, merges);
      if (detection) {
        const extraction = extractStartmeldungRows(rows, detection);
        if (extraction.rows.length > 0) {
          showDetectedPreview(name, extraction, rows, detection);
          return;
        }
      }
    }
  }

  // Fallback: generische Spalten-Zuordnung (langes Format, eine Zeile = ein Ergebnis)
  importHeaders = rowsAsArrays[0].map(String);
  importRows = rowsAsArrays.slice(1).map((row) => {
    const obj = {};
    importHeaders.forEach((h, i) => (obj[h] = row[i] !== undefined ? String(row[i]) : ''));
    return obj;
  });
  renderMappingUI();
});

document.getElementById('importArchiveBtn').addEventListener('click', async () => {
  if (!detectedArchive) return;
  if (!confirm('Die aktuelle Saison wird vollständig durch dieses JSON-Archiv ersetzt. Fortfahren?')) return;
  const resultEl = document.getElementById('importResult');
  resultEl.textContent = 'Saisonarchiv wird wiederhergestellt...';
  try {
    const result = await api('/api/import/archive', {
      method: 'POST',
      body: JSON.stringify({ archive: detectedArchive }),
    });
    resultEl.textContent =
      `Saison „${result.event_title || 'ohne Titel'}“ wiederhergestellt: ${result.restored.shooters} Schütze(n), ` +
      `${result.restored.disciplines} Disziplin(en), ${result.restored.results} Ergebnis(se).` +
      (result.backup ? `\nDie vorherige Saison wurde als ${result.backup} archiviert.` : '');
    detectedArchive = null;
    document.getElementById('importArchiveWrap').style.display = 'none';
    await Promise.all([loadShooters(), loadDisciplines(), loadEventTitle()]);
  } catch (err) {
    resultEl.textContent = 'Fehler beim JSON-Import: ' + err.message;
  }
});

function showDetectedPreview(sheetName, extraction, rowsAsArrays, detection) {
  detectedExtraction = extraction;
  document.getElementById('detectedSheetName').textContent = sheetName;
  document.getElementById('detectedSummary').textContent =
    `${extraction.shooterCount} Schütze(n) gefunden, davon ${extraction.shooterCount - extraction.shootersWithoutResult} mit erfassten Ergebnissen. ` +
    `Erkannte Disziplinen: ${extraction.disciplineNames.join(', ') || '–'}. ` +
    `Insgesamt werden ${extraction.rows.length} Einzelergebnisse (Durchgänge) importiert.`;
  document.getElementById('detectedNote').textContent = extraction.shootersWithoutResult > 0
    ? `Hinweis: ${extraction.shootersWithoutResult} Schütze(n) ohne bisheriges Ergebnis werden beim Import übersprungen (nur Schützen mit mind. einem Ergebnis werden angelegt). Diese können danach manuell unter "Schützen" ergänzt werden.`
    : '';
  document.getElementById('importDetectedWrap').style.display = 'block';

  document.getElementById('switchToManualBtn').onclick = () => {
    document.getElementById('importDetectedWrap').style.display = 'none';
    importHeaders = (rowsAsArrays[detection.headerRowIdx] || []).map(String);
    importRows = rowsAsArrays.slice(detection.headerRowIdx + 1).map((row) => {
      const obj = {};
      importHeaders.forEach((h, i) => (obj[h] = row[i] !== undefined ? String(row[i]) : ''));
      return obj;
    });
    renderMappingUI();
  };
}

document.getElementById('importDetectedBtn').addEventListener('click', async () => {
  if (!detectedExtraction) return;
  await submitImportRows(detectedExtraction.rows);
});

function renderMappingUI() {
  const grid = document.getElementById('mappingGrid');
  grid.innerHTML = '';
  const fields = [
    { key: 'start_number', label: 'Startnummer (optional)' },
    { key: 'name', label: 'Name' },
    { key: 'gender', label: 'Geschlecht' },
    { key: 'discipline', label: 'Disziplin' },
    { key: 'round', label: 'Durchgang (optional)' },
    { key: 'points', label: 'Punkte' },
  ];
  for (const f of fields) {
    const select = el('select', { 'data-field': f.key }, [
      el('option', { value: '', text: '— nicht zugeordnet —' }),
      ...importHeaders.map((h) => el('option', { value: h, text: h })),
    ]);
    // Best-effort Vorauswahl
    const guess = importHeaders.find((h) => f.key === 'start_number'
      ? isStartNumberHeader(h)
      : h.toLowerCase().includes(f.key === 'discipline' ? 'disz' : f.key === 'gender' ? 'geschl' : f.key === 'round' ? 'durchg' : f.key === 'points' ? 'punkt' : 'name'));
    if (guess) select.value = guess;
    grid.appendChild(el('div', {}, [el('label', { text: f.label + ': ' }), select]));
  }
  document.getElementById('importPreviewWrap').style.display = 'block';
}

document.getElementById('importSubmitBtn').addEventListener('click', async () => {
  const mapping = {};
  document.querySelectorAll('#mappingGrid select').forEach((sel) => {
    mapping[sel.dataset.field] = sel.value;
  });
  if (!mapping.name || !mapping.discipline || !mapping.points) {
    alert('Bitte mindestens Name, Disziplin und Punkte zuordnen.');
    return;
  }
  const rows = importRows.map((r) => ({
    start_number: mapping.start_number ? r[mapping.start_number] : '',
    name: r[mapping.name] || '',
    gender: mapping.gender ? r[mapping.gender] : '',
    discipline: r[mapping.discipline] || '',
    round: mapping.round ? r[mapping.round] : '',
    points: r[mapping.points] || '',
  })).filter((r) => r.name && r.discipline && r.points !== '');

  await submitImportRows(rows);
});

async function submitImportRows(rows) {
  const resultEl = document.getElementById('importResult');
  resultEl.textContent = 'Importiere ' + rows.length + ' Zeilen...';
  try {
    const result = await api('/api/import', { method: 'POST', body: JSON.stringify({ rows }) });
    resultEl.textContent = `Import abgeschlossen: ${result.created.shooters} neue Schützen, ${result.created.disciplines} neue Disziplinen, ${result.created.results} Ergebnisse.` +
      (result.errors.length ? `\n${result.errors.length} Zeile(n) übersprungen:\n` + result.errors.map((e) => `Zeile ${e.row}: ${e.message}`).join('\n') : '');
    state.shooters = [];
    state.disciplines = [];
    loadShooters();
    loadDisciplines();
  } catch (err) {
    resultEl.textContent = 'Fehler beim Import: ' + err.message;
  }
}

// ---------------- Season & Network ----------------

async function refreshSeasonInfo() {
  await loadEventTitle();
  const info = await api('/api/info');
  const ipList = document.getElementById('lanIpList');
  ipList.innerHTML = '';
  if (!info.lan_ips.length) {
    ipList.appendChild(el('li', { text: 'Keine LAN-Adresse gefunden (nur lokal am Laptop erreichbar).' }));
  }
  for (const ip of info.lan_ips) {
    const address = `http://${ip}:${info.port}`;
    ipList.appendChild(el('li', {}, [el('a', { href: address, target: '_blank', text: address })]));
  }
  await refreshArchiveList();
}

async function refreshArchiveList() {
  const archives = await api('/api/season/archives');
  const list = document.getElementById('archiveList');
  list.innerHTML = '';
  if (!archives.length) {
    list.appendChild(el('li', { text: 'Noch keine Archive vorhanden.' }));
  }
  for (const name of archives) {
    list.appendChild(
      el('li', {}, [el('a', { href: `/api/season/archives/${encodeURIComponent(name)}`, text: name })])
    );
  }
}

document.getElementById('exportBtn').addEventListener('click', () => {
  window.location.href = '/api/export';
});

document.getElementById('seasonTitleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('seasonTitleStatus');
  const title = document.getElementById('seasonTitle').value.trim();
  try {
    const season = await api('/api/season', { method: 'PUT', body: JSON.stringify({ title }) });
    state.eventTitle = season.title;
    renderEventTitle();
    status.textContent = 'Gespeichert.';
  } catch (err) {
    status.textContent = 'Fehler: ' + err.message;
  }
});

document.getElementById('resetSeasonBtn').addEventListener('click', async () => {
  if (!confirm('Wirklich eine neue Saison starten? Alle aktuellen Schützen, Disziplinen und Ergebnisse werden gelöscht (nach automatischem Archiv-Export).')) return;
  const result = await api('/api/season/reset', { method: 'POST', body: JSON.stringify({}) });
  alert('Neue Saison gestartet. Archiv gespeichert als: ' + result.archive);
  state.eventTitle = '';
  document.getElementById('seasonTitle').value = '';
  document.getElementById('seasonTitleStatus').textContent = '';
  renderEventTitle();
  state.shooters = [];
  state.disciplines = [];
  loadShooters();
  loadDisciplines();
  refreshArchiveList();
});

// ---------------- Init ----------------

loadShooters();
loadDisciplines();
loadEventTitle();

if (window.location.pathname === '/dashboard') {
  document.body.classList.add('tv-mode');
  activateTab('dashboard');
}
