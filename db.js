'use strict';
const { randomUUID } = require('node:crypto');
const store = require('./storage');
const { db, all, get, run, transaction } = store;
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
const positive = (v, label) => { if (!Number.isSafeInteger(v) || v < 1) fail(label + ' ist ungültig'); return v; };
function person(data) {
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name || name.length > 200 || !['m','w'].includes(data.gender)) fail('Gültiger Name (max. 200 Zeichen) und Geschlecht erforderlich');
  return { name, gender: data.gender };
}
const Events = {
  active() { return get("SELECT * FROM events WHERE status='active'"); },
  list() { return all('SELECT * FROM events ORDER BY year DESC,id DESC'); },
  get(id) { const e=get('SELECT * FROM events WHERE id=?',[id]); if(!e) fail('Event nicht gefunden',404); return e; },
  writable(id) { const e=this.get(id); if(!['active','correction'].includes(e.status)) fail('Abgeschlossenes Event ist schreibgeschützt',409); return e; },
  metadata(id, data) {
    this.writable(id);
    const title=String(data.title || '').trim();
    if(title.length>200) fail('Der Titel darf höchstens 200 Zeichen lang sein');
    const year=data.year === undefined ? this.get(id).year : Number(data.year);
    if(year !== null && (!Number.isInteger(year) || year<1900 || year>2200)) fail('Veranstaltungsjahr ist ungültig');
    run('UPDATE events SET title=?,year=? WHERE id=?',[title,year,id]);
    return this.get(id);
  },
  close(id, reason='Eventabschluss') {
    const e=this.writable(id);
    if(!e.year) fail('Bitte zuerst das Veranstaltungsjahr festlegen');
    const revision=e.revision+1;
    for(const d of Disciplines.list(id)) {
      for(const row of rankingForDiscipline(d.id, true)) {
        run('INSERT INTO placements(event_id,revision,participant_id,discipline_id,rank,best_points,rounds) VALUES (?,?,?,?,?,?,?)',
          [id,revision,row.participant_id,d.id,row.rank,row.best_points,JSON.stringify(row.all_rounds)]);
      }
    }
    run('INSERT INTO closures(event_id,revision,reason) VALUES (?,?,?)',[id,revision,reason]);
    run("UPDATE events SET status='closed',revision=?,closed_at=datetime('now'),correction_reason=NULL WHERE id=?",[revision,id]);
  },
  start({ title, year, previous_event_id }) {
    const old=this.active();
    if(!old || old.id !== previous_event_id) fail('Das aktive Event hat sich geändert. Bitte Ansicht aktualisieren.',409);
    const y=Number(year);
    if(!String(title || '').trim() || String(title).length>200 || !Number.isInteger(y) || y<1900 || y>2200) fail('Titel und gültiges Jahr für das neue Event erforderlich');
    if(!old.year) fail('Bitte das Jahr des bisherigen Events speichern');
    const backup=require('./backups').create('vor-eventwechsel');
    const next=transaction(()=>{
      this.close(old.id);
      const id=Number(run("INSERT INTO events(uuid,title,year,status) VALUES (?,?,?,'active')",[randomUUID(),title.trim(),y]).lastInsertRowid);
      return this.get(id);
    });
    const warnings=[]; let archive=null;
    try { archive=require('./archives').archiveCurrentSeason(undefined,old.id); } catch { warnings.push('Event geschlossen; Event-Export fehlgeschlagen. Erneut exportieren.'); }
    try { require('./backups').create('nach-eventwechsel'); } catch { warnings.push('Abschlusssicherung fehlgeschlagen. Bitte Vollbackup erneut erstellen.'); }
    return { ok:true, event:next, backup, archive:archive ? require('node:path').basename(archive) : null, warnings };
  },
  beginCorrection(id, reason) {
    const e=this.get(id);
    if(e.status!=='closed' || typeof reason!=='string' || !reason.trim() || reason.length>500) fail('Abgeschlossenes Event und Korrekturbegründung erforderlich');
    require('./backups').create('vor-korrektur');
    run("UPDATE events SET status='correction',correction_reason=? WHERE id=?",[reason.trim(),id]);
    return this.get(id);
  },
  finishCorrection(id) {
    const e=this.get(id);
    if(e.status!=='correction') fail('Kein Korrekturmodus aktiv');
    transaction(()=>this.close(id,e.correction_reason));
    const warnings=[];
    try { require('./archives').archiveCurrentSeason(undefined,id); }
    catch { warnings.push('Korrektur gespeichert; Event-Export fehlgeschlagen.'); }
    try { require('./backups').create('nach-korrektur'); }
    catch { warnings.push('Korrektur gespeichert; Abschlusssicherung fehlgeschlagen.'); }
    return {...this.get(id),warnings};
  }
};
const current = () => Events.active().id;
const Season = {
  getTitle() { return Events.active().title; },
  setTitle(title) { return Events.metadata(current(),{title}).title; }
};

