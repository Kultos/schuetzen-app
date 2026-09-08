'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const https = require('node:https');
const Auth = require('./auth');
const Backups = require('./backups');
const { Contacts } = require('./privacy');
const { People, Events, setting, transaction } = require('./db');
const Archives = require('./archives');

const {
  Shooters,
  Disciplines,
  Results,
  Season,
  rankingForDiscipline,
  dashboardSnapshot,
  fullExport,
  archiveCurrentSeason,
  validateSeasonArchive,
  restoreSeasonArchive,
  resetSeason,
  listArchives,
  ARCHIVE_DIR,
} = require('./db');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message, details = {}) {
  sendJSON(res, status, { error: message, ...details });
}

function normalizedName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePositiveInteger(value) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseFiniteNumber(value) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 150 * 1024 * 1024) {
        reject(new Error('Payload zu gross'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Ungueltiges JSON'));
      }
    });
    req.on('error', reject);
  });
}
function assertCurrentEvent(req) {
  if(Number(req.headers['x-event-id'])!==Events.active().id) {
    const error=new Error('Das aktive Event hat sich geändert. Bitte die Seite neu laden.');error.status=409;throw error;
  }
}
async function readEventBody(req) {const body=await readBody(req);assertCurrentEvent(req);return body;}

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR,'index.html')) {
    return sendError(res, 403, 'Verboten');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      // SPA fallback -> index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, fallback) => {
        if (err2) return sendError(res, 404, 'Nicht gefunden');
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(fallback);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

function getLanIPs() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  return results;
}

