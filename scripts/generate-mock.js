'use strict';

const fs = require('fs');
const path = require('path');
const {
  ensureProjectDirs,
  ensureServiceDirs,
  projectDataDir,
  serviceDataDir,
  serviceContractPath,
  stubHandlerPath,
  serviceStubHandlerPath,
  stubId: makeStubId,
  apiKey,
  pathDepth,
  sanitizeUpstreamId,
} = require('../lib/paths');
const {
  writeProjectIndex,
  upsertServiceRules,
} = require('../lib/catalog-merge');
const { appendAudit } = require('../lib/audit');
const {
  materialize,
  shapeToDataFields,
  buildEnumCases,
} = require('../lib/materialize');
const {
  normalizeHostLabel,
  deriveUpstreamId,
  pickCanonicalHost,
} = require('../lib/upstream');
const { classifyFidelity } = require('../lib/gap-taxonomy');

function hintListToObject(hints) {
  if (!hints) return {};
  if (Array.isArray(hints)) {
    return Object.fromEntries(
      hints.map((k) =>
        typeof k === 'string'
          ? [k, { type: 'string', required: false, enums: [] }]
          : [k, k],
      ),
    );
  }
  return hints;
}

function buildStandardCases(dataSample, enumCases = []) {
  const emptyData = Array.isArray(dataSample) ? [] : {};
  return [
    {
      id: 'success',
      when: {},
      response: { code: 0, data: dataSample, message: '' },
      httpStatus: 200,
    },
    {
      id: 'empty',
      when: { header: { 'x-mock-case': 'empty' } },
      response: { code: 0, data: emptyData, message: '' },
      httpStatus: 200,
    },
    {
      id: 'biz_error',
      when: { header: { 'x-mock-case': 'biz_error' } },
      response: { code: 50000, data: null, message: 'mock business error' },
      httpStatus: 200,
    },
    {
      id: 'http_401',
      when: { header: { 'x-mock-case': 'http_401' } },
      response: { code: 401, data: null, message: 'unauthorized' },
      httpStatus: 401,
    },
    {
      id: 'http_403',
      when: { header: { 'x-mock-case': 'http_403' } },
      response: { code: 403, data: null, message: 'forbidden' },
      httpStatus: 403,
    },
    {
      id: 'http_404',
      when: { header: { 'x-mock-case': 'http_404' } },
      response: { code: 404, data: null, message: 'not found' },
      httpStatus: 404,
    },
    {
      id: 'http_500',
      when: { header: { 'x-mock-case': 'http_500' } },
      response: { code: 500, data: null, message: 'internal server error' },
      httpStatus: 500,
    },
    {
      id: 'http_502',
      when: { header: { 'x-mock-case': 'http_502' } },
      response: { code: 502, data: null, message: 'bad gateway / dep fail' },
      httpStatus: 502,
    },
    {
      id: 'dep_fail',
      when: { header: { 'x-mock-case': 'dep_fail' } },
      response: { code: 502, data: null, message: 'dependency failure' },
      httpStatus: 502,
    },
    {
      id: 'slow',
      when: { header: { 'x-mock-case': 'slow' } },
      response: { code: 0, data: dataSample, message: '' },
      httpStatus: 200,
      meta: { delayMs: 3000 },
    },
    {
      id: 'timeout',
      when: { header: { 'x-mock-case': 'timeout' } },
      response: { code: 0, data: null, message: '' },
      httpStatus: 0,
      meta: { delayMs: 60000, fault: 'hang' },
    },
    {
      id: 'offline',
      when: { header: { 'x-mock-case': 'offline' } },
      response: { code: 0, data: null, message: '' },
      httpStatus: 0,
      meta: { fault: 'reset' },
    },
    ...enumCases,
  ];
}

