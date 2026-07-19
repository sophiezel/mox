'use strict';

/**
 * L7: merge proxy captures into contracts (additive only).
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
} = require('../lib/paths');
const { appendAudit } = require('../lib/audit');
const { renderHandler, loadExistingContracts } = require('./generate-mock');
const { isPlaceholderValue } = require('../lib/materialize');
const { classifyFidelity } = require('../lib/gap-taxonomy');
const { sanitizeCapture } = require('../lib/sanitize-capture');

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
    return [
      mergeDataAdditive(existing[0] || {}, incoming[0]),
    ];
  }
  if (typeof incoming !== 'object') {
    // Scalar: real capture always preferred over placeholder / prior sample
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
      // Real leaf overwrites faker/init sample
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
    return { merged: 0 };
  }

  const contracts = loadExistingContracts();
  const upstreamsData = loadUpstreams();
  let merged = 0;
  let anyLearnedHost = false;
  const skipped = [];

  for (const { file: f, dir: capturesDir } of captureFiles) {
    let cap;
    try {
      cap = JSON.parse(fs.readFileSync(path.join(capturesDir, f), 'utf8'));
    } catch {
      skipped.push({ file: f, reason: 'invalid_json' });
      continue;
    }
    if (!cap.path) {
      skipped.push({ file: f, reason: 'missing_path' });
      continue;
    }
    if (!cap.responseBody) {
      skipped.push({
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

    const legacyKey = apiKey({ host, method, path: cap.path });
    let contract = contracts.get(legacyKey) || null;

    let upstreamId = hostToUpstream(host, upstreamsData);
    let learnedHost = false;

    if (!contract && !upstreamId && host !== '_default') {
      const matches = [];
      for (const [, c] of contracts) {
        if (c.path === cap.path && (c.method || ['GET']).includes(method)) {
          matches.push(c);
        }
      }
      if (matches.length === 1) {
        upstreamId = matches[0].upstreamId || '_default';
        contract = matches[0];
        const up = upstreamsData.upstreams[upstreamId] || { hosts: [], canonicalHost: null };
        if (!up.hosts.includes(host)) {
          up.hosts.push(host);
          upstreamsData.upstreams[upstreamId] = up;
          learnedHost = true;
          anyLearnedHost = true;
        }
      } else {
        skipped.push({
          file: f,
          reason: 'unknown_or_ambiguous_host',
          host,
          path: cap.path,
          method,
          matchCount: matches.length,
        });
        continue;
      }
    }

    if (!contract) {
      const id = makeStubId({ upstreamId: upstreamId || '_default', method, path: cap.path });
      contract = contracts.get(id);
    }
    if (!contract) {
      skipped.push({ file: f, reason: 'no_contract', host, path: cap.path, method });
      continue;
    }

    if (!upstreamId) {
      upstreamId = contract.upstreamId || '_default';
    }

    const id = contract.stubId || contract.id || makeStubId({
      upstreamId,
      method,
      path: cap.path,
    });

    let body = cap.responseBody;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
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
    if (data == null) continue;

    const success = contract.cases?.find((c) => c.id === 'success');
    if (!success) continue;
    const prev = success.response?.data;
    const next = mergeDataAdditive(prev, data);
    if (JSON.stringify(prev) === JSON.stringify(next) && !learnedHost) continue;

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
          ...Object.keys(typeof data === 'object' && !Array.isArray(data) ? data : {}),
        ]),
      ],
    };

    const up = sanitizeUpstreamId(contract.upstreamId || upstreamId || '_default');
    ensureServiceDirs(up);
    const cPath = serviceContractPath(up, contract.stubId || contract.id || id);
    fs.mkdirSync(path.dirname(cPath), { recursive: true });
    fs.writeFileSync(cPath, `${JSON.stringify(contract, null, 2)}\n`);

    const handlerFile = stubHandlerPath(null, up, method, contract.path);
    if (
      fs.existsSync(handlerFile) &&
      !fs.readFileSync(handlerFile, 'utf8').includes('mox:manual')
    ) {
      fs.writeFileSync(handlerFile, renderHandler(contract));
    }

    appendAudit(label, {
      command: 'capture-merge',
      taskId: opts.taskId || null,
      apiKey: contract.id || id,
      summary: learnedHost ? 'merged capture + learned host alias' : 'merged capture response into contract',
    });
    merged++;
  }

  if (anyLearnedHost) {
    saveUpstreams(null, upstreamsData);
  }

  if (skipped.length) {
    const report = path.join(
      reportsDir(),
      `capture-merge-skipped-${Date.now()}.json`,
    );
    fs.writeFileSync(report, `${JSON.stringify({ skipped }, null, 2)}\n`);
    console.log(
      `[mox] capture-merge skipped=${skipped.length} (see ${report})`,
    );
  }
  console.log(`[mox] capture-merge merged=${merged}`);
  return { merged, skipped };
}

module.exports = { captureMerge, mergeDataAdditive, deepMergeShape };

if (require.main === module) {
  captureMerge({});
}