const People = {
  list(search='') {
    return all(`SELECT s.id,s.uuid,s.name,s.gender,s.archived_at,s.updated_at,
      p.start_number, EXISTS(SELECT 1 FROM contacts c WHERE c.shooter_id=s.id AND c.status='granted') AS contact_allowed,
      (SELECT COUNT(*) FROM participants h WHERE h.shooter_id=s.id) AS event_count
      FROM shooters s LEFT JOIN participants p ON p.shooter_id=s.id AND p.event_id=?
      WHERE s.name LIKE ? ORDER BY s.name COLLATE NOCASE,s.id`,[current(),'%'+String(search).slice(0,200)+'%']);
  },
  get(id) { const s=get('SELECT * FROM shooters WHERE id=?',[id]); if(!s) fail('Schütze nicht gefunden',404); return s; },
  create(data) {
    const s=person(data);
    const id=Number(run('INSERT INTO shooters(uuid,name,gender) VALUES (?,?,?)',[randomUUID(),s.name,s.gender]).lastInsertRowid);
    return this.get(id);
  },
  update(id,data) {
    const existing=this.get(id);
    if(require('./privacy').erased(existing.uuid)) fail('Gelöschte Person darf nicht reaktiviert werden');
    const s=person(data);
    run("UPDATE shooters SET name=?,gender=?,updated_at=datetime('now') WHERE id=?",[s.name,s.gender,id]);
    run('UPDATE participants SET name=?,gender=? WHERE shooter_id=? AND event_id=?',[s.name,s.gender,id,current()]);
    return this.get(id);
  },
  archive(id, archived) {
    const s=this.get(id);
    if(!archived && require('./privacy').erased(s.uuid)) fail('Gelöschte Person darf nicht reaktiviert werden');
    run("UPDATE shooters SET archived_at=?,updated_at=datetime('now') WHERE id=?",[archived ? new Date().toISOString() : null,id]);
  },
  history(id) {
    this.get(id);
    return all(`SELECT e.*,p.id AS participant_id,p.start_number,p.name AS historical_name,
      (SELECT COUNT(*) FROM results r WHERE r.participant_id=p.id) AS result_count
      FROM participants p JOIN events e ON e.id=p.event_id WHERE p.shooter_id=? ORDER BY e.year DESC,e.id DESC`,[id]).map(e=>({
        ...e, placements: all(`SELECT f.rank,f.best_points,d.name AS discipline,f.revision
          FROM placements f JOIN disciplines d ON d.id=f.discipline_id
          WHERE f.participant_id=? AND f.revision=? ORDER BY d.sort_order,d.id`,[e.participant_id,e.revision])
      }));
  }
};
const shooterSelect = `SELECT s.id,s.uuid,p.name,p.gender,p.start_number,p.created_at,p.id AS participant_id,p.event_id
  FROM participants p JOIN shooters s ON s.id=p.shooter_id`;
