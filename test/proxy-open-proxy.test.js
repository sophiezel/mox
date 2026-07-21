'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');
const {
  startProxyServer,
  isLanBind,
  isLoopbackBind,
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

test('CONNECT on loopback tunnels non-catalog HTTPS hosts', async () => {
  const upstream = net.createServer((sock) => sock.end());
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;

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
        // localhost — CONNECT url parser splits on first ":"
        sock.write(
          `CONNECT localhost:${upPort} HTTP/1.1\r\nHost: localhost:${upPort}\r\n\r\n`,
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
