'use strict';

const initialState = {
  settings: { mode: 'both', maxSize: 5, scoringCount: 3 },
  disciplines: [
    { id: 'rifle', name: 'Luftgewehr' },
    { id: 'pistol', name: 'Luftpistole' },
  ],
  teams: [
    { id: 1, name: 'Die Volltreffer' },
    { id: 2, name: 'Adlerauge' },
    { id: 3, name: 'Ruhige Hand' },
    { id: 4, name: 'Ringjäger' },
  ],
  shooters: [
    { id: 12, name: 'Alex Beispiel', teamId: 1, results: { rifle: [{ points: 95, team: true }, { points: 97, team: false }], pistol: [{ points: 86, team: true }] } },
    { id: 18, name: 'Kim Muster', teamId: 1, results: { rifle: [{ points: 92, team: true }], pistol: [{ points: 91, team: true }] } },
    { id: 23, name: 'Robin Demo', teamId: 1, results: { rifle: [{ points: 88, team: true }], pistol: [] } },
    { id: 31, name: 'Toni Test', teamId: 1, results: { rifle: [{ points: 80, team: true }], pistol: [{ points: 93, team: true }] } },
    { id: 42, name: 'Sascha Beispiel', teamId: 2, results: { rifle: [{ points: 98, team: true }], pistol: [{ points: 82, team: true }] } },
    { id: 47, name: 'Andrea Schmitt', teamId: 2, results: { rifle: [{ points: 90, team: true }], pistol: [{ points: 94, team: true }] } },
    { id: 53, name: 'Martin Wolf', teamId: 2, results: { rifle: [{ points: 87, team: true }], pistol: [] } },
    { id: 58, name: 'Jan König', teamId: 3, results: { rifle: [{ points: 93, team: true }], pistol: [{ points: 90, team: true }] } },
    { id: 64, name: 'Samira Klein', teamId: 3, results: { rifle: [], pistol: [{ points: 96, team: true }] } },
    { id: 69, name: 'Chris Bauer', teamId: null, results: { rifle: [{ points: 89, team: false }], pistol: [] } },
    { id: 72, name: 'Mara Peters', teamId: 4, results: { rifle: [], pistol: [] } },
  ],
};

let state = structuredClone(initialState);
let selectedTeamId = 1;
let selectedShooterId = 12;
let selectedDisciplineId = 'rifle';
let selectedRanking = 'team';
let expandedTeamId = 1;
let feedbackTimer;

const $ = (id) => document.getElementById(id);
const formatPoints = (value) => value.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const teamById = (id) => state.teams.find((team) => team.id === id);
const selectedTeam = () => teamById(selectedTeamId);
const membersOf = (teamId) => state.shooters.filter((shooter) => shooter.teamId === teamId);
const disciplineById = (id) => state.disciplines.find((discipline) => discipline.id === id);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function showFeedback(message) {
  clearTimeout(feedbackTimer);
  $('feedback').textContent = message;
  feedbackTimer = setTimeout(() => { $('feedback').textContent = ''; }, 4000);
}

function switchView(viewName) {
  document.querySelectorAll('.step').forEach((button) => button.classList.toggle('active', button.dataset.view === viewName));
  document.querySelectorAll('.view').forEach((view) => {
    const active = view.id === `view-${viewName}`;
    view.hidden = !active;
    view.classList.toggle('active', active);
  });
  if (viewName === 'teams') renderTeams();
  if (viewName === 'results') renderResults();
  if (viewName === 'ranking') renderRanking();
  const hashes = { settings: 'regeln', teams: 'mannschaften', results: 'ergebnisse', ranking: 'rangliste' };
  window.history.replaceState(null, '', `#${hashes[viewName]}`);
}

function renderSettings() {
  const { mode, maxSize, scoringCount } = state.settings;
  document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
  $('maxSize').value = maxSize;
  $('scoringCount').value = scoringCount;
  $('teamMaxSize').textContent = maxSize;
  $('teamScoringCount').textContent = scoringCount;
  const disabled = mode === 'individual';
  $('maxSize').disabled = disabled;
  $('scoringCount').disabled = disabled;
}