function buildContract(roleEntry, { taskId, source, resolution }) {
  const upstreamId = roleEntry.upstreamId || deriveUpstreamId({
    hostVar: roleEntry.hostVar,
    hosts: roleEntry.hosts || [roleEntry.host].filter(Boolean),
  }) || '_default';
  const hosts = roleEntry.hosts || (roleEntry.host && roleEntry.host !== '_default' ? [roleEntry.host] : []);
  const canonicalHost = roleEntry.canonicalHost || (hosts.length ? pickCanonicalHost(hosts, upstreamId) : null);
  const id = roleEntry.stubId || makeStubId({ upstreamId, method: roleEntry.method, path: roleEntry.path });
  const now = new Date().toISOString();
  const historyEntry = {
    taskId: taskId || null,
    role: roleEntry.role,
    at: now,
    action: roleEntry.hasMock ? 'update' : 'create',
  };

  const shape =
    roleEntry.responseShape ||
    ({
      type: 'object',
      props: Object.fromEntries(
        (roleEntry.responseHints || []).map((h) => [h, { type: 'unknown' }]),
      ),
    });

  const dataSample = materialize(shape);
  const hasData =
    (shape && shape.type === 'array') ||
    (dataSample &&
      typeof dataSample === 'object' &&
      (Array.isArray(dataSample)
        ? dataSample.length > 0
        : Object.keys(dataSample).length > 0));

  const enumCases = buildEnumCases(shape, dataSample);
  const coverage = roleEntry.coverage || {
    request: { keysFound: [], confidence: 'low' },
    response: { pathsFound: [], confidence: 'low' },
    enums: [],
    gaps: ['unknown'],
  };

  const cases = buildStandardCases(dataSample, enumCases);

  return {
    id,
    stubId: id,
    upstreamId,
    hosts,
    canonicalHost,
    method: [roleEntry.method || 'GET'],
    path: roleEntry.path,
    source: source || 'usage',
    role: roleEntry.role,
    relatedToTask: Boolean(roleEntry.relatedToTask),
    confidence: roleEntry.confidence || 'medium',
    lastTaskId: taskId || null,
    history: [historyEntry],
    resolution: resolution || null,
    request: {
      query: hintListToObject(
        roleEntry.queryHints?.length
          ? roleEntry.queryHints
          : coverage.request?.keysFound || [],
      ),
      body: hintListToObject(roleEntry.bodyHints || []),
      headers: [],
    },
    response: {
      envelope: { code: 'number', data: 'object|null', message: 'string' },
      successCode: 0,
      dataFields: shapeToDataFields(shape),
      bizCodes: [],
      source: hasData ? (source && source.includes('openapi') ? 'openapi' : 'usage') : 'empty',
      shape,
    },
    cases,
    coverage,
    fidelity: classifyFidelity({
      response: { source: hasData ? 'usage' : 'empty', shape },
      coverage,
    }),
    evidences: roleEntry.evidences || [],
    exportHint: roleEntry.exportHint || null,
    exportKey: roleEntry.exportKey || null,
  };
}

function renderHandler(contract) {
  const gaps = (contract.coverage?.gaps || []).slice(0, 8).join(',');
  const layer = contract.coverage?.layer
    ? ` bind=${contract.coverage.layer.bind} trace=${contract.coverage.layer.trace}`
    : '';
  const casesJson = JSON.stringify(
    Object.fromEntries(
      contract.cases.map((c) => [
        c.id,
        {
          response: c.response,
          httpStatus: c.httpStatus,
          meta: c.meta,
        },
      ]),
    ),
    null,
    2,
  );
  return `/** Auto-generated by mox — ${contract.id}${gaps ? ` gaps=${gaps}` : ''}${layer} */
module.exports = ({ method, query, params, body, headers, caseId }) => {
  const cases = ${casesJson};
  const id = caseId || (headers && (headers['x-mock-case'] || headers['X-Mock-Case'])) || 'success';
  const entry = cases[id] || cases.success || { response: { code: 0, data: {}, message: '' }, httpStatus: 200 };
  return entry;
};
`;
}

function isCaptureBacked(contract) {
  const src = contract?.response?.source || '';
  return String(src).includes('capture');
}

/**
 * Preserve capture success.data when merging usage regen.
 * @param {object} existing
 * @param {object} next
 * @param {{ taskId?: string|null, overwriteCapture?: boolean }} opts
 */
