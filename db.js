'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, 'data');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const DB_PATH = path.join(DATA_DIR, 'wettkampf.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS shooters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    gender TEXT NOT NULL CHECK (gender IN ('m', 'w')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS disciplines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shooter_id INTEGER NOT NULL REFERENCES shooters(id) ON DELETE CASCADE,
    discipline_id INTEGER NOT NULL REFERENCES disciplines(id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL,
    points REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_results_shooter_discipline
    ON results(shooter_id, discipline_id);
`);

// ---------- Helpers ----------

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.get(...params);
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.run(...params);
}

// ---------- Shooters ----------

const Shooters = {
  list() {
    return all('SELECT * FROM shooters ORDER BY name COLLATE NOCASE');
  },
  create({ name, gender }) {
    const res = run('INSERT INTO shooters (name, gender) VALUES (?, ?)', [name, gender]);
    return get('SELECT * FROM shooters WHERE id = ?', [res.lastInsertRowid]);
  },
  update(id, { name, gender }) {
    run('UPDATE shooters SET name = ?, gender = ? WHERE id = ?', [name, gender, id]);
    return get('SELECT * FROM shooters WHERE id = ?', [id]);
  },
  remove(id) {
    run('DELETE FROM shooters WHERE id = ?', [id]);
  },
  findByName(name) {
    return get('SELECT * FROM shooters WHERE name = ? COLLATE NOCASE', [name]);
  },
};

// ---------- Disciplines ----------

const Disciplines = {
  list() {
    return all('SELECT * FROM disciplines ORDER BY sort_order, name COLLATE NOCASE');
  },
  create({ name }) {
    const maxOrder = get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM disciplines').m;
    const res = run('INSERT INTO disciplines (name, sort_order) VALUES (?, ?)', [name, maxOrder + 1]);
    return get('SELECT * FROM disciplines WHERE id = ?', [res.lastInsertRowid]);
  },
  update(id, { name }) {
    run('UPDATE disciplines SET name = ? WHERE id = ?', [name, id]);
    return get('SELECT * FROM disciplines WHERE id = ?', [id]);
  },
  remove(id) {
    run('DELETE FROM disciplines WHERE id = ?', [id]);
  },
  findByName(name) {
    return get('SELECT * FROM disciplines WHERE name = ? COLLATE NOCASE', [name]);
  },
};

// ---------- Results ----------

const Results = {
  listForShooterDiscipline(shooterId, disciplineId) {
    return all(
      'SELECT * FROM results WHERE shooter_id = ? AND discipline_id = ? ORDER BY round_number',
      [shooterId, disciplineId]
    );
  },
  create({ shooter_id, discipline_id, round_number, points }) {
    const res = run(
      'INSERT INTO results (shooter_id, discipline_id, round_number, points) VALUES (?, ?, ?, ?)',
      [shooter_id, discipline_id, round_number, points]
    );
    return get('SELECT * FROM results WHERE id = ?', [res.lastInsertRowid]);
  },
  update(id, { points, round_number }) {
    run('UPDATE results SET points = ?, round_number = ? WHERE id = ?', [points, round_number, id]);
    return get('SELECT * FROM results WHERE id = ?', [id]);
  },
  remove(id) {
    run('DELETE FROM results WHERE id = ?', [id]);
  },
  nextRoundNumber(shooterId, disciplineId) {
    const row = get(
      'SELECT COALESCE(MAX(round_number), 0) AS m FROM results WHERE shooter_id = ? AND discipline_id = ?',
      [shooterId, disciplineId]
    );
    return row.m + 1;
  },
};

// ---------- Rankings ----------

/**
 * Rangliste fuer eine Disziplin.
 * Wertung: bester Durchgang zaehlt. Bei Gleichstand entscheidet der
 * naechstbeste Durchgang (rekursiver Tie-Break ueber alle Durchgaenge).
 */
function rankingForDiscipline(disciplineId) {
  const rows = all(
    `SELECT s.id AS shooter_id, s.name, s.gender, r.points
     FROM shooters s
     JOIN results r ON r.shooter_id = s.id
     WHERE r.discipline_id = ?`,
    [disciplineId]
  );

  const byShooter = new Map();
  for (const row of rows) {
    if (!byShooter.has(row.shooter_id)) {
      byShooter.set(row.shooter_id, {
        shooter_id: row.shooter_id,
        name: row.name,
        gender: row.gender,
        allPoints: [],
      });
    }
    byShooter.get(row.shooter_id).allPoints.push(row.points);
  }

  const entries = [...byShooter.values()].map((e) => {
    const sorted = [...e.allPoints].sort((a, b) => b - a); // absteigend
    return {
      shooter_id: e.shooter_id,
      name: e.name,
      gender: e.gender,
      best_points: sorted[0],
      rounds_sorted: sorted,
      num_rounds: sorted.length,
    };
  });

  entries.sort((a, b) => {
    const len = Math.max(a.rounds_sorted.length, b.rounds_sorted.length);
    for (let i = 0; i < len; i++) {
      const av = a.rounds_sorted[i];
      const bv = b.rounds_sorted[i];
      if (av === undefined && bv === undefined) return 0;
      if (av === undefined) return 1; // weniger Durchgaenge -> nach hinten bei Gleichstand
      if (bv === undefined) return -1;
      if (av !== bv) return bv - av; // absteigend
    }
    return a.name.localeCompare(b.name);
  });

  return entries.map((e, idx) => ({
    rank: idx + 1,
    shooter_id: e.shooter_id,
    name: e.name,
    gender: e.gender,
    best_points: e.best_points,
    all_rounds: e.rounds_sorted,
  }));
}

// ---------- Season export / reset ----------

function fullExport() {
  return {
    exported_at: new Date().toISOString(),
    shooters: all('SELECT * FROM shooters'),
    disciplines: all('SELECT * FROM disciplines'),
    results: all('SELECT * FROM results'),
  };
}

function archiveCurrentSeason(label) {
  const data = fullExport();
  const safeLabel = (label || `saison-${Date.now()}`).replace(/[^a-zA-Z0-9_\-]/g, '_');
  const filePath = path.join(ARCHIVE_DIR, `${safeLabel}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

function resetSeason() {
  run('DELETE FROM results');
  run('DELETE FROM disciplines');
  run('DELETE FROM shooters');
  run("DELETE FROM sqlite_sequence WHERE name IN ('results','disciplines','shooters')");
}

function listArchives() {
  return fs
    .readdirSync(ARCHIVE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();
}

module.exports = {
  db,
  Shooters,
  Disciplines,
  Results,
  rankingForDiscipline,
  fullExport,
  archiveCurrentSeason,
  resetSeason,
  listArchives,
  ARCHIVE_DIR,
};
