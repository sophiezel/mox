'use strict';

/**
 * Merge proxy captures into catalog mocks:
 * - existing stub → additive L2 upgrade
 * - missing stub → gated promote (contract + handler + proxy-rules)
 */
const fs = require('fs');
const path = require('path');
const {
  ensureServiceDirs,
  serviceDataDir,
  serviceContractPath,
  stubHandlerPath,
  stubId: makeStubId,
  apiKey,
  listServiceIds,
  sanitizeUpstreamId,
  parseStubId,
} = require('../lib/paths');
const { appendAudit } = require('../lib/audit');
const { renderHandler, loadExistingContracts } = require('./generate-mock');
const { isPlaceholderValue } = require('../lib/materialize');
const { classifyFidelity } = require('../lib/gap-taxonomy');
const { sanitizeCapture } = require('../lib/sanitize-capture');
const { isCaptureNoiseHost } = require('../lib/capture-filter');
const { upsertServiceRules } = require('../lib/catalog-merge');
const { resolveServiceIdFromHost } = require('../lib/resolve-service-id-from-host');

function deepMergeShape(target, sample) {
  if (sample == null) return target;
  if (Array.isArray(sample)) {
    return {
      type: 'array',
      item:
        sample.length > 0
          ? deepMergeShape({ type: 'object', props: {} }, sample[0])
          : { type: 'unknown' },
    };
  }
  if (typeof sample !== 'object') {
    const t =
      typeof sample === 'number'
        ? 'number'
        : typeof sample === 'boolean'
          ? 'boolean'
          : 'string';
    return { type: t };
  }
  const props = { ...(target?.props || {}) };
  for (const [k, v] of Object.entries(sample)) {
    props[k] = deepMergeShape(props[k], v);
  }
  return { type: 'object', props };
}

/**
 * Merge capture data into existing mock data.
 * Real capture wins over null/''/faker placeholders; nested objects recurse.
 * New keys from real response are added (they are API fields, not invented).
 */
function mergeDataAdditive(existing, incoming) {
  if (incoming == null) return existing;
  if (existing == null) return incoming;
  if (Array.isArray(incoming)) {
    if (!Array.isArray(existing) || existing.length === 0) return incoming;
    if (incoming.length === 0) return existing;
    return [mergeDataAdditive(existing[0] || {}, incoming[0])];
  }
  if (typeof incoming !== 'object') {
    if (isPlaceholderValue(existing)) return incoming;
    return incoming;
  }
  const out = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    if (!(k in out) || isPlaceholderValue(out[k])) {
      out[k] = v;
    } else if (
      v != null &&
      typeof v === 'object' &&
      typeof out[k] === 'object' &&
      !Array.isArray(v) &&
      !Array.isArray(out[k])
    ) {
      out[k] = mergeDataAdditive(out[k], v);
    } else if (typeof v !== 'object' || v === null) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = mergeDataAdditive(out[k], v);
    }
  }
  return out;
}

/** Aggregate upstreams from all services. */
function loadUpstreams() {
  const merged = { version: 1, upstreams: {} };
  for (const up of listServiceIds()) {
    const p = path.join(serviceDataDir(up), 'upstreams.json');
    if (!fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      Object.assign(merged.upstreams, data.upstreams || {});
    } catch {
      /* ignore */
    }
  }
  return merged;
}

/** Persist host aliases into services/<upstreamId>/upstreams.json. */
function saveUpstreams(_ignored, data) {
  const { assertHostsCompatible } = require('../lib/upstream');
  for (const [upId, info] of Object.entries(data.upstreams || {})) {
    const up = sanitizeUpstreamId(upId);
    ensureServiceDirs(up);
    const p = path.join(serviceDataDir(up), 'upstreams.json');
    let existing = { version: 1, upstreams: {} };
    if (fs.existsSync(p)) {
      try {
        existing = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        /* ignore */
      }
    }
    existing.upstreams = existing.upstreams || {};
    const prev = existing.upstreams[up];
    if (prev?.hosts && info?.hosts) {
      assertHostsCompatible(prev.hosts, info.hosts, { serviceId: up });
    }
    existing.upstreams[up] = info;
    fs.writeFileSync(p, `${JSON.stringify(existing, null, 2)}\n`);
  }
}

function hostToUpstream(host, upstreams) {
  if (!host) return null;
  for (const [upId, info] of Object.entries(upstreams.upstreams || {})) {
    if ((info.hosts || []).includes(host)) return upId;
  }
  return null;
}

