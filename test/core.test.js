'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, beforeEach, test } = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schuetzen-app-test-'));
process.env.SCHUETZEN_DATA_DIR = testDataDir;

const {
  db,
  Shooters,
  Disciplines,
  Results,
  Season,
  rankingForDiscipline,
  fullExport,
  validateSeasonArchive,
  restoreSeasonArchive,
  resetSeason,
  ARCHIVE_DIR,
} = require('../db');
const { server } = require('../server');

let baseUrl;

function clearArchives() {
  for (const name of fs.readdirSync(ARCHIVE_DIR)) {
    fs.rmSync(path.join(ARCHIVE_DIR, name), { force: true });
  }
}

function archiveFixture(overrides = {}) {
  return {
    event_title: 'Vereinsschießen 2026',
    shooters: [
      { id: 7, name: 'Anna Adler', gender: 'w', created_at: '2026-08-30 10:00:00' },
    ],
    disciplines: [
      { id: 4, name: 'Luftgewehr', sort_order: 1, created_at: '2026-08-30 10:01:00' },
    ],
    results: [
      {
        id: 11,
        shooter_id: 7,
        discipline_id: 4,
        round_number: 1,
        points: 98.5,
        created_at: '2026-08-30 10:02:00',
      },
    ],
    ...overrides,
  };
}

async function api(pathname, options = {}) {
  const requestOptions = { ...options };
  if (Object.hasOwn(requestOptions, 'json')) {
    requestOptions.body = JSON.stringify(requestOptions.json);
    requestOptions.headers = { 'Content-Type': 'application/json', ...requestOptions.headers };
    delete requestOptions.json;
  }
  const response = await fetch(baseUrl + pathname, requestOptions);
  const text = await response.text();
  let body = text;
  if ((response.headers.get('content-type') || '').includes('application/json')) {
    body = text ? JSON.parse(text) : null;
  }
  return { response, body };
}

before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  resetSeason();
  clearArchives();
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  db.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test('Dateneingabe und Datenänderungen funktionieren mit isolierter SQLite-Datenbank', () => {
  const berta = Shooters.create({ name: 'Berta', gender: 'w' });
  const anna = Shooters.create({ name: 'Anna', gender: 'w' });
  assert.deepEqual(Shooters.list().map((shooter) => shooter.name), ['Anna', 'Berta']);
  assert.equal(berta.start_number, 1);
  assert.equal(anna.start_number, 2);

  const gewehr = Disciplines.create({ name: 'Luftgewehr' });
  const pistole = Disciplines.create({ name: 'Pistole' });
  assert.deepEqual(Disciplines.list().map((discipline) => discipline.sort_order), [1, 2]);

  const first = Results.create({
    shooter_id: anna.id,
    discipline_id: gewehr.id,
    round_number: 1,
    points: 97.5,
  });
  assert.equal(Results.nextRoundNumber(anna.id, gewehr.id), 2);

  const changedShooter = Shooters.update(anna.id, { name: 'Anna Adler', gender: 'w' });
  const changedDiscipline = Disciplines.update(pistole.id, { name: 'Luftpistole' });
  const changedResult = Results.update(first.id, { round_number: 2, points: 99 });
  assert.equal(changedShooter.name, 'Anna Adler');
  assert.equal(changedDiscipline.name, 'Luftpistole');
  assert.equal(changedResult.points, 99);
  assert.equal(changedResult.round_number, 2);
  assert.equal(Shooters.findById(berta.id).name, 'Berta');

  Shooters.remove(anna.id);
  assert.equal(Shooters.findById(anna.id), undefined);
  assert.deepEqual(Results.listForShooterDiscipline(anna.id, gewehr.id), []);
});

