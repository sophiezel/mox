'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { forceCloseHttpServer } = require('../lib/force-close-server');

test('forceCloseHttpServer resolves while a keep-alive client is connected', async () => {
  const server = http.createServer((req, res) => {
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r, j) => {
    sock.once('connect', r);
    sock.once('error', j);
  });
  sock.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
  await new Promise((r) => sock.once('data', r));

  const started = Date.now();
  await forceCloseHttpServer(server, { timeoutMs: 400 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `close took too long: ${elapsed}ms`);
  try {
    sock.destroy();
  } catch (_) {
    /* ignore */
  }
});
