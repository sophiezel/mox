'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  seedPath,
  readSeed,
  writeSeed,
  upsertSeedRows,
  listSeedResources,
  hydrateSeedsIntoStores,
} = require('../../lib/virtual-service/seed-store');
const {
  getStore,
  _resetAllForTests,
} = require('../../lib/service-store');

let tmpRoot;
let prevDataRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-seed-'));
  prevDataRoot = process.env.MOX_DATA_ROOT;
  process.env.MOX_DATA_ROOT = tmpRoot;
  _resetAllForTests();
});

afterEach(() => {
  if (prevDataRoot === undefined) delete process.env.MOX_DATA_ROOT;
  else process.env.MOX_DATA_ROOT = prevDataRoot;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  _resetAllForTests();
});

test('upsertSeedRows merges by id and persists under services/<id>/seeds/', () => {
  upsertSeedRows('jian-j', 'tradeAppoint', [
    { id: 1, title: 'a' },
    { id: 2, title: 'b' },
  ]);
  upsertSeedRows('jian-j', 'tradeAppoint', [{ id: 2, title: 'b2' }, { id: 3 }]);
  const seed = readSeed('jian-j', 'tradeAppoint');
  assert.equal(seed.rows.length, 3);
  assert.equal(seed.rows.find((r) => r.id === '2').title, 'b2');
  assert.ok(fs.existsSync(seedPath('jian-j', 'tradeAppoint')));
});

test('hydrateSeedsIntoStores loads all catalog seeds after reset', () => {
  upsertSeedRows('api', 'items', [
    { id: 'x', name: 'one' },
    { id: 'y', name: 'two' },
  ]);
  // Formal catalog marker so listServiceIds finds it
  const base = path.join(tmpRoot, 'services', 'api');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'proxy-rules.json'), '[]\n');

  _resetAllForTests();
  assert.equal(getStore('api').collectionList('items').length, 0);

  const n = hydrateSeedsIntoStores(['api']);
  assert.equal(n, 1);
  assert.equal(getStore('api').collectionList('items').length, 2);
  assert.deepEqual(getStore('api').collectionGet('items', 'x'), {
    id: 'x',
    name: 'one',
  });
});

test('listSeedResources returns resource names for upstream', () => {
  upsertSeedRows('svc', 'alpha', [{ id: 1 }]);
  upsertSeedRows('svc', 'beta', [{ id: 2 }]);
  assert.deepEqual(listSeedResources('svc').sort(), ['alpha', 'beta']);
});
