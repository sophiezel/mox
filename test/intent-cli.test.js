'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveStartTraffic } = require('../bin/mox');
const { setTraffic } = require('../scripts/set-traffic');
const { loadSession, saveSession } = require('../lib/session-config');
const { applySessionOpts } = require('../scripts/start-session');
const {
  stopSession,
  countCaptureFiles,
  hintMergeIfCaptures,
} = require('../scripts/stop-session');
const { ensureDataDirs } = require('../lib/paths');
const { capturesDirFor } = require('../lib/catalog-merge');
const { setScenario } = require('../scripts/set-scenario');
const { copyBuiltinScenarios } = require('../lib/scenario');

function withSlug(fn) {
  const slug = `intent-cli-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sessionFile = path.join(os.tmpdir(), `${slug}-session.json`);
  const runtimeFile = path.join(os.tmpdir(), `${slug}-runtime.json`);
  const prevS = process.env.MOX_SESSION_FILE;
  const prevR = process.env.MOX_RUNTIME_FILE;
  process.env.MOX_SESSION_FILE = sessionFile;
  process.env.MOX_RUNTIME_FILE = runtimeFile;
  ensureDataDirs();
  try {
    return fn(slug);
  } finally {
    process.env.MOX_SESSION_FILE = prevS;
    process.env.MOX_RUNTIME_FILE = prevR;
    for (const f of [sessionFile, runtimeFile]) {
      try {
        fs.unlinkSync(f);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

test('intent: --capture-open maps to capture-open (not all-passthrough)', () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    assert.equal(resolveStartTraffic({ 'capture-open': true }), null);
    assert.ok(logs.some((l) => l.includes('mode=capture-open')));
  } finally {
    console.log = orig;
  }
});

test('intent: --capture-open and --traffic= are mutually exclusive', () => {
  assert.throws(
    () => resolveStartTraffic({ 'capture-open': true, traffic: 'all-mock' }),
    /mutually exclusive/,
  );
});

test('intent: --capture-open with --rules does not force all-passthrough', () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    assert.equal(
      resolveStartTraffic({ 'capture-open': true, rules: ['jian-h5'] }),
      null,
    );
    assert.ok(logs.some((l) => l.includes('selective mock + capture-open')));
  } finally {
    console.log = orig;
  }
});

test('intent: rules + capture-open keeps selective and enables recordMisses', () => {
  withSlug((slug) => {
    const rulesDir = path.join(os.tmpdir(), `intent-rules-${slug}`);
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'jian-h5.json'),
      JSON.stringify({ stubs: ['GET up/a'] }),
    );
    try {
      const { applyRulesToSession } = require('../lib/rules');
      applyRulesToSession(['jian-h5'], { rulesDir });
      saveSession({
        proxy: {
          ...(loadSession().proxy || {}),
          recordMisses: true,
        },
      });
      const cfg = loadSession();
      assert.equal(cfg.proxy.trafficMode, 'selective');
      assert.deepEqual(cfg.proxy.mockAllowlist, ['GET up/a']);
      assert.notEqual(cfg.proxy.recordMisses, false);
    } finally {
      fs.rmSync(rulesDir, { recursive: true, force: true });
    }
  });
});

test('intent: plain start leaves traffic unset (caller keeps default all-mock)', () => {
  assert.equal(resolveStartTraffic({}), null);
  assert.equal(resolveStartTraffic({ traffic: 'selective' }), 'selective');
});

test('intent: start --capture-open persistence path writes proxy.mode=capture-open', () => {
  withSlug((slug) => {
    const traffic = resolveStartTraffic({ 'capture-open': true });
    assert.equal(traffic, null);
    const applied = applySessionOpts(loadSession(slug), { captureOpen: true });
    assert.equal(applied.proxy.mode, 'capture-open');
    assert.notEqual(applied.proxy.recordMisses, false);
    assert.notEqual(applied.proxy.trafficMode, 'all-passthrough');
  });
});

test('intent: passthrough / mock hot-switch match traffic actions', () => {
  withSlug((slug) => {
    setTraffic({ name: slug, action: 'all-passthrough' });
    assert.equal(loadSession(slug).proxy.trafficMode, 'all-passthrough');
    setTraffic({ name: slug, action: 'all-mock' });
    assert.equal(loadSession(slug).proxy.trafficMode, 'all-mock');
  });
});

test('intent: scenario alias target setScenario works', () => {
  withSlug((slug) => {
    copyBuiltinScenarios();
    setScenario({ name: slug, scenario: 'e2e-happy' });
    assert.equal(loadSession(slug).scenario, 'e2e-happy');
  });
});

test('intent: stop hints merge when captures exist', () => {
  withSlug((slug) => {
    const up = `intent-cap-${slug}`;
    const capDir = capturesDirFor(up);
    fs.mkdirSync(capDir, { recursive: true });
    fs.writeFileSync(path.join(capDir, 'sample.json'), '{}\n');
    assert.equal(countCaptureFiles([up]), 1);

    const logs = [];
    const orig = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      const n = hintMergeIfCaptures([up]);
      assert.equal(n, 1);
      assert.ok(logs.some((l) => l.includes('hint:') && l.includes('merge')));
    } finally {
      console.log = orig;
    }

    const out = stopSession({ name: up });
    assert.equal(out.killed, false);
    assert.equal(out.captureCount, 1);
    try {
      fs.rmSync(capDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  });
});

test('intent: stop --auto-merge invokes capture-merge', () => {
  withSlug((slug) => {
    const up = `intent-merge-${slug}`;
    const capDir = capturesDirFor(up);
    fs.mkdirSync(capDir, { recursive: true });
    fs.writeFileSync(
      path.join(capDir, 'GET__x.json'),
      JSON.stringify({
        method: 'GET',
        url: 'https://example.com/x',
        status: 200,
        body: { code: 0, data: { a: 1 } },
      }),
    );
    const out = stopSession({ name: up, autoMerge: true });
    assert.ok(out.mergeResult);
    const first = Array.isArray(out.mergeResult)
      ? out.mergeResult[0]
      : out.mergeResult;
    assert.equal(typeof first.merged, 'number');
    try {
      fs.rmSync(capDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  });
});
