'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-svc-cat-'));
process.env.MOX_DATA_ROOT = tmpRoot;

const {
  serviceDataDir,
  ensureServiceDirs,
  serviceStubHandlerPath,
  serviceContractPath,
  listServiceIds,
  sanitizeUpstreamId,
  ensureDataDirs,
  getDataRoot,
} = require('../lib/paths');
const {
  upsertServiceRules,
  resolveActiveCatalogs,
  mergeCatalogs,
  mocksRootForStub,
} = require('../lib/catalog-merge');

const UP = 'cars-task';

before(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.MOX_DATA_ROOT;
});

test('service dirs and stub handler path under services/<upstreamId>', () => {
  ensureServiceDirs(UP);
  const base = serviceDataDir(UP);
  assert.ok(fs.existsSync(path.join(base, 'mocks')));
  assert.ok(fs.existsSync(path.join(base, 'contracts')));
  const handler = serviceStubHandlerPath(UP, 'GET', '/cars-task/list');
  assert.equal(
    handler,
    path.join(base, 'mocks', 'GET', 'cars-task', 'list', 'index.js'),
  );
  const cPath = serviceContractPath(UP, 'GET cars-task/cars-task/list');
  assert.ok(cPath.includes(path.join('services', UP, 'contracts')));
});

test('two init scans write same service catalog (no projects/)', () => {
  ensureDataDirs();
  ensureServiceDirs(UP);
  const rules = [
    {
      stubId: 'GET cars-task/cars-task/list',
      upstreamId: UP,
      pathPrefix: '/cars-task/list',
      methods: ['GET'],
      hosts: ['a.example.com'],
    },
  ];
  // Simulate two frontend scans materializing the same upstream
  upsertServiceRules(UP, rules);
  upsertServiceRules(UP, rules);

  assert.equal(listServiceIds().includes(UP), true);
  assert.ok(!fs.existsSync(path.join(getDataRoot(), 'projects')));

  const merged = mergeCatalogs([UP]);
  assert.equal(merged.rules.length, 1);
  assert.equal(merged.rules[0].stubId, 'GET cars-task/cars-task/list');
  assert.equal(merged.stubToCatalog['GET cars-task/cars-task/list'], UP);

  const root = mocksRootForStub('GET cars-task/cars-task/list');
  assert.equal(root, path.join(serviceDataDir(UP), 'mocks'));
});

test('resolveActiveCatalogs empty mounts all services', () => {
  ensureServiceDirs('svc-x');
  upsertServiceRules('svc-x', [
    {
      stubId: 'GET svc-x/ping',
      upstreamId: 'svc-x',
      pathPrefix: '/ping',
      methods: ['GET'],
    },
  ]);
  const all = resolveActiveCatalogs({});
  assert.ok(all.includes(UP) || all.includes('svc-x'));
  assert.ok(all.every((id) => typeof id === 'string'));
});

test('sanitizeUpstreamId strips unsafe chars', () => {
  assert.equal(sanitizeUpstreamId('foo/bar'), 'foo_bar');
  assert.equal(sanitizeUpstreamId(''), '_default');
});
