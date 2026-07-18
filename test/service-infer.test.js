'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-intent-'));
process.env.MOX_DATA_ROOT = tmpRoot;

const {
  inferOperationIntent,
  inferResourceClusters,
  splitResourcePath,
} = require('../lib/service-infer/operation-intent');
const { materializeStoreHandlers } = require('../lib/service-infer');
const { renderStoreHandler } = require('../lib/service-infer/store-handler');
const { writeDomainDraft } = require('../lib/service-infer/domain-draft');
const { getStore, _resetAllForTests } = require('../lib/service-store');
const { serviceStubHandlerPath, ensureServiceDirs } = require('../lib/paths');
const { upsertServiceRules } = require('../lib/catalog-merge');

test('inferOperationIntent basics', () => {
  assert.equal(inferOperationIntent({ method: 'GET', path: '/users' }), 'list');
  assert.equal(inferOperationIntent({ method: 'GET', path: '/users/{id}' }), 'detail');
  assert.equal(inferOperationIntent({ method: 'POST', path: '/users' }), 'create');
  assert.equal(inferOperationIntent({ method: 'PUT', path: '/users/1' }), 'update');
  assert.equal(inferOperationIntent({ method: 'DELETE', path: '/users/1' }), 'delete');
  assert.equal(inferOperationIntent({ method: 'POST', path: '/order/submit' }), 'submit');
});

test('inferResourceClusters pairs list+create', () => {
  const clusters = inferResourceClusters([
    { stubId: 'GET api/users', method: 'GET', path: '/users', upstreamId: 'api' },
    { stubId: 'POST api/users', method: 'POST', path: '/users', upstreamId: 'api' },
    { stubId: 'GET api/users/{id}', method: 'GET', path: '/users/{id}', upstreamId: 'api' },
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].resource, 'users');
  assert.ok(clusters[0].ops.list);
  assert.ok(clusters[0].ops.create);
  assert.ok(clusters[0].ops.detail);
});

test('store handler create then list shares state', () => {
  _resetAllForTests();
  const createSrc = renderStoreHandler({
    resource: 'users',
    op: 'create',
    stubId: 'POST api/users',
  });
  const listSrc = renderStoreHandler({
    resource: 'users',
    op: 'list',
    stubId: 'GET api/users',
  });
  const runCreate = new Function('module', 'exports', `${createSrc}\nreturn module.exports;`);
  const runList = new Function('module', 'exports', `${listSrc}\nreturn module.exports;`);
  const createHandler = runCreate({ exports: {} }, {});
  const listHandler = runList({ exports: {} }, {});
  const store = getStore('api');
  const created = createHandler({
    body: { name: 'Ada' },
    headers: {},
    store,
    path: '/users',
    query: {},
  });
  assert.equal(created.response.data.name, 'Ada');
  const listed = listHandler({
    headers: {},
    store,
    path: '/users',
    query: {},
  });
  assert.equal(listed.response.data.length, 1);
  assert.equal(listed.response.data[0].name, 'Ada');
});

test('store handler honors full case set including http_401', () => {
  const src = renderStoreHandler({
    resource: 'users',
    op: 'list',
    stubId: 'GET api/users',
  });
  const run = new Function('module', 'exports', `${src}\nreturn module.exports;`);
  const handler = run({ exports: {} }, {});
  const store = getStore('api-cases');
  const res = handler({
    headers: { 'x-mock-case': 'http_401' },
    store,
    path: '/users',
    query: {},
  });
  assert.equal(res.httpStatus, 401);
  assert.equal(res.response.code, 401);
});

test('store detail success soft-fills when row missing', () => {
  _resetAllForTests();
  const src = renderStoreHandler({
    resource: 'users',
    op: 'detail',
    stubId: 'GET api/users/1',
  });
  const run = new Function('module', 'exports', `${src}\nreturn module.exports;`);
  const handler = run({ exports: {} }, {});
  const store = getStore('api-detail');
  const res = handler({
    headers: {},
    store,
    path: '/users/1',
    query: {},
  });
  assert.equal(res.httpStatus, 200);
  assert.equal(res.response.data.id, '1');
});

test('materializeStoreHandlers writes store handlers + models', () => {
  ensureServiceDirs('shop');
  upsertServiceRules('shop', [
    { stubId: 'GET shop/items', upstreamId: 'shop', pathPrefix: '/items', methods: ['GET'] },
    { stubId: 'POST shop/items', upstreamId: 'shop', pathPrefix: '/items', methods: ['POST'] },
  ]);
  const result = materializeStoreHandlers('shop', [
    { stubId: 'GET shop/items', method: 'GET', path: '/items', upstreamId: 'shop' },
    { stubId: 'POST shop/items', method: 'POST', path: '/items', upstreamId: 'shop' },
  ]);
  assert.ok(result.clusters >= 1);
  assert.ok(result.rewritten.length >= 1);
  const file = serviceStubHandlerPath('shop', 'POST', '/items');
  assert.ok(fs.existsSync(file));
  assert.ok(fs.readFileSync(file, 'utf8').includes('mox:store'));
});

test('domain-draft writes md and models', () => {
  ensureServiceDirs('shop');
  const out = writeDomainDraft({
    upstreamId: 'shop',
    stubs: [
      { stubId: 'GET shop/items', method: 'GET', path: '/items', upstreamId: 'shop' },
      { stubId: 'POST shop/items', method: 'POST', path: '/items', upstreamId: 'shop' },
    ],
  });
  assert.ok(fs.existsSync(out.draftPath));
  assert.ok(fs.readFileSync(out.draftPath, 'utf8').includes('Domain draft'));
});

test('splitResourcePath', () => {
  assert.deepEqual(splitResourcePath('/users/{id}'), {
    basePath: '/users',
    hasId: true,
  });
  assert.deepEqual(splitResourcePath('/users'), {
    basePath: '/users',
    hasId: false,
  });
});
