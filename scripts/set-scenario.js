'use strict';

const { resolveProjectSlug } = require('../lib/paths');
const { loadSession, saveSession } = require('../lib/session-config');
const { appendAudit } = require('../lib/audit');
const { loadScenario, listScenarios } = require('../lib/scenario');

function setScenario(opts = {}) {
  const projectSlug = resolveProjectSlug(
    opts.projectDir || process.cwd(),
    opts.name,
  );
  const name = opts.scenario;
  if (!name) {
    const avail = listScenarios(projectSlug);
    throw new Error(`Usage: mox set-scenario <name>. Available: ${avail.join(', ') || '(none)'}`);
  }
  const scenario = loadScenario(projectSlug, name);
  const cfg = loadSession(projectSlug);
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
  saveSession(projectSlug, {
    scenario: name,
    cases: { active, default: defaultCase },
    stateful,
  });
  appendAudit(projectSlug, {
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
