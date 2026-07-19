'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { serviceDataDir, stubHandlerPath, serviceContractPath } = require('../lib/paths');
const { generateMocks } = require('../scripts/generate-mock');
const { capturesDirFor } = require('../lib/catalog-merge');

function withTempServices(fn) {
  const label = `cap-gap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    return fn(label);
  } finally {
    try {
      fs.rmSync(serviceDataDir('svc-a'), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function makeEmptyRole(overrides = {}) {
  return {
    role: 'dependency',
    method: 'GET',
    path: '/v1/items',
    upstreamId: 'svc-a',
    hosts: ['svc-a.example.com'],
    canonicalHost: 'svc-a.example.com',
    stubId: 'GET svc-a/v1/items',
    exportHint: 'getList',
    responseShape: { type: 'object', props: {} },
    coverage: {
      request: { keysFound: [], confidence: 'low' },
      response: { pathsFound: [], confidence: 'low' },
      enums: [],
      gaps: ['TRACE_EMPTY', 'no_callsite', 'no_property_access', 'no_export_symbol'],
    },
    evidences: ['src/api.js:1'],
    ...overrides,
  };
}

test('P1-C1: capture-merge clears TRACE_EMPTY + no_property_access after successful merge', () => {
  withTempServices((slug) => {
    generateMocks({
      projectSlug: slug,
      roles: [makeEmptyRole()],
      force: true, merge: false,
    });

    const capturesDir = capturesDirFor('svc-a');
    fs.writeFileSync(
      path.join(capturesDir, 'cap.json'),
      JSON.stringify({
        host: 'svc-a.example.com',
        path: '/v1/items',
        method: 'GET',
        responseBody: { code: 0, data: { id: 1, name: 'real' } },
      }, null, 2),
    );

    const { captureMerge } = require('../scripts/capture-merge');
    const result = captureMerge(slug, { capturesDir });
    assert.ok(result.merged >= 1);

    const contract = JSON.parse(
      fs.readFileSync(serviceContractPath('svc-a', 'GET svc-a/v1/items'), 'utf8'),
    );
    const gaps = contract.coverage.gaps || [];
    assert.ok(!gaps.includes('TRACE_EMPTY'), `TRACE_EMPTY should be cleared: ${gaps}`);
    assert.ok(!gaps.includes('no_property_access'), `no_property_access should be cleared: ${gaps}`);
    assert.ok(!gaps.includes('no_export_symbol'), `no_export_symbol should be cleared: ${gaps}`);
  });
});

test('P1-C2: capture-merge clears no_callsite when real data arrives (export now has evidence of use)', () => {
  withTempServices((slug) => {
    generateMocks({
      projectSlug: slug,
      roles: [makeEmptyRole()],
      force: true, merge: false,
    });

    const capturesDir = capturesDirFor('svc-a');
    fs.writeFileSync(
      path.join(capturesDir, 'cap.json'),
      JSON.stringify({
        host: 'svc-a.example.com',
        path: '/v1/items',
        method: 'GET',
        responseBody: { code: 0, data: { id: 1 } },
      }, null, 2),
    );

    const { captureMerge } = require('../scripts/capture-merge');
    captureMerge({ capturesDir });

    const contract = JSON.parse(
      fs.readFileSync(serviceContractPath('svc-a', 'GET svc-a/v1/items'), 'utf8'),
    );
    const gaps = contract.coverage.gaps || [];
    assert.ok(!gaps.includes('no_callsite'), `no_callsite should be cleared by capture: ${gaps}`);
    // bind_ambiguous (if present) should remain — capture doesn't fix binding
    // dynamic_key should remain if it was there
  });
});

test('P1-C3: capture-merge preserves bind_ambiguous and dynamic_key (capture does not fix binding/dynamic)', () => {
  withTempServices((slug) => {
    generateMocks({
      projectSlug: slug,
      roles: [makeEmptyRole({
        coverage: {
          request: { keysFound: [], confidence: 'low' },
          response: { pathsFound: [], confidence: 'low' },
          enums: [],
          gaps: ['TRACE_EMPTY', 'bind_ambiguous', 'dynamic_key'],
        },
      })],
      force: true, merge: false,
    });

    const capturesDir = capturesDirFor('svc-a');
    fs.writeFileSync(
      path.join(capturesDir, 'cap.json'),
      JSON.stringify({
        host: 'svc-a.example.com',
        path: '/v1/items',
        method: 'GET',
        responseBody: { code: 0, data: { id: 1 } },
      }, null, 2),
    );

    const { captureMerge } = require('../scripts/capture-merge');
    captureMerge({ capturesDir });

    const contract = JSON.parse(
      fs.readFileSync(serviceContractPath('svc-a', 'GET svc-a/v1/items'), 'utf8'),
    );
    const gaps = contract.coverage.gaps || [];
    assert.ok(!gaps.includes('TRACE_EMPTY'), 'TRACE_EMPTY cleared');
    assert.ok(gaps.includes('bind_ambiguous'), 'bind_ambiguous preserved');
    assert.ok(gaps.includes('dynamic_key'), 'dynamic_key preserved');
  });
});

test('P1-C4: capture-merge stamps fidelity=L2 after successful merge', () => {
  withTempServices((slug) => {
    generateMocks({
      projectSlug: slug,
      roles: [makeEmptyRole()],
      force: true, merge: false,
    });

    const capturesDir = capturesDirFor('svc-a');
    fs.writeFileSync(
      path.join(capturesDir, 'cap.json'),
      JSON.stringify({
        host: 'svc-a.example.com',
        path: '/v1/items',
        method: 'GET',
        responseBody: { code: 0, data: { id: 1 } },
      }, null, 2),
    );

    const { captureMerge } = require('../scripts/capture-merge');
    captureMerge({ capturesDir });

    const contract = JSON.parse(
      fs.readFileSync(serviceContractPath('svc-a', 'GET svc-a/v1/items'), 'utf8'),
    );
    assert.equal(contract.fidelity, 'L2', `fidelity should be L2 after capture, got ${contract.fidelity}`);
  });
});

test('P1-C5: capture-merge sanitizes token/password fields in persisted data', () => {
  withTempServices((slug) => {
    generateMocks({
      projectSlug: slug,
      roles: [makeEmptyRole()],
      force: true, merge: false,
    });

    const capturesDir = capturesDirFor('svc-a');
    fs.writeFileSync(
      path.join(capturesDir, 'cap.json'),
      JSON.stringify({
        host: 'svc-a.example.com',
        path: '/v1/items',
        method: 'GET',
        responseBody: { code: 0, data: { id: 1, token: 'leaked-jwt', password: 'p', name: 'bob' } },
      }, null, 2),
    );

    const { captureMerge } = require('../scripts/capture-merge');
    captureMerge({ capturesDir });

    const contract = JSON.parse(
      fs.readFileSync(serviceContractPath('svc-a', 'GET svc-a/v1/items'), 'utf8'),
    );
    const data = contract.cases.find((c) => c.id === 'success').response.data;
    assert.equal(data.token, '[REDACTED]', 'token redacted');
    assert.equal(data.password, '[REDACTED]', 'password redacted');
    assert.equal(data.name, 'bob', 'non-sensitive preserved');
    assert.equal(data.id, 1, 'id preserved');
  });
});

test('P1-C6: capture-merge --no-sanitize opts disables sanitization', () => {
  withTempServices((slug) => {
    generateMocks({
      projectSlug: slug,
      roles: [makeEmptyRole()],
      force: true, merge: false,
    });

    const capturesDir = capturesDirFor('svc-a');
    fs.writeFileSync(
      path.join(capturesDir, 'cap.json'),
      JSON.stringify({
        host: 'svc-a.example.com',
        path: '/v1/items',
        method: 'GET',
        responseBody: { code: 0, data: { id: 1, token: 'leaked' } },
      }, null, 2),
    );

    const { captureMerge } = require('../scripts/capture-merge');
    captureMerge({ capturesDir, sanitize: false });

    const contract = JSON.parse(
      fs.readFileSync(serviceContractPath('svc-a', 'GET svc-a/v1/items'), 'utf8'),
    );
    const data = contract.cases.find((c) => c.id === 'success').response.data;
    assert.equal(data.token, 'leaked', 'token preserved when sanitize disabled');
  });
});
