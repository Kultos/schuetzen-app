'use strict';

// ---------------- Utilities ----------------

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Fehler bei ' + path);
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
};

// ---------------- Tabs ----------------

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'results') refreshResultSelectors();
    if (btn.dataset.tab === 'rankings') refreshRankingSelector();
    if (btn.dataset.tab === 'season') refreshSeasonInfo();
  });
});

// ---------------- Shooters ----------------

async function loadShooters() {
  state.shooters = await api('/api/shooters');
  const body = document.getElementById('shooterTableBody');
  body.innerHTML = '';
  for (const s of state.shooters) {
    body.appendChild(
      el('tr', {}, [
        el('td', { text: s.name }),
        el('td', { text: s.gender === 'w' ? 'weiblich' : 'männlich' }),
        el('td', {}, [
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
      ])
    );
  }
}

document.getElementById('shooterForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('shooterName').value.trim();
  const gender = document.getElementById('shooterGender').value;
  if (!name) return;
  await api('/api/shooters', { method: 'POST', body: JSON.stringify({ name, gender }) });
  document.getElementById('shooterName').value = '';
  loadShooters();
});

// ---------------- Disciplines ----------------

async function loadDisciplines() {
  state.disciplines = await api('/api/disciplines');
  const body = document.getElementById('disciplineTableBody');
  body.innerHTML = '';
  for (const d of state.disciplines) {
    body.appendChild(
      el('tr', {}, [
        el('td', { text: d.name }),
        el('td', {}, [
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
      ])
    );
  }
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
  fillSelect(document.getElementById('resultShooterSelect'), state.shooters, 'id', (s) => s.name);
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

let importRows = []; // array of objects keyed by detected column header
let importHeaders = [];

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

document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const resultEl = document.getElementById('importResult');
  resultEl.textContent = '';
  let rowsAsArrays;
  try {
    if (file.name.match(/\.(xlsx|xls|xlsm)$/i)) {
      resultEl.textContent = 'Lade Excel-Bibliothek...';
      await loadSheetJS();
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rowsAsArrays = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      resultEl.textContent = '';
    } else {
      const text = await file.text();
      rowsAsArrays = parseCSV(text);
    }
  } catch (err) {
    resultEl.textContent = 'Fehler: ' + err.message;
    return;
  }

  if (!rowsAsArrays.length) {
    resultEl.textContent = 'Datei enthält keine Daten.';
    return;
  }

  importHeaders = rowsAsArrays[0].map(String);
  importRows = rowsAsArrays.slice(1).map((row) => {
    const obj = {};
    importHeaders.forEach((h, i) => (obj[h] = row[i] !== undefined ? String(row[i]) : ''));
    return obj;
  });

  renderMappingUI();
});

function renderMappingUI() {
  const grid = document.getElementById('mappingGrid');
  grid.innerHTML = '';
  const fields = [
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
    const guess = importHeaders.find((h) => h.toLowerCase().includes(f.key === 'discipline' ? 'disz' : f.key === 'gender' ? 'geschl' : f.key === 'round' ? 'durchg' : f.key === 'points' ? 'punkt' : 'name'));
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
    name: r[mapping.name] || '',
    gender: mapping.gender ? r[mapping.gender] : '',
    discipline: r[mapping.discipline] || '',
    round: mapping.round ? r[mapping.round] : '',
    points: r[mapping.points] || '',
  })).filter((r) => r.name && r.discipline && r.points !== '');

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
});

// ---------------- Season & Network ----------------

async function refreshSeasonInfo() {
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

document.getElementById('resetSeasonBtn').addEventListener('click', async () => {
  if (!confirm('Wirklich eine neue Saison starten? Alle aktuellen Schützen, Disziplinen und Ergebnisse werden gelöscht (nach automatischem Archiv-Export).')) return;
  const label = document.getElementById('seasonLabel').value.trim();
  const result = await api('/api/season/reset', { method: 'POST', body: JSON.stringify({ label }) });
  alert('Neue Saison gestartet. Archiv gespeichert als: ' + result.archive);
  state.shooters = [];
  state.disciplines = [];
  loadShooters();
  loadDisciplines();
  refreshArchiveList();
});

// ---------------- Init ----------------

loadShooters();
loadDisciplines();
