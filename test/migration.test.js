'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');

test('Migration erhält Bestandsdaten, erstellt ein lesbares Vorabbackup und läuft nur einmal',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'schuetzen-migration-'));
  const file=path.join(dir,'wettkampf.db');
  const seed=new DatabaseSync(file);
  seed.exec(`
    CREATE TABLE shooters(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,gender TEXT NOT NULL,created_at TEXT NOT NULL,start_number INTEGER);
    CREATE TABLE disciplines(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,sort_order INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE results(id INTEGER PRIMARY KEY AUTOINCREMENT,shooter_id INTEGER REFERENCES shooters(id),discipline_id INTEGER REFERENCES disciplines(id),round_number INTEGER,points REAL,created_at TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO shooters VALUES(7,'Bestand','w','2026-08-30',42);
    INSERT INTO disciplines VALUES(4,'Gewehr',1,'2026-08-30');
    INSERT INTO results VALUES(11,7,4,1,98.5,'2026-08-30');
    INSERT INTO settings VALUES('event_title','Bestehendes Event');
  `);
  seed.close();
  const code="const D=require('./db'); const e=D.fullExport(); console.log(JSON.stringify(e)); D.db.close();";
  try {
    const opts={cwd:path.join(__dirname,'..'),env:{...process.env,SCHUETZEN_DATA_DIR:dir},encoding:'utf8'};
    const first=spawnSync(process.execPath,['-e',code],opts);
    assert.equal(first.status,0,first.stderr);
    const exported=JSON.parse(first.stdout);
    assert.equal(exported.event_title,'Bestehendes Event');
    assert.equal(exported.shooters[0].id,7);assert.equal(exported.shooters[0].start_number,42);
    assert.equal(exported.results[0].id,11);assert.equal(exported.results[0].points,98.5);
    assert.equal(exported.event.year,null,'Jahr darf nicht aus Datei- oder Exportdatum geraten werden');
    const names=fs.readdirSync(path.join(dir,'backups')).filter(n=>n.endsWith('.sqlite'));
    assert.equal(names.length,1);
    const backup=new DatabaseSync(path.join(dir,'backups',names[0]),{readOnly:true});
    assert.equal(backup.prepare('SELECT start_number FROM shooters').get().start_number,42);backup.close();
    const second=spawnSync(process.execPath,['-e',code],opts);assert.equal(second.status,0,second.stderr);
    assert.equal(JSON.parse(second.stdout).shooters[0].uuid,exported.shooters[0].uuid);
    assert.equal(fs.readdirSync(path.join(dir,'backups')).filter(n=>n.endsWith('.sqlite')).length,1);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('Fehlgeschlagene Migration lässt das alte Schema und alle Datensätze intakt',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'schuetzen-migration-error-'));
  const file=path.join(dir,'wettkampf.db'),seed=new DatabaseSync(file);
  seed.exec(`CREATE TABLE shooters(id INTEGER PRIMARY KEY,name TEXT,gender TEXT,created_at TEXT,start_number INTEGER);
    CREATE TABLE disciplines(id INTEGER PRIMARY KEY,name TEXT,sort_order INTEGER,created_at TEXT);
    CREATE TABLE results(id INTEGER PRIMARY KEY,shooter_id INTEGER,discipline_id INTEGER,round_number INTEGER,points REAL,created_at TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO shooters VALUES(1,'Unverändert','invalid','2026-01-01',1);`);
  seed.close();
  try {
    const result=spawnSync(process.execPath,['-e',"require('./db')"],{cwd:path.join(__dirname,'..'),env:{...process.env,SCHUETZEN_DATA_DIR:dir},encoding:'utf8'});
    assert.notEqual(result.status,0);
    const check=new DatabaseSync(file,{readOnly:true});
    assert.equal(check.prepare('PRAGMA user_version').get().user_version,0);
    assert.equal(check.prepare('SELECT name FROM shooters').get().name,'Unverändert');
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='events'").get().n,0);
    check.close();
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('Schema 2 wird mit Platzierungsbeziehungen, UUID-Aliasen und gemeinsamer Wertung auf Schema 4 aktualisiert',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'schuetzen-v2-'));
  const file=path.join(dir,'wettkampf.db'),seed=new DatabaseSync(file);
  seed.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE shooters(id INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT UNIQUE,name TEXT,gender TEXT,archived_at TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT UNIQUE,title TEXT,year INTEGER,status TEXT,revision INTEGER,ranking_version TEXT,reconstructed INTEGER,correction_reason TEXT,created_at TEXT,closed_at TEXT);
    CREATE TABLE participants(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id INTEGER REFERENCES events(id),shooter_id INTEGER REFERENCES shooters(id),start_number INTEGER,name TEXT,gender TEXT,created_at TEXT,UNIQUE(id,event_id));
    CREATE TABLE disciplines(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id INTEGER REFERENCES events(id),name TEXT,sort_order INTEGER,created_at TEXT,UNIQUE(id,event_id));
    CREATE TABLE results(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id INTEGER,participant_id INTEGER,discipline_id INTEGER,round_number INTEGER,points REAL,created_at TEXT);
    CREATE TABLE placements(event_id INTEGER REFERENCES events(id),revision INTEGER,participant_id INTEGER REFERENCES participants(id),discipline_id INTEGER REFERENCES disciplines(id),rank INTEGER,best_points REAL,rounds TEXT,PRIMARY KEY(event_id,revision,participant_id,discipline_id));
    CREATE TABLE closures(event_id INTEGER,revision INTEGER,reason TEXT,created_at TEXT);
    CREATE TABLE contacts(shooter_id INTEGER PRIMARY KEY,email TEXT,consent_at TEXT,consent_text TEXT,evidence TEXT,status TEXT,updated_at TEXT);
    CREATE TABLE consent_log(id INTEGER PRIMARY KEY AUTOINCREMENT,shooter_id INTEGER,action TEXT,details TEXT,created_at TEXT);
    CREATE TABLE imports(fingerprint TEXT PRIMARY KEY,event_id INTEGER);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO shooters VALUES(1,'10000000-0000-4000-8000-000000000001','Alt','m',NULL,'2026','2026');
    INSERT INTO events VALUES(1,'20000000-0000-4000-8000-000000000001','Alt',2026,'active',0,'series-name-v1',0,NULL,'2026',NULL);
    INSERT INTO participants VALUES(1,1,1,3,'Alt','m','2026');
    INSERT INTO disciplines VALUES(1,1,'Gewehr',1,'2026');
    PRAGMA user_version=2;
  `);seed.close();
  try {
    const code="const S=require('./storage'); console.log(JSON.stringify({version:S.get('PRAGMA user_version').user_version,aliases:S.get(\"SELECT COUNT(*) AS n FROM sqlite_master WHERE name='person_aliases'\").n,fks:S.all('PRAGMA foreign_key_list(placements)').length}));S.db.close();";
    const result=spawnSync(process.execPath,['-e',code],{cwd:path.join(__dirname,'..'),env:{...process.env,SCHUETZEN_DATA_DIR:dir},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),{version:4,aliases:1,fks:5});
    assert.equal(fs.readdirSync(path.join(dir,'backups')).filter(n=>n.endsWith('.sqlite')).length,1);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('Schema 3 erhält beim Update die gemeinsame Wertung als sicheren Standard',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'schuetzen-v3-'));
  const file=path.join(dir,'wettkampf.db'),seed=new DatabaseSync(file);
  seed.exec(`CREATE TABLE disciplines(id INTEGER PRIMARY KEY,event_id INTEGER,name TEXT,sort_order INTEGER,created_at TEXT);
    INSERT INTO disciplines VALUES(1,1,'Gewehr',1,'2026'); PRAGMA user_version=3;`);
  seed.close();
  try {
    const code="const S=require('./storage'); console.log(JSON.stringify({version:S.get('PRAGMA user_version').user_version,mode:S.get('SELECT ranking_mode FROM disciplines').ranking_mode}));S.db.close();";
    const result=spawnSync(process.execPath,['-e',code],{cwd:path.join(__dirname,'..'),env:{...process.env,SCHUETZEN_DATA_DIR:dir},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),{version:4,mode:'combined'});
    assert.equal(fs.readdirSync(path.join(dir,'backups')).filter(n=>n.endsWith('.sqlite')).length,1);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
