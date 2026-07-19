'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureDataDirs, scenariosDir } = require('../lib/paths');
const { copyBuiltinScenarios, loadScenario, listScenarios } = require('../lib/scenario');
const { setScenario } = require('../scripts/set-scenario');
const { loadSession } = require('../lib/session-config');

function withIsolatedSession(fn) {
  const sessionFile = path.join(os.tmpdir(), `scenario-test-${Date.now()}-session.json`);
  const prev = process.env.MOX_SESSION_FILE;
  process.env.MOX_SESSION_FILE = sessionFile;
  try {
    return fn();
  } finally {
    process.env.MOX_SESSION_FILE = prev;
    try {
      fs.unlinkSync(sessionFile);
    } catch (_) {
      /* ignore */
    }
  }
}

function cleanupScenarios() {
  const dir = scenariosDir();
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
}

test('loadScenario reads builtin e2e-happy/fault/slow', () => {
  ensureDataDirs();
  assert.equal(loadScenario('e2e-happy').default, 'success');
  assert.equal(loadScenario('e2e-fault').default, 'http_500');
  assert.equal(loadScenario('e2e-slow').default, 'slow');
});

test('copyBuiltinScenarios + listScenarios', () => {
  cleanupScenarios();
  ensureDataDirs();
  copyBuiltinScenarios();
  const list = listScenarios();
  assert.ok(list.includes('e2e-happy'));
  assert.ok(list.includes('e2e-fault'));
  assert.ok(list.includes('e2e-slow'));
  cleanupScenarios();
});

test('setScenario applies default + per-api to session cases', () => {
  withIsolatedSession(() => {
    cleanupScenarios();
    ensureDataDirs();
    const scenDir = scenariosDir();
    fs.mkdirSync(scenDir, { recursive: true });
    fs.writeFileSync(
      path.join(scenDir, 'custom.json'),
      JSON.stringify({ default: 'http_502', apis: { 'GET api.example.com/v1/users': 'http_401' } }),
    );
    setScenario({ scenario: 'custom' });
    const cfg = loadSession();
    assert.equal(cfg.cases.default, 'http_502');
    assert.equal(cfg.cases.active['GET api.example.com/v1/users'], 'http_401');
    cleanupScenarios();
  });
});

test('setScenario unknown name throws', () => {
  cleanupScenarios();
  ensureDataDirs();
  assert.throws(() => setScenario({ scenario: 'does-not-exist' }), /scenario not found/);
});

test('loadScenario rejects invalid JSON shape', () => {
  cleanupScenarios();
  ensureDataDirs();
  const scenDir = scenariosDir();
  fs.mkdirSync(scenDir, { recursive: true });
  fs.writeFileSync(path.join(scenDir, 'bad-array.json'), '[]');
  assert.throws(() => loadScenario('bad-array'), /invalid scenario/);
  fs.writeFileSync(
    path.join(scenDir, 'bad-apis.json'),
    JSON.stringify({ default: 'success', apis: ['nope'] }),
  );
  assert.throws(() => loadScenario('bad-apis'), /apis must be object/);
  fs.writeFileSync(
    path.join(scenDir, 'bad-case.json'),
    JSON.stringify({ default: 123 }),
  );
  assert.throws(() => loadScenario('bad-case'), /default must be string/);
  cleanupScenarios();
});
