'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  ensureDataDirs,
  serviceDataDir,
  getGlobalSessionPath,
} = require('../lib/paths');
const {
  loadSession,
  saveSession,
} = require('../lib/session-config');
const {
  mergeCatalogs,
  parseNameList,
  resolveActiveCatalogs,
} = require('../lib/catalog-merge');
const {
  loadAndMergeRules,
  applyRulesToSession,
  resolveRuleKeyword,
  saveRulesFromSession,
  parseRulesKeywords,
} = require('../lib/rules');
const { parseArgs } = require('../bin/mox');

const TMP = path.join(os.tmpdir(), `mox-rules-test-${Date.now()}`);

function withIsolatedSession(fn) {
  const sessionFile = path.join(
    os.tmpdir(),
    `rules-sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
  const prev = process.env.MOX_SESSION_FILE;
  process.env.MOX_SESSION_FILE = sessionFile;
  try {
    return fn(sessionFile);
  } finally {
    process.env.MOX_SESSION_FILE = prev;
    try {
      fs.unlinkSync(sessionFile);
    } catch (_) {
      /* ignore */
    }
  }
}

function writeServiceRules(upstreamId, rules) {
  ensureDataDirs();
  const base = serviceDataDir(upstreamId);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(
    path.join(base, 'proxy-rules.json'),
    `${JSON.stringify(rules, null, 2)}\n`,
  );
}

test('parseNameList and parseRulesKeywords', () => {
  assert.deepEqual(parseNameList('a,b'), ['a', 'b']);
  assert.deepEqual(parseNameList(['x', 'y']), ['x', 'y']);
  assert.deepEqual(parseRulesKeywords(['jian-h5', 'xrk']), ['jian-h5', 'xrk']);
  assert.deepEqual(parseRulesKeywords('a,b c'), ['a', 'b', 'c']);
});

test('parseArgs accumulates --name and --rules', () => {
  const p = parseArgs([
    'node',
    'mox',
    'start',
    '--name=tower',
    '--name=other',
    '--rules',
    'jian-h5',
    'xrk',
  ]);
  assert.deepEqual(p.flags.name, ['tower', 'other']);
  assert.deepEqual(p.flags.rules, ['jian-h5', 'xrk']);

  const comma = parseArgs([
    'node',
    'mox',
    'start',
    '--rules=csp-trade,csp-tasks',
  ]);
  assert.deepEqual(comma.flags.rules, ['csp-trade', 'csp-tasks']);

  const logFlag = parseArgs([
    'node',
    'mox',
    'start',
    '--proxy-log=verbose',
  ]);
  assert.equal(logFlag.flags['proxy-log'], 'verbose');
});

test('global session save/load ignores project path', () => {
  withIsolatedSession((sessionFile) => {
    saveSession({ proxy: { trafficMode: 'selective', mockAllowlist: ['GET a/b'] } });
    const cfg = loadSession();
    assert.equal(cfg.proxy.trafficMode, 'selective');
    assert.deepEqual(cfg.proxy.mockAllowlist, ['GET a/b']);
    assert.ok(fs.existsSync(sessionFile));
    assert.equal(getGlobalSessionPath(), sessionFile);
  });
});

test('mergeCatalogs unions rules and fails on stubId conflict', () => {
  const a = `up-a-${Date.now()}`;
  const b = `up-b-${Date.now()}`;
  writeServiceRules(a, [
    {
      stubId: 'GET up-a/v1/x',
      upstreamId: 'up-a',
      hosts: ['a.example.com'],
      pathPrefix: '/v1/x',
      methods: ['GET'],
    },
  ]);
  writeServiceRules(b, [
    {
      stubId: 'GET up-b/v1/y',
      upstreamId: 'up-b',
      hosts: ['b.example.com'],
      pathPrefix: '/v1/y',
      methods: ['GET'],
    },
  ]);
  const ok = mergeCatalogs([a, b]);
  assert.equal(ok.rules.length, 2);
  assert.equal(ok.stubToCatalog['GET up-a/v1/x'], a);
  assert.equal(ok.stubToCatalog['GET up-b/v1/y'], b);

  writeServiceRules(b, [
    {
      stubId: 'GET up-a/v1/x',
      upstreamId: 'up-a',
      hosts: ['b.example.com'],
      pathPrefix: '/v1/x',
      methods: ['GET'],
    },
  ]);
  assert.throws(() => mergeCatalogs([a, b]), /stubId conflict/);

  fs.rmSync(serviceDataDir(a), { recursive: true, force: true });
  fs.rmSync(serviceDataDir(b), { recursive: true, force: true });
});

test('rules keyword resolve + multi merge + apply selective', () => {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(
    path.join(TMP, 'jian-h5.json'),
    JSON.stringify({
      stubs: ['GET up/a', 'GET up/b'],
      cases: { default: 'success', active: { 'GET up/a': 'biz_error' } },
    }),
  );
  fs.writeFileSync(
    path.join(TMP, 'jian-app.json'),
    JSON.stringify({ stubs: ['GET up/z'] }),
  );
  fs.writeFileSync(
    path.join(TMP, 'xrk.json'),
    JSON.stringify({ stubs: ['GET up/b', 'GET up/c'] }),
  );

  assert.equal(resolveRuleKeyword('xrk', TMP), 'xrk');
  assert.throws(() => resolveRuleKeyword('jian', TMP), /ambiguous/);
  assert.throws(() => resolveRuleKeyword('nope', TMP), /no rule/);

  const merged = loadAndMergeRules(['jian-h5', 'xrk'], TMP);
  assert.deepEqual(merged.resolved, ['jian-h5', 'xrk']);
  assert.deepEqual(merged.stubs.sort(), ['GET up/a', 'GET up/b', 'GET up/c']);
  assert.equal(merged.cases.active['GET up/a'], 'biz_error');

  withIsolatedSession(() => {
    applyRulesToSession(['jian-h5', 'xrk'], { rulesDir: TMP });
    const cfg = loadSession();
    assert.equal(cfg.proxy.trafficMode, 'selective');
    assert.equal(cfg.proxy.mockAllowlist.length, 3);
    assert.deepEqual(cfg.activeRules, ['jian-h5', 'xrk']);

    saveRulesFromSession('roundtrip', { rulesDir: TMP });
    assert.ok(fs.existsSync(path.join(TMP, 'roundtrip.json')));
  });
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('multi --rules merges hits and skips missing names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-rules-multi-'));
  const prevData = process.env.MOX_DATA_ROOT;
  const prevSession = process.env.MOX_SESSION_FILE;
  process.env.MOX_DATA_ROOT = root;
  process.env.MOX_SESSION_FILE = path.join(root, 'session.json');
  try {
    ensureDataDirs();
    const rulesDir = path.join(root, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'csp-trade.txt'),
      'https://api.example.com/v1/users http://127.0.0.1/v1/users\n',
    );
    fs.writeFileSync(
      path.join(rulesDir, 'csp-tasks.json'),
      JSON.stringify({ stubs: ['GET up/tasks'] }),
    );

    const { loadAndMergeRules, applyRulesToSession } = require('../lib/rules');
    const merged = loadAndMergeRules(
      ['csp-trade', 'missing-pack', 'csp-tasks'],
      rulesDir,
    );
    assert.deepEqual(merged.resolved, ['csp-trade', 'csp-tasks']);
    assert.deepEqual(merged.skipped, ['missing-pack']);
    assert.ok(merged.stubs.some((id) => /users/.test(id)));
    assert.ok(merged.stubs.includes('GET up/tasks'));

    const { session, applied } = applyRulesToSession(
      ['csp-trade', 'nope', 'csp-tasks'],
      { rulesDir },
    );
    assert.equal(applied, true);
    assert.equal(session.proxy.trafficMode, 'selective');
    assert.deepEqual(session.activeRules, ['csp-trade', 'csp-tasks']);
    assert.ok(session.proxy.mockAllowlist.includes('GET up/tasks'));

    const none = applyRulesToSession(['ghost-a', 'ghost-b'], { rulesDir });
    assert.equal(none.applied, false);
    assert.deepEqual(none.merged.skipped, ['ghost-a', 'ghost-b']);
    assert.deepEqual(loadSession().activeRules, ['csp-trade', 'csp-tasks']);
  } finally {
    if (prevData === undefined) delete process.env.MOX_DATA_ROOT;
    else process.env.MOX_DATA_ROOT = prevData;
    if (prevSession === undefined) delete process.env.MOX_SESSION_FILE;
    else process.env.MOX_SESSION_FILE = prevSession;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Whistle .txt map via --rules sets selective + allowlist + captureMitmHosts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-rules-txt-'));
  const prevData = process.env.MOX_DATA_ROOT;
  const prevSession = process.env.MOX_SESSION_FILE;
  process.env.MOX_DATA_ROOT = root;
  process.env.MOX_SESSION_FILE = path.join(root, 'session.json');
  try {
    ensureDataDirs();
    const rulesDir = path.join(root, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'csp-trade.txt'),
      [
        '# comment',
        'https://api.example.com/v1/users http://127.0.0.1/v1/users',
        'https://pay.example.com/checkout http://127.0.0.1/checkout',
        '',
      ].join('\n'),
    );

    const {
      listRuleNames,
      resolveRuleEntry,
      applyRulesToSession,
    } = require('../lib/rules');
    assert.ok(listRuleNames(rulesDir).includes('csp-trade'));
    assert.equal(resolveRuleEntry('csp-trade', rulesDir).kind, 'map');

    const { merged, session } = applyRulesToSession(['csp-trade'], {
      rulesDir,
    });
    assert.deepEqual(merged.resolved, ['csp-trade']);
    assert.ok(merged.stubs.some((id) => /users/.test(id)));
    assert.ok(merged.stubs.some((id) => /checkout/.test(id)));
    assert.equal(session.proxy.trafficMode, 'selective');
    assert.ok(session.proxy.mockAllowlist.length >= 2);
    assert.ok(
      (session.proxy.captureMitmHosts || []).includes('api.example.com'),
    );
    assert.ok(
      (session.proxy.captureMitmHosts || []).includes('pay.example.com'),
    );
    assert.deepEqual(session.activeRules, ['csp-trade']);

    const { serviceDataDir } = require('../lib/paths');
    const { normalizeHostLabel } = require('../lib/upstream');
    const up = normalizeHostLabel('api.example.com') || 'api-example-com';
    const proxyRules = path.join(serviceDataDir(up), 'proxy-rules.json');
    assert.ok(fs.existsSync(proxyRules), `expected ${proxyRules}`);
  } finally {
    if (prevData === undefined) delete process.env.MOX_DATA_ROOT;
    else process.env.MOX_DATA_ROOT = prevData;
    if (prevSession === undefined) delete process.env.MOX_SESSION_FILE;
    else process.env.MOX_SESSION_FILE = prevSession;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveActiveCatalogs requires existing proxy-rules', () => {
  const missing = `missing-${Date.now()}`;
  assert.throws(
    () => resolveActiveCatalogs({ names: missing }),
    /service not found/,
  );
});