function mergeContract(existing, next, { taskId, overwriteCapture = false } = {}) {
  const history = [...(existing.history || []), ...(next.history || [])].slice(
    -50,
  );

  if (isCaptureBacked(existing) && !overwriteCapture) {
    const cases = mergeCasesPreserveCapture(existing.cases, next.cases);
    const response = {
      ...next.response,
      ...existing.response,
      source: existing.response.source,
      dataFields: {
        ...(next.response?.dataFields || {}),
        ...(existing.response?.dataFields || {}),
      },
      shape: existing.response?.shape || next.response?.shape,
    };
    return {
      ...existing,
      ...next,
      history,
      lastTaskId: taskId || existing.lastTaskId || null,
      request: {
        query: {
          ...(existing.request?.query || {}),
          ...(next.request?.query || {}),
        },
        body: {
          ...(existing.request?.body || {}),
          ...(next.request?.body || {}),
        },
        headers: next.request?.headers || existing.request?.headers || [],
      },
      response,
      cases,
      coverage: next.coverage || existing.coverage,
      fidelity: classifyFidelity({ response, coverage: next.coverage || existing.coverage }),
      evidences: [
        ...new Set([
          ...(existing.evidences || []),
          ...(next.evidences || []),
        ]),
      ],
      exportHint: next.exportHint || existing.exportHint,
      exportKey: next.exportKey || existing.exportKey,
    };
  }

  // Prefer richer data sample (non-capture path)
  const nextData = next.cases?.find((c) => c.id === 'success')?.response?.data;
  const prevData = existing.cases?.find((c) => c.id === 'success')?.response
    ?.data;
  const nextRich =
    nextData &&
    typeof nextData === 'object' &&
    Object.keys(nextData).length > 0;
  const prevRich =
    prevData &&
    typeof prevData === 'object' &&
    Object.keys(prevData).length > 0;

  const cases =
    nextRich || !prevRich
      ? next.cases
      : mergeCasesPreserve(existing.cases, next.cases);

  const response = {
    ...existing.response,
    ...next.response,
    dataFields: {
      ...(existing.response?.dataFields || {}),
      ...(next.response?.dataFields || {}),
    },
    shape: nextRich
      ? next.response?.shape
      : existing.response?.shape || next.response?.shape,
  };
  return {
    ...existing,
    ...next,
    history,
    lastTaskId: taskId || existing.lastTaskId || null,
    request: {
      query: { ...(existing.request?.query || {}), ...(next.request?.query || {}) },
      body: { ...(existing.request?.body || {}), ...(next.request?.body || {}) },
      headers: next.request?.headers || existing.request?.headers || [],
    },
    response,
    cases,
    coverage: next.coverage || existing.coverage,
    fidelity: classifyFidelity({ response, coverage: next.coverage || existing.coverage }),
    evidences: [
      ...new Set([...(existing.evidences || []), ...(next.evidences || [])]),
    ],
  };
}

/** Keep existing success case when capture-backed; refresh other cases from next. */
function mergeCasesPreserveCapture(prev = [], next = []) {
  const map = new Map(next.map((c) => [c.id, c]));
  const prevSuccess = prev.find((c) => c.id === 'success');
  if (prevSuccess) map.set('success', prevSuccess);
  for (const c of prev) {
    if (c.id !== 'success' && !map.has(c.id)) map.set(c.id, c);
  }
  return [...map.values()];
}

function mergeCasesPreserve(prev = [], next = []) {
  const map = new Map(prev.map((c) => [c.id, c]));
  for (const c of next) {
    if (!map.has(c.id) || c.id !== 'success') map.set(c.id, c);
    else if (
      c.id === 'success' &&
      Object.keys(c.response?.data || {}).length >
        Object.keys(map.get('success').response?.data || {}).length
    ) {
      map.set(c.id, c);
    }
  }
  return [...map.values()];
}

function loadExistingContracts(projectSlug) {
  const { loadContractsForCatalog } = require('../lib/catalog-merge');
  const map = new Map();
  for (const c of loadContractsForCatalog(projectSlug)) {
    if (c.id) map.set(c.id, c);
    if (c.stubId && c.stubId !== c.id) map.set(c.stubId, c);
  }
  return map;
}

