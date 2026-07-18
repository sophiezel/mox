'use strict';

const { resolveProjectSlug, parseStubId } = require('../lib/paths');
const { loadSession, saveSession } = require('../lib/session-config');
const { appendAudit } = require('../lib/audit');

const STUB_ID_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) [A-Za-z0-9._-]+\//;

/**
 * Validate apiId is a stubId (METHOD upstreamId/path), not a FQDN-based key.
 * @param {string} apiId
 */
function assertStubId(apiId) {
  if (!STUB_ID_RE.test(apiId)) {
    throw new Error(
      `set-case apiId must be a stubId (e.g. "GET svc-a/v1/items"), got: ${apiId}`,
    );
  }
  const { upstreamId } = parseStubId(apiId);
  if (upstreamId.includes('.')) {
    throw new Error(
      `set-case apiId must not use FQDN as upstreamId (got "${upstreamId}"); use stubId instead`,
    );
  }
}

function setCase(opts = {}) {
  const projectSlug = resolveProjectSlug(
    opts.projectDir || process.cwd(),
    opts.name,
  );
  const apiId = opts.apiId;
  const caseId = opts.caseId;
  if (!apiId || !caseId) {
    throw new Error('Usage: mox set-case <apiId> <caseId>');
  }
  assertStubId(apiId);
  const cfg = loadSession(projectSlug);
  const active = { ...(cfg.cases?.active || {}) };
  active[apiId] = caseId;
  saveSession(projectSlug, { cases: { ...cfg.cases, active } });
  appendAudit(projectSlug, {
    command: 'set-case',
    taskId: opts.taskId || null,
    apiKey: apiId,
    summary: `case=${caseId}`,
  });
  console.log(`[mox] set case ${apiId} -> ${caseId}`);
  console.log('[mox] session picks up via ≤1s cache; no restart needed');
}

module.exports = { setCase, assertStubId };

if (require.main === module) {
  setCase({
    apiId: process.argv[2],
    caseId: process.argv[3],
  });
}
