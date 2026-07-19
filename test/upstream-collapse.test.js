'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collapseByUpstream } = require('../lib/upstream');

function api(overrides) {
  return {
    method: 'GET',
    host: '_default',
    path: '/v1/items',
    evidence: 'src/api.js:1',
    confidence: 'medium',
    exportHint: null,
    exportKey: null,
    queryHints: [],
    bodyHints: [],
    responseHints: [],
    responseShape: null,
    ...overrides,
  };
}

test('U3: two env hosts same path collapse into one stub with hosts.length===2', () => {
  const apis = [
    api({ host: 'svc-a.example.com', path: '/v1/items', exportHint: 'getList' }),
    api({ host: 'svc-a-stage.example.com', path: '/v1/items' }),
  ];
  const out = collapseByUpstream(apis);
  assert.equal(out.length, 1, `expected 1 stub, got ${out.length}`);
  const stub = out[0];
  assert.equal(stub.method, 'GET');
  assert.equal(stub.path, '/v1/items');
  assert.equal(stub.upstreamId, 'svc-a');
  assert.deepEqual([...stub.hosts].sort(), [
    'svc-a-stage.example.com',
    'svc-a.example.com',
  ]);
  assert.equal(stub.hosts.length, 2);
  assert.ok(stub.canonicalHost, 'canonicalHost should be set');
  assert.equal(stub.canonicalHost, 'svc-a.example.com');
  assert.ok(stub.stubId, 'GET svc-a/v1/items');
  assert.equal(stub.stubId, 'GET svc-a/v1/items');
  // exportHint union preserved
  assert.deepEqual(stub.exportHints, ['getList']);
});

test('U4: different families same path → two stubs', () => {
  const apis = [
    api({ host: 'svc-a.example.com', path: '/v1/items' }),
    api({ host: 'svc-b.example.com', path: '/v1/items' }),
  ];
  const out = collapseByUpstream(apis);
  assert.equal(out.length, 2, `expected 2 stubs, got ${out.length}`);
  const ids = out.map((s) => s.stubId).sort();
  assert.deepEqual(ids, ['GET svc-a/v1/items', 'GET svc-b/v1/items']);
});

test('U5: _default row dropped when a real-host twin exists for same method+path', () => {
  const apis = [
    api({ host: '_default', path: '/v1/items' }),
    api({ host: 'svc-a.example.com', path: '/v1/items' }),
  ];
  const out = collapseByUpstream(apis);
  assert.equal(out.length, 1);
  assert.equal(out[0].upstreamId, 'svc-a');
  assert.deepEqual(out[0].hosts, ['svc-a.example.com']);
});

test('U5: _default kept when no real-host twin exists', () => {
  const apis = [api({ host: '_default', path: '/v1/items' })];
  const out = collapseByUpstream(apis);
  assert.equal(out.length, 1);
  assert.equal(out[0].upstreamId, '_default');
  assert.deepEqual(out[0].hosts, []);
  assert.equal(out[0].canonicalHost, null);
});

test('collapse merges evidences and exportHints union', () => {
  const apis = [
    api({
      host: 'svc-a.example.com',
      path: '/v1/items',
      evidence: 'a.js:1',
      exportHint: 'getList',
      exportKey: 'src/a.js#getList',
    }),
    api({
      host: 'svc-a-stage.example.com',
      path: '/v1/items',
      evidence: 'b.js:2',
      exportHint: 'fetchItems',
      exportKey: 'src/b.js#fetchItems',
    }),
  ];
  const out = collapseByUpstream(apis);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].evidences.sort(), ['a.js:1', 'b.js:2']);
  assert.deepEqual(out[0].exportHints.sort(), ['fetchItems', 'getList']);
  assert.deepEqual(out[0].exportKeys.sort(), [
    'src/a.js#getList',
    'src/b.js#fetchItems',
  ]);
});

test('collapse takes highest confidence within group', () => {
  const apis = [
    api({ host: 'svc-a.example.com', confidence: 'medium' }),
    api({ host: 'svc-a-stage.example.com', confidence: 'high' }),
  ];
  const out = collapseByUpstream(apis);
  assert.equal(out[0].confidence, 'high');
});

test('collapse: shared hostVar with prefix-related labels merges via consensus', () => {
  const apis = [
    api({
      host: 'svc-a.example.com',
      path: '/v1/items',
      hostVar: 'apiPrefix',
    }),
    api({
      host: 'svc-a-brand-preview.example.com',
      path: '/v1/items',
      hostVar: 'apiPrefix',
    }),
  ];
  const out = collapseByUpstream(apis);
  assert.equal(out.length, 1, 'env-noise labels under same hostVar must merge');
  assert.equal(out[0].upstreamId, 'svc-a');
  assert.ok(!out[0].upstreamId.includes('apiPrefix'));
  assert.deepEqual([...out[0].hosts].sort(), [
    'svc-a-brand-preview.example.com',
    'svc-a.example.com',
  ]);
});

test('collapse: shared hostVar with true sibling fork splits by host label', () => {
  const apis = [
    api({
      host: 'one.example.com',
      path: '/v1/items',
      hostVar: 'apiPrefix',
    }),
    api({
      host: 'two.example.com',
      path: '/v1/items',
      hostVar: 'apiPrefix',
    }),
  ];
  const out = collapseByUpstream(apis);
  assert.equal(out.length, 2, 'true fork must not dump to _default or hostVar id');
  const ids = out.map((s) => s.upstreamId).sort();
  assert.deepEqual(ids, ['one', 'two']);
  assert.ok(out.every((s) => s.upstreamId !== '_default'));
  assert.ok(out.every((s) => s.upstreamId !== 'apiPrefix'));
});

test('collapse does not merge when hostVar differs', () => {
  const apis = [
    api({ host: 'one.example.com', path: '/v1/items', hostVar: 'a' }),
    api({ host: 'two.example.com', path: '/v1/items', hostVar: 'b' }),
  ];
  const out = collapseByUpstream(apis);
  assert.equal(out.length, 2, 'different hostVars must not merge');
});

test('collapse preserves responseShape from the richest member', () => {
  const apis = [
    api({ host: 'svc-a.example.com', responseShape: null }),
    api({
      host: 'svc-a-stage.example.com',
      responseShape: { type: 'array', item: { props: { name: {} } } },
    }),
  ];
  const out = collapseByUpstream(apis);
  assert.equal(out.length, 1);
  assert.ok(out[0].responseShape, 'richest responseShape preserved');
  assert.equal(out[0].responseShape.type, 'array');
});

test('collapse is pure (does not mutate input array elements)', () => {
  const apis = [
    api({ host: 'svc-a.example.com' }),
    api({ host: 'svc-a-stage.example.com' }),
  ];
  const snapshot = JSON.parse(JSON.stringify(apis));
  collapseByUpstream(apis);
  assert.deepEqual(apis.map((a) => ({ host: a.host, path: a.path })), snapshot.map((a) => ({ host: a.host, path: a.path })));
});
