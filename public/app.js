'use strict';

document.querySelectorAll('img').forEach((image) => image.addEventListener('error', () => { image.hidden = true; }));

// ---------------- Utilities ----------------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Schuetzen-Request':'1', ...(state.eventId ? {'X-Event-Id':String(state.eventId)} : {}), ...options.headers },
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

function splitShooterName(name) {
  const normalized = String(name || '').trim().replace(/\s+/g, ' ');
  const comma = normalized.indexOf(',');
  if (comma >= 0) return {
    firstName: normalized.slice(comma + 1).trim(),
    lastName: normalized.slice(0, comma).trim(),
  };
  const parts = normalized.split(' ');
  return parts.length > 1
    ? { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) }
    : { firstName: normalized, lastName: '' };
}

let state = {
  shooters: [],
  disciplines: [],
  teams: [],
  event: null,
  eventTitle: '',
};

const dashboardState = {
  snapshot: null,
  disciplineId: null,
  rankingMode: 'individual',
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
  state.event = season.event;
  state.eventId = season.event.id;
  document.getElementById('seasonYear').value = season.event.year || '';
  document.getElementById('seasonTitle').value = state.eventTitle;
  applyTeamSettings(season.event);
  renderEventTitle();
}

// ---------------- Tabs ----------------

document.querySelectorAll('.tab').forEach((btn) => {
  if (!btn.dataset.tab) return;
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.querySelector('main').classList.toggle('results-main', ['results', 'rankings'].includes(btn.dataset.tab));
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'dashboard') startDashboard();
    else stopDashboard();
    if (btn.dataset.tab === 'results') refreshResultSelectors();
    if (btn.dataset.tab === 'rankings') refreshRankingSelector();
    if (btn.dataset.tab === 'teams') loadTeams();
    if (btn.dataset.tab === 'season') refreshSeasonInfo();
    if (btn.dataset.tab === 'people') loadPeople();
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

  const teamRanking=dashboardState.rankingMode==='team';
  const ranking=teamRanking ? discipline?.team_ranking || [] : discipline?.ranking || [];
  if (!discipline || !ranking.length) {
    container.appendChild(el('div', { class: 'dashboard-empty', text: 'Sobald Ergebnisse erfasst sind, erscheint hier die Rangliste.' }));
    return;
  }

  if(teamRanking) {
    const list=el('ol',{class:'ranking-list'});
    for(const entry of ranking.slice(0,8)) {
      const medal=entry.rank<=3 ? ` rank-${entry.rank}` : '';
      list.appendChild(el('li',{class:`ranking-row${medal}`},[
        el('span',{class:'rank-number',text:entry.rank}),
        el('span',{class:'rank-name',text:entry.name}),
        el('span',{class:'rank-rounds',text:`${entry.counted_count}/${entry.required_count} gewertet`}),
        el('strong',{class:'rank-score',text:formatPoints(entry.total_points)})
      ]));
    }
    container.appendChild(list);return;
  }

  const groups = discipline.ranking_mode === 'separate'
    ? [['women', 'Frauen'], ['men', 'Männer']]
    : [['combined', 'Gemeinsame Wertung']];
  for (const [group, label] of groups) {
    const entries = discipline.ranking.filter((entry) => entry.ranking_group === group).slice(0, 8);
    if (!entries.length) continue;
    if (discipline.ranking_mode === 'separate') container.appendChild(el('h4', { text: label }));
    const list = el('ol', { class: 'ranking-list' });
    for (const entry of entries) {
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
  if(data.scoring_mode==='team') dashboardState.rankingMode='team';
  if(data.scoring_mode==='individual') dashboardState.rankingMode='individual';
  const modeSwitch=document.getElementById('dashboardRankingMode');
  modeSwitch.hidden=data.scoring_mode!=='both';
  document.getElementById('dashboardIndividualRankingBtn').classList.toggle('active',dashboardState.rankingMode==='individual');
  document.getElementById('dashboardTeamRankingBtn').classList.toggle('active',dashboardState.rankingMode==='team');
  document.getElementById('dashboardIndividualRankingBtn').setAttribute('aria-pressed',String(dashboardState.rankingMode==='individual'));
  document.getElementById('dashboardTeamRankingBtn').setAttribute('aria-pressed',String(dashboardState.rankingMode==='team'));
  document.getElementById('dashboardRankingKind').textContent=dashboardState.rankingMode==='team' ? 'Aktuelle Mannschaftswertung' : 'Aktuelle Einzelwertung';

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
document.getElementById('dashboardIndividualRankingBtn').addEventListener('click',()=>{dashboardState.rankingMode='individual';renderDashboard();});
document.getElementById('dashboardTeamRankingBtn').addEventListener('click',()=>{dashboardState.rankingMode='team';renderDashboard();});
document.getElementById('openTvDashboardBtn').addEventListener('click', () => window.open('/dashboard', '_blank'));
document.getElementById('exitTvDashboardBtn').addEventListener('click', () => { window.location.href = '/'; });

// ---------------- Shooters ----------------

let editingShooterId = null;

async function loadShooters() {
  const [shooters,teams]=await Promise.all([api('/api/shooters'),api('/api/teams')]);
  state.shooters = shooters;
  state.teams = teams;
  renderShooterTeamSelect();
  const body = document.getElementById('shooterTableBody');
  body.innerHTML = '';
  for (const s of state.shooters) {
    body.appendChild(s.id === editingShooterId ? renderShooterEditRow(s) : renderShooterRow(s));
  }
  if (!editingShooterId) await refreshStartNumberSuggestion();
}

function renderShooterTeamSelect() {
  const field=document.getElementById('shooterTeamField');
  const select=document.getElementById('shooterTeam');
  field.hidden=!teamModeEnabled();
  select.replaceChildren(el('option',{value:'',text:state.teams.length?'– keine Mannschaft –':'Noch keine Mannschaft angelegt'}));
  for(const team of state.teams) {
    const full=team.member_count>=state.event.team_max_members;
    const attrs={value:team.id,text:`${team.name} (${team.member_count}/${state.event.team_max_members})`};
    if(full) attrs.disabled='';
    select.appendChild(el('option',attrs));
  }
  select.disabled=!state.teams.length;
}

async function refreshStartNumberSuggestion() {
  const input = document.getElementById('shooterStartNumber');
  if (document.activeElement === input && input.value) return;
  const suggestion = await api('/api/shooters/next-start-number');
  input.value = suggestion.start_number;
}

function renderShooterRow(s) {
  const team=state.teams.find(entry=>entry.members.some(member=>member.shooter_id===s.id));
  return el('tr', {}, [
    el('td', { class: 'start-number-cell', text: s.start_number }),
    el('td', { text: s.name }),
    el('td', { text: s.gender === 'w' ? 'weiblich' : 'männlich' }),
    el('td', { text: team?.name || '–' }),
    el('td', { class: 'row-actions' }, [
      el('button', {
        class: 'link',
        text: 'Ergebnisse',
        onclick: () => {
          resultView.shooterId = s.id;
          document.getElementById('resultSearch').value = '';
          activateTab('results');
        },
      }),
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
          if (!confirm(`"${s.name}" aus dem aktuellen Event entfernen? Dessen aktuelle Ergebnisse werden gelöscht. Schützenstamm und frühere Events bleiben erhalten.`)) return;
          await api(`/api/shooters/${s.id}`, { method: 'DELETE' });
          loadShooters();
        },
      }),
    ]),
  ]);
}

