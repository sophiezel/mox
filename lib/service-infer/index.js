'use strict';

const fs = require('fs');
const path = require('path');
const {
  inferOperationIntent,
  inferResourceClusters,
} = require('./operation-intent');
const { renderStoreHandler } = require('./store-handler');
const {
  serviceDataDir,
  serviceStubHandlerPath,
  ensureServiceDirs,
  parseStubId,
  sanitizeUpstreamId,
} = require('../paths');

/**
 * Apply store-backed handlers for CRUD clusters under a service.
 * Skips handlers marked mox:manual.
 * @param {string} upstreamId
 * @param {{ stubId: string, method: string, path: string, upstreamId?: string }[]} stubs
 * @param {{ force?: boolean }} [opts]
 * @returns {{ clusters: number, rewritten: string[] }}
 */
function materializeStoreHandlers(upstreamId, stubs, opts = {}) {
  const up = sanitizeUpstreamId(upstreamId);
  ensureServiceDirs(up);
  const clusters = inferResourceClusters(
    stubs.map((s) => ({ ...s, upstreamId: s.upstreamId || up })),
  );
  const rewritten = [];

  for (const cluster of clusters) {
    for (const [op, stubId] of Object.entries(cluster.ops)) {
      if (!stubId) continue;
      let parsed;
      try {
        parsed = parseStubId(stubId);
      } catch {
        continue;
      }
      const file = serviceStubHandlerPath(parsed.upstreamId, parsed.method, parsed.path);
      if (fs.existsSync(file)) {
        const prev = fs.readFileSync(file, 'utf8');
        if (prev.includes('mox:manual') && !opts.force) continue;
        if (prev.includes('mox:store') && !opts.force) {
          // already store-backed
          continue;
        }
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        renderStoreHandler({
          resource: cluster.resource,
          op,
          stubId,
        }),
      );
      rewritten.push(stubId);
    }
  }

  // Persist cluster summary on the service
  const modelsPath = path.join(serviceDataDir(up), 'models.json');
  let models = { version: 1, resources: [] };
  if (fs.existsSync(modelsPath)) {
    try {
      models = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
    } catch {
      /* ignore */
    }
  }
  const byName = new Map((models.resources || []).map((r) => [r.name, r]));
  for (const c of clusters) {
    byName.set(c.resource, {
      name: c.resource,
      basePath: c.basePath,
      ops: c.ops,
      source: 'resource-cluster',
    });
  }
  models.resources = [...byName.values()];
  models.updatedAt = new Date().toISOString();
  fs.writeFileSync(modelsPath, `${JSON.stringify(models, null, 2)}\n`);

  return { clusters: clusters.length, rewritten };
}

/**
 * Annotate roles with intent (mutates shallow copies).
 * @param {object[]} roles
 * @returns {object[]}
 */
function enrichRolesWithIntent(roles) {
  return (roles || []).map((r) => ({
    ...r,
    operationIntent: inferOperationIntent(r),
  }));
}

module.exports = {
  materializeStoreHandlers,
  enrichRolesWithIntent,
  inferOperationIntent,
  inferResourceClusters,
  writeDomainDraft: require('./domain-draft').writeDomainDraft,
};
