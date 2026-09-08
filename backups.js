'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {createHash,randomUUID}=require('node:crypto');
const S=require('./storage');
const {db,all,get,run,transaction,snapshot,checkDatabase,atomicWrite,setting,setSetting,BACKUP_DIR}=S;
const TABLES=['shooters','events','participants','disciplines','results','placements','closures','contacts','consent_log','imports','person_aliases','settings'];
function invalid(message) {const error=new Error(message);error.status=400;throw error;}
let lastError=null,externalAt=null;
const external=process.env.SCHUETZEN_BACKUP_DIR ? path.resolve(process.env.SCHUETZEN_BACKUP_DIR) : null;
function safeFile(name) {
  if(typeof name!=='string' || path.basename(name)!==name || !/^[a-zA-Z0-9_.-]+\.sqlite$/.test(name)) invalid('Ungültiger Backupname');
  return path.join(BACKUP_DIR,name);
}
function create(label='manuell') {
  const name=snapshot(label);
  const localFile=safeFile(name),privacy=require('./privacy');
  const journal=privacy.journal(),journalContent=JSON.stringify(journal);
  atomicWrite(localFile+'.privacy.json',journalContent);
  const manifest=JSON.parse(fs.readFileSync(localFile+'.json','utf8'));
  manifest.privacy_sha256=createHash('sha256').update(journalContent).digest('hex');
  atomicWrite(localFile+'.json',JSON.stringify(manifest));
  lastError=null;
  try {
    if(external) {
      if(!fs.existsSync(external)) throw new Error('Externes Sicherungsziel ist nicht erreichbar');
      for(const suffix of ['', '.json','.privacy.json']) atomicWrite(path.join(external,name+suffix),fs.readFileSync(localFile+suffix));
      atomicWrite(path.join(external,'privacy-journal.json'),JSON.stringify(privacy.journal()));
      externalAt=new Date().toISOString();
    }
  } catch { lastError='Lokales Backup erfolgreich; externe Sicherung fehlgeschlagen.'; }
  return name;
}
function list() {
  return fs.readdirSync(BACKUP_DIR).filter(n=>n.endsWith('.sqlite') && fs.existsSync(path.join(BACKUP_DIR,n+'.json'))).sort().reverse();
}
function status() { return {files:list(),last_local:list()[0] || null,last_external:externalAt,external_configured:!!external,error:lastError,privacy_review:setting('privacy_review')==='1'}; }
function bundle(name) {
  const file=safeFile(name);
  const privacyFile=file+'.privacy.json';
  const manifest=JSON.parse(fs.readFileSync(file+'.json','utf8'));
  if(manifest.privacy_sha256 && !fs.existsSync(privacyFile)) invalid('Datenschutzprotokoll zum Backup fehlt');
  return {format:'schuetzen-system-backup',version:fs.existsSync(privacyFile)?(manifest.privacy_sha256?3:2):1,manifest,database:fs.readFileSync(file).toString('base64'),privacy_journal:fs.existsSync(privacyFile)?JSON.parse(fs.readFileSync(privacyFile,'utf8')):undefined};
}
function inspect(bundleData, consume) {
  if(!bundleData || bundleData.format!=='schuetzen-system-backup' || ![1,2,3].includes(bundleData.version) || typeof bundleData.database!=='string') invalid('Kein gültiges Systembackup');
  if(bundleData.version>=2) {
    let journal;
    try { journal=require('./privacy').validateJournal(bundleData.privacy_journal); }
    catch { invalid('Datenschutzprotokoll im Backup ist beschädigt'); }
    if(bundleData.version===3 && createHash('sha256').update(JSON.stringify(journal)).digest('hex')!==bundleData.manifest?.privacy_sha256) invalid('Datenschutzprotokoll-Prüfsumme stimmt nicht');
  }
  const bytes=Buffer.from(bundleData.database,'base64');
  if(bytes.length>100*1024*1024 || createHash('sha256').update(bytes).digest('hex')!==bundleData.manifest?.sha256) invalid('Backup-Prüfsumme stimmt nicht');
  const temp=path.join(BACKUP_DIR,randomUUID()+'.restore-tmp');
  fs.writeFileSync(temp,bytes,{flag:'wx'});
  let source;
  try {
    source=new DatabaseSync(temp,{readOnly:true}); source.exec('PRAGMA trusted_schema=OFF');
    try { checkDatabase(source); } catch { invalid('Backup-Datenbank ist beschädigt'); }
    if(source.prepare('PRAGMA user_version').get().user_version!==S.CURRENT_SCHEMA_VERSION) invalid('Backup benötigt eine andere App-Version');
    const tables=source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
    const expectedTables=all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);
    if(JSON.stringify(tables)!==JSON.stringify(expectedTables) || source.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('trigger','view')").get().n) invalid('Backup-Schema weicht ab');
    for(const table of TABLES) {
      const columns=connectionColumns(source,table), expected=connectionColumns(db,table);
      if(JSON.stringify(columns)!==JSON.stringify(expected)) invalid('Backup-Schema weicht ab');
    }
    if(source.prepare("SELECT COUNT(*) AS n FROM events WHERE status='active'").get().n!==1) invalid('Backup hat kein eindeutiges aktives Event');
    const summary={events:source.prepare('SELECT COUNT(*) AS n FROM events').get().n,shooters:source.prepare('SELECT COUNT(*) AS n FROM shooters').get().n,results:source.prepare('SELECT COUNT(*) AS n FROM results').get().n};
    return consume ? consume(source,summary) : summary;
  } finally { if(source) source.close(); fs.unlinkSync(temp); }
}
function connectionColumns(connection,table) {
  return connection.prepare('PRAGMA table_info('+table+')').all().map(({name,type,notnull,pk})=>({name,type,notnull,pk}));
}
function restore(bundleData) {
  return inspect(bundleData,(source,summary)=>{
    const privacy=require('./privacy'),currentJournal=privacy.journal();
    const backup=create('vor-restore');
    // Copy validated rows in ONE transaction. SQLite commits/recovery handle power
    // failures; the open Windows database file never needs to be renamed.
    transaction(()=>{
      for(const table of [...TABLES].reverse()) run('DELETE FROM '+table);
      for(const table of TABLES) {
        const columns=source.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);
        const insert=db.prepare('INSERT INTO '+table+' ('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')');
        for(const row of source.prepare('SELECT * FROM '+table).all()) insert.run(...columns.map(c=>row[c]));
      }
      privacy.replayEntries(currentJournal.entries);
      if(bundleData.privacy_journal) privacy.replayEntries(bundleData.privacy_journal.entries);
      // A backup cannot prove absence of later withdrawals on another machine.
      run("UPDATE contacts SET status='review'");
      setSetting('privacy_review','1');
      privacy.checkpointJournal(currentJournal);
      checkDatabase(db);
    });
    const warnings=[];
    if(bundleData.privacy_journal) {
      try {privacy.mergeJournal(bundleData.privacy_journal);}
      catch {warnings.push('Daten wiederhergestellt; Datenschutzprotokoll konnte nicht zusammengeführt werden. Prüfung gesperrt lassen und Protokoll separat sichern.');}
    } else warnings.push('Älteres Backup ohne eingebettetes Datenschutzprotokoll. Löschungen anhand der Vereinsunterlagen vollständig abgleichen.');
    if(bundleData.version===2) warnings.push('Älteres Backup mit noch nicht separat geprüfter Journal-Prüfsumme. Datenschutzprotokoll anhand der Vereinsunterlagen abgleichen.');
    return {ok:true,backup,summary,privacy_review:true,warnings};
  });
}
function reviewed(note) {
  if(typeof note!=='string' || note.trim().length<15 || note.length>2000) invalid('Bitte Datenschutzabgleich nachvollziehbar dokumentieren');
  setSetting('privacy_review_note',note.trim()); setSetting('privacy_review','0');
  // Contacts stay in review until a fresh documented consent is entered per person.
}
function pruneDirectory(directory) {
  const days=Number(process.env.SCHUETZEN_BACKUP_RETENTION_DAYS || 30);
  if(!Number.isInteger(days) || days<1) return;
  const names=fs.readdirSync(directory).filter(n=>/^\d{4}-\d{2}-\d{2}T[a-zA-Z0-9_.-]+\.sqlite$/.test(n) && fs.existsSync(path.join(directory,n+'.json'))).sort().reverse();
  for(const name of names.slice(1)) {
    const file=path.join(directory,name);
    const metadata=JSON.parse(fs.readFileSync(file+'.json','utf8'));
    if(metadata.name!==name || !/^[a-f0-9]{64}$/.test(metadata.sha256)) continue;
    if(Date.now()-fs.statSync(file).mtimeMs > days*86400000) {
      fs.unlinkSync(file);fs.unlinkSync(file+'.json');
      if(fs.existsSync(file+'.privacy.json'))fs.unlinkSync(file+'.privacy.json');
    }
  }
}
function prune() {pruneDirectory(BACKUP_DIR);if(external && fs.existsSync(external))pruneDirectory(external);}
function startTimer() {
  let previous=-1;
  const tick=()=>{
    try {
      const total=get('SELECT total_changes() AS n').n;
      if(total!==previous || lastError) {create('automatisch');previous=total;prune();}
    } catch {lastError='Automatische Sicherung fehlgeschlagen. Bitte Sicherungsziel und freien Speicher prüfen.';}
  };
  tick(); const timer=setInterval(tick,5*60*1000);timer.unref();return timer;
}
module.exports={create,list,status,bundle,inspect,restore,reviewed,startTimer,prune,safeFile};
