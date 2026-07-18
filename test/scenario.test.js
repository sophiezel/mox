'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  projectDataDir,
  ensureProjectDirs,
} = require('../lib/paths');
const { copyBuiltinScenarios, loadScenario, listScenarios } = require('../lib/scenario');
const { setScenario } = require('../scripts/set-scenario');
const { loadSession } = require('../lib/session-config');

const SLUG = 'scenario-test-isolated';

function withIsolatedSession(fn) {
  const sessionFile = path.join(os.tmpdir(), `${SLUG}-${Date.now()}-session.json`);
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

function cleanup() {
  fs.rmSync(projectDataDir(SLUG), { recursive: true, force: true });
}

test('loadScenario reads builtin e2e-happy/fault/slow', () => {
  cleanup();
  ensureProjectDirs(SLUG);
  assert.equal(loadScenario(SLUG, 'e2e-happy').default, 'success');
  assert.equal(loadScenario(SLUG, 'e2e-fault').default, 'http_500');
  assert.equal(loadScenario(SLUG, 'e2e-slow').default, 'slow');
  cleanup();
});

test('copyBuiltinScenarios + listScenarios', () => {
  cleanup();
  ensureProjectDirs(SLUG);
  copyBuiltinScenarios(SLUG);
  const list = listScenarios(SLUG);
  assert.ok(list.includes('e2e-happy'));
  assert.ok(list.includes('e2e-fault'));
  assert.ok(list.includes('e2e-slow'));
  cleanup();
});

test('setScenario applies default + per-api to session cases', () => {
  withIsolatedSession(() => {
    cleanup();
    ensureProjectDirs(SLUG);
    const dir = projectDataDir(SLUG);
    const scenDir = path.join(dir, 'scenarios');
    fs.mkdirSync(scenDir, { recursive: true });
    fs.writeFileSync(
      path.join(scenDir, 'custom.json'),
      JSON.stringify({ default: 'http_502', apis: { 'GET api.example.com/v1/users': 'http_401' } }),
    );
    setScenario({ name: SLUG, scenario: 'custom' });
    const cfg = loadSession(SLUG);
    assert.equal(cfg.cases.default, 'http_502');
    assert.equal(cfg.cases.active['GET api.example.com/v1/users'], 'http_401');
    cleanup();
  });
});

test('setScenario unknown name throws', () => {
  cleanup();
  ensureProjectDirs(SLUG);
  assert.throws(() => setScenario({ name: SLUG, scenario: 'does-not-exist' }), /scenario not found/);
  cleanup();
});

test('loadScenario rejects invalid JSON shape', () => {
  cleanup();
  ensureProjectDirs(SLUG);
  const scenDir = path.join(projectDataDir(SLUG), 'scenarios');
  fs.mkdirSync(scenDir, { recursive: true });
  fs.writeFileSync(path.join(scenDir, 'bad-array.json'), '[]');
  assert.throws(() => loadScenario(SLUG, 'bad-array'), /invalid scenario/);
  fs.writeFileSync(
    path.join(scenDir, 'bad-apis.json'),
    JSON.stringify({ default: 'success', apis: ['nope'] }),
  );
  assert.throws(() => loadScenario(SLUG, 'bad-apis'), /apis must be object/);
  fs.writeFileSync(
    path.join(scenDir, 'bad-case.json'),
    JSON.stringify({ default: 123 }),
  );
  assert.throws(() => loadScenario(SLUG, 'bad-case'), /default must be string/);
  cleanup();
});
