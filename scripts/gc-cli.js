'use strict';

const { getDataRoot } = require('../lib/paths');
const { loadSession } = require('../lib/session-config');
const {
  runDataRetention,
  resolveRetentionPolicy,
} = require('../lib/data-retention');

/**
 * @param {{ dryRun?: boolean }} [opts]
 */
function runGcCli(opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const cfg = loadSession();
  const policy = resolveRetentionPolicy(cfg.dataRetention);
  const summary = runDataRetention(getDataRoot(), policy, { dryRun });
  const tag = dryRun ? 'gc dry-run' : 'gc';
  console.log(
    `[mox] ${tag} removed=${summary.removed} rotated=${summary.rotated} kept=${summary.kept}`,
  );
  for (const [k, v] of Object.entries(summary.details || {})) {
    console.log(`[mox]   ${k}: ${JSON.stringify(v)}`);
  }
  return summary;
}

module.exports = { runGcCli };
