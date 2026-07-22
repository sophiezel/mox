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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-rmh-'));
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

test('capture-open MITMs host on captureMitmHosts without path rule', async () => {
  await withTempMitmDir(async () => {
    const { createMitmCa, hostCert } = require('../lib/mitm-ca');
    const ca = createMitmCa();
    const leaf = hostCert('rec.example.com');

    const upstream = https.createServer(
      { key: leaf.key, cert: leaf.cert },
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
    );
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = upstream.address().port;

    const originalLookup = dns.lookup;
    dns.lookup = (hostname, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      const opts = typeof options === 'function' ? {} : options || {};
      if (hostname === 'rec.example.com') {
        if (opts.all) {
          return process.nextTick(() =>
            cb(null, [{ address: '127.0.0.1', family: 4 }]),
          );
        }
        return process.nextTick(() => cb(null, '127.0.0.1', 4));
      }
      return originalLookup.call(dns, hostname, options, callback);
    };

    const capturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-rmh-cap-'));
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => {
      logs.push(a.join(' '));
      origLog(...a);
    };

    const proxy = await startProxyServer({
      host: '127.0.0.1',
      port: 0,
      mockTarget: 'http://127.0.0.1:9',
      rules: [], // no path rule / catalog coverage
      missPolicy: 'passthrough',
      allowOpenProxy: true,
      mode: 'capture-open',
      captureMitmHosts: ['rec.example.com'],
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
        `CONNECT rec.example.com:${upPort} HTTP/1.1\r\nHost: rec.example.com:${upPort}\r\n\r\n`,
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

      assert.ok(
        logs.some((l) => /connect-mitm/.test(l)),
        `expected connect-mitm in logs: ${logs.filter((l) => /connect/.test(l)).join(' | ')}`,
      );

      const tlsSock = tls.connect({
        socket: raw,
        servername: 'rec.example.com',
        rejectUnauthorized: false,
      });
      await new Promise((r, j) => {
        tlsSock.once('secureConnect', r);
        tlsSock.once('error', j);
      });
      tlsSock.write(
        'GET /ping HTTP/1.1\r\nHost: rec.example.com\r\nConnection: close\r\n\r\n',
      );
      const resBuf = await new Promise((resolve, reject) => {
        let buf = '';
        tlsSock.on('data', (c) => {
          buf += c.toString('utf8');
        });
        tlsSock.on('end', () => resolve(buf));
        tlsSock.on('error', reject);
        setTimeout(() => reject(new Error(`timeout ${buf}`)), 5000);
      });
      assert.match(resBuf, /HTTP\/1\.1 200/);
      assert.match(resBuf, /"ok":\s*true/);
    } finally {
      console.log = origLog;
      dns.lookup = originalLookup;
      await proxy.close();
      await new Promise((r) => upstream.close(r));
      fs.rmSync(capturesDir, { recursive: true, force: true });
    }
  });
});
