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
  teamSettings(id, data) {
    const event=this.writable(id);
    const scoringMode=data.scoring_mode === undefined ? event.scoring_mode : data.scoring_mode;
    const maxMembers=data.team_max_members === undefined ? event.team_max_members : Number(data.team_max_members);
    const countedResults=data.team_counted_results === undefined ? event.team_counted_results : Number(data.team_counted_results);
    if(!['individual','team','both'].includes(scoringMode)) fail('Wertungsmodus ist ungültig');
    if(!Number.isSafeInteger(maxMembers) || maxMembers<1 || maxMembers>100) fail('Die Mannschaftsgröße muss zwischen 1 und 100 liegen');
    if(!Number.isSafeInteger(countedResults) || countedResults<1 || countedResults>maxMembers) fail('Die Zahl der gewerteten Ergebnisse muss zwischen 1 und der Mannschaftsgröße liegen');
    const largest=get(`SELECT COUNT(*) AS n FROM team_memberships WHERE event_id=? GROUP BY team_id ORDER BY n DESC LIMIT 1`,[id])?.n || 0;
    if(largest>maxMembers) fail(`Mindestens eine Mannschaft hat bereits ${largest} Mitglieder`,409);
    run('UPDATE events SET scoring_mode=?,team_max_members=?,team_counted_results=? WHERE id=?',[scoringMode,maxMembers,countedResults,id]);
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
      if(e.scoring_mode!=='individual') {
        for(const row of teamRankingForDiscipline(d.id, true)) {
          run('INSERT INTO team_placements(event_id,revision,team_id,discipline_id,rank,total_points,counted_results) VALUES (?,?,?,?,?,?,?)',
            [id,revision,row.team_id,d.id,row.rank,row.total_points,JSON.stringify({entries:row.entries,member_count:row.member_count,required_count:row.required_count})]);
        }
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
  create(data) {
    return transaction(()=>{
      const shooter=this.register(People.create(data).id,data.start_number);
      if(data.team_id!==undefined && data.team_id!==null && data.team_id!=='') Teams.assign(positive(Number(data.team_id),'Mannschafts-ID'),shooter.id);
      return shooter;
    });
  },
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
      if(Object.hasOwn(data,'team_id')) {
        if(data.team_id===null || data.team_id==='') Teams.unassign(id);
        else Teams.assign(positive(Number(data.team_id),'Mannschafts-ID'),id);
      }
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
  create({name,ranking_mode='combined'}) {
    if(typeof name!=='string' || !name.trim() || name.length>200) fail('Disziplinname ist ungültig');
    if(!['combined','separate'].includes(ranking_mode)) fail('Wertungsart ist ungültig');
    const order=get('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM disciplines WHERE event_id=?',[current()]).n;
    const id=Number(run('INSERT INTO disciplines(event_id,name,ranking_mode,sort_order) VALUES (?,?,?,?)',[current(),name.trim(),ranking_mode,order]).lastInsertRowid);
    return this.findById(id);
  },
  update(id,{name,ranking_mode}) {
    const existing=this.findById(id); if(!existing) fail('Disziplin nicht gefunden',404);
    if(typeof name!=='string' || !name.trim() || name.length>200) fail('Disziplinname ist ungültig');
    ranking_mode=ranking_mode===undefined ? existing.ranking_mode : ranking_mode;
    if(!['combined','separate'].includes(ranking_mode)) fail('Wertungsart ist ungültig');
    run('UPDATE disciplines SET name=?,ranking_mode=? WHERE id=?',[name.trim(),ranking_mode,id]); return this.findById(id);
  },
  remove(id) { if(!this.findById(id)) fail('Disziplin nicht gefunden',404); run('DELETE FROM disciplines WHERE id=?',[id]); }
};
const Teams = {
  list(eventId=current()) {
    return all(`SELECT t.*,COUNT(m.participant_id) AS member_count
      FROM teams t LEFT JOIN team_memberships m ON m.team_id=t.id
      WHERE t.event_id=? GROUP BY t.id ORDER BY t.name COLLATE NOCASE,t.id`,[eventId]).map(team=>({
        ...team,
        members:all(`SELECT p.shooter_id,p.id AS participant_id,p.start_number,p.name,p.gender
          FROM team_memberships m JOIN participants p ON p.id=m.participant_id
          WHERE m.team_id=? ORDER BY p.name COLLATE NOCASE,p.id`,[team.id])
      }));
  },
  findById(id, eventId=current()) { return get('SELECT * FROM teams WHERE id=? AND event_id=?',[id,eventId]); },
  create({name}) {
    Events.writable(current());
    name=String(name || '').trim();
    if(!name || name.length>200) fail('Mannschaftsname ist ungültig');
    if(get('SELECT id FROM teams WHERE event_id=? AND name=? COLLATE NOCASE',[current(),name])) fail('Mannschaft existiert bereits',409);
    const id=Number(run('INSERT INTO teams(event_id,name) VALUES (?,?)',[current(),name]).lastInsertRowid);
    return this.findById(id);
  },
  update(id,{name}) {
    Events.writable(current());
    if(!this.findById(id)) fail('Mannschaft nicht gefunden',404);
    name=String(name || '').trim();
    if(!name || name.length>200) fail('Mannschaftsname ist ungültig');
    const duplicate=get('SELECT id FROM teams WHERE event_id=? AND name=? COLLATE NOCASE',[current(),name]);
    if(duplicate && duplicate.id!==id) fail('Mannschaft existiert bereits',409);
    run('UPDATE teams SET name=? WHERE id=?',[name,id]);
    return this.findById(id);
  },
  remove(id) {
    Events.writable(current());
    if(!this.findById(id)) fail('Mannschaft nicht gefunden',404);
    run('DELETE FROM teams WHERE id=?',[id]);
  },
  assign(teamId, shooterId) {
    const event=Events.writable(current());
    const team=this.findById(teamId);
    const shooter=Shooters.findById(shooterId);
    if(!team || !shooter) fail('Mannschaft oder Teilnehmer gehört nicht zum aktiven Event');
    const existing=get('SELECT team_id FROM team_memberships WHERE event_id=? AND participant_id=?',[current(),shooter.participant_id]);
    if(existing?.team_id===teamId) return team;
    const count=get('SELECT COUNT(*) AS n FROM team_memberships WHERE team_id=?',[teamId]).n;
    if(count>=event.team_max_members) fail(`Diese Mannschaft hat bereits ${event.team_max_members} Mitglieder`,409);
    run(`INSERT INTO team_memberships(event_id,team_id,participant_id) VALUES (?,?,?)
      ON CONFLICT(event_id,participant_id) DO UPDATE SET team_id=excluded.team_id,created_at=datetime('now')`,[current(),teamId,shooter.participant_id]);
    return team;
  },
  unassign(shooterId) {
    Events.writable(current());
    const shooter=Shooters.findById(shooterId);
    if(!shooter) fail('Teilnehmer nicht gefunden',404);
    run('DELETE FROM team_memberships WHERE event_id=? AND participant_id=?',[current(),shooter.participant_id]);
  },
  membershipForShooter(shooterId) {
    return get(`SELECT t.id,t.name FROM team_memberships m JOIN teams t ON t.id=m.team_id
      JOIN participants p ON p.id=m.participant_id WHERE p.shooter_id=? AND m.event_id=?`,[shooterId,current()]);
  }
};
const resultSelect=`SELECT r.*,p.shooter_id,
  EXISTS(SELECT 1 FROM team_result_selections ts WHERE ts.result_id=r.id) AS team_selected
  FROM results r JOIN participants p ON p.id=r.participant_id`;
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
  },
  selectForTeam(id, selected=true) {
    Events.writable(current());
    const result=this.findById(id);
    if(!result) fail('Ergebnis nicht gefunden',404);
    if(selected) {
      if(!get('SELECT 1 FROM team_memberships WHERE event_id=? AND participant_id=?',[current(),result.participant_id])) fail('Teilnehmer zuerst einer Mannschaft zuordnen',409);
      run(`INSERT INTO team_result_selections(event_id,participant_id,discipline_id,result_id) VALUES (?,?,?,?)
        ON CONFLICT(event_id,participant_id,discipline_id) DO UPDATE SET result_id=excluded.result_id,created_at=datetime('now')`,
        [current(),result.participant_id,result.discipline_id,id]);
    } else {
      run('DELETE FROM team_result_selections WHERE event_id=? AND participant_id=? AND discipline_id=? AND result_id=?',
        [current(),result.participant_id,result.discipline_id,id]);
    }
    return this.findById(id);
  }
};
function rankingForDiscipline(id, calculate=false) {
  const d=get('SELECT * FROM disciplines WHERE id=?',[id]); if(!d) return [];
  const e=Events.get(d.event_id);
  if(e.status==='closed' && !calculate) return all(`SELECT f.rank,p.shooter_id,p.id AS participant_id,p.name,p.gender,p.start_number,
    f.best_points,f.rounds FROM placements f JOIN participants p ON p.id=f.participant_id
    WHERE f.discipline_id=? AND f.revision=? ORDER BY ${d.ranking_mode==='separate' ? "p.gender DESC," : ''} f.rank`,[id,e.revision]).map(({rounds,...r})=>({...r,ranking_group:d.ranking_mode==='separate' ? (r.gender==='w'?'women':'men') : 'combined',all_rounds:JSON.parse(rounds)}));
  const by=new Map();
  for(const r of all(`SELECT p.*,r.points FROM participants p JOIN results r ON r.participant_id=p.id WHERE r.discipline_id=?`,[id])) {
    if(!by.has(r.id)) by.set(r.id,{shooter_id:r.shooter_id,participant_id:r.id,name:r.name,gender:r.gender,start_number:r.start_number,all_rounds:[]});
    by.get(r.id).all_rounds.push(r.points);
  }
  const entries=[...by.values()];
  entries.forEach(r=>r.all_rounds.sort((a,b)=>b-a));
  entries.sort((a,b)=>{
    if(d.ranking_mode==='separate' && a.gender!==b.gender) return a.gender==='w' ? -1 : 1;
    for(let i=0;i<Math.max(a.all_rounds.length,b.all_rounds.length);i++) {
      if(a.all_rounds[i]===undefined) return 1;
      if(b.all_rounds[i]===undefined) return -1;
      if(a.all_rounds[i]!==b.all_rounds[i]) return b.all_rounds[i]-a.all_rounds[i];
    }
    return a.name.localeCompare(b.name,'de') || a.participant_id-b.participant_id;
  });
  const ranks={};
  return entries.map((r,i)=>{
    const ranking_group=d.ranking_mode==='separate' ? (r.gender==='w'?'women':'men') : 'combined';
    ranks[ranking_group]=(ranks[ranking_group]||0)+1;
    return {...r,ranking_group,rank:ranks[ranking_group],best_points:r.all_rounds[0]};
  });
}
function teamRankingForDiscipline(id, calculate=false) {
  const discipline=get('SELECT * FROM disciplines WHERE id=?',[id]);
  if(!discipline) return [];
  const event=Events.get(discipline.event_id);
  if(event.scoring_mode==='individual') return [];
  if(event.status==='closed' && !calculate) {
    return all(`SELECT f.rank,f.team_id,t.name,f.total_points,f.counted_results
      FROM team_placements f JOIN teams t ON t.id=f.team_id
      WHERE f.discipline_id=? AND f.revision=? ORDER BY f.rank,t.name COLLATE NOCASE`,[id,event.revision]).map(row=>{
        const snapshot=JSON.parse(row.counted_results);
        const entries=Array.isArray(snapshot) ? snapshot : snapshot.entries;
        return {...row,entries,member_count:snapshot.member_count ?? entries.length,required_count:snapshot.required_count ?? event.team_counted_results,
          selected_count:entries.length,counted_count:entries.filter(entry=>entry.counted).length};
      });
  }
  const rows=all(`SELECT t.id AS team_id,t.name,p.shooter_id,p.id AS participant_id,p.name AS shooter_name,p.start_number,
      r.id AS result_id,r.round_number,r.points
    FROM teams t
    LEFT JOIN team_memberships m ON m.team_id=t.id
    LEFT JOIN participants p ON p.id=m.participant_id
    LEFT JOIN team_result_selections s ON s.participant_id=p.id AND s.discipline_id=?
    LEFT JOIN results r ON r.id=s.result_id
    WHERE t.event_id=? ORDER BY t.name COLLATE NOCASE,p.name COLLATE NOCASE`,[id,event.id]);
  const teams=new Map();
  for(const row of rows) {
    if(!teams.has(row.team_id)) teams.set(row.team_id,{team_id:row.team_id,name:row.name,member_count:0,required_count:event.team_counted_results,entries:[]});
    const team=teams.get(row.team_id);
    if(row.participant_id) team.member_count++;
    if(row.result_id) team.entries.push({result_id:row.result_id,participant_id:row.participant_id,shooter_id:row.shooter_id,
      name:row.shooter_name,start_number:row.start_number,round_number:row.round_number,points:row.points});
  }
  const ranked=[...teams.values()].filter(team=>team.entries.length);
  for(const team of ranked) {
    team.entries.sort((a,b)=>b.points-a.points || a.name.localeCompare(b.name,'de') || a.participant_id-b.participant_id);
    team.entries=team.entries.map((entry,index)=>({...entry,counted:index<event.team_counted_results}));
    team.selected_count=team.entries.length;
    team.counted_count=Math.min(team.entries.length,event.team_counted_results);
    team.total_points=team.entries.slice(0,event.team_counted_results).reduce((sum,entry)=>sum+entry.points,0);
  }
  ranked.sort((a,b)=>b.total_points-a.total_points || comparePointSeries(a.entries.filter(e=>e.counted).map(e=>e.points),b.entries.filter(e=>e.counted).map(e=>e.points)) || a.name.localeCompare(b.name,'de') || a.team_id-b.team_id);
  let previousKey=null,rank=0;
  ranked.forEach((team,index)=>{
    const key=JSON.stringify([team.total_points,team.entries.filter(entry=>entry.counted).map(entry=>entry.points)]);
    if(key!==previousKey) rank=index+1;
    team.rank=rank;
    previousKey=key;
  });
  return ranked;
}
function comparePointSeries(a,b) {
  for(let i=0;i<Math.max(a.length,b.length);i++) {
    if(a[i]===undefined) return 1;
    if(b[i]===undefined) return -1;
    if(a[i]!==b[i]) return b[i]-a[i];
  }
  return 0;
}
function dashboardSnapshot() {
  const event=Events.active();
  const disciplines=Disciplines.list().map(d=>({...d,ranking:rankingForDiscipline(d.id),team_ranking:teamRankingForDiscipline(d.id)}));
  return {event_title:Season.getTitle(),scoring_mode:event.scoring_mode,updated_at:new Date().toISOString(),
    stats:{shooters:Shooters.list().length,disciplines:disciplines.length,results:get('SELECT COUNT(*) AS n FROM results WHERE event_id=?',[current()]).n},
    disciplines, latest_results:all(`SELECT r.id,r.points,r.round_number,r.created_at,p.name AS shooter_name,p.start_number,d.id AS discipline_id,d.name AS discipline_name
      FROM results r JOIN participants p ON p.id=r.participant_id JOIN disciplines d ON d.id=r.discipline_id WHERE r.event_id=? ORDER BY r.id DESC LIMIT 10`,[current()])};
}
module.exports = { ...store, Events, People, Shooters, Disciplines, Teams, Results, Season, rankingForDiscipline, teamRankingForDiscipline, dashboardSnapshot, fail, person,
  fullExport:(...args)=>require('./archives').fullExport(...args),
  archiveCurrentSeason:(...args)=>require('./archives').archiveCurrentSeason(...args),
  validateSeasonArchive:(...args)=>require('./archives').validateSeasonArchive(...args),
  restoreSeasonArchive:(...args)=>require('./archives').restoreSeasonArchive(...args),
  listArchives:()=>require('./archives').listArchives(),
  resetSeason:(data)=>Events.start(data)
};