function renderShooterEditRow(s) {
  const team=state.teams.find(entry=>entry.members.some(member=>member.shooter_id===s.id));
  const structuredName=splitShooterName(s.name);
  const startNumberInput = el('input', { class: 'edit-start-number', type: 'number', min: '1', step: '1', value: s.start_number });
  startNumberInput.value = s.start_number;
  const firstNameInput = el('input', { type: 'text', value: structuredName.firstName, maxlength: '100', placeholder: 'Vorname', autocomplete: 'given-name' });
  const lastNameInput = el('input', { type: 'text', value: structuredName.lastName, maxlength: '100', placeholder: 'Nachname', autocomplete: 'family-name' });
  const genderSelect = el('select', {}, [
    el('option', { value: 'm', text: 'männlich' }),
    el('option', { value: 'w', text: 'weiblich' }),
  ]);
  genderSelect.value = s.gender;
  const teamSelect=el('select',{class:'edit-team-select','aria-label':`Mannschaft für ${s.name}`},[
    el('option',{value:'',text:'– keine Mannschaft –'}),
    ...state.teams.map(entry=>{
      const full=entry.member_count>=state.event.team_max_members && entry.id!==team?.id;
      return el('option',{value:entry.id,text:`${entry.name} (${entry.member_count}/${state.event.team_max_members})`,...(full?{disabled:''}:{})});
    })
  ]);
  teamSelect.value=team?.id || '';

  const save = async () => {
    const first_name = firstNameInput.value.trim();
    const last_name = lastNameInput.value.trim();
    const start_number = Number(startNumberInput.value);
    if (!first_name || !last_name) { alert('Vorname und Nachname dürfen nicht leer sein.'); return; }
    if (!Number.isSafeInteger(start_number) || start_number < 1) { alert('Die Startnummer muss eine positive ganze Zahl sein.'); return; }
    const payload = { name: `${last_name}, ${first_name}`, first_name, last_name, gender: genderSelect.value, start_number, ...(teamModeEnabled()?{team_id:teamSelect.value?Number(teamSelect.value):null}:{}) };
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
  for (const input of [firstNameInput, lastNameInput]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); });

  return el('tr', {}, [
    el('td', {}, [startNumberInput]),
    el('td', { class: 'name-fields' }, [firstNameInput, lastNameInput]),
    el('td', {}, [genderSelect]),
    teamModeEnabled() ? el('td', {}, [teamSelect]) : el('td', { text: team?.name || '–' }),
    el('td', { class: 'row-actions' }, [
      el('button', { text: 'Speichern', onclick: save }),
      el('button', { class: 'link', text: 'Abbrechen', onclick: cancel }),
    ]),
  ]);
}

