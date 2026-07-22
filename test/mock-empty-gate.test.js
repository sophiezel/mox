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
        path: u.pathname + u.search,
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
          resolve({ status: res.statusCode, body, headers: res.headers });
        });
      },
    )
      .on('error', reject)
      .end();
  });
}

test('mock-lab returns 503 for TRACE_EMPTY success envelope', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-empty-gate-'));
  mkStub(
    tmp,
    'api.example.com',
    '/v1/trace-empty',
    `module.exports = () => ({
      response: { code: 0, data: {}, message: '', gap: 'TRACE_EMPTY' },
      httpStatus: 200,
    });`,
  );
  const prevAllow = process.env.MOX_ALLOW_EMPTY_MOCK;
  const prevMode = process.env.MOX_PROXY_MODE;
  delete process.env.MOX_ALLOW_EMPTY_MOCK;
  process.env.MOX_PROXY_MODE = 'mock-lab';
  const srv = await startMockServer({
    mocksRoot: tmp,
    host: '127.0.0.1',
    port: 0,
    mode: 'mock-lab',
  });
  try {
    const res = await httpGet(`${srv.url}/v1/trace-empty`, {
      'x-forwarded-host': 'api.example.com',
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.gap, 'TRACE_EMPTY');
    assert.ok(res.body.code === 503 || res.body.message);
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.MOX_ALLOW_EMPTY_MOCK;
    else process.env.MOX_ALLOW_EMPTY_MOCK = prevAllow;
    if (prevMode === undefined) delete process.env.MOX_PROXY_MODE;
    else process.env.MOX_PROXY_MODE = prevMode;
  }
});

test('MOX_ALLOW_EMPTY_MOCK=1 still returns 200 empty data', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-empty-allow-'));
  mkStub(
    tmp,
    'api.example.com',
    '/v1/trace-empty',
    `module.exports = () => ({
      response: { code: 0, data: {}, message: '', gap: 'TRACE_EMPTY' },
      httpStatus: 200,
    });`,
  );
  const prevAllow = process.env.MOX_ALLOW_EMPTY_MOCK;
  const prevMode = process.env.MOX_PROXY_MODE;
  process.env.MOX_ALLOW_EMPTY_MOCK = '1';
  process.env.MOX_PROXY_MODE = 'mock-lab';
  const srv = await startMockServer({
    mocksRoot: tmp,
    host: '127.0.0.1',
    port: 0,
    mode: 'mock-lab',
  });
  try {
    const res = await httpGet(`${srv.url}/v1/trace-empty`, {
      'x-forwarded-host': 'api.example.com',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 0);
    assert.deepEqual(res.body.data, {});
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.MOX_ALLOW_EMPTY_MOCK;
    else process.env.MOX_ALLOW_EMPTY_MOCK = prevAllow;
    if (prevMode === undefined) delete process.env.MOX_PROXY_MODE;
    else process.env.MOX_PROXY_MODE = prevMode;
  }
});

test('capture-open still returns 200 for empty success envelope', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-empty-rf-'));
  mkStub(
    tmp,
    'api.example.com',
    '/v1/trace-empty',
    `module.exports = () => ({
      response: { code: 0, data: {}, message: '', gap: 'TRACE_EMPTY' },
      httpStatus: 200,
    });`,
  );
  const prevAllow = process.env.MOX_ALLOW_EMPTY_MOCK;
  delete process.env.MOX_ALLOW_EMPTY_MOCK;
  const srv = await startMockServer({
    mocksRoot: tmp,
    host: '127.0.0.1',
    port: 0,
    mode: 'capture-open',
  });
  try {
    const res = await httpGet(`${srv.url}/v1/trace-empty`, {
      'x-forwarded-host': 'api.example.com',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, {});
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.MOX_ALLOW_EMPTY_MOCK;
    else process.env.MOX_ALLOW_EMPTY_MOCK = prevAllow;
  }
});
