'use strict';

const { loadSession, saveSession } = require('../lib/session-config');
const { appendAudit } = require('../lib/audit');
const {
  listRuleNames,
  applyRulesToSession,
  saveRulesFromSession,
  parseRulesKeywords,
  rulesDir,
} = require('../lib/rules');
const {
  loadRulesActive,
  saveRulesActive,
  clearRulesActive,
} = require('../lib/rules-active');

/**
 * @param {object} opts
 * @param {'list'|'use'|'save'|'clear'} opts.action
 * @param {string[]} [opts.keywords]
 * @param {string} [opts.name] — for save
 * @param {string} [opts.rulesDir]
 */
function runRules(opts = {}) {
  const action = String(opts.action || 'list').toLowerCase();
  const dir = opts.rulesDir;

  if (action === 'list') {
    const names = listRuleNames(dir);
    console.log(`[mox] rules dir: ${rulesDir(dir)}`);
    if (!names.length) {
      console.log('[mox] (no rule files)');
    } else {
      for (const n of names) console.log(`  - ${n}`);
    }
    const pref = loadRulesActive();
    if (pref.length) {
      console.log(`[mox] rules-active: ${pref.join(', ')}`);
    }
    const cfg = loadSession();
    if (cfg.activeRules?.length) {
      console.log(`[mox] activeRules: ${cfg.activeRules.join(', ')}`);
    }
    console.log(
      `[mox] trafficMode=${cfg.proxy?.trafficMode || 'all-mock'} allowlist=${(cfg.proxy?.mockAllowlist || []).length}`,
    );
    return { names, dir: rulesDir(dir), preference: pref };
  }

  if (action === 'use') {
    const keywords = parseRulesKeywords(opts.keywords || opts._);
    if (!keywords.length) {
      throw new Error('Usage: mox rules use <keyword> [keyword…]');
    }
    const { merged, applied } = applyRulesToSession(keywords, {
      rulesDir: dir,
    });
    if (applied && merged.resolved.length) {
      saveRulesActive(merged.resolved);
    }
    const primary = loadSession().activeCatalogs?.[0] || 'default';
    appendAudit(primary, {
      command: 'rules use',
      summary: `rules=${merged.resolved.join(',')} stubs=${merged.stubs.length}`,
    });
    console.log(
      `[mox] rules applied: ${merged.resolved.join(', ') || '(none)'} (${merged.stubs.length} stubs, selective)`,
    );
    if (applied) {
      console.log('[mox] sticky packs → .data/rules-active');
    }
    console.log('[mox] session picks up via ≤1s cache; no restart needed');
    return merged;
  }

  if (action === 'save') {
    const name = opts.name || (opts.keywords && opts.keywords[0]);
    if (!name) {
      throw new Error('Usage: mox rules save <name>');
    }
    const result = saveRulesFromSession(name, { rulesDir: dir });
    const primary = loadSession().activeCatalogs?.[0] || 'default';
    appendAudit(primary, {
      command: 'rules save',
      summary: `name=${result.name} stubs=${result.stubs}`,
    });
    console.log(
      `[mox] saved rule ${result.name} (${result.stubs} stubs) → ${result.file}`,
    );
    return result;
  }

  if (action === 'clear') {
    clearRulesActive();
    const prev = loadSession();
    const cfg = saveSession({
      activeRules: [],
      proxy: {
        ...(prev.proxy || {}),
        trafficMode: 'all-mock',
        mockAllowlist: [],
      },
    });
    const primary = cfg.activeCatalogs?.[0] || 'default';
    appendAudit(primary, {
      command: 'rules clear',
      summary: 'rules-active cleared; trafficMode=all-mock',
    });
    console.log('[mox] rules-active cleared; trafficMode=all-mock allowlist=0');
    return { preference: [], session: cfg };
  }

  throw new Error(`unknown rules action: ${action}`);
}

module.exports = { runRules };

if (require.main === module) {
  try {
    runRules({
      action: process.argv[2] || 'list',
      keywords: process.argv.slice(3),
      name: process.argv[3],
    });
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}