function listExistingMockKeys(projectSlug) {
  const { listMockKeysForCatalog } = require('../lib/catalog-merge');
  return listMockKeysForCatalog(projectSlug);
}

/** Remove gateway-only mocks (path depth <= 1) left by old infer */
function cleanupGatewayOnlyMocks(projectSlug) {
  const mocksRoot = path.join(projectDataDir(projectSlug), 'mocks');
  const contractsDir = path.join(projectDataDir(projectSlug), 'contracts');
  let removed = 0;
  if (!fs.existsSync(mocksRoot)) return removed;

  function rmHandler(host, parts) {
    const p = '/' + parts.join('/');
    if (pathDepth(p) > 1) return;
    const handler = path.join(mocksRoot, host, ...parts, 'index.js');
    if (fs.existsSync(handler)) {
      fs.unlinkSync(handler);
      removed++;
      // remove empty dirs
      try {
        fs.rmdirSync(path.join(mocksRoot, host, ...parts));
      } catch {
        /* ignore */
      }
    }
    // remove matching contracts
    if (fs.existsSync(contractsDir)) {
      for (const f of fs.readdirSync(contractsDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const c = JSON.parse(
            fs.readFileSync(path.join(contractsDir, f), 'utf8'),
          );
          if (c.host === host && c.path === p && pathDepth(p) <= 1) {
            fs.unlinkSync(path.join(contractsDir, f));
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  function walkDir(dir, host, parts) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walkDir(full, host, [...parts, ent.name]);
        // after children, if this is depth-1 leaf with index already removed
      } else if (ent.name === 'index.js') {
        rmHandler(host, parts);
      }
    }
  }

  for (const hostEnt of fs.readdirSync(mocksRoot, { withFileTypes: true })) {
    if (!hostEnt.isDirectory()) continue;
    walkDir(path.join(mocksRoot, hostEnt.name), hostEnt.name, []);
  }
  return removed;
}

function rmEmptyParents(startDir, stopDir) {
  let cur = startDir;
  while (cur && cur.startsWith(stopDir) && cur !== stopDir) {
    try {
      fs.rmdirSync(cur);
    } catch {
      break;
    }
    cur = path.dirname(cur);
  }
}

/**
 * After --force generate: delete handlers/contracts not in this round's whitelist
 * and without mox:manual. Handlers whitelist = stubIds; contracts =
 * all stubIds written this round (including contract-only skips).
 *
 * Walks service catalog (services/<up>/mocks/<METHOD>/<path>) and legacy
 * project mocks layouts.
 */
function pruneOrphanArtifacts(projectSlug, { keepHandlerKeys, keepContractKeys }) {
  const { serviceDataDir } = require('../lib/paths');
  const { readProjectIndex } = require('../lib/catalog-merge');
  const mocksRoot = path.join(projectDataDir(projectSlug), 'mocks');
  const contractsDir = path.join(projectDataDir(projectSlug), 'contracts');
  let prunedHandlers = 0;
  let prunedContracts = 0;
  const handlerKeep = keepHandlerKeys instanceof Set ? keepHandlerKeys : new Set(keepHandlerKeys || []);
  const contractKeep =
    keepContractKeys instanceof Set ? keepContractKeys : new Set(keepContractKeys || []);

  function pruneHandlerFile(full, stopDir, stubIdCandidates) {
    if (stubIdCandidates.some((k) => handlerKeep.has(k))) return;
    let content = '';
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      return;
    }
    if (content.includes('mox:manual')) return;
    fs.unlinkSync(full);
    prunedHandlers++;
    rmEmptyParents(path.dirname(full), stopDir);
  }

  // Legacy project mocks: mocks/<up>/<METHOD>/... or FQDN
  if (fs.existsSync(mocksRoot)) {
    function walkMocks(dir, parts) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walkMocks(full, [...parts, ent.name]);
        } else if (ent.name === 'index.js') {
          pruneHandlerFile(full, mocksRoot, reconstructStubIds(parts));
        }
      }
    }
    for (const ent of fs.readdirSync(mocksRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      walkMocks(path.join(mocksRoot, ent.name), [ent.name]);
    }
  }

  // Service catalog mocks: only services touched by this project / whitelist / project contracts
  const idx = readProjectIndex(projectSlug);
  const { parseStubId } = require('../lib/paths');
  const serviceIds = new Set([...(idx?.upstreams || [])]);
  for (const id of handlerKeep) {
    try {
      serviceIds.add(parseStubId(id).upstreamId);
    } catch {
      /* ignore */
    }
  }
  for (const id of contractKeep) {
    try {
      serviceIds.add(parseStubId(id).upstreamId);
    } catch {
      /* ignore */
    }
  }
  if (fs.existsSync(contractsDir)) {
    for (const f of fs.readdirSync(contractsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(contractsDir, f), 'utf8'));
        if (c.upstreamId) serviceIds.add(sanitizeUpstreamId(c.upstreamId));
        if (c.stubId || c.id) {
          try {
            serviceIds.add(parseStubId(c.stubId || c.id).upstreamId);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  for (const up of serviceIds) {
    const svcMocks = path.join(serviceDataDir(up), 'mocks');
    if (!fs.existsSync(svcMocks)) continue;
    function walkSvc(dir, parts) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walkSvc(full, [...parts, ent.name]);
        } else if (ent.name === 'index.js') {
          // parts = [METHOD, ...pathSegs]
          const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
          let candidates = [];
          if (parts.length >= 1 && methods.includes(parts[0])) {
            const p = '/' + parts.slice(1).join('/');
            candidates = [`${parts[0]} ${up}${p}`];
          } else {
            candidates = reconstructStubIds([up, ...parts]);
          }
          pruneHandlerFile(full, svcMocks, candidates);
        }
      }
    }
    for (const ent of fs.readdirSync(svcMocks, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      walkSvc(path.join(svcMocks, ent.name), [ent.name]);
    }

    const svcContracts = path.join(serviceDataDir(up), 'contracts');
    if (fs.existsSync(svcContracts)) {
      for (const f of fs.readdirSync(svcContracts)) {
        if (!f.endsWith('.json')) continue;
        const full = path.join(svcContracts, f);
        let c;
        try {
          c = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch {
          continue;
        }
        const id = c.id || c.stubId || apiKey(c);
        if (contractKeep.has(id)) continue;
        if (c.manual === true || c['mox:manual'] === true) continue;
        fs.unlinkSync(full);
        prunedContracts++;
      }
    }
  }

  if (fs.existsSync(contractsDir)) {
    for (const f of fs.readdirSync(contractsDir)) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(contractsDir, f);
      let c;
      try {
        c = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        continue;
      }
      const id = c.id || c.stubId || apiKey(c);
      if (contractKeep.has(id)) continue;
      if (c.manual === true || c['mox:manual'] === true) continue;
      fs.unlinkSync(full);
      prunedContracts++;
    }
  }

  return { prunedHandlers, prunedContracts };
}

