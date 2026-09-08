'use strict';
// Offline packaging only: never opens the live application database.
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const [command,input,output]=process.argv.slice(2);
if(command!=='pack'||!input||!output) {
  console.error('Aufruf: node backup-tool.js pack BACKUP.sqlite AUSGABE.json');process.exitCode=1;
} else {
  const file=path.resolve(input),target=path.resolve(output);
  const database=fs.readFileSync(file),manifest=JSON.parse(fs.readFileSync(file+'.json','utf8'));
  if(createHash('sha256').update(database).digest('hex')!==manifest.sha256) throw new Error('Backup-Prüfsumme stimmt nicht');
  const privacyFile=file+'.privacy.json',privacy=fs.existsSync(privacyFile)?JSON.parse(fs.readFileSync(privacyFile,'utf8')):undefined;
  if(manifest.privacy_sha256 && !privacy) throw new Error('Datenschutzprotokoll zum Backup fehlt');
  if(privacy) manifest.privacy_sha256=createHash('sha256').update(JSON.stringify(privacy)).digest('hex');
  fs.writeFileSync(target,JSON.stringify({format:'schuetzen-system-backup',version:privacy?3:1,manifest,database:database.toString('base64'),privacy_journal:privacy}),{flag:'wx',flush:true,mode:0o600});
  console.log('Portables Backup erstellt: '+target);
}
