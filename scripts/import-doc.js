'use strict';

/**
 * Import wiki/doc Markdown as a third Observation source → shared merge/derive.
 * Usage: mox import-doc --from=<url|path> | --file=<path> [--name=] [--task=] [--llm]
 */

const fs = require('fs');
const path = require('path');
const {
  ensureDataDirs,
  reportsDir,
  resolveScanLabel,
  stubId: makeStubId,
  sanitizeUpstreamId,
  ensureServiceDirs,
  serviceContractPath,
  stubHandlerPath,
} = require('../lib/paths');
const { appendAudit } = require('../lib/audit');
const { fetchDoc } = require('../lib/doc-source/fetch');
const { extractEndpoints } = require('../lib/doc-source/extract');
const { observationFromDoc } = require('../lib/virtual-service/observation');
const {
  renderHandler,
  loadExistingContracts,
  isCaptureBacked,
} = require('./generate-mock');
const { mergeDataAdditive, deepMergeShape } = require('./capture-merge');
const { classifyFidelity } = require('../lib/gap-taxonomy');
const { upsertServiceRules } = require('../lib/catalog-merge');
const { resolveServiceIdFromHost } = require('../lib/resolve-service-id-from-host');
const {
  deriveAndMaterializeVirtualService,
} = require('../lib/virtual-service/derive');
const { resolveUpstreamId, normalizeHostLabel } = require('../lib/upstream');

