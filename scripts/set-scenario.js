'use strict';

const { resolveScanLabel } = require('../lib/paths');
const { loadSession, saveSession } = require('../lib/session-config');
const { appendAudit } = require('../lib/audit');
const { loadScenario, listScenarios } = require('../lib/scenario');

function setScenario(opts = {}) {
  const label = resolveScanLabel(
    opts.projectDir || process.cwd(),
    opts.name,
  );
  const name = opts.scenario;
  if (!name) {
    const avail = listScenarios();
    throw new Error(`Usage: mox set-scenario <name>. Available: ${avail.join(', ') || '(none)'}`);
  }
  const scenario = loadScenario(name);
  if (Array.isArray(scenario.requiredStubs) && scenario.requiredStubs.length) {
    const { loadContractsAcross, handlerExistsForContract } = require('../lib/catalog-merge');
    const contracts = loadContractsAcross(null);
    const byId = new Map(contracts.map((c) => [c.stubId || c.id, c]));
    const missing = [];
    for (const stubId of scenario.requiredStubs) {
      const c = byId.get(stubId);
      if (!c) {
        missing.push(stubId);
        continue;
      }
      const gaps = (c.coverage && c.coverage.gaps) || [];
      if (gaps.includes('TRACE_EMPTY') || !handlerExistsForContract(c)) {
        missing.push(stubId);
      }
    }
    if (missing.length) {
      throw new Error(
        `requiredStubs missing from catalog (or empty/no handler): ${missing.join(', ')}`,
      );
    }
  }
  const cfg = loadSession();
  const active = { ...(cfg.cases?.active || {}) };
  if (scenario.apis && typeof scenario.apis === 'object') {
    for (const [apiId, caseId] of Object.entries(scenario.apis)) {
      active[apiId] = caseId;
    }
  }
  const defaultCase = scenario.default || cfg.cases?.default || 'success';
  const stateful =
    scenario.times || scenario.transitions || scenario.state
      ? {
          state: scenario.state || 'Started',
          times: scenario.times || {},
          transitions: scenario.transitions || null,
        }
      : null;
  saveSession({
    scenario: name,
    cases: { active, default: defaultCase },
    stateful,
  });
  appendAudit(label, {
    command: 'set-scenario',
    taskId: opts.taskId || null,
    summary: `scenario=${name} default=${defaultCase} apis=${Object.keys(scenario.apis || {}).length}`,
  });
  console.log(`[mox] scenario ${name} applied (default=${defaultCase}, apis=${Object.keys(scenario.apis || {}).length})`);
  console.log('[mox] session picks up via ≤1s cache; no restart needed');
}

module.exports = { setScenario };

if (require.main === module) {
  setScenario({ scenario: process.argv[2] });
}