test('Startnummern werden vorgeschlagen, bleiben eindeutig und können bei Konflikten getauscht werden', async () => {
  let result = await api('/api/shooters/next-start-number');
  assert.deepEqual(result.body, { start_number: 1 });

  const anna = (await api('/api/shooters', {
    method: 'POST',
    json: { name: 'Anna', gender: 'w', start_number: 7 },
  })).body;
  const berta = (await api('/api/shooters', {
    method: 'POST',
    json: { name: 'Berta', gender: 'w' },
  })).body;
  assert.equal(anna.start_number, 7);
  assert.equal(berta.start_number, 1);

  result = await api('/api/shooters/next-start-number');
  assert.equal(result.body.start_number, 2);

  result = await api('/api/shooters', {
    method: 'POST',
    json: { name: 'Carla', gender: 'w', start_number: 7 },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'START_NUMBER_CONFLICT');
  assert.equal(result.body.conflicting_shooter.id, anna.id);
  assert.equal(result.body.suggested_start_number, 2);

  result = await api(`/api/shooters/${berta.id}`, {
    method: 'PUT',
    json: { name: 'Berta', gender: 'w', start_number: 7 },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.conflicting_shooter.id, anna.id);

  result = await api(`/api/shooters/${berta.id}`, {
    method: 'PUT',
    json: { name: 'Berta', gender: 'w', start_number: 7, conflict_resolution: 'swap' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.start_number, 7);
  assert.equal(Shooters.findById(anna.id).start_number, 1);
  assert.deepEqual(Shooters.list().map((shooter) => shooter.start_number).sort((a, b) => a - b), [1, 7]);
});

test('Startnummern werden exportiert, alte Archive ergänzt und mit der Saison zurückgesetzt', async () => {
  Shooters.create({ name: 'Exportiert', gender: 'm', start_number: 42 });
  assert.equal(fullExport().shooters[0].start_number, 42);

  const oldArchive = validateSeasonArchive(archiveFixture());
  assert.equal(oldArchive.shooters[0].start_number, 1);

  const duplicateArchive = archiveFixture({
    shooters: [
      { id: 7, name: 'Anna', gender: 'w', start_number: 3, created_at: '2026-08-30 10:00:00' },
      { id: 8, name: 'Berta', gender: 'w', start_number: 3, created_at: '2026-08-30 10:01:00' },
    ],
  });
  assert.throws(() => validateSeasonArchive(duplicateArchive), /Startnummer 3 kommt mehrfach vor/);

  await api('/api/season/reset', { method: 'POST', json: {} });
  assert.equal(Shooters.nextStartNumber(), 1);
});

test('Rangliste berücksichtigt alle Folgeserien, Anzahl der Serien und Namen', () => {
  const discipline = Disciplines.create({ name: 'Luftgewehr' });
  const shooters = ['Dora', 'Berta', 'Carla', 'Anna'].map((name) =>
    Shooters.create({ name, gender: 'w' })
  );
  const pointsByName = {
    Anna: [100, 95],
    Berta: [100, 94],
    Carla: [100, 95],
    Dora: [100],
  };
  for (const shooter of shooters) {
    pointsByName[shooter.name].forEach((points, index) => {
      Results.create({
        shooter_id: shooter.id,
        discipline_id: discipline.id,
        round_number: index + 1,
        points,
      });
    });
  }

  const ranking = rankingForDiscipline(discipline.id);
  assert.deepEqual(ranking.map((entry) => entry.name), ['Anna', 'Carla', 'Berta', 'Dora']);
  assert.deepEqual(ranking.map((entry) => entry.rank), [1, 2, 3, 4]);
  assert.deepEqual(ranking[0].all_rounds, [100, 95]);
});

test('API validiert Eingaben und meldet fehlende oder doppelte Datensätze eindeutig', async () => {
  let result = await api('/api/shooters', {
    method: 'POST',
    json: { name: '   ', gender: 'w' },
  });
  assert.equal(result.response.status, 400);

  result = await api('/api/shooters', {
    method: 'POST',
    json: { name: '  Max Muster  ', gender: 'm' },
  });
  assert.equal(result.response.status, 201);
  const shooter = result.body;
  assert.equal(shooter.name, 'Max Muster');

  result = await api(`/api/shooters/${shooter.id}`, {
    method: 'PUT',
    json: { name: 'Max Neu', gender: 'x' },
  });
  assert.equal(result.response.status, 400);

  result = await api('/api/shooters/999999', {
    method: 'PUT',
    json: { name: 'Niemand', gender: 'm' },
  });
  assert.equal(result.response.status, 404);

  result = await api('/api/disciplines', {
    method: 'POST',
    json: { name: 'Luftgewehr' },
  });
  assert.equal(result.response.status, 201);
  const discipline = result.body;

  result = await api('/api/disciplines', {
    method: 'POST',
    json: { name: 'luftGEWEHR' },
  });
  assert.equal(result.response.status, 409);

  result = await api('/api/results', {
    method: 'POST',
    json: { shooter_id: shooter.id, discipline_id: discipline.id, points: 'keine Zahl' },
  });
  assert.equal(result.response.status, 400);

  result = await api('/api/results', {
    method: 'POST',
    json: { shooter_id: shooter.id, discipline_id: discipline.id, points: '   ' },
  });
  assert.equal(result.response.status, 400);

  result = await api('/api/results', {
    method: 'POST',
    json: { shooter_id: shooter.id, discipline_id: discipline.id, points: 98, round_number: 1.5 },
  });
  assert.equal(result.response.status, 400);

  const first = await api('/api/results', {
    method: 'POST',
    json: { shooter_id: shooter.id, discipline_id: discipline.id, points: 98 },
  });
  const second = await api('/api/results', {
    method: 'POST',
    json: { shooter_id: shooter.id, discipline_id: discipline.id, points: 99 },
  });
  assert.equal(first.response.status, 201);
  assert.equal(second.body.round_number, 2);

  result = await api(`/api/results/${first.body.id}`, {
    method: 'PUT',
    json: { points: 99.5, round_number: 3 },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.points, 99.5);

  result = await api('/api/results/999999', { method: 'DELETE' });
  assert.equal(result.response.status, 404);
});

test('API-CRUD liefert gespeicherte Änderungen und aktualisierte Ranglisten', async () => {
  let result = await api('/api/shooters', { method: 'POST', json: { name: 'Karl', gender: 'm' } });
  const shooter = result.body;
  result = await api(`/api/shooters/${shooter.id}`, {
    method: 'PUT',
    json: { name: 'Karl König', gender: 'm' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.name, 'Karl König');

  result = await api('/api/shooters');
  assert.deepEqual(result.body.map((item) => item.name), ['Karl König']);

  result = await api('/api/disciplines', { method: 'POST', json: { name: 'Gewehr' } });
  const discipline = result.body;
  result = await api(`/api/disciplines/${discipline.id}`, {
    method: 'PUT',
    json: { name: 'Luftgewehr' },
  });
  assert.equal(result.body.name, 'Luftgewehr');
  result = await api('/api/disciplines');
  assert.deepEqual(result.body.map((item) => item.name), ['Luftgewehr']);

  const created = await api('/api/results', {
    method: 'POST',
    json: { shooter_id: shooter.id, discipline_id: discipline.id, points: 97 },
  });
  result = await api(`/api/results?shooter_id=${shooter.id}&discipline_id=${discipline.id}`);
  assert.equal(result.response.status, 200);
  assert.equal(result.body[0].points, 97);

  result = await api(`/api/rankings/${discipline.id}`);
  assert.equal(result.body[0].name, 'Karl König');
  assert.equal(result.body[0].best_points, 97);

  result = await api(`/api/results/${created.body.id}`, { method: 'DELETE' });
  assert.equal(result.response.status, 200);
  assert.deepEqual(Results.listForShooterDiscipline(shooter.id, discipline.id), []);

  await api('/api/results', {
    method: 'POST',
    json: { shooter_id: shooter.id, discipline_id: discipline.id, points: 96 },
  });
  result = await api(`/api/disciplines/${discipline.id}`, { method: 'DELETE' });
  assert.equal(result.response.status, 200);
  assert.deepEqual(Results.listForShooterDiscipline(shooter.id, discipline.id), []);

  result = await api(`/api/shooters/${shooter.id}`, { method: 'DELETE' });
  assert.equal(result.response.status, 200);
  assert.deepEqual(Shooters.list(), []);
});

test('Saisontitel wird über die API gelesen, getrimmt und begrenzt', async () => {
  let result = await api('/api/season', { method: 'PUT', json: { title: '  Pokalschießen  ' } });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.title, 'Pokalschießen');

  result = await api('/api/season');
  assert.deepEqual(result.body, { title: 'Pokalschießen' });

  result = await api('/api/season', { method: 'PUT', json: { title: 'x'.repeat(201) } });
  assert.equal(result.response.status, 400);
  assert.equal(Season.getTitle(), 'Pokalschießen');
});

test('JSON-Export enthält die vollständige Saison und einen sicheren Downloadnamen', async () => {
  Season.setTitle('Königsschießen 2026');
  const shooter = Shooters.create({ name: 'Eva Beispiel', gender: 'w' });
  const discipline = Disciplines.create({ name: 'Luftpistole' });
  Results.create({ shooter_id: shooter.id, discipline_id: discipline.id, round_number: 1, points: 96.5 });

  const { response, body } = await api('/api/export');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''K%C3%B6nigsschie%C3%9Fen-2026\.json/);
  assert.equal(body.event_title, 'Königsschießen 2026');
  assert.equal(body.shooters.length, 1);
  assert.equal(body.disciplines.length, 1);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].points, 96.5);
  assert.ok(Number.isFinite(Date.parse(body.exported_at)));
});

test('Saisonarchiv-Validierung weist beschädigte JSON-Daten zurück', async (t) => {
  const cases = [
    ['fehlende Tabellen', { event_title: 'Kaputt' }, /fehlen/],
    ['doppelte Schützen-ID', archiveFixture({
      shooters: [
        ...archiveFixture().shooters,
        { id: 7, name: 'Doppelt', gender: 'm', created_at: '2026-08-30 11:00:00' },
      ],
    }), /mehrfach/],
    ['ungültiges Geschlecht', archiveFixture({
      shooters: [{ id: 7, name: 'Anna', gender: 'x', created_at: '2026-08-30 10:00:00' }],
    }), /Geschlecht/],
    ['unbekannter Schütze im Ergebnis', archiveFixture({
      results: [{ ...archiveFixture().results[0], shooter_id: 999 }],
    }), /unbekannten Schützen/],
    ['ungültiger Durchgang', archiveFixture({
      results: [{ ...archiveFixture().results[0], round_number: 0 }],
    }), /Durchgang/],
    ['ungültige Punkte', archiveFixture({
      results: [{ ...archiveFixture().results[0], points: '98' }],
    }), /Punkte/],
  ];

  for (const [name, archive, expected] of cases) {
    await t.test(name, () => {
      assert.throws(() => validateSeasonArchive(archive), expected);
    });
  }
});

test('JSON-Archivimport stellt Daten wieder her und sichert die vorherige Saison', () => {
  Season.setTitle('Alte Saison');
  Shooters.create({ name: 'Alter Schütze', gender: 'm' });

  const result = restoreSeasonArchive(archiveFixture());
  assert.equal(result.event_title, 'Vereinsschießen 2026');
  assert.deepEqual(result.restored, { shooters: 1, disciplines: 1, results: 1 });
  assert.ok(result.backup);
  assert.ok(fs.existsSync(path.join(ARCHIVE_DIR, result.backup)));

  const restored = fullExport();
  assert.equal(restored.event_title, 'Vereinsschießen 2026');
  assert.deepEqual(restored.shooters.map(({ id, name, gender }) => ({ id, name, gender })), [
    { id: 7, name: 'Anna Adler', gender: 'w' },
  ]);
  assert.equal(restored.disciplines[0].id, 4);
  assert.equal(restored.results[0].id, 11);
  assert.equal(restored.results[0].points, 98.5);
});

test('Gültiger JSON-Archivimport funktioniert über den HTTP-Endpunkt', async () => {
  const { response, body } = await api('/api/import/archive', {
    method: 'POST',
    json: { archive: archiveFixture() },
  });
  assert.equal(response.status, 200);
  assert.equal(body.backup, null);
  assert.deepEqual(body.restored, { shooters: 1, disciplines: 1, results: 1 });
  assert.equal(Season.getTitle(), 'Vereinsschießen 2026');
  assert.equal(Results.findById(11).points, 98.5);
});

test('Ungültiger JSON-Archivimport verändert die aktuelle Saison nicht', async () => {
  Season.setTitle('Bleibt erhalten');
  Shooters.create({ name: 'Bestand', gender: 'm' });
  const beforeImport = fullExport();
  const invalidArchive = archiveFixture({
    results: [{ ...archiveFixture().results[0], discipline_id: 999 }],
  });

  const { response, body } = await api('/api/import/archive', {
    method: 'POST',
    json: { archive: invalidArchive },
  });
  assert.equal(response.status, 400);
  assert.match(body.error, /unbekannte Disziplin/);

  const afterImport = fullExport();
  assert.equal(afterImport.event_title, beforeImport.event_title);
  assert.deepEqual(afterImport.shooters, beforeImport.shooters);
  assert.deepEqual(afterImport.disciplines, beforeImport.disciplines);
  assert.deepEqual(afterImport.results, beforeImport.results);
  assert.deepEqual(fs.readdirSync(ARCHIVE_DIR), []);
});

test('Saison-Reset archiviert den vollständigen Stand und leert die Arbeitsdaten', async () => {
  Season.setTitle('Saison zum Archivieren');
  const shooter = Shooters.create({ name: 'Archiv Schütze', gender: 'm' });
  const discipline = Disciplines.create({ name: 'Archiv Disziplin' });
  Results.create({ shooter_id: shooter.id, discipline_id: discipline.id, round_number: 1, points: 88 });

  const { response, body } = await api('/api/season/reset', { method: 'POST', json: {} });
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);

  const current = fullExport();
  assert.equal(current.event_title, '');
  assert.deepEqual(current.shooters, []);
  assert.deepEqual(current.disciplines, []);
  assert.deepEqual(current.results, []);

  const archived = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, body.archive), 'utf8'));
  assert.equal(archived.event_title, 'Saison zum Archivieren');
  assert.equal(archived.shooters[0].name, 'Archiv Schütze');
  assert.equal(archived.results[0].points, 88);

  const list = await api('/api/season/archives');
  assert.deepEqual(list.body, [body.archive]);
  const download = await api(`/api/season/archives/${encodeURIComponent(body.archive)}`);
  assert.equal(download.response.status, 200);
  assert.equal(download.body.event_title, 'Saison zum Archivieren');
});