document.getElementById('shooterForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const firstNameInput = document.getElementById('shooterFirstName');
  const lastNameInput = document.getElementById('shooterLastName');
  const first_name = firstNameInput.value.trim();
  const last_name = lastNameInput.value.trim();
  const gender = document.getElementById('shooterGender').value;
  const startNumberInput = document.getElementById('shooterStartNumber');
  const teamSelect = document.getElementById('shooterTeam');
  const start_number = Number(startNumberInput.value);
  if (!first_name || !last_name) return;
  if (!Number.isSafeInteger(start_number) || start_number < 1) { alert('Die Startnummer muss eine positive ganze Zahl sein.'); return; }
  try {
    const team_id = !teamSelect.disabled && teamSelect.value ? Number(teamSelect.value) : null;
    await api('/api/shooters', { method: 'POST', body: JSON.stringify({ name: `${last_name}, ${first_name}`, first_name, last_name, gender, start_number, team_id }) });
    firstNameInput.value = '';
    lastNameInput.value = '';
    await loadShooters();
    firstNameInput.focus();
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
    el('td', { text: d.ranking_mode === 'separate' ? 'Getrennt' : 'Gemeinsam' }),
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
  const modeInput = el('select', {}, [el('option', { value: 'combined', text: 'Gemeinsame Wertung' }), el('option', { value: 'separate', text: 'Getrennt: Frauen / Männer' })]);
  modeInput.value = d.ranking_mode;

  const save = async () => {
    const name = nameInput.value.trim();
    if (!name) { alert('Name darf nicht leer sein.'); return; }
    await api(`/api/disciplines/${d.id}`, { method: 'PUT', body: JSON.stringify({ name, ranking_mode: modeInput.value }) });
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
    el('td', {}, [modeInput]),
    el('td', { class: 'row-actions' }, [
      el('button', { text: 'Speichern', onclick: save }),
      el('button', { class: 'link', text: 'Abbrechen', onclick: cancel }),
    ]),
  ]);
}

document.getElementById('disciplineForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('disciplineName').value.trim();
  const ranking_mode = document.getElementById('disciplineRankingMode').value;
  if (!name) return;
  await api('/api/disciplines', { method: 'POST', body: JSON.stringify({ name, ranking_mode }) });
  document.getElementById('disciplineName').value = '';
  loadDisciplines();
});

// ---------------- Teams ----------------

