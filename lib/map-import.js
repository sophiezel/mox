'use strict';

const fs = require('fs');
const { stubId } = require('./paths');
const { normalizeHostLabel } = require('./upstream');
const { upsertServiceRules } = require('./catalog-merge');
const { loadSession, saveSession } = require('./session-config');

const MAP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Parse whistle-like two-column map lines:
 *   https://host/path http://127.0.0.1/path
 * Blank lines and `#` comments ignored.
 *
 * @param {string} text
 * @returns {{ host: string, pathPrefix: string, localUrl: string }[]}
 */
function parseMapText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) {
      throw new Error(`invalid map line ${i + 1}: expected two columns`);
    }
    const [remote, local] = parts;
    let remoteUrl;
    let localUrl;
    try {
      remoteUrl = new URL(remote);
      localUrl = new URL(local);
    } catch {
      throw new Error(`invalid map line ${i + 1}: not a URL pair`);
    }
    if (!/^https?:$/i.test(remoteUrl.protocol)) {
      throw new Error(`invalid map line ${i + 1}: remote must be http(s)`);
    }
    if (!/^https?:$/i.test(localUrl.protocol)) {
      throw new Error(`invalid map line ${i + 1}: local must be http(s)`);
    }
    const pathPrefix =
      remoteUrl.pathname && remoteUrl.pathname !== '/'
        ? remoteUrl.pathname.replace(/\/+$/, '') || '/'
        : remoteUrl.pathname || '/';
    rows.push({
      host: remoteUrl.hostname,
      pathPrefix,
      localUrl: local,
    });
  }
  return rows;
}

/**
 * @param {string} filePath
 */
function parseMapFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseMapText(text);
}

/**
 * Plan stubIds / proxy-rules from map rows (no disk write).
 * @param {{ host: string, pathPrefix: string }[]} rows
 * @returns {{ stubIds: string[], hosts: string[], byUpstream: Map<string, object[]> }}
 */
function planMapRows(rows) {
  /** @type {Map<string, object[]>} */
  const byUpstream = new Map();
  /** @type {string[]} */
  const stubIds = [];
  /** @type {string[]} */
  const hosts = [];

  for (const row of rows) {
    const upstreamId =
      normalizeHostLabel(row.host) || row.host.replace(/\./g, '-');
    if (!hosts.includes(row.host)) hosts.push(row.host);
    const list = byUpstream.get(upstreamId) || [];
    for (const method of MAP_METHODS) {
      const id = stubId({
        upstreamId,
        method,
        path: row.pathPrefix,
      });
      if (!stubIds.includes(id)) stubIds.push(id);
      list.push({
        id,
        stubId: id,
        hosts: [row.host],
        pathPrefix: row.pathPrefix,
        methods: [method],
        upstreamId,
      });
    }
    byUpstream.set(upstreamId, list);
  }

  return { stubIds, hosts, byUpstream };
}

/**
 * Build stubIds + upsert proxy-rules from map rows (no session write).
 * @param {{ host: string, pathPrefix: string }[]} rows
 * @returns {{ stubIds: string[], hosts: string[] }}
 */
function materializeMapRows(rows) {
  const { stubIds, hosts, byUpstream } = planMapRows(rows);
  for (const [upstreamId, rules] of byUpstream) {
    upsertServiceRules(upstreamId, rules);
  }
  return { stubIds, hosts };
}

/**
 * Apply map file → selective traffic + allowlist + incremental proxy-rules.
 * Local column `127.0.0.1` means "serve via local mock" (not a second truth source).
 *
 * @param {string} filePath
 * @param {{ saveAs?: string|false|null, rulesDir?: string }} [opts]
 */
function applyMapImport(filePath, opts = {}) {
  const rows = parseMapFile(filePath);
  if (!rows.length) {
    throw new Error('map import: no mapping rows');
  }

  const { stubIds, hosts } = materializeMapRows(rows);

  const prev = loadSession();
  const prevList = Array.isArray(prev.proxy?.mockAllowlist)
    ? prev.proxy.mockAllowlist
    : [];
  const mergedAllow = [...prevList];
  for (const id of stubIds) {
    if (!mergedAllow.includes(id)) mergedAllow.push(id);
  }
  const prevHosts = Array.isArray(prev.proxy?.captureMitmHosts)
    ? prev.proxy.captureMitmHosts
    : [];
  const captureMitmHosts = [...prevHosts];
  for (const h of hosts) {
    if (!captureMitmHosts.includes(h)) captureMitmHosts.push(h);
  }

  const session = saveSession({
    proxy: {
      ...(prev.proxy || {}),
      trafficMode: 'selective',
      mockAllowlist: mergedAllow,
      captureMitmHosts,
    },
  });

  let savedRule = null;
  const saveAs = opts.saveAs === false || opts.saveAs === null
    ? null
    : opts.saveAs || 'map-import';
  if (saveAs) {
    const { saveRulesFromSession, ensureRulesDir } = require('./rules');
    ensureRulesDir(opts.rulesDir);
    savedRule = saveRulesFromSession(saveAs, { rulesDir: opts.rulesDir });
  }

  return {
    rows,
    stubIds,
    hosts,
    captureMitmHosts,
    session,
    savedRule,
  };
}

module.exports = {
  parseMapText,
  parseMapFile,
  planMapRows,
  materializeMapRows,
  applyMapImport,
  MAP_METHODS,
};
