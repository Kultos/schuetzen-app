'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const D=require('./db');
const {all,get,run,transaction,atomicWrite,ARCHIVE_DIR,Events,People,Shooters,Disciplines,fail}=D;
const legacyValidate=require('./archive-validation').validateSeasonArchive;
function fullExport(eventId=Events.active().id) {
  const event=Events.get(eventId);
  const placementHistory=all(`SELECT f.revision,p.shooter_id,f.discipline_id,f.rank,f.best_points,f.rounds
    FROM placements f JOIN participants p ON p.id=f.participant_id WHERE f.event_id=? ORDER BY f.revision,f.discipline_id,f.rank`,[eventId])
    .map(({rounds,...row})=>({...row,all_rounds:JSON.parse(rounds)}));
  const teamPlacementHistory=all(`SELECT f.revision,f.team_id,f.discipline_id,f.rank,f.total_points,f.counted_results
    FROM team_placements f WHERE f.event_id=? ORDER BY f.revision,f.discipline_id,f.rank,f.team_id`,[eventId]).map(({counted_results,...row})=>{
      const snapshot=JSON.parse(counted_results);
      return {...row,...(Array.isArray(snapshot) ? {entries:snapshot} : snapshot)};
    });
  const teams=all('SELECT id,name,created_at FROM teams WHERE event_id=? ORDER BY name COLLATE NOCASE,id',[eventId]).map(team=>({
    ...team,members:all(`SELECT p.shooter_id FROM team_memberships m JOIN participants p ON p.id=m.participant_id
      WHERE m.team_id=? ORDER BY p.shooter_id`,[team.id]).map(row=>row.shooter_id)
  }));
  return {format:'schuetzen-event',version:5,event_title:event.title,event,exported_at:new Date().toISOString(),
    shooters:Shooters.list(eventId).map(({id,uuid,name,gender,start_number,created_at})=>({id,uuid,name,gender,start_number,created_at})),
    disciplines:Disciplines.list(eventId),
    results:all('SELECT r.id,p.shooter_id,r.discipline_id,r.round_number,r.points,r.created_at FROM results r JOIN participants p ON p.id=r.participant_id WHERE r.event_id=?',[eventId]),
    teams,
    team_selections:all(`SELECT p.shooter_id,s.discipline_id,s.result_id FROM team_result_selections s
      JOIN participants p ON p.id=s.participant_id WHERE s.event_id=? ORDER BY p.shooter_id,s.discipline_id`,[eventId]),
    placements:event.status==='closed' ? placementHistory.filter(p=>p.revision===event.revision).map(({revision,...p})=>p) : [],
    placement_history:placementHistory,
    team_placements:event.status==='closed' ? teamPlacementHistory.filter(p=>p.revision===event.revision).map(({revision,...p})=>p) : [],
    team_placement_history:teamPlacementHistory,
    closures:all('SELECT revision,reason,created_at FROM closures WHERE event_id=? ORDER BY revision',[eventId])};
}
function validateSeasonArchive(data) {
  let clean;
  try { clean=legacyValidate(data); }
  catch(error) { if(!Number.isInteger(error.status)) error.status=400; throw error; }
  if(data.version!==undefined && (![2,3,4,5].includes(data.version) || data.format!=='schuetzen-event')) fail('Unbekannte Archivversion');
  clean.archive_version=data.version || 1;
  if([2,3,4,5].includes(data.version)) {
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if(!data.event || !uuid.test(data.event.uuid) || !['active','closed','correction'].includes(data.event.status) || data.event.ranking_version!=='series-name-v1') fail('Ungültige Veranstaltungsdaten oder unbekannte Wertung');
    if(data.event.year!==null && (!Number.isInteger(data.event.year) || data.event.year<1900 || data.event.year>2200)) fail('Eventjahr ist ungültig');
    if(!Number.isSafeInteger(data.event.revision) || data.event.revision<0 || (['closed','correction'].includes(data.event.status) && data.event.revision<1)) fail('Eventrevision ist ungültig');
    if(![0,1].includes(data.event.reconstructed)) fail('Rekonstruktionskennzeichen ist ungültig');
    const uuids=new Set();
    clean.shooters.forEach((s,i)=>{const value=data.shooters[i].uuid;if(!uuid.test(value)||uuids.has(value)) fail('Ungültige oder doppelte Personen-UUID');s.uuid=value;uuids.add(value);});
    const scoringMode=data.version>=5 ? data.event.scoring_mode : 'individual';
    const teamMaxMembers=data.version>=5 ? data.event.team_max_members : 5;
    const teamCountedResults=data.version>=5 ? data.event.team_counted_results : 3;
    if(!['individual','team','both'].includes(scoringMode) || !Number.isSafeInteger(teamMaxMembers) || teamMaxMembers<1 || !Number.isSafeInteger(teamCountedResults) || teamCountedResults<1 || teamCountedResults>teamMaxMembers) fail('Mannschaftswertungs-Einstellungen sind ungültig');
    clean.event={uuid:data.event.uuid,year:data.event.year,status:data.event.status,revision:data.event.revision,ranking_version:data.event.ranking_version,reconstructed:data.event.reconstructed,
      scoring_mode:scoringMode,team_max_members:teamMaxMembers,team_counted_results:teamCountedResults};
    if(!Array.isArray(data.placements)) fail('Abschlusswertung fehlt');
    clean.placements=data.placements.map(p=>{
      if(!clean.shooters.some(s=>s.id===p.shooter_id)||!clean.disciplines.some(d=>d.id===p.discipline_id)||!Number.isSafeInteger(p.rank)||p.rank<1||!Number.isFinite(p.best_points)||!Array.isArray(p.all_rounds)||!p.all_rounds.length||p.all_rounds.some(v=>typeof v!=='number'||!Number.isFinite(v))) fail('Abschlussplatzierung ist ungültig');
      return {shooter_id:p.shooter_id,discipline_id:p.discipline_id,rank:p.rank,best_points:p.best_points,all_rounds:p.all_rounds};
    });
    const rankingGroup=p=>clean.disciplines.find(d=>d.id===p.discipline_id).ranking_mode==='separate'
      ? clean.shooters.find(s=>s.id===p.shooter_id).gender : 'combined';
    const keys=new Set();
    const ranks=new Set();
    for(const p of clean.placements) {
      const key=p.shooter_id+':'+p.discipline_id, rankKey=p.discipline_id+':'+rankingGroup(p)+':'+p.rank;
      if(keys.has(key)||ranks.has(rankKey)) fail('Doppelte Abschlussplatzierung');keys.add(key);ranks.add(rankKey);
    }
    if(clean.event.status==='closed') {
      const groups=new Set(clean.results.map(r=>r.shooter_id+':'+r.discipline_id));
      if(groups.size!==keys.size || [...groups].some(k=>!keys.has(k))) fail('Abschlusswertung ist unvollständig');
      for(const p of clean.placements) {
        if(p.rank>clean.placements.filter(x=>x.discipline_id===p.discipline_id).length) fail('Platz liegt außerhalb der Rangliste');
        const points=clean.results.filter(r=>r.shooter_id===p.shooter_id&&r.discipline_id===p.discipline_id).map(r=>r.points).sort((a,b)=>b-a);
        if(JSON.stringify(points)!==JSON.stringify(p.all_rounds) || points[0]!==p.best_points) fail('Abschlusswertung widerspricht Ergebnissen');
      }
      const names=new Map(clean.shooters.map(s=>[s.id,s.name]));
      for(const d of clean.disciplines) {
        const expected=[...new Set(clean.results.filter(r=>r.discipline_id===d.id).map(r=>r.shooter_id))].map(shooterId=>({
          shooter_id:shooterId,
          name:names.get(shooterId),
          gender:clean.shooters.find(s=>s.id===shooterId).gender,
          rounds:clean.results.filter(r=>r.discipline_id===d.id&&r.shooter_id===shooterId).map(r=>r.points).sort((a,b)=>b-a)
        }));
        expected.sort((a,b)=>{
          if(d.ranking_mode==='separate' && a.gender!==b.gender) return a.gender==='w' ? -1 : 1;
          for(let i=0;i<Math.max(a.rounds.length,b.rounds.length);i++) {
            if(a.rounds[i]===undefined)return 1;if(b.rounds[i]===undefined)return -1;
            if(a.rounds[i]!==b.rounds[i])return b.rounds[i]-a.rounds[i];
          }
          return a.name.localeCompare(b.name,'de') || a.shooter_id-b.shooter_id;
        });
        const ranksByGroup={}; expected.forEach(row=>{
          const placement=clean.placements.find(p=>p.discipline_id===d.id&&p.shooter_id===row.shooter_id);
          const group=d.ranking_mode==='separate' ? row.gender : 'combined';
          ranksByGroup[group]=(ranksByGroup[group]||0)+1;
          if(!placement || placement.rank!==ranksByGroup[group]) fail('Abschlussrang entspricht nicht der angegebenen Wertungsregel');
        });
      }
    } else if(clean.placements.length) {
      fail('Eine noch nicht abgeschlossene Veranstaltung darf keine Abschlusswertung enthalten');
    }
    if(data.version>=3) {
      if(!Array.isArray(data.placement_history)||!Array.isArray(data.closures)) fail('Versionshistorie fehlt');
      clean.placement_history=data.placement_history.map(p=>{
        if(!Number.isSafeInteger(p.revision)||p.revision<1||p.revision>clean.event.revision||!clean.shooters.some(s=>s.id===p.shooter_id)||!clean.disciplines.some(d=>d.id===p.discipline_id)||!Number.isSafeInteger(p.rank)||p.rank<1||!Number.isFinite(p.best_points)||!Array.isArray(p.all_rounds)||!p.all_rounds.length||p.all_rounds.some(v=>typeof v!=='number'||!Number.isFinite(v))) fail('Historische Abschlussplatzierung ist ungültig');
        return {revision:p.revision,shooter_id:p.shooter_id,discipline_id:p.discipline_id,rank:p.rank,best_points:p.best_points,all_rounds:p.all_rounds};
      });
      clean.closures=data.closures.map(c=>{
        if(!Number.isSafeInteger(c.revision)||c.revision<1||c.revision>clean.event.revision||typeof c.reason!=='string'||!c.reason.trim()||c.reason.length>500||typeof c.created_at!=='string'||!Number.isFinite(Date.parse(c.created_at))) fail('Abschlussprotokoll ist ungültig');
        return {revision:c.revision,reason:c.reason.trim(),created_at:c.created_at};
      });
      const expectedRevisions=Array.from({length:clean.event.revision},(_,i)=>i+1);
      if(clean.event.status==='active' && (clean.event.revision!==0||clean.closures.length||clean.placement_history.length)) fail('Aktive Veranstaltung enthält eine Abschlussversion');
      if(clean.event.status!=='active' && JSON.stringify(clean.closures.map(c=>c.revision).sort((a,b)=>a-b))!==JSON.stringify(expectedRevisions)) fail('Abschlussprotokoll ist unvollständig');
      const historyKeys=new Set(),groups=new Set(clean.results.map(r=>r.shooter_id+':'+r.discipline_id));
      for(const p of clean.placement_history) {
        const key=p.revision+':'+p.shooter_id+':'+p.discipline_id,rankKey=p.revision+':'+p.discipline_id+':'+rankingGroup(p)+':rank:'+p.rank;
        if(historyKeys.has(key)||historyKeys.has(rankKey)) fail('Doppelte historische Abschlussplatzierung');historyKeys.add(key);historyKeys.add(rankKey);
      }
      for(const revision of expectedRevisions) {
        const rows=clean.placement_history.filter(p=>p.revision===revision),rowGroups=new Set(rows.map(p=>p.shooter_id+':'+p.discipline_id));
        if(rowGroups.size!==groups.size||[...groups].some(key=>!rowGroups.has(key))) fail('Historische Abschlusswertung ist unvollständig');
        for(const d of clean.disciplines) {
          for(const group of d.ranking_mode==='separate' ? ['m','w'] : ['combined']) {
            const ranks=rows.filter(p=>p.discipline_id===d.id&&(group==='combined'||clean.shooters.find(s=>s.id===p.shooter_id).gender===group)).map(p=>p.rank).sort((a,b)=>a-b);
            if(ranks.some((rank,index)=>rank!==index+1)) fail('Historische Abschlussränge sind unvollständig');
          }
        }
      }
      if(clean.event.status==='closed') {
        const canonical=rows=>rows.map(p=>({shooter_id:p.shooter_id,discipline_id:p.discipline_id,rank:p.rank,best_points:p.best_points,all_rounds:p.all_rounds})).sort((a,b)=>a.discipline_id-b.discipline_id||rankingGroup(a).localeCompare(rankingGroup(b))||a.rank-b.rank||a.shooter_id-b.shooter_id);
        if(JSON.stringify(canonical(clean.placements))!==JSON.stringify(canonical(clean.placement_history.filter(p=>p.revision===clean.event.revision)))) fail('Letzte Abschlusswertung widerspricht der Versionshistorie');
      }
    }
    if(data.version>=5) {
      if(!Array.isArray(data.teams)||!Array.isArray(data.team_selections)||!Array.isArray(data.team_placements)||!Array.isArray(data.team_placement_history)) fail('Mannschaftsdaten fehlen');
      const teamIds=new Set(),teamNames=new Set(),assignedShooters=new Set();
      clean.teams=data.teams.map((team,index)=>{
        if(!team || !Number.isSafeInteger(team.id) || team.id<1 || teamIds.has(team.id)) fail(`Mannschaft ${index+1}: ID ist ungültig oder doppelt`);
        const name=typeof team.name==='string' ? team.name.trim() : '';
        const normalized=name.toLocaleLowerCase('de');
        if(!name || name.length>200 || teamNames.has(normalized) || !Array.isArray(team.members) || team.members.length>teamMaxMembers) fail(`Mannschaft ${index+1} ist ungültig`);
        for(const shooterId of team.members) {
          if(!clean.shooters.some(shooter=>shooter.id===shooterId) || assignedShooters.has(shooterId)) fail('Ein Schütze ist keiner oder mehreren gültigen Mannschaften zugeordnet');
          assignedShooters.add(shooterId);
        }
        teamIds.add(team.id);teamNames.add(normalized);
        return {id:team.id,name,members:[...team.members],created_at:team.created_at};
      });
      const selectionKeys=new Set();
      clean.team_selections=data.team_selections.map(selection=>{
        const result=clean.results.find(row=>row.id===selection.result_id);
        const key=selection.shooter_id+':'+selection.discipline_id;
        if(selectionKeys.has(key)||!assignedShooters.has(selection.shooter_id)||!result||result.shooter_id!==selection.shooter_id||result.discipline_id!==selection.discipline_id) fail('Auswahl für die Mannschaftswertung ist ungültig');
        selectionKeys.add(key);
        return {shooter_id:selection.shooter_id,discipline_id:selection.discipline_id,result_id:selection.result_id};
      });
      const validateTeamPlacements=(rows,historical)=>rows.map(row=>{
        if(!teamIds.has(row.team_id)||!clean.disciplines.some(d=>d.id===row.discipline_id)||!Number.isSafeInteger(row.rank)||row.rank<1||!Number.isFinite(row.total_points)||!Array.isArray(row.entries)) fail('Mannschaftsplatzierung ist ungültig');
        if(historical && (!Number.isSafeInteger(row.revision)||row.revision<1||row.revision>clean.event.revision)) fail('Historische Mannschaftsplatzierung ist ungültig');
        const entries=row.entries.map(entry=>{
          if(!clean.shooters.some(s=>s.id===entry.shooter_id)||!Number.isFinite(entry.points)||typeof entry.counted!=='boolean') fail('Gewertetes Mannschaftsergebnis ist ungültig');
          return {result_id:entry.result_id,shooter_id:entry.shooter_id,name:String(entry.name||''),start_number:entry.start_number,round_number:entry.round_number,points:entry.points,counted:entry.counted};
        });
        const requiredCount=Number.isSafeInteger(row.required_count) && row.required_count>0 ? row.required_count : teamCountedResults;
        const counted=entries.filter(entry=>entry.counted);
        if(counted.length>requiredCount || counted.reduce((sum,entry)=>sum+entry.points,0)!==row.total_points) fail('Mannschaftspunktzahl widerspricht den gewerteten Ergebnissen');
        return {...(historical ? {revision:row.revision} : {}),team_id:row.team_id,discipline_id:row.discipline_id,rank:row.rank,total_points:row.total_points,
          entries,member_count:Number.isSafeInteger(row.member_count)?row.member_count:entries.length,required_count:requiredCount};
      });
      clean.team_placements=validateTeamPlacements(data.team_placements,false);
      clean.team_placement_history=validateTeamPlacements(data.team_placement_history,true);
      if(clean.event.status==='closed') {
        const current=clean.team_placement_history.filter(row=>row.revision===clean.event.revision);
        if(JSON.stringify(clean.team_placements)!==JSON.stringify(current.map(({revision,...row})=>row))) fail('Letzte Mannschaftswertung widerspricht der Versionshistorie');
      } else if(clean.team_placements.length) fail('Eine noch nicht abgeschlossene Veranstaltung darf keine Mannschaftsplatzierung enthalten');
    } else {
      clean.teams=[];clean.team_selections=[];clean.team_placements=[];clean.team_placement_history=[];
    }
  }
  return clean;
}
function fingerprint(a) {return createHash('sha256').update(JSON.stringify(a)).digest('hex');}
function preview(data) {
  const a=validateSeasonArchive(data), hash=fingerprint(a);
  const existing=get('SELECT event_id FROM imports WHERE fingerprint=?',[hash]);
  if(existing || (a.event && get('SELECT id FROM events WHERE uuid=?',[a.event.uuid]))) fail('Diese Veranstaltung wurde bereits importiert oder ist bereits vorhanden',409);
  const privacy=require('./privacy');
  return {fingerprint:hash,year:a.event?.year || null,title:a.event_title,
    shooters:a.shooters.map(s=>{
      if(s.uuid && privacy.erased(s.uuid)) fail('Archiv enthält eine bereits gelöschte Person. Bitte bereinigtes Archiv verwenden.');
      const existing=s.uuid ? get('SELECT id,uuid FROM shooters WHERE uuid=? UNION SELECT s.id,s.uuid FROM shooters s JOIN person_aliases a ON a.shooter_id=s.id WHERE a.uuid=?',[s.uuid,s.uuid]) : null;
      if(existing && privacy.erased(existing.uuid)) fail('Archiv enthält eine bereits gelöschte Person. Bitte bereinigtes Archiv verwenden.');
      return {...s,existing_id:existing?.id || null,
        candidates:all('SELECT id,name,gender FROM shooters WHERE name=? COLLATE NOCASE AND archived_at IS NULL',[s.name])};
    })};
}
function restoreSeasonArchive(data,{year,mapping={},fingerprint:expected}={}) {
  const a=validateSeasonArchive(data), p=preview(data);
  if(expected!==p.fingerprint) fail('Bitte zuerst die Importvorschau prüfen');
  const y=Number(year || a.event?.year);
  if(!Number.isInteger(y)||y<1900||y>2200) fail('Veranstaltungsjahr muss ausdrücklich angegeben werden');
  const selected=new Set();
  for(const s of p.shooters) {
    if(!Object.hasOwn(mapping,String(s.id))) fail('Bitte jeden Schützen zuordnen oder ausdrücklich neu anlegen');
    const id=mapping[s.id];
    if(id!==null) {
      if(!Number.isSafeInteger(id)) fail('Ungültige Personenzuordnung');
      const person=People.get(id);
      if(require('./privacy').erased(person.uuid)) fail('Gelöschte Person darf nicht wiederhergestellt werden');
      if(selected.has(id)) fail('Zwei Teilnehmer dürfen nicht derselben Person zugeordnet werden');selected.add(id);
    }
    if(s.existing_id && id!==s.existing_id) fail('Die dauerhafte Personen-ID ist bereits zugeordnet');
  }
  const backup=require('./backups').create('vor-eventimport');
  const eventId=transaction(()=>{
    const preserveHistory=a.archive_version>=3 && ['closed','correction'].includes(a.event?.status);
    const id=Number(run("INSERT INTO events(uuid,title,year,status,reconstructed,scoring_mode,team_max_members,team_counted_results) VALUES (?,?,?,'correction',?,?,?,?)",
      [a.event?.uuid||randomUUID(),a.event_title,y,preserveHistory&&a.event.status==='closed' ? a.event.reconstructed : 1,a.event?.scoring_mode||'individual',a.event?.team_max_members||5,a.event?.team_counted_results||3]).lastInsertRowid);
    const participants=new Map(),people=new Map(),disciplines=new Map(),results=new Map(),teams=new Map();
    for(const s of a.shooters) {
      let personId=mapping[s.id];
      if(personId===null) personId=Number(run('INSERT INTO shooters(uuid,name,gender) VALUES (?,?,?)',[s.uuid||randomUUID(),s.name,s.gender]).lastInsertRowid);
      if(s.uuid && People.get(personId).uuid!==s.uuid) run('INSERT INTO person_aliases(uuid,shooter_id) VALUES (?,?) ON CONFLICT(uuid) DO NOTHING',[s.uuid,personId]);
      people.set(s.id,personId);
      participants.set(s.id,Number(run('INSERT INTO participants(event_id,shooter_id,start_number,name,gender,created_at) VALUES (?,?,?,?,?,?)',[id,personId,s.start_number,s.name,s.gender,s.created_at]).lastInsertRowid));
    }
    for(const d of a.disciplines) disciplines.set(d.id,Number(run('INSERT INTO disciplines(event_id,name,ranking_mode,sort_order,created_at) VALUES (?,?,?,?,?)',[id,d.name,d.ranking_mode,d.sort_order,d.created_at]).lastInsertRowid));
    for(const r of a.results) results.set(r.id,Number(run('INSERT INTO results(event_id,participant_id,discipline_id,round_number,points,created_at) VALUES (?,?,?,?,?,?)',[id,participants.get(r.shooter_id),disciplines.get(r.discipline_id),r.round_number,r.points,r.created_at]).lastInsertRowid));
    for(const team of a.teams || []) {
      const teamId=Number(run('INSERT INTO teams(event_id,name,created_at) VALUES (?,?,?)',[id,team.name,team.created_at]).lastInsertRowid);
      teams.set(team.id,teamId);
      for(const shooterId of team.members) run('INSERT INTO team_memberships(event_id,team_id,participant_id) VALUES (?,?,?)',[id,teamId,participants.get(shooterId)]);
    }
    for(const selection of a.team_selections || []) run('INSERT INTO team_result_selections(event_id,participant_id,discipline_id,result_id) VALUES (?,?,?,?)',
      [id,participants.get(selection.shooter_id),disciplines.get(selection.discipline_id),results.get(selection.result_id)]);
    const teamSnapshot=row=>JSON.stringify({entries:row.entries.map(entry=>({...entry,result_id:results.get(entry.result_id),shooter_id:people.get(entry.shooter_id),participant_id:participants.get(entry.shooter_id)})),member_count:row.member_count,required_count:row.required_count});
    if(preserveHistory) {
      for(const row of a.placement_history) run('INSERT INTO placements(event_id,revision,participant_id,discipline_id,rank,best_points,rounds) VALUES (?,?,?,?,?,?,?)',[id,row.revision,participants.get(row.shooter_id),disciplines.get(row.discipline_id),row.rank,row.best_points,JSON.stringify(row.all_rounds)]);
      for(const row of a.team_placement_history || []) run('INSERT INTO team_placements(event_id,revision,team_id,discipline_id,rank,total_points,counted_results) VALUES (?,?,?,?,?,?,?)',
        [id,row.revision,teams.get(row.team_id),disciplines.get(row.discipline_id),row.rank,row.total_points,teamSnapshot(row)]);
      for(const closure of a.closures) run('INSERT INTO closures(event_id,revision,reason,created_at) VALUES (?,?,?,?)',[id,closure.revision,closure.reason,closure.created_at]);
      run('UPDATE events SET revision=? WHERE id=?',[a.event.revision,id]);
      if(a.event.status==='closed') run("UPDATE events SET status='closed',closed_at=datetime('now') WHERE id=?",[id]);
      else Events.close(id,'Aus Archiv rekonstruierter Abschluss des Korrekturstands');
    } else if(a.event?.status==='closed') {
      for(const row of a.placements) run('INSERT INTO placements(event_id,revision,participant_id,discipline_id,rank,best_points,rounds) VALUES (?,1,?,?,?,?,?)',[id,participants.get(row.shooter_id),disciplines.get(row.discipline_id),row.rank,row.best_points,JSON.stringify(row.all_rounds)]);
      for(const row of a.team_placements || []) run('INSERT INTO team_placements(event_id,revision,team_id,discipline_id,rank,total_points,counted_results) VALUES (?,1,?,?,?,?,?)',
        [id,teams.get(row.team_id),disciplines.get(row.discipline_id),row.rank,row.total_points,teamSnapshot(row)]);
      run("INSERT INTO closures(event_id,revision,reason) VALUES (?,1,'Aus älterem Archiv rekonstruierte Abschlusswertung')",[id]);
      run("UPDATE events SET revision=1,status='closed',reconstructed=1,closed_at=datetime('now') WHERE id=?",[id]);
    } else Events.close(id,'Aus Archiv rekonstruierte Wertung');
    run('INSERT INTO imports(fingerprint,event_id) VALUES (?,?)',[p.fingerprint,id]);
    return id;
  });
  return {event_id:eventId,event_title:a.event_title,backup,restored:{shooters:a.shooters.length,disciplines:a.disciplines.length,results:a.results.length}};
}
function archiveCurrentSeason(label,eventId=Events.active().id) {
  const data=fullExport(eventId);
  const name=(label||data.event_title||'event').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80)+'-'+data.event.uuid+'-r'+data.event.revision+'.json';
  const target=path.join(ARCHIVE_DIR,name); atomicWrite(target,JSON.stringify(data,null,2));return target;
}
function listArchives() {return fs.readdirSync(ARCHIVE_DIR).filter(f=>f.endsWith('.json')).sort().reverse();}
module.exports={fullExport,validateSeasonArchive,preview,restoreSeasonArchive,archiveCurrentSeason,listArchives};
