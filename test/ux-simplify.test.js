'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { help, hintForError } = require('../bin/mox');
const {
  getStore,
  resetStore,
  appendJournal,
  readJournal,
  journalSummary,
  _resetAllForTests,
} = require('../lib/service-store');
const { stopSession } = require('../scripts/stop-session');
const { applySessionOpts } = require('../scripts/start-session');

beforeEach(() => {
  _resetAllForTests();
});

test('help mentions --detach for background sessions', () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    help(true);
    const full = lines.join('\n');
    assert.ok(full.includes('--detach'));
  } finally {
    console.log = orig;
  }
});

test('help primary omits service/domain-draft; --all includes them', () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    help(false);
    const primary = lines.join('\n');
    assert.ok(primary.includes('mox init'));
    assert.ok(primary.includes('learning-path.md'));
    assert.ok(!primary.includes('mox service reset'));
    assert.ok(!primary.includes('mox domain-draft'));
    assert.ok(primary.includes('help --all'));

    lines.length = 0;
    help(true);
    const full = lines.join('\n');
    assert.ok(full.includes('mox service reset'));
    assert.ok(full.includes('mox domain-draft'));
    assert.ok(full.includes('--keep-state'));
    assert.ok(full.includes('guide-l6-advanced.md'));
  } finally {
    console.log = orig;
  }
});

test('hintForError maps common failures to guide anchors', () => {
  assert.match(hintForError('mock port in use: 127.0.0.1:3900'), /guide-l0/);
  assert.match(hintForError('no classify result — run mox init'), /guide-l1/);
  assert.match(
    hintForError('--record and --traffic= are mutually exclusive'),
    /guide-l2/,
  );
  assert.match(hintForError('unknown command'), /guide-l6/);
  assert.match(hintForError('materialize failed'), /guide-l6/);
  assert.match(hintForError('something else'), /learning-path/);
});

test('journal persists to disk for cross-process stop summary', () => {
  const journalFile = path.join(
    os.tmpdir(),
    `mock-journal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
  const prev = process.env.MOX_JOURNAL_FILE;
  process.env.MOX_JOURNAL_FILE = journalFile;
  const {
    appendJournal,
    journalSummary,
    readJournal,
    _resetAllForTests,
    _emptyMemoryJournalForTests,
  } = require('../lib/service-store');
  try {
    _resetAllForTests();
    appendJournal({
      stubId: 'GET a/x',
      method: 'GET',
      path: '/x',
      upstreamId: 'a',
    });
    appendJournal({
      stubId: 'POST a/x',
      method: 'POST',
      path: '/x',
      upstreamId: 'a',
    });
    assert.ok(fs.existsSync(journalFile));
    _emptyMemoryJournalForTests();
    const fromDisk = readJournal(10);
    assert.equal(fromDisk.length, 2);
    const summary = journalSummary();
    assert.equal(summary.hits, 2);
    assert.match(summary.line, /journal: 2 hit/);
  } finally {
    process.env.MOX_JOURNAL_FILE = prev;
    try {
      fs.unlinkSync(journalFile);
    } catch {
      /* ignore */
    }
    _resetAllForTests();
  }
});

test('resetStore(*) clears journal file', () => {
  const journalFile = path.join(
    os.tmpdir(),
    `mock-journal-reset-${Date.now()}.json`,
  );
  const prev = process.env.MOX_JOURNAL_FILE;
  process.env.MOX_JOURNAL_FILE = journalFile;
  try {
    _resetAllForTests();
    appendJournal({ stubId: 'GET a/x', method: 'GET', path: '/x', upstreamId: 'a' });
    assert.ok(fs.existsSync(journalFile));
    resetStore('*');
    assert.ok(!fs.existsSync(journalFile));
    assert.equal(readJournal(10).length, 0);
  } finally {
    process.env.MOX_JOURNAL_FILE = prev;
    _resetAllForTests();
  }
});

test('stopSession prints journal one-liner', () => {
  const journalFile = path.join(
    os.tmpdir(),
    `mock-journal-stop-${Date.now()}.json`,
  );
  const runtimeFile = path.join(os.tmpdir(), `mock-runtime-stop-${Date.now()}.json`);
  const sessionFile = path.join(os.tmpdir(), `mock-session-stop-${Date.now()}.json`);
  const prevJ = process.env.MOX_JOURNAL_FILE;
  const prevR = process.env.MOX_RUNTIME_FILE;
  const prevS = process.env.MOX_SESSION_FILE;
  process.env.MOX_JOURNAL_FILE = journalFile;
  process.env.MOX_RUNTIME_FILE = runtimeFile;
  process.env.MOX_SESSION_FILE = sessionFile;
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    _resetAllForTests();
    appendJournal({
      stubId: 'GET demo/x',
      method: 'GET',
      path: '/x',
      upstreamId: 'demo',
    });
    const result = stopSession({ projectDir: process.cwd(), name: 'no-such-slug-ux' });
    assert.equal(result.journalHits, 1);
    assert.ok(logs.some((l) => /journal: 1 hit/.test(l)));
  } finally {
    console.log = orig;
    process.env.MOX_JOURNAL_FILE = prevJ;
    process.env.MOX_RUNTIME_FILE = prevR;
    process.env.MOX_SESSION_FILE = prevS;
    for (const f of [journalFile, runtimeFile, sessionFile]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    _resetAllForTests();
  }
});

test('applySessionOpts still ignores unknown keep-state (handled in startSession)', () => {
  const base = { mock: { port: 3900 }, proxy: { port: 18999, enabled: true } };
  const next = applySessionOpts(base, { keepState: true });
  assert.equal(next.mock.port, 3900);
});

test('getStore survives until resetStore all', () => {
  getStore('ux').put('k', 1);
  assert.equal(getStore('ux').get('k'), 1);
  resetStore('*');
  assert.equal(getStore('ux').get('k'), null);
});
