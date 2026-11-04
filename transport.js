'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

function portNumber(value, fallback, name) {
  const port = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} muss eine Portnummer zwischen 0 und 65535 sein.`);
  }
  return port;
}

function createServers(handler, {dataDirectory, env = process.env}) {
  const port = portNumber(env.PORT, 3000, 'PORT');
  const httpsPort = portNumber(env.SCHUETZEN_HTTPS_PORT, 3443, 'SCHUETZEN_HTTPS_PORT');
  const explicit = !!(env.SCHUETZEN_TLS_CERT || env.SCHUETZEN_TLS_KEY);
  const certFile = explicit ? env.SCHUETZEN_TLS_CERT : path.join(dataDirectory, 'tls', 'server-cert.pem');
  const keyFile = explicit ? env.SCHUETZEN_TLS_KEY : path.join(dataDirectory, 'tls', 'server-key.pem');
  if (explicit && (!certFile || !keyFile)) {
    throw new Error('SCHUETZEN_TLS_CERT und SCHUETZEN_TLS_KEY muessen gemeinsam gesetzt werden.');
  }
  const enabled = explicit || fs.existsSync(certFile) || fs.existsSync(keyFile);
  if (enabled && port !== 0 && port === httpsPort) {
    throw new Error('HTTP und HTTPS benoetigen unterschiedliche Ports.');
  }
  const httpsServer = enabled
    ? https.createServer({cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile)}, handler)
    : null;
  return {server: http.createServer(handler), httpsServer, port, httpsPort};
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function startServers({server, httpsServer, port, httpsPort}, host = '0.0.0.0') {
  try {
    await listen(server, port, host);
    if (httpsServer) await listen(httpsServer, httpsPort, host);
  } catch (error) {
    await Promise.all([server, httpsServer].filter(s => s?.listening).map(s => new Promise(resolve => s.close(resolve))));
    throw error;
  }
}

module.exports = {createServers, startServers};
