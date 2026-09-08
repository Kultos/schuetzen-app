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
    const old=B.create('alt'),past=new Date(Date.now()-3*86400000);
    fs.utimesSync(path.join(process.env.SCHUETZEN_DATA_DIR,'backups',old),past,past);
    fs.utimesSync(path.join(process.env.SCHUETZEN_BACKUP_DIR,old),past,past);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
    const latest=B.create('neu'),timer=B.startTimer();clearInterval(timer);
    console.log(JSON.stringify({old,latest,oldLocal:fs.existsSync(path.join(process.env.SCHUETZEN_DATA_DIR,'backups',old)),oldExternal:fs.existsSync(path.join(process.env.SCHUETZEN_BACKUP_DIR,old)),sidecars:['','.json','.privacy.json'].every(s=>fs.existsSync(path.join(process.env.SCHUETZEN_BACKUP_DIR,latest+s))),journal:fs.existsSync(path.join(process.env.SCHUETZEN_BACKUP_DIR,'privacy-journal.json')),version:B.bundle(latest).version}));
    require('./db').db.close();`;
  try {
    const env={...process.env,SCHUETZEN_DATA_DIR:data,SCHUETZEN_BACKUP_DIR:external,SCHUETZEN_BACKUP_RETENTION_DAYS:'1'};
    const result=spawnSync(process.execPath,['-e',code],{cwd:path.join(__dirname,'..'),env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);const state=JSON.parse(result.stdout);
    assert.deepEqual({...state,old:undefined,latest:undefined},{old:undefined,latest:undefined,oldLocal:false,oldExternal:false,sidecars:true,journal:true,version:3});
    const output=path.join(root,'portable.json');
    const packed=spawnSync(process.execPath,['backup-tool.js','pack',path.join(external,state.latest),output],{cwd:path.join(__dirname,'..'),encoding:'utf8'});
    assert.equal(packed.status,0,packed.stderr);
    const bundle=JSON.parse(fs.readFileSync(output,'utf8'));
    assert.equal(bundle.version,3);
    assert.equal(bundle.manifest.privacy_sha256,createHash('sha256').update(JSON.stringify(bundle.privacy_journal)).digest('hex'));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
