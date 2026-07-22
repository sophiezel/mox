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

async function withTempMitmDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-mitm-cap-'));
  const prev = process.env.MOX_MITM_DIR;
  process.env.MOX_MITM_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MOX_MITM_DIR;
    else process.env.MOX_MITM_DIR = prev;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function waitForCaptureRec(dir, { timeoutMs = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8').trim();
        if (!text) continue;
        try {
          return JSON.parse(text);
        } catch {
          /* incomplete write */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
}

test('MITM passthrough records capture with responseBody on catalog host without mock rule', async () => {
  await withTempMitmDir(async () => {
    const { createMitmCa, hostCert, ensureCa } = require('../lib/mitm-ca');
    ensureCa({ forceRegen: true });
    const leaf = hostCert('svc.example.com');
    const expectedBody = { ok: true, n: 42 };

    const upstream = https.createServer(
      { key: leaf.key, cert: leaf.cert },
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(expectedBody));
      },
    );
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = upstream.address().port;

    const originalLookup = dns.lookup;
    dns.lookup = (hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      const opts = typeof options === 'function' ? {} : options || {};
      if (hostname === 'svc.example.com') {
        if (opts.all) {
          return process.nextTick(() =>
            cb(null, [{ address: '127.0.0.1', family: 4 }]),
          );
        }
        return process.nextTick(() => cb(null, '127.0.0.1', 4));
      }
      return originalLookup.call(dns, hostname, options, callback);
    };

    const capturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-caps-'));
    const ca = createMitmCa();
    const proxy = await startProxyServer({
      host: '127.0.0.1',
      port: 0,
      mockTarget: 'http://127.0.0.1:9',
      rules: [
        {
          id: 'GET svc/api/other',
          hosts: ['svc.example.com'],
          pathPrefix: '/api/other',
          methods: ['GET'],
        },
      ],
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
      const raw = net.connect(proxy.port, '127.0.0.1');
      await new Promise((r, j) => {
        raw.once('connect', r);
        raw.once('error', j);
      });
      raw.write(
        `CONNECT svc.example.com:${upPort} HTTP/1.1\r\nHost: svc.example.com:${upPort}\r\n\r\n`,
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
        servername: 'svc.example.com',
        rejectUnauthorized: false,
      });
      await new Promise((r, j) => {
        tlsSock.once('secureConnect', r);
        tlsSock.once('error', j);
      });

      tlsSock.write(
        'GET /api/record-me HTTP/1.1\r\nHost: svc.example.com\r\nConnection: close\r\n\r\n',
      );
      const resBuf = await new Promise((resolve, reject) => {
        let buf = '';
        tlsSock.on('data', (c) => {
          buf += c.toString('utf8');
          if (buf.includes('\r\n\r\n') && buf.includes('{')) resolve(buf);
        });
        tlsSock.on('error', reject);
        tlsSock.on('end', () => resolve(buf));
        setTimeout(() => reject(new Error(`GET timeout buf=${buf}`)), 5000);
      });
      assert.match(resBuf, /HTTP\/1\.1 200/);
      assert.match(resBuf, /"n":\s*42/);

      const rec = await waitForCaptureRec(capturesDir);
      assert.ok(rec, 'expected a capture JSON record');
      assert.equal(rec.host, 'svc.example.com');
      assert.equal(rec.path, '/api/record-me');
      assert.equal(rec.method, 'GET');
      assert.equal(rec.status, 200);
      assert.deepEqual(rec.responseBody, expectedBody);
      tlsSock.end();
    } finally {
      dns.lookup = originalLookup;
      await proxy.close();
      await new Promise((r) => upstream.close(r));
      fs.rmSync(capturesDir, { recursive: true, force: true });
    }
  });
});