function applySettings(event) {
  event.preventDefault();
  const mode = new FormData(event.currentTarget).get('mode');
  const maxSize = Number($('maxSize').value);
  const scoringCount = Number($('scoringCount').value);
  $('settingsError').textContent = '';
  if (mode !== 'individual' && (!Number.isInteger(maxSize) || !Number.isInteger(scoringCount) || maxSize < 1 || scoringCount < 1)) {
    $('settingsError').textContent = 'Bitte positive ganze Zahlen eintragen.';
    return;
  }
  if (mode !== 'individual' && scoringCount > maxSize) {
    $('settingsError').textContent = 'Die Zahl gewerteter Ergebnisse darf nicht größer als die Mannschaft sein.';
    return;
  }
  const largestTeam = Math.max(0, ...state.teams.map((team) => membersOf(team.id).length));
  if (mode !== 'individual' && maxSize < largestTeam) {
    $('settingsError').textContent = `Mindestens eine Mannschaft hat bereits ${largestTeam} Mitglieder.`;
    return;
  }
  state.settings = mode === 'individual' ? { ...state.settings, mode } : { mode, maxSize, scoringCount };
  selectedRanking = mode === 'individual' ? 'individual' : 'team';
  renderSettings();
  showFeedback('Event-Regeln für die Demo übernommen.');
}

function renderTeams() {
  if (!state.teams.some((team) => team.id === selectedTeamId)) selectedTeamId = state.teams[0]?.id ?? null;
  $('teamList').replaceChildren();
  for (const team of state.teams) {
    const count = membersOf(team.id).length;
    const button = node('button', `team-option${team.id === selectedTeamId ? ' active' : ''}`);
    button.type = 'button';
    button.append(node('strong', '', team.name), node('small', '', count === state.settings.maxSize ? 'Mannschaft vollständig' : `${state.settings.maxSize - count} Plätze frei`), node('span', 'capacity', `${count} / ${state.settings.maxSize}`));
    button.addEventListener('click', () => { selectedTeamId = team.id; renderTeams(); });
    $('teamList').append(button);
  }
  if (!state.teams.length) $('teamList').append(node('p', 'empty', 'Noch keine Mannschaft angelegt.'));
  renderMemberPanel();
}

function renderMemberPanel() {
  const team = selectedTeam();
  $('selectedTeamHeader').replaceChildren();
  $('memberList').replaceChildren();
  if (!team) {
    $('selectedTeamHeader').append(node('p', 'empty', 'Lege eine Mannschaft an, um Schützen zuzuordnen.'));
    $('memberSearch').disabled = true;
    return;
  }
  $('memberSearch').disabled = false;
  const count = membersOf(team.id).length;
  const head = document.createDocumentFragment();
  const title = node('div', 'team-detail-title');
  title.append(node('h3', '', team.name), node('small', '', `${count} von ${state.settings.maxSize} Plätzen belegt`));
  const actions = node('div', 'team-actions');
  const rename = node('button', 'link', 'Umbenennen');
  const remove = node('button', 'danger', 'Löschen');
  rename.type = remove.type = 'button';
  rename.addEventListener('click', () => renameTeam(team));
  remove.addEventListener('click', () => removeTeam(team));
  actions.append(rename, remove);
  head.append(title, actions);
  $('selectedTeamHeader').append(head);

  const query = $('memberSearch').value.trim().toLocaleLowerCase('de-DE');
  const matching = state.shooters.filter((shooter) => `${shooter.id} ${shooter.name}`.toLocaleLowerCase('de-DE').includes(query));
  for (const shooter of matching) {
    const row = node('tr');
    const currentTeam = teamById(shooter.teamId);
    const select = node('select');
    select.setAttribute('aria-label', `Mannschaft für ${shooter.name}`);
    select.append(new Option('Ohne Mannschaft', ''));
    state.teams.forEach((item) => select.append(new Option(item.name, item.id)));
    select.value = shooter.teamId ?? '';
    select.addEventListener('change', () => assignShooter(shooter, select));
    const numberCell = node('td', 'start-number-cell', shooter.id);
    const nameCell = node('td', '', shooter.name);
    const teamCell = node('td', 'current-team', currentTeam ? currentTeam.name : 'Ohne Mannschaft');
    const selectCell = node('td');
    selectCell.append(select);
    row.append(numberCell, nameCell, teamCell, selectCell);
    $('memberList').append(row);
  }
  if (!matching.length) {
    const row = node('tr');
    const cell = node('td', 'empty', 'Keine Schützen gefunden.');
    cell.colSpan = 4;
    row.append(cell);
    $('memberList').append(row);
  }
}

