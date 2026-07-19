'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { serviceDataDir, stubHandlerPath, serviceContractPath } = require('../lib/paths');
const { generateMocks } = require('../scripts/generate-mock');

function withTempServices(fn) {
  const label = `dead-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    return fn(label);
  } finally {
    try {
      fs.rmSync(serviceDataDir('dead-svc'), { recursive: true, force: true });
    } catch {
      /* ignore busy dirs */
    }
  }
}

function makeRole(overrides = {}) {
  return {
    role: 'dependency',
    method: 'GET',
    path: '/v1/items',
    upstreamId: 'dead-svc',
    hosts: ['svc-a.example.com'],
    canonicalHost: 'svc-a.example.com',
    stubId: 'GET dead-svc/v1/items',
    exportHint: 'getList',
    responseShape: { type: 'object', props: {} },
    coverage: {
      request: { keysFound: [], confidence: 'low' },
      response: { pathsFound: [], confidence: 'low' },
      enums: [],
      gaps: [],
    },
    evidences: ['src/api.js:1'],
    ...overrides,
  };
}

test('P3-D1: empty + no_callsite → contract-only (no handler, no proxy rule)', () => {
  withTempServices((slug) => {
    const role = makeRole({
      coverage: {
        request: { keysFound: [], confidence: 'low' },
        response: { pathsFound: [], confidence: 'low' },
        enums: [],
        gaps: ['no_callsite'],
      },
    });
    const gen = generateMocks({
      projectSlug: slug, roles: [role], force: true, merge: false,
    });
    assert.ok(gen.skippedEmptyCount >= 1, 'no_callsite+empty should be skippedEmpty');

    // Contract written
    assert.ok(fs.existsSync(serviceContractPath('dead-svc', 'GET dead-svc/v1/items')), 'contract written');

    // No handler file
    const handlerFile = stubHandlerPath(slug, 'dead-svc', 'GET', '/v1/items');
    assert.ok(!fs.existsSync(handlerFile), 'no handler for dead export');

    // No proxy rule under service catalog
    const rulesPath = path.join(serviceDataDir('dead-svc'), 'proxy-rules.json');
    const arr = fs.existsSync(rulesPath)
      ? JSON.parse(fs.readFileSync(rulesPath, 'utf8'))
      : [];
    assert.ok(!arr.some((r) => r.stubId === 'GET dead-svc/v1/items'), 'no proxy rule for dead export');
  });
});

test('P3-D2: empty + no_export_symbol → contract-only (existing behavior preserved)', () => {
  withTempServices((slug) => {
    const role = makeRole({
      coverage: {
        request: {}, response: {}, enums: [],
        gaps: ['no_export_symbol'],
      },
    });
    const gen = generateMocks({
      projectSlug: slug, roles: [role], force: true, merge: false,
    });
    assert.ok(gen.skippedEmptyCount >= 1);
    assert.ok(fs.existsSync(serviceContractPath('dead-svc', 'GET dead-svc/v1/items')));
    const handlerFile = stubHandlerPath(slug, 'dead-svc', 'GET', '/v1/items');
    assert.ok(!fs.existsSync(handlerFile));
  });
});

test('P3-D3: empty + TRACE_EMPTY (callsite exists) → still renders handler (not contract-only)', () => {
  withTempServices((slug) => {
    const role = makeRole({
      coverage: {
        request: { keysFound: [], confidence: 'low' },
        response: { pathsFound: [], confidence: 'low' },
        enums: [],
        gaps: ['TRACE_EMPTY'],
      },
    });
    const gen = generateMocks({
      projectSlug: slug, roles: [role], force: true, merge: false,
    });
    // TRACE_EMPTY means callsite exists — keep handler so capture-merge can fill it
    assert.equal(gen.skippedEmptyCount, 0, 'TRACE_EMPTY should NOT be contract-only');
    const handlerFile = stubHandlerPath(slug, 'dead-svc', 'GET', '/v1/items');
    assert.ok(fs.existsSync(handlerFile), 'handler kept for TRACE_EMPTY');
    const rules = JSON.parse(
      fs.readFileSync(path.join(serviceDataDir('dead-svc'), 'proxy-rules.json'), 'utf8'),
    );
    const arr = Array.isArray(rules) ? rules : (rules.rules || []);
    assert.ok(arr.some((r) => r.stubId === 'GET dead-svc/v1/items'), 'proxy rule kept');
  });
});

test('P3-D4: empty + no_callsite + TRACE_EMPTY → contract-only (no_callsite dominates; dead export)', () => {
  withTempServices((slug) => {
    // Both gaps: no_callsite wins — it's a dead export regardless of trace state
    const role = makeRole({
      coverage: {
        request: {}, response: {}, enums: [],
        gaps: ['no_callsite', 'TRACE_EMPTY'],
      },
    });
    const gen = generateMocks({
      projectSlug: slug, roles: [role], force: true, merge: false,
    });
    assert.ok(gen.skippedEmptyCount >= 1, 'no_callsite+empty → contract-only even with TRACE_EMPTY');
    const handlerFile = stubHandlerPath(slug, 'dead-svc', 'GET', '/v1/items');
    assert.ok(!fs.existsSync(handlerFile));
  });
});

test('P3-D5: non-empty shape + no_callsite → still renders handler (shape exists, not dead)', () => {
  withTempServices((slug) => {
    const role = makeRole({
      responseShape: { type: 'object', props: { id: { type: 'string' } } },
      coverage: {
        request: {}, response: { pathsFound: ['id'] }, enums: [],
        gaps: ['no_callsite'],
      },
    });
    const gen = generateMocks({
      projectSlug: slug, roles: [role], force: true, merge: false,
    });
    // Has shape → not empty → not contract-only; handler renders
    assert.equal(gen.skippedEmptyCount, 0);
    const handlerFile = stubHandlerPath(slug, 'dead-svc', 'GET', '/v1/items');
    assert.ok(fs.existsSync(handlerFile), 'handler kept when shape exists');
  });
});

test('P3-D6: deadExports reported in init coverage-summary.json', () => {
  withTempServices((slug) => {
    const role = makeRole({
      stubId: 'GET dead-svc/v1/dead',
      path: '/v1/dead',
      exportHint: 'unusedFn',
      coverage: { request: {}, response: {}, enums: [], gaps: ['no_callsite'] },
    });
    generateMocks({ projectSlug: slug, roles: [role], force: true, merge: false });

    const { buildInitReport } = require('../lib/init-report');
    const { summary } = buildInitReport({
      apiList: [{
        stubId: 'GET dead-svc/v1/dead',
        upstreamId: 'dead-svc',
        hosts: [],
        responseShape: { type: 'object', props: {} },
        coverage: { gaps: ['no_callsite'] },
        exportHint: 'unusedFn',
      }],
      gen: { generated: 1, gapApis: [], blocked: [] },
      roles: [],
      projectDir: '/tmp', projectSlug: slug, taskId: null,
    });
    assert.ok(summary.deadExports.length === 1);
    assert.equal(summary.deadExports[0].stubId, 'GET dead-svc/v1/dead');
    assert.equal(summary.deadExports[0].exportHint, 'unusedFn');
  });
});
