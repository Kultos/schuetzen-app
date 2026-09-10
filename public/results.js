'use strict';

const resultView = {
  shooterId: null,
  eventId: null,
  request: 0,
  rows: [],
  ready: false,
  busy: false,
  drafts: new Map(),
};
const resultElement = (id) => document.getElementById(id);

function matchingResultShooters() {
  const query = resultElement('resultSearch').value.trim().toLocaleLowerCase('de-DE');
  return state.shooters.filter((s) => `${s.start_number} ${s.name}`.toLocaleLowerCase('de-DE').includes(query));
}

function renderResultShooters() {
  const list = resultElement('resultShooters');
  list.replaceChildren();
  const matches = matchingResultShooters();
  for (const shooter of matches) {
    list.appendChild(el('button', {
      type: 'button', class: 'result-shooter',
      'aria-pressed': String(shooter.id === resultView.shooterId),
      text: `#${shooter.start_number} · ${shooter.name}`,
      onclick: () => {
        resultView.shooterId = shooter.id;
        resultElement('resultFeedback').textContent = '';
        renderResultShooters();
        loadResultsList();
      },
    }));
  }
  resultElement('resultSearchCount').textContent = matches.length
    ? `${matches.length} Schützen gefunden`
    : state.shooters.length ? 'Keine Treffer. Name oder Startnummer prüfen.' : 'Noch keine Teilnehmer im aktuellen Event.';
}

function resultLoading(message) {
  resultView.ready = false;
  resultElement('resultDisciplines').replaceChildren();
  resultElement('resultProgress').textContent = '';
  resultElement('resultLoadStatus').textContent = message;
}

async function refreshResultSelectors() {
  const request = ++resultView.request;
  resultLoading('Teilnehmer werden geladen …');
  resultElement('resultShooters').replaceChildren();
  resultElement('resultFeedback').textContent = '';
  if (resultView.eventId !== state.eventId) {
    resultView.eventId = state.eventId;
    resultView.drafts.clear();
  }
  try {
    const [shooters, disciplines] = await Promise.all([api('/api/shooters'), api('/api/disciplines')]);
    if (request !== resultView.request) return;
    state.shooters = shooters;
    state.disciplines = disciplines;
    if (!shooters.some((s) => s.id === resultView.shooterId)) resultView.shooterId = shooters[0]?.id ?? null;
    renderResultShooters();
    await loadResultsList();
  } catch (error) {
    if (request === resultView.request) resultLoadError(error, refreshResultSelectors);
  }
}

function resultLoadError(error, retry) {
  resultLoading(`Laden fehlgeschlagen: ${error.message}`);
  resultElement('resultDisciplines').appendChild(el('button', { type: 'button', text: 'Erneut laden', onclick: retry }));
}

async function loadResultsList() {
  const request = ++resultView.request;
  const shooterId = resultView.shooterId;
  const eventId = state.eventId;
  const shooter = state.shooters.find((s) => s.id === shooterId);
  resultElement('resultShooterName').textContent = shooter ? `#${shooter.start_number} · ${shooter.name}` : 'Schützen auswählen';
  resultLoading(shooter ? 'Ergebnisse werden geladen …' : 'Zuerst einen Teilnehmer unter „Schützen“ anlegen.');
  if (!shooter) return;
  try {
    const groups = await Promise.all(state.disciplines.map((discipline) => api(`/api/results?shooter_id=${shooterId}&discipline_id=${discipline.id}`)));
    // A late response must never replace another shooter's results.
    if (request !== resultView.request || eventId !== state.eventId) return;
    resultView.rows = groups.flat();
    resultView.ready = true;
    resultElement('resultLoadStatus').textContent = '';
    renderResultDisciplines();
  } catch (error) {
    if (request === resultView.request) resultLoadError(error, loadResultsList);
  }
}

