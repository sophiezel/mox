'use strict';

const fs = require('fs');
const path = require('path');
const { rulesDir } = require('./paths');
const { loadSession, saveSession } = require('./session-config');
const { parseMapFile, materializeMapRows, planMapRows } = require('./map-import');

/**
 * @param {string} [dirOverride]
 * @returns {string}
 */
function ensureRulesDir(dirOverride) {
  const dir = rulesDir(dirOverride);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Rule pack names: basename of `*.json` (stubs) or Whistle-like `*.txt` (map).
 * @param {string} [dirOverride]
 * @returns {string[]}
 */
function listRuleNames(dirOverride) {
  const dir = ensureRulesDir(dirOverride);
  const names = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) names.add(f.replace(/\.json$/, ''));
    else if (f.endsWith('.txt')) names.add(f.replace(/\.txt$/, ''));
  }
  return [...names].sort();
}

/**
 * Prefer .json stubs pack; else Whistle .txt map.
 * @param {string} name
 * @param {string} [dirOverride]
 * @returns {{ name: string, kind: 'json'|'map', file: string }}
 */
function resolveRuleEntry(name, dirOverride) {
  const dir = ensureRulesDir(dirOverride);
  const jsonFile = path.join(dir, `${name}.json`);
  const txtFile = path.join(dir, `${name}.txt`);
  if (fs.existsSync(jsonFile)) {
    return { name, kind: 'json', file: jsonFile };
  }
  if (fs.existsSync(txtFile)) {
    return { name, kind: 'map', file: txtFile };
  }
  throw new Error(`rule file not found: ${jsonFile} (or ${name}.txt)`);
}

/**
 * @param {unknown} raw
 * @param {string} name
 */
function assertRuleShape(raw, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`invalid rule ${name}: expected object`);
  }
  if (!Array.isArray(raw.stubs)) {
    throw new Error(`invalid rule ${name}: stubs must be an array`);
  }
  for (let i = 0; i < raw.stubs.length; i++) {
    if (typeof raw.stubs[i] !== 'string' || !raw.stubs[i].trim()) {
      throw new Error(`invalid rule ${name}: stubs[${i}] must be non-empty string`);
    }
  }
  if (raw.cases != null) {
    if (typeof raw.cases !== 'object' || Array.isArray(raw.cases)) {
      throw new Error(`invalid rule ${name}: cases must be object`);
    }
    if (raw.cases.default != null && typeof raw.cases.default !== 'string') {
      throw new Error(`invalid rule ${name}: cases.default must be string`);
    }
    if (raw.cases.active != null) {
      if (
        typeof raw.cases.active !== 'object' ||
        Array.isArray(raw.cases.active)
      ) {
        throw new Error(`invalid rule ${name}: cases.active must be object`);
      }
      for (const [k, v] of Object.entries(raw.cases.active)) {
        if (typeof v !== 'string') {
          throw new Error(
            `invalid rule ${name}: cases.active["${k}"] must be string`,
          );
        }
      }
    }
  }
}

/**
 * Resolve one keyword to a rule basename (without .json/.txt).
 * Exact match first; else unique substring/prefix match.
 * @param {string} keyword
 * @param {string} [dirOverride]
 * @param {{ optional?: boolean }} [opts] — optional: return null when no match (still throws on ambiguous)
 * @returns {string|null}
 */
function resolveRuleKeyword(keyword, dirOverride, opts = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('empty rules keyword');
  const names = listRuleNames(dirOverride);
  if (names.includes(kw)) return kw;

  const hits = names.filter(
    (n) => n.includes(kw) || n.startsWith(kw) || kw.startsWith(n),
  );
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) {
    if (opts.optional) return null;
    throw new Error(
      `no rule matching "${kw}" in ${rulesDir(dirOverride)} (have: ${
        names.join(', ') || 'none'
      })`,
    );
  }
  throw new Error(
    `ambiguous rule keyword "${kw}" matches: ${hits.join(', ')}`,
  );
}

/**
 * @param {string} name
 * @param {string} [dirOverride]
 */
function loadRuleFile(name, dirOverride) {
  const entry = resolveRuleEntry(name, dirOverride);
  if (entry.kind === 'map') {
    const rows = parseMapFile(entry.file);
    if (!rows.length) {
      throw new Error(`invalid rule ${name}: empty map file`);
    }
    const { stubIds } = planMapRows(rows);
    return {
      name,
      file: entry.file,
      kind: 'map',
      stubs: stubIds,
      cases: null,
      rows,
    };
  }

  const raw = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
  assertRuleShape(raw, name);
  return {
    name,
    file: entry.file,
    kind: 'json',
    stubs: [...raw.stubs],
    cases: raw.cases || null,
  };
}

/**
 * Merge multiple rule keywords (comma/space list). Missing names are skipped;
 * ambiguous keywords still throw. Found packs/maps are union-merged.
 * @param {string[]} keywords
 * @param {string} [dirOverride]
 */
