'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startMockServer } = require('../runtime/mock-server/server');

function mkStub(root, host, urlPath, source) {
  const dir = path.join(root, host, urlPath.replace(/^\//, ''));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), source);
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    require('http').request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
          resolve({ status: res.statusCode, body });
        });
      },
    )
      .on('error', reject)
      .end();
  });
}

const EMPTY_HANDLER = `module.exports = () => ({
  response: { code: 0, data: {}, message: '', gap: 'TRACE_EMPTY' },
  httpStatus: 200,
});`;

test('serveCaptureIfEmpty off keeps 503', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-sce-off-'));
  mkStub(tmp, 'api.example.com', '/v1/x', EMPTY_HANDLER);
  const capt = path.join(tmp, 'captures');
  fs.mkdirSync(capt, { recursive: true });
  fs.writeFileSync(
    path.join(capt, 'GET__v1__x.json'),
    JSON.stringify({
      method: 'GET',
      path: '/v1/x',
      host: 'api.example.com',
      status: 200,
      responseBody: { code: 0, data: { id: 9 }, message: 'from-capture' },
    }),
  );
  const prev = process.env.MOX_ALLOW_EMPTY_MOCK;
  delete process.env.MOX_ALLOW_EMPTY_MOCK;
  const srv = await startMockServer({
    mocksRoot: tmp,
    host: '127.0.0.1',
    port: 0,
    mode: 'mock-lab',
    serveCaptureIfEmpty: false,
    capturesDir: capt,
  });
  try {
    const res = await httpGet(`${srv.url}/v1/x`, {
      'x-forwarded-host': 'api.example.com',
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.gap, 'TRACE_EMPTY');
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prev === undefined) delete process.env.MOX_ALLOW_EMPTY_MOCK;
    else process.env.MOX_ALLOW_EMPTY_MOCK = prev;
  }
});

test('serveCaptureIfEmpty on returns capture body without writing contract', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-sce-on-'));
  mkStub(tmp, 'api.example.com', '/v1/x', EMPTY_HANDLER);
  const capt = path.join(tmp, 'captures');
  fs.mkdirSync(capt, { recursive: true });
  const capFile = path.join(capt, 'GET__v1__x.json');
  const captureBody = { code: 0, data: { id: 9 }, message: 'from-capture' };
  fs.writeFileSync(
    capFile,
    JSON.stringify({
      method: 'GET',
      path: '/v1/x',
      host: 'api.example.com',
      status: 200,
      responseBody: captureBody,
    }),
  );
  const contractsBefore = fs.existsSync(path.join(tmp, 'contracts'))
    ? fs.readdirSync(path.join(tmp, 'contracts')).length
    : 0;
  const mtimeBefore = fs.statSync(capFile).mtimeMs;
  const prev = process.env.MOX_ALLOW_EMPTY_MOCK;
  delete process.env.MOX_ALLOW_EMPTY_MOCK;
  const srv = await startMockServer({
    mocksRoot: tmp,
    host: '127.0.0.1',
    port: 0,
    mode: 'mock-lab',
    serveCaptureIfEmpty: true,
    capturesDir: capt,
  });
  try {
    const res = await httpGet(`${srv.url}/v1/x`, {
      'x-forwarded-host': 'api.example.com',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, captureBody);
    assert.equal(fs.statSync(capFile).mtimeMs, mtimeBefore);
    const contractsAfter = fs.existsSync(path.join(tmp, 'contracts'))
      ? fs.readdirSync(path.join(tmp, 'contracts')).length
      : 0;
    assert.equal(contractsAfter, contractsBefore);
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prev === undefined) delete process.env.MOX_ALLOW_EMPTY_MOCK;
    else process.env.MOX_ALLOW_EMPTY_MOCK = prev;
  }
});
