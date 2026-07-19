'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_ENV_TOKENS,
  normalizeHostLabel,
  consensusHostLabel,
  resolveUpstreamId,
  resolveUpstreamIdFromRole,
  deriveUpstreamId,
  assertHostsCompatible,
  pickCanonicalHost,
} = require('../lib/upstream');

test('U1: normalizeHostLabel strips generic env tokens', () => {
  assert.equal(normalizeHostLabel('svc-a-dev'), 'svc-a');
  assert.equal(normalizeHostLabel('svc-a-stage'), 'svc-a');
  assert.equal(normalizeHostLabel('preview-svc-a'), 'svc-a');
  assert.equal(normalizeHostLabel('api-prod'), 'api');
  assert.equal(normalizeHostLabel('svc-a.example.com'), 'svc-a');
  assert.equal(normalizeHostLabel('svc-a.example.com:443'), 'svc-a');
  assert.equal(normalizeHostLabel('svc-a-staging'), 'svc-a');
  assert.equal(normalizeHostLabel('svc-a-qa'), 'svc-a');
  assert.equal(normalizeHostLabel('svc-a-uat'), 'svc-a');
  assert.equal(normalizeHostLabel('svc-a-online'), 'svc-a');
  assert.equal(normalizeHostLabel('svc-a-production'), 'svc-a');
});

test('U1: normalizeHostLabel empty result -> default', () => {
  assert.equal(normalizeHostLabel('dev'), 'default');
  assert.equal(normalizeHostLabel('stage.example.com'), 'default');
});

test('U1: DEFAULT_ENV_TOKENS contains no company brand strings', () => {
  for (const t of DEFAULT_ENV_TOKENS) {
    assert.ok(!t.includes('guazi'), `token "${t}" must not include brand`);
    assert.ok(/^[a-z]+$/.test(t), `token "${t}" must be generic lowercase word`);
  }
  for (const expected of ['dev', 'test', 'stage', 'preview', 'prod']) {
    assert.ok(DEFAULT_ENV_TOKENS.includes(expected), `missing generic token ${expected}`);
  }
});

test('U1: normalizeHostLabel accepts extra project envHostTokens', () => {
  assert.equal(
    normalizeHostLabel('svc-a-canary', { envHostTokens: ['canary'] }),
    'svc-a',
  );
  assert.equal(normalizeHostLabel('svc-a-canary'), 'svc-a-canary');
});

test('U2: resolveUpstreamId ignores hostVar (FE symbol ≠ service id)', () => {
  assert.equal(
    resolveUpstreamId({ hostVar: 'apiPrefix', hosts: ['x.example.com'] }),
    'x',
  );
});

test('U2: resolveUpstreamId prefers host label over prefixKey when hosts present', () => {
  assert.equal(
    resolveUpstreamId({ prefixKey: 'baseURL', hosts: ['x.example.com'] }),
    'x',
  );
});

test('U2: resolveUpstreamId uses prefixKey alone without prefix- marker', () => {
  assert.equal(resolveUpstreamId({ prefixKey: 'baseURL' }), 'baseURL');
  assert.equal(resolveUpstreamId({ prefixKey: 'cars-task', hosts: [] }), 'cars-task');
});

test('U2: resolveUpstreamId uses family token when only hosts, same family', () => {
  assert.equal(
    resolveUpstreamId({
      hosts: ['svc-a.example.com', 'svc-a-stage.example.com'],
    }),
    'svc-a',
  );
});

test('U2: consensusHostLabel collapses env-noise extension to shorter prefix', () => {
  assert.equal(
    consensusHostLabel([
      'svc-a.example.com',
      'svc-a-brand-preview.example.com',
    ]),
    'svc-a',
  );
  assert.equal(
    resolveUpstreamId({
      hosts: ['svc-a.example.com', 'svc-a-brand-preview.example.com'],
    }),
    'svc-a',
  );
});

test('U2: resolveUpstreamId null on true sibling fork without prefixKey', () => {
  assert.equal(
    resolveUpstreamId({ hosts: ['svc-a.example.com', 'svc-b.example.com'] }),
    null,
  );
});

