'use strict';

const fs = require('fs');
const path = require('path');
const {
  ensureProjectDirs,
  projectDataDir,
  apiKey,
  stubId: makeStubId,
  sanitizeSlug,
} = require('../lib/paths');

/**
 * @param {object} opts
 * @param {Array} opts.apis - from infer
 * @param {string} [opts.taskId]
 * @param {string} [opts.relatedFrom] - path to req doc or comma keywords
 * @param {string[]} [opts.relatedPaths] - path prefixes related to task
 * @param {string[]} [opts.modifiedFiles] - files changed in task
 * @param {Set<string>} [opts.existingMockKeys]
 * @param {Map<string, object>} [opts.existingContracts]
 */
function classifyRequests(opts) {
  const {
    apis,
    taskId = null,
    relatedFrom,
    relatedPaths = [],
    modifiedFiles = [],
    existingMockKeys = new Set(),
    existingContracts = new Map(),
  } = opts;

  let keywords = [];
  let docText = '';
  if (relatedFrom && fs.existsSync(relatedFrom)) {
    docText = fs.readFileSync(relatedFrom, 'utf8');
    keywords = docText
      .split(/[\s,，、]+/)
      .filter((w) => w.length > 3)
      .slice(0, 200);
  } else if (relatedFrom) {
    keywords = String(relatedFrom)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const roles = [];
  const conflicts = [];

  for (const api of apis) {
    const upstreamId = api.upstreamId || '_default';
    const key =
      api.stubId ||
      makeStubId({
        upstreamId,
        method: api.method,
        path: api.path,
      });
    const legacyKey = apiKey(api);
    const hasMock =
      existingMockKeys.has(key) ||
      existingMockKeys.has(legacyKey) ||
      existingMockKeys.has(`${api.method} ${api.host}${api.path}`);
    const existing = existingContracts.get(key) || existingContracts.get(legacyKey);

    const pathHit =
      relatedPaths.some((p) => api.path.includes(p)) ||
      keywords.some((k) => api.path.includes(k) || (docText && docText.includes(api.path)));
    const evidenceHit = (api.evidences || [api.evidence]).some((e) =>
      modifiedFiles.some((f) => e && e.includes(f)),
    );

    const relatedToTask = Boolean(taskId && (pathHit || evidenceHit || keywords.length === 0 && false));
    // Without task: treat as project baseline → dependency (generate/reuse)
    let related = Boolean(taskId) && (pathHit || evidenceHit);

    // If task + relatedFrom file mentions path explicitly
    if (taskId && docText && docText.includes(api.path)) related = true;

    let role = 'unrelated';
    if (!taskId) {
      role = 'dependency';
    } else if (!related) {
      role = 'unrelated';
    } else if (!hasMock && !existing) {
      role = 'new';
    } else if (pathHit || evidenceHit) {
      // present in project + related → modify if docs/diff imply change, else dependency
      const looksModified =
        (docText && (docText.includes('修改') || docText.includes('变更') || docText.includes('modify'))) ||
        evidenceHit;
      role = looksModified ? 'modify' : 'dependency';
    } else {
      role = 'dependency';
    }

    // Conflict: modify with existing contract field mismatch hints
    if (role === 'modify' && existing && api.responseHints?.length) {
      const oldFields = Object.keys(existing.response?.dataFields || {});
      const missing = api.responseHints.filter((f) => oldFields.length && !oldFields.includes(f));
      const extra = oldFields.filter((f) => !api.responseHints.includes(f));
      if (missing.length || extra.length) {
        conflicts.push({
          apiKey: key,
          field: 'response.dataFields',
          existing: oldFields,
          incoming: api.responseHints,
          evidence: api.evidences || [api.evidence],
        });
      }
    }

    roles.push({
      apiKey: key,
      id: key,
      stubId: key,
      upstreamId,
      hosts: Array.isArray(api.hosts)
        ? [...api.hosts]
        : api.host && api.host !== '_default'
          ? [api.host]
          : [],
      canonicalHost: api.canonicalHost || null,
      hostVar: api.hostVar || null,
      prefixKey: api.prefixKey || null,
      method: api.method,
      path: api.path,
      relatedToTask: related,
      role,
      confidence: api.confidence,
      hasMock,
      evidences: api.evidences || [api.evidence],
      responseHints: api.responseHints || [],
      queryHints: api.queryHints || [],
      bodyHints: api.bodyHints || [],
      blocked: role === 'new' && !docText && !relatedFrom,
      lastTaskId: taskId,
    });
  }

  return { roles, conflicts, taskId };
}

function writeClassifyResult(projectSlug, result) {
  ensureProjectDirs(projectSlug);
  const base = projectDataDir(projectSlug);
  const file = path.join(base, 'classify', 'request-roles.json');
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  if (result.conflicts?.length) {
    const md = [
      '# Contract conflicts',
      '',
      `taskId: ${result.taskId || 'adhoc'}`,
      '',
      ...result.conflicts.map(
        (c) =>
          `- **${c.apiKey}** \`${c.field}\`\n  - existing: \`${JSON.stringify(c.existing)}\`\n  - incoming: \`${JSON.stringify(c.incoming)}\`\n  - evidence: ${c.evidence.join(', ')}`,
      ),
      '',
      '请确认保留哪一侧后再 generate（未决议不会覆盖已有 handler）。',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(base, 'reports', 'contract-conflicts.md'), md);
  }
  return file;
}

module.exports = { classifyRequests, writeClassifyResult, sanitizeSlug };

if (require.main === module) {
  console.error('Use via mox classify or init');
  process.exit(1);
}
