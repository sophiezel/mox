'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { setTraffic } = require('../scripts/set-traffic');
const { loadSession } = require('../lib/session-config');

function withSlug(fn) {
  const slug = `traffic-cli-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sessionFile = path.join(os.tmpdir(), `${slug}-session.json`);
  const prev = process.env.MOX_SESSION_FILE;
  process.env.MOX_SESSION_FILE = sessionFile;
  try {
    return fn(slug);
  } finally {
    process.env.MOX_SESSION_FILE = prev;
    try {
      fs.unlinkSync(sessionFile);
    } catch (_) {
      /* ignore */
    }
    const { projectDataDir } = require('../lib/paths');
    const dir = projectDataDir(slug);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI1: traffic mode persists to session.json', () => {
  withSlug((slug) => {
    setTraffic({ name: slug, action: 'all-passthrough' });
    const cfg = loadSession(slug);
    assert.equal(cfg.proxy.trafficMode, 'all-passthrough');
  });
});

test('CLI2: allow / deny / clear allowlist', () => {
  withSlug((slug) => {
    setTraffic({ name: slug, action: 'selective' });
    setTraffic({
      name: slug,
      action: 'allow',
      stubId: 'GET svc-a/v1/items',
    });
    let cfg = loadSession(slug);
    assert.deepEqual(cfg.proxy.mockAllowlist, ['GET svc-a/v1/items']);
    setTraffic({
      name: slug,
      action: 'allow',
      stubId: 'GET svc-a/v1/items',
    }); // dedupe
    cfg = loadSession(slug);
    assert.equal(cfg.proxy.mockAllowlist.length, 1);
    setTraffic({
      name: slug,
      action: 'deny',
      stubId: 'GET svc-a/v1/items',
    });
    cfg = loadSession(slug);
    assert.deepEqual(cfg.proxy.mockAllowlist, []);
    setTraffic({
      name: slug,
      action: 'allow',
      stubId: 'GET svc-a/v1/items',
    });
    setTraffic({ name: slug, action: 'clear' });
    cfg = loadSession(slug);
    assert.deepEqual(cfg.proxy.mockAllowlist, []);
  });
});

test('CLI3: reject FQDN stubId', () => {
  withSlug((slug) => {
    assert.throws(
      () =>
        setTraffic({
          name: slug,
          action: 'allow',
          stubId: 'GET api.example.com/v1/items',
        }),
      /FQDN|stubId/,
    );
  });
});

test('CLI4: list returns current state', () => {
  withSlug((slug) => {
    setTraffic({ name: slug, action: 'selective' });
    const out = setTraffic({ name: slug, action: 'list' });
    assert.equal(out.trafficMode, 'selective');
    assert.ok(Array.isArray(out.mockAllowlist));
  });
});
