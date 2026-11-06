'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');

test('Externes Backup, Rotation und Offline-Verpackung behalten alle geprüften Begleitdaten',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'schuetzen-backup-process-'));
  const data=path.join(root,'data'),external=path.join(root,'external');fs.mkdirSync(external);
  const code=`
    const fs=require('node:fs'),path=require('node:path'),B=require('./backups');
    const {Events,db}=require('./db');
    const initial=B.create('alt'),past=new Date(Date.now()-3*86400000);
    const old=past.toISOString().replace(/[:.]/g,'-')+'-alt-'+require('node:crypto').randomUUID()+'.sqlite';
    for(const directory of [path.join(process.env.SCHUETZEN_DATA_DIR,'backups'),process.env.SCHUETZEN_BACKUP_DIR]) {
      for(const suffix of ['', '.json', '.privacy.json']) fs.renameSync(path.join(directory,initial+suffix),path.join(directory,old+suffix));
      const manifestFile=path.join(directory,old+'.json'),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
      fs.writeFileSync(manifestFile,JSON.stringify({...manifest,name:old,created_at:past.toISOString()}));
      fs.utimesSync(path.join(directory,old),past,past);
    }
    require('node:assert/strict').equal(B.bundle(old).manifest.name,old);
    Events.metadata(Events.active().id,{title:'Vereinscup',year:2031});
    const timer=B.startTimer();clearInterval(timer);
    const latest=B.status().last_local;
    console.log(JSON.stringify({old,latest,oldLocal:fs.existsSync(path.join(process.env.SCHUETZEN_DATA_DIR,'backups',old)),oldExternal:fs.existsSync(path.join(process.env.SCHUETZEN_BACKUP_DIR,old)),sidecars:['','.json','.privacy.json'].every(s=>fs.existsSync(path.join(process.env.SCHUETZEN_BACKUP_DIR,latest+s))),journal:fs.existsSync(path.join(process.env.SCHUETZEN_BACKUP_DIR,'privacy-journal.json')),version:B.bundle(latest).version}));
    db.close();`;
  try {
    const env={...process.env,SCHUETZEN_DATA_DIR:data,SCHUETZEN_BACKUP_DIR:external,SCHUETZEN_BACKUP_RETENTION_DAYS:'1'};
    const result=spawnSync(process.execPath,['-e',code],{cwd:path.join(__dirname,'..'),env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);const state=JSON.parse(result.stdout);
    assert.deepEqual({...state,old:undefined,latest:undefined},{old:undefined,latest:undefined,oldLocal:false,oldExternal:false,sidecars:true,journal:true,version:3});
    assert.match(state.latest,/-Vereinscup-2031--automatisch-/);
    const output=path.join(root,'portable.json');
    const packed=spawnSync(process.execPath,['backup-tool.js','pack',path.join(external,state.latest),output],{cwd:path.join(__dirname,'..'),encoding:'utf8'});
    assert.equal(packed.status,0,packed.stderr);
    const bundle=JSON.parse(fs.readFileSync(output,'utf8'));
    assert.equal(bundle.version,3);
    assert.equal(bundle.manifest.privacy_sha256,createHash('sha256').update(JSON.stringify(bundle.privacy_journal)).digest('hex'));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
