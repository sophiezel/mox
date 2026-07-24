'use strict';

/**
 * Shared Virtual Service derive + materialize (init and capture-merge).
 */

const fs = require('fs');
const path = require('path');
const {
  ensureServiceDirs,
  serviceDataDir,
  serviceContractPath,
  stubHandlerPath,
  sanitizeUpstreamId,
  parseStubId,
} = require('../paths');
const { upsertSeedRows } = require('./seed-store');
const {
  detectPaginatedList,
  extractListRows,
  resourceNameFromStub,
  renderPaginatedListHandler,
} = require('./protocols/paginated-list');
const { inferOperatorsFromObservations } = require('./evidence-ops');
const { classifyFidelity } = require('../gap-taxonomy');

function protocolPath(upstreamId, resource) {
  return path.join(
    serviceDataDir(upstreamId),
    'protocols',
    `${resource}.json`,
  );
}

function pickSnapshotSuccess(observations, envelope) {
  const listKey = envelope?.listKey || 'detail';
  const pageKey = envelope?.pageKey || 'page';
  const ranked = [...(observations || [])].filter(
    (o) => o?.data && typeof o.data === 'object' && !Array.isArray(o.data),
  );
  ranked.sort((a, b) => {
    const pa = Number(a.data[pageKey] ?? a.requestBody?.[pageKey] ?? 99);
    const pb = Number(b.data[pageKey] ?? b.requestBody?.[pageKey] ?? 99);
    const la = Array.isArray(a.data[listKey]) ? a.data[listKey].length : 0;
    const lb = Array.isArray(b.data[listKey]) ? b.data[listKey].length : 0;
    if (pa !== pb) return pa - pb;
    return lb - la;
  });
  const best = ranked[0];
  if (!best) {
    return { code: 0, data: { [listKey]: [], [envelope?.totalKey || 'totalNum']: 0 }, message: '' };
  }
  const body = best.responseBody;
  if (body && typeof body === 'object' && body.data !== undefined) {
    return {
      code: body.code != null ? body.code : 0,
      data: body.data,
      message: body.message != null ? body.message : '',
    };
  }
  return { code: 0, data: best.data, message: '' };
}

/**
 * @param {{
 *   observations: object[],
 *   contract?: object,
 *   upstreamId: string,
 *   stubId?: string,
 *   method?: string,
 *   path?: string,
 *   force?: boolean,
 * }} opts
 * @returns {{ ok: boolean, reason?: string, protocol?: string, resource?: string, manualSkipped?: boolean, seeded?: number }}
 */
function deriveAndMaterializeVirtualService(opts = {}) {
  const observations = opts.observations || [];
  const upstreamId = sanitizeUpstreamId(opts.upstreamId || '_default');
  const detected = detectPaginatedList(observations);
  if (!detected) {
    return { ok: false, reason: 'no_protocol' };
  }

  const stubId =
    opts.stubId ||
    opts.contract?.stubId ||
    opts.contract?.id ||
    observations.find((o) => o.stubId)?.stubId ||
    null;
  const resource = resourceNameFromStub(
    stubId || `${opts.method || 'GET'} ${opts.path || 'items'}`,
  );
  const envelope = detected.envelope;
  const rows = extractListRows(observations, envelope);
  if (rows.length) {
    upsertSeedRows(upstreamId, resource, rows);
  }

  const operators = inferOperatorsFromObservations(observations, envelope);
  const snapshotSuccess = pickSnapshotSuccess(observations, envelope);

  const profile = {
    version: 1,
    protocol: 'paginated-list',
    stubId,
    resource,
    envelope,
    operators,
    updatedAt: new Date().toISOString(),
  };
  ensureServiceDirs(upstreamId);
  const pDir = path.dirname(protocolPath(upstreamId, resource));
  fs.mkdirSync(pDir, { recursive: true });
  fs.writeFileSync(
    protocolPath(upstreamId, resource),
    `${JSON.stringify(profile, null, 2)}\n`,
  );

  let contract = opts.contract;
  if (contract) {
    const success = (contract.cases || []).find((c) => c.id === 'success');
    if (success) {
      success.response = {
        ...(success.response || {}),
        ...snapshotSuccess,
      };
    }
    contract.response = contract.response || {};
    contract.response.source = 'usage+capture';
    contract.virtualService = {
      protocol: 'paginated-list',
      resource,
    };
    contract.fidelity = classifyFidelity(contract);
    const id = contract.stubId || contract.id;
    if (id) {
      const cPath = serviceContractPath(upstreamId, id);
      fs.mkdirSync(path.dirname(cPath), { recursive: true });
      fs.writeFileSync(cPath, `${JSON.stringify(contract, null, 2)}\n`);
    }
  }

  let method = opts.method;
  let urlPath = opts.path;
  if ((!method || !urlPath) && stubId) {
    try {
      const parsed = parseStubId(stubId);
      method = method || parsed.method;
      urlPath = urlPath || parsed.path;
    } catch {
      /* ignore */
    }
  }
  method = (method || 'GET').toUpperCase();
  urlPath = urlPath || '/';

  const handlerFile = stubHandlerPath(null, upstreamId, method, urlPath);
  let manualSkipped = false;
  if (fs.existsSync(handlerFile)) {
    const prev = fs.readFileSync(handlerFile, 'utf8');
    if (prev.includes('mox:manual') && !opts.force) {
      manualSkipped = true;
    } else {
      fs.writeFileSync(
        handlerFile,
        renderPaginatedListHandler({
          stubId: stubId || `${method} ${urlPath}`,
          resource,
          envelope,
          operators,
          snapshotSuccess,
        }),
      );
    }
  } else {
    fs.mkdirSync(path.dirname(handlerFile), { recursive: true });
    fs.writeFileSync(
      handlerFile,
      renderPaginatedListHandler({
        stubId: stubId || `${method} ${urlPath}`,
        resource,
        envelope,
        operators,
        snapshotSuccess,
      }),
    );
  }

  return {
    ok: true,
    protocol: 'paginated-list',
    resource,
    manualSkipped,
    seeded: rows.length,
    operators,
  };
}

module.exports = {
  deriveAndMaterializeVirtualService,
  pickSnapshotSuccess,
  protocolPath,
};
