'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');
const dns = require('dns');
const {
  startProxyServer,
  isLanBind,
  isLoopbackBind,
  isLoopbackHostname,
} = require('../runtime/proxy/server');

test('isLanBind detects 0.0.0.0', () => {
  assert.equal(isLanBind('0.0.0.0'), true);
  assert.equal(isLanBind('127.0.0.1'), false);
});

test('isLoopbackBind detects loopback hosts', () => {
  assert.equal(isLoopbackBind('127.0.0.1'), true);
  assert.equal(isLoopbackBind('::1'), true);
  assert.equal(isLoopbackBind('0.0.0.0'), false);
});

test('isLoopbackHostname detects CONNECT targets', () => {
  assert.equal(isLoopbackHostname('127.0.0.1'), true);
  assert.equal(isLoopbackHostname('LOCALHOST'), true);
  assert.equal(isLoopbackHostname('[::1]'), true);
  assert.equal(isLoopbackHostname('cdn.example.com'), false);
});

test('proxy on 0.0.0.0 without allowOpenProxy forces missPolicy=reject', async () => {
  const open = await startProxyServer({
    host: '0.0.0.0',
    port: 0,
    mockTarget: 'http://127.0.0.1:9',
    rules: [],
    missPolicy: 'passthrough',
    allowOpenProxy: false,
  });
  try {
    assert.equal(open.missPolicy, 'reject');
  } finally {
    await open.close();
  }
});

