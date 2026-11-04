'use strict';

const {generateKeyPairSync, sign} = require('node:crypto');

// Generate disposable X.509 material without OpenSSL or a Windows certificate-store entry.
function certificateFor(addresses = ['127.0.0.1']) {
  const der = (tag, ...parts) => {
    const body = Buffer.concat(parts);
    let length = body.length;
    const bytes = [];
    do { bytes.unshift(length & 255); length >>>= 8; } while (length);
    return Buffer.concat([Buffer.from([tag, ...(body.length < 128 ? [body.length] : [128 + bytes.length, ...bytes])]), body]);
  };
  const seq = (...parts) => der(0x30, ...parts);
  const oid = hex => der(0x06, Buffer.from(hex, 'hex'));
  const integer = value => der(0x02, Buffer.from([value]));
  const algorithm = seq(oid('2a864886f70d01010b'), der(0x05));
  const name = seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from('localhost')))));
  const time = offset => der(0x17, Buffer.from(new Date(Date.now() + offset).toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const extensions = der(0xa3, seq(
    seq(oid('551d13'), der(0x01, Buffer.from([255])), der(0x04, seq(der(0x01, Buffer.from([255]))))),
    seq(oid('551d11'), der(0x04, seq(
      der(0x82, Buffer.from('localhost')),
      ...addresses.map(ip => der(0x87, Buffer.from(ip.split('.').map(Number)))),
    ))),
  ));
  const tbs = seq(
    der(0xa0, integer(2)), integer(1), algorithm, name,
    seq(time(-86400000), time(7 * 86400000)), name,
    publicKey.export({format: 'der', type: 'spki'}), extensions,
  );
  const certificate = seq(tbs, algorithm, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  const cert = `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  const key = privateKey.export({format: 'pem', type: 'pkcs8'});
  return {cert, key};
}

module.exports = {certificateFor};