async function handleApi(req, res, pathname, query) {
  const method = req.method;
  res.setHeader('Cache-Control','no-store');
  if(!Auth.validateWrite(req)) return sendError(res,403,'Ungültige Anfrage');
  if(pathname === '/api/auth/status' && method === 'GET') return sendJSON(res,200,{configured:Auth.configured(),authenticated:!!Auth.session(req),local:Auth.local(req),secure:Auth.protectedTransport(req)});
  if(pathname === '/api/auth/setup' && method === 'POST') {
    const body=await readBody(req);
    try {Auth.setup(req,body.password);Auth.login(req,res,body.password);} catch(e) {return sendError(res,400,e.message);}
    return sendJSON(res,200,{ok:true});
  }
  if(pathname === '/api/auth/login' && method === 'POST') {
    const body=await readBody(req);
    try {Auth.login(req,res,body.password);} catch(e) {return sendError(res,401,e.message);}
    return sendJSON(res,200,{ok:true});
  }
  if(pathname === '/api/auth/logout' && method === 'POST') {Auth.logout(req,res);return sendJSON(res,200,{ok:true});}
  if(pathname === '/api/dashboard' && method === 'GET') {
    if(setting('privacy_review')==='1') return sendError(res,503,'Datenbestand wird nach Wiederherstellung geprüft');
    return sendJSON(res,200,dashboardSnapshot());
  }
  if(!Auth.protectedTransport(req)) return sendError(res,403,'Verwaltung im LAN erfordert HTTPS. Direkt am Server ist localhost verfügbar.');
  if(!Auth.session(req)) return sendError(res,401,'Bitte anmelden');
  const eventWrite=method!=='GET' && (/^\/api\/(shooters|disciplines|results)(\/|$)/.test(pathname) || pathname==='/api/import' || pathname==='/api/season' || pathname==='/api/season/reset' || /^\/api\/people\/\d+\/register$/.test(pathname));
  if(eventWrite) assertCurrentEvent(req);
  const reviewAllowed=['/api/backups','/api/backup/preview','/api/backup/restore','/api/privacy/review','/api/people'].includes(pathname) || /^\/api\/backups\//.test(pathname) || /^\/api\/people\/\d+(\/contact|\/consent-log|\/erase|\/history)?$/.test(pathname);
  if(setting('privacy_review')==='1' && !reviewAllowed) return sendError(res,423,'Datenschutzabgleich nach Restore erforderlich');
  let extra;
  if(pathname==='/api/people' && method==='GET') return sendJSON(res,200,People.list(query.search));
  if(pathname==='/api/people' && method==='POST') return sendJSON(res,201,People.create(await readBody(req)));
  if((extra=pathname.match(/^\/api\/people\/(\d+)$/)) && method==='PUT') return sendJSON(res,200,People.update(Number(extra[1]),await readBody(req)));
  if((extra=pathname.match(/^\/api\/people\/(\d+)\/history$/)) && method==='GET') return sendJSON(res,200,People.history(Number(extra[1])));
  if((extra=pathname.match(/^\/api\/people\/(\d+)\/register$/)) && method==='POST') {
    const b=await readEventBody(req);return sendJSON(res,201,Shooters.register(Number(extra[1]),b.start_number));
  }
  if((extra=pathname.match(/^\/api\/people\/(\d+)\/archive$/)) && method==='POST') {
    const b=await readBody(req);People.archive(Number(extra[1]),b.archived===true);return sendJSON(res,200,{ok:true});
  }
  if((extra=pathname.match(/^\/api\/people\/(\d+)\/contact$/))) {
    const id=Number(extra[1]);
    if(method==='GET') return sendJSON(res,200,Contacts.get(id));
    if(method==='PUT') return sendJSON(res,200,Contacts.save(id,await readBody(req)));
    if(method==='DELETE') {Contacts.revoke(id);return sendJSON(res,200,{ok:true});}
  }
  if((extra=pathname.match(/^\/api\/people\/(\d+)\/consent-log$/)) && method==='DELETE') {
    const b=await readBody(req);if(b.confirm!==true) return sendError(res,400,'Löschbestätigung fehlt');
    Contacts.purgeLog(Number(extra[1]));return sendJSON(res,200,{ok:true});
  }
  if((extra=pathname.match(/^\/api\/people\/(\d+)\/erase$/)) && method==='POST') {
    const b=await readBody(req);if(b.confirm!==true) return sendError(res,400,'Löschbestätigung fehlt');
    Contacts.erase(Number(extra[1]));return sendJSON(res,200,{ok:true});
  }
  if(pathname==='/api/invitations' && method==='GET') {
    let eventId=null;
    if(query.event_id!==undefined && query.event_id!=='') {
      eventId=parsePositiveInteger(query.event_id);if(!eventId) return sendError(res,400,'event_id muss eine positive ganze Zahl sein');Events.get(eventId);
    }
    return sendJSON(res,200,Contacts.invitations(eventId));
  }
  if(pathname==='/api/events' && method==='GET') return sendJSON(res,200,Events.list());
  if((extra=pathname.match(/^\/api\/events\/(\d+)$/))) {
    const id=Number(extra[1]);
    if(method==='GET') return sendJSON(res,200,fullExport(id));
    if(method==='PUT') return sendJSON(res,200,Events.metadata(id,await readBody(req)));
  }
  if((extra=pathname.match(/^\/api\/events\/(\d+)\/correction$/)) && method==='POST') {
    const b=await readBody(req);return sendJSON(res,200,b.finish ? Events.finishCorrection(Number(extra[1])) : Events.beginCorrection(Number(extra[1]),b.reason));
  }
  if((extra=pathname.match(/^\/api\/events\/(\d+)\/results\/(\d+)$/)) && method==='PUT') {
    const b=await readBody(req);Results.correct(Number(extra[1]),Number(extra[2]),b.points);return sendJSON(res,200,{ok:true});
  }
  if(pathname==='/api/backups' && method==='GET') return sendJSON(res,200,Backups.status());
  if(pathname==='/api/backups' && method==='POST') return sendJSON(res,201,{name:Backups.create()});
  if((extra=pathname.match(/^\/api\/backups\/([^/]+)$/)) && method==='GET') {
    res.setHeader('Content-Disposition','attachment; filename="systembackup.json"');return sendJSON(res,200,Backups.bundle(extra[1]));
  }
  if(pathname==='/api/backup/preview' && method==='POST') return sendJSON(res,200,Backups.inspect((await readBody(req)).backup));
  if(pathname==='/api/backup/restore' && method==='POST') {
    const b=await readBody(req);if(b.confirm!==true) return sendError(res,400,'Restore-Bestätigung fehlt');
    const restored=Backups.restore(b.backup);Auth.clearSessions();return sendJSON(res,200,restored);
  }
  if(pathname==='/api/privacy/review' && method==='POST') {Backups.reviewed((await readBody(req)).note);return sendJSON(res,200,{ok:true});}
  if(pathname==='/api/import/preview' && method==='POST') return sendJSON(res,200,Archives.preview((await readBody(req)).archive));

  // ---- Shooters ----
  if (pathname === '/api/shooters' && method === 'GET') {
    return sendJSON(res, 200, Shooters.list());
  }
  if (pathname === '/api/shooters/next-start-number' && method === 'GET') {
    return sendJSON(res, 200, { start_number: Shooters.nextStartNumber() });
  }
  if (pathname === '/api/shooters' && method === 'POST') {
    const body = await readEventBody(req);
    const name = normalizedName(body.name);
    if (!name || !body.gender) return sendError(res, 400, 'name und gender erforderlich');
    if (!['m', 'w'].includes(body.gender)) return sendError(res, 400, "gender muss 'm' oder 'w' sein");
    const startNumber = Object.hasOwn(body, 'start_number') ? parsePositiveInteger(body.start_number) : Shooters.nextStartNumber();
    if (!startNumber) return sendError(res, 400, 'start_number muss eine positive ganze Zahl sein');
    const conflict = Shooters.findByStartNumber(startNumber);
    if (conflict) {
      return sendError(res, 409, `Startnummer ${startNumber} ist bereits vergeben`, {
        code: 'START_NUMBER_CONFLICT',
        conflicting_shooter: conflict,
        suggested_start_number: Shooters.nextStartNumber(),
      });
    }
    return sendJSON(res, 201, Shooters.create({ name, gender: body.gender, start_number: startNumber }));
  }
  let m;
  if ((m = pathname.match(/^\/api\/shooters\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PUT') {
      const body = await readEventBody(req);
      const name = normalizedName(body.name);
      if (!name || !['m', 'w'].includes(body.gender)) {
        return sendError(res, 400, 'Gültiger Name und gender erforderlich');
      }
      const current = Shooters.findById(id);
      if (!current) return sendError(res, 404, 'Schütze nicht gefunden');
      const startNumber = Object.hasOwn(body, 'start_number') ? parsePositiveInteger(body.start_number) : current.start_number;
      if (!startNumber) return sendError(res, 400, 'start_number muss eine positive ganze Zahl sein');
      const conflict = Shooters.findByStartNumber(startNumber);
      const swapOnConflict = body.conflict_resolution === 'swap';
      if (conflict && conflict.id !== id && !swapOnConflict) {
        return sendError(res, 409, `Startnummer ${startNumber} ist bereits an ${conflict.name} vergeben`, {
          code: 'START_NUMBER_CONFLICT',
          conflicting_shooter: conflict,
        });
      }
      return sendJSON(res, 200, Shooters.update(
        id,
        { name, gender: body.gender, start_number: startNumber },
        { swapOnConflict }
      ));
    }
    if (method === 'DELETE') {
      if (!Shooters.findById(id)) return sendError(res, 404, 'Schütze nicht gefunden');
      Shooters.remove(id);
      return sendJSON(res, 200, { ok: true });
    }
  }

  // ---- Disciplines ----
  if (pathname === '/api/disciplines' && method === 'GET') {
    return sendJSON(res, 200, Disciplines.list());
  }
  if (pathname === '/api/disciplines' && method === 'POST') {
    const body = await readEventBody(req);
    const name = normalizedName(body.name);
    if (!name) return sendError(res, 400, 'name erforderlich');
    if (Disciplines.findByName(name)) return sendError(res, 409, 'Disziplin existiert bereits');
    return sendJSON(res, 201, Disciplines.create({ name }));
  }
  if ((m = pathname.match(/^\/api\/disciplines\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PUT') {
      const body = await readEventBody(req);
      const name = normalizedName(body.name);
      if (!name) return sendError(res, 400, 'name erforderlich');
      const current = Disciplines.findById(id);
      if (!current) return sendError(res, 404, 'Disziplin nicht gefunden');
      const duplicate = Disciplines.findByName(name);
      if (duplicate && duplicate.id !== id) return sendError(res, 409, 'Disziplin existiert bereits');
      return sendJSON(res, 200, Disciplines.update(id, { name }));
    }
    if (method === 'DELETE') {
      if (!Disciplines.findById(id)) return sendError(res, 404, 'Disziplin nicht gefunden');
      Disciplines.remove(id);
      return sendJSON(res, 200, { ok: true });
    }
  }

  // ---- Results ----
  if (pathname === '/api/results' && method === 'GET') {
    const shooterId = Number(query.shooter_id);
    const disciplineId = Number(query.discipline_id);
    if (!shooterId || !disciplineId) return sendError(res, 400, 'shooter_id und discipline_id erforderlich');
    return sendJSON(res, 200, Results.listForShooterDiscipline(shooterId, disciplineId));
  }
  if (pathname === '/api/results' && method === 'POST') {
    const body = await readEventBody(req);
    const shooterId = parsePositiveInteger(body.shooter_id);
    const disciplineId = parsePositiveInteger(body.discipline_id);
    const points = parseFiniteNumber(body.points);
    if (!shooterId || !disciplineId || points === null) {
      return sendError(res, 400, 'shooter_id, discipline_id und points erforderlich');
    }
    if (!Shooters.findById(shooterId) || !Disciplines.findById(disciplineId)) {
      return sendError(res, 400, 'Schütze oder Disziplin ist ungültig');
    }
    const roundNumber = body.round_number === undefined || body.round_number === null || body.round_number === ''
      ? Results.nextRoundNumber(shooterId, disciplineId)
      : parsePositiveInteger(body.round_number);
    if (!roundNumber) return sendError(res, 400, 'round_number muss eine positive ganze Zahl sein');
    return sendJSON(res, 201, Results.create({
      shooter_id: shooterId,
      discipline_id: disciplineId,
      round_number: roundNumber,
      points,
    }));
  }
  if ((m = pathname.match(/^\/api\/results\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PUT') {
      const body = await readEventBody(req);
      if (!Results.findById(id)) return sendError(res, 404, 'Ergebnis nicht gefunden');
      const points = parseFiniteNumber(body.points);
      const roundNumber = parsePositiveInteger(body.round_number);
      if (points === null || !roundNumber) {
        return sendError(res, 400, 'Gültige Punkte und round_number erforderlich');
      }
      return sendJSON(res, 200, Results.update(id, { points, round_number: roundNumber }));
    }
    if (method === 'DELETE') {
      if (!Results.findById(id)) return sendError(res, 404, 'Ergebnis nicht gefunden');
      Results.remove(id);
      return sendJSON(res, 200, { ok: true });
    }
  }

  // ---- Rankings ----
  if ((m = pathname.match(/^\/api\/rankings\/(\d+)$/)) && method === 'GET') {
    const disciplineId = Number(m[1]);
    return sendJSON(res, 200, rankingForDiscipline(disciplineId));
  }

  // ---- Live-Dashboard (TV-Ansicht) ----
  if (pathname === '/api/dashboard' && method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return sendJSON(res, 200, dashboardSnapshot());
  }

  // ---- Import ----
  if (pathname === '/api/import' && method === 'POST') {
    const body = await readEventBody(req);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    let created = { shooters: 0, disciplines: 0, results: 0 };
    let errors = [];
    for (const [i, row] of rows.entries()) {
      try {
        const name = String(row.name || '').trim();
        const genderRaw = String(row.gender || '').trim().toLowerCase();
        const disciplineName = String(row.discipline || '').trim();
        const pointsRaw=String(row.points??'').trim(),points = Number(row.points);
        if (!name || !disciplineName || !pointsRaw || !Number.isFinite(points)) {
          errors.push({ row: i + 1, message: 'Name, Disziplin oder Punkte fehlen/ungueltig' });
          continue;
        }
        let gender;
        if(genderRaw.startsWith('w')||genderRaw.startsWith('f')) gender='w';
        else if(genderRaw.startsWith('m')) gender='m';
        else throw new Error('Geschlecht muss m oder w sein');
        const delta=transaction(()=>{
          let shooters=0,disciplines=0;
          const number=String(row.start_number??'').trim() ? parsePositiveInteger(row.start_number) : null;
          let shooter = number ? Shooters.findByStartNumber(number) : Shooters.findByName(name);
          if(shooter && shooter.name.toLocaleLowerCase('de')!==name.toLocaleLowerCase('de')) throw new Error('Startnummer gehört zu einem anderen Teilnehmer');
          if (!shooter) {
            if(People.list(name).some(p=>p.name.toLocaleLowerCase('de')===name.toLocaleLowerCase('de'))) throw new Error('Name ist im Schützenstamm vorhanden. Person zuerst ausdrücklich für das Event anmelden.');
            const requestedStartNumber = String(row.start_number ?? '').trim() ? parsePositiveInteger(row.start_number) : Shooters.nextStartNumber();
            if (!requestedStartNumber) throw new Error('Startnummer ist ungültig');
            const conflict = Shooters.findByStartNumber(requestedStartNumber);
            if (conflict) throw new Error(`Startnummer ${requestedStartNumber} ist bereits an ${conflict.name} vergeben`);
            shooter = Shooters.register(People.create({name,gender}).id,requestedStartNumber);shooters=1;
          } else if (String(row.start_number ?? '').trim()) {
            const requestedStartNumber = parsePositiveInteger(row.start_number);
            if (!requestedStartNumber) throw new Error('Startnummer ist ungültig');
            if (shooter.start_number !== requestedStartNumber) throw new Error(`${name} ist bereits mit Startnummer ${shooter.start_number} erfasst`);
          }
          let discipline = Disciplines.findByName(disciplineName);
          if (!discipline) {discipline = Disciplines.create({ name: disciplineName });disciplines=1;}
          const round_number = String(row.round??'').trim() ? Number(row.round) : Results.nextRoundNumber(shooter.id, discipline.id);
          Results.create({ shooter_id: shooter.id, discipline_id: discipline.id, round_number, points });
          return {shooters,disciplines,results:1};
        });
        for(const key of Object.keys(created)) created[key]+=delta[key];
      } catch (e) {
        errors.push({ row: i + 1, message: e.message });
      }
    }
    return sendJSON(res, 200, { created, errors });
  }
  if (pathname === '/api/import/archive' && method === 'POST') {
    const body = await readBody(req);
    if (!body.archive) return sendError(res, 400, 'Saisonarchiv fehlt');
    try {
      validateSeasonArchive(body.archive);
    } catch (error) {
      return sendError(res, 400, error.message);
    }
    return sendJSON(res, 200, restoreSeasonArchive(body.archive,body));
  }

  // ---- Export (aktuelle Saison als JSON) ----
  if (pathname === '/api/export' && method === 'GET') {
    const data = fullExport();
    const body = JSON.stringify(data, null, 2);
    const title = Season.getTitle();
    const filenameBase = (title || 'saison-export')
      .replace(/[^a-zA-Z0-9äöüÄÖÜß_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'saison-export';
    const fallbackName = filenameBase.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
    const encodedName = encodeURIComponent(filenameBase + '.json');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
    });
    return res.end(body);
  }

  // ---- Saison-/Eventtitel ----
  if (pathname === '/api/season' && method === 'GET') {
    return sendJSON(res, 200, { title: Season.getTitle(), event: Events.active() });
  }
  if (pathname === '/api/season' && method === 'PUT') {
    const body = await readEventBody(req);
    const title = String(body.title || '').trim();
    if (title.length > 200) return sendError(res, 400, 'Der Titel darf höchstens 200 Zeichen lang sein');
    const event=Events.metadata(Events.active().id,{title,year:body.year});
    return sendJSON(res, 200, { title:event.title,event });
  }

  // ---- Season reset mit Archiv ----
  if (pathname === '/api/season/reset' && method === 'POST') {
    const body = await readEventBody(req);
    return sendJSON(res, 200, resetSeason(body));
  }
  if (pathname === '/api/season/archives' && method === 'GET') {
    return sendJSON(res, 200, listArchives());
  }
  if ((m = pathname.match(/^\/api\/season\/archives\/([^/]+)$/)) && method === 'GET') {
    const fname = decodeURIComponent(m[1]);
    if (!listArchives().includes(fname) || path.basename(fname)!==fname) return sendError(res, 400, 'Ungueltiger Dateiname');
    const filePath = path.join(ARCHIVE_DIR, fname);
    if (!fs.existsSync(filePath)) return sendError(res, 404, 'Nicht gefunden');
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fname}"`,
    });
    return res.end(content);
  }

  // ---- Info (IP/Port fuer LAN-Zugriff) ----
  if (pathname === '/api/info' && method === 'GET') {
    return sendJSON(res, 200, { port: server.address()?.port || PORT, lan_ips: getLanIPs() });
  }

  return sendError(res, 404, 'Unbekannter Endpoint');
}

