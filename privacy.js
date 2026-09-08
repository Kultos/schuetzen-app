'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID,createHash } = require('node:crypto');
const { all,get,run,transaction,setting,setSetting,atomicWrite,DATA_DIR,ARCHIVE_DIR } = require('./storage');
const JOURNAL = path.join(DATA_DIR,'privacy-journal.json');
const fail = message => { const error=new Error(message); error.status=400; throw error; };
function validateJournal(value) {
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!value || !uuid.test(value.id) || !Array.isArray(value.entries)) throw new Error('Datenschutzprotokoll ist beschädigt');
  const seen=new Set(),entries=value.entries.map(entry=>{
    if(!entry || !uuid.test(entry.uuid) || !['revoke','erase','purge-consent'].includes(entry.action) || typeof entry.at!=='string' || !Number.isFinite(Date.parse(entry.at)) || new Date(entry.at).toISOString()!==entry.at) throw new Error('Datenschutzprotokoll ist beschädigt');
    const clean={uuid:entry.uuid,action:entry.action,at:entry.at},key=`${clean.uuid}|${clean.action}|${clean.at}`;
    if(seen.has(key)) throw new Error('Datenschutzprotokoll enthält doppelte Einträge');
    seen.add(key);return clean;
  });
  return {id:value.id,entries};
}
function journalHash(value,count=value.entries.length) {return createHash('sha256').update(JSON.stringify({id:value.id,entries:value.entries.slice(0,count)})).digest('hex');}
function journal() {
  if (!fs.existsSync(JOURNAL)) {
    if(setting('journal_id')) throw new Error('Datenschutzprotokoll fehlt. Datei privacy-journal.json aus separater Sicherung wiederherstellen.');
    atomicWrite(JOURNAL,JSON.stringify({id:randomUUID(),entries:[]}));
  }
  const j=validateJournal(JSON.parse(fs.readFileSync(JOURNAL,'utf8'))),storedId=setting('journal_id');
  if(storedId && storedId!==j.id) throw new Error('Datenschutzprotokoll gehört nicht zu diesem Datenbestand');
  const storedCount=setting('journal_count');
  if(storedCount!==undefined) {
    const count=Number(storedCount),hash=setting('journal_sha256');
    if(!Number.isSafeInteger(count)||count<0||count>j.entries.length||!hash||journalHash(j,count)!==hash) throw new Error('Datenschutzprotokoll wurde ersetzt oder zurückgesetzt');
  }
  return j;
}
function checkpointJournal(value=journal()) {
  setSetting('journal_id',value.id);setSetting('journal_count',value.entries.length);setSetting('journal_sha256',journalHash(value));
}
function mergeJournal(other) {
  if(!other) return false;
  const incoming=validateJournal(other),current=journal();
  const entries=new Map(current.entries.map(e=>[`${e.uuid}|${e.action}|${e.at}`,e]));
  for(const entry of incoming.entries) entries.set(`${entry.uuid}|${entry.action}|${entry.at}`,entry);
  const merged=validateJournal({id:current.id,entries:[...entries.values()].sort((a,b)=>a.at.localeCompare(b.at))});
  atomicWrite(JOURNAL,JSON.stringify(merged));
  transaction(()=>{replayEntries(merged.entries);checkpointJournal(merged);});
  return true;
}
function append(uuid,action) {
  const j=journal(),latest=j.entries.reduce((value,entry)=>Math.max(value,Date.parse(entry.at)),0);
  const entry={uuid,action,at:new Date(Math.max(Date.now(),latest+1)).toISOString()};
  j.entries.push(entry); atomicWrite(JOURNAL,JSON.stringify(j));
  return entry;
}
function applyEntry(entry) {
  const s=get('SELECT * FROM shooters WHERE uuid=?',[entry.uuid]); if(!s) return;
  if(entry.action==='erase') {
    run('DELETE FROM contacts WHERE shooter_id=?',[s.id]);
    run('DELETE FROM consent_log WHERE shooter_id=?',[s.id]);
    run("UPDATE shooters SET name='Gelöschter Teilnehmer',archived_at=?,updated_at=? WHERE id=?",[entry.at,entry.at,s.id]);
    run("UPDATE participants SET name='Gelöschter Teilnehmer' WHERE shooter_id=?",[s.id]);
  } else if(entry.action==='revoke') {
    run('DELETE FROM contacts WHERE shooter_id=? AND consent_at<=?',[s.id,entry.at]);
  } else run('DELETE FROM consent_log WHERE shooter_id=? AND julianday(created_at)<=julianday(?)',[s.id,entry.at]);
}
function replay() { for(const entry of journal().entries) applyEntry(entry); }
function replayEntries(entries) { for(const entry of entries || []) applyEntry(entry); }
function erased(uuid) { return journal().entries.some(e=>e.uuid===uuid && e.action==='erase'); }
function purgeArchives(s) {
  // Archives are reproducible from event history. Remove managed copies containing
  // erased identities, including legacy files lacking UUIDs. Never touch other paths.
  const historicalNames=new Set([s.name,...all('SELECT DISTINCT name FROM participants WHERE shooter_id=?',[s.id]).map(p=>p.name)]);
  const targets=[];
  for(const file of fs.readdirSync(ARCHIVE_DIR).filter(n=>n.endsWith('.json'))) {
    const target=path.join(ARCHIVE_DIR,file);
    try {
      const a=JSON.parse(fs.readFileSync(target,'utf8'));
      if(a.shooters?.some(p=>p.uuid===s.uuid || (!p.uuid && (p.id===s.id || historicalNames.has(p.name))))) targets.push(target);
    } catch(error) { throw new Error('Archivbereinigung fehlgeschlagen: '+file); }
  }
  for(const target of targets) fs.unlinkSync(target);
}
const Contacts = {
  get(id) {
    const s=get('SELECT id FROM shooters WHERE id=?',[id]); if(!s) fail('Schütze nicht gefunden');
    return {contact:get('SELECT email,consent_at,consent_text,evidence,status FROM contacts WHERE shooter_id=?',[id]) || null,
      log:all('SELECT action,details,created_at FROM consent_log WHERE shooter_id=? ORDER BY id DESC',[id])};
  },
  save(id,data) {
    const s=get('SELECT * FROM shooters WHERE id=?',[id]); if(!s || erased(s.uuid)) fail('Schütze nicht verfügbar');
    const email=String(data.email || '').trim();
    const text=String(data.consent_text || '').trim(), evidence=String(data.evidence || '').trim();
    if(data.consent!==true || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254 || text.length<20 || text.length>3000 || !evidence || evidence.length>500) fail('Gültige E-Mail, ausdrückliche Einwilligung, Einwilligungstext und Nachweis erforderlich');
    const latest=journal().entries.filter(e=>e.uuid===s.uuid).reduce((n,e)=>Math.max(n,Date.parse(e.at)),0);
    const at=new Date(Math.max(Date.now(),latest+1)).toISOString();
    transaction(()=>{
      run(`INSERT INTO contacts(shooter_id,email,consent_at,consent_text,evidence,status) VALUES (?,?,?,?,?,'granted')
        ON CONFLICT(shooter_id) DO UPDATE SET email=excluded.email,consent_at=excluded.consent_at,consent_text=excluded.consent_text,evidence=excluded.evidence,status='granted',updated_at=datetime('now')`,[id,email,at,text,evidence]);
      run('INSERT INTO consent_log(shooter_id,action,details,created_at) VALUES (?,?,?,?)',[id,'granted',JSON.stringify({text,evidence,at,email_sha256:createHash('sha256').update(email.toLocaleLowerCase('en-US')).digest('hex')}),at]);
    });
    return this.get(id);
  },
  revoke(id) {
    const s=get('SELECT * FROM shooters WHERE id=?',[id]); if(!s) fail('Schütze nicht gefunden');
    const entry=append(s.uuid,'revoke');
    transaction(()=>{applyEntry(entry);run('INSERT INTO consent_log(shooter_id,action,details,created_at) VALUES (?,?,?,?)',[id,'revoked',JSON.stringify({at:entry.at}),entry.at]);checkpointJournal();});
  },
  purgeLog(id) {
    const s=get('SELECT id,uuid FROM shooters WHERE id=?',[id]);if(!s) fail('Schütze nicht gefunden');
    if(get('SELECT 1 FROM contacts WHERE shooter_id=?',[id])) fail('Aktive Einwilligung zuerst widerrufen');
    const entry=append(s.uuid,'purge-consent');transaction(()=>{applyEntry(entry);checkpointJournal();});
  },
  erase(id) {
    const s=get('SELECT * FROM shooters WHERE id=?',[id]); if(!s) fail('Schütze nicht gefunden');
    purgeArchives(s);
    const entry=append(s.uuid,'erase');
    transaction(()=>{applyEntry(entry);checkpointJournal();});
  },
  invitations(eventId) {
    if(setting('privacy_review')==='1') fail('Datenschutzprüfung nach Wiederherstellung erforderlich');
    const filter=eventId ?? null;
    const rows=all(`SELECT s.id,s.name,c.email FROM shooters s JOIN contacts c ON c.shooter_id=s.id
      WHERE s.archived_at IS NULL AND c.status='granted'
      AND EXISTS(SELECT 1 FROM participants p WHERE p.shooter_id=s.id AND (? IS NULL OR p.event_id=?))
      ORDER BY s.name COLLATE NOCASE`,[filter,filter]);
    return rows;
  }
};
const initialJournal=journal();
transaction(()=>{replayEntries(initialJournal.entries);checkpointJournal(initialJournal);});
module.exports={Contacts,journal,journalHash,checkpointJournal,replay,replayEntries,erased,validateJournal,mergeJournal,JOURNAL};
