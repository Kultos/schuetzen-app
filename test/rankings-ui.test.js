'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(api) {
  const nodes = new Map();
  function el(tag, attrs = {}, children = []) {
    return {
      tag, ...attrs, textContent: attrs.text || '', children,
      appendChild(child) { this.children.push(child); },
      replaceChildren(...items) { this.children = items; },
      addEventListener() {},
    };
  }
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, el('div'));
    return nodes.get(id);
  } };
  const state = { eventId: 1, disciplines: [
    { id: 1, name: 'Luftgewehr', ranking_mode: 'combined' },
    { id: 2, name: 'Pistole', ranking_mode: 'separate' },
  ] };
  const context = vm.createContext({ document, state, api, el, loadDisciplines: async () => {} });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  vm.runInContext(source.split('// ---------------- Rankings ----------------')[1].split('// ---------------- Import ----------------')[0], context);
  return { state, nodes, run: (code) => vm.runInContext(code, context) };
}

const entry = (name, group = 'combined') => ({ rank: 1, start_number: 4, name, gender: 'w', best_points: 0, all_rounds: [0], ranking_group: group });

test('Disziplinen sind direkt auswählbar und die Auswahl bleibt beim Öffnen erhalten', async () => {
  const ui = setup(async () => []);
  await ui.run('refreshRankingSelector()');
  const buttons = ui.nodes.get('rankingDisciplines').children;
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0]['aria-pressed'], 'true');
  buttons[1].onclick();
  await ui.run('refreshRankingSelector()');
  assert.equal(ui.nodes.get('rankingDisciplines').children[1]['aria-pressed'], 'true');
  assert.equal(ui.nodes.get('rankingDisciplineName').textContent, 'Pistole');
  ui.state.disciplines.pop();
  await ui.run('refreshRankingSelector()');
  assert.equal(ui.nodes.get('rankingDisciplineName').textContent, 'Luftgewehr');
});

test('Späte Antworten überschreiben weder Auswahl noch getrennte Wertung', async () => {
  const pending = [];
  const ui = setup(() => new Promise((resolve) => pending.push(resolve)));
  const first = ui.run('rankingView.disciplineId = 1; loadRanking()');
  const second = ui.run('rankingView.disciplineId = 2; loadRanking()');
  pending[1]([entry('Kim', 'women'), entry('Alex', 'men')]);
  await second;
  pending[0]([entry('Veraltet')]);
  await first;
  const tables = ui.nodes.get('rankingTables').children;
  assert.equal(tables.length, 4);
  assert.equal(tables[0].textContent, 'Frauen');
  assert.equal(tables[2].textContent, 'Männer');
  assert.equal(tables[1].children[1].children[0].children[2].textContent, 'Kim');
  assert.equal(ui.nodes.get('printTitle').textContent, 'Rangliste – Pistole');
  assert.equal(ui.nodes.get('printRankingBtn').disabled, false);
});

test('Leere Listen und Ladefehler werden angezeigt und verhindern leeres Drucken', async () => {
  let fail = false;
  const ui = setup(async () => { if (fail) throw new Error('Offline'); return []; });
  await ui.run('refreshRankingSelector()');
  assert.match(ui.nodes.get('rankingStatus').textContent, /keine Ergebnisse/);
  assert.equal(ui.nodes.get('printRankingBtn').disabled, true);
  fail = true;
  await ui.run('loadRanking()');
  assert.match(ui.nodes.get('rankingStatus').textContent, /Offline/);
  ui.state.disciplines = [];
  await ui.run('refreshRankingSelector()');
  assert.equal(ui.run('rankingView.disciplineId'), null);
  assert.match(ui.nodes.get('rankingStatus').textContent, /Disziplinen angelegt/);
});

test('Antworten aus einem vorherigen Event werden verworfen', async () => {
  let resolve;
  const ui = setup(() => new Promise((done) => { resolve = done; }));
  const loading = ui.run('rankingView.disciplineId = 1; loadRanking()');
  ui.state.eventId = 2;
  resolve([entry('Altes Event')]);
  await loading;
  assert.equal(ui.nodes.get('rankingTables').children.length, 0);
  assert.equal(ui.nodes.get('printRankingBtn').disabled, true);
});
