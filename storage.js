'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const DATA_DIR = path.resolve(process.env.SCHUETZEN_DATA_DIR || path.join(__dirname, 'data'));
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
for (const dir of [DATA_DIR, ARCHIVE_DIR, BACKUP_DIR]) fs.mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'wettkampf.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF; PRAGMA secure_delete = ON');
const all = (sql, args = []) => db.prepare(sql).all(...args);
const get = (sql, args = []) => db.prepare(sql).get(...args);
const run = (sql, args = []) => db.prepare(sql).run(...args);
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function atomicWrite(target, content) {
  const temporary = target + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, content, { flag: 'wx', flush: true, mode: 0o600 });
  fs.renameSync(temporary, target);
}
function checkDatabase(connection) {
  if (connection.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      connection.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Datenbankprüfung fehlgeschlagen');
}
function snapshot(label) {
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}-${randomUUID()}.sqlite`;
  const target = path.join(BACKUP_DIR, name);
  const temporary = target + '.tmp';
  // VACUUM INTO makes a consistent SQLite snapshot and omits deleted free pages.
  run('VACUUM INTO ?', [temporary]);
  const check = new DatabaseSync(temporary, { readOnly: true });
  try { checkDatabase(check); } finally { check.close(); }
  const fd = fs.openSync(temporary, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
  const sha256 = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  atomicWrite(target + '.json', JSON.stringify({ name, sha256, created_at: new Date().toISOString(), schema_version: get('PRAGMA user_version').user_version }));
  return name;
}

const CURRENT_SCHEMA_VERSION = 3;
const SCHEMA = `
CREATE TABLE shooters (
 id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 gender TEXT NOT NULL CHECK(gender IN ('m','w')), archived_at TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '',
 year INTEGER CHECK(year BETWEEN 1900 AND 2200), status TEXT NOT NULL CHECK(status IN ('active','closed','correction')),
 revision INTEGER NOT NULL DEFAULT 0, ranking_version TEXT NOT NULL DEFAULT 'series-name-v1',
 reconstructed INTEGER NOT NULL DEFAULT 0, correction_reason TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT
);
CREATE UNIQUE INDEX one_active_event ON events(status) WHERE status='active';
CREATE TABLE participants (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES events(id),
 shooter_id INTEGER NOT NULL REFERENCES shooters(id), start_number INTEGER CHECK(start_number > 0),
 name TEXT NOT NULL, gender TEXT NOT NULL CHECK(gender IN ('m','w')),
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(event_id,shooter_id), UNIQUE(event_id,start_number), UNIQUE(id,event_id)
);
CREATE TABLE disciplines (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES events(id),
 name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(event_id,name COLLATE NOCASE), UNIQUE(id,event_id)
);
CREATE TABLE results (
 id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL,
 participant_id INTEGER NOT NULL, discipline_id INTEGER NOT NULL,
 round_number INTEGER NOT NULL CHECK(round_number > 0), points REAL NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 FOREIGN KEY(participant_id,event_id) REFERENCES participants(id,event_id) ON DELETE CASCADE,
 FOREIGN KEY(discipline_id,event_id) REFERENCES disciplines(id,event_id) ON DELETE CASCADE
);
CREATE INDEX results_participant_discipline ON results(participant_id,discipline_id);
CREATE TABLE placements (
 event_id INTEGER NOT NULL REFERENCES events(id), revision INTEGER NOT NULL,
 participant_id INTEGER NOT NULL, discipline_id INTEGER NOT NULL,
 rank INTEGER NOT NULL CHECK(rank > 0), best_points REAL NOT NULL, rounds TEXT NOT NULL,
 FOREIGN KEY(participant_id,event_id) REFERENCES participants(id,event_id),
 FOREIGN KEY(discipline_id,event_id) REFERENCES disciplines(id,event_id),
 PRIMARY KEY(event_id,revision,participant_id,discipline_id)
);
CREATE TABLE closures (
 event_id INTEGER NOT NULL REFERENCES events(id), revision INTEGER NOT NULL,
 reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY(event_id,revision)
);
CREATE TABLE contacts (
 shooter_id INTEGER PRIMARY KEY REFERENCES shooters(id), email TEXT NOT NULL,
 consent_at TEXT NOT NULL, consent_text TEXT NOT NULL, evidence TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('granted','review')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE consent_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, shooter_id INTEGER NOT NULL REFERENCES shooters(id),
 action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE imports (fingerprint TEXT PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id));
CREATE TABLE person_aliases (uuid TEXT PRIMARY KEY, shooter_id INTEGER NOT NULL REFERENCES shooters(id));
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version = 3;
`;

const version = get('PRAGMA user_version').user_version;
if (version > CURRENT_SCHEMA_VERSION) throw new Error('Diese Datenbank benötigt eine neuere App-Version.');
if (version < 2) {
  const legacy = !!get("SELECT name FROM sqlite_master WHERE type='table' AND name='shooters'");
  if (legacy) snapshot('vor-migration');
  transaction(() => {
    const shooters = legacy ? all('SELECT * FROM shooters') : [];
    const disciplines = legacy ? all('SELECT * FROM disciplines') : [];
    const results = legacy ? all('SELECT * FROM results') : [];
    const title = legacy ? get("SELECT value FROM settings WHERE key='event_title'")?.value || '' : '';
    if (legacy) db.exec('DROP TABLE results; DROP TABLE disciplines; DROP TABLE shooters; DROP TABLE settings;');
    db.exec(SCHEMA);
    const eventId = Number(run("INSERT INTO events(uuid,title,status) VALUES (?,?,'active')", [randomUUID(), title]).lastInsertRowid);
    const used = new Set(shooters.map(s => s.start_number).filter(Boolean));
    let next = 1;
    for (const s of shooters) {
      while (used.has(next)) next++;
      const number = s.start_number || next++;
      run('INSERT INTO shooters(id,uuid,name,gender,created_at) VALUES (?,?,?,?,?)', [s.id, randomUUID(), s.name, s.gender, s.created_at]);
      run('INSERT INTO participants(id,event_id,shooter_id,start_number,name,gender,created_at) VALUES (?,?,?,?,?,?,?)', [s.id,eventId,s.id,number,s.name,s.gender,s.created_at]);
    }
    for (const d of disciplines) run('INSERT INTO disciplines(id,event_id,name,sort_order,created_at) VALUES (?,?,?,?,?)', [d.id,eventId,d.name,d.sort_order,d.created_at]);
    for (const r of results) run('INSERT INTO results(id,event_id,participant_id,discipline_id,round_number,points,created_at) VALUES (?,?,?,?,?,?,?)', [r.id,eventId,r.shooter_id,r.discipline_id,r.round_number,r.points,r.created_at]);
    checkDatabase(db);
  });
}
if (version === 2) {
  snapshot('vor-migration-v3');
  transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS person_aliases (
        uuid TEXT PRIMARY KEY,
        shooter_id INTEGER NOT NULL REFERENCES shooters(id)
      );
      CREATE TABLE placements_v3 (
        event_id INTEGER NOT NULL REFERENCES events(id), revision INTEGER NOT NULL,
        participant_id INTEGER NOT NULL, discipline_id INTEGER NOT NULL,
        rank INTEGER NOT NULL CHECK(rank > 0), best_points REAL NOT NULL, rounds TEXT NOT NULL,
        FOREIGN KEY(participant_id,event_id) REFERENCES participants(id,event_id),
        FOREIGN KEY(discipline_id,event_id) REFERENCES disciplines(id,event_id),
        PRIMARY KEY(event_id,revision,participant_id,discipline_id)
      );
      INSERT INTO placements_v3 SELECT * FROM placements;
      DROP TABLE placements;
      ALTER TABLE placements_v3 RENAME TO placements;
      PRAGMA user_version = 3;
    `);
    checkDatabase(db);
  });
}

const setting = key => get('SELECT value FROM settings WHERE key=?', [key])?.value;
const setSetting = (key,value) => run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key,String(value)]);
module.exports = { db, all, get, run, transaction, atomicWrite, checkDatabase, snapshot, setting, setSetting, DATA_DIR, ARCHIVE_DIR, BACKUP_DIR, CURRENT_SCHEMA_VERSION };