test('CONNECT to loopback target is denied on loopback bind', async () => {
  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: 'http://127.0.0.1:9',
    rules: [],
    missPolicy: 'passthrough',
    allowOpenProxy: false,
    passthroughHosts: [],
  });
  try {
    const status = await new Promise((resolve, reject) => {
      const sock = net.connect(proxy.port, '127.0.0.1', () => {
        sock.write(
          'CONNECT 127.0.0.1:8000 HTTP/1.1\r\nHost: 127.0.0.1:8000\r\n\r\n',
        );
      });
      let buf = '';
      sock.on('data', (c) => {
        buf += c.toString('utf8');
        if (buf.includes('\r\n\r\n')) {
          sock.end();
          resolve(buf);
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    assert.match(status, /403 Forbidden/);
  } finally {
    await proxy.close();
  }
});

test('CONNECT on loopback tunnels non-catalog remote HTTPS hosts', async () => {
  const upstream = net.createServer((sock) => sock.end());
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const originalLookup = dns.lookup;
  dns.lookup = (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options || {};
    if (hostname === 'cdn.example.test') {
      if (opts.all) {
        return process.nextTick(() =>
          cb(null, [{ address: '127.0.0.1', family: 4 }]),
        );
      }
      return process.nextTick(() => cb(null, '127.0.0.1', 4));
    }
    return originalLookup.call(dns, hostname, options, callback);
  };

  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: 'http://127.0.0.1:9',
    rules: [],
    missPolicy: 'passthrough',
    allowOpenProxy: false,
    passthroughHosts: [],
  });
  try {
    const status = await new Promise((resolve, reject) => {
      const sock = net.connect(proxy.port, '127.0.0.1', () => {
        sock.write(
          `CONNECT cdn.example.test:${upPort} HTTP/1.1\r\nHost: cdn.example.test:${upPort}\r\n\r\n`,
        );
      });
      let buf = '';
      sock.on('data', (c) => {
        buf += c.toString('utf8');
        if (buf.includes('\r\n\r\n')) {
          sock.end();
          resolve(buf);
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    assert.match(status, /200 Connection Established/);
  } finally {
    dns.lookup = originalLookup;
    await proxy.close();
    await new Promise((r) => upstream.close(r));
  }
});

test('CONNECT on LAN bind denied without allowOpenProxy', async () => {
  const proxy = await startProxyServer({
    host: '0.0.0.0',
    port: 0,
    mockTarget: 'http://127.0.0.1:9',
    rules: [],
    missPolicy: 'passthrough',
    allowOpenProxy: false,
    passthroughHosts: [],
  });
  try {
    const status = await new Promise((resolve, reject) => {
      const sock = net.connect(proxy.port, '127.0.0.1', () => {
        sock.write(
          'CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n',
        );
      });
      let buf = '';
      sock.on('data', (c) => {
        buf += c.toString('utf8');
        if (buf.includes('\r\n\r\n')) {
          sock.end();
          resolve(buf);
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    assert.match(status, /403 Forbidden/);
  } finally {
    await proxy.close();
  }
});

test('CONNECT MITM OPTIONS preflight returns CORS for localhost origin', async () => {
  const { createMitmCa } = require('../lib/mitm-ca');
  const tls = require('tls');
  const ca = createMitmCa();
  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: 'http://127.0.0.1:9',
    rules: [
      {
        id: 'POST svc/api/q',
        hosts: ['svc.example.com'],
        pathPrefix: '/api/q',
        methods: ['POST'],
      },
    ],
    missPolicy: 'passthrough',
    allowOpenProxy: false,
    cors: { allowLocalhost: true },
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
      'CONNECT svc.example.com:443 HTTP/1.1\r\nHost: svc.example.com:443\r\n\r\n',
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
      'OPTIONS /api/q HTTP/1.1\r\n' +
        'Host: svc.example.com\r\n' +
        'Origin: http://127.0.0.1:8000\r\n' +
        'Access-Control-Request-Method: POST\r\n' +
        'Access-Control-Request-Headers: content-type\r\n' +
        '\r\n',
    );

    const resBuf = await new Promise((resolve, reject) => {
      let buf = '';
      tlsSock.on('data', (c) => {
        buf += c.toString('utf8');
        if (buf.includes('\r\n\r\n')) resolve(buf);
      });
      tlsSock.on('error', reject);
      setTimeout(() => reject(new Error(`OPTIONS timeout buf=${buf}`)), 5000);
    });
    assert.match(resBuf, /HTTP\/1\.1 204/);
    assert.match(resBuf, /Access-Control-Allow-Origin:\s*http:\/\/127\.0\.0\.1:8000/i);
    assert.match(resBuf, /Access-Control-Allow-Methods:/i);
    tlsSock.end();
  } finally {
    await proxy.close();
  }
});

test('CONNECT MITM path taken when host covered (pathPrefix irrelevant)', async () => {
  let mitmHost = null;
  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: 'http://127.0.0.1:9',
    rules: [
      {
        id: 'GET svc/api/x',
        hosts: ['svc.example.com'],
        pathPrefix: '/api/x',
        methods: ['GET'],
      },
    ],
    missPolicy: 'passthrough',
    allowOpenProxy: false,
    mitm: {
      enabled: true,
      getSecureContext(hostname) {
        mitmHost = hostname;
        // Force mitm-fail so client gets a finite response (no TLS hang)
        throw new Error('test-skip-tls');
      },
    },
  });
  try {
    const status = await new Promise((resolve, reject) => {
      const sock = net.connect(proxy.port, '127.0.0.1', () => {
        sock.write(
          'CONNECT svc.example.com:443 HTTP/1.1\r\nHost: svc.example.com:443\r\n\r\n',
        );
      });
      let buf = '';
      sock.on('data', (c) => {
        buf += c.toString('utf8');
        if (buf.includes('\r\n\r\n')) {
          sock.end();
          resolve(buf);
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error(`timeout buf=${buf}`)), 3000);
    });
    assert.equal(mitmHost, 'svc.example.com');
    assert.match(status, /502 Bad Gateway/);
    assert.doesNotMatch(status, /403 Forbidden/);
  } finally {
    await proxy.close();
  }
});

test('miss reject returns 404 when missPolicy=reject', async () => {
  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: 'http://127.0.0.1:9',
    rules: [],
    missPolicy: 'reject',
    allowOpenProxy: false,
  });
  try {
    const res = await new Promise((resolve, reject) => {
      http
        .request(
          {
            hostname: '127.0.0.1',
            port: proxy.port,
            path: 'http://api.example.com/nope',
            method: 'GET',
          },
          (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () =>
              resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }),
            );
          },
        )
        .on('error', reject)
        .end();
    });
    assert.equal(res.status, 404);
  } finally {
    await proxy.close();
  }
});

test('GET /mox/ca.cer serves DER CA; /__mox__/ alias still works', async () => {
  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: 'http://127.0.0.1:9',
    rules: [],
    missPolicy: 'reject',
  });
  async function getCa(pathOnly) {
    return new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${proxy.port}${pathOnly}`, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () =>
            resolve({
              status: r.statusCode,
              type: r.headers['content-type'],
              body: Buffer.concat(chunks),
            }),
          );
        })
        .on('error', reject);
    });
  }
  try {
    const res = await getCa('/mox/ca.cer');
    assert.equal(res.status, 200);
    assert.match(String(res.type), /pkix-cert|octet|x-x509/i);
    assert.ok(res.body.length > 100);
    assert.doesNotMatch(res.body.toString('utf8'), /BEGIN CERTIFICATE/);
    const alias = await getCa('/__mox__/ca.cer');
    assert.equal(alias.status, 200);
    assert.equal(alias.body.length, res.body.length);

    // Absolute-form (as phone Wi‑Fi proxy clients send)
    const abs = await new Promise((resolve, reject) => {
      http
        .request(
          {
            hostname: '127.0.0.1',
            port: proxy.port,
            path: `http://10.0.0.2:${proxy.port}/mox/ca.cer`,
            method: 'GET',
          },
          (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () =>
              resolve({ status: r.statusCode, body: Buffer.concat(chunks) }),
            );
          },
        )
        .on('error', reject)
        .end();
    });
    assert.equal(abs.status, 200);
    assert.equal(abs.body.length, res.body.length);
  } finally {
    await proxy.close();
  }
});

test('captureScope=catalog drops uncovered host misses', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const capturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-cap-'));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: `http://127.0.0.1:${upPort}`,
    rules: [
      {
        id: 'r1',
        stubId: 'GET covered/x',
        hosts: ['covered.example.test'],
        pathPrefix: '/x',
        methods: ['GET'],
      },
    ],
    missPolicy: 'passthrough',
    recordMisses: true,
    captureScope: 'catalog',
    capturesDir,
    blockWritePassthrough: false,
  });

  async function proxyGet(absoluteUrl) {
    return new Promise((resolve, reject) => {
      http
        .request(
          {
            hostname: '127.0.0.1',
            port: proxy.port,
            path: absoluteUrl,
            method: 'GET',
          },
          (r) => {
            r.resume();
            r.on('end', () => resolve(r.statusCode));
          },
        )
        .on('error', reject)
        .end();
    });
  }

  try {
    // Uncovered host — passthrough succeeds but catalog scope must not capture
    await proxyGet(`http://127.0.0.1:${upPort}/noise`);
    await new Promise((r) => setTimeout(r, 30));
    const files = fs.readdirSync(capturesDir);
    assert.equal(files.length, 0, `unexpected captures: ${files.join(',')}`);
  } finally {
    await proxy.close();
    await new Promise((r) => upstream.close(r));
    fs.rmSync(capturesDir, { recursive: true, force: true });
  }
});
