'use strict';

const fs = require('fs');
const path = require('path');
const {
  serviceDataDir,
  listServiceIds,
  sanitizeUpstreamId,
  parseStubId,
  ensureServiceDirs,
} = require('./paths');

/**
 * Parse --name values: string | string[] | "a,b".
 * Values are upstreamIds (service catalog keys).
 * @param {string|string[]|null|undefined} raw
 * @returns {string[]}
 */
function parseNameList(raw) {
  if (raw == null || raw === false || raw === true) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const p of parts) {
    for (const bit of String(p).split(',')) {
      const trimmed = bit.trim();
      if (!trimmed) continue;
      const s = sanitizeUpstreamId(trimmed);
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/**
 * Upsert rules into a service's proxy-rules.json (by stubId).
 * @param {string} upstreamId
 * @param {object[]} rules
 * @returns {object[]}
 */
function upsertServiceRules(upstreamId, rules) {
  ensureServiceDirs(upstreamId);
  const rulesPath = path.join(serviceDataDir(upstreamId), 'proxy-rules.json');
  /** @type {Map<string, object>} */
  const byId = new Map();
  if (fs.existsSync(rulesPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
      if (Array.isArray(prev)) {
        for (const r of prev) {
          const id = r.stubId || r.id;
          if (id) byId.set(id, r);
        }
      }
    } catch {
      /* ignore */
    }
  }
  for (const r of rules || []) {
    const id = r.stubId || r.id;
    if (!id) continue;
    byId.set(id, {
      ...r,
      stubId: id,
      upstreamId: sanitizeUpstreamId(r.upstreamId || upstreamId),
    });
  }
  const list = [...byId.values()];
  fs.writeFileSync(rulesPath, `${JSON.stringify(list, null, 2)}\n`);
  return list;
}

/**
 * Load proxy-rules for one service.
 * @param {string} upstreamId
 * @returns {object[]}
 */
function loadServiceRules(upstreamId) {
  const rulesPath = path.join(serviceDataDir(upstreamId), 'proxy-rules.json');
  if (!fs.existsSync(rulesPath)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Resolve which service ids to mount.
 * Empty → all services with proxy-rules.
 * @param {{ names?: string|string[], allIfEmpty?: boolean }} opts
 * @returns {string[]}
 */
function resolveActiveCatalogs(opts = {}) {
  const named = parseNameList(opts.names);
  if (named.length) {
    for (const key of named) {
      const hasService = fs.existsSync(
        path.join(serviceDataDir(key), 'proxy-rules.json'),
      );
      if (!hasService) {
        throw new Error(
          `service not found for --name=${key} (expected .data/services/${key}/proxy-rules.json)`,
        );
      }
    }
    return named;
  }
  if (opts.allIfEmpty === false) return [];
  const services = listServiceIds();
  if (!services.length) {
    if (opts.allowEmpty) return [];
    throw new Error(
      'no services to mount: run mox init <frontendDir>, or capture-open + mox merge, or pass --name=<upstreamId>',
    );
  }
  return services;
}

/**
 * Expand a mount key into service upstreamIds (key must be a service id).
 * @param {string} key
 * @returns {{ services: string[], legacyProject: string|null }}
 */
function expandMountKey(key) {
  const up = sanitizeUpstreamId(key);
  const svcRules = path.join(serviceDataDir(up), 'proxy-rules.json');
  if (fs.existsSync(svcRules)) {
    return { services: [up], legacyProject: null };
  }
  return { services: [], legacyProject: null };
}

/**
 * Merge proxy-rules from services.
 * @param {string[]} keys
 * @returns {{
 *   rules: object[],
 *   stubToCatalog: Record<string, string>,
 *   catalogs: string[],
 * }}
 */
function mergeCatalogs(keys) {
  if (!Array.isArray(keys)) {
    throw new Error('mergeCatalogs: need an array of upstreamIds');
  }
  if (!keys.length) {
    return { rules: [], stubToCatalog: {}, catalogs: [] };
  }

  /** @type {Set<string>} */
  const serviceSet = new Set();

  for (const key of keys) {
    const { services } = expandMountKey(key);
    for (const s of services) serviceSet.add(s);
    // Also accept bare service scaffold / explicit key
    const up = sanitizeUpstreamId(key);
    if (fs.existsSync(path.join(serviceDataDir(up), 'proxy-rules.json'))) {
      serviceSet.add(up);
    }
  }

  if (!serviceSet.size) {
    throw new Error(
      `mergeCatalogs: no services found for keys=${JSON.stringify(keys)}`,
    );
  }

  /** @type {Record<string, string>} */
  const stubToCatalog = {};
  /** @type {object[]} */
  const rules = [];
  /** @type {Record<string, string[]>} */
  const conflicts = {};

  function addRule(rule, catalogKey) {
    const stubId = rule.stubId || rule.id;
    if (!stubId) return;
    if (stubToCatalog[stubId] && stubToCatalog[stubId] !== catalogKey) {
      if (!conflicts[stubId]) conflicts[stubId] = [stubToCatalog[stubId]];
      if (!conflicts[stubId].includes(catalogKey)) {
        conflicts[stubId].push(catalogKey);
      }
      return;
    }
    stubToCatalog[stubId] = catalogKey;
    rules.push({
      ...rule,
      stubId,
      catalog: catalogKey,
      upstreamId: rule.upstreamId || catalogKey,
    });
  }

  for (const up of [...serviceSet].sort()) {
    for (const rule of loadServiceRules(up)) {
      addRule(rule, up);
    }
  }

  const conflictIds = Object.keys(conflicts);
  if (conflictIds.length) {
    const lines = conflictIds
      .slice(0, 20)
      .map((id) => `  ${id} ← ${conflicts[id].join(', ')}`)
      .join('\n');
    throw new Error(
      `stubId conflict across services (${conflictIds.length}):\n${lines}${
        conflictIds.length > 20 ? '\n  …' : ''
      }`,
    );
  }

  return {
    rules,
    stubToCatalog,
    catalogs: [...serviceSet].sort(),
  };
}

/**
 * Mocks root for a service id.
 * @param {string} catalogSlug
 * @returns {string}
 */
function mocksRootFor(catalogSlug) {
  return path.join(serviceDataDir(catalogSlug), 'mocks');
}

/**
 * Mocks root for a stubId (service layout).
 * @param {string} stubId
 * @returns {string|null}
 */
function mocksRootForStub(stubId) {
  try {
    const { upstreamId } = parseStubId(stubId);
    return path.join(serviceDataDir(upstreamId), 'mocks');
  } catch {
    return null;
  }
}

/**
 * Captures dir under services/<upstreamId>/captures.
 * @param {string} catalogSlug upstreamId
 * @returns {string}
 */
function capturesDirFor(catalogSlug) {
  const dir = path.join(serviceDataDir(catalogSlug), 'captures');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Load contracts for a service id (or expand if key lists services).
 * @param {string} catalogKey
 * @returns {object[]}
 */
function loadContractsForCatalog(catalogKey) {
  const byKey = new Map();
  const addDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const key = c.stubId || c.id || f;
        if (!byKey.has(key)) byKey.set(key, c);
      } catch {
        /* skip corrupt */
      }
    }
  };

  const { services } = expandMountKey(catalogKey);
  const ups = services.length ? services : [sanitizeUpstreamId(catalogKey)];
  for (const up of ups) {
    addDir(path.join(serviceDataDir(up), 'contracts'));
  }

  return [...byKey.values()];
}

/**
 * Load contracts across one or more upstreamIds (empty → all services).
 * @param {string|string[]|null} [names]
 * @returns {object[]}
 */
function loadContractsAcross(names) {
  const list = Array.isArray(names)
    ? names.filter(Boolean)
    : names
      ? [names]
      : [];
  const ups = list.length ? list.map(sanitizeUpstreamId) : listServiceIds();
  const byKey = new Map();
  for (const up of ups) {
    for (const c of loadContractsForCatalog(up)) {
      const key = c.stubId || c.id;
      if (key && !byKey.has(key)) byKey.set(key, c);
    }
  }
  return [...byKey.values()];
}

/**
 * Candidate handler file paths for a contract (service catalog only).
 * @param {object} contract
 * @param {string} [_ignored]
 * @returns {string[]}
 */
function handlerPathCandidates(contract, _ignored) {
  const { serviceStubHandlerPath } = require('./paths');
  const candidates = [];
  const upId = contract.upstreamId || '_default';
  const methods = contract.method || ['GET'];
  const methodList = Array.isArray(methods) ? methods : [methods];

  for (const m of methodList) {
    const method = String(m).toUpperCase();
    try {
      candidates.push(serviceStubHandlerPath(upId, method, contract.path || '/'));
    } catch {
      /* unsafe */
    }
  }

  return candidates;
}

/**
 * @param {object} contract
 * @param {string} [projectSlug]
 * @returns {boolean}
 */
function handlerExistsForContract(contract, projectSlug) {
  return handlerPathCandidates(contract, projectSlug).some((p) => fs.existsSync(p));
}

/**
 * StubIds that already have materialized handlers for this service.
 * @param {string} catalogKey
 * @returns {Set<string>}
 */
function listMockKeysForCatalog(catalogKey) {
  const keys = new Set();
  const contracts = loadContractsForCatalog(catalogKey);
  for (const c of contracts) {
    if (!handlerExistsForContract(c, catalogKey)) continue;
    const stubId = c.stubId || c.id;
    if (stubId) keys.add(stubId);
    const methods = c.method || ['GET'];
    for (const m of Array.isArray(methods) ? methods : [methods]) {
      const method = String(m).toUpperCase();
      if (c.host) keys.add(`${method} ${c.host}${c.path || ''}`);
      for (const h of c.hosts || []) {
        keys.add(`${method} ${h}${c.path || ''}`);
      }
    }
  }

  const { services } = expandMountKey(catalogKey);
  const ups = services.length ? services : [sanitizeUpstreamId(catalogKey)];
  for (const up of ups) {
    for (const r of loadServiceRules(up)) {
      const stubId = r.stubId || r.id;
      if (!stubId) continue;
      try {
        const parsed = parseStubId(stubId);
        const fake = {
          stubId,
          upstreamId: parsed.upstreamId,
          method: [parsed.method],
          path: parsed.path,
          hosts: r.hosts || [],
        };
        if (handlerExistsForContract(fake, catalogKey)) {
          keys.add(stubId);
        }
      } catch {
        /* ignore */
      }
    }
  }

  return keys;
}

/** @deprecated no-op — project index removed */
function writeProjectIndex(_slug, data = {}) {
  return {
    version: 1,
    stubs: [...new Set(data.stubs || [])].sort(),
    upstreams: [...new Set((data.upstreams || []).map(sanitizeUpstreamId))].sort(),
    source: data.source || null,
    updatedAt: new Date().toISOString(),
  };
}

/** @deprecated always null — project index removed */
function readProjectIndex() {
  return null;
}

module.exports = {
  parseNameList,
  resolveActiveCatalogs,
  mergeCatalogs,
  mocksRootFor,
  mocksRootForStub,
  capturesDirFor,
  writeProjectIndex,
  readProjectIndex,
  upsertServiceRules,
  loadServiceRules,
  expandMountKey,
  loadContractsForCatalog,
  loadContractsAcross,
  handlerPathCandidates,
  handlerExistsForContract,
  listMockKeysForCatalog,
};