const teamView = { teamId: null, busy: false, addOpen: false, rankings: new Map(), request: 0 };

function teamModeEnabled() {
  return state.event && state.event.scoring_mode !== 'individual';
}

function applyTeamSettings(event) {
  state.event = event;
  const radio = document.querySelector(`input[name="teamScoringMode"][value="${event.scoring_mode}"]`);
  if (radio) radio.checked = true;
  document.getElementById('teamMaxMembers').value = event.team_max_members;
  document.getElementById('teamCountedResults').value = event.team_counted_results;
  document.getElementById('teamSelectionHint').hidden = event.scoring_mode === 'individual';
  document.getElementById('individualRankingHint').hidden = event.scoring_mode === 'team';
  const tabs = document.getElementById('rankingModeTabs');
  tabs.hidden = event.scoring_mode !== 'both';
  if (event.scoring_mode === 'team') rankingView.mode = 'team';
  if (event.scoring_mode === 'individual') rankingView.mode = 'individual';
  renderShooterTeamSelect();
}

async function loadTeams() {
  const [teams,shooters,disciplines,event] = await Promise.all([api('/api/teams'),api('/api/shooters'),api('/api/disciplines'),api('/api/team-settings')]);
  state.teams=teams;state.shooters=shooters;state.disciplines=disciplines;teamView.rankings=new Map();applyTeamSettings(event);
  if(!teams.some(team=>team.id===teamView.teamId)) {teamView.teamId=teams[0]?.id ?? null;teamView.addOpen=false;}
  renderTeams();
  await loadTeamOverview();
}

function renderTeams() {
  const max=state.event?.team_max_members || 5;
  document.getElementById('teamRules').textContent=teamModeEnabled()
    ? `Pro Mannschaft sind höchstens ${max} Mitglieder erlaubt; je Disziplin werden die besten ${state.event.team_counted_results} markierten Ergebnisse gewertet.`
    : 'Für dieses Event ist derzeit nur die Einzelwertung aktiv. Mannschaften können vorbereitet und unter „Saison & Netzwerk“ aktiviert werden.';
  const list=document.getElementById('teamList');list.replaceChildren();
  for(const team of state.teams) list.appendChild(el('button',{type:'button',class:team.id===teamView.teamId?'active':'','aria-pressed':String(team.id===teamView.teamId),onclick:()=>{teamView.teamId=team.id;teamView.addOpen=false;teamView.rankings=new Map();renderTeams();loadTeamOverview();}},[
    el('span',{class:'team-option'},[el('strong',{text:team.name}),el('small',{text:`${team.member_count} von ${max} Mitgliedern`}),el('span',{class:'capacity',text:`${team.member_count}/${max}`})])
  ]));
  if(!state.teams.length) list.appendChild(el('p',{class:'hint',text:'Noch keine Mannschaft angelegt.'}));
  const selected=state.teams.find(team=>team.id===teamView.teamId);
  const header=document.getElementById('selectedTeamHeader');header.replaceChildren();
  if(selected) {
    header.append(el('div',{class:'team-detail-title'},[el('h3',{text:selected.name}),el('small',{text:`${selected.member_count} von ${max} Plätzen belegt`})]),
      el('div',{class:'team-actions'},[
        el('button',{type:'button',text:'Schützen hinzufügen',...(selected.member_count>=max?{disabled:''}:{}),onclick:()=>{teamView.addOpen=true;renderTeamMemberPanel();document.getElementById('teamMemberSearch').focus();}}),
        el('button',{type:'button',class:'link',text:'Umbenennen',onclick:async()=>{const name=prompt('Neuer Mannschaftsname',selected.name);if(!name?.trim())return;await teamMutation(`/api/teams/${selected.id}`,{method:'PUT',body:JSON.stringify({name:name.trim()})},'Mannschaft umbenannt.');}}),
        el('button',{type:'button',class:'link danger-text',text:'Löschen',onclick:async()=>{if(!confirm(`Mannschaft „${selected.name}“ löschen? Die Teilnehmer bleiben im Event.`))return;await teamMutation(`/api/teams/${selected.id}`,{method:'DELETE'},'Mannschaft gelöscht.');}})
      ]));
  } else header.appendChild(el('h3',{text:'Mannschaft auswählen'}));
  document.getElementById('teamResultsTitle').hidden=!selected;
  renderTeamOverview();
  renderTeamMemberPanel();
}

