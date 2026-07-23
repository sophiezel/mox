'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveUpstreamId } = require('../lib/upstream');
const {
  resolveServiceIdFromHost,
  resolveCaptureStagingDir,
} = require('../lib/resolve-service-id-from-host');

test('resolveServiceIdFromHost: existing upstreams map wins over derive', () => {
  const host = 'api-preview.example.com';
  const derived = resolveUpstreamId({ hosts: [host] });
  assert.ok(derived);
  assert.notEqual(derived, 'carsource-api');

  const id = resolveServiceIdFromHost(host, {
    upstreams: {
      version: 1,
      upstreams: {
        'carsource-api': {
          hosts: [host],
          canonicalHost: host,
        },
      },
    },
  });
  assert.equal(id, 'carsource-api');
});

test('resolveServiceIdFromHost: unknown resolvable host matches resolveUpstreamId', () => {
  const host = 'jian-j.example.com';
  const expected = resolveUpstreamId({ hosts: [host] });
  assert.equal(expected, 'jian-j');
  assert.equal(resolveServiceIdFromHost(host), expected);
  assert.equal(resolveServiceIdFromHost(host, { upstreams: { version: 1, upstreams: {} } }), expected);
});

test('resolveServiceIdFromHost: noise host yields null', () => {
  assert.equal(resolveServiceIdFromHost('www.google.com'), null);
  assert.equal(resolveServiceIdFromHost('cdn.sentry.io'), null);
});

test('resolveServiceIdFromHost: empty / _default / unresolvable yield null', () => {
  assert.equal(resolveServiceIdFromHost(''), null);
  assert.equal(resolveServiceIdFromHost(null), null);
  assert.equal(resolveServiceIdFromHost('_default'), null);
  // pure env token label → no consensus identity
  assert.equal(resolveServiceIdFromHost('dev.example.com'), null);
});

test('resolveCaptureStagingDir: no stubId stages under derived service captures', () => {
  const prev = process.env.MOX_DATA_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-stage-'));
  process.env.MOX_DATA_ROOT = tmp;
  try {
    const host = 'jian-j.example.com';
    const dir = resolveCaptureStagingDir({
      host,
      primary: 'unrelated-primary',
      stubToCatalog: {},
    });
    assert.ok(dir);
    assert.ok(dir.endsWith(path.join('services', 'jian-j', 'captures')));
    assert.ok(fs.existsSync(dir));
    assert.ok(!fs.existsSync(path.join(tmp, 'services', 'jian-j', 'proxy-rules.json')));
    assert.ok(!fs.existsSync(path.join(tmp, 'services', 'jian-j', 'contracts')));
    assert.ok(!fs.existsSync(path.join(tmp, 'services', 'unrelated-primary')));
  } finally {
    if (prev === undefined) delete process.env.MOX_DATA_ROOT;
    else process.env.MOX_DATA_ROOT = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveCaptureStagingDir: noise host yields null (no dir)', () => {
  const prev = process.env.MOX_DATA_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-stage-n-'));
  process.env.MOX_DATA_ROOT = tmp;
  try {
    assert.equal(
      resolveCaptureStagingDir({
        host: 'www.google.com',
        primary: 'primary-svc',
      }),
      null,
    );
    assert.ok(!fs.existsSync(path.join(tmp, 'services')));
  } finally {
    if (prev === undefined) delete process.env.MOX_DATA_ROOT;
    else process.env.MOX_DATA_ROOT = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
