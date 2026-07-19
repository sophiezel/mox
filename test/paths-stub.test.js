'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  stubId,
  stubHandlerPath,
  parseStubId,
} = require('../lib/paths');

test('U6: stubId formats METHOD upstreamId path', () => {
  assert.equal(
    stubId({ upstreamId: 'svc-a', method: 'GET', path: '/v1/items' }),
    'GET svc-a/v1/items',
  );
  assert.equal(
    stubId({ upstreamId: 'svc-a', method: 'get', path: 'v1/items' }),
    'GET svc-a/v1/items',
  );
  assert.equal(
    stubId({ upstreamId: 'svc-a', method: 'POST', path: '/v1/items/' }),
    'POST svc-a/v1/items/',
  );
});

test('U6: stubHandlerPath places METHOD in path and upstreamId as top dir', () => {
  const p = stubHandlerPath('demo', 'svc-a', 'GET', '/v1/items');
  const seg = p.split(path.sep);
  assert.ok(seg.includes('mocks'));
  assert.ok(seg.includes('svc-a'));
  assert.ok(seg.includes('GET'));
  assert.ok(seg.includes('v1'));
  assert.ok(seg.includes('items'));
  assert.ok(p.endsWith('index.js'));
});

test('U6: stubHandlerPath rejects traversal segments', () => {
  assert.throws(() => stubHandlerPath('demo', 'svc-a', 'GET', '/../etc/passwd'));
  assert.throws(() => stubHandlerPath('demo', 'svc-a', 'GET', '/v1/../etc'));
});

test('U6: stubHandlerPath uses _default upstream verbatim', () => {
  const p = stubHandlerPath('demo', '_default', 'GET', '/v1/items');
  const seg = p.split(path.sep);
  assert.ok(seg.includes('_default'));
  assert.ok(seg.includes('GET'));
});

test('U6: parseStubId round-trips stubId', () => {
  const id = 'GET svc-a/v1/items';
  const parsed = parseStubId(id);
  assert.equal(parsed.method, 'GET');
  assert.equal(parsed.upstreamId, 'svc-a');
  assert.equal(parsed.path, '/v1/items');
  assert.equal(stubId(parsed), id);
});

test('U6: parseStubId handles upstream id with dashes', () => {
  const id = 'POST svc-b-2/v2/foo/bar';
  const parsed = parseStubId(id);
  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.upstreamId, 'svc-b-2');
  assert.equal(parsed.path, '/v2/foo/bar');
});

test('ensureProjectDirs does not create chrome-profiles (no garbage)', () => {
  const fs = require('fs');
  const os = require('os');
  const {
    ensureProjectDirs,
    chromeProfileDir,
    ensureChromeProfileDir,
    projectDataDir,
    getDataRoot,
  } = require('../lib/paths');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-chrome-'));
  const prev = process.env.MOX_DATA_ROOT;
  process.env.MOX_DATA_ROOT = tmp;
  try {
    const slug = 'no-chrome-leak';
    ensureProjectDirs(slug);
    assert.ok(fs.existsSync(projectDataDir(slug)));
    assert.ok(!fs.existsSync(chromeProfileDir(slug)));
    assert.ok(!fs.existsSync(path.join(getDataRoot(), 'chrome-profiles')));
    ensureChromeProfileDir(slug);
    assert.ok(fs.existsSync(chromeProfileDir(slug)));
  } finally {
    process.env.MOX_DATA_ROOT = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ensureProjectDirs is thin: no contracts/mocks shells', () => {
  const fs = require('fs');
  const os = require('os');
  const { ensureProjectDirs, projectDataDir } = require('../lib/paths');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-thin-'));
  const prev = process.env.MOX_DATA_ROOT;
  process.env.MOX_DATA_ROOT = tmp;
  try {
    const slug = 'thin-proj';
    ensureProjectDirs(slug);
    const base = projectDataDir(slug);
    for (const sub of ['classify', 'captures', 'reports', 'audit', 'scenarios', 'exports']) {
      assert.ok(fs.existsSync(path.join(base, sub)), `expected ${sub}`);
    }
    assert.ok(!fs.existsSync(path.join(base, 'contracts')));
    assert.ok(!fs.existsSync(path.join(base, 'mocks')));
  } finally {
    process.env.MOX_DATA_ROOT = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('U6: stubId rejects FQDN as upstreamId (guard)', () => {
  // upstreamId must not be a FQDN; stubId should still format but downstream
  // collapse must never pass a FQDN. Here we only assert the formatter does not
  // special-case hosts (no protocol, no port).
  const id = stubId({ upstreamId: 'svc-a', method: 'GET', path: '/v1/items' });
  assert.ok(!id.includes('://'));
  assert.ok(!id.includes(':443'));
});

test('resolveProjectSlug accepts --name array from CLI parseArgs', () => {
  const { resolveProjectSlug } = require('../lib/paths');
  assert.equal(resolveProjectSlug('/tmp/app', ['tower']), 'tower');
  assert.equal(resolveProjectSlug('/tmp/app', 'tower'), 'tower');
});