async function loadTeamOverview() {
  const teamId=teamView.teamId,request=++teamView.request;
  if(!teamId) {teamView.rankings=new Map();renderTeamOverview();return;}
  document.getElementById('teamOverviewStatus').textContent='Mannschaftsergebnisse werden geladen …';
  try {
    const rankings=await Promise.all(state.disciplines.map(discipline=>api(`/api/team-rankings/${discipline.id}`)));
    if(request!==teamView.request || teamId!==teamView.teamId)return;
    teamView.rankings=new Map(state.disciplines.map((discipline,index)=>[discipline.id,rankings[index].find(team=>team.team_id===teamId) || null]));
    document.getElementById('teamOverviewStatus').textContent='';
    renderTeamOverview();
  } catch(error) {
    if(request===teamView.request) document.getElementById('teamOverviewStatus').textContent='Ergebnisse konnten nicht geladen werden: '+error.message;
  }
}

function renderTeamOverview() {
  const selected=state.teams.find(team=>team.id===teamView.teamId);
  const summaries=document.getElementById('teamDisciplineSummaries');summaries.replaceChildren();
  const head=document.getElementById('teamResultsHead');head.replaceChildren();
  const body=document.getElementById('teamResultsBody');body.replaceChildren();
  document.getElementById('teamResultsTable').hidden=!selected;
  if(!selected) {document.getElementById('teamOverviewStatus').textContent=state.teams.length?'Mannschaft auswählen.':'Zuerst eine Mannschaft anlegen.';return;}
  if(!state.disciplines.length) {
    summaries.appendChild(el('p',{class:'hint',text:'Noch keine Disziplinen angelegt.'}));
  }
  for(const discipline of state.disciplines) {
    const ranking=teamView.rankings.get(discipline.id);
    summaries.appendChild(el('article',{class:'team-summary-card'},[
      el('span',{text:discipline.name}),el('strong',{text:ranking?formatPoints(ranking.total_points):'–'}),
      el('small',{text:ranking?`Platz ${ranking.rank} · ${ranking.counted_count}/${ranking.required_count} gewertet`:'Noch kein Durchgang markiert'})
    ]));
  }
  ['Startnummer','Name',...state.disciplines.map(discipline=>discipline.name),'Aktionen'].forEach(label=>head.appendChild(el('th',{text:label})));
  for(const member of selected.members) {
    const cells=[el('td',{text:member.start_number}),el('td',{text:member.name})];
    for(const discipline of state.disciplines) {
      const ranking=teamView.rankings.get(discipline.id);
      const entry=ranking?.entries.find(result=>result.shooter_id===member.shooter_id);
      cells.push(entry ? el('td',{class:entry.counted?'team-score counted':'team-score dropped'},[
        el('strong',{text:formatPoints(entry.points)}),el('small',{text:`D${entry.round_number} · ${entry.counted?'gewertet':'Streichergebnis'}`})
      ]) : el('td',{class:'team-score missing'},[el('span',{text:'–'}),el('small',{text:'nicht markiert'})]));
    }
    cells.push(el('td',{class:'row-actions'},[
      el('button',{type:'button',class:'link',text:'Ergebnisse',onclick:()=>{resultView.shooterId=member.shooter_id;document.getElementById('resultSearch').value='';activateTab('results');}}),
      el('button',{type:'button',class:'link danger-text',text:'Entfernen',onclick:async()=>{if(!confirm(`${member.name} aus „${selected.name}“ entfernen?`))return;await teamMutation(`/api/teams/members/${member.shooter_id}`,{method:'DELETE'},`${member.name} wurde aus der Mannschaft entfernt.`);}})
    ]));
    body.appendChild(el('tr',{},cells));
  }
  if(!selected.members.length) body.appendChild(el('tr',{},[el('td',{colspan:String(state.disciplines.length+3),class:'hint',text:'Diese Mannschaft hat noch keine Mitglieder.'})]));
}

