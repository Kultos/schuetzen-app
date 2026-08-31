'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// Tests can redirect all persistent state to a temporary directory. In normal
// operation the environment variable is unset and the existing data directory
// continues to be used.
const DATA_DIR = process.env.SCHUETZEN_DATA_DIR
  ? path.resolve(process.env.SCHUETZEN_DATA_DIR)
  : path.join(__dirname, 'data');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const DB_PATH = path.join(DATA_DIR, 'wettkampf.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

// SQLite does not enable foreign-key actions by default. The application relies
// on ON DELETE CASCADE when a shooter or discipline is removed.
db.exec('PRAGMA foreign_keys = ON');

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

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Bestehende Installationen erhalten die Startnummern-Spalte automatisch.
// Die Vergabe in ID-Reihenfolge bildet für vorhandene Schützen eine stabile,
// saisonbezogene Nummerierung, ohne dass eine manuelle Migration nötig ist.
const shooterColumns = db.prepare('PRAGMA table_info(shooters)').all();
if (!shooterColumns.some((column) => column.name === 'start_number')) {
  db.exec('ALTER TABLE shooters ADD COLUMN start_number INTEGER');
}

const usedStartNumbers = new Set(
  db.prepare('SELECT start_number FROM shooters WHERE start_number IS NOT NULL').all()
    .map((row) => row.start_number)
);
let migrationStartNumber = 1;
const assignMigratedStartNumber = db.prepare('UPDATE shooters SET start_number = ? WHERE id = ?');
for (const shooter of db.prepare('SELECT id FROM shooters WHERE start_number IS NULL ORDER BY id').all()) {
  while (usedStartNumbers.has(migrationStartNumber)) migrationStartNumber++;
  assignMigratedStartNumber.run(migrationStartNumber, shooter.id);
  usedStartNumbers.add(migrationStartNumber);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_shooters_start_number ON shooters(start_number)');

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

// ---------- Settings ----------

const Season = {
  getTitle() {
    const row = get("SELECT value FROM settings WHERE key = 'event_title'");
    return row ? row.value : '';
  },
  setTitle(title) {
    const value = String(title || '').trim();
    run(
      `INSERT INTO settings (key, value) VALUES ('event_title', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [value]
    );
    return value;
  },
};

// ---------- Shooters ----------

const Shooters = {
  list() {
    return all('SELECT * FROM shooters ORDER BY name COLLATE NOCASE');
  },
  nextStartNumber() {
    const used = new Set(all('SELECT start_number FROM shooters').map((row) => row.start_number));
    let candidate = 1;
    while (used.has(candidate)) candidate++;
    return candidate;
  },
  create({ name, gender, start_number }) {
    const number = start_number === undefined ? this.nextStartNumber() : start_number;
    const res = run('INSERT INTO shooters (name, gender, start_number) VALUES (?, ?, ?)', [name, gender, number]);
    return get('SELECT * FROM shooters WHERE id = ?', [res.lastInsertRowid]);
  },
  update(id, { name, gender, start_number }, { swapOnConflict = false } = {}) {
    const current = this.findById(id);
    const number = start_number === undefined ? current.start_number : start_number;
    const conflict = this.findByStartNumber(number);

    if (conflict && conflict.id !== id) {
      if (!swapOnConflict) {
        const error = new Error(`Startnummer ${number} ist bereits an ${conflict.name} vergeben`);
        error.code = 'START_NUMBER_CONFLICT';
        error.conflictingShooter = conflict;
        throw error;
      }

      db.exec('BEGIN IMMEDIATE');
      try {
        run('UPDATE shooters SET start_number = NULL WHERE id = ?', [conflict.id]);
        run('UPDATE shooters SET name = ?, gender = ?, start_number = ? WHERE id = ?', [name, gender, number, id]);
        run('UPDATE shooters SET start_number = ? WHERE id = ?', [current.start_number, conflict.id]);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } else {
      run('UPDATE shooters SET name = ?, gender = ?, start_number = ? WHERE id = ?', [name, gender, number, id]);
    }
    return this.findById(id);
  },
  remove(id) {
    run('DELETE FROM shooters WHERE id = ?', [id]);
  },
  findByName(name) {
    return get('SELECT * FROM shooters WHERE name = ? COLLATE NOCASE', [name]);
  },
  findById(id) {
    return get('SELECT * FROM shooters WHERE id = ?', [id]);
  },
  findByStartNumber(startNumber) {
    return get('SELECT * FROM shooters WHERE start_number = ?', [startNumber]);
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
  findById(id) {
    return get('SELECT * FROM disciplines WHERE id = ?', [id]);
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
  findById(id) {
    return get('SELECT * FROM results WHERE id = ?', [id]);
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
    `SELECT s.id AS shooter_id, s.name, s.gender, s.start_number, r.points
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
        start_number: row.start_number,
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
      start_number: e.start_number,
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
    start_number: e.start_number,
    best_points: e.best_points,
    all_rounds: e.rounds_sorted,
  }));
}

/**
 * Kompakter Datenstand fuer die Live-Anzeige im Schuetzenhaus.
 * Die Ranglisten werden mit derselben Wertungslogik wie in der Verwaltung
 * berechnet, damit beide Ansichten jederzeit identische Plaetze zeigen.
 */
function dashboardSnapshot() {
  const disciplines = Disciplines.list().map((discipline) => ({
    id: discipline.id,
    name: discipline.name,
    ranking: rankingForDiscipline(discipline.id),
  }));

  const latestResults = all(
    `SELECT r.id, r.points, r.round_number, r.created_at,
            s.name AS shooter_name, s.start_number, d.id AS discipline_id, d.name AS discipline_name
     FROM results r
     JOIN shooters s ON s.id = r.shooter_id
     JOIN disciplines d ON d.id = r.discipline_id
     ORDER BY r.id DESC
     LIMIT 10`
  );

  return {
    event_title: Season.getTitle(),
    updated_at: new Date().toISOString(),
    stats: {
      shooters: get('SELECT COUNT(*) AS count FROM shooters').count,
      disciplines: disciplines.length,
      results: get('SELECT COUNT(*) AS count FROM results').count,
    },
    disciplines,
    latest_results: latestResults,
  };
}

// ---------- Season export / reset ----------

function fullExport() {
  return {
    event_title: Season.getTitle(),
    exported_at: new Date().toISOString(),
    shooters: all('SELECT * FROM shooters'),
    disciplines: all('SELECT * FROM disciplines'),
    results: all('SELECT * FROM results'),
  };
}

function archiveCurrentSeason(label) {
  const data = fullExport();
  const safeLabel = (label || Season.getTitle() || `saison-${Date.now()}`).replace(/[^a-zA-Z0-9_\-]/g, '_');
  let filePath = path.join(ARCHIVE_DIR, `${safeLabel}.json`);
  let suffix = 2;
  while (fs.existsSync(filePath)) {
    filePath = path.join(ARCHIVE_DIR, `${safeLabel}-${suffix}.json`);
    suffix++;
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

function validateSeasonArchive(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Die JSON-Datei enthält kein gültiges Saisonarchiv');
  }

  const eventTitle = typeof data.event_title === 'string' ? data.event_title.trim() : '';
  if (eventTitle.length > 200) throw new Error('Der Eventtitel ist länger als 200 Zeichen');
  if (!Array.isArray(data.shooters) || !Array.isArray(data.disciplines) || !Array.isArray(data.results)) {
    throw new Error('Im Saisonarchiv fehlen Schützen, Disziplinen oder Ergebnisse');
  }

  const validateId = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} ist ungültig`);
    return value;
  };
  const validateCreatedAt = (value, label) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: Erstellungsdatum fehlt`);
    return value;
  };

  const shooterIds = new Set();
  const startNumbers = new Set();
  const shooters = data.shooters.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Schütze ${index + 1} ist ungültig`);
    const id = validateId(item.id, `Schütze ${index + 1}: ID`);
    if (shooterIds.has(id)) throw new Error(`Schützen-ID ${id} kommt mehrfach vor`);
    shooterIds.add(id);
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) throw new Error(`Schütze ${index + 1}: Name fehlt`);
    if (!['m', 'w'].includes(item.gender)) throw new Error(`Schütze ${index + 1}: Geschlecht ist ungültig`);
    let start_number = item.start_number;
    if (start_number !== undefined && (!Number.isSafeInteger(start_number) || start_number < 1)) {
      throw new Error(`Schütze ${index + 1}: Startnummer ist ungültig`);
    }
    if (start_number !== undefined && startNumbers.has(start_number)) {
      throw new Error(`Startnummer ${start_number} kommt mehrfach vor`);
    }
    if (start_number !== undefined) startNumbers.add(start_number);
    return { id, name, gender: item.gender, start_number, created_at: validateCreatedAt(item.created_at, `Schütze ${index + 1}`) };
  });

  // Archive aus älteren App-Versionen enthielten noch keine Startnummer.
  // Solche Schützen bekommen beim Einlesen deterministisch die nächste freie.
  let nextArchiveStartNumber = 1;
  for (const shooter of shooters) {
    if (shooter.start_number !== undefined) continue;
    while (startNumbers.has(nextArchiveStartNumber)) nextArchiveStartNumber++;
    shooter.start_number = nextArchiveStartNumber;
    startNumbers.add(nextArchiveStartNumber);
  }

  const disciplineIds = new Set();
  const disciplineNames = new Set();
  const disciplines = data.disciplines.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Disziplin ${index + 1} ist ungültig`);
    const id = validateId(item.id, `Disziplin ${index + 1}: ID`);
    if (disciplineIds.has(id)) throw new Error(`Disziplin-ID ${id} kommt mehrfach vor`);
    disciplineIds.add(id);
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) throw new Error(`Disziplin ${index + 1}: Name fehlt`);
    const normalizedName = name.toLocaleLowerCase('de');
    if (disciplineNames.has(normalizedName)) throw new Error(`Disziplin "${name}" kommt mehrfach vor`);
    disciplineNames.add(normalizedName);
    if (!Number.isSafeInteger(item.sort_order)) throw new Error(`Disziplin ${index + 1}: Sortierung ist ungültig`);
    return {
      id,
      name,
      sort_order: item.sort_order,
      created_at: validateCreatedAt(item.created_at, `Disziplin ${index + 1}`),
    };
  });

  const resultIds = new Set();
  const results = data.results.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Ergebnis ${index + 1} ist ungültig`);
    const id = validateId(item.id, `Ergebnis ${index + 1}: ID`);
    if (resultIds.has(id)) throw new Error(`Ergebnis-ID ${id} kommt mehrfach vor`);
    resultIds.add(id);
    const shooter_id = validateId(item.shooter_id, `Ergebnis ${index + 1}: Schützen-ID`);
    const discipline_id = validateId(item.discipline_id, `Ergebnis ${index + 1}: Disziplin-ID`);
    if (!shooterIds.has(shooter_id)) throw new Error(`Ergebnis ${index + 1} verweist auf einen unbekannten Schützen`);
    if (!disciplineIds.has(discipline_id)) throw new Error(`Ergebnis ${index + 1} verweist auf eine unbekannte Disziplin`);
    if (!Number.isSafeInteger(item.round_number) || item.round_number < 1) {
      throw new Error(`Ergebnis ${index + 1}: Durchgang ist ungültig`);
    }
    if (typeof item.points !== 'number' || !Number.isFinite(item.points)) {
      throw new Error(`Ergebnis ${index + 1}: Punkte sind ungültig`);
    }
    return {
      id,
      shooter_id,
      discipline_id,
      round_number: item.round_number,
      points: item.points,
      created_at: validateCreatedAt(item.created_at, `Ergebnis ${index + 1}`),
    };
  });

  return { event_title: eventTitle, shooters, disciplines, results };
}

function restoreSeasonArchive(data) {
  const archive = validateSeasonArchive(data);
  const current = fullExport();
  const hasCurrentData = current.event_title || current.shooters.length || current.disciplines.length || current.results.length;
  const backupPath = hasCurrentData ? archiveCurrentSeason(current.event_title || 'vor-json-import') : null;

  db.exec('BEGIN IMMEDIATE');
  try {
    resetSeason();
    const insertShooter = db.prepare(
      'INSERT INTO shooters (id, name, gender, start_number, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const insertDiscipline = db.prepare(
      'INSERT INTO disciplines (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)'
    );
    const insertResult = db.prepare(
      'INSERT INTO results (id, shooter_id, discipline_id, round_number, points, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const shooter of archive.shooters) {
      insertShooter.run(shooter.id, shooter.name, shooter.gender, shooter.start_number, shooter.created_at);
    }
    for (const discipline of archive.disciplines) {
      insertDiscipline.run(discipline.id, discipline.name, discipline.sort_order, discipline.created_at);
    }
    for (const result of archive.results) {
      insertResult.run(
        result.id,
        result.shooter_id,
        result.discipline_id,
        result.round_number,
        result.points,
        result.created_at
      );
    }
    Season.setTitle(archive.event_title);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return {
    restored: {
      shooters: archive.shooters.length,
      disciplines: archive.disciplines.length,
      results: archive.results.length,
    },
    event_title: archive.event_title,
    backup: backupPath ? path.basename(backupPath) : null,
  };
}

function resetSeason() {
  run('DELETE FROM results');
  run('DELETE FROM disciplines');
  run('DELETE FROM shooters');
  run("DELETE FROM sqlite_sequence WHERE name IN ('results','disciplines','shooters')");
  Season.setTitle('');
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
  Season,
  rankingForDiscipline,
  dashboardSnapshot,
  fullExport,
  archiveCurrentSeason,
  validateSeasonArchive,
  restoreSeasonArchive,
  resetSeason,
  listArchives,
  ARCHIVE_DIR,
};