const handler = async (req, res) => {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  try {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(parsed.pathname);
  const query = Object.fromEntries(parsed.searchParams);

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, pathname, query);
    } catch (e) {
      if (Number.isInteger(e.status)) sendError(res,e.status,e.message);
      else {
        console.error(e);
        sendError(res,500,'Interner Serverfehler');
      }
    }
    return;
  }

  serveStatic(req, res, pathname);
  } catch { sendError(res,400,'Ungültige Anfrage'); }
};
const server = process.env.SCHUETZEN_TLS_CERT && process.env.SCHUETZEN_TLS_KEY
  ? https.createServer({cert:fs.readFileSync(process.env.SCHUETZEN_TLS_CERT),key:fs.readFileSync(process.env.SCHUETZEN_TLS_KEY)},handler)
  : http.createServer(handler);

if (require.main === module) {
  Backups.startTimer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Schuetzen-Wettkampf-Server laeuft auf Port ${PORT}`);
    const protocol=process.env.SCHUETZEN_TLS_CERT ? 'https' : 'http';
    console.log(`Lokal:   ${protocol}://localhost:${PORT}`);
    for (const ip of getLanIPs()) {
      console.log(`Im LAN:  ${protocol}://${ip}:${PORT}`);
    }
  });
}

module.exports = { server, handleApi };
