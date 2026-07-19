'use strict';

/**
 * E2E test: infer → classify → generate → proxy match → router resolve
 * for the multi-host-web fixture.
 *
 * Verifies the full stub catalog pipeline:
 * 1. inferApiUsage collapses multi-env hosts into one stub per upstream
 * 2. generate writes handlers at stubHandlerPath (no FQDN dirs)
 * 3. proxy-rules.json has hosts[] + stubId + upstreamId
 * 4. upstreams.json has correct host lists
 * 5. matchRule matches both env hosts to the same rule
 * 6. router resolveStubHandlerFile resolves by stubId header
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { inferApiUsage } = require('../scripts/infer-api-usage');
const { generateMocks } = require('../scripts/generate-mock');
const { projectDataDir, stubHandlerPath, serviceDataDir } = require('../lib/paths');
const { matchRule } = require('../lib/match-rule');
const { resolveStubHandlerFile } = require('../runtime/mock-server/router');
const { stubId: makeStubId, parseStubId } = require('../lib/paths');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'multi-host-web');

function withTempProject(fn) {
  const slug = `e2e-upstream-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const root = projectDataDir(slug);
  fs.mkdirSync(path.join(root, 'audit'), { recursive: true });
  try {
    return fn(slug);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    for (const up of ['svcAPrefix', 'svcBPrefix']) {
      try {
        fs.rmSync(serviceDataDir(up), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

test('E2E: multi-host fixture — full stub catalog pipeline', () => {
  withTempProject((slug) => {
    // Step 1: Infer API usage from fixture
    const apis = inferApiUsage(FIXTURE_DIR, {
      projectSlug: slug,
      withUsageIo: false,
      forceRefresh: true,
    });

    // Should collapse to 3 stubs: GET svcAPrefix/v1/items, POST svcAPrefix/v1/items, GET svcBPrefix/v1/profile
    assert.ok(apis.length >= 3, `expected >=3 stubs, got ${apis.length}: ${JSON.stringify(apis.map(a => a.stubId || a.id))}`);

    // Find the svcA items stub — should have 2 hosts (hostVar: svcAPrefix)
    const svcAItems = apis.find((a) => {
      const sid = a.stubId || a.id || '';
      return sid.includes('svcAPrefix') && sid.includes('/v1/items') && sid.startsWith('GET');
    });
    assert.ok(svcAItems, `should find GET svcAPrefix/v1/items stub among: ${JSON.stringify(apis.map(a => a.stubId || a.id))}`);
    assert.ok(svcAItems.hosts?.length >= 2, `svcA items should have >=2 hosts, got ${JSON.stringify(svcAItems.hosts)}`);

    // Step 2: Generate mocks
    const roles = apis.map((a) => ({
      role: 'dependency',
      method: a.method,
      path: a.path,
      upstreamId: a.upstreamId,
      hosts: a.hosts,
      canonicalHost: a.canonicalHost,
      stubId: a.stubId || a.id,
      exportHint: a.exportHint,
      responseShape: a.responseShape,
      coverage: a.coverage || {
        request: { keysFound: [], confidence: 'low' },
        response: { pathsFound: [], confidence: 'low' },
        enums: [],
        gaps: [],
      },
      evidences: a.evidences || [],
    }));

    const gen = generateMocks({ projectSlug: slug, roles, force: true, merge: false });
    assert.ok(gen.generated >= 3, `expected >=3 generated, got ${gen.generated}`);

    // Step 3: Verify proxy-rules.json under services
    const rules = JSON.parse(
      fs.readFileSync(path.join(serviceDataDir('svcAPrefix'), 'proxy-rules.json'), 'utf8'),
    );
    const allRules = [
      ...rules,
      ...(fs.existsSync(path.join(serviceDataDir('svcBPrefix'), 'proxy-rules.json'))
        ? JSON.parse(fs.readFileSync(path.join(serviceDataDir('svcBPrefix'), 'proxy-rules.json'), 'utf8'))
        : []),
    ];
    assert.ok(allRules.length >= 3, `expected >=3 rules, got ${allRules.length}`);

    const svcARule = allRules.find((r) => r.stubId?.includes('svcAPrefix') && r.pathPrefix === '/v1/items' && r.methods?.includes('GET'));
    assert.ok(svcARule, `should find svcAPrefix GET /v1/items rule`);
    assert.ok(svcARule.hosts?.length >= 2, `svcA rule should have >=2 hosts, got ${JSON.stringify(svcARule.hosts)}`);
    assert.ok(svcARule.upstreamId === 'svcAPrefix', `svcA rule upstreamId should be svcAPrefix`);

    // Step 4: Verify upstreams.json under services
    const upstreams = JSON.parse(
      fs.readFileSync(path.join(serviceDataDir('svcAPrefix'), 'upstreams.json'), 'utf8'),
    );
    assert.ok(upstreams.upstreams['svcAPrefix'], 'svcAPrefix upstream should exist');
    assert.ok(upstreams.upstreams['svcAPrefix'].hosts.length >= 2, 'svcAPrefix should have >=2 hosts');
    const upstreamsB = JSON.parse(
      fs.readFileSync(path.join(serviceDataDir('svcBPrefix'), 'upstreams.json'), 'utf8'),
    );
    assert.ok(upstreamsB.upstreams['svcBPrefix'], 'svcBPrefix upstream should exist');

    // Step 5: matchRule — both env hosts match the same rule
    const prodMatch = matchRule(allRules, 'svc-a.example.com', '/v1/items', 'GET');
    assert.ok(prodMatch, 'prod host should match');
    const stageMatch = matchRule(allRules, 'svc-a-stage.example.com', '/v1/items', 'GET');
    assert.ok(stageMatch, 'stage host should match');
    assert.equal(prodMatch.stubId, stageMatch.stubId, 'both env hosts should match the same stub');

    // Step 6: router resolveStubHandlerFile — service mocks root
    const { mocksRootForStub } = require('../lib/catalog-merge');
    const svcRoot = mocksRootForStub(prodMatch.stubId);
    const handlerFile = resolveStubHandlerFile(svcRoot, {
      stubId: prodMatch.stubId,
      method: 'GET',
      urlPath: '/v1/items',
    });
    assert.ok(handlerFile, 'handler should resolve by stubId');
    assert.ok(fs.existsSync(handlerFile), `handler file should exist: ${handlerFile}`);

    // Step 7: handlers live under services/, not FQDN project dirs
    assert.ok(fs.existsSync(serviceDataDir('svcAPrefix')), 'svcAPrefix service catalog');
    assert.ok(fs.existsSync(serviceDataDir('svcBPrefix')), 'svcBPrefix service catalog');
    const projectMocks = path.join(projectDataDir(slug), 'mocks');
    if (fs.existsSync(projectMocks)) {
      const entries = fs.readdirSync(projectMocks);
      assert.ok(!entries.some((e) => e.includes('.example.')), `no FQDN directories: ${JSON.stringify(entries)}`);
    }
  });
});

test('E2E: stubId round-trips through parseStubId', () => {
  const id = 'GET svc-a/v1/items';
  const parsed = parseStubId(id);
  assert.equal(parsed.method, 'GET');
  assert.equal(parsed.upstreamId, 'svc-a');
  assert.equal(parsed.path, '/v1/items');
  assert.equal(makeStubId(parsed), id);
});
