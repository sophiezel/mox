'use strict';

/**
 * Brand hard-cut gate: product tree must not retain the former product name.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FORBIDDEN = [
  /mock-skill/i,
  /MOCK_SKILL/,
  /api-mock-orchestrator/i,
  /\.mock-skill/,
];

const SCAN_DIRS = [
  'bin',
  'lib',
  'runtime',
  'scripts',
  'adapters',
  'config',
  'assets',
  'references',
  'docs',
  'test',
  'fixtures',
];

const SCAN_ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'README.md',
  'SKILL.md',
  'CHANGELOG.md',
  'LICENSE',
  'eslint.config.js',
];

const SCAN_EXT = new Set([
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.json',
  '.md',
  '.sh',
  '.yml',
  '.yaml',
  '.tmpl',
]);

function* walk(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.data') {
        continue;
      }
      yield* walk(full);
    } else if (e.isFile() && SCAN_EXT.has(path.extname(e.name))) {
      yield full;
    }
  }
}

function scan() {
  const offenders = [];
  const files = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) files.push(f);
  }
  for (const name of SCAN_ROOT_FILES) {
    const abs = path.join(ROOT, name);
    if (fs.existsSync(abs)) files.push(abs);
  }
  for (const file of files) {
    // This gate file itself mentions forbidden patterns as regexes — skip self.
    if (file.endsWith(`${path.sep}brand-rename.test.js`)) continue;
    const body = fs.readFileSync(file, 'utf8');
    for (const re of FORBIDDEN) {
      if (re.test(body)) {
        offenders.push({ file: path.relative(ROOT, file), pattern: re.source });
        break;
      }
    }
  }
  return offenders;
}

test('brand hard-cut: no former product name strings in tree', () => {
  const offenders = scan();
  assert.deepEqual(
    offenders,
    [],
    `former brand strings found: ${JSON.stringify(offenders)}`,
  );
});
