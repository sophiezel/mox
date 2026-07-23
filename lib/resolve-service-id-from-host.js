'use strict';

/**
 * Shared host → service id for capture staging and merge open.
 * Single identity: upstreams map wins, else resolveUpstreamId; noise → null.
 */

const { resolveUpstreamId, sanitizeUpstreamId } = require('./upstream');
const { isCaptureNoiseHost } = require('./capture-filter');
const { ensureCapturesDir } = require('./paths');

/**
 * @param {string|null|undefined} host
 * @param {{
 *   upstreams?: { upstreams?: Record<string, { hosts?: string[] }> },
 *   captureNoiseSuffixes?: string[],
 *   envHostTokens?: string[],
 * }} [opts]
 * @returns {string|null}
 */
function resolveServiceIdFromHost(host, opts = {}) {
  const h = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!h || h === '_default') return null;
  if (isCaptureNoiseHost(h, opts.captureNoiseSuffixes)) return null;

  const table = opts.upstreams?.upstreams || {};
  for (const [upId, info] of Object.entries(table)) {
    if ((info?.hosts || []).includes(h) || (info?.hosts || []).includes(host)) {
      return sanitizeUpstreamId(upId);
    }
  }

  return (
    resolveUpstreamId({
      hosts: [h],
      envHostTokens: opts.envHostTokens,
    }) || null
  );
}

/**
 * Where to stage a capture file (captures/ only — not a formal catalog open).
 * @param {{
 *   stubId?: string|null,
 *   host?: string|null,
 *   stubToCatalog?: Record<string, string>,
 *   primary?: string|null,
 *   upstreams?: object,
 *   captureNoiseSuffixes?: string[],
 * }} opts
 * @returns {string|null} absolute captures dir, or null to skip write
 */
function resolveCaptureStagingDir(opts = {}) {
  const stubId = opts.stubId || null;
  const host = opts.host || null;
  const stubToCatalog = opts.stubToCatalog || {};
  const primary = opts.primary || null;

  if (stubId && stubToCatalog[stubId]) {
    return ensureCapturesDir(stubToCatalog[stubId]);
  }

  const derived = resolveServiceIdFromHost(host, {
    upstreams: opts.upstreams,
    captureNoiseSuffixes: opts.captureNoiseSuffixes,
  });
  if (derived) return ensureCapturesDir(derived);

  if (host && isCaptureNoiseHost(host, opts.captureNoiseSuffixes)) {
    return null;
  }

  if (stubId && primary) return ensureCapturesDir(primary);
  if (primary) return ensureCapturesDir(primary);
  return null;
}

module.exports = {
  resolveServiceIdFromHost,
  resolveCaptureStagingDir,
};