/** List capture JSON files from services/{id}/captures and optional overrides. */
function listCaptureFiles(opts = {}) {
  /** @type {{ file: string, dir: string }[]} */
  const out = [];
  if (opts.capturesDir && fs.existsSync(opts.capturesDir)) {
    for (const f of fs.readdirSync(opts.capturesDir)) {
      if (f.endsWith('.json')) out.push({ file: f, dir: opts.capturesDir });
    }
    return out;
  }
  const { getDataRoot } = require('../lib/paths');
  const root = path.join(getDataRoot(), 'services');
  if (!fs.existsSync(root)) return out;
  for (const up of fs.readdirSync(root)) {
    const dir = path.join(root, up, 'captures');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) out.push({ file: f, dir });
    }
  }
  return out;
}

function tryParseStubId(id) {
  if (!id || typeof id !== 'string') return null;
  try {
    return parseStubId(id);
  } catch {
    return null;
  }
}

function buildPromotedContract({ upstreamId, method, path: urlPath, host, data, id }) {
  const shape = deepMergeShape({ type: 'object', props: {} }, data);
  const contract = {
    id,
    stubId: id,
    upstreamId,
    hosts: host && host !== '_default' ? [host] : [],
    method: [method],
    path: urlPath.startsWith('/') ? urlPath : `/${urlPath}`,
    source: 'capture',
    role: 'dependency',
    relatedToTask: false,
    confidence: 'high',
    lastTaskId: null,
    history: [
      {
        taskId: null,
        role: 'dependency',
        at: new Date().toISOString(),
        action: 'promote-from-capture',
      },
    ],
    request: { query: {}, body: {}, headers: [] },
    response: {
      envelope: { code: 'number', data: 'object|null', message: 'string' },
      source: 'usage+capture',
      shape,
    },
    cases: [
      {
        id: 'success',
        response: {
          code: 0,
          data,
          message: '',
        },
        httpStatus: 200,
      },
      {
        id: 'empty',
        response: { code: 0, data: Array.isArray(data) ? [] : {}, message: '' },
        httpStatus: 200,
      },
      {
        id: 'biz_error',
        response: { code: 1, data: null, message: 'biz error' },
        httpStatus: 200,
      },
    ],
    coverage: {
      request: { keysFound: [], confidence: 'medium' },
      response: {
        confidence: 'high',
        pathsFound: Object.keys(
          typeof data === 'object' && data && !Array.isArray(data) ? data : {},
        ),
      },
      enums: [],
      gaps: [],
    },
  };
  contract.fidelity = classifyFidelity(contract);
  return contract;
}

function applyCaptureToContract(contract, data, { learnedHost = false } = {}) {
  const success = contract.cases?.find((c) => c.id === 'success');
  if (!success) return { ok: false, reason: 'no_success_case' };
  const prev = success.response?.data;
  const next = mergeDataAdditive(prev, data);
  if (JSON.stringify(prev) === JSON.stringify(next) && !learnedHost) {
    return { ok: false, reason: 'noop_unchanged' };
  }
  success.response = success.response || {};
  success.response.data = next;
  contract.response = contract.response || {};
  contract.response.source = 'usage+capture';
  contract.response.shape = deepMergeShape(
    contract.response.shape || { type: 'object', props: {} },
    data,
  );
  contract.fidelity = classifyFidelity(contract);
  contract.coverage = contract.coverage || {
    request: { keysFound: [] },
    response: { pathsFound: [] },
    enums: [],
    gaps: [],
  };
  contract.coverage.gaps = (contract.coverage.gaps || []).filter(
    (g) =>
      g !== 'no_property_access' &&
      g !== 'no_export_symbol' &&
      g !== 'TRACE_EMPTY' &&
      g !== 'no_callsite',
  );
  contract.coverage.response = {
    ...contract.coverage.response,
    confidence: 'high',
    pathsFound: [
      ...new Set([
        ...(contract.coverage.response.pathsFound || []),
        ...Object.keys(typeof data === 'object' && data && !Array.isArray(data) ? data : {}),
      ]),
    ],
  };
  return { ok: true };
}