function assignShooter(shooter, select) {
  const newTeamId = select.value ? Number(select.value) : null;
  if (newTeamId && membersOf(newTeamId).length >= state.settings.maxSize && shooter.teamId !== newTeamId) {
    showFeedback(`${teamById(newTeamId).name} ist bereits voll.`);
    select.value = shooter.teamId ?? '';
    return;
  }
  const oldTeam = teamById(shooter.teamId);
  shooter.teamId = newTeamId;
  const newTeam = teamById(newTeamId);
  showFeedback(newTeam ? `${shooter.name} ist jetzt in „${newTeam.name}“.` : `${shooter.name} ist jetzt ohne Mannschaft.`);
  if (oldTeam && oldTeam.id !== selectedTeamId && newTeamId !== selectedTeamId) selectedTeamId = oldTeam.id;
  renderTeams();
}

function renameTeam(team) {
  const nextName = window.prompt('Neuer Mannschaftsname:', team.name)?.trim();
  if (!nextName || nextName === team.name) return;
  if (state.teams.some((item) => item.id !== team.id && item.name.toLocaleLowerCase('de-DE') === nextName.toLocaleLowerCase('de-DE'))) {
    showFeedback('Dieser Mannschaftsname ist bereits vergeben.');
    return;
  }
  team.name = nextName;
  renderTeams();
  showFeedback('Mannschaft umbenannt.');
}

function removeTeam(team) {
  if (!window.confirm(`„${team.name}“ löschen? Die ${membersOf(team.id).length} Mitglieder bleiben als Schützen erhalten.`)) return;
  membersOf(team.id).forEach((shooter) => { shooter.teamId = null; });
  state.teams = state.teams.filter((item) => item.id !== team.id);
  selectedTeamId = state.teams[0]?.id ?? null;
  renderTeams();
  showFeedback('Mannschaft gelöscht; ihre Schützen sind jetzt ohne Mannschaft.');
}

function createTeam(event) {
  event.preventDefault();
  const name = $('newTeamName').value.trim();
  if (!name) return;
  if (state.teams.some((team) => team.name.toLocaleLowerCase('de-DE') === name.toLocaleLowerCase('de-DE'))) {
    showFeedback('Dieser Mannschaftsname ist bereits vergeben.');
    return;
  }
  const id = Math.max(0, ...state.teams.map((team) => team.id)) + 1;
  state.teams.push({ id, name });
  selectedTeamId = id;
  event.currentTarget.reset();
  event.currentTarget.hidden = true;
  $('showTeamForm').hidden = false;
  renderTeams();
  showFeedback(`Mannschaft „${name}“ angelegt.`);
}

function createShooter(event) {
  event.preventDefault();
  const name = $('newShooterName').value.trim();
  if (!name) return;
  if (state.shooters.some((shooter) => shooter.name.toLocaleLowerCase('de-DE') === name.toLocaleLowerCase('de-DE'))) {
    showFeedback('Ein Schütze mit diesem Namen ist bereits vorhanden.');
    return;
  }
  if (selectedTeamId && membersOf(selectedTeamId).length >= state.settings.maxSize) {
    showFeedback('Die ausgewählte Mannschaft ist voll. Die Person wurde nicht angelegt.');
    return;
  }
  const results = Object.fromEntries(state.disciplines.map((discipline) => [discipline.id, []]));
  const id = Math.max(0, ...state.shooters.map((shooter) => shooter.id)) + 1;
  state.shooters.push({ id, name, teamId: selectedTeamId, results });
  event.currentTarget.reset();
  renderTeams();
  showFeedback(selectedTeamId ? `${name} wurde angelegt und der Mannschaft zugeordnet.` : `${name} wurde ohne Mannschaft angelegt.`);
}