const Shooters = {
  list(eventId=current()) { return all(shooterSelect+' WHERE p.event_id=? ORDER BY p.name COLLATE NOCASE,p.id',[eventId]); },
  nextStartNumber() {
    const used=new Set(this.list().map(s=>s.start_number)); let n=1; while(used.has(n)) n++; return n;
  },
  findById(id) { return get(shooterSelect+' WHERE s.id=? AND p.event_id=?',[id,current()]); },
  findByName(name) {
    const matches=all(shooterSelect+' WHERE p.name=? COLLATE NOCASE AND p.event_id=?',[name,current()]);
    if(matches.length>1) fail('Mehrere Teilnehmer mit diesem Namen. Bitte Startnummer verwenden.');
    return matches[0];
  },
  findByStartNumber(n) { return get(shooterSelect+' WHERE p.start_number=? AND p.event_id=?',[n,current()]); },
  register(shooterId, startNumber=this.nextStartNumber()) {
    const s=People.get(positive(shooterId,'Schützen-ID')); Events.writable(current());
    if(s.archived_at) fail('Archivierten Schützen zuerst reaktivieren');
    positive(startNumber,'Startnummer');
    if(this.findById(shooterId)) fail('Schütze ist bereits für dieses Event angemeldet',409);
    if(this.findByStartNumber(startNumber)) fail('Startnummer ist bereits vergeben',409);
    run('INSERT INTO participants(event_id,shooter_id,start_number,name,gender) VALUES (?,?,?,?,?)',[current(),shooterId,startNumber,s.name,s.gender]);
    return this.findById(shooterId);
  },
  create(data) { return transaction(()=>this.register(People.create(data).id,data.start_number)); },
  update(id,data,{swapOnConflict=false}={}) {
    const s=this.findById(id); if(!s) fail('Teilnehmer nicht gefunden',404);
    const p=person(data); const n=data.start_number === undefined ? s.start_number : positive(data.start_number,'Startnummer');
    const conflict=this.findByStartNumber(n);
    if(conflict && conflict.id!==id && !swapOnConflict) {
      const e=new Error('Startnummer ist bereits vergeben'); e.code='START_NUMBER_CONFLICT'; e.status=409; e.conflictingShooter=conflict; throw e;
    }
    return transaction(()=>{
      if(conflict && conflict.id!==id) run('UPDATE participants SET start_number=NULL WHERE id=?',[conflict.participant_id]);
      run('UPDATE participants SET name=?,gender=?,start_number=? WHERE id=?',[p.name,p.gender,n,s.participant_id]);
      People.update(id,p);
      if(conflict && conflict.id!==id) run('UPDATE participants SET start_number=? WHERE id=?',[s.start_number,conflict.participant_id]);
      return this.findById(id);
    });
  },
  remove(id) {
    const s=this.findById(id); if(!s) fail('Teilnehmer nicht gefunden',404);
    run('DELETE FROM participants WHERE id=?',[s.participant_id]);
  }
};
const Disciplines = {
  list(eventId=current()) { return all('SELECT * FROM disciplines WHERE event_id=? ORDER BY sort_order,name COLLATE NOCASE',[eventId]); },
  findById(id) { return get('SELECT * FROM disciplines WHERE id=? AND event_id=?',[id,current()]); },
  findByName(name) { return get('SELECT * FROM disciplines WHERE name=? COLLATE NOCASE AND event_id=?',[name,current()]); },
  create({name}) {
    if(typeof name!=='string' || !name.trim() || name.length>200) fail('Disziplinname ist ungültig');
    const order=get('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM disciplines WHERE event_id=?',[current()]).n;
    const id=Number(run('INSERT INTO disciplines(event_id,name,sort_order) VALUES (?,?,?)',[current(),name.trim(),order]).lastInsertRowid);
    return this.findById(id);
  },
  update(id,{name}) {
    if(!this.findById(id)) fail('Disziplin nicht gefunden',404);
    if(typeof name!=='string' || !name.trim() || name.length>200) fail('Disziplinname ist ungültig');
    run('UPDATE disciplines SET name=? WHERE id=?',[name.trim(),id]); return this.findById(id);
  },
  remove(id) { if(!this.findById(id)) fail('Disziplin nicht gefunden',404); run('DELETE FROM disciplines WHERE id=?',[id]); }
};
const resultSelect='SELECT r.*,p.shooter_id FROM results r JOIN participants p ON p.id=r.participant_id';
const Results = {
  listForShooterDiscipline(id,disciplineId) { return all(resultSelect+' WHERE p.shooter_id=? AND r.discipline_id=? AND r.event_id=? ORDER BY r.round_number,r.id',[id,disciplineId,current()]); },
  findById(id) { return get(resultSelect+' WHERE r.id=? AND r.event_id=?',[id,current()]); },
  create({shooter_id,discipline_id,round_number,points}) {
    const s=Shooters.findById(shooter_id);
    if(!s || !Disciplines.findById(discipline_id)) fail('Teilnehmer oder Disziplin gehört nicht zum aktiven Event');
    positive(round_number,'Durchgang'); if(typeof points!=='number' || !Number.isFinite(points)) fail('Punkte sind ungültig');
    const id=Number(run('INSERT INTO results(event_id,participant_id,discipline_id,round_number,points) VALUES (?,?,?,?,?)',[current(),s.participant_id,discipline_id,round_number,points]).lastInsertRowid);
    return this.findById(id);
  },
  update(id,{points,round_number}) {
    if(!this.findById(id)) fail('Ergebnis nicht gefunden',404);
    positive(round_number,'Durchgang'); if(typeof points!=='number' || !Number.isFinite(points)) fail('Punkte sind ungültig');
    run('UPDATE results SET points=?,round_number=? WHERE id=?',[points,round_number,id]); return this.findById(id);
  },
  remove(id) { if(!this.findById(id)) fail('Ergebnis nicht gefunden',404); run('DELETE FROM results WHERE id=?',[id]); },
  nextRoundNumber(id,d) { return Math.max(0,...this.listForShooterDiscipline(id,d).map(r=>r.round_number))+1; },
  correct(eventId,id,points) {
    if(Events.get(eventId).status!=='correction') fail('Korrekturmodus erforderlich',409);
    if(typeof points!=='number' || !Number.isFinite(points)) fail('Punkte sind ungültig');
    if(!get('SELECT id FROM results WHERE id=? AND event_id=?',[id,eventId])) fail('Ergebnis nicht gefunden',404);
    run('UPDATE results SET points=? WHERE id=?',[points,id]);
  }
};
function rankingForDiscipline(id, calculate=false) {
  const d=get('SELECT * FROM disciplines WHERE id=?',[id]); if(!d) return [];
  const e=Events.get(d.event_id);
  if(e.status==='closed' && !calculate) return all(`SELECT f.rank,p.shooter_id,p.id AS participant_id,p.name,p.gender,p.start_number,
    f.best_points,f.rounds FROM placements f JOIN participants p ON p.id=f.participant_id
    WHERE f.discipline_id=? AND f.revision=? ORDER BY f.rank`,[id,e.revision]).map(({rounds,...r})=>({...r,all_rounds:JSON.parse(rounds)}));
  const by=new Map();
  for(const r of all(`SELECT p.*,r.points FROM participants p JOIN results r ON r.participant_id=p.id WHERE r.discipline_id=?`,[id])) {
    if(!by.has(r.id)) by.set(r.id,{shooter_id:r.shooter_id,participant_id:r.id,name:r.name,gender:r.gender,start_number:r.start_number,all_rounds:[]});
    by.get(r.id).all_rounds.push(r.points);
  }
  const entries=[...by.values()];
  entries.forEach(r=>r.all_rounds.sort((a,b)=>b-a));
  entries.sort((a,b)=>{
    for(let i=0;i<Math.max(a.all_rounds.length,b.all_rounds.length);i++) {
      if(a.all_rounds[i]===undefined) return 1;
      if(b.all_rounds[i]===undefined) return -1;
      if(a.all_rounds[i]!==b.all_rounds[i]) return b.all_rounds[i]-a.all_rounds[i];
    }
    return a.name.localeCompare(b.name,'de') || a.participant_id-b.participant_id;
  });
  return entries.map((r,i)=>({...r,rank:i+1,best_points:r.all_rounds[0]}));
}
function dashboardSnapshot() {
  const disciplines=Disciplines.list().map(d=>({...d,ranking:rankingForDiscipline(d.id)}));
  return {event_title:Season.getTitle(),updated_at:new Date().toISOString(),
    stats:{shooters:Shooters.list().length,disciplines:disciplines.length,results:get('SELECT COUNT(*) AS n FROM results WHERE event_id=?',[current()]).n},
    disciplines, latest_results:all(`SELECT r.id,r.points,r.round_number,r.created_at,p.name AS shooter_name,p.start_number,d.id AS discipline_id,d.name AS discipline_name
      FROM results r JOIN participants p ON p.id=r.participant_id JOIN disciplines d ON d.id=r.discipline_id WHERE r.event_id=? ORDER BY r.id DESC LIMIT 10`,[current()])};
}
module.exports = { ...store, Events, People, Shooters, Disciplines, Results, Season, rankingForDiscipline, dashboardSnapshot, fail, person,
  fullExport:(...args)=>require('./archives').fullExport(...args),
  archiveCurrentSeason:(...args)=>require('./archives').archiveCurrentSeason(...args),
  validateSeasonArchive:(...args)=>require('./archives').validateSeasonArchive(...args),
  restoreSeasonArchive:(...args)=>require('./archives').restoreSeasonArchive(...args),
  listArchives:()=>require('./archives').listArchives(),
  resetSeason:(data)=>Events.start(data)
};