function renderTeamMemberPanel() {
  const panel=document.getElementById('teamMemberPanel');
  const selected=state.teams.find(team=>team.id===teamView.teamId);
  panel.hidden=!teamView.addOpen || !selected;
  if(panel.hidden)return;
  const root=document.getElementById('availableTeamMembers');root.replaceChildren();
  const query=document.getElementById('teamMemberSearch').value.trim().toLocaleLowerCase('de-DE');
  const membership=new Map();
  for(const team of state.teams) for(const member of team.members) membership.set(member.shooter_id,team);
  const shooters=state.shooters.filter(shooter=>membership.get(shooter.id)?.id!==selected.id && `${shooter.start_number} ${shooter.name}`.toLocaleLowerCase('de-DE').includes(query));
  for(const shooter of shooters) {
    const currentTeam=membership.get(shooter.id);
    const add=el('button',{type:'button',text:currentTeam?'Verschieben':'Hinzufügen',onclick:async()=>{
      if(currentTeam && !confirm(`${shooter.name} aus „${currentTeam.name}“ nach „${selected.name}“ verschieben?`))return;
      await teamMutation(`/api/teams/${selected.id}/members/${shooter.id}`,{method:'PUT'},`${shooter.name} wurde ${currentTeam?'verschoben':'hinzugefügt'}.`);
    }});add.disabled=teamView.busy || selected.member_count>=state.event.team_max_members;
    root.appendChild(el('div',{class:'available-team-member'},[
      el('div',{},[el('strong',{text:`#${shooter.start_number} · ${shooter.name}`}),el('small',{text:currentTeam?`Derzeit: ${currentTeam.name}`:'Noch keiner Mannschaft zugeordnet'})]),add
    ]));
  }
  if(!shooters.length) root.appendChild(el('p',{class:'hint',text:state.shooters.length?'Keine passenden Schützen verfügbar.':'Noch keine Teilnehmer im Event.'}));
}

async function teamMutation(path,options,message) {
  if(teamView.busy)return;
  teamView.busy=true;document.getElementById('teamFeedback').textContent='Wird gespeichert …';
  try {await api(path,options);document.getElementById('teamFeedback').textContent=message;await loadTeams();}
  catch(error){document.getElementById('teamFeedback').textContent='Speichern fehlgeschlagen: '+error.message;throw error;}
  finally{teamView.busy=false;renderTeamMemberPanel();}
}

document.getElementById('teamForm').addEventListener('submit',async event=>{
  event.preventDefault();const input=document.getElementById('teamName');
  try {await teamMutation('/api/teams',{method:'POST',body:JSON.stringify({name:input.value})},'Mannschaft angelegt.');input.value='';document.getElementById('teamCreateDetails').open=false;}
  catch {}
});
document.getElementById('teamMemberSearch').addEventListener('input',renderTeamMemberPanel);
document.getElementById('closeTeamMemberPanel').addEventListener('click',()=>{teamView.addOpen=false;renderTeamMemberPanel();});

document.getElementById('teamSettingsForm').addEventListener('submit',async event=>{
  event.preventDefault();const status=document.getElementById('teamSettingsStatus');status.textContent='Wird gespeichert …';
  const scoring_mode=document.querySelector('input[name="teamScoringMode"]:checked')?.value;
  try {
    const saved=await api('/api/team-settings',{method:'PUT',body:JSON.stringify({scoring_mode,team_max_members:Number(document.getElementById('teamMaxMembers').value),team_counted_results:Number(document.getElementById('teamCountedResults').value)})});
    applyTeamSettings(saved);status.textContent='Mannschaftswertung gespeichert.';
  } catch(error){status.textContent='Fehler: '+error.message;}
});

// ---------------- Results ----------------

function fillSelect(selectEl, items, valueKey, labelFn) {
  selectEl.innerHTML = '';
  for (const item of items) {
    selectEl.appendChild(el('option', { value: item[valueKey], text: labelFn(item) }));
  }
}

// ---------------- Rankings ----------------

const rankingView = { disciplineId: null, request: 0, mode: 'individual' };