function renderResults() {
  const query = $('resultSearch').value.trim().toLocaleLowerCase('de-DE');
  const matches = state.shooters.filter((shooter) => `${shooter.id} ${shooter.name}`.toLocaleLowerCase('de-DE').includes(query));
  $('resultShooters').replaceChildren();
  matches.forEach((shooter) => {
    const button = node('button', 'result-shooter', `#${shooter.id} · ${shooter.name}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(shooter.id === selectedShooterId));
    button.addEventListener('click', () => { selectedShooterId = shooter.id; renderResults(); });
    $('resultShooters').append(button);
  });
  $('resultSearchCount').textContent = `${matches.length} Schützen gefunden`;
  const shooter = state.shooters.find((item) => item.id === selectedShooterId);
  if (!shooter) return;
  const team = teamById(shooter.teamId);
  $('resultShooterName').textContent = `#${shooter.id} · ${shooter.name}`;
  $('resultTeam').replaceChildren(node('span', 'team-badge', team?.name || 'Ohne Mannschaft'));
  $('resultDisciplines').replaceChildren();
  state.disciplines.forEach((discipline) => $('resultDisciplines').append(renderDisciplineCard(shooter, discipline)));
}

function renderDisciplineCard(shooter, discipline) {
  const rounds = shooter.results[discipline.id] || (shooter.results[discipline.id] = []);
  const card = node('article', 'result-discipline');
  const main = node('div', 'result-discipline-main');
  const details = node('div');
  details.append(node('h4', '', discipline.name));
  if (rounds.length) {
    const chips = node('div', 'result-rounds');
    rounds.forEach((round, index) => {
      const chip = node('span', `result-round prototype-round${round.team ? ' team-counted' : ''}`);
      chip.append(node('span', '', `D${index + 1}: ${formatPoints(round.points)}`));
      const mark = node('button', '', round.team ? '✓ Mannschaft' : 'Mannschaft');
      mark.type = 'button';
      mark.title = round.team ? 'Mannschaftsmarkierung entfernen' : 'Diesen Durchgang für die Mannschaft werten';
      mark.addEventListener('click', () => toggleTeamRound(rounds, index));
      chip.append(mark);
      chips.append(chip);
    });
    details.append(chips);
  } else {
    details.append(node('span', 'hint', 'Noch kein Ergebnis'));
  }
  const best = rounds.length ? Math.max(...rounds.map((round) => round.points)) : null;
  const bestCell = node('div', 'result-best', best === null ? '–' : formatPoints(best));
  bestCell.append(node('small', '', 'Bestwert'));
  const add = node('button', '', rounds.length ? '+ Durchgang' : '+ Erfassen');
  add.type = 'button';
  add.addEventListener('click', () => openRoundForm(card, shooter, discipline));
  main.append(details, bestCell, add);
  card.append(main);
  return card;
}

function openRoundForm(card, shooter, discipline) {
  if (card.querySelector('form')) return;
  const rounds = shooter.results[discipline.id];
  const form = node('form', 'result-entry');
  const label = node('label', '', `${shooter.name} · ${discipline.name} · Durchgang ${rounds.length + 1}`);
  const fields = node('div', 'inline-form');
  const input = node('input');
  input.type = 'number'; input.min = '0'; input.step = '0.1'; input.required = true; input.placeholder = 'Punkte';
  const countsLabel = node('label', 'team-checkbox');
  const counts = node('input'); counts.type = 'checkbox'; counts.checked = !rounds.some((round) => round.team);
  countsLabel.append(counts, document.createTextNode('Für Mannschaft werten'));
  const save = node('button', '', 'Speichern'); save.type = 'submit';
  const cancel = node('button', 'link', 'Abbrechen'); cancel.type = 'button'; cancel.addEventListener('click', () => form.remove());
  fields.append(input, countsLabel, save, cancel);
  form.append(label, fields);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const points = input.valueAsNumber;
    if (!Number.isFinite(points) || points < 0) return;
    if (counts.checked) rounds.forEach((round) => { round.team = false; });
    rounds.push({ points, team: counts.checked });
    renderResults();
    showFeedback(`${formatPoints(points)} Punkte gespeichert.`);
  });
  card.append(form);
  input.focus();
}

function toggleTeamRound(rounds, index) {
  const wasMarked = rounds[index].team;
  rounds.forEach((round) => { round.team = false; });
  rounds[index].team = !wasMarked;
  renderResults();
  showFeedback(wasMarked ? 'Mannschaftsmarkierung entfernt.' : 'Dieser Durchgang zählt jetzt für die Mannschaft.');
}

function teamRanking(disciplineId) {
  const entries = state.teams.map((team) => {
    const members = membersOf(team.id).map((shooter) => {
      const marked = (shooter.results[disciplineId] || []).find((round) => round.team);
      return { shooter, points: marked?.points ?? null };
    });
    const withResults = members.filter((member) => member.points !== null).sort((a, b) => b.points - a.points || a.shooter.name.localeCompare(b.shooter.name, 'de'));
    const counted = withResults.slice(0, state.settings.scoringCount);
    return { team, members, counted, total: counted.reduce((sum, member) => sum + member.points, 0), resultCount: withResults.length };
  }).filter((entry) => entry.resultCount > 0);
  entries.sort((a, b) => b.total - a.total || compareScoreVectors(a.counted, b.counted) || a.team.name.localeCompare(b.team.name, 'de'));
  let previous = null;
  entries.forEach((entry, index) => {
    const signature = `${entry.total}|${entry.counted.map((member) => member.points).join('|')}`;
    entry.rank = signature === previous?.signature ? previous.rank : index + 1;
    previous = { signature, rank: entry.rank };
  });
  return entries;
}

function compareScoreVectors(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return 1;
    if (b[index] === undefined) return -1;
    if (a[index].points !== b[index].points) return b[index].points - a[index].points;
  }
  return 0;
}