/**
 * Reconstruct possible stubIds from path parts.
 * New layout: [upstreamId, METHOD, ...pathSegs] → METHOD upstreamId/path
 * Old layout: [host, ...pathSegs] → METHOD host/path (for each METHOD)
 */
function reconstructStubIds(parts) {
  if (parts.length >= 2) {
    // New layout: parts[1] is METHOD (GET/POST/PUT/PATCH/DELETE)
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    if (methods.includes(parts[1])) {
      const up = parts[0];
      const p = '/' + parts.slice(2).join('/');
      return [`${parts[1]} ${up}${p}`];
    }
  }
  // Old layout: parts[0] is host, rest is path
  const host = parts[0] || '_default';
  const p = '/' + parts.slice(1).join('/');
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => `${m} ${host}${p}`);
}

function generateMocks({
  projectSlug,
  roles,
  conflicts = [],
  taskId = null,
  force = false,
  merge = true,
  overwriteCapture = false,
}) {
  ensureProjectDirs(projectSlug);
  const removedGateway = cleanupGatewayOnlyMocks(projectSlug);

  const conflictKeys = new Set(
    conflicts.filter((c) => !c.resolution).map((c) => c.apiKey),
  );
  const existing = loadExistingContracts(projectSlug);
  let generated = 0;
  let skipped = 0;
  let reused = 0;
  let usageBackedCount = 0;
  let emptyDataCount = 0;
  let enumBackedCount = 0;
  let skippedEmptyCount = 0;
  let prunedHandlers = 0;
  let prunedContracts = 0;
  let traceEmptyCount = 0;
  let bindAmbiguousCount = 0;
  let capturePreservedCount = 0;
  /** @type {Set<string>} unique exportHint (or apiKey fallback) with usage-backed data */
  const usageBackedHintSet = new Set();
  /** @type {Set<string>} unique exportHint (or apiKey fallback) with empty data */
  const emptyDataHintSet = new Set();
  const gapApis = [];
  const blocked = [];
  const rules = [];
  /** @type {Map<string, object[]>} */
  const rulesByUpstream = new Map();
  /** Contracts written this round (including contract-only skips) */
  const keepContractKeys = new Set();
  const stubIds = [];
  const upstreamIds = new Set();

  function trackHintCoverage(contract, key) {
    const hint = contract.exportHint || key;
    const src = contract.response?.source || '';
    if (src === 'usage' || String(src).includes('capture')) {
      usageBackedCount++;
      usageBackedHintSet.add(hint);
    } else {
      emptyDataCount++;
      emptyDataHintSet.add(hint);
    }
    const gaps = contract.coverage?.gaps || [];
    if (gaps.includes('TRACE_EMPTY')) traceEmptyCount++;
    if (gaps.includes('bind_ambiguous')) bindAmbiguousCount++;
  }

  function applyExistingMerge(key, contract) {
    if (!existing.has(key)) return contract;
    const prev = existing.get(key);
    // Always protect capture unless overwriteCapture — even under --force
    if (isCaptureBacked(prev) && !overwriteCapture) {
      capturePreservedCount++;
      return mergeContract(prev, contract, { taskId, overwriteCapture: false });
    }
    if (merge) {
      return mergeContract(prev, contract, { taskId, overwriteCapture });
    }
    return contract;
  }

  function pushRule(rule) {
    rules.push(rule);
    const up = sanitizeUpstreamId(rule.upstreamId || '_default');
    if (!rulesByUpstream.has(up)) rulesByUpstream.set(up, []);
    rulesByUpstream.get(up).push(rule);
  }

  function writeContractAndHandler(upstreamId, key, contract, roleEntry, hasHandler, handlerFile) {
    ensureServiceDirs(upstreamId);
    const cPath = serviceContractPath(upstreamId, key);
    fs.mkdirSync(path.dirname(cPath), { recursive: true });
    fs.writeFileSync(cPath, `${JSON.stringify(contract, null, 2)}\n`);
    keepContractKeys.add(key);
    stubIds.push(key);
    upstreamIds.add(sanitizeUpstreamId(upstreamId));
  }

  /**
   * Contract-only gate: empty shape + weak/discover gaps → write contract only,
   * no handler, no proxy rule. Keeps the stub discoverable for capture-merge /
   * import-openapi without polluting the proxy with dead/empty handlers.
   *
   * Triggers:
   *  - no_export_symbol: URL found but no export bound (discover gap)
   *  - no_callsite: export never called (dead export) — Phase 3 policy
   * Both are gaps capture cannot create value for; TRACE_EMPTY keeps a handler
   * (callsite exists → capture-merge can fill it).
   */
  function isEmptyContractOnly(contract) {
    if (contract.response?.source !== 'empty') return false;
    const gaps = contract.coverage?.gaps || [];
    return gaps.includes('no_export_symbol') || gaps.includes('no_callsite');
  }

  // Skip roles that are still gateway-only
  const filteredRoles = roles.filter((r) => {
    const p = r.path || '';
    return pathDepth(p) > 1;
  });

  for (const roleEntry of filteredRoles) {
    const upstreamId = sanitizeUpstreamId(
      roleEntry.upstreamId ||
        deriveUpstreamId({
          hostVar: roleEntry.hostVar,
          hosts: roleEntry.hosts || [roleEntry.host].filter(Boolean),
        }) ||
        '_default',
    );
    const hosts = roleEntry.hosts || (roleEntry.host && roleEntry.host !== '_default' ? [roleEntry.host] : []);
    const canonicalHost = roleEntry.canonicalHost || (hosts.length ? pickCanonicalHost(hosts, upstreamId) : null);
    const key = roleEntry.stubId || makeStubId({ upstreamId, method: roleEntry.method, path: roleEntry.path });

    if (roleEntry.role === 'new' && roleEntry.blocked) {
      blocked.push(key);
      skipped++;
      continue;
    }
    if (conflictKeys.has(key) && !force) {
      skipped++;
      continue;
    }

    ensureServiceDirs(upstreamId);
    const handlerFile = serviceStubHandlerPath(
      upstreamId,
      roleEntry.method || 'GET',
      roleEntry.path,
    );
    const hasHandler = fs.existsSync(handlerFile);

    if (
      (roleEntry.role === 'dependency' || roleEntry.role === 'unrelated') &&
      hasHandler &&
      !force
    ) {
      // Still refresh contract IO if usage-backed is richer
      let contract = buildContract(roleEntry, {
        taskId,
        source: roleEntry.source || 'usage',
      });
      if (merge && existing.has(key)) {
        contract = applyExistingMerge(key, contract);
      }
      writeContractAndHandler(upstreamId, key, contract, roleEntry, hasHandler, handlerFile);
      trackHintCoverage(contract, key);
      if (contract.coverage?.enums?.length) enumBackedCount++;
      if (contract.coverage?.gaps?.length) {
        gapApis.push({ id: key, gaps: contract.coverage.gaps });
      }
      reused++;
      if (!isEmptyContractOnly(contract)) {
        pushRule({
          id: key,
          stubId: key,
          upstreamId,
          hosts: hosts.length ? hosts : undefined,
          host: upstreamId === '_default' ? '*' : undefined,
          pathPrefix: roleEntry.path,
          methods: [roleEntry.method || 'GET'],
        });
      } else {
        skippedEmptyCount++;
      }
      continue;
    }

    let contract = buildContract(roleEntry, {
      taskId,
      source: roleEntry.source || (roleEntry.role === 'new' ? 'docs|manual' : 'usage'),
    });
    contract = applyExistingMerge(key, contract);

    trackHintCoverage(contract, key);
    if (contract.coverage?.enums?.length) enumBackedCount++;
    if (contract.coverage?.gaps?.length) {
      gapApis.push({ id: key, gaps: contract.coverage.gaps });
    }

    writeContractAndHandler(upstreamId, key, contract, roleEntry, hasHandler, handlerFile);

    // Gate: empty + weak gaps → contract only, no empty handler / proxy rule
    if (isEmptyContractOnly(contract)) {
      skippedEmptyCount++;
      if (fs.existsSync(handlerFile)) {
        try {
          const prev = fs.readFileSync(handlerFile, 'utf8');
          if (!prev.includes('mox:manual')) fs.unlinkSync(handlerFile);
        } catch {
          /* ignore */
        }
      }
      appendAudit(projectSlug, {
        command: 'generate',
        taskId,
        apiKey: key,
        role: roleEntry.role,
        summary: 'skipped-empty-handler',
      });
      continue;
    }

    if (hasHandler && merge && !force && roleEntry.role === 'modify') {
      const prev = fs.readFileSync(handlerFile, 'utf8');
      if (prev.includes('mox:manual')) {
        skipped++;
      } else {
        fs.writeFileSync(handlerFile, renderHandler(contract));
        generated++;
      }
    } else {
      fs.mkdirSync(path.dirname(handlerFile), { recursive: true });
      fs.writeFileSync(handlerFile, renderHandler(contract));
      generated++;
    }

    pushRule({
      id: key,
      stubId: key,
      upstreamId,
      hosts: hosts.length ? hosts : undefined,
      host: upstreamId === '_default' ? '*' : undefined,
      pathPrefix: roleEntry.path,
      methods: contract.method || [roleEntry.method || 'GET'],
    });

    appendAudit(projectSlug, {
      command: 'generate',
      taskId,
      apiKey: key,
      role: roleEntry.role,
      summary: hasHandler ? 'updated' : 'created',
    });
  }

  // Persist per-service rules + upstreams
  for (const [up, list] of rulesByUpstream) {
    upsertServiceRules(up, list);
    const upstreamsMap = {};
    for (const roleEntry of filteredRoles) {
      const u = sanitizeUpstreamId(
        roleEntry.upstreamId ||
          deriveUpstreamId({
            hostVar: roleEntry.hostVar,
            hosts: roleEntry.hosts || [roleEntry.host].filter(Boolean),
          }) ||
          '_default',
      );
      if (u !== up) continue;
      const h = roleEntry.hosts || (roleEntry.host && roleEntry.host !== '_default' ? [roleEntry.host] : []);
      const ch = roleEntry.canonicalHost || (h.length ? pickCanonicalHost(h, u) : null);
      if (!upstreamsMap[u] || (h.length > (upstreamsMap[u].hosts || []).length)) {
        upstreamsMap[u] = { hosts: h, canonicalHost: ch };
      }
    }
    fs.writeFileSync(
      path.join(serviceDataDir(up), 'upstreams.json'),
      `${JSON.stringify({ version: 1, upstreams: upstreamsMap }, null, 2)}\n`,
    );
  }

  // Frontend discovery index only (no catalog dual-write under projects/)
  writeProjectIndex(projectSlug, {
    stubs: stubIds,
    upstreams: [...upstreamIds],
  });

  if (force) {
    const keepHandlerKeys = new Set(rules.map((r) => r.id));
    const pruned = pruneOrphanArtifacts(projectSlug, {
      keepHandlerKeys,
      keepContractKeys,
    });
    prunedHandlers = pruned.prunedHandlers;
    prunedContracts = pruned.prunedContracts;
  }

  // Phase 2: auto-bind store handlers + silent domain-draft for CRUD clusters
  let storeRewritten = [];
  let domainDrafts = [];
  try {
    const {
      materializeStoreHandlers,
      writeDomainDraft,
    } = require('../lib/service-infer');
    for (const up of upstreamIds) {
      const stubs = rules
        .filter((r) => sanitizeUpstreamId(r.upstreamId) === up)
        .map((r) => {
          try {
            const { parseStubId } = require('../lib/paths');
            const p = parseStubId(r.stubId);
            return {
              stubId: r.stubId,
              method: p.method,
              path: p.path,
              upstreamId: up,
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const m = materializeStoreHandlers(up, stubs, { force: false });
      storeRewritten = storeRewritten.concat(m.rewritten);
      try {
        const draft = writeDomainDraft({
          upstreamId: up,
          stubs,
          projectSlug,
          confirm: true,
        });
        domainDrafts.push({
          upstreamId: up,
          draftPath: draft.draftPath,
          clusters: draft.clusters,
        });
      } catch {
        /* draft is best-effort */
      }
    }
  } catch (e) {
    // non-fatal: static handlers remain
  }

  return {
    generated,
    skipped,
    blocked,
    reused,
    // Project aggregate proxy-rules no longer written; truth is services/<up>/proxy-rules.json
    rulesPath: null,
    removedGateway,
    usageBackedCount,
    emptyDataCount,
    usageBackedHints: usageBackedHintSet.size,
    emptyDataHints: emptyDataHintSet.size,
    enumBackedCount,
    skippedEmptyCount,
    prunedHandlers,
    prunedContracts,
    gapApis,
    gatewayFilteredRoles: roles.length - filteredRoles.length,
    traceEmptyCount,
    bindAmbiguousCount,
    capturePreservedCount,
    upstreamIds: [...upstreamIds],
    storeRewritten,
    domainDrafts,
  };
}

module.exports = {
  generateMocks,
  buildContract,
  renderHandler,
  loadExistingContracts,
  listExistingMockKeys,
  cleanupGatewayOnlyMocks,
  pruneOrphanArtifacts,
  mergeContract,
  isCaptureBacked,
};

if (require.main === module) {
  console.error('Use via mox generate or init');
  process.exit(1);
}
