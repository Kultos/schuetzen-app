'use strict';
const $ = id => document.getElementById(id);
const json = (method, data) => ({method,body:JSON.stringify(data)});
function report(error) { showAppStatus(error.message || String(error),'error'); }
function action(label,fn) {return el('button',{type:'button',text:label,onclick:async(event)=>{const button=event.currentTarget;button.disabled=true;try{await fn();}catch(e){report(e);}finally{button.disabled=false;}}});}
function download(name,data,type='application/json') {
  const url=URL.createObjectURL(new Blob([typeof data==='string'?data:JSON.stringify(data,null,2)],{type}));
  const a=el('a',{href:url,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function detail(title) {
  const root=$('detailContent');root.replaceChildren(el('h2',{text:title}));
  if(!$('detailDialog').open) $('detailDialog').showModal();return root;
}
function field(label,input) {return el('label',{class:'form-field'},[document.createTextNode(label),input]);}
async function closeDetailDialog() {
  if($('detailDialog').querySelector('form[data-dirty="true"]') && !await confirmAction('Ungespeicherte Eingaben','Eingaben wurden noch nicht gespeichert. Dialog trotzdem schließen?','Dialog schließen'))return;
  $('detailDialog').close();
}
$('closeDetail').onclick=closeDetailDialog;
$('detailDialog').addEventListener('cancel',event=>{event.preventDefault();closeDetailDialog();});
$('loginDialog').addEventListener('cancel',e=>e.preventDefault());
$('logoutBtn').onclick=async()=>{await api('/api/auth/logout',json('POST',{}));location.reload();};
let authStatus;
async function initialize() {
  if(location.pathname==='/dashboard') {
    document.body.classList.add('tv-mode');
    document.querySelectorAll('.panel').forEach(panel=>panel.classList.remove('active'));
    $('tab-dashboard').classList.add('active');startDashboard();return;
  }
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
    $('tab-backup').classList.add('active');await refreshManagement();return;
  }
  await loadEventTitle();
  await Promise.all([loadShooters(),loadDisciplines()]);
  setRegistrationMode('existing');
  await showTab(location.hash.slice(1) || 'overview',{updateHash:false});
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
    $('peopleRows').append(el('tr',{},[el('td',{text:p.name+(p.archived_at?' (archiviert)':'')}),el('td',{text:p.event_count}),el('td',{text:p.start_number||'–'}),el('td',{text:p.contact_allowed?'Freigegeben':'Keine Freigabe'}),el('td',{},[action('Person ansehen',()=>showPerson(p))])]));
  }
  $('peopleStatus').textContent=people.length+' Person(en) gefunden.';
}

async function loadInvitationEvents() {
  const events=await api('/api/events');
  $('invitationEvent').replaceChildren(el('option',{value:'',text:'Alle Veranstaltungen'}),...events.map(e=>el('option',{value:e.id,text:(e.year||'Jahr offen')+' – '+(e.title||'Ohne Titel')})));
}

async function showPerson(p) {
  const root=detail(p.name);
  root.append(el('dl',{class:'person-facts'},[
    el('div',{},[el('dt',{text:'Veranstaltungen'}),el('dd',{text:p.event_count})]),
    el('div',{},[el('dt',{text:'Aktuelle Teilnahme'}),el('dd',{text:p.start_number?'Startnummer '+p.start_number:'Nicht angemeldet'})]),
    el('div',{},[el('dt',{text:'Einladungen'}),el('dd',{text:p.contact_allowed?'Freigegeben':'Keine Freigabe'})])
  ]));
  const actions=el('div',{class:'detail-actions'},[
    action('Stammdaten bearbeiten',()=>editPerson(p)),action('Historie ansehen',()=>showHistory(p)),action('E-Mail / Einwilligung',()=>editContact(p))
  ]);
  if(!p.archived_at && !p.start_number) actions.prepend(action('Für Veranstaltung anmelden',()=>openRegistrationForPerson(p)));
  root.append(actions,el('section',{class:'danger-zone'},[
    el('h3',{text:'Archivierung und Datenschutz'}),
    el('p',{class:'hint',text:'Diese Aktionen betreffen die künftige Nutzung oder entfernen personenbezogene Daten.'}),
    action(p.archived_at?'Person reaktivieren':'Person archivieren',async()=>{await api('/api/people/'+p.id+'/archive',json('POST',{archived:!p.archived_at}));$('detailDialog').close();await loadPeople();}),
    el('button',{type:'button',class:'danger',text:'Personendaten endgültig löschen',onclick:async()=>{
      if(!await confirmAction('Personendaten endgültig löschen',p.name+': Namen und Kontakt endgültig aus Stamm und Historie entfernen? Betroffene verwaltete Veranstaltungsdateien werden gelöscht und können bereinigt neu exportiert werden. Ergebnisse bleiben ohne Namen erhalten.','Personendaten löschen',true))return;
      await api('/api/people/'+p.id+'/erase',json('POST',{confirm:true}));$('detailDialog').close();await loadPeople();
    }})
  ]));
}

async function openRegistrationForPerson(p) {
  $('detailDialog').close();
  await activateTab('shooters');
  $('registrationSearch').value=p.name;
  await loadRegistrationPeople();
  const person=registrationView.people.find(entry=>entry.id===p.id);
  if(person)selectRegistrationPerson(person);
}
let searchTimer;
$('peopleSearch').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadPeople().catch(report),200);};
function editPerson(p) {
  const root=detail(p?'Stammdaten bearbeiten':'Person anlegen'),form=el('form');
  const structuredName=splitShooterName(p?.name);
  const firstName=el('input',{value:structuredName.firstName,required:'',maxlength:'100',autocomplete:'given-name'});
  const lastName=el('input',{value:structuredName.lastName,required:'',maxlength:'100',autocomplete:'family-name'});
  const gender=el('select',{},[el('option',{value:'m',text:'männlich'}),el('option',{value:'w',text:'weiblich'})]);gender.value=p?.gender||'m';
  form.append(field('Vorname',firstName),field('Nachname',lastName),field('Geschlecht',gender),el('p',{text:'Stammdatenänderungen ändern keine bereits gespeicherten Veranstaltungslisten.'}),el('button',{text:'Speichern'}));
  form.onsubmit=async e=>{e.preventDefault();const first_name=firstName.value.trim(),last_name=lastName.value.trim();try{await api('/api/people'+(p?'/'+p.id:''),json(p?'PUT':'POST',{name:`${last_name}, ${first_name}`,first_name,last_name,gender:gender.value}));$('detailDialog').close();await loadPeople();}catch(error){report(error);}};
  root.append(form);
}
$('newPersonBtn').onclick=()=>editPerson(null);
async function showHistory(p) {
  const root=detail('Historie: '+p.name),history=await api('/api/people/'+p.id+'/history');
  if(!history.length) root.append(el('p',{text:'Noch keine Veranstaltungsanmeldung.'}));
  for(const h of history) {
    const historicalName=h.historical_name!==p.name?' · damaliger Name: '+h.historical_name:'';
    const card=el('article',{class:'card'},[el('h3',{text:(h.year||'Jahr offen')+' – '+(h.title||'Ohne Titel')}),el('p',{text:'Startnummer '+h.start_number+historicalName+' · '+(h.result_count?'Ergebnisse vorhanden':'Angemeldet, ohne Ergebnis')+(h.reconstructed?' · Wertung rekonstruiert':'')})]);
    for(const r of h.placements) card.append(el('p',{text:r.discipline+': Platz '+r.rank+' ('+formatPoints(r.best_points)+' Punkte)'}));
    if(h.status!=='closed') card.append(el('p',{text:'Veranstaltung noch nicht abgeschlossen; keine endgültige Wertung.'}));
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
  root.append(form,action('Einwilligung widerrufen / E-Mail entfernen',async()=>{if(!await confirmAction('Einwilligung widerrufen','Einladungsfreigabe widerrufen und E-Mail-Adresse entfernen?','Widerrufen',true))return;await api('/api/people/'+p.id+'/contact',{method:'DELETE'});$('detailDialog').close();await loadPeople();}));
  root.append(el('h3',{text:'Dokumentation'}));
  for(const l of result.log) root.append(el('p',{text:l.created_at+' · '+l.action+' · '+l.details}));
  if(result.log.length) root.append(action('Alte Einwilligungsnachweise löschen',async()=>{
    if(c)throw new Error('Aktive Einwilligung zuerst widerrufen.');
    if(!await confirmAction('Nachweise endgültig löschen','Einwilligungs- und Widerrufsnachweise dieser Person entsprechend dem Löschkonzept endgültig entfernen?','Nachweise löschen',true))return;
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
  $('backupStatus').textContent='Lokale Sicherung: '+(b.last_local?backupLabel(b.last_local):'noch keine')+' · Externe Sicherung: '+(b.external_configured?(b.last_external?backupLabel(b.last_external):'in diesem Lauf noch nicht bestätigt'):'kein Ziel eingerichtet')+(b.error?' · Fehler: '+b.error:'');
  $('restoreReview').hidden=!b.privacy_review;
  $('backupList').replaceChildren(...b.files.slice(0,10).map(name=>el('li',{},[
    el('a',{href:'/api/backups/'+encodeURIComponent(name),text:backupLabel(name)}),el('small',{text:name})
  ])));
  if(b.privacy_review)return;
  const events=await api('/api/events');
  const statusLabel={active:'aktiv',closed:'abgeschlossen',correction:'Korrektur geöffnet'};
  $('eventList').replaceChildren(...events.map(e=>el('article',{class:'event-list-item'},[
    el('div',{},[el('strong',{text:(e.year||'Jahr offen')+' – '+(e.title||'Ohne Titel')}),el('small',{text:statusLabel[e.status]||e.status})]),
    action('Details und Wertungen',()=>showEvent(e.id))
  ])));
}

function backupLabel(name) {
  const value=String(name);
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))return new Date(value).toLocaleString('de-DE');
  const match=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/i);
  if(!match)return value;
  const [,year,month,day,hour,minute,second,millis,reason]=match;
  const date=new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`);
  const reasonLabel={manuell:'Manuell',automatisch:'Automatisch','vor-eventwechsel':'Vor Veranstaltungswechsel','nach-eventwechsel':'Nach Veranstaltungswechsel','vor-korrektur':'Vor Korrektur','nach-korrektur':'Nach Korrektur','vor-restore':'Vor Wiederherstellung'}[reason]||reason;
  return `${date.toLocaleString('de-DE')} · ${reasonLabel}`;
}
$('createBackup').onclick=async()=>{try{await api('/api/backups',json('POST',{}));await refreshManagement();}catch(e){report(e);}};
$('restoreFile').onchange=async()=>{
  try {
    const file=$('restoreFile').files[0];if(!file)return;
    const backup=JSON.parse(await file.text());
    const summary=await api('/api/backup/preview',json('POST',{backup}));
    if(!await confirmAction('Vollbackup wiederherstellen',summary.events+' Veranstaltungen, '+summary.shooters+' Schützen und '+summary.results+' Ergebnisse ersetzen den gesamten Datenbestand. Vorher wird ein Notfallbackup erstellt. Danach sind Datenschutzabgleich und erneute Kontaktfreigaben erforderlich.','Datenbestand ersetzen',true))return;
    await api('/api/backup/restore',json('POST',{backup,confirm:true}));location.reload();
  } catch(e){report(e);} finally {$('restoreFile').value='';}
};
$('finishReview').onclick=async()=>{try{await api('/api/privacy/review',json('POST',{note:$('reviewNote').value}));location.reload();}catch(e){report(e);}};
async function startNextEvent() {
  const button=$('resetSeasonBtn');button.disabled=true;
  try {
    const title=$('nextEventTitle').value.trim(),year=Number($('nextEventYear').value);
    if(!title||!year)throw new Error('Bitte Titel und Jahr für die neue Veranstaltung ausfüllen.');
    const current=`${state.event?.year||'Jahr offen'} – ${state.eventTitle||'Ohne Titel'}`;
    if(!await confirmAction('Veranstaltung wechseln',`${current} abschließen und ${year} – ${title} starten? Teilnehmer, Disziplinen und Ergebnisse werden abgeschlossen. Die neue Veranstaltung beginnt leer; Schützenstamm und Historie bleiben erhalten.`,'Abschließen und neu starten',true))return;
    const result=await api('/api/season/reset',json('POST',{title,year,previous_event_id:state.eventId}));
    await loadEventTitle();await Promise.all([loadShooters(),loadDisciplines(),refreshSeasonInfo()]);
    $('nextEventTitle').value='';$('nextEventYear').value='';if(result.warnings.length)showAppStatus(result.warnings.join(' '),'error');
    await activateTab('disciplines');
  } catch(e){report(e);} finally {button.disabled=false;}
}
function placementGroupsForDiscipline(archive,discipline) {
  const placements=archive.placements.filter(row=>row.discipline_id===discipline.id).sort((a,b)=>a.rank-b.rank);
  if(discipline.ranking_mode!=='separate')return [['Einzelwertung',placements]];
  const genderFor=row=>archive.shooters.find(shooter=>shooter.id===row.shooter_id)?.gender;
  return [['Frauen',placements.filter(row=>genderFor(row)==='w')],['Männer',placements.filter(row=>genderFor(row)==='m')]];
}

async function showEvent(id) {
  const a=await api('/api/events/'+id),root=detail((a.event.year||'Jahr offen')+' – '+a.event_title);
  const scoringLabel=a.event.scoring_mode==='team'?'nur Mannschaft':a.event.scoring_mode==='both'?'Einzel und Mannschaft':'nur Einzel';
  root.append(el('p',{text:'Status: '+a.event.status+' · Abschlussversion '+a.event.revision+' · Wertung: '+scoringLabel+'. Einzel: beste Serien; Mannschaft: beste '+a.event.team_counted_results+' ausgewählte Ergebnisse.'}),action('Veranstaltungsdatei herunterladen',()=>download('veranstaltung-'+a.event.uuid+'-r'+a.event.revision+'.json',a)));
  for(const c of a.closures)root.append(el('p',{text:'Abschluss '+c.revision+': '+c.reason+' ('+c.created_at+')'}));
  if(a.event.status==='closed') {
    const reason=el('input',{placeholder:'Korrektur begründen',maxlength:'500'});
    root.append(field('Korrekturgrund',reason),action('Korrekturmodus öffnen',async()=>{await api('/api/events/'+id+'/correction',json('POST',{reason:reason.value}));await showEvent(id);}));
  }
  if(a.event.status==='correction')root.append(action('Korrektur abschließen',async()=>{const result=await api('/api/events/'+id+'/correction',json('POST',{finish:true}));if(result.warnings?.length)showAppStatus(result.warnings.join(' '),'error');await showEvent(id);}));
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
    for(const [label,rows] of placementGroupsForDiscipline(a,d)) {
      root.append(el('h4',{text:label}));
      if(!rows.length)root.append(el('p',{class:'hint',text:'Keine Platzierungen.'}));
      for(const p of rows)root.append(el('p',{text:'Platz '+p.rank+': '+a.shooters.find(s=>s.id===p.shooter_id)?.name+' – '+formatPoints(p.best_points)}));
    }
    if(a.event.scoring_mode!=='individual') {
      root.append(el('h4',{text:'Mannschaftswertung'}));
      for(const p of a.team_placements.filter(p=>p.discipline_id===d.id).sort((x,y)=>x.rank-y.rank))root.append(el('p',{text:'Platz '+p.rank+': '+a.teams.find(team=>team.id===p.team_id)?.name+' – '+formatPoints(p.total_points)+' Punkte'}));
    }
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
    form.append(el('button',{text:'Historische Veranstaltung importieren'}));root.append(form);
    form.onsubmit=async e=>{
      e.preventDefault();const button=form.querySelector('button');button.disabled=true;
      try {
        const mapping=Object.fromEntries([...choices].map(([id,s])=>[id,s.value==='new'?null:Number(s.value)]));
        const result=await api('/api/import/archive',json('POST',{archive,year:Number(year.value),mapping,fingerprint:p.fingerprint}));
        $('detailDialog').close();$('importResult').textContent='Veranstaltung „'+result.event_title+'“ als Historie importiert.';
        detectedArchive=null;$('importArchiveWrap').style.display='none';
      } catch(error){report(error);} finally {button.disabled=false;}
    };
  }catch(e){report(e);}
}
window.addEventListener('unhandledrejection',event=>{event.preventDefault();if(event.reason?.status===401)location.reload();else report(event.reason);});
initialize().catch(report);
