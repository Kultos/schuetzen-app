'use strict';

const http = require('node:http');
const url = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  Shooters,
  Disciplines,
  Results,
  Season,
  rankingForDiscipline,
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

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 20 * 1024 * 1024) {
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

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
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

  // ---- Shooters ----
  if (pathname === '/api/shooters' && method === 'GET') {
    return sendJSON(res, 200, Shooters.list());
  }
  if (pathname === '/api/shooters' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name || !body.gender) return sendError(res, 400, 'name und gender erforderlich');
    if (!['m', 'w'].includes(body.gender)) return sendError(res, 400, "gender muss 'm' oder 'w' sein");
    return sendJSON(res, 201, Shooters.create({ name: body.name.trim(), gender: body.gender }));
  }
  let m;
  if ((m = pathname.match(/^\/api\/shooters\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PUT') {
      const body = await readBody(req);
      return sendJSON(res, 200, Shooters.update(id, { name: body.name, gender: body.gender }));
    }
    if (method === 'DELETE') {
      Shooters.remove(id);
      return sendJSON(res, 200, { ok: true });
    }
  }

  // ---- Disciplines ----
  if (pathname === '/api/disciplines' && method === 'GET') {
    return sendJSON(res, 200, Disciplines.list());
  }
  if (pathname === '/api/disciplines' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name) return sendError(res, 400, 'name erforderlich');
    return sendJSON(res, 201, Disciplines.create({ name: body.name.trim() }));
  }
  if ((m = pathname.match(/^\/api\/disciplines\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PUT') {
      const body = await readBody(req);
      return sendJSON(res, 200, Disciplines.update(id, { name: body.name }));
    }
    if (method === 'DELETE') {
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
    const body = await readBody(req);
    const { shooter_id, discipline_id, points } = body;
    if (!shooter_id || !discipline_id || points === undefined || points === null || points === '') {
      return sendError(res, 400, 'shooter_id, discipline_id und points erforderlich');
    }
    const round_number = body.round_number || Results.nextRoundNumber(shooter_id, discipline_id);
    return sendJSON(res, 201, Results.create({ shooter_id, discipline_id, round_number, points: Number(points) }));
  }
  if ((m = pathname.match(/^\/api\/results\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PUT') {
      const body = await readBody(req);
      return sendJSON(res, 200, Results.update(id, { points: Number(body.points), round_number: body.round_number }));
    }
    if (method === 'DELETE') {
      Results.remove(id);
      return sendJSON(res, 200, { ok: true });
    }
  }

  // ---- Rankings ----
  if ((m = pathname.match(/^\/api\/rankings\/(\d+)$/)) && method === 'GET') {
    const disciplineId = Number(m[1]);
    return sendJSON(res, 200, rankingForDiscipline(disciplineId));
  }

  // ---- Import ----
  if (pathname === '/api/import' && method === 'POST') {
    const body = await readBody(req);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    let created = { shooters: 0, disciplines: 0, results: 0 };
    let errors = [];
    for (const [i, row] of rows.entries()) {
      try {
        const name = String(row.name || '').trim();
        const genderRaw = String(row.gender || '').trim().toLowerCase();
        const disciplineName = String(row.discipline || '').trim();
        const points = Number(row.points);
        if (!name || !disciplineName || Number.isNaN(points)) {
          errors.push({ row: i + 1, message: 'Name, Disziplin oder Punkte fehlen/ungueltig' });
          continue;
        }
        const gender = genderRaw.startsWith('w') || genderRaw.startsWith('f') ? 'w' : 'm';

        let shooter = Shooters.findByName(name);
        if (!shooter) {
          shooter = Shooters.create({ name, gender });
          created.shooters++;
        }
        let discipline = Disciplines.findByName(disciplineName);
        if (!discipline) {
          discipline = Disciplines.create({ name: disciplineName });
          created.disciplines++;
        }
        const round_number = row.round ? Number(row.round) : Results.nextRoundNumber(shooter.id, discipline.id);
        Results.create({ shooter_id: shooter.id, discipline_id: discipline.id, round_number, points });
        created.results++;
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
    return sendJSON(res, 200, restoreSeasonArchive(body.archive));
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
    return sendJSON(res, 200, { title: Season.getTitle() });
  }
  if (pathname === '/api/season' && method === 'PUT') {
    const body = await readBody(req);
    const title = String(body.title || '').trim();
    if (title.length > 200) return sendError(res, 400, 'Der Titel darf höchstens 200 Zeichen lang sein');
    return sendJSON(res, 200, { title: Season.setTitle(title) });
  }

  // ---- Season reset mit Archiv ----
  if (pathname === '/api/season/reset' && method === 'POST') {
    const body = await readBody(req);
    const archivePath = archiveCurrentSeason(body.label || Season.getTitle());
    resetSeason();
    return sendJSON(res, 200, { ok: true, archive: path.basename(archivePath) });
  }
  if (pathname === '/api/season/archives' && method === 'GET') {
    return sendJSON(res, 200, listArchives());
  }
  if ((m = pathname.match(/^\/api\/season\/archives\/([^/]+)$/)) && method === 'GET') {
    const fname = decodeURIComponent(m[1]);
    if (fname.includes('..') || fname.includes('/')) return sendError(res, 400, 'Ungueltiger Dateiname');
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
    return sendJSON(res, 200, { port: PORT, lan_ips: getLanIPs() });
  }

  return sendError(res, 404, 'Unbekannter Endpoint');
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, pathname, parsed.query);
    } catch (e) {
      sendError(res, 500, e.message || 'Serverfehler');
    }
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Schuetzen-Wettkampf-Server laeuft auf Port ${PORT}`);
  console.log(`Lokal:   http://localhost:${PORT}`);
  for (const ip of getLanIPs()) {
    console.log(`Im LAN:  http://${ip}:${PORT}`);
  }
});
