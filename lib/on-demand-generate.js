'use strict';

/**
 * Generate catalog stubs for a subset of inferred APIs (on-demand miss path).
 * Never invents response fields — empty shape → { ok:false, gap }.
 */

const path = require('path');
const { resolveScanLabel } = require('./paths');
const { shapeIsEmpty } = require('./on-demand-page-apis');

/** @type {Map<string, Promise<object>>} */
const inflight = new Map();

function apiToRole(api) {
  const upstreamId = api.upstreamId || '_default';
  const hosts = Array.isArray(api.hosts)
    ? [...api.hosts]
    : api.host && api.host !== '_default'
      ? [api.host]
      : [];
  const stubId =
    api.stubId ||
    `${String(api.method || 'GET').toUpperCase()} ${upstreamId}${api.path || ''}`;
  return {
    apiKey: stubId,
    id: stubId,
    stubId,
    upstreamId,
    hosts,
    canonicalHost: api.canonicalHost || null,
    hostVar: api.hostVar || null,
    prefixKey: api.prefixKey || null,
    method: api.method || 'GET',
    path: api.path,
    relatedToTask: false,
    role: 'dependency',
    confidence: api.confidence || 'medium',
    hasMock: false,
    evidences: api.evidences || (api.evidence ? [api.evidence] : []),
    responseHints: api.responseHints || [],
    queryHints: api.queryHints || [],
    bodyHints: api.bodyHints || [],
    responseShape: api.responseShape,
    coverage: api.coverage || {
      request: { keysFound: [], confidence: 'low' },
      response: { pathsFound: [], confidence: 'low' },
      enums: [],
      gaps: shapeIsEmpty(api) ? ['TRACE_EMPTY'] : [],
    },
    exportHint: api.exportHint || null,
    exportKey: api.exportKey || null,
    blocked: false,
    lastTaskId: null,
    source: 'usage',
  };
}

/**
 * @param {object} api
 * @returns {{ ok: boolean, gap?: string }}
 */
function preflightShape(api) {
  if (!api) return { ok: false, gap: 'no_match' };
  const gaps = api.coverage?.gaps || [];
  if (shapeIsEmpty(api)) {
    return {
      ok: false,
      gap: gaps.includes('TRACE_EMPTY') ? 'TRACE_EMPTY' : 'empty_shape',
    };
  }
  return { ok: true };
}

/**
 * @param {{ scanDir: string, apis: object[], projectSlug?: string }} opts
 */
async function generateOnDemandApis(opts) {
  const scanDir = path.resolve(opts.scanDir);
  const apis = Array.isArray(opts.apis) ? opts.apis : [];
  const projectSlug =
    opts.projectSlug || resolveScanLabel(scanDir, null);

  const usable = [];
  const skipped = [];
  for (const api of apis) {
    const pf = preflightShape(api);
    if (!pf.ok) {
      skipped.push({
        stubId: api.stubId || `${api.method} ${api.path}`,
        gap: pf.gap,
      });
      continue;
    }
    usable.push(api);
  }

  if (!usable.length) {
    return {
      ok: false,
      gap: skipped[0]?.gap || 'empty_shape',
      generated: 0,
      skipped,
      rules: [],
      stubIds: [],
    };
  }

  const key = usable
    .map(
      (a) =>
        a.stubId ||
        `${String(a.method || 'GET').toUpperCase()} ${a.path}`,
    )
    .sort()
    .join('|');

  if (inflight.has(key)) {
    return inflight.get(key);
  }

  const job = (async () => {
    const { generateMocks } = require('../scripts/generate-mock');
    const roles = usable.map(apiToRole);
    const gen = generateMocks({
      projectSlug,
      roles,
      conflicts: [],
      taskId: null,
      force: false,
      merge: true,
      overwriteCapture: false,
    });
    return {
      ok: true,
      gap: null,
      generated: gen.generated || 0,
      reused: gen.reused || 0,
      skipped,
      rules: gen.rules || [],
      stubIds: gen.stubIds || [],
      gen,
    };
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

function clearInflight() {
  inflight.clear();
}

module.exports = {
  apiToRole,
  preflightShape,
  generateOnDemandApis,
  clearInflight,
};
