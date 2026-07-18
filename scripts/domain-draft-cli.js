'use strict';

const { writeDomainDraft } = require('../lib/service-infer/domain-draft');
const { materializeStoreHandlers } = require('../lib/service-infer');
const { loadServiceRules } = require('../lib/catalog-merge');
const { parseStubId, sanitizeUpstreamId } = require('../lib/paths');

/**
 * @param {{ _: string[], flags: Record<string, any> }} args
 */
function runDomainDraft(args) {
  const flags = args.flags || {};
  const upstreamId = flags.upstream || flags.name;
  if (!upstreamId || upstreamId === true) {
    console.error('Usage: mox domain-draft --upstream=<id> [--project=slug] [--confirm]');
    process.exitCode = 1;
    return;
  }
  const result = writeDomainDraft({
    upstreamId,
    projectSlug: flags.project || null,
    confirm: Boolean(flags.confirm),
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        upstreamId: sanitizeUpstreamId(upstreamId),
        draftPath: result.draftPath,
        modelsPath: result.modelsPath,
        clusters: result.clusters,
        confirmed: Boolean(flags.confirm),
      },
      null,
      2,
    ),
  );
}

/**
 * Materialize store handlers after domain draft confirm (or --force).
 * @param {{ _: string[], flags: Record<string, any> }} args
 */
function runMaterializeService(args) {
  const flags = args.flags || {};
  const upstreamId = flags.upstream || flags.name;
  if (!upstreamId || upstreamId === true) {
    console.error('Usage: mox materialize-service --upstream=<id> [--force]');
    process.exitCode = 1;
    return;
  }
  const up = sanitizeUpstreamId(upstreamId);
  const rules = loadServiceRules(up);
  const stubs = rules
    .map((r) => {
      try {
        const p = parseStubId(r.stubId || r.id);
        return {
          stubId: r.stubId || r.id,
          method: p.method,
          path: p.path,
          upstreamId: up,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const result = materializeStoreHandlers(up, stubs, { force: Boolean(flags.force) });
  console.log(JSON.stringify({ ok: true, upstreamId: up, ...result }, null, 2));
}

module.exports = { runDomainDraft, runMaterializeService };
