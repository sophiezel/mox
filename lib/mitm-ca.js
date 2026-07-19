'use strict';

/**
 * Minimal local CA for HTTPS MITM (opt-in).
 * Generates PEM files under .data/mitm/ using Node crypto.
 * Default OFF — session start requires --mitm=1.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getDataRoot, ensureDataDirs } = require('./paths');

function mitmDir() {
  ensureDataDirs();
  const dir = path.join(getDataRoot(), 'mitm');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function opensslAvailable() {
  const r = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  return r.status === 0;
}

function runOpenssl(args, input) {
  const r = spawnSync('openssl', args, {
    input,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`openssl ${args[0]} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

/** Compat: ensureCa() or ensureCa(_ignoredSlug) */
function ensureCa() {
  const dir = mitmDir();
  const keyPath = path.join(dir, 'ca.key.pem');
  const certPath = path.join(dir, 'ca.cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { keyPath, certPath, dir };
  }
  if (!opensslAvailable()) {
    throw new Error(
      'HTTPS MITM requires openssl on PATH to generate a local CA',
    );
  }
  runOpenssl(['genrsa', '-out', keyPath, '2048']);
  runOpenssl([
    'req',
    '-x509',
    '-new',
    '-nodes',
    '-key',
    keyPath,
    '-sha256',
    '-days',
    '3650',
    '-out',
    certPath,
    '-subj',
    '/CN=mox Local MITM CA',
  ]);
  return { keyPath, certPath, dir };
}

/** Compat: hostCert(hostname) or hostCert(_slug, hostname) */
function hostCert(a, b) {
  const hostname = b != null ? b : a;
  const { keyPath: caKey, certPath: caCert, dir } = ensureCa();
  const safe = hostname.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const hostKey = path.join(dir, `${safe}.key.pem`);
  const hostCsr = path.join(dir, `${safe}.csr.pem`);
  const hostCertPath = path.join(dir, `${safe}.cert.pem`);
  const extFile = path.join(dir, `${safe}.ext`);

  if (fs.existsSync(hostKey) && fs.existsSync(hostCertPath)) {
    return {
      key: fs.readFileSync(hostKey),
      cert: fs.readFileSync(hostCertPath),
      ca: fs.readFileSync(caCert),
    };
  }

  runOpenssl(['genrsa', '-out', hostKey, '2048']);
  runOpenssl([
    'req',
    '-new',
    '-key',
    hostKey,
    '-out',
    hostCsr,
    '-subj',
    `/CN=${hostname}`,
  ]);
  fs.writeFileSync(
    extFile,
    `basicConstraints=CA:FALSE\nsubjectAltName=DNS:${hostname}\nextendedKeyUsage=serverAuth\n`,
  );
  runOpenssl([
    'x509',
    '-req',
    '-in',
    hostCsr,
    '-CA',
    caCert,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-out',
    hostCertPath,
    '-days',
    '825',
    '-sha256',
    '-extfile',
    extFile,
  ]);
  return {
    key: fs.readFileSync(hostKey),
    cert: fs.readFileSync(hostCertPath),
    ca: fs.readFileSync(caCert),
  };
}

/** Compat: createMitmCa() or createMitmCa(_ignoredSlug) */
function createMitmCa() {
  const tls = require('tls');
  const { certPath } = ensureCa();
  const cache = new Map();

  return {
    caCertPath: certPath,
    getSecureContext(hostname) {
      if (cache.has(hostname)) return cache.get(hostname);
      const pems = hostCert(hostname);
      const ctx = tls.createSecureContext({
        key: pems.key,
        cert: Buffer.concat([pems.cert, pems.ca]),
        ca: pems.ca,
      });
      cache.set(hostname, ctx);
      return ctx;
    },
  };
}

module.exports = {
  createMitmCa,
  ensureCa,
  hostCert,
  mitmDir,
  opensslAvailable,
};
