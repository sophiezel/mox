'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  ensureProjectDirs,
  projectDataDir,
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

function writeCatalog(slug, rules) {
  ensureProjectDirs(slug);
  fs.writeFileSync(
    path.join(projectDataDir(slug), 'proxy-rules.json'),
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
  const a = `cat-a-${Date.now()}`;
  const b = `cat-b-${Date.now()}`;
  writeCatalog(a, [
    {
      stubId: 'GET up-a/v1/x',
      upstreamId: 'up-a',
      hosts: ['a.example.com'],
      pathPrefix: '/v1/x',
      methods: ['GET'],
    },
  ]);
  writeCatalog(b, [
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

  writeCatalog(b, [
    {
      stubId: 'GET up-a/v1/x',
      upstreamId: 'up-a',
      hosts: ['b.example.com'],
      pathPrefix: '/v1/x',
      methods: ['GET'],
    },
  ]);
  assert.throws(() => mergeCatalogs([a, b]), /stubId conflict/);

  fs.rmSync(projectDataDir(a), { recursive: true, force: true });
  fs.rmSync(projectDataDir(b), { recursive: true, force: true });
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

test('resolveActiveCatalogs requires existing proxy-rules', () => {
  const missing = `missing-${Date.now()}`;
  assert.throws(
    () => resolveActiveCatalogs({ names: missing }),
    /catalog not found/,
  );
});
