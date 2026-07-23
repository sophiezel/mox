'use strict';

const fs = require('fs');
const path = require('path');
const { getDataRoot } = require('./paths');
const { parseRulesKeywords } = require('./rules');

/**
 * Local sticky pack preference (gitignored under .data/).
 * One pack name per line; blank lines and `#` whole-line comments ignored.
 * @returns {string}
 */
function rulesActivePath() {
  return path.join(getDataRoot(), 'rules-active');
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function parseRulesActiveText(text) {
  /** @type {string[]} */
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/**
 * @returns {string[]}
 */
function loadRulesActive() {
  const file = rulesActivePath();
  if (!fs.existsSync(file)) return [];
  try {
    return parseRulesActiveText(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Overwrite preference with pack names (no comments preserved).
 * @param {string[]} names
 * @returns {string[]}
 */
function saveRulesActive(names) {
  const list = [];
  for (const n of names || []) {
    const s = String(n || '').trim();
    if (s && !list.includes(s)) list.push(s);
  }
  const root = getDataRoot();
  fs.mkdirSync(root, { recursive: true });
  const body = list.length ? `${list.join('\n')}\n` : '';
  fs.writeFileSync(rulesActivePath(), body, 'utf8');
  return list;
}

/**
 * Clear sticky preference file (empty).
 */
function clearRulesActive() {
  saveRulesActive([]);
}

/**
 * CLI --rules wins; else .data/rules-active packs.
 * @param {{ rules?: string|string[]|boolean }} [opts]
 * @returns {{ keywords: string[], source: 'cli'|'rules-active'|'none' }}
 */
function resolveStartRuleKeywords(opts = {}) {
  const fromCli = parseRulesKeywords(opts.rules);
  if (fromCli.length) {
    return { keywords: fromCli, source: 'cli' };
  }
  const packs = loadRulesActive();
  if (packs.length) {
    return { keywords: packs, source: 'rules-active' };
  }
  return { keywords: [], source: 'none' };
}

module.exports = {
  rulesActivePath,
  parseRulesActiveText,
  loadRulesActive,
  saveRulesActive,
  clearRulesActive,
  resolveStartRuleKeywords,
};