test('U2: resolveUpstreamId falls back to prefixKey when hosts fork', () => {
  assert.equal(
    resolveUpstreamId({
      prefixKey: 'shared',
      hosts: ['svc-a.example.com', 'svc-b.example.com'],
    }),
    'shared',
  );
});

test('U2: resolveUpstreamId null when only _default / empty hosts', () => {
  assert.equal(resolveUpstreamId({ hosts: ['_default'] }), null);
  assert.equal(resolveUpstreamId({ hosts: [] }), null);
});

test('U2: hostVar alone does not become service id', () => {
  assert.equal(resolveUpstreamId({ hostVar: 'my api prefix!', hosts: [] }), null);
  assert.equal(
    resolveUpstreamIdFromRole({ hostVar: 'my api prefix!' }),
    '_default',
  );
});

test('U2: deriveUpstreamId is alias of resolveUpstreamId', () => {
  assert.equal(
    deriveUpstreamId({ prefixKey: 'cars-task' }),
    resolveUpstreamId({ prefixKey: 'cars-task' }),
  );
});

test('U2: resolveUpstreamIdFromRole reads role fields', () => {
  assert.equal(
    resolveUpstreamIdFromRole({
      prefixKey: 'cars-task',
      host: '_default',
    }),
    'cars-task',
  );
  assert.equal(
    resolveUpstreamIdFromRole({
      prefixKey: 'cars-task',
      hosts: ['pay.example.com'],
    }),
    'pay',
  );
});

test('U2: resolveUpstreamIdFromRole ignores hostVar when hosts present', () => {
  assert.equal(
    resolveUpstreamIdFromRole({
      hostVar: 'JIANDomainLike',
      hosts: ['svc-a.example.com', 'svc-a-brand-preview.apps.example.com'],
    }),
    'svc-a',
  );
});

test('U2: resolveUpstreamIdFromRole null when hosts fork (no dump to _default)', () => {
  assert.equal(
    resolveUpstreamIdFromRole({
      hosts: ['svc-pay.example.com', 'svc-order.example.com'],
    }),
    null,
  );
});

test('U2: assertHostsCompatible throws on disjoint non-empty sets', () => {
  assert.throws(
    () =>
      assertHostsCompatible(['a.example.com'], ['b.example.com'], {
        serviceId: 'cars-task',
      }),
    /host conflict/,
  );
  assert.doesNotThrow(() =>
    assertHostsCompatible(
      ['a.example.com'],
      ['a.example.com', 'a-dev.example.com'],
      { serviceId: 'a' },
    ),
  );
  assert.doesNotThrow(() =>
    assertHostsCompatible([], ['a.example.com'], { serviceId: 'a' }),
  );
});

test('U7: pickCanonicalHost prefers host whose label has no env token', () => {
  const hosts = [
    'svc-a-stage.example.com',
    'svc-a.example.com',
    'svc-a-dev.example.com',
  ];
  assert.equal(pickCanonicalHost(hosts, 'svc-a'), 'svc-a.example.com');
});

test('U7: pickCanonicalHost falls back to lexicographically smallest', () => {
  const hosts = ['svc-b.example.com', 'svc-a.example.com'];
  assert.equal(pickCanonicalHost(hosts, 'svc'), 'svc-a.example.com');
});

test('U7: pickCanonicalHost null when hosts empty', () => {
  assert.equal(pickCanonicalHost([], 'svc-a'), null);
});

test('U7: pickCanonicalHost has no domain-suffix allowlist', () => {
  const src = String(pickCanonicalHost);
  assert.ok(!src.includes('guazi'), 'pickCanonicalHost must not reference brand domain');
});

test('U8: project envHostTokens append does not mutate DEFAULT_ENV_TOKENS', () => {
  const before = [...DEFAULT_ENV_TOKENS];
  normalizeHostLabel('svc-a-canary', { envHostTokens: ['canary'] });
  assert.deepEqual(DEFAULT_ENV_TOKENS, before);
});
