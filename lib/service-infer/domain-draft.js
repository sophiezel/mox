'use strict';

const fs = require('fs');
const path = require('path');
const {
  serviceDataDir,
  ensureServiceDirs,
  sanitizeUpstreamId,
  parseStubId,
} = require('../paths');
const {
  inferOperationIntent,
  inferResourceClusters,
} = require('./operation-intent');
const { loadServiceRules } = require('../catalog-merge');

/**
 * Build a reviewable domain draft from discovered stubs / clusters.
 * Does NOT auto-materialize into hot path — write drafts only.
 *
 * @param {{
 *   upstreamId: string,
 *   stubs?: { stubId: string, method: string, path: string }[],
 *   confirm?: boolean,
 * }} opts
 */
function writeDomainDraft(opts) {
  const upstreamId = sanitizeUpstreamId(opts.upstreamId);
  ensureServiceDirs(upstreamId);

  let stubs = opts.stubs || [];
  if (!stubs.length) {
    const rules = loadServiceRules(upstreamId);
    stubs = rules.map((r) => {
      try {
        const p = parseStubId(r.stubId || r.id);
        return {
          stubId: r.stubId || r.id,
          method: p.method,
          path: p.path,
          upstreamId,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  const annotated = stubs.map((s) => ({
    ...s,
    intent: inferOperationIntent(s),
  }));
  const clusters = inferResourceClusters(annotated);

  const models = {
    version: 1,
    upstreamId,
    confirmed: Boolean(opts.confirm),
    resources: clusters.map((c) => ({
      name: c.resource,
      basePath: c.basePath,
      // Virtual entity fields are unknown until shape/capture — keep empty keys only
      fields: [],
      ops: c.ops,
      note: 'fields filled after confirm + shape/capture; not invented here',
    })),
    operations: annotated.map((s) => ({
      stubId: s.stubId,
      intent: s.intent,
      method: s.method,
      path: s.path,
    })),
    updatedAt: new Date().toISOString(),
  };

  const modelsPath = path.join(serviceDataDir(upstreamId), 'models.json');
  if (opts.confirm || !fs.existsSync(modelsPath)) {
    fs.writeFileSync(modelsPath, `${JSON.stringify(models, null, 2)}\n`);
  } else if (!opts.confirm) {
    // Keep existing confirmed models; still write draft md
  }

  const md = [
    `# Domain draft — ${upstreamId}`,
    '',
    `Generated: ${models.updatedAt}`,
    `Confirmed: ${models.confirmed ? 'yes' : 'no (review required)'}`,
    '',
    '## Resources (virtual entities)',
    '',
    ...(clusters.length
      ? clusters.map(
          (c) =>
            `- **${c.resource}** \`${c.basePath}\`\n  - ops: ${Object.entries(c.ops)
              .filter(([, v]) => v)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')}`,
        )
      : ['- (none — need ≥2 related CRUD-ish stubs)']),
    '',
    '## Operations',
    '',
    ...annotated.map((s) => `- \`${s.intent}\` ${s.method} ${s.path}`),
    '',
    '## Next',
    '',
    'Main path already auto-materialized CRUD store handlers on init/generate.',
    'Re-run advanced commands only when repairing:',
    '',
    '1. Review resources / intents (do not invent business fields).',
    '2. `mox domain-draft --upstream=' +
      upstreamId +
      ' --confirm` to refresh this draft.',
    '3. `mox materialize-service --upstream=' +
      upstreamId +
      ' [--force]` to re-bind store handlers.',
    '4. See `references/guide-l5-backend-inference.md` and `references/guide-l6-advanced.md`.',
    '',
  ].join('\n');

  const draftPath = path.join(serviceDataDir(upstreamId), 'domain-draft.md');
  fs.writeFileSync(draftPath, md);

  return { modelsPath, draftPath, models, clusters: clusters.length };
}

module.exports = { writeDomainDraft };