function individualRanking(disciplineId) {
  const entries = state.shooters.map((shooter) => {
    const rounds = shooter.results[disciplineId] || [];
    return { shooter, best: rounds.length ? Math.max(...rounds.map((round) => round.points)) : null, rounds };
  }).filter((entry) => entry.best !== null).sort((a, b) => b.best - a.best || a.shooter.name.localeCompare(b.shooter.name, 'de'));
  let lastPoints = null;
  let lastRank = 0;
  entries.forEach((entry, index) => {
    if (entry.best !== lastPoints) lastRank = index + 1;
    entry.rank = lastRank;
    lastPoints = entry.best;
  });
  return entries;
}

function renderRanking() {
  if (state.settings.mode === 'individual') selectedRanking = 'individual';
  if (state.settings.mode === 'team') selectedRanking = 'team';
  $('rankingDisciplines').replaceChildren();
  state.disciplines.forEach((discipline) => {
    const button = node('button', discipline.id === selectedDisciplineId ? 'active' : '');
    button.type = 'button';
    button.append(node('strong', '', discipline.name), node('small', '', 'Gemeinsame Wertung'));
    button.addEventListener('click', () => { selectedDisciplineId = discipline.id; renderRanking(); });
    $('rankingDisciplines').append(button);
  });
  $('rankingDisciplineName').textContent = disciplineById(selectedDisciplineId)?.name || 'Disziplin auswählen';
  document.querySelectorAll('[data-ranking]').forEach((button) => {
    const type = button.dataset.ranking;
    button.hidden = (type === 'individual' && state.settings.mode === 'team') || (type === 'team' && state.settings.mode === 'individual');
    button.classList.toggle('active', type === selectedRanking);
  });
  if (selectedRanking === 'team') renderTeamRanking(selectedDisciplineId);
  else renderIndividualRanking(selectedDisciplineId);
}

function renderTeamRanking(disciplineId) {
  const scoringCount = state.settings.scoringCount;
  $('rankingExplanation').textContent = `Je Mannschaft zählen bis zu ${scoringCount} markierte Ergebnisse. Bei Punktgleichheit entscheidet das beste Einzelergebnis.`;
  const entries = teamRanking(disciplineId);
  if (!entries.length) {
    $('rankingContent').replaceChildren(node('p', 'empty', 'Noch keine markierten Mannschaftsergebnisse in dieser Disziplin.'));
    return;
  }
  const table = node('table', 'data-table ranking-table');
  const head = node('thead');
  const headerRow = node('tr');
  ['Rang', 'Mannschaft', 'Stand', 'Punkte'].forEach((label) => headerRow.append(node('th', '', label)));
  head.append(headerRow); table.append(head);
  const body = node('tbody');
  entries.forEach((entry) => {
    const row = node('tr', 'team-ranking-row');
    row.tabIndex = 0;
    row.setAttribute('aria-expanded', String(expandedTeamId === entry.team.id));
    const teamCell = node('td', 'ranking-team-name');
    teamCell.append(node('strong', '', `${expandedTeamId === entry.team.id ? '▾' : '▸'} ${entry.team.name}`), node('small', '', ` ${membersOf(entry.team.id).length} Mitglieder`));
    const scoreCell = node('td', 'ranking-score', formatPoints(entry.total));
    row.append(node('td', 'rank-cell', entry.rank), teamCell, node('td', '', `${Math.min(entry.resultCount, scoringCount)} / ${scoringCount} Ergebnisse`), scoreCell);
    const toggle = () => { expandedTeamId = expandedTeamId === entry.team.id ? null : entry.team.id; renderRanking(); };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
    body.append(row);
    if (expandedTeamId === entry.team.id) body.append(teamDetailRow(entry));
  });
  table.append(body);
  $('rankingContent').replaceChildren(table);
}

