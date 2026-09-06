'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createHash } = require('node:crypto');
const { all,get,run,transaction,setting,setSetting,atomicWrite,DATA_DIR,ARCHIVE_DIR } = require('./storage');
const JOURNAL = path.join(DATA_DIR,'privacy-journal.json');
const fail = message => { const error=new Error(message); error.status=400; throw error; };
function validateJournal(value) {
  if(!value || typeof value.id!=='string' || !Array.isArray(value.entries) || value.entries.some(e=>!e.uuid || !['revoke','erase'].includes(e.action) || !Number.isFinite(Date.parse(e.at)))) throw new Error('Datenschutzprotokoll ist beschädigt');
  return value;
}
function journal() {
  if (!fs.existsSync(JOURNAL)) {
    if(setting('journal_id')) throw new Error('Datenschutzprotokoll fehlt. Datei privacy-journal.json aus separater Sicherung wiederherstellen.');
    atomicWrite(JOURNAL,JSON.stringify({id:randomUUID(),entries:[]}));
  }
  const j=validateJournal(JSON.parse(fs.readFileSync(JOURNAL,'utf8')));
  if(!setting('journal_id')) setSetting('journal_id',j.id);
  return j;
}
function mergeJournal(other) {
  if(!other) return false;
  const incoming=validateJournal(other),current=journal();
  const entries=new Map(current.entries.map(e=>[`${e.uuid}|${e.action}|${e.at}`,e]));
  for(const entry of incoming.entries) entries.set(`${entry.uuid}|${entry.action}|${entry.at}`,entry);
  const merged={id:current.id,entries:[...entries.values()].sort((a,b)=>a.at.localeCompare(b.at))};
  atomicWrite(JOURNAL,JSON.stringify(merged));
  return true;
}
function append(uuid,action) {
  const j=journal(); const entry={uuid,action,at:new Date().toISOString()};
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
  } else {
    run('DELETE FROM contacts WHERE shooter_id=? AND consent_at<=?',[s.id,entry.at]);
  }
}
function replay() { for(const entry of journal().entries) applyEntry(entry); }
function replayEntries(entries) { for(const entry of entries || []) applyEntry(entry); }
function erased(uuid) { return journal().entries.some(e=>e.uuid===uuid && e.action==='erase'); }
function purgeArchives(s) {
  // Archives are reproducible from event history. Remove managed copies containing
  // erased identities, including legacy files lacking UUIDs. Never touch other paths.
  for(const file of fs.readdirSync(ARCHIVE_DIR).filter(n=>n.endsWith('.json'))) {
    const target=path.join(ARCHIVE_DIR,file);
    try {
      const a=JSON.parse(fs.readFileSync(target,'utf8'));
      if(a.shooters?.some(p=>p.uuid===s.uuid || (!p.uuid && p.name===s.name))) fs.unlinkSync(target);
    } catch(error) { throw new Error('Archivbereinigung fehlgeschlagen: '+file); }
  }
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
      run('INSERT INTO consent_log(shooter_id,action,details) VALUES (?,?,?)',[id,'granted',JSON.stringify({text,evidence,at,email_sha256:createHash('sha256').update(email.toLocaleLowerCase('en-US')).digest('hex')})]);
    });
    return this.get(id);
  },
  revoke(id) {
    const s=get('SELECT * FROM shooters WHERE id=?',[id]); if(!s) fail('Schütze nicht gefunden');
    const entry=append(s.uuid,'revoke');
    transaction(()=>{applyEntry(entry);run('INSERT INTO consent_log(shooter_id,action,details) VALUES (?,?,?)',[id,'revoked',JSON.stringify({at:entry.at})]);});
  },
  erase(id) {
    const s=get('SELECT * FROM shooters WHERE id=?',[id]); if(!s) fail('Schütze nicht gefunden');
    purgeArchives(s);
    const entry=append(s.uuid,'erase');
    transaction(()=>applyEntry(entry));
  },
  invitations(eventId) {
    if(setting('privacy_review')==='1') fail('Datenschutzprüfung nach Wiederherstellung erforderlich');
    const rows=all(`SELECT s.id,s.name,c.email FROM shooters s JOIN contacts c ON c.shooter_id=s.id
      WHERE s.archived_at IS NULL AND c.status='granted'
      AND EXISTS(SELECT 1 FROM participants p WHERE p.shooter_id=s.id AND (? IS NULL OR p.event_id=?))
      ORDER BY s.name COLLATE NOCASE`,[eventId || null,eventId || null]);
    return rows;
  }
};
journal();
transaction(replay);
module.exports={Contacts,journal,replay,replayEntries,erased,validateJournal,mergeJournal,JOURNAL};
