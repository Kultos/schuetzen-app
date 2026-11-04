'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const {before, after, test} = require('node:test');
const {certificateFor} = require('./helpers/tls-certificate');
const {createServers, startServers: startTransport} = require('../transport');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schuetzen-https-'));
const lanIp = Object.values(os.networkInterfaces()).flat().find(net => net.family === 'IPv4' && !net.internal)?.address;
const {cert, key} = certificateFor(['127.0.0.1', ...(lanIp ? [lanIp] : [])]);
fs.mkdirSync(path.join(directory, 'tls'));
fs.writeFileSync(path.join(directory, 'tls', 'server-cert.pem'), cert);
fs.writeFileSync(path.join(directory, 'tls', 'server-key.pem'), key);
process.env.SCHUETZEN_DATA_DIR = directory;
process.env.PORT = '0';
process.env.SCHUETZEN_HTTPS_PORT = '0';
delete process.env.SCHUETZEN_TLS_CERT;
delete process.env.SCHUETZEN_TLS_KEY;
delete process.env.SCHUETZEN_BACKUP_DIR;
const {server, httpsServer, startServers} = require('../server');
const {db, Events} = require('../db');
let secureCookie;
const password = 'test-password-https-12345';

function request(secure, pathname, {host = '127.0.0.1', method = 'GET', headers = {}, json} = {}) {
  return new Promise((resolve, reject) => {
    const payload = json === undefined ? undefined : JSON.stringify(json);
    const req = (secure ? https : http).request({
      hostname: host,
      port: (secure ? httpsServer : server).address().port,
      path: pathname, method, ca: cert,
      headers: {'X-Schuetzen-Request': '1', ...(payload ? {'Content-Type': 'application/json'} : {}), ...headers},
      timeout: 5000,
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text}));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.end(payload);
  });
}

before(async () => {
  await startServers();
  const setup = await request(false, '/api/auth/setup', {method: 'POST', json: {password}});
  assert.equal(setup.status, 200);
  const login = await request(true, '/api/auth/login', {method: 'POST', json: {password}});
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /; Secure$/);
  secureCookie = login.headers['set-cookie'][0].split(';')[0];
});

after(async () => {
  await Promise.all([server, httpsServer].map(s => new Promise(resolve => s.close(resolve))));
  db.close();
  fs.rmSync(directory, {recursive: true, force: true});
});

test('HTTP and trusted HTTPS run concurrently and share competition data', async () => {
  assert.equal((await request(false, '/dashboard')).status, 200);
  assert.equal((await request(false, '/api/health')).status, 200);
  assert.equal((await request(true, '/api/health')).status, 200);
  assert.equal((await request(true, '/api/people')).status, 401);
  const headers = {Cookie: secureCookie, 'X-Event-Id': String(Events.active().id)};
  const created = await request(true, '/api/shooters', {method: 'POST', headers, json: {name: 'HTTPS Teilnehmer', gender: 'w'}});
  assert.equal(created.status, 201);
  const dashboard = await request(false, '/api/dashboard');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.stats.shooters, 1);
  const info = await request(true, '/api/info', {headers});
  assert.equal(info.body.port, server.address().port);
  assert.equal(info.body.https_port, httpsServer.address().port);
  const wrongOrigin = await request(true, '/api/shooters', {
    method: 'POST', headers: {...headers, Origin: `http://127.0.0.1:${server.address().port}`},
    json: {name: 'Falscher Ursprung', gender: 'm'},
  });
  assert.equal(wrongOrigin.status, 403);
});

test('LAN HTTP allows the dashboard but blocks management even with a valid HTTPS session', {skip: !lanIp}, async () => {
  const options = {host: lanIp, headers: {Cookie: secureCookie, 'X-Forwarded-Proto': 'https'}};
  assert.equal((await request(false, '/dashboard', options)).status, 200);
  assert.equal((await request(false, '/api/dashboard', options)).status, 200);
  assert.equal((await request(false, '/api/people', options)).status, 403);
  assert.equal((await request(false, '/api/auth/login', {...options, method: 'POST', json: {password}})).status, 401);
  assert.equal((await request(false, '/api/auth/status', options)).body.secure, false);
  assert.equal((await request(true, '/api/people', options)).status, 200);
});

test('TLS configuration rejects incomplete, invalid, mismatched or conflicting settings', () => {
  const options = env => ({dataDirectory: directory, env});
  const certFile = path.join(directory, 'tls', 'server-cert.pem');
  assert.throws(() => createServers(() => {}, options({SCHUETZEN_TLS_CERT: certFile})), /gemeinsam/);
  assert.throws(() => createServers(() => {}, options({PORT: '3443'})), /unterschiedliche Ports/);
  assert.throws(() => createServers(() => {}, options({PORT: 'abc'})), /Portnummer/);
  assert.throws(() => createServers(() => {}, options({SCHUETZEN_HTTPS_PORT: '65536'})), /Portnummer/);
  const wrongKey = path.join(directory, 'wrong-key.pem');
  fs.writeFileSync(wrongKey, certificateFor().key);
  assert.throws(() => createServers(() => {}, options({SCHUETZEN_TLS_CERT: certFile, SCHUETZEN_TLS_KEY: wrongKey})), /key values mismatch/);
  const invalidCert = path.join(directory, 'invalid-cert.pem');
  fs.writeFileSync(invalidCert, 'invalid');
  assert.throws(() => createServers(() => {}, options({SCHUETZEN_TLS_CERT: invalidCert, SCHUETZEN_TLS_KEY: wrongKey})));
  assert.throws(() => createServers(() => {}, options({SCHUETZEN_TLS_CERT: 'missing-cert', SCHUETZEN_TLS_KEY: 'missing-key'})), /ENOENT/);
  const emptyDirectory = path.join(directory, 'empty');
  const plain = createServers(() => {}, {dataDirectory: emptyDirectory, env: {}});
  assert.equal(plain.httpsServer, null);
  assert.equal(plain.port, 3000);
  assert.equal(plain.httpsPort, 3443);
  fs.mkdirSync(path.join(emptyDirectory, 'tls'), {recursive: true});
  fs.writeFileSync(path.join(emptyDirectory, 'tls', 'server-cert.pem'), cert);
  assert.throws(() => createServers(() => {}, {dataDirectory: emptyDirectory, env: {}}), /ENOENT/);
});

test('A busy HTTPS port also closes the HTTP listener on startup failure', async t => {
  const occupied = http.createServer();
  await new Promise(resolve => occupied.listen(0, '0.0.0.0', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const listeners = createServers(() => {}, {dataDirectory: directory, env: {PORT: '0', SCHUETZEN_HTTPS_PORT: String(occupied.address().port)}});
  await assert.rejects(startTransport(listeners), {code: 'EADDRINUSE'});
  assert.equal(listeners.server.listening, false);
  assert.equal(listeners.httpsServer.listening, false);
});