function teamDetailRow(entry) {
  const row = node('tr', 'detail-row');
  const cell = node('td'); cell.colSpan = 4;
  const details = node('div', 'ranking-details');
  const countedIds = new Set(entry.counted.map((member) => member.shooter.id));
  const ordered = [...entry.members].sort((a, b) => (b.points ?? -1) - (a.points ?? -1));
  ordered.forEach((member) => {
    const line = node('div', 'detail-member');
    let status = 'Kein Mannschaftsergebnis';
    let statusClass = '';
    if (countedIds.has(member.shooter.id)) { status = '✓ Gewertet'; statusClass = 'included'; }
    else if (member.points !== null) { status = 'Streichergebnis'; statusClass = 'dropped'; }
    line.append(node('strong', '', member.shooter.name), node('span', '', member.points === null ? '–' : formatPoints(member.points)), node('span', statusClass, status));
    details.append(line);
  });
  cell.append(details); row.append(cell);
  return row;
}

function renderIndividualRanking(disciplineId) {
  $('rankingExplanation').textContent = 'Für die Einzelwertung zählt der beste erfasste Durchgang jeder Person.';
  const entries = individualRanking(disciplineId);
  const table = node('table', 'data-table ranking-table');
  const head = node('thead'); const headerRow = node('tr');
  ['Rang', 'Schütze', 'Mannschaft', 'Bestwert'].forEach((label) => headerRow.append(node('th', '', label)));
  head.append(headerRow); table.append(head);
  const body = node('tbody');
  entries.forEach((entry) => {
    const row = node('tr');
    const score = node('td', 'ranking-score', formatPoints(entry.best));
    row.append(node('td', 'rank-cell', entry.rank), node('td', '', entry.shooter.name), node('td', '', teamById(entry.shooter.teamId)?.name || '–'), score);
    body.append(row);
  });
  table.append(body);
  $('rankingContent').replaceChildren(table);
}

document.querySelectorAll('.step').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
document.querySelectorAll('input[name="mode"]').forEach((input) => input.addEventListener('change', () => {
  const disabled = input.value === 'individual' && input.checked;
  $('maxSize').disabled = disabled; $('scoringCount').disabled = disabled;
}));
$('settingsForm').addEventListener('submit', applySettings);
$('showTeamForm').addEventListener('click', () => { $('teamForm').hidden = false; $('showTeamForm').hidden = true; $('newTeamName').focus(); });
$('cancelTeam').addEventListener('click', () => { $('teamForm').hidden = true; $('showTeamForm').hidden = false; $('teamForm').reset(); });
$('teamForm').addEventListener('submit', createTeam);
$('shooterForm').addEventListener('submit', createShooter);
$('memberSearch').addEventListener('input', renderMemberPanel);
$('resultSearch').addEventListener('input', renderResults);
$('resultSearch').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const query = event.currentTarget.value.trim().toLocaleLowerCase('de-DE');
  const first = state.shooters.find((shooter) => `${shooter.id} ${shooter.name}`.toLocaleLowerCase('de-DE').includes(query));
  if (first) { event.preventDefault(); selectedShooterId = first.id; renderResults(); $('resultShooterName').focus(); }
});
document.querySelectorAll('[data-ranking]').forEach((button) => button.addEventListener('click', () => { selectedRanking = button.dataset.ranking; renderRanking(); }));
$('resetDemo').addEventListener('click', () => {
  state = structuredClone(initialState); selectedTeamId = 1; selectedShooterId = 12; selectedDisciplineId = 'rifle'; selectedRanking = 'team'; expandedTeamId = 1;
  $('memberSearch').value = ''; $('resultSearch').value = ''; renderSettings(); switchView('teams'); showFeedback('Demo wurde zurückgesetzt.');
});

renderSettings();
const viewForHash = { '#regeln': 'settings', '#mannschaften': 'teams', '#ergebnisse': 'results', '#rangliste': 'ranking' };
switchView(viewForHash[window.location.hash] || 'teams');