function persistContractAndHandler(contract, upstreamId, method, { createHandler }) {
  const up = sanitizeUpstreamId(upstreamId);
  ensureServiceDirs(up);
  const id = contract.stubId || contract.id;
  const cPath = serviceContractPath(up, id);
  fs.mkdirSync(path.dirname(cPath), { recursive: true });
  fs.writeFileSync(cPath, `${JSON.stringify(contract, null, 2)}\n`);

  const handlerFile = stubHandlerPath(null, up, method, contract.path);
  const exists = fs.existsSync(handlerFile);
  if (exists) {
    const src = fs.readFileSync(handlerFile, 'utf8');
    if (!src.includes('mox:manual')) {
      fs.writeFileSync(handlerFile, renderHandler(contract));
    }
  } else if (createHandler) {
    fs.mkdirSync(path.dirname(handlerFile), { recursive: true });
    fs.writeFileSync(handlerFile, renderHandler(contract));
  }
  return cPath;
}

function captureMerge(labelOrOpts, maybeOpts) {
  const opts =
    maybeOpts != null
      ? maybeOpts
      : labelOrOpts && typeof labelOrOpts === 'object' && !Array.isArray(labelOrOpts)
        ? labelOrOpts
        : {};
  const label =
    maybeOpts != null
      ? labelOrOpts
      : typeof labelOrOpts === 'string'
        ? labelOrOpts
        : 'default';

  const { ensureDataDirs, reportsDir } = require('../lib/paths');
  ensureDataDirs();

  const captureFiles = listCaptureFiles(opts);
  if (!captureFiles.length) {
    console.log('[mox] no captures');
    return { merged: 0, upgraded: 0, created: 0, skipped: [] };
  }

  const contracts = loadExistingContracts();
  const upstreamsData = loadUpstreams();
  let upgraded = 0;
  let created = 0;
  let anyLearnedHost = false;
  const skipped = [];
  const skippedByReason = {};

  const pushSkip = (row) => {
    skipped.push(row);
    const r = row.reason || 'unknown';
    skippedByReason[r] = (skippedByReason[r] || 0) + 1;
  };

  for (const { file: f, dir: capturesDir } of captureFiles) {
    let cap;
    try {
      cap = JSON.parse(fs.readFileSync(path.join(capturesDir, f), 'utf8'));
    } catch {
      pushSkip({ file: f, reason: 'invalid_json' });
      continue;
    }
    if (!cap.path) {
      pushSkip({ file: f, reason: 'missing_path' });
      continue;
    }
    if (cap.bodyMeta && cap.bodyMeta.parseOk === false) {
      pushSkip({
        file: f,
        reason: 'body_not_json',
        host: cap.host,
        path: cap.path,
        method: cap.method,
        hint: cap.bodyMeta.error || 'bodyMeta.parseOk=false',
      });
      continue;
    }
    if (cap.responseBody == null || cap.responseBody === '') {
      pushSkip({
        file: f,
        reason: 'empty_responseBody',
        hint: 'capture had no body',
        host: cap.host,
        path: cap.path,
        method: cap.method,
      });
      continue;
    }

    const host = cap.host || '_default';
    const method = (cap.method || 'GET').toUpperCase();
    const urlPath = cap.path.startsWith('/') ? cap.path : `/${cap.path}`;

    if (isCaptureNoiseHost(host)) {
      pushSkip({ file: f, reason: 'noise_host', host, path: urlPath, method });
      continue;
    }

    let body = cap.responseBody;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        pushSkip({
          file: f,
          reason: 'body_not_json',
          host,
          path: urlPath,
          method,
        });
        continue;
      }
    }
    if (opts.sanitize !== false) {
      const sanitized = sanitizeCapture(
        { responseBody: body, requestHeaders: cap.requestHeaders },
        { sensitivePaths: opts.sensitivePaths || [] },
      );
      body = sanitized.responseBody;
    }
    const data =
      body && typeof body === 'object' && 'data' in body ? body.data : body;
    if (data == null) {
      pushSkip({ file: f, reason: 'null_data', host, path: urlPath, method });
      continue;
    }

    // --- identity ---
    let contract = null;
    let upstreamId = hostToUpstream(host, upstreamsData);
    let learnedHost = false;

    const parsedCapStub = tryParseStubId(cap.stubId);
    if (cap.stubId && contracts.has(cap.stubId)) {
      contract = contracts.get(cap.stubId);
    }
    if (!contract && parsedCapStub) {
      const id = makeStubId({
        upstreamId: parsedCapStub.upstreamId,
        method: parsedCapStub.method || method,
        path: parsedCapStub.path || urlPath,
      });
      contract = contracts.get(id) || null;
      if (!upstreamId) upstreamId = parsedCapStub.upstreamId;
    }

    const legacyKey = apiKey({ host, method, path: urlPath });
    if (!contract) {
      contract = contracts.get(legacyKey) || null;
    }

    if (!contract && !upstreamId && host !== '_default') {
      const matches = [];
      for (const [, c] of contracts) {
        if (c.path === urlPath && (c.method || ['GET']).includes(method)) {
          matches.push(c);
        }
      }
      if (matches.length === 1) {
        upstreamId = matches[0].upstreamId || '_default';
        contract = matches[0];
        const up =
          upstreamsData.upstreams[upstreamId] || {
            hosts: [],
            canonicalHost: null,
          };
        if (!up.hosts.includes(host)) {
          up.hosts.push(host);
          upstreamsData.upstreams[upstreamId] = up;
          learnedHost = true;
          anyLearnedHost = true;
        }
      } else if (matches.length > 1) {
        pushSkip({
          file: f,
          reason: 'unknown_or_ambiguous_host',
          host,
          path: urlPath,
          method,
          matchCount: matches.length,
        });
        continue;
      }
    }

    if (!contract && upstreamId) {
      const id = makeStubId({ upstreamId, method, path: urlPath });
      contract = contracts.get(id) || null;
    }

    // Promote: no contract but resolvable upstream (map or derive)
    if (!contract) {
      if (!upstreamId) {
        upstreamId = resolveServiceIdFromHost(host, {
          upstreams: upstreamsData,
        });
      }
      if (!upstreamId) {
        pushSkip({
          file: f,
          reason: 'unresolved_upstream',
          host,
          path: urlPath,
          method,
        });
        continue;
      }
      const upInfo =
        upstreamsData.upstreams[upstreamId] || {
          hosts: [],
          canonicalHost: null,
        };
      if (host !== '_default' && !(upInfo.hosts || []).includes(host)) {
        upInfo.hosts = [...(upInfo.hosts || []), host];
        upInfo.canonicalHost = upInfo.canonicalHost || host;
        upstreamsData.upstreams[upstreamId] = upInfo;
        anyLearnedHost = true;
      }
      const id = makeStubId({ upstreamId, method, path: urlPath });
      contract = buildPromotedContract({
        upstreamId,
        method,
        path: urlPath,
        host,
        data,
        id,
      });
      persistContractAndHandler(contract, upstreamId, method, {
        createHandler: true,
      });
      upsertServiceRules(upstreamId, [
        {
          stubId: id,
          id,
          upstreamId,
          methods: [method],
          pathPrefix: urlPath,
          hosts: host && host !== '_default' ? [host] : [],
        },
      ]);
      contracts.set(id, contract);
      if (contract.stubId) contracts.set(contract.stubId, contract);
      created += 1;
      appendAudit(label, {
        command: 'capture-merge',
        taskId: opts.taskId || null,
        apiKey: id,
        summary: 'promoted capture → new contract+handler',
      });
      continue;
    }

    if (!upstreamId) {
      upstreamId = contract.upstreamId || '_default';
    }

    const applied = applyCaptureToContract(contract, data, { learnedHost });
    if (!applied.ok) {
      pushSkip({
        file: f,
        reason: applied.reason,
        host,
        path: urlPath,
        method,
        stubId: contract.stubId || contract.id,
      });
      continue;
    }

    persistContractAndHandler(contract, upstreamId, method, {
      createHandler: false,
    });
    appendAudit(label, {
      command: 'capture-merge',
      taskId: opts.taskId || null,
      apiKey: contract.id || contract.stubId,
      summary: learnedHost
        ? 'merged capture + learned host alias'
        : 'merged capture response into contract',
    });
    upgraded += 1;
  }

  if (anyLearnedHost) {
    saveUpstreams(null, upstreamsData);
  }

  const merged = upgraded + created;
  if (skipped.length) {
    const report = path.join(
      reportsDir(),
      `capture-merge-skipped-${Date.now()}.json`,
    );
    fs.writeFileSync(
      report,
      `${JSON.stringify({ skipped, skippedByReason, upgraded, created }, null, 2)}\n`,
    );
    console.log(
      `[mox] capture-merge skipped=${skipped.length} (see ${report})`,
    );
    const top = Object.entries(skippedByReason)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
    if (top) console.log(`[mox] capture-merge skip reasons: ${top}`);
  }
  console.log(
    `[mox] capture-merge merged=${merged} upgraded=${upgraded} created=${created}`,
  );
  return { merged, upgraded, created, skipped, skippedByReason };
}

module.exports = { captureMerge, mergeDataAdditive, deepMergeShape };

if (require.main === module) {
  captureMerge({});
}