function renderRankingDisciplines() {
  const nav = document.getElementById('rankingDisciplines');
  nav.replaceChildren();
  for (const discipline of state.disciplines) {
    nav.appendChild(el('button', {
      type: 'button', class: 'result-shooter',
      'aria-pressed': String(discipline.id === rankingView.disciplineId),
      onclick: () => {
        rankingView.disciplineId = discipline.id;
        renderRankingDisciplines();
        loadRanking();
      },
    }, [
      el('span', { text: discipline.name }),
      el('small', { text: discipline.ranking_mode === 'separate' ? 'Frauen / Männer getrennt' : 'Gemeinsame Wertung' }),
    ]));
  }
  if (!state.disciplines.length) nav.appendChild(el('p', { class: 'hint', text: 'Noch keine Disziplinen angelegt.' }));
}

async function refreshRankingSelector() {
  if (!state.disciplines.length) await loadDisciplines();
  if(state.event?.scoring_mode==='team') rankingView.mode='team';
  if(state.event?.scoring_mode==='individual') rankingView.mode='individual';
  if (!state.disciplines.some((d) => d.id === rankingView.disciplineId)) {
    rankingView.disciplineId = state.disciplines[0]?.id ?? null;
  }
  renderRankingDisciplines();
  await loadRanking();
}

async function loadRanking() {
  const disciplineId = rankingView.disciplineId;
  const request = ++rankingView.request;
  const eventId = state.eventId;
  const tables = document.getElementById('rankingTables');
  const status = document.getElementById('rankingStatus');
  const printButton = document.getElementById('printRankingBtn');
  tables.replaceChildren();
  printButton.disabled = true;
  const discipline = state.disciplines.find((d) => String(d.id) === String(disciplineId));
  document.getElementById('rankingDisciplineName').textContent = discipline ? discipline.name : 'Disziplin auswählen';
  const teamRanking=rankingView.mode==='team';
  document.getElementById('individualRankingBtn').class = teamRanking ? '' : 'active';
  document.getElementById('teamRankingBtn').class = teamRanking ? 'active' : '';
  document.getElementById('individualRankingBtn').setAttribute?.('class',teamRanking ? '' : 'active');
  document.getElementById('teamRankingBtn').setAttribute?.('class',teamRanking ? 'active' : '');
  document.getElementById('printTitle').textContent = (teamRanking ? 'Mannschaftsrangliste – ' : 'Rangliste – ') + (discipline ? discipline.name : '');
  document.getElementById('rankingExplanation').textContent=teamRanking && state.event
    ? `Je Mannschaft zählen die besten ${state.event.team_counted_results} ausdrücklich markierten Ergebnisse. Bei Gleichstand werden diese Einzelergebnisse absteigend verglichen.` : '';
  if (!discipline) {
    status.textContent = 'Sobald Disziplinen angelegt sind, erscheinen hier die Ranglisten.';
    return;
  }
  document.getElementById('printDate').textContent = 'Stand: ' + new Date().toLocaleDateString('de-DE');
  status.textContent = 'Rangliste wird geladen …';
  let ranking;
  try {
    ranking = await api(`/${teamRanking ? 'api/team-rankings' : 'api/rankings'}/${disciplineId}`);
  } catch (error) {
    if (request === rankingView.request && eventId === state.eventId) status.textContent = 'Rangliste konnte nicht geladen werden: ' + error.message + ' Bitte die Disziplin erneut auswählen.';
    return;
  }
  if (request !== rankingView.request || eventId !== state.eventId) return;
  status.textContent = ranking.length ? '' : 'Für diese Disziplin sind noch keine Ergebnisse erfasst.';
  printButton.disabled = !ranking.length;
  if(teamRanking) {
    const body=el('tbody');
    for(const team of ranking) {
      const main=el('tr',{class:'team-ranking-row','aria-expanded':'false',tabindex:'0'},[
        el('td',{class:'rank-cell',text:team.rank}),
        el('td',{class:'ranking-team-name'},[el('strong',{text:team.name}),el('small',{text:`${team.counted_count}/${team.required_count} Ergebnisse gewertet · ${team.member_count} Mitglieder`})]),
        el('td',{text:team.entries.filter(entry=>entry.counted).map(entry=>formatPoints(entry.points)).join(' + ')}),
        el('td',{class:'ranking-score',text:formatPoints(team.total_points)})
      ]);
      const details=el('div',{class:'ranking-details'});
      for(const entry of team.entries) details.appendChild(el('div',{class:'detail-member'},[
        el('span',{text:`#${entry.start_number} · ${entry.name}`}),el('strong',{text:formatPoints(entry.points)}),
        el('span',{class:entry.counted?'included':'dropped',text:entry.counted?'✓ Wird gewertet':'Streichergebnis'})
      ]));
      if(team.member_count>team.selected_count) details.appendChild(el('p',{class:'hint',text:`${team.member_count-team.selected_count} Mitglied(er) ohne markierten Durchgang in dieser Disziplin.`}));
      const detailRow=el('tr',{class:'detail-row',hidden:''},[el('td',{colspan:'4'},[details])]);
      const toggle=()=>{const open=main['aria-expanded']==='true';main['aria-expanded']=String(!open);main.setAttribute?.('aria-expanded',String(!open));detailRow.hidden=open;if(open)detailRow.setAttribute?.('hidden','');else detailRow.removeAttribute?.('hidden');};
      main.onclick=toggle;main.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();toggle();}};
      body.appendChild(main);body.appendChild(detailRow);
    }
    tables.appendChild(el('table',{class:'data-table ranking-table'},[el('thead',{},[el('tr',{},['Platz','Mannschaft','Gewertete Ergebnisse','Gesamtpunkte'].map(text=>el('th',{text})))]),body]));
    return;
  }
  const groups = discipline.ranking_mode === 'separate' ? [['women','Frauen'],['men','Männer']] : [['combined','Gemeinsame Wertung']];
  for (const [group, label] of groups) {
    const rows = ranking.filter((r) => r.ranking_group === group);
    if (!rows.length) continue;
    if (discipline.ranking_mode === 'separate') tables.appendChild(el('h3', { text: label }));
    const body = el('tbody');
    for (const r of rows) body.appendChild(
      el('tr', {}, [
        el('td', { text: r.rank }),
        el('td', { text: r.start_number }),
        el('td', { text: r.name }),
        el('td', { text: r.gender === 'w' ? 'weiblich' : 'männlich' }),
        el('td', { text: r.best_points }),
        el('td', { text: r.all_rounds.join(', ') }),
      ])
    );
    const table = el('table', { class: 'data-table ranking-table' }, [el('thead', {}, [el('tr', {}, ['Platz','Startnummer','Name','Geschlecht','Bestes Ergebnis','Alle Durchgänge'].map((text) => el('th', { text })))]), body]);
    tables.appendChild(table);
  }
}