function loadAndMergeRules(keywords, dirOverride) {
  const keys = (keywords || []).map((k) => String(k).trim()).filter(Boolean);
  if (!keys.length) {
    throw new Error('need at least one rules keyword');
  }
  /** @type {string[]} */
  const stubs = [];
  const seen = new Set();
  /** @type {{ default?: string, active: Record<string, string> }} */
  const cases = { active: {} };
  let hasCases = false;
  const resolved = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {object[]} */
  const mapRules = [];

  for (const kw of keys) {
    const name = resolveRuleKeyword(kw, dirOverride, { optional: true });
    if (!name) {
      if (!skipped.includes(kw)) skipped.push(kw);
      continue;
    }
    if (resolved.includes(name)) continue;
    resolved.push(name);
    const rule = loadRuleFile(name, dirOverride);
    if (rule.kind === 'map') mapRules.push(rule);
    for (const s of rule.stubs) {
      if (!seen.has(s)) {
        seen.add(s);
        stubs.push(s);
      }
    }
    if (rule.cases) {
      hasCases = true;
      if (rule.cases.default) cases.default = rule.cases.default;
      if (rule.cases.active) {
        Object.assign(cases.active, rule.cases.active);
      }
    }
  }

  return {
    resolved,
    skipped,
    stubs,
    mapRules,
    cases: hasCases
      ? {
          default: cases.default || 'success',
          active: cases.active,
        }
      : null,
  };
}

/**
 * Apply merged rules into global session (selective + allowlist).
 * Whistle `.txt` maps also upsert proxy-rules + captureMitmHosts.
 * Multi: `--rules=a,b` merges hits; missing keywords are skipped (no throw).
 * @param {string[]} keywords
 * @param {{ rulesDir?: string }} [opts]
 */
function applyRulesToSession(keywords, opts = {}) {
  const merged = loadAndMergeRules(keywords, opts.rulesDir);

  if (merged.skipped.length) {
    console.log(
      `[mox] rules skip (not found): ${merged.skipped.join(', ')}`,
    );
  }

  if (!merged.resolved.length) {
    console.log('[mox] rules: none matched; leaving session unchanged');
    return { merged, session: loadSession(), applied: false };
  }

  /** @type {string[]} */
  const hosts = [];
  for (const rule of merged.mapRules || []) {
    const { hosts: hs } = materializeMapRows(rule.rows || []);
    for (const h of hs) {
      if (!hosts.includes(h)) hosts.push(h);
    }
  }

  const prev = loadSession();
  const prevHosts = Array.isArray(prev.proxy?.captureMitmHosts)
    ? prev.proxy.captureMitmHosts
    : [];
  const captureMitmHosts = [...prevHosts];
  for (const h of hosts) {
    if (!captureMitmHosts.includes(h)) captureMitmHosts.push(h);
  }

  const patch = {
    proxy: {
      ...(prev.proxy || {}),
      trafficMode: 'selective',
      mockAllowlist: merged.stubs,
      ...(hosts.length ? { captureMitmHosts } : {}),
    },
    activeRules: merged.resolved,
  };
  if (merged.cases) {
    patch.cases = merged.cases;
  }
  const cfg = saveSession(patch);
  return { merged, session: cfg, applied: true };
}

/**
 * Save current session allowlist/cases as a named rule file.
 * @param {string} name
 * @param {{ rulesDir?: string }} [opts]
 */
function saveRulesFromSession(name, opts = {}) {
  const safe = String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-');
  if (!safe) throw new Error('rules save: need a name');
  const cfg = loadSession();
  const stubs = Array.isArray(cfg.proxy?.mockAllowlist)
    ? [...cfg.proxy.mockAllowlist]
    : [];
  const body = {
    stubs,
    cases: {
      default: cfg.cases?.default || 'success',
      active: { ...(cfg.cases?.active || {}) },
    },
  };
  assertRuleShape(body, safe);
  const dir = ensureRulesDir(opts.rulesDir);
  const file = path.join(dir, `${safe}.json`);
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return { name: safe, file, stubs: stubs.length };
}

/**
 * Parse CLI --rules values into keyword list.
 * @param {string|string[]|boolean|undefined} raw
 * @returns {string[]}
 */
function parseRulesKeywords(raw) {
  if (raw == null || raw === false || raw === true) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const p of parts) {
    for (const bit of String(p).split(/[,\s]+/)) {
      const s = bit.trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

module.exports = {
  ensureRulesDir,
  listRuleNames,
  resolveRuleEntry,
  assertRuleShape,
  resolveRuleKeyword,
  loadRuleFile,
  loadAndMergeRules,
  applyRulesToSession,
  saveRulesFromSession,
  parseRulesKeywords,
  rulesDir,
};
