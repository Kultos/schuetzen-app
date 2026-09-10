'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A small DOM stand-in exercises the actual view and async request handling.
function setup(api) {
  const nodes = new Map();
  function node(tag = 'div', attrs = {}, children = []) {
    const n = {
      tag, children, value: '', checked: false, textContent: attrs.text || '',
      listeners: {}, classList: { contains: () => true },
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...items) { this.children = items; },
      setAttribute(key, value) { this[key] = value; },
      addEventListener(type, callback) { this.listeners[type] = callback; },
      querySelector(tagName) {
        for (const child of this.children) {
          if (child.tag === tagName) return child;
          const match = child.querySelector(tagName);
          if (match) return match;
        }
        return null;
      },
      focus() {},
    };
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on')) n.listeners[key.slice(2)] = value;
      else n[key] = value;
    }
    return n;
  }
  const document = { getElementById: (id) => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  } };
  const state = { eventId: 1, shooters: [{ id: 1, start_number: 12, name: 'Alex' }, { id: 2, start_number: 42, name: 'Kim' }], disciplines: [{ id: 3, name: 'Luftgewehr' }, { id: 4, name: 'Pistole' }] };
  const context = vm.createContext({ document, state, api, el: node, formatPoints: String, confirm: () => true });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/results.js'), 'utf8'), context);
  return { state, nodes, run: (source) => vm.runInContext(source, context) };
}

test('Ergebnissuche findet Startnummern und Namen ohne Groß-/Kleinschreibung', () => {
  const ui = setup();
  ui.nodes.get('resultSearch').value = '42';
  assert.equal(ui.run('matchingResultShooters()[0].name'), 'Kim');
  ui.nodes.get('resultSearch').value = ' aLEX ';
  assert.equal(ui.run('matchingResultShooters()[0].start_number'), 12);
});

test('Späte Ergebnisse eines vorherigen Schützen überschreiben die aktuelle Übersicht nicht', async () => {
  const pending = [];
  const ui = setup((url) => new Promise((resolve) => pending.push({ url, resolve })));
  const first = ui.run('resultView.shooterId = 1; loadResultsList()');
  const second = ui.run('resultView.shooterId = 2; loadResultsList()');
  pending.slice(2).forEach((p) => p.resolve([{ id: 8, discipline_id: 3, round_number: 1, points: 0 }]));
  await second;
  pending.slice(0, 2).forEach((p) => p.resolve([{ id: 9, discipline_id: 3, round_number: 1, points: 99 }]));
  await first;
  assert.equal(ui.run('resultView.rows[0].id'), 8);
  assert.match(ui.nodes.get('resultShooterName').textContent, /Kim/);
});

test('Null Punkte zählen als Ergebnis, Bestwert und Filter bleiben korrekt', async () => {
  const ui = setup(async (url) => url.endsWith('=3') ? [{ id: 7, discipline_id: 3, round_number: 2, points: 0 }] : []);
  await ui.run('resultView.shooterId = 1; loadResultsList()');
  assert.equal(ui.nodes.get('resultDisciplines').children.length, 2);
  assert.equal(ui.nodes.get('resultDisciplines').children[0].children[0].children[1].textContent, '0');
  ui.nodes.get('resultShotOnly').checked = true;
  ui.run('renderResultDisciplines()');
  assert.equal(ui.nodes.get('resultDisciplines').children.length, 1);
  assert.match(ui.nodes.get('resultProgress').textContent, /^1 \/ 2/);
});

test('Fehlgeschlagenes Speichern erhält den Entwurf und entsperrt die Eingabe', async () => {
  const ui = setup(async () => { throw new Error('Keine Verbindung'); });
  await ui.run("resultView.shooterId = 1; resultView.drafts.set('1:1:3', '91.5'); mutateResult('/api/results', {method: 'POST'}, 'Gespeichert', '1:1:3', 3)");
  assert.equal(ui.run("resultView.drafts.get('1:1:3')"), '91.5');
  assert.equal(ui.run('resultView.busy'), false);
  assert.match(ui.nodes.get('resultFeedback').textContent, /Keine Verbindung/);
});

test('Speichern verwendet den ursprünglichen Eventkontext und verhindert doppelte Anfragen', async () => {
  const calls = [];
  let finish;
  const ui = setup((url, options) => {
    calls.push(options);
    return new Promise((resolve) => { finish = resolve; });
  });
  const saving = ui.run("resultView.shooterId = 1; resultView.drafts.set('1:1:3', '91'); mutateResult('/api/results', {method: 'POST'}, 'Gespeichert', '1:1:3', 3)");
  await ui.run("mutateResult('/api/results', {method: 'POST'}, 'Doppelt')");
  ui.state.eventId = 2;
  finish({});
  await saving;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['X-Event-Id'], '1');
  assert.equal(ui.run("resultView.drafts.has('1:1:3')"), false);
});
