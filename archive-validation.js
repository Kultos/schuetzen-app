'use strict';
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
    if (data.version >= 4 && item.ranking_mode === undefined) throw new Error(`Disziplin ${index + 1}: Wertungsart fehlt`);
    const ranking_mode = item.ranking_mode === undefined ? 'combined' : item.ranking_mode;
    if (!['combined', 'separate'].includes(ranking_mode)) throw new Error(`Disziplin ${index + 1}: Wertungsart ist ungültig`);
    return {
      id,
      name,
      ranking_mode,
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


module.exports = { validateSeasonArchive };