document.getElementById('individualRankingBtn').addEventListener('click',()=>{rankingView.mode='individual';loadRanking();});
document.getElementById('teamRankingBtn').addEventListener('click',()=>{rankingView.mode='team';loadRanking();});

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
    script.integrity = 'sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tIRAI062MaV8sfjQKYVGjOBaZBOA87z+IhZE9DA==';
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
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

document.getElementById('importArchiveBtn').addEventListener('click', () => {
  if (detectedArchive) openArchiveImport(detectedArchive);
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
  const backupState = await api('/api/backups');
  if (backupState.privacy_review) { await refreshManagement(); return; }
  await loadEventTitle();
  const info = await api('/api/info');
  const ipList = document.getElementById('lanIpList');
  ipList.innerHTML = '';
  if (!info.lan_ips.length) {
    ipList.appendChild(el('li', { text: 'Keine LAN-Adresse gefunden (nur lokal am Laptop erreichbar).' }));
  }
  for (const ip of info.lan_ips) {
    const address = `${window.location.protocol}//${ip}:${info.port}`;
    ipList.appendChild(el('li', {}, [el('a', { href: address, target: '_blank', text: address })]));
  }
  await refreshArchiveList();
  await refreshManagement();
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
    const year = Number(document.getElementById('seasonYear').value);
    const season = await api('/api/season', { method: 'PUT', body: JSON.stringify({ title, year }) });
    state.eventTitle = season.title;
    renderEventTitle();
    status.textContent = 'Gespeichert.';
  } catch (err) {
    status.textContent = 'Fehler: ' + err.message;
  }
});

document.getElementById('resetSeasonBtn').addEventListener('click', () => startNextEvent());

// Startup and authentication are handled by manage.js.