function buildWikiContract({ upstreamId, method, path: urlPath, host, data, id, taskId }) {
  const shape = deepMergeShape({ type: 'object', props: {} }, data);
  const contract = {
    id,
    stubId: id,
    upstreamId,
    hosts: host && host !== '_default' ? [host] : [],
    method: [method],
    path: urlPath.startsWith('/') ? urlPath : `/${urlPath}`,
    source: 'wiki',
    role: 'dependency',
    relatedToTask: Boolean(taskId),
    confidence: 'medium',
    lastTaskId: taskId || null,
    history: [
      {
        taskId: taskId || null,
        role: 'dependency',
        at: new Date().toISOString(),
        action: 'import-from-doc',
      },
    ],
    request: { query: {}, body: {}, headers: [] },
    response: {
      envelope: { code: 'number', data: 'object|null', message: 'string' },
      source: 'wiki',
      shape,
    },
    cases: [
      {
        id: 'success',
        response: { code: 0, data, message: '' },
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
      request: { keysFound: [], confidence: 'low' },
      response: {
        confidence: 'medium',
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

function applyWikiToContract(contract, data) {
  if (isCaptureBacked(contract)) {
    return { ok: false, reason: 'capture_wins' };
  }
  const success = contract.cases?.find((c) => c.id === 'success');
  if (!success) return { ok: false, reason: 'no_success_case' };
  const prev = success.response?.data;
  const next = mergeDataAdditive(prev, data);
  if (JSON.stringify(prev) === JSON.stringify(next)) {
    return { ok: false, reason: 'noop_unchanged' };
  }
  success.response = success.response || {};
  success.response.data = next;
  contract.response = contract.response || {};
  if (!String(contract.response.source || '').includes('capture')) {
    contract.response.source = 'wiki';
  }
  contract.response.shape = deepMergeShape(
    contract.response.shape || { type: 'object', props: {} },
    data,
  );
  contract.source = contract.source || 'wiki';
  contract.history = [
    ...(contract.history || []),
    {
      taskId: null,
      role: contract.role || 'dependency',
      at: new Date().toISOString(),
      action: 'merge-from-doc',
    },
  ].slice(-50);
  contract.fidelity = classifyFidelity(contract);
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
    if (
      !src.includes('mox:manual') &&
      !src.includes('protocol=paginated-list')
    ) {
      fs.writeFileSync(handlerFile, renderHandler(contract));
    }
  } else if (createHandler !== false) {
    fs.mkdirSync(path.dirname(handlerFile), { recursive: true });
    fs.writeFileSync(handlerFile, renderHandler(contract));
  }
  return cPath;
}

function resolveUpstreamForEndpoint(ep, nameOverride) {
  let name = nameOverride;
  if (Array.isArray(name)) {
    name = name.find((x) => x != null && x !== true && String(x).trim()) || null;
  }
  if (name) {
    return sanitizeUpstreamId(String(name));
  }
  const host = ep.host;
  if (host) {
    const fromMap = resolveServiceIdFromHost(host, {});
    if (fromMap) return fromMap;
    return (
      resolveUpstreamId({ hosts: [host] }) ||
      normalizeHostLabel(host) ||
      '_default'
    );
  }
  return '_default';
}

/**
 * @param {object} opts
 */
function importDoc(opts = {}) {
  if (opts.llm || opts['llm']) {
    throw new Error(
      '--llm is not implemented yet (phase 1 is deterministic extract only)',
    );
  }

  ensureDataDirs();
  const projectDir = path.resolve(opts.projectDir || process.cwd());
  const scanLabel = resolveScanLabel(projectDir, opts.name);
  const taskId = opts.taskId || opts.task || null;

  const fetched = fetchDoc({
    from: opts.from || null,
    file: opts.file || null,
    projectDir,
    env: opts.env || process.env,
    slug: opts.slug || null,
  });

  const endpoints = extractEndpoints(fetched.markdown);
  const contracts = loadExistingContracts();
  const skipped = [];
  const skippedByReason = {};
  let created = 0;
  let upgraded = 0;
  /** @type {Map<string, { upstreamId: string, method: string, path: string, observations: object[], contract: object|null }>} */
  const vsBucket = new Map();

  const pushSkip = (row) => {
    skipped.push(row);
    const r = row.reason || 'unknown';
    skippedByReason[r] = (skippedByReason[r] || 0) + 1;
  };

  const rememberObs = (stubKey, upstreamId, method, urlPath, contract, obs) => {
    if (!stubKey || !obs) return;
    obs.stubId = stubKey;
    if (!vsBucket.has(stubKey)) {
      vsBucket.set(stubKey, {
        upstreamId,
        method,
        path: urlPath,
        observations: [],
        contract,
      });
    }
    const bucket = vsBucket.get(stubKey);
    bucket.observations.push(obs);
    if (contract) bucket.contract = contract;
    bucket.upstreamId = upstreamId || bucket.upstreamId;
  };

  for (const ep of endpoints) {
    const obs = observationFromDoc(ep);
    if (!obs) {
      pushSkip({ reason: 'invalid_endpoint', path: ep.path, method: ep.method });
      continue;
    }
    const data = obs.data;
    if (data == null) {
      pushSkip({
        reason: 'null_data',
        path: obs.path,
        method: obs.method,
      });
      continue;
    }

    const method = obs.method;
    const urlPath = obs.path;
    const host = obs.host;
    const upstreamId = resolveUpstreamForEndpoint(ep, opts.name);
    const id = makeStubId({ upstreamId, method, path: urlPath });
    let contract = contracts.get(id) || null;

    if (contract && isCaptureBacked(contract)) {
      pushSkip({
        reason: 'capture_wins',
        stubId: id,
        path: urlPath,
        method,
      });
      continue;
    }

    if (!contract) {
      contract = buildWikiContract({
        upstreamId,
        method,
        path: urlPath,
        host,
        data,
        id,
        taskId,
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
      created += 1;
      rememberObs(id, upstreamId, method, urlPath, contract, obs);
      appendAudit(scanLabel, {
        command: 'import-doc',
        taskId,
        apiKey: id,
        summary: `created from doc slug=${fetched.slug}`,
      });
      continue;
    }

    const applied = applyWikiToContract(contract, data);
    if (!applied.ok) {
      pushSkip({
        reason: applied.reason,
        stubId: id,
        path: urlPath,
        method,
      });
      if (applied.reason === 'noop_unchanged') {
        rememberObs(id, upstreamId, method, urlPath, contract, obs);
      }
      continue;
    }

    persistContractAndHandler(contract, upstreamId, method, {
      createHandler: true,
    });
    rememberObs(id, upstreamId, method, urlPath, contract, obs);
    upgraded += 1;
    appendAudit(scanLabel, {
      command: 'import-doc',
      taskId,
      apiKey: id,
      summary: `merged wiki into contract slug=${fetched.slug}`,
    });
  }

  let vsDerived = 0;
  const contractOnly = [];
  for (const [stubKey, bucket] of vsBucket) {
    const contract = bucket.contract || contracts.get(stubKey) || null;
    const derived = deriveAndMaterializeVirtualService({
      observations: bucket.observations,
      contract,
      upstreamId: bucket.upstreamId,
      stubId: stubKey,
      method: bucket.method,
      path: bucket.path,
    });
    if (!derived.ok) continue;
    vsDerived += 1;
    if (derived.manualSkipped) {
      contractOnly.push(stubKey);
      pushSkip({
        reason: 'handler_manual_skipped',
        stubId: stubKey,
        path: bucket.path,
        method: bucket.method,
      });
    }
  }

  const reportPayload = {
    command: 'import-doc',
    slug: fetched.slug,
    indexPath: fetched.indexPath,
    fetcher: fetched.fetcher,
    extracted: endpoints.length,
    created,
    upgraded,
    vs_derived: vsDerived,
    contract_only: contractOnly,
    skipped,
    skippedByReason,
  };
  const report = path.join(reportsDir(), `doc-import-${Date.now()}.json`);
  fs.writeFileSync(report, `${JSON.stringify(reportPayload, null, 2)}\n`);

  appendAudit(scanLabel, {
    command: 'import-doc',
    taskId,
    summary: `slug=${fetched.slug} extracted=${endpoints.length} created=${created} upgraded=${upgraded}`,
  });

  console.log(
    `[mox] import-doc extracted=${endpoints.length} created=${created} upgraded=${upgraded} vs_derived=${vsDerived}`,
  );
  console.log(`[mox] snapshot ${fetched.indexPath}`);
  console.log(`[mox] report ${report}`);

  return {
    ...reportPayload,
    report,
    projectSlug: scanLabel,
  };
}

module.exports = {
  importDoc,
  buildWikiContract,
  applyWikiToContract,
};

if (require.main === module) {
  const from = process.argv.find((a) => a.startsWith('--from='))?.slice(7);
  const file = process.argv.find((a) => a.startsWith('--file='))?.slice(7);
  importDoc({ from, file, projectDir: process.cwd() });
}
