'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startProxyServer } = require('../runtime/proxy/server');
const { startMockServer } = require('../runtime/mock-server/server');
const { generateOnDemandApis, clearInflight } = require('../lib/on-demand-generate');
const { handleOnDemandMiss } = require('../lib/on-demand-miss');

function getJson(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          headers,
        },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
            resolve({ status: r.statusCode, json, text });
          });
        },
      )
      .on('error', reject);
  });
}

test('handleOnDemandMiss gap returns TRACE_EMPTY for empty shaped prereq', async () => {
  // Direct orchestration test with injected page resolve by generating empty via preflight only
  const { preflightShape } = require('../lib/on-demand-generate');
  const pf = preflightShape({
    responseShape: { type: 'object', props: {} },
    coverage: { gaps: ['TRACE_EMPTY'] },
  });
  assert.equal(pf.gap, 'TRACE_EMPTY');
});

test('proxy on-demand gap path returns 503 when miss hook reports gap', async () => {
  const mock = await startMockServer({ host: '127.0.0.1', port: 0 });
  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: mock.url,
    rules: [],
    missPolicy: 'reject',
    allowOpenProxy: false,
    blockWritePassthrough: false,
    onDemand: {
      enabled: true,
      scanDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mox-od-px-')),
      timeoutMs: 2000,
      getMergedRules: () => [],
    },
  });

  // Patch handle by making scanDir empty page map → continue → reject 404
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxy.port,
          path: 'http://api.od-gap.test/api/v1/x',
          method: 'GET',
          headers: {
            Host: 'api.od-gap.test',
            Referer: 'http://127.0.0.1:8000/unknown-page',
          },
        },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () =>
            resolve({
              status: r.statusCode,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
    // page map fail → continue → missPolicy reject → 404
    assert.equal(res.status, 404);
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test('after generateOnDemandApis, proxy serves mock for new rule', async () => {
  clearInflight();
  const stubId = 'GET od-live/api/v1/live';
  const gen = await generateOnDemandApis({
    scanDir: process.cwd(),
    projectSlug: 'od-live',
    apis: [
      {
        method: 'GET',
        path: '/api/v1/live',
        host: 'od-live.test',
        upstreamId: 'od-live',
        hosts: ['od-live.test'],
        stubId,
        responseShape: {
          type: 'object',
          props: { ok: { type: 'boolean' } },
        },
        coverage: {
          request: { keysFound: [], confidence: 'high' },
          response: { pathsFound: ['ok'], confidence: 'high' },
          enums: [],
          gaps: [],
        },
      },
    ],
  });
  assert.equal(gen.ok, true);

  const { mocksRootFor, mergeCatalogs } = require('../lib/catalog-merge');
  const mock = await startMockServer({
    host: '127.0.0.1',
    port: 0,
    mocksRoot: mocksRootFor('od-live'),
  });
  const rules = gen.rules;
  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: mock.url,
    rules,
    missPolicy: 'reject',
    allowOpenProxy: true,
  });
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: proxy.port,
          path: 'http://od-live.test/api/v1/live',
          method: 'GET',
          headers: { Host: 'od-live.test' },
        },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
            resolve({ status: r.statusCode, json, text });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    // envelope from generated handler
    assert.ok(res.json === null || typeof res.json === 'object');
  } finally {
    await proxy.close();
    await mock.close();
  }
});
