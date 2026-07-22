'use strict';

const fs = require('fs');
const { stubId } = require('./paths');
const { normalizeHostLabel } = require('./upstream');
const { upsertServiceRules } = require('./catalog-merge');
const { loadSession, saveSession } = require('./session-config');

const MAP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * @param {string} pathname
 * @returns {string}
 */
function normalizePathPrefix(pathname) {
  const raw = String(pathname || '/');
  if (!raw || raw === '/') return '/';
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed || '/';
}

/**
 * Parse left-column Whistle-like pattern → host + pathPrefix.
 * Protocol (if present) is ignored at runtime matching (Q5).
 * @param {string} pattern
 * @param {number} lineNo
 * @returns {{ host: string, pathPrefix: string }}
 */
function parsePattern(pattern, lineNo) {
  const p = String(pattern || '').trim();
  if (!p) {
    throw new Error(`invalid map line ${lineNo}: empty pattern`);
  }
  if (/^https?:\/\//i.test(p)) {
    let url;
    try {
      url = new URL(p);
    } catch {
      throw new Error(`invalid map line ${lineNo}: invalid pattern URL`);
    }
    if (!/^https?:$/i.test(url.protocol)) {
      throw new Error(`invalid map line ${lineNo}: pattern must be http(s)`);
    }
    let host = url.hostname;
    if (!host) {
      throw new Error(`invalid map line ${lineNo}: pattern missing host`);
    }
    if (url.port) host = `${host}:${url.port}`;
    return { host, pathPrefix: normalizePathPrefix(url.pathname) };
  }
  if (p.startsWith('/')) {
    throw new Error(
      `invalid map line ${lineNo}: path-only pattern needs a host (got "${p}")`,
    );
  }
  const slash = p.indexOf('/');
  if (slash < 0) {
    return { host: p, pathPrefix: '/' };
  }
  const host = p.slice(0, slash);
  if (!host) {
    throw new Error(`invalid map line ${lineNo}: pattern missing host`);
  }
  return { host, pathPrefix: normalizePathPrefix(p.slice(slash)) };
}

/**
 * Optional right column = local-mock marker only (path ignored).
 * @param {string} op
 * @param {number} lineNo
 */
function assertMapOperation(op, lineNo) {
  const s = String(op || '').trim();
  if (s.startsWith('/')) return;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (!/^https?:$/i.test(u.protocol)) {
        throw new Error('bad proto');
      }
      return;
    } catch {
      throw new Error(`invalid map line ${lineNo}: invalid operation URL`);
    }
  }
  throw new Error(
    `invalid map line ${lineNo}: operation must be /path or http(s)://…`,
  );
}

/**
 * Parse Whistle-like map lines (P0 subset):
 *   pattern [operation]
 * pattern: https://host/path | host/path | host
 * operation (optional): /path | http(s)://…  — local-mock marker only
 * Blank lines and `#` comments ignored.
 *
 * @param {string} text
 * @returns {{ host: string, pathPrefix: string, localUrl?: string }[]}
 */
function parseMapText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const lineNo = i + 1;
    if (parts.length === 0 || parts.length > 2) {
      throw new Error(
        `invalid map line ${lineNo}: expected 1 or 2 columns (got ${parts.length})`,
      );
    }
    const [pattern, operation] = parts;
    const { host, pathPrefix } = parsePattern(pattern, lineNo);
    /** @type {{ host: string, pathPrefix: string, localUrl?: string }} */
    const row = { host, pathPrefix };
    if (operation != null) {
      assertMapOperation(operation, lineNo);
      row.localUrl = operation;
    }
    rows.push(row);
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
 * Optional operation column (`/` path or `http(s)://…`) marks local mock only.
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
  parsePattern,
  planMapRows,
  materializeMapRows,
  applyMapImport,
  MAP_METHODS,
};
