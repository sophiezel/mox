'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dns = require('dns');
const https = require('https');
const tls = require('tls');
const { startProxyServer } = require('../runtime/proxy/server');
const { reportsDir } = require('../lib/paths');

async function withTempDataRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-ufj-'));
  const mitm = path.join(root, 'mitm');
  fs.mkdirSync(mitm, { recursive: true });
  const prevData = process.env.MOX_DATA_ROOT;
  const prevMitm = process.env.MOX_MITM_DIR;
  process.env.MOX_DATA_ROOT = root;
  process.env.MOX_MITM_DIR = mitm;
  try {
    return await fn(root);
  } finally {
    if (prevData === undefined) delete process.env.MOX_DATA_ROOT;
    else process.env.MOX_DATA_ROOT = prevData;
    if (prevMitm === undefined) delete process.env.MOX_MITM_DIR;
    else process.env.MOX_MITM_DIR = prevMitm;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function journalPath() {
  return path.join(reportsDir(), 'upstream-failures.jsonl');
}

async function waitForJournalLine({ timeoutMs = 3000 } = {}) {
  const file = journalPath();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) {
      const lines = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length) {
        return lines.map((l) => JSON.parse(l));
      }
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return [];
}

async function mitmGet(proxyPort, authority, hostHeader, pathName) {
  const raw = net.connect(proxyPort, '127.0.0.1');
  await new Promise((r, j) => {
    raw.once('connect', r);
    raw.once('error', j);
  });
  raw.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
  );
  await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (c) => {
      buf += c.toString('utf8');
      if (buf.includes('\r\n\r\n')) {
        raw.off('data', onData);
        if (/200 Connection Established/i.test(buf)) resolve();
        else reject(new Error(buf));
      }
    };
    raw.on('data', onData);
    raw.on('error', reject);
    setTimeout(() => reject(new Error('CONNECT timeout')), 5000);
  });

  const tlsSock = tls.connect({
    socket: raw,
    servername: hostHeader,
    rejectUnauthorized: false,
  });
  await new Promise((r, j) => {
    tlsSock.once('secureConnect', r);
    tlsSock.once('error', j);
  });

  tlsSock.write(
    `GET ${pathName} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`,
  );
  return new Promise((resolve) => {
    let buf = '';
    tlsSock.on('data', (c) => {
      buf += c.toString('utf8');
    });
    tlsSock.on('end', () => resolve(buf));
    tlsSock.on('error', () => resolve(buf));
    setTimeout(() => resolve(buf), 5000);
  });
}

test('upstream failure journal appends JSON line on mitm upstream error', async () => {
  await withTempDataRoot(async () => {
    const { createMitmCa } = require('../lib/mitm-ca');
    const ca = createMitmCa();

    // Bind and immediately close to get a free port that refuses connections.
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = probe.address().port;
    await new Promise((r) => probe.close(r));

    const originalLookup = dns.lookup;
    dns.lookup = (hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      const opts = typeof options === 'function' ? {} : options || {};
      if (hostname === 'fail.example.com') {
        if (opts.all) {
          return process.nextTick(() =>
            cb(null, [{ address: '127.0.0.1', family: 4 }]),
          );
        }
        return process.nextTick(() => cb(null, '127.0.0.1', 4));
      }
      return originalLookup.call(dns, hostname, options, callback);
    };

    const capturesDir = path.join(process.env.MOX_DATA_ROOT, 'captures');
    fs.mkdirSync(capturesDir, { recursive: true });

    const proxy = await startProxyServer({
      host: '127.0.0.1',
      port: 0,
      mockTarget: 'http://127.0.0.1:9',
      rules: [
        {
          id: 'GET fail/api',
          hosts: [`fail.example.com:${deadPort}`],
          pathPrefix: '/',
          methods: ['GET'],
        },
      ],
      trafficMode: 'all-passthrough',
      missPolicy: 'passthrough',
      allowOpenProxy: false,
      captureScope: 'catalog',
      recordMisses: true,
      capturesDir,
      rejectUnauthorized: false,
      mitm: {
        enabled: true,
        getSecureContext: (h) => ca.getSecureContext(h),
      },
    });

    try {
      const resBuf = await mitmGet(
        proxy.port,
        `fail.example.com:${deadPort}`,
        'fail.example.com',
        '/api/x',
      );
      assert.match(resBuf, /HTTP\/1\.1 502/);

      const rows = await waitForJournalLine();
      assert.ok(rows.length >= 1, 'expected journal line');
      const row = rows[0];
      assert.equal(row.host, 'fail.example.com');
      assert.equal(row.method, 'GET');
      assert.match(String(row.path || ''), /\/api\/x/);
      assert.ok(row.error || row.message, 'expected error message');
      assert.ok(row.at, 'expected timestamp');
      assert.equal(row.kind, 'connect-error');
    } finally {
      dns.lookup = originalLookup;
      await proxy.close();
    }
  });
});

test('upstream failure journal appends JSON line on HTTP status >= 400', async () => {
  await withTempDataRoot(async () => {
    const { createMitmCa, hostCert } = require('../lib/mitm-ca');
    const ca = createMitmCa();
    const leaf = hostCert('bad.example.com');

    const upstream = https.createServer(
      { key: leaf.key, cert: leaf.cert },
      (req, res) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 503, message: 'unavailable' }));
      },
    );
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = upstream.address().port;

    const originalLookup = dns.lookup;
    dns.lookup = (hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      const opts = typeof options === 'function' ? {} : options || {};
      if (hostname === 'bad.example.com') {
        if (opts.all) {
          return process.nextTick(() =>
            cb(null, [{ address: '127.0.0.1', family: 4 }]),
          );
        }
        return process.nextTick(() => cb(null, '127.0.0.1', 4));
      }
      return originalLookup.call(dns, hostname, options, callback);
    };

    const capturesDir = path.join(process.env.MOX_DATA_ROOT, 'captures');
    fs.mkdirSync(capturesDir, { recursive: true });

    const proxy = await startProxyServer({
      host: '127.0.0.1',
      port: 0,
      mockTarget: 'http://127.0.0.1:9',
      rules: [
        {
          id: 'GET bad/down',
          hosts: [`bad.example.com:${upPort}`],
          pathPrefix: '/',
          methods: ['GET'],
        },
      ],
      trafficMode: 'all-passthrough',
      missPolicy: 'passthrough',
      allowOpenProxy: false,
      captureScope: 'catalog',
      recordMisses: true,
      capturesDir,
      rejectUnauthorized: false,
      mitm: {
        enabled: true,
        getSecureContext: (h) => ca.getSecureContext(h),
      },
    });

    try {
      const resBuf = await mitmGet(
        proxy.port,
        `bad.example.com:${upPort}`,
        'bad.example.com',
        '/down',
      );
      assert.match(resBuf, /HTTP\/1\.1 503/);

      const rows = await waitForJournalLine();
      assert.ok(rows.length >= 1, 'expected journal line for HTTP>=400');
      const row = rows.find((r) => Number(r.status) >= 400) || rows[0];
      assert.equal(row.host, 'bad.example.com');
      assert.ok(Number(row.status) >= 400);
      assert.match(String(row.path || ''), /\/down/);
      assert.equal(row.kind, 'http-error');
      assert.ok(row.at);
    } finally {
      dns.lookup = originalLookup;
      await proxy.close();
      await new Promise((r) => upstream.close(r));
    }
  });
});
