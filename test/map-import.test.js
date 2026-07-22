'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('parseMapFile extracts host and pathPrefix from whistle-like two-column lines', () => {
  const { parseMapFile, parseMapText } = require('../lib/map-import');
  const text = `
# comment
https://api.example.com/v1/users http://127.0.0.1/v1/users
https://pay.example.com/checkout http://127.0.0.1:3900/checkout

https://cdn.example.com/static http://127.0.0.1/static
`;
  const rows = parseMapText(text);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    host: 'api.example.com',
    pathPrefix: '/v1/users',
    localUrl: 'http://127.0.0.1/v1/users',
  });
  assert.deepEqual(rows[1], {
    host: 'pay.example.com',
    pathPrefix: '/checkout',
    localUrl: 'http://127.0.0.1:3900/checkout',
  });
  assert.equal(rows[2].host, 'cdn.example.com');
  assert.equal(rows[2].pathPrefix, '/static');

  const file = path.join(os.tmpdir(), `mox-map-${Date.now()}.txt`);
  fs.writeFileSync(file, text);
  try {
    const fromFile = parseMapFile(file);
    assert.equal(fromFile.length, 3);
    assert.equal(fromFile[0].host, 'api.example.com');
  } finally {
    fs.unlinkSync(file);
  }
});

test('parseMapText rejects illegal lines with exit-style error', () => {
  const { parseMapText } = require('../lib/map-import');
  assert.throws(
    () => parseMapText('not-a-url somehow'),
    /invalid map line/i,
  );
});

test('map import sets trafficMode selective and allowlist for listed paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-map-apply-'));
  const prevData = process.env.MOX_DATA_ROOT;
  const prevSession = process.env.MOX_SESSION_FILE;
  process.env.MOX_DATA_ROOT = root;
  process.env.MOX_SESSION_FILE = path.join(root, 'session.json');
  try {
    const { ensureDataDirs } = require('../lib/paths');
    ensureDataDirs();
    const mapFile = path.join(root, 'map.txt');
    fs.writeFileSync(
      mapFile,
      'https://api.example.com/v1/users http://127.0.0.1/v1/users\n',
    );
    const { applyMapImport } = require('../lib/map-import');
    const out = applyMapImport(mapFile);
    assert.ok(out.stubIds.length >= 1);
    assert.ok(
      out.stubIds.some((id) => /users/.test(id)),
      `expected path in stubIds: ${out.stubIds}`,
    );

    const { loadSession } = require('../lib/session-config');
    const cfg = loadSession();
    assert.equal(cfg.proxy.trafficMode, 'selective');
    assert.ok(Array.isArray(cfg.proxy.mockAllowlist));
    assert.ok(cfg.proxy.mockAllowlist.length >= 1);
    assert.ok(
      cfg.proxy.mockAllowlist.every((id) => out.stubIds.includes(id)),
    );
    assert.ok(
      (cfg.proxy.captureMitmHosts || []).includes('api.example.com'),
    );
  } finally {
    if (prevData === undefined) delete process.env.MOX_DATA_ROOT;
    else process.env.MOX_DATA_ROOT = prevData;
    if (prevSession === undefined) delete process.env.MOX_SESSION_FILE;
    else process.env.MOX_SESSION_FILE = prevSession;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
