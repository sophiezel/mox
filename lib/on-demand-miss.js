'use strict';

/**
 * Orchestrate on-demand mock for a proxy miss.
 *
 * Returns:
 *  - { action: 'mock', stubId, rules }
 *  - { action: 'gap', gap }
 *  - { action: 'continue', reason }
 */

const {
  resolvePageApisForMiss,
  shapeIsEmpty,
} = require('./on-demand-page-apis');
const {
  generateOnDemandApis,
  preflightShape,
} = require('./on-demand-generate');

function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(label || 'on-demand-timeout');
      err.code = 'ON_DEMAND_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * @param {object} opts
 * @param {string} opts.scanDir
 * @param {string} opts.method
 * @param {string} opts.host
 * @param {string} opts.path
 * @param {string|null} [opts.referer]
 * @param {number} [opts.timeoutMs]
 * @param {() => object[]} [opts.getMergedRules]
 * @param {(rules: object[]) => void} [opts.reloadRules]
 */
async function handleOnDemandMiss(opts) {
  const scanDir = opts.scanDir;
  if (!scanDir) {
    return { action: 'continue', reason: 'no_scan_dir' };
  }

  let resolved;
  try {
    resolved = resolvePageApisForMiss({
      scanDir,
      referer: opts.referer,
      method: opts.method,
      host: opts.host,
      path: opts.path,
    });
  } catch (e) {
    return { action: 'continue', reason: `resolve_error:${e.message}` };
  }

  if (!resolved.ok || !resolved.matched) {
    return {
      action: 'continue',
      reason: resolved.reason || 'no_page_match',
    };
  }

  const kind = resolved.kind || 'prereq';
  const matched = resolved.matched;
  const prereqApis = resolved.pageApis
    .filter((r) => r.kind === 'prereq')
    .map((r) => r.api);
  const silentApis = resolved.pageApis
    .filter((r) => r.kind === 'silent')
    .map((r) => r.api);

  const runGenerate = async (apis) =>
    generateOnDemandApis({ scanDir, apis });

  const finishReload = (result) => {
    if (typeof opts.reloadRules === 'function' && typeof opts.getMergedRules === 'function') {
      try {
        opts.reloadRules(opts.getMergedRules());
      } catch (_) {
        /* ignore */
      }
    } else if (typeof opts.reloadRules === 'function' && result.rules?.length) {
      try {
        opts.reloadRules(result.rules);
      } catch (_) {
        /* ignore */
      }
    }
  };

  if (kind === 'silent') {
    // Fire-and-forget: current request continues with missPolicy
    const batch = silentApis.length ? silentApis : [matched];
    void runGenerate(batch)
      .then((r) => {
        if (r.ok) finishReload(r);
      })
      .catch((e) => {
        console.warn(`[proxy] on-demand silent generate failed: ${e.message}`);
      });
    return { action: 'continue', reason: 'silent_scheduled' };
  }

  // Prefetch silent siblings in background while we block on prereq
  if (silentApis.length) {
    void runGenerate(silentApis)
      .then((r) => {
        if (r.ok) finishReload(r);
      })
      .catch(() => {});
  }

  const pf = preflightShape(matched);
  if (!pf.ok || shapeIsEmpty(matched)) {
    return { action: 'gap', gap: pf.gap || 'TRACE_EMPTY', stubId: matched.stubId || null };
  }

  const toGen = prereqApis.filter((a) => !shapeIsEmpty(a));
  if (!toGen.some((a) => a === matched || a.stubId === matched.stubId || (a.path === matched.path && a.method === matched.method))) {
    toGen.unshift(matched);
  }

  try {
    const result = await withTimeout(
      runGenerate(toGen.length ? toGen : [matched]),
      opts.timeoutMs || 8000,
      'on-demand-timeout',
    );
    if (!result.ok) {
      return { action: 'gap', gap: result.gap || 'empty_shape', stubId: matched.stubId || null };
    }
    finishReload(result);
    const stubId =
      matched.stubId ||
      result.stubIds?.[0] ||
      `${String(matched.method || 'GET').toUpperCase()} ${matched.path}`;
    return {
      action: 'mock',
      stubId,
      rules: result.rules || [],
      generated: result.generated,
    };
  } catch (e) {
    if (e.code === 'ON_DEMAND_TIMEOUT') {
      console.warn('[proxy] on-demand-timeout; falling back to missPolicy');
      return { action: 'continue', reason: 'timeout' };
    }
    console.warn(`[proxy] on-demand generate failed: ${e.message}`);
    return { action: 'continue', reason: `generate_error:${e.message}` };
  }
}

module.exports = {
  handleOnDemandMiss,
  withTimeout,
};
