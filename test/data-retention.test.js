'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  pruneEntriesByAge,
  pruneEntriesByMaxCount,
  rotateFileBySize,
  pruneCapturesDir,
  pruneChromeProfiles,
  pruneOrphanServiceDirs,
  pruneReports,
  runDataRetention,
  resolveRetentionPolicy,
} = require('../lib/data-retention');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('pruneEntriesByAge drops older than maxAgeDays', () => {
  const now = Date.parse('2026-07-23T00:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const { keep, drop } = pruneEntriesByAge(
    [
      { path: 'a', mtimeMs: now - 8 * day },
      { path: 'b', mtimeMs: now - 2 * day },
    ],
    { maxAgeDays: 7, now },
  );
  assert.equal(drop.length, 1);
  assert.equal(drop[0].path, 'a');
  assert.equal(keep.length, 1);
  assert.equal(keep[0].path, 'b');
});

test('pruneEntriesByMaxCount keeps newest', () => {
  const { keep, drop } = pruneEntriesByMaxCount(
    [
      { path: 'old', mtimeMs: 1 },
      { path: 'mid', mtimeMs: 2 },
      { path: 'new', mtimeMs: 3 },
    ],
    { maxFiles: 2 },
  );
  assert.deepEqual(
    drop.map((e) => e.path),
    ['old'],
  );
  assert.deepEqual(
    keep.map((e) => e.path).sort(),
    ['mid', 'new'],
  );
});

test('pruneCapturesDir age then maxFiles', () => {
  const dir = tmpDir('mox-cap-');
  try {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    for (const [name, age] of [
      ['old.json', 10 * day],
      ['a.json', day],
      ['b.json', day / 2],
      ['c.json', 1000],
    ]) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, '{}');
      fs.utimesSync(p, new Date(now - age), new Date(now - age));
    }
    const r = pruneCapturesDir(dir, { maxFiles: 2, maxAgeDays: 7, now });
    assert.equal(r.removed, 2);
    assert.equal(r.kept, 2);
    assert.ok(!fs.existsSync(path.join(dir, 'old.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'a.json')));
    assert.ok(fs.existsSync(path.join(dir, 'b.json')));
    assert.ok(fs.existsSync(path.join(dir, 'c.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rotateFileBySize shifts and respects keepRotated', () => {
  const dir = tmpDir('mox-rot-');
  try {
    const file = path.join(dir, 'access.jsonl');
    fs.writeFileSync(file, 'x'.repeat(100));
    const r1 = rotateFileBySize(file, { maxBytes: 50, keepRotated: 2 });
    assert.equal(r1.rotated, true);
    assert.ok(!fs.existsSync(file));
    assert.ok(fs.existsSync(`${file}.1`));
    fs.writeFileSync(file, 'y'.repeat(100));
    rotateFileBySize(file, { maxBytes: 50, keepRotated: 2 });
    assert.ok(fs.existsSync(`${file}.1`));
    assert.ok(fs.existsSync(`${file}.2`));
    fs.writeFileSync(file, 'z'.repeat(100));
    const r3 = rotateFileBySize(file, { maxBytes: 50, keepRotated: 2 });
    assert.equal(r3.rotated, true);
    assert.ok(fs.existsSync(`${file}.1`));
    assert.ok(fs.existsSync(`${file}.2`));
    assert.ok(!fs.existsSync(`${file}.3`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneChromeProfiles removes aged dirs', () => {
  const root = tmpDir('mox-chrome-');
  try {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const oldDir = path.join(root, 'old');
    const newDir = path.join(root, 'new');
    fs.mkdirSync(oldDir);
    fs.mkdirSync(newDir);
    fs.writeFileSync(path.join(oldDir, 'x'), '1');
    fs.writeFileSync(path.join(newDir, 'x'), '1');
    fs.utimesSync(oldDir, new Date(now - 20 * day), new Date(now - 20 * day));
    fs.utimesSync(newDir, new Date(now), new Date(now));
    const r = pruneChromeProfiles(root, { maxAgeDays: 14, now });
    assert.equal(r.removed, 1);
    assert.ok(!fs.existsSync(oldDir));
    assert.ok(fs.existsSync(newDir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pruneOrphanServiceDirs removes empty shells without proxy-rules', () => {
  const root = tmpDir('mox-svc-');
  try {
    const orphan = path.join(root, 'intent-cap-x');
    const real = path.join(root, 'api');
    fs.mkdirSync(orphan);
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'proxy-rules.json'), '{}');
    const r = pruneOrphanServiceDirs(root);
    assert.equal(r.removed, 1);
    assert.ok(!fs.existsSync(orphan));
    assert.ok(fs.existsSync(real));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pruneReports keeps per prefix', () => {
  const dir = tmpDir('mox-rep-');
  try {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, `quality-gate-${1000 + i}.json`);
      fs.writeFileSync(p, '{}');
      fs.utimesSync(p, new Date(now - i * 1000), new Date(now - i * 1000));
    }
    const r = pruneReports(dir, { maxAgeDays: 0, keepPerPrefix: 2, now });
    assert.equal(r.removed, 3);
    assert.equal(r.kept, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runDataRetention orchestrates under dataRoot', () => {
  const root = tmpDir('mox-gc-');
  try {
    const cap = path.join(root, 'services', 'demo', 'captures');
    fs.mkdirSync(cap, { recursive: true });
    fs.writeFileSync(path.join(cap, 'a.json'), '{}');
    fs.writeFileSync(path.join(cap, 'b.json'), '{}');
    fs.writeFileSync(path.join(cap, 'c.json'), '{}');
    fs.mkdirSync(path.join(root, 'services', 'orphan'));
    fs.mkdirSync(path.join(root, 'audit'), { recursive: true });
    const access = path.join(root, 'audit', 'proxy-access.jsonl');
    fs.writeFileSync(access, 'x'.repeat(200));
    const summary = runDataRetention(
      root,
      {
        captures: { maxFiles: 1, maxAgeDays: 0 },
        appendLogs: {
          maxBytes: 50,
          keepRotated: 1,
          targets: ['audit/proxy-access.jsonl'],
        },
        orphanServiceDirs: true,
        reports: { maxAgeDays: 0, keepPerPrefix: 20 },
        chromeProfiles: { maxAgeDays: 0 },
      },
      { dryRun: false },
    );
    assert.ok(summary.removed >= 2);
    assert.ok(summary.rotated >= 1);
    assert.equal(fs.readdirSync(cap).filter((n) => n.endsWith('.json')).length, 1);
    assert.ok(!fs.existsSync(path.join(root, 'services', 'orphan')));
    assert.ok(fs.existsSync(`${access}.1`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveRetentionPolicy merges defaults', () => {
  const p = resolveRetentionPolicy({ captures: { maxFiles: 10 } });
  assert.equal(p.captures.maxFiles, 10);
  assert.equal(p.captures.maxAgeDays, 7);
  assert.equal(p.chromeProfiles.maxAgeDays, 14);
});
