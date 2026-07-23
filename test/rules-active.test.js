'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  parseRulesActiveText,
  loadRulesActive,
  saveRulesActive,
  clearRulesActive,
  clearPackGateFromSession,
  syncEmptyPackPreferenceToSession,
  resolveStartRuleKeywords,
  rulesActivePath,
} = require('../lib/rules-active');
const { applyRulesToSession } = require('../lib/rules');
const { loadSession, saveSession } = require('../lib/session-config');
const { runRules } = require('../scripts/rules-cli');

function withDataRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-rules-active-'));
  const prevRoot = process.env.MOX_DATA_ROOT;
  const prevSess = process.env.MOX_SESSION_FILE;
  process.env.MOX_DATA_ROOT = root;
  delete process.env.MOX_SESSION_FILE;
  try {
    return fn(root);
  } finally {
    if (prevRoot == null) delete process.env.MOX_DATA_ROOT;
    else process.env.MOX_DATA_ROOT = prevRoot;
    if (prevSess == null) delete process.env.MOX_SESSION_FILE;
    else process.env.MOX_SESSION_FILE = prevSess;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('parseRulesActiveText: blanks, # comments, dedupe', () => {
  assert.deepEqual(
    parseRulesActiveText(`
# sticky packs
csp-trade

# csp-tasks
csp-trade
csp-tasks
`),
    ['csp-trade', 'csp-tasks'],
  );
  assert.deepEqual(parseRulesActiveText(''), []);
  assert.deepEqual(parseRulesActiveText('# only\n\n'), []);
});

test('save/load/clear rules-active under MOX_DATA_ROOT', () => {
  withDataRoot((root) => {
    assert.deepEqual(loadRulesActive(), []);
    assert.equal(rulesActivePath(), path.join(root, 'rules-active'));

    saveRulesActive(['csp-trade', 'csp-tasks']);
    assert.equal(
      fs.readFileSync(rulesActivePath(), 'utf8'),
      'csp-trade\ncsp-tasks\n',
    );
    assert.deepEqual(loadRulesActive(), ['csp-trade', 'csp-tasks']);

    clearRulesActive();
    assert.deepEqual(loadRulesActive(), []);
    assert.equal(fs.readFileSync(rulesActivePath(), 'utf8'), '');
  });
});

test('resolveStartRuleKeywords: CLI overrides rules-active', () => {
  withDataRoot(() => {
    saveRulesActive(['from-file']);
    assert.deepEqual(resolveStartRuleKeywords({ rules: 'cli-a,cli-b' }), {
      keywords: ['cli-a', 'cli-b'],
      source: 'cli',
    });
    assert.deepEqual(resolveStartRuleKeywords({}), {
      keywords: ['from-file'],
      source: 'rules-active',
    });
    clearRulesActive();
    assert.deepEqual(resolveStartRuleKeywords({}), {
      keywords: [],
      source: 'none',
    });
  });
});

test('rules use writes sticky; clear resets session + preference', () => {
  withDataRoot(() => {
    const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-rpack-'));
    try {
      fs.writeFileSync(
        path.join(rulesDir, 'pack-a.json'),
        `${JSON.stringify({ stubs: ['GET svc/a'] }, null, 2)}\n`,
      );
      runRules({
        action: 'use',
        keywords: ['pack-a'],
        rulesDir,
      });
      assert.deepEqual(loadRulesActive(), ['pack-a']);
      assert.equal(loadSession().proxy.trafficMode, 'selective');
      assert.deepEqual(loadSession().proxy.mockAllowlist, ['GET svc/a']);
      assert.deepEqual(loadSession().activeRules, ['pack-a']);

      // Simulate traffic hand-edit
      saveSession({
        proxy: {
          ...loadSession().proxy,
          mockAllowlist: ['GET svc/hand'],
        },
      });
      assert.deepEqual(loadSession().proxy.mockAllowlist, ['GET svc/hand']);

      // Sticky re-apply overwrites hand edit (boundary)
      applyRulesToSession(['pack-a'], { rulesDir });
      assert.deepEqual(loadSession().proxy.mockAllowlist, ['GET svc/a']);

      runRules({ action: 'clear' });
      assert.deepEqual(loadRulesActive(), []);
      assert.equal(loadSession().proxy.trafficMode, 'selective');
      assert.deepEqual(loadSession().proxy.mockAllowlist, []);
      assert.deepEqual(loadSession().activeRules, []);
    } finally {
      fs.rmSync(rulesDir, { recursive: true, force: true });
    }
  });
});

test('syncEmptyPackPreferenceToSession clears stale pack gate', () => {
  withDataRoot(() => {
    saveSession({
      activeRules: ['csp-trade'],
      proxy: {
        trafficMode: 'selective',
        mockAllowlist: [
          'GET jian-j/csp-task/external/trade/appoint/getTradeAppointDetail',
        ],
      },
    });
    clearRulesActive();
    const sync = syncEmptyPackPreferenceToSession();
    assert.equal(sync.cleared, true);
    assert.deepEqual(loadSession().activeRules, []);
    assert.deepEqual(loadSession().proxy.mockAllowlist, []);
    assert.equal(loadSession().proxy.trafficMode, 'selective');
  });
});

test('syncEmptyPackPreferenceToSession leaves virgin session alone', () => {
  withDataRoot(() => {
    saveSession({
      activeRules: [],
      proxy: { trafficMode: 'all-mock', mockAllowlist: [] },
    });
    const before = loadSession();
    const sync = syncEmptyPackPreferenceToSession();
    assert.equal(sync.cleared, false);
    assert.equal(loadSession().proxy.trafficMode, before.proxy.trafficMode);
    assert.deepEqual(loadSession().activeRules, []);
  });
});

test('clearPackGateFromSession sets selective empty allowlist', () => {
  withDataRoot(() => {
    saveSession({
      activeRules: ['x'],
      proxy: { trafficMode: 'all-mock', mockAllowlist: ['GET a/b'] },
    });
    clearPackGateFromSession();
    assert.deepEqual(loadSession().activeRules, []);
    assert.deepEqual(loadSession().proxy.mockAllowlist, []);
    assert.equal(loadSession().proxy.trafficMode, 'selective');
  });
});
