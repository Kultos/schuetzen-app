'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const { after, before, beforeEach, test } = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schuetzen-app-test-'));
process.env.SCHUETZEN_DATA_DIR = testDataDir;
delete process.env.SCHUETZEN_BACKUP_DIR;

const {
  db,
  Events,
  People,
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
let cookie='';

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
  requestOptions.headers={'X-Schuetzen-Request':'1','X-Event-Id':String(Events.active().id),Cookie:cookie,...requestOptions.headers};
  if (Object.hasOwn(requestOptions, 'json')) {
    requestOptions.body = JSON.stringify(requestOptions.json);
    requestOptions.headers = { 'Content-Type': 'application/json', ...requestOptions.headers };
    delete requestOptions.json;
  }
  const response = await fetch(baseUrl + pathname, requestOptions);
  if(response.headers.get('set-cookie')) cookie=response.headers.get('set-cookie').split(';')[0];
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
  await api('/api/auth/setup',{method:'POST',json:{password:'test-password-12345'}});
});

beforeEach(async () => {
  db.exec("DELETE FROM person_aliases; DELETE FROM consent_log; DELETE FROM contacts; DELETE FROM imports; DELETE FROM placements; DELETE FROM closures; DELETE FROM results; DELETE FROM disciplines; DELETE FROM participants; DELETE FROM events; DELETE FROM shooters;");
  db.prepare("INSERT INTO events(uuid,title,year,status) VALUES (?,'',2026,'active')").run(randomUUID());
  db.prepare("DELETE FROM settings WHERE key='privacy_review'").run();
  await api('/api/auth/login',{method:'POST',json:{password:'test-password-12345'}});
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

  await api('/api/season/reset', { method: 'POST', json: {title:'Neu',year:2027,previous_event_id:Events.active().id} });
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
  assert.equal(result.body.title, 'Pokalschießen');

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

test('JSON-Archivimport ergänzt die Historie und erhält das aktive Event', () => {
  Season.setTitle('Aktive Saison');
  const current=Events.active().id;
  const shooter=Shooters.create({name:'Aktueller Schütze',gender:'m'});
  const archive=archiveFixture();
  const preview=require('../archives').preview(archive);
  const result=restoreSeasonArchive(archive,{year:2025,fingerprint:preview.fingerprint,mapping:{7:null}});
  assert.equal(Events.active().id,current);
  assert.equal(Season.getTitle(),'Aktive Saison');
  assert.equal(Shooters.list()[0].id,shooter.id);
  const imported=fullExport(result.event_id);
  assert.equal(imported.event_title,'Vereinsschießen 2026');
  assert.equal(imported.results[0].points,98.5);
  assert.equal(imported.event.reconstructed,1);
  assert.equal(imported.placements[0].rank,1);
  assert.ok(result.backup);
});

test('Versionierte Eventarchive müssen eine vollständige und regelkonforme Abschlusswertung enthalten',()=>{
  Season.setTitle('Archiv');Events.metadata(Events.active().id,{title:'Archiv',year:2026});
  const first=Shooters.create({name:'Anna',gender:'w'}),second=Shooters.create({name:'Berta',gender:'w'}),d=Disciplines.create({name:'Gewehr'});
  Results.create({shooter_id:first.id,discipline_id:d.id,round_number:1,points:100});
  Results.create({shooter_id:second.id,discipline_id:d.id,round_number:1,points:90});
  const old=Events.active().id;Events.start({title:'Neu',year:2027,previous_event_id:old});
  const archive=fullExport(old);
  archive.placements.find(p=>p.shooter_id===first.id).rank=2;
  archive.placements.find(p=>p.shooter_id===second.id).rank=1;
  assert.throws(()=>validateSeasonArchive(archive),/Wertungsregel/);
  const invalidMetadata=fullExport(old);
  invalidMetadata.event.revision='1';
  assert.throws(()=>validateSeasonArchive(invalidMetadata),/Eventrevision/);
  const incompleteHistory=fullExport(old);
  incompleteHistory.placement_history.pop();
  assert.throws(()=>validateSeasonArchive(incompleteHistory),/Historische Abschlusswertung|Versionshistorie/);
});

test('Gültiger JSON-Archivimport funktioniert über Vorschau und explizite Zuordnung', async () => {
  const archive=archiveFixture();
  const preview=await api('/api/import/preview',{method:'POST',json:{archive}});
  const result=await api('/api/import/archive',{method:'POST',json:{archive,year:2025,fingerprint:preview.body.fingerprint,mapping:{7:null}}});
  assert.equal(result.response.status,200);
  assert.deepEqual(result.body.restored,{shooters:1,disciplines:1,results:1});
  assert.equal(Season.getTitle(),'');
  assert.equal(fullExport(result.body.event_id).results[0].points,98.5);
  const duplicate=await api('/api/import/preview',{method:'POST',json:{archive}});
  assert.equal(duplicate.response.status,409);
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

  const previous=Events.active().id;
  const { response, body } = await api('/api/season/reset', { method: 'POST', json: {title:'Nächstes Event',year:2027,previous_event_id:previous} });
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);

  const current = fullExport();
  assert.equal(current.event_title, 'Nächstes Event');
  assert.deepEqual(current.shooters, []);
  assert.deepEqual(current.disciplines, []);
  assert.deepEqual(current.results, []);
  assert.equal(People.get(shooter.id).name,'Archiv Schütze');
  assert.equal(People.history(shooter.id)[0].placements[0].rank,1);

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

test('Wiederanmeldung erhält Identität und historische Namen, Startnummern und Abschlussplätze', () => {
  const s=Shooters.create({name:'Anna Alt',gender:'w',start_number:42});
  const d=Disciplines.create({name:'Gewehr'});
  Results.create({shooter_id:s.id,discipline_id:d.id,round_number:1,points:95});
  const previous=Events.active().id;
  Events.start({title:'2027',year:2027,previous_event_id:previous});
  People.update(s.id,{name:'Anna Neu',gender:'w'});
  const next=Shooters.register(s.id,1);
  assert.equal(next.uuid,s.uuid);
  assert.equal(next.start_number,1);
  assert.throws(()=>Shooters.register(s.id,2),/bereits/);
  assert.equal(fullExport(previous).shooters[0].name,'Anna Alt');
  assert.equal(fullExport(previous).shooters[0].start_number,42);
  const history=People.history(s.id).find(h=>h.id===previous);
  assert.equal(history.historical_name,'Anna Alt');assert.equal(history.placements[0].rank,1);
  assert.throws(()=>Results.create({shooter_id:s.id,discipline_id:d.id,round_number:1,points:99}),/aktiven Event/);
  assert.throws(()=>Events.start({title:'Doppelt',year:2028,previous_event_id:previous}),/geändert/);
});

test('Abschlusskorrektur erfordert Begründung und erzeugt eine neue Wertungsversion', () => {
  const s=Shooters.create({name:'Korrektur',gender:'m'}),d=Disciplines.create({name:'Gewehr'});
  const r=Results.create({shooter_id:s.id,discipline_id:d.id,round_number:1,points:80});
  const previous=Events.active().id;
  Events.start({title:'Neu',year:2027,previous_event_id:previous});
  assert.throws(()=>Results.correct(previous,r.id,99),/Korrekturmodus/);
  assert.throws(()=>Events.beginCorrection(previous,''),/Begründung|begründung/);
  Events.beginCorrection(previous,'Übertragungsfehler auf dem Wertungsbogen');
  Results.correct(previous,r.id,99);
  Events.finishCorrection(previous);
  assert.equal(Events.get(previous).revision,2);
  assert.equal(rankingForDiscipline(d.id)[0].best_points,99);
  assert.equal(db.prepare('SELECT best_points FROM placements WHERE event_id=? AND revision=1').get(previous).best_points,80);

  const archive=fullExport(previous);
  assert.equal(archive.version,3);
  assert.deepEqual([...new Set(archive.placement_history.map(p=>p.revision))],[1,2]);
  assert.deepEqual(archive.closures.map(c=>c.revision),[1,2]);
  archive.event.uuid='99999999-9999-4999-8999-999999999999';
  const preview=require('../archives').preview(archive);
  const mapping=Object.fromEntries(archive.shooters.map(person=>[person.id,person.id]));
  const imported=restoreSeasonArchive(archive,{year:2026,fingerprint:preview.fingerprint,mapping});
  assert.equal(Events.get(imported.event_id).revision,2);
  assert.deepEqual(db.prepare('SELECT DISTINCT revision FROM placements WHERE event_id=? ORDER BY revision').all(imported.event_id).map(r=>r.revision),[1,2]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM closures WHERE event_id=?').get(imported.event_id).n,2);

  const oldV2=structuredClone(archive);oldV2.version=2;oldV2.event.uuid='88888888-8888-4888-8888-888888888888';delete oldV2.placement_history;delete oldV2.closures;
  const oldPreview=require('../archives').preview(oldV2);
  const reconstructed=restoreSeasonArchive(oldV2,{year:2026,fingerprint:oldPreview.fingerprint,mapping});
  assert.equal(Events.get(reconstructed.event_id).revision,1);
  assert.equal(Events.get(reconstructed.event_id).reconstructed,1);
});

test('Nicht angemeldete Personen dürfen keine Ergebnisse erhalten; Entfernen betrifft nur aktuelle Teilnahme', () => {
  const p=People.create({name:'Stamm',gender:'w'}),d=Disciplines.create({name:'Test'});
  assert.throws(()=>Results.create({shooter_id:p.id,discipline_id:d.id,round_number:1,points:90}),/Teilnehmer/);
  Shooters.register(p.id,5);Shooters.remove(p.id);
  assert.equal(People.get(p.id).name,'Stamm');
  assert.equal(Shooters.findById(p.id),undefined);
});

const consentData={email:'anna@example.org',consent:true,consent_text:'Ich willige in Einladungen des Testvereins per E-Mail ein. Widerruf ist jederzeit möglich.',evidence:'Unterschriebener Testbogen 42'};
test('Kontakte benötigen dokumentierte Einwilligung und erscheinen ausschließlich in geschützten Kontakt-APIs', async () => {
  const s=Shooters.create({name:'Anna',gender:'w'});
  let r=await api('/api/people/'+s.id+'/contact',{method:'PUT',json:{...consentData,consent:false}});
  assert.equal(r.response.status,400);
  r=await api('/api/people/'+s.id+'/contact',{method:'PUT',json:consentData});
  assert.equal(r.response.status,200);
  assert.equal((await api('/api/invitations')).body[0].email,consentData.email);
  for(const endpoint of ['/api/shooters','/api/dashboard','/api/export','/api/people','/api/people/'+s.id+'/history']) {
    const output=JSON.stringify((await api(endpoint)).body);
    assert.ok(!output.includes(consentData.email),endpoint+' darf keine E-Mail enthalten');
    assert.ok(!output.includes(consentData.evidence),endpoint+' darf keinen Nachweis enthalten');
  }
  const beforePurge=require('../backups').bundle(require('../backups').create('vor-nachweisloeschung'));
  assert.equal((await api('/api/people/'+s.id+'/consent-log',{method:'DELETE',json:{confirm:true}})).response.status,400);
  await api('/api/people/'+s.id+'/contact',{method:'DELETE'});
  assert.deepEqual((await api('/api/invitations')).body,[]);
  assert.equal((await api('/api/people/'+s.id+'/contact')).body.contact,null);
  assert.ok((await api('/api/people/'+s.id+'/contact')).body.log.length>=2);
  await api('/api/people/'+s.id+'/consent-log',{method:'DELETE',json:{confirm:true}});
  assert.deepEqual((await api('/api/people/'+s.id+'/contact')).body.log,[]);
  require('../backups').restore(beforePurge);
  assert.equal((await api('/api/people/'+s.id+'/contact')).body.contact,null);
  assert.deepEqual((await api('/api/people/'+s.id+'/contact')).body.log,[],'gelöschte Nachweise dürfen durch Restore nicht zurückkehren');
});

test('Einladungsexport validiert Eventfilter und begrenzt Empfänger auf das gewählte Event', async()=>{
  const first=Shooters.create({name:'Nur Alt',gender:'w'}),C=require('../privacy').Contacts;
  C.save(first.id,consentData);
  const old=Events.active().id;Events.start({title:'Neu',year:2027,previous_event_id:old});
  const second=Shooters.create({name:'Nur Neu',gender:'m'});C.save(second.id,{...consentData,email:'neu@example.org'});
  assert.equal((await api('/api/invitations?event_id=abc')).response.status,400);
  assert.deepEqual((await api('/api/invitations?event_id='+old)).body.map(r=>r.name),['Nur Alt']);
  assert.deepEqual((await api('/api/invitations?event_id='+Events.active().id)).body.map(r=>r.name),['Nur Neu']);
});

test('Anmeldung, CSRF-Schutz und veralteter Eventkontext werden serverseitig geprüft', async () => {
  const anonymous=await fetch(baseUrl+'/api/people');assert.equal(anonymous.status,401);
  const dashboard=await fetch(baseUrl+'/api/dashboard');assert.equal(dashboard.status,200);
  const csrf=await fetch(baseUrl+'/api/shooters',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({name:'CSRF',gender:'m'})});
  assert.equal(csrf.status,403);
  const wrongOrigin=await api('/api/shooters',{method:'POST',headers:{Origin:'https://example.org'},json:{name:'CSRF',gender:'m'}});
  assert.equal(wrongOrigin.response.status,403);
  const stale=await api('/api/shooters',{method:'POST',headers:{'X-Event-Id':'99999'},json:{name:'Alt',gender:'m'}});
  assert.equal(stale.response.status,409);
  const Auth=require('../auth');
  assert.equal(Auth.protectedTransport({socket:{remoteAddress:'192.168.1.5'}}),false);
  assert.equal(Auth.protectedTransport({socket:{remoteAddress:'192.168.1.5',encrypted:true}}),true);
  let secureCookie='';const secureRequest={socket:{remoteAddress:'192.0.2.10',encrypted:true},headers:{}};
  Auth.login(secureRequest,{setHeader:(name,value)=>{if(name==='Set-Cookie')secureCookie=value;}},'test-password-12345');assert.match(secureCookie,/; Secure$/);
  const blockedRequest={socket:{remoteAddress:'192.0.2.11',encrypted:true},headers:{}};
  for(let i=0;i<5;i++)assert.throws(()=>Auth.login(blockedRequest,{setHeader(){}},'falsch'),/Anmeldung fehlgeschlagen/);
  assert.throws(()=>Auth.login(blockedRequest,{setHeader(){}},'test-password-12345'),/Zu viele Versuche/);
  const page=await fetch(baseUrl+'/');assert.match(page.headers.get('content-security-policy'),/default-src 'self'/);
  const appSource=await (await fetch(baseUrl+'/app.js')).text();assert.match(appSource,/script\.integrity = 'sha512-/);
  await api('/api/auth/logout',{method:'POST',json:{}});
  assert.equal((await fetch(baseUrl+'/api/people',{headers:{Cookie:cookie}})).status,401);
});

test('Ein während des Body-Uploads gewechseltes Event weist den alten Request zurück',async()=>{
  const old=Events.active(),payload=JSON.stringify({name:'Darf nicht landen',gender:'m'}),url=new URL(baseUrl+'/api/shooters');
  let request;
  const responsePromise=new Promise((resolve,reject)=>{
    request=http.request(url,{method:'POST',headers:{Cookie:cookie,'X-Schuetzen-Request':'1','X-Event-Id':String(old.id),'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},response=>{
      let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode,body}));
    });request.on('error',reject);request.write(payload.slice(0,1));
  });
  await new Promise(resolve=>setTimeout(resolve,40));
  Events.start({title:'Parallel neu',year:2027,previous_event_id:old.id});
  request.end(payload.slice(1));
  const response=await responsePromise;
  assert.equal(response.status,409,response.body);
  assert.equal(People.list('Darf nicht landen').length,0);
});

test('Fehlerhafte Tabellenimport-Zeilen hinterlassen keine persistenten Teilobjekte',async()=>{
  const result=await api('/api/import',{method:'POST',json:{rows:[{name:'Rollback Person',gender:'w',discipline:'Rollback Disziplin',round:0,points:90}]}});
  assert.equal(result.body.errors.length,1);
  assert.deepEqual(result.body.created,{shooters:0,disciplines:0,results:0});
  assert.equal(People.list('Rollback Person').length,0);
  assert.equal(Disciplines.findByName('Rollback Disziplin'),undefined);
  const blank=await api('/api/import',{method:'POST',json:{rows:[{name:'Leerwert',gender:'w',discipline:'Test',points:''}]}});
  assert.equal(blank.body.errors.length,1);assert.equal(People.list('Leerwert').length,0);
});

test('Vollrestore erhält spätere Widerrufe und sperrt andere Kontaktfreigaben bis zur erneuten Prüfung', async () => {
  const B=require('../backups'),C=require('../privacy').Contacts;
  const s=Shooters.create({name:'Widerruf',gender:'w'}),other=Shooters.create({name:'Weiterer Kontakt',gender:'m'}),remoteErase=Shooters.create({name:'Extern gelöscht',gender:'w'});
  C.save(s.id,consentData);C.save(other.id,{...consentData,email:'other@example.org'});C.save(remoteErase.id,{...consentData,email:'erase@example.org'});
  const backup=B.bundle(B.create('test'));
  assert.equal(backup.version,3);
  backup.privacy_journal.entries.push({uuid:remoteErase.uuid,action:'erase',at:new Date(Date.now()+1000).toISOString()});
  backup.manifest.privacy_sha256=createHash('sha256').update(JSON.stringify(backup.privacy_journal)).digest('hex');
  C.revoke(s.id);
  const result=B.restore(backup);assert.equal(result.privacy_review,true);
  assert.equal(C.get(s.id).contact,null);
  assert.equal(C.get(other.id).contact.status,'review');
  assert.equal(People.get(remoteErase.id).name,'Gelöschter Teilnehmer');
  assert.equal((await api('/api/dashboard')).response.status,503);
  assert.throws(()=>C.invitations(),/Datenschutzprüfung/);
  B.reviewed('Aktuelles Datenschutzprotokoll vollständig abgeglichen.');
  assert.deepEqual(C.invitations(),[]);
  C.save(other.id,{...consentData,email:'other@example.org'});
  assert.equal(C.invitations().length,1);
});

test('Beschädigte Backups verändern keine Daten; fehlgeschlagener Eventwechsel bleibt vollständig zurückgerollt', () => {
  const B=require('../backups'),person=Shooters.create({name:'Erhalten',gender:'m'});
  const bundle=B.bundle(B.create('test'));
  const before=JSON.stringify(People.list());
  const journalTampered=structuredClone(bundle);
  journalTampered.privacy_journal.entries.push({uuid:person.uuid,action:'erase',at:new Date().toISOString()});
  assert.throws(()=>B.inspect(journalTampered),/Datenschutzprotokoll-Prüfsumme/);
  const missingJournal=B.create('fehlendes-journal');fs.rmSync(path.join(require('../storage').BACKUP_DIR,missingJournal+'.privacy.json'));
  assert.throws(()=>B.bundle(missingJournal),/Datenschutzprotokoll.*fehlt/);
  bundle.manifest.sha256='00';assert.throws(()=>B.restore(bundle),/Prüfsumme/);
  assert.equal(JSON.stringify(People.list()),before);
  const event=Events.active();
  const close=Events.close;
  Events.close=function(id){close.call(this,id);throw new Error('Simulierter Schreibfehler');};
  try {assert.throws(()=>Events.start({title:'Scheitert',year:2027,previous_event_id:event.id}),/Schreibfehler/);}
  finally {Events.close=close;}
  assert.equal(Events.active().id,event.id);
  assert.equal(Events.get(event.id).revision,0);
  assert.equal(Events.list().length,1);
});

test('Fehler während der eigentlichen Restore-Transaktion rollen alle Tabellen zurück',()=>{
  const B=require('../backups'),person=Shooters.create({name:'Vor Restore',gender:'m'}),bundle=B.bundle(B.create('restore-rollback'));
  const originalFile=path.join(testDataDir,'restore-source.sqlite'),file=path.join(testDataDir,'weakened-restore.sqlite');fs.writeFileSync(originalFile,Buffer.from(bundle.database,'base64'));
  let source,target;
  try {
    source=new DatabaseSync(originalFile,{readOnly:true});target=new DatabaseSync(file);
    const names=source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
    const quote=value=>'"'+value.replaceAll('"','""')+'"';
    for(const name of names) {
      const columns=source.prepare('PRAGMA table_info('+quote(name)+')').all(),primary=columns.filter(column=>column.pk).sort((a,b)=>a.pk-b.pk);
      const definitions=columns.map(column=>quote(column.name)+' '+column.type+(column.notnull?' NOT NULL':''));
      if(primary.length)definitions.push('PRIMARY KEY ('+primary.map(column=>quote(column.name)).join(',')+')');
      target.exec('CREATE TABLE '+quote(name)+' ('+definitions.join(',')+')');
      const insert=target.prepare('INSERT INTO '+quote(name)+' ('+columns.map(column=>quote(column.name)).join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')');
      for(const row of source.prepare('SELECT * FROM '+quote(name)).all())insert.run(...columns.map(column=>row[column.name]));
    }
    target.prepare("UPDATE shooters SET gender='x'").run();target.exec('PRAGMA user_version=3');source.close();source=null;target.close();target=null;
    const bytes=fs.readFileSync(file);bundle.database=bytes.toString('base64');bundle.manifest.sha256=createHash('sha256').update(bytes).digest('hex');
    assert.throws(()=>B.restore(bundle));
    assert.equal(People.get(person.id).name,'Vor Restore');assert.equal(People.get(person.id).gender,'m');assert.equal(Events.list().length,1);
  } finally {if(source)source.close();if(target)target.close();for(const item of [originalFile,file])if(fs.existsSync(item))fs.rmSync(item);}
});

test('Löschungen werden auch nach Restore auf Namen und verwaltete Archive angewendet', () => {
  const B=require('../backups'),P=require('../privacy');
  const s=Shooters.create({name:'Zu löschen',gender:'m'});
  const archivePath=require('../archives').archiveCurrentSeason();
  const backup=B.bundle(B.create('test'));
  P.Contacts.erase(s.id);
  assert.equal(fs.existsSync(archivePath),false);
  B.restore(backup);
  assert.equal(People.get(s.id).name,'Gelöschter Teilnehmer');
  assert.equal(Shooters.list()[0].name,'Gelöschter Teilnehmer');
  assert.throws(()=>P.Contacts.save(s.id,consentData),/nicht verfügbar/);
});

test('Löschung erkennt UUID-lose Archive über frühere Namen und arbeitet bei defekten Archiven nicht teilweise',()=>{
  const P=require('../privacy'),s=Shooters.create({name:'Früherer Name',gender:'w'}),old=Events.active().id;
  Events.start({title:'Neu',year:2027,previous_event_id:old});People.update(s.id,{name:'Neuer Name',gender:'w'});
  const legacy=path.join(ARCHIVE_DIR,'legacy-name.json');
  fs.writeFileSync(legacy,JSON.stringify({shooters:[{name:'Früherer Name'}]}));
  P.Contacts.erase(s.id);assert.equal(fs.existsSync(legacy),false);

  const other=Shooters.create({name:'Alter aktiver Name',gender:'m'}),matching=path.join(ARCHIVE_DIR,'matching.json'),broken=path.join(ARCHIVE_DIR,'broken.json');
  fs.writeFileSync(matching,JSON.stringify({shooters:[{id:other.id,name:'Alter aktiver Name'}]}));People.update(other.id,{name:'Noch vorhanden',gender:'m'});fs.writeFileSync(broken,'{');
  assert.throws(()=>P.Contacts.erase(other.id),/Archivbereinigung fehlgeschlagen/);
  assert.equal(fs.existsSync(matching),true);assert.equal(People.get(other.id).name,'Noch vorhanden');
  fs.rmSync(broken);P.Contacts.erase(other.id);assert.equal(fs.existsSync(matching),false);
});

test('Datenschutzjournal erkennt eine fremde oder zurückgesetzte Datei',()=>{
  const P=require('../privacy'),original=fs.readFileSync(P.JOURNAL,'utf8'),parsed=JSON.parse(original);let valid=original;
  try {
    fs.writeFileSync(P.JOURNAL,JSON.stringify({...parsed,id:randomUUID()}));
    assert.throws(()=>P.journal(),/gehört nicht/);
    fs.writeFileSync(P.JOURNAL,original);
    const s=Shooters.create({name:'Journaltest',gender:'m'});P.Contacts.revoke(s.id);P.Contacts.revoke(s.id);
    const current=fs.readFileSync(P.JOURNAL,'utf8'),shortened=JSON.parse(current);valid=current;shortened.entries.pop();
    const revokes=JSON.parse(current).entries.filter(entry=>entry.uuid===s.uuid&&entry.action==='revoke');assert.equal(new Set(revokes.map(entry=>entry.at)).size,2);
    fs.writeFileSync(P.JOURNAL,JSON.stringify(shortened));
    assert.throws(()=>P.journal(),/zurückgesetzt/);
    fs.writeFileSync(P.JOURNAL,current);
    assert.doesNotThrow(()=>P.journal());
  } finally {fs.writeFileSync(P.JOURNAL,valid);}
});

test('Legacy-IDs und gleiche Namen werden nicht automatisch als dieselbe Person übernommen', () => {
  People.create({name:'Anna Adler',gender:'w'});
  const A=require('../archives'),archive=archiveFixture();
  const p=A.preview(archive);
  assert.equal(p.shooters[0].existing_id,null);
  assert.equal(p.shooters[0].candidates.length,1);
  assert.throws(()=>A.restoreSeasonArchive(archive,{year:2025,fingerprint:p.fingerprint}),/jeden Schützen/);
  A.restoreSeasonArchive(archive,{year:2025,fingerprint:p.fingerprint,mapping:{7:null}});
  assert.equal(People.list().length,2);
});
