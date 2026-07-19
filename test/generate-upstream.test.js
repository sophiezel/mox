'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  generateMocks,
} = require('../scripts/generate-mock');
const {
  serviceDataDir,
  stubHandlerPath,
  serviceContractPath,
  getDataRoot,
} = require('../lib/paths');

function withTempServices(fn) {
  const label = `gen-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function makeRole(overrides = {}) {
  return {
    role: 'dependency',
    method: 'GET',
    path: '/v1/items',
    upstreamId: 'svc-a',
    hosts: ['svc-a.example.com', 'svc-a-stage.example.com'],
    canonicalHost: 'svc-a.example.com',
    stubId: 'GET svc-a/v1/items',
    exportHint: 'getList',
    responseShape: {
      type: 'array',
      item: { props: { name: { type: 'string' } } },
    },
    coverage: {
      request: { keysFound: [], confidence: 'high' },
      response: { pathsFound: ['name'], confidence: 'high' },
      enums: [],
      gaps: [],
    },
    evidences: ['src/api.js:1'],
    ...overrides,
  };
}

test('G1: generate writes handler at stubHandlerPath (no FQDN dir), rule.hosts>=2', () => {
  withTempServices((slug) => {
    const roles = [makeRole()];
    const gen = generateMocks({ projectSlug: slug, roles, force: true, merge: false });
    assert.equal(gen.generated, 1);

    // Handler under services/<upstreamId>/mocks/<METHOD>/...
    const handlerFile = stubHandlerPath(slug, 'svc-a', 'GET', '/v1/items');
    assert.ok(fs.existsSync(handlerFile), `handler should exist at ${handlerFile}`);
    assert.ok(
      handlerFile.includes(`${path.sep}services${path.sep}svc-a${path.sep}`),
      'handler lives under services catalog',
    );

    // No catalog dual-write under projects/
    assert.ok(!fs.existsSync(path.join(getDataRoot(), 'projects')));
    assert.ok(fs.existsSync(serviceDataDir('svc-a')), 'service catalog exists');

    // proxy-rules under service
    const rules = JSON.parse(
      fs.readFileSync(path.join(serviceDataDir('svc-a'), 'proxy-rules.json'), 'utf8'),
    );
    assert.equal(rules.length, 1);
    assert.ok(rules[0].hosts?.length >= 2, `rule.hosts should have >=2, got ${JSON.stringify(rules[0].hosts)}`);
    assert.ok(rules[0].stubId, 'rule should have stubId');
    assert.ok(rules[0].upstreamId, 'rule should have upstreamId');

    // upstreams.json under service
    const upstreamsPath = path.join(serviceDataDir('svc-a'), 'upstreams.json');
    assert.ok(fs.existsSync(upstreamsPath), 'upstreams.json should exist');
    const upstreams = JSON.parse(fs.readFileSync(upstreamsPath, 'utf8'));
    assert.ok(upstreams.upstreams?.['svc-a'], 'svc-a upstream exists');
    assert.ok(upstreams.upstreams['svc-a'].hosts?.length >= 2);
  });
});

test('G2: prune --force removes old FQDN tree, keeps manual', () => {
  withTempServices((slug) => {
    const mocksRoot = path.join(serviceDataDir('svc-a'), 'mocks');
    // Create an old-style FQDN handler (legacy residue under service catalog)
    const oldFqdnDir = path.join(mocksRoot, 'svc-a.example.com', 'GET', 'v1', 'items');
    fs.mkdirSync(oldFqdnDir, { recursive: true });
    fs.writeFileSync(path.join(oldFqdnDir, 'index.js'), 'module.exports = () => ({});\n');

    // Create a manual handler under the service catalog layout
    const manualDir = path.join(mocksRoot, 'svc-a', 'GET', 'v1', 'manual');
    fs.mkdirSync(manualDir, { recursive: true });
    fs.writeFileSync(
      path.join(manualDir, 'index.js'),
      '/** mox:manual */\nmodule.exports = () => ({});\n',
    );

    const roles = [makeRole()];
    const gen = generateMocks({ projectSlug: slug, roles, force: true, merge: false });
    assert.ok(gen.prunedHandlers >= 1, 'old FQDN handler should be pruned');

    // Old FQDN dir should be gone
    assert.ok(!fs.existsSync(oldFqdnDir), 'old FQDN directory should be removed');

    // Manual handler should remain
    assert.ok(
      fs.existsSync(path.join(manualDir, 'index.js')),
      'manual handler should be preserved',
    );
  });
});

test('G3: skippedEmpty — no_export_symbol writes contract only, no handler/rule', () => {
  withTempServices((slug) => {
    const roles = [
      makeRole({
        path: '/v1/orphan',
        stubId: 'GET svc-a/v1/orphan',
        upstreamId: 'svc-a',
        exportHint: null,
        responseShape: { type: 'object', props: {} },
        coverage: {
          request: { keysFound: [], confidence: 'low' },
          response: { pathsFound: [], confidence: 'low' },
          enums: [],
          gaps: ['no_export_symbol'],
        },
      }),
    ];
    const gen = generateMocks({ projectSlug: slug, roles, force: true, merge: false });
    assert.equal(gen.skippedEmptyCount, 1);
    assert.equal(gen.generated, 0);

    const rulesPath = path.join(serviceDataDir('svc-a'), 'proxy-rules.json');
    if (fs.existsSync(rulesPath)) {
      const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
      assert.equal(rules.length, 0, 'no_export_symbol must not enter proxy-rules');
    }

    // Contract should still be written under services/
    const cPath = serviceContractPath('svc-a', 'GET svc-a/v1/orphan');
    assert.ok(fs.existsSync(cPath), 'contract should be written');

    // Handler should NOT exist
    const handlerFile = stubHandlerPath(slug, 'svc-a', 'GET', '/v1/orphan');
    assert.ok(!fs.existsSync(handlerFile), 'handler should not be rendered');
  });
});

test('contract schema includes stubId, upstreamId, hosts, canonicalHost', () => {
  withTempServices((slug) => {
    const roles = [makeRole()];
    generateMocks({ projectSlug: slug, roles, force: true, merge: false });

    const cPath = serviceContractPath('svc-a', 'GET svc-a/v1/items');
    const contract = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    assert.equal(contract.id, 'GET svc-a/v1/items');
    assert.equal(contract.stubId, 'GET svc-a/v1/items');
    assert.equal(contract.upstreamId, 'svc-a');
    assert.ok(Array.isArray(contract.hosts));
    assert.ok(contract.hosts.length >= 2);
    assert.equal(contract.canonicalHost, 'svc-a.example.com');
    // No top-level host field (avoid ambiguity with hosts[])
    assert.ok(!contract.host || contract.host === undefined, 'no top-level host field');
  });
});

test('contract schema stamps fidelity (L1 for usage shape, L0 for empty)', () => {
  withTempServices((slug) => {
    const shapeRole = makeRole();
    const emptyRole = {
      ...makeRole(),
      stubId: 'GET svc-a/v1/empty',
      path: '/v1/empty',
      responseShape: { type: 'object', props: {} },
      coverage: { gaps: ['TRACE_EMPTY'], request: {}, response: {} },
    };
    generateMocks({
      projectSlug: slug,
      roles: [shapeRole, emptyRole],
      force: true,
      merge: false,
    });

    const shapeContract = JSON.parse(
      fs.readFileSync(serviceContractPath('svc-a', 'GET svc-a/v1/items'), 'utf8'),
    );
    assert.equal(shapeContract.fidelity, 'L1', 'usage-backed shape → L1');

    const emptyContract = JSON.parse(
      fs.readFileSync(serviceContractPath('svc-a', 'GET svc-a/v1/empty'), 'utf8'),
    );
    assert.equal(emptyContract.fidelity, 'L0', 'empty shape → L0');
  });
});

test('generate leaves no projects/ directory after catalog write', () => {
  withTempServices((slug) => {
    generateMocks({ projectSlug: slug, roles: [makeRole()], force: true, merge: false });
    assert.ok(!fs.existsSync(path.join(getDataRoot(), 'projects')));
    const svcBase = serviceDataDir('svc-a');
    assert.ok(fs.existsSync(path.join(svcBase, 'contracts')));
    assert.ok(fs.existsSync(path.join(svcBase, 'mocks')));
    assert.ok(fs.existsSync(path.join(svcBase, 'proxy-rules.json')));
  });
});
