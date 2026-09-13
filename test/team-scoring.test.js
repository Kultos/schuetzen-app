'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schuetzen-team-test-'));
process.env.SCHUETZEN_DATA_DIR = testDataDir;

const {
  db,
  Events,
  Shooters,
  Disciplines,
  Teams,
  Results,
  teamRankingForDiscipline,
  dashboardSnapshot,
  fullExport,
  validateSeasonArchive,
  restoreSeasonArchive,
} = require('../db');

after(() => {
  db.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test('Mannschaften werten ausdrücklich gewählte Durchgänge, begrenzen Mitglieder und teilen exakte Ränge', () => {
  const event = Events.active();
  Events.metadata(event.id, { title: 'Jedermannschießen 2026', year: 2026 });
  Events.teamSettings(event.id, { scoring_mode: 'both', team_max_members: 5, team_counted_results: 3 });
  const discipline = Disciplines.create({ name: 'Luftgewehr' });
  const teams = ['Adlerauge', 'Volltreffer', 'Ringjäger', 'Kleines Team'].map(name => Teams.create({ name }));
  const points = [[100,90,80,70],[95,90,85],[100,90,80],[70,60]];
  const shooters=[];
  points.forEach((teamPoints,teamIndex) => teamPoints.forEach((score,index) => {
    const shooter=Shooters.create({name:`T${teamIndex+1} Schütze ${index+1}`,gender:index%2?'w':'m'});
    shooters.push(shooter);
    Teams.assign(teams[teamIndex].id,shooter.id);
    const result=Results.create({shooter_id:shooter.id,discipline_id:discipline.id,round_number:1,points:score});
    Results.selectForTeam(result.id);
  }));

  const extra=Shooters.create({name:'Fünfter Adler',gender:'m'});
  Teams.assign(teams[0].id,extra.id);
  const sixth=Shooters.create({name:'Sechster Adler',gender:'m'});
  assert.throws(()=>Teams.assign(teams[0].id,sixth.id),/bereits 5 Mitglieder/);

  const low=Results.create({shooter_id:shooters[0].id,discipline_id:discipline.id,round_number:2,points:1});
  Results.selectForTeam(low.id);
  assert.equal(Results.listForShooterDiscipline(shooters[0].id,discipline.id).find(row=>row.id===low.id).team_selected,1);
  Results.selectForTeam(Results.listForShooterDiscipline(shooters[0].id,discipline.id).find(row=>row.round_number===1).id);

  const ranking=teamRankingForDiscipline(discipline.id);
  assert.deepEqual(ranking.map(row=>[row.name,row.rank,row.total_points,row.counted_count]),[
    ['Adlerauge',1,270,3],
    ['Ringjäger',1,270,3],
    ['Volltreffer',3,270,3],
    ['Kleines Team',4,130,2],
  ]);
  assert.equal(ranking[0].entries.find(entry=>entry.points===70).counted,false);
  const dashboard=dashboardSnapshot();
  assert.equal(dashboard.scoring_mode,'both');
  assert.deepEqual(dashboard.disciplines[0].team_ranking.map(row=>row.rank),[1,1,3,4]);

  Teams.assign(teams[2].id,shooters[0].id);
  assert.equal(Teams.list().find(team=>team.id===teams[0].id).member_count,4);
  assert.equal(Teams.list().find(team=>team.id===teams[2].id).member_count,4);

  Events.close(event.id);
  const archive=fullExport(event.id);
  assert.equal(archive.version,5);
  assert.equal(archive.teams.length,4);
  assert.equal(archive.team_placement_history.length,4);
  assert.doesNotThrow(()=>validateSeasonArchive(archive));
  assert.deepEqual(teamRankingForDiscipline(discipline.id).map(row=>row.rank),[1,2,3,4]);

  archive.event.uuid='90000000-0000-4000-8000-000000000001';
  const preview=require('../archives').preview(archive);
  const mapping=Object.fromEntries(archive.shooters.map(shooter=>[shooter.id,shooter.id]));
  const restored=restoreSeasonArchive(archive,{year:2026,mapping,fingerprint:preview.fingerprint});
  const imported=fullExport(restored.event_id);
  assert.deepEqual(imported.teams.map(team=>team.name),archive.teams.map(team=>team.name));
  assert.equal(imported.team_selections.length,archive.team_selections.length);
  assert.equal(imported.team_placement_history.length,archive.team_placement_history.length);

  require('../privacy').Contacts.erase(shooters[0].id);
  const erased=fullExport(event.id).team_placement_history.flatMap(row=>row.entries).filter(entry=>entry.shooter_id===shooters[0].id);
  assert.ok(erased.length>0);
  assert.ok(erased.every(entry=>entry.name==='Gelöschter Teilnehmer'));
});
