'use strict';

const fs = require('fs');
const path = require('path');
const { scenariosDir, ensureDataDirs, ROOT } = require('./paths');

const BUILTIN_SCENARIOS_DIR = path.join(ROOT, 'assets', 'scenarios');

function listScenarios() {
  const dir = scenariosDir();
  const out = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) out.push(f.replace(/\.json$/, ''));
    }
  }
  return out;
}

function assertScenarioShape(raw, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`invalid scenario ${name}: expected object with optional default/apis`);
  }
  if (raw.default != null && typeof raw.default !== 'string') {
    throw new Error(`invalid scenario ${name}: default must be string`);
  }
  if (raw.apis != null) {
    if (typeof raw.apis !== 'object' || Array.isArray(raw.apis)) {
      throw new Error(`invalid scenario ${name}: apis must be object`);
    }
    for (const [k, v] of Object.entries(raw.apis)) {
      if (typeof v !== 'string') {
        throw new Error(`invalid scenario ${name}: apis["${k}"] must be string caseId`);
      }
    }
  }
  if (raw.times != null) {
    if (typeof raw.times !== 'object' || Array.isArray(raw.times)) {
      throw new Error(`invalid scenario ${name}: times must be object`);
    }
  }
  if (raw.state != null && typeof raw.state !== 'string') {
    throw new Error(`invalid scenario ${name}: state must be string`);
  }
  return raw;
}

/** Compat: loadScenario(name) or loadScenario(_ignoredSlug, name) */
function loadScenario(a, b) {
  const name = b != null ? b : a;
  const dir = scenariosDir();
  const file = path.join(dir, `${name}.json`);
  const builtin = path.join(BUILTIN_SCENARIOS_DIR, `${name}.json`);
  const src = fs.existsSync(file)
    ? file
    : fs.existsSync(builtin)
      ? builtin
      : null;
  if (!src) {
    throw new Error(
      `scenario not found: ${name} (looked in ${dir} and ${BUILTIN_SCENARIOS_DIR})`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(src, 'utf8'));
  } catch (err) {
    throw new Error(`invalid scenario ${name}: JSON parse failed (${err.message})`);
  }
  return assertScenarioShape(raw, name);
}

function copyBuiltinScenarios() {
  ensureDataDirs();
  const dir = scenariosDir();
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(BUILTIN_SCENARIOS_DIR)) return [];
  const copied = [];
  for (const f of fs.readdirSync(BUILTIN_SCENARIOS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const dest = path.join(dir, f);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(BUILTIN_SCENARIOS_DIR, f), dest);
      copied.push(f);
    }
  }
  return copied;
}

module.exports = {
  scenariosDir,
  listScenarios,
  loadScenario,
  assertScenarioShape,
  copyBuiltinScenarios,
  BUILTIN_SCENARIOS_DIR,
};
