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
 *
 * Service ids come from host-family consensus (svc-a / svc-b), not hostVar names.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { inferApiUsage } = require('../scripts/infer-api-usage');
const { generateMocks } = require('../scripts/generate-mock');
const { serviceDataDir } = require('../lib/paths');
const { matchRule } = require('../lib/match-rule');
const { resolveStubHandlerFile } = require('../runtime/mock-server/router');
const { stubId: makeStubId, parseStubId } = require('../lib/paths');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'multi-host-web');

function withTempServices(fn) {
  const label = `e2e-upstream-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    return fn(label);
  } finally {
    for (const up of ['svc-a', 'svc-b', 'svcAPrefix', 'svcBPrefix']) {
      try {
        fs.rmSync(serviceDataDir(up), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

test('E2E: multi-host fixture — full stub catalog pipeline', () => {
  withTempServices((slug) => {
    const apis = inferApiUsage(FIXTURE_DIR, {
      projectSlug: slug,
      withUsageIo: false,
      forceRefresh: true,
    });

    assert.ok(
      apis.length >= 3,
      `expected >=3 stubs, got ${apis.length}: ${JSON.stringify(apis.map((a) => a.stubId || a.id))}`,
    );

    const svcAItems = apis.find((a) => {
      const sid = a.stubId || a.id || '';
      return (
        sid.includes('svc-a') &&
        sid.includes('/v1/items') &&
        sid.startsWith('GET') &&
        !sid.includes('svcAPrefix')
      );
    });
    assert.ok(
      svcAItems,
      `should find GET svc-a/v1/items stub among: ${JSON.stringify(apis.map((a) => a.stubId || a.id))}`,
    );
    assert.equal(svcAItems.upstreamId, 'svc-a');
    assert.ok(
      svcAItems.hosts?.length >= 2,
      `svc-a items should have >=2 hosts, got ${JSON.stringify(svcAItems.hosts)}`,
    );

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

    const rules = JSON.parse(
      fs.readFileSync(path.join(serviceDataDir('svc-a'), 'proxy-rules.json'), 'utf8'),
    );
    const allRules = [
      ...rules,
      ...(fs.existsSync(path.join(serviceDataDir('svc-b'), 'proxy-rules.json'))
        ? JSON.parse(
            fs.readFileSync(path.join(serviceDataDir('svc-b'), 'proxy-rules.json'), 'utf8'),
          )
        : []),
    ];
    assert.ok(allRules.length >= 3, `expected >=3 rules, got ${allRules.length}`);

    const svcARule = allRules.find(
      (r) =>
        r.upstreamId === 'svc-a' &&
        r.pathPrefix === '/v1/items' &&
        r.methods?.includes('GET'),
    );
    assert.ok(svcARule, 'should find svc-a GET /v1/items rule');
    assert.ok(
      svcARule.hosts?.length >= 2,
      `svc-a rule should have >=2 hosts, got ${JSON.stringify(svcARule.hosts)}`,
    );

    const upstreams = JSON.parse(
      fs.readFileSync(path.join(serviceDataDir('svc-a'), 'upstreams.json'), 'utf8'),
    );
    assert.ok(upstreams.upstreams['svc-a'], 'svc-a upstream should exist');
    assert.ok(
      upstreams.upstreams['svc-a'].hosts.length >= 2,
      'svc-a should have >=2 hosts',
    );
    const upstreamsB = JSON.parse(
      fs.readFileSync(path.join(serviceDataDir('svc-b'), 'upstreams.json'), 'utf8'),
    );
    assert.ok(upstreamsB.upstreams['svc-b'], 'svc-b upstream should exist');

    const prodMatch = matchRule(allRules, 'svc-a.example.com', '/v1/items', 'GET');
    assert.ok(prodMatch, 'prod host should match');
    const stageMatch = matchRule(allRules, 'svc-a-stage.example.com', '/v1/items', 'GET');
    assert.ok(stageMatch, 'stage host should match');
    assert.equal(prodMatch.stubId, stageMatch.stubId, 'both env hosts should match the same stub');

    const { mocksRootForStub } = require('../lib/catalog-merge');
    const svcRoot = mocksRootForStub(prodMatch.stubId);
    const handlerFile = resolveStubHandlerFile(svcRoot, {
      stubId: prodMatch.stubId,
      method: 'GET',
      urlPath: '/v1/items',
    });
    assert.ok(handlerFile, 'handler should resolve by stubId');
    assert.ok(fs.existsSync(handlerFile), `handler file should exist: ${handlerFile}`);

    assert.ok(fs.existsSync(serviceDataDir('svc-a')), 'svc-a service catalog');
    assert.ok(fs.existsSync(serviceDataDir('svc-b')), 'svc-b service catalog');
    const svcMocks = path.join(serviceDataDir('svc-a'), 'mocks');
    if (fs.existsSync(svcMocks)) {
      const entries = fs.readdirSync(svcMocks);
      assert.ok(
        !entries.some((e) => e.includes('.example.')),
        `no FQDN directories: ${JSON.stringify(entries)}`,
      );
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
