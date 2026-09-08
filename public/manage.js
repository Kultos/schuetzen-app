'use strict';
const $ = id => document.getElementById(id);
const json = (method, data) => ({method,body:JSON.stringify(data)});
function report(error) { alert(error.message || String(error)); }
function action(label,fn) {return el('button',{type:'button',text:label,onclick:async(event)=>{event.currentTarget.disabled=true;try{await fn();}catch(e){report(e);}finally{event.target.disabled=false;}}});}
function download(name,data,type='application/json') {
  const url=URL.createObjectURL(new Blob([typeof data==='string'?data:JSON.stringify(data,null,2)],{type}));
  const a=el('a',{href:url,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function detail(title) {
  const root=$('detailContent');root.replaceChildren(el('h2',{text:title}));
  if(!$('detailDialog').open) $('detailDialog').showModal();return root;
}
function field(label,input) {return el('label',{class:'form-field'},[document.createTextNode(label),input]);}
$('closeDetail').onclick=()=>$('detailDialog').close();
$('loginDialog').addEventListener('cancel',e=>e.preventDefault());
$('openRegistry').onclick=()=>activateTab('people');
$('logoutBtn').onclick=async()=>{await api('/api/auth/logout',json('POST',{}));location.reload();};
let authStatus;
async function initialize() {
  if(location.pathname==='/dashboard') {document.body.classList.add('tv-mode');activateTab('dashboard');return;}
  authStatus=await api('/api/auth/status');
  if(!authStatus.authenticated) {
    $('loginHint').textContent=!authStatus.secure ? 'Verwaltung im LAN benötigt HTTPS. Direkt am Server localhost öffnen.' : authStatus.configured ? 'Mit dem Verwaltungskennwort anmelden.' : authStatus.local ? 'Einmalig ein Verwaltungskennwort mit mindestens 12 Zeichen festlegen. Es gilt für alle Helfer.' : 'Das Kennwort zuerst direkt am Server einrichten.';
    $('loginForm').querySelector('button').disabled=!authStatus.secure || (!authStatus.configured&&!authStatus.local);
    $('loginDialog').showModal();return;
  }
  $('loginDialog').close();
  const backups=await api('/api/backups');
  if(backups.privacy_review) {
    document.querySelectorAll('.panel,.tab').forEach(e=>e.classList.remove('active'));
    $('tab-season').classList.add('active');await refreshManagement();return;
  }
  await loadEventTitle();
  await Promise.all([loadShooters(),loadDisciplines()]);
}
$('loginForm').onsubmit=async e=>{
  e.preventDefault();$('loginError').textContent='';
  try {await api(authStatus.configured?'/api/auth/login':'/api/auth/setup',json('POST',{password:$('adminPassword').value}));$('adminPassword').value='';await initialize();}
  catch(error){$('loginError').textContent=error.message;}
};
async function loadPeople() {
  const people=await api('/api/people?search='+encodeURIComponent($('peopleSearch').value));
  $('peopleRows').replaceChildren();
  for(const p of people) {
    const buttons=[action('Historie',()=>showHistory(p)),action('Bearbeiten',()=>editPerson(p)),action('E-Mail / Einwilligung',()=>editContact(p))];
    if(!p.archived_at && !p.start_number) buttons.unshift(action('Für Event anmelden',()=>registerPerson(p)));
    buttons.push(action(p.archived_at?'Reaktivieren':'Archivieren',async()=>{await api('/api/people/'+p.id+'/archive',json('POST',{archived:!p.archived_at}));await loadPeople();}));
    buttons.push(action('Personendaten löschen',async()=>{
      if(!confirm(p.name+': Namen und Kontakt aus Stamm und Historie entfernen? Betroffene verwaltete Eventdateien werden gelöscht und können bereinigt neu exportiert werden. Ergebnisse bleiben ohne Namen erhalten. Alte Backups unterliegen der Aufbewahrungsfrist.')) return;
      await api('/api/people/'+p.id+'/erase',json('POST',{confirm:true}));await loadPeople();
    }));
    $('peopleRows').append(el('tr',{},[el('td',{text:p.name+(p.archived_at?' (archiviert)':'')}),el('td',{text:p.event_count}),el('td',{text:p.start_number||'–'}),el('td',{text:p.contact_allowed?'Freigegeben':'Keine Freigabe'}),el('td',{class:'row-actions'},buttons)]));
  }
  $('peopleStatus').textContent=people.length+' Person(en) gefunden.';
  try {
    const events=await api('/api/events');
    $('invitationEvent').replaceChildren(el('option',{value:'',text:'Alle Events'}),...events.map(e=>el('option',{value:e.id,text:(e.year||'Jahr offen')+' – '+(e.title||'Ohne Titel')})));
  } catch(e){if(e.status!==423) throw e;}
}
let searchTimer;
$('peopleSearch').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadPeople().catch(report),200);};
function editPerson(p) {
  const root=detail(p?'Stammdaten bearbeiten':'Person anlegen'),form=el('form');
  const name=el('input',{value:p?.name||'',required:'',maxlength:'200'});
  const gender=el('select',{},[el('option',{value:'m',text:'männlich'}),el('option',{value:'w',text:'weiblich'})]);gender.value=p?.gender||'m';
  form.append(field('Name',name),field('Geschlecht',gender),el('p',{text:'Stammdatenänderungen ändern keine bereits gespeicherten Eventlisten.'}),el('button',{text:'Speichern'}));
  form.onsubmit=async e=>{e.preventDefault();try{await api('/api/people'+(p?'/'+p.id:''),json(p?'PUT':'POST',{name:name.value,gender:gender.value}));$('detailDialog').close();await loadPeople();}catch(error){report(error);}};
  root.append(form);
}
$('newPersonBtn').onclick=()=>editPerson(null);
async function registerPerson(p) {
  const root=detail(p.name+' anmelden'),form=el('form');
  const suggestion=await api('/api/shooters/next-start-number');
  const n=el('input',{type:'number',min:'1',step:'1',required:'',value:suggestion.start_number});
  form.append(field('Neue Startnummer für das aktuelle Event',n),el('button',{text:'Anmelden'}));root.append(form);
  form.onsubmit=async e=>{e.preventDefault();try{await api('/api/people/'+p.id+'/register',json('POST',{start_number:Number(n.value)}));$('detailDialog').close();await Promise.all([loadPeople(),loadShooters()]);}catch(error){report(error);}};
}
async function showHistory(p) {
  const root=detail('Historie: '+p.name),history=await api('/api/people/'+p.id+'/history');
  if(!history.length) root.append(el('p',{text:'Noch keine Event-Anmeldung.'}));
  for(const h of history) {
    const historicalName=h.historical_name!==p.name?' · damaliger Name: '+h.historical_name:'';
    const card=el('article',{class:'card'},[el('h3',{text:(h.year||'Jahr offen')+' – '+(h.title||'Ohne Titel')}),el('p',{text:'Startnummer '+h.start_number+historicalName+' · '+(h.result_count?'Ergebnisse vorhanden':'Angemeldet, ohne Ergebnis')+(h.reconstructed?' · Wertung rekonstruiert':'')})]);
    for(const r of h.placements) card.append(el('p',{text:r.discipline+': Platz '+r.rank+' ('+formatPoints(r.best_points)+' Punkte)'}));
    if(h.status!=='closed') card.append(el('p',{text:'Event noch nicht abgeschlossen; keine endgültige Wertung.'}));
    root.append(card);
  }
}
async function editContact(p) {
  const result=await api('/api/people/'+p.id+'/contact'),c=result.contact;
  const root=detail('Kontakt: '+p.name),form=el('form');
  const email=el('input',{type:'email',maxlength:'254',value:c?.email||'',required:''});
  const text=el('textarea',{required:'',minlength:'20',maxlength:'3000'});text.value=c?.consent_text||'';
  const evidence=el('input',{required:'',maxlength:'500',placeholder:'z. B. unterschriebener Anmeldebogen Nr. 42'});
  const consent=el('input',{type:'checkbox',required:''});
  form.append(el('p',{text:c?.status==='review'?'Nach Wiederherstellung gesperrt. Einwilligungsnachweis für diese Adresse erneut prüfen.':'E-Mail ist freiwillig. Ohne Einwilligung bleibt die Teilnahme möglich.'}),field('E-Mail-Adresse',email),field('Tatsächlicher Wortlaut der Einwilligung (Verein, Zweck, Widerrufshinweis)',text),field('Nachweis / Belegnummer',evidence),field('Einwilligung für diese Adresse liegt nachweislich vor',consent),el('button',{text:'Einwilligung dokumentieren und speichern'}));
  form.onsubmit=async e=>{e.preventDefault();try{await api('/api/people/'+p.id+'/contact',json('PUT',{email:email.value,consent_text:text.value,evidence:evidence.value,consent:consent.checked}));$('detailDialog').close();await loadPeople();}catch(error){report(error);}};
  root.append(form,action('Einwilligung widerrufen / E-Mail entfernen',async()=>{if(!confirm('Einladungsfreigabe widerrufen und E-Mail entfernen?'))return;await api('/api/people/'+p.id+'/contact',{method:'DELETE'});$('detailDialog').close();await loadPeople();}));
  root.append(el('h3',{text:'Dokumentation'}));
  for(const l of result.log) root.append(el('p',{text:l.created_at+' · '+l.action+' · '+l.details}));
  if(result.log.length) root.append(action('Alte Einwilligungsnachweise löschen',async()=>{
    if(c)throw new Error('Aktive Einwilligung zuerst widerrufen.');
    if(!confirm('Einwilligungs- und Widerrufsnachweise dieser Person entsprechend dem Löschkonzept endgültig entfernen?'))return;
    await api('/api/people/'+p.id+'/consent-log',json('DELETE',{confirm:true}));await editContact(p);
  }));
}
$('invitationExport').onclick=async()=>{
  try {
    const rows=await api('/api/invitations?event_id='+encodeURIComponent($('invitationEvent').value));
    const cell=v=>'"'+String(/^[=+\-@\t\r]/.test(v)?"'"+v:v).replaceAll('"','""')+'"';
    const unique=[...new Map(rows.map(r=>[r.email.toLowerCase(),r])).values()];
    download('einladungen-'+new Date().toISOString().slice(0,10)+'.csv','\uFEFFName;E-Mail\r\n'+unique.map(r=>[r.name,r.email].map(cell).join(';')).join('\r\n'),'text/csv;charset=utf-8');
  } catch(error){report(error);}
};
async function refreshManagement() {
  const b=await api('/api/backups');
  $('backupStatus').textContent='Letztes lokales Backup: '+(b.last_local||'keines')+' · Extern: '+(b.external_configured?(b.last_external||'in diesem Lauf noch nicht bestätigt'):'kein Ziel eingerichtet')+(b.error?' · '+b.error:'');
  $('restoreReview').hidden=!b.privacy_review;
  $('backupList').replaceChildren(...b.files.slice(0,10).map(name=>el('li',{},[el('a',{href:'/api/backups/'+encodeURIComponent(name),text:name})])));
  if(b.privacy_review)return;
  const events=await api('/api/events');
  $('eventList').replaceChildren(...events.map(e=>el('p',{},[document.createTextNode((e.year||'Jahr offen')+' – '+(e.title||'Ohne Titel')+' · '+e.status+' '),action('Ansehen / korrigieren',()=>showEvent(e.id))])));
}
$('createBackup').onclick=async()=>{try{await api('/api/backups',json('POST',{}));await refreshManagement();}catch(e){report(e);}};
$('restoreFile').onchange=async()=>{
  try {
    const file=$('restoreFile').files[0];if(!file)return;
    const backup=JSON.parse(await file.text());
    const summary=await api('/api/backup/preview',json('POST',{backup}));
    if(!confirm(summary.events+' Events, '+summary.shooters+' Schützen, '+summary.results+' Ergebnisse. Gesamten Datenbestand ersetzen? Vorher wird ein Notfallbackup erstellt. Danach sind ein Datenschutzabgleich und erneute Kontaktfreigaben erforderlich.'))return;
    await api('/api/backup/restore',json('POST',{backup,confirm:true}));location.reload();
  } catch(e){report(e);} finally {$('restoreFile').value='';}
};
$('finishReview').onclick=async()=>{try{await api('/api/privacy/review',json('POST',{note:$('reviewNote').value}));location.reload();}catch(e){report(e);}};
async function startNextEvent() {
  const button=$('resetSeasonBtn');button.disabled=true;
  try {
    const title=$('nextEventTitle').value.trim(),year=Number($('nextEventYear').value);
    if(!title||!year)throw new Error('Bitte Titel und Jahr für das neue Event ausfüllen.');
    if(!confirm('Aktuelles Event abschließen und „'+title+'“ starten?'))return;
    const result=await api('/api/season/reset',json('POST',{title,year,previous_event_id:state.eventId}));
    await loadEventTitle();await Promise.all([loadShooters(),loadDisciplines(),refreshSeasonInfo()]);
    $('nextEventTitle').value='';if(result.warnings.length)alert(result.warnings.join('\n'));
  } catch(e){report(e);} finally {button.disabled=false;}
}
async function showEvent(id) {
  const a=await api('/api/events/'+id),root=detail((a.event.year||'Jahr offen')+' – '+a.event_title);
  root.append(el('p',{text:'Status: '+a.event.status+' · Abschlussversion '+a.event.revision+' · Wertung: beste Serien, bei vollständigem Gleichstand alphabetisch.'}),action('Eventdatei herunterladen',()=>download('event-'+a.event.uuid+'-r'+a.event.revision+'.json',a)));
  for(const c of a.closures)root.append(el('p',{text:'Abschluss '+c.revision+': '+c.reason+' ('+c.created_at+')'}));
  if(a.event.status==='closed') {
    const reason=el('input',{placeholder:'Korrektur begründen',maxlength:'500'});
    root.append(field('Korrekturgrund',reason),action('Korrekturmodus öffnen',async()=>{await api('/api/events/'+id+'/correction',json('POST',{reason:reason.value}));await showEvent(id);}));
  }
  if(a.event.status==='correction')root.append(action('Korrektur abschließen',async()=>{const result=await api('/api/events/'+id+'/correction',json('POST',{finish:true}));if(result.warnings?.length)alert(result.warnings.join('\n'));await showEvent(id);}));
  const table=el('table',{class:'data-table'},[el('thead',{},[el('tr',{},['Schütze','Disziplin','Durchgang','Punkte'].map(t=>el('th',{text:t})))])]);
  const body=el('tbody');
  for(const r of a.results) {
    const cell=el('td',{text:formatPoints(r.points)});
    if(a.event.status==='correction') {
      const input=el('input',{type:'number',step:'any',value:r.points});
      cell.replaceChildren(input,action('Korrigieren',async()=>{if(!input.value.trim())throw new Error('Punkte fehlen');await api('/api/events/'+id+'/results/'+r.id,json('PUT',{points:Number(input.value)}));await showEvent(id);}));
    }
    body.append(el('tr',{},[el('td',{text:a.shooters.find(s=>s.id===r.shooter_id)?.name}),el('td',{text:a.disciplines.find(d=>d.id===r.discipline_id)?.name}),el('td',{text:r.round_number}),cell]));
  }
  table.append(body);root.append(table);
  for(const d of a.disciplines) {
    root.append(el('h3',{text:d.name}));
    for(const p of a.placements.filter(p=>p.discipline_id===d.id).sort((x,y)=>x.rank-y.rank))root.append(el('p',{text:'Platz '+p.rank+': '+a.shooters.find(s=>s.id===p.shooter_id)?.name+' – '+formatPoints(p.best_points)}));
  }
}
async function openArchiveImport(archive) {
  try {
    const p=await api('/api/import/preview',json('POST',{archive})),root=detail('Import prüfen: '+p.title),form=el('form');
    const year=el('input',{type:'number',min:'1900',max:'2200',required:'',value:p.year||''});
    form.append(field('Veranstaltungsjahr',year),el('p',{text:'Jede Person bewusst zuordnen. Namensgleichheit ist kein Identitätsnachweis.'}));
    const choices=new Map();const people=await api('/api/people');
    for(const s of p.shooters) {
      const select=el('select',{required:''},[el('option',{value:'',text:'Bitte wählen'}),el('option',{value:'new',text:'Neue Person anlegen'}),...people.filter(x=>!x.archived_at).map(x=>el('option',{value:x.id,text:x.name+' (Person '+x.id+')'}))]);
      if(s.existing_id)select.value=String(s.existing_id);
      choices.set(s.id,select);form.append(field(s.name+' · damalige Nr. '+s.start_number,select));
    }
    form.append(el('button',{text:'Historisches Event importieren'}));root.append(form);
    form.onsubmit=async e=>{
      e.preventDefault();const button=form.querySelector('button');button.disabled=true;
      try {
        const mapping=Object.fromEntries([...choices].map(([id,s])=>[id,s.value==='new'?null:Number(s.value)]));
        const result=await api('/api/import/archive',json('POST',{archive,year:Number(year.value),mapping,fingerprint:p.fingerprint}));
        $('detailDialog').close();$('importResult').textContent='Event „'+result.event_title+'“ als Historie importiert.';
        detectedArchive=null;$('importArchiveWrap').style.display='none';
      } catch(error){report(error);} finally {button.disabled=false;}
    };
  }catch(e){report(e);}
}
window.addEventListener('unhandledrejection',event=>{event.preventDefault();if(event.reason?.status===401)location.reload();else report(event.reason);});
initialize().catch(report);