function renderResultDisciplines() {
  if (!resultView.ready) return;
  const container = resultElement('resultDisciplines');
  container.replaceChildren();
  const shooter = state.shooters.find((s) => s.id === resultView.shooterId);
  const count = new Set(resultView.rows.map((r) => r.discipline_id)).size;
  resultElement('resultProgress').textContent = `${count} / ${state.disciplines.length} Disziplinen mit Ergebnissen`;
  for (const discipline of state.disciplines) {
    const rows = resultView.rows.filter((r) => r.discipline_id === discipline.id).sort((a, b) => a.round_number - b.round_number);
    if (resultElement('resultShotOnly').checked && !rows.length) continue;
    const best = rows.length ? Math.max(...rows.map((r) => r.points)) : null;
    const card = el('article', { class: 'result-discipline' });
    const details = el('div', {}, [
      el('h4', { text: discipline.name }),
      el('span', { class: 'hint', text: rows.length ? `✓ ${rows.length} Durchgänge erfasst` : '○ Noch kein Ergebnis' }),
    ]);
    const rounds = el('div', { class: 'result-rounds' });
    for (const row of rows) {
      const remove = el('button', {
        type: 'button', class: 'link danger-text', text: '×',
        'aria-label': `${discipline.name}: Durchgang ${row.round_number} mit ${formatPoints(row.points)} Punkten löschen`,
        onclick: () => {
          if (resultView.busy) return;
          if (!confirm(`${shooter.name} · ${discipline.name}: Durchgang ${row.round_number} (${formatPoints(row.points)} Punkte) löschen?`)) return;
          mutateResult(`/api/results/${row.id}`, { method: 'DELETE' }, `${shooter.name} · ${discipline.name}: Durchgang gelöscht.`);
        },
      });
      remove.disabled = resultView.busy;
      rounds.appendChild(el('span', { class: `result-round${row.points === best ? ' best' : ''}`, title: row.points === best ? 'Bester Durchgang' : 'Durchgang' }, [
        el('span', { text: `D${row.round_number} · ${formatPoints(row.points)}` }), remove,
      ]));
    }
    details.appendChild(rounds);
    const score = el('div', { class: 'result-best', text: best === null ? '–' : formatPoints(best) }, [el('small', { text: 'Bestwert · Punkte' })]);
    const key = `${state.eventId}:${shooter.id}:${discipline.id}`;
    const add = el('button', { type: 'button', id: `result-add-${discipline.id}`, text: rows.length ? '+ Durchgang' : '+ Erfassen', 'aria-expanded': String(resultView.drafts.has(key)) });
    add.disabled = resultView.busy;
    card.appendChild(el('div', { class: 'result-discipline-main' }, [details, score, add]));
    const openEntry = () => {
      const existing = card.querySelector('input');
      if (existing) { existing.focus(); return; }
      if (!resultView.drafts.has(key)) resultView.drafts.set(key, '');
      add.setAttribute('aria-expanded', 'true');
      const input = el('input', { id: `result-points-${discipline.id}`, type: 'number', step: '0.1', required: '', placeholder: 'Punkte', 'aria-label': `Punkte für ${discipline.name}` });
      input.value = resultView.drafts.get(key);
      input.disabled = resultView.busy;
      input.addEventListener('input', () => resultView.drafts.set(key, input.value));
      const save = el('button', { type: 'submit', text: 'Speichern' });
      save.disabled = resultView.busy;
      const cancel = el('button', { type: 'button', class: 'link', text: 'Abbrechen', onclick: () => {
        resultView.drafts.delete(key);
        form.remove();
        add.setAttribute('aria-expanded', 'false');
        add.focus();
      } });
      cancel.disabled = resultView.busy;
      const form = el('form', { class: 'result-entry' }, [
        el('label', { for: input.id, text: `${shooter.name} · ${discipline.name} · Durchgang ${Math.max(0, ...rows.map((r) => r.round_number)) + 1}` }),
        el('div', { class: 'inline-form' }, [input, save, cancel]),
      ]);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (resultView.busy || !Number.isFinite(input.valueAsNumber)) return;
        mutateResult('/api/results', {
          method: 'POST', body: JSON.stringify({ shooter_id: shooter.id, discipline_id: discipline.id, points: input.valueAsNumber }),
        }, `${shooter.name} · ${discipline.name}: ${formatPoints(input.valueAsNumber)} Punkte gespeichert.`, key, discipline.id);
      });
      card.appendChild(form);
    };
    add.addEventListener('click', () => { openEntry(); card.querySelector('input').focus(); });
    if (resultView.drafts.has(key)) openEntry();
    container.appendChild(card);
  }
  if (!container.children.length) container.appendChild(el('p', { class: 'hint', text: state.disciplines.length
    ? 'Noch keine Ergebnisse. Deaktiviere den Filter, um einen Durchgang zu erfassen.'
    : 'Zuerst eine Disziplin unter „Disziplinen“ anlegen.' }));
}

async function mutateResult(path, options, message, draftKey, disciplineId) {
  if (resultView.busy) return;
  const eventId = state.eventId;
  const shooterId = resultView.shooterId;
  resultView.busy = true;
  resultElement('resultFeedback').textContent = 'Wird gespeichert …';
  renderResultDisciplines();
  try {
    await api(path, { ...options, headers: { 'X-Event-Id': String(eventId) } });
    if (draftKey) resultView.drafts.delete(draftKey);
    if (eventId === state.eventId) {
      resultElement('resultFeedback').textContent = message;
      await loadResultsList();
    }
  } catch (error) {
    resultElement('resultFeedback').textContent = `Speichern fehlgeschlagen: ${error.message}`;
  } finally {
    resultView.busy = false;
    renderResultDisciplines();
    if (eventId === state.eventId && shooterId === resultView.shooterId && disciplineId && resultElement('tab-results').classList.contains('active')) {
      resultElement(`result-points-${disciplineId}`)?.focus();
      if (!resultElement(`result-points-${disciplineId}`)) resultElement(`result-add-${disciplineId}`)?.focus();
    }
  }
}

resultElement('resultSearch').addEventListener('input', renderResultShooters);
resultElement('resultSearch').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !matchingResultShooters().length) return;
  event.preventDefault();
  resultView.shooterId = matchingResultShooters()[0].id;
  renderResultShooters();
  loadResultsList();
  resultElement('resultShooterName').focus();
});
resultElement('resultShotOnly').addEventListener('change', renderResultDisciplines);
