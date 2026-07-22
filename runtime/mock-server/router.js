'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { resolveCase, pickCase, isDescriptor } = require('../../lib/case-resolve');
const { emptyMockGate } = require('../../lib/empty-mock');
const { normalizeProxyMode } = require('../../lib/capture-filter');
const { findCaptureResponse } = require('../../lib/serve-capture-if-empty');

/**
 * Ensure candidate path stays inside mocksRoot (no path traversal).
 * @param {string} mocksRoot
 * @param {string} candidate
 * @returns {string|null} resolved absolute path or null if outside jail
 */
function jailPath(mocksRoot, candidate) {
  const root = path.resolve(mocksRoot);
  const resolved = path.resolve(candidate);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved === root || resolved.startsWith(prefix)) return resolved;
  return null;
}

/**
 * Reject path segments that enable traversal or absolute escapes.
 * @param {string} relative
 */
function isUnsafeRelative(relative) {
  if (!relative) return false;
  if (path.isAbsolute(relative)) return true;
  const parts = relative.split(/[/\\]/);
  return parts.some((p) => p === '..' || p === '');
}

/**
 * Resolve handler file under mocksRoot with path jail.
 * Exported for unit tests.
 *
 * Checks both layouts:
 * 1. New stub catalog: mocks/<upstreamId>/<METHOD>/<path>/index.js
 * 2. Old FQDN layout: mocks/<host>/<path>/index.js
 */
function resolveHandlerFile(mocksRoot, urlPath, hostHeader) {
  const clean = urlPath.replace(/\/+$/, '') || '/';
  const relative = clean.replace(/^\//, '');
  if (isUnsafeRelative(relative)) return null;

  const root = path.resolve(mocksRoot);
  const candidates = [];

  // New stub catalog layout: derive upstreamId from host label
  if (hostHeader) {
    const rawHost = String(hostHeader).split(':')[0];
    const { normalizeHostLabel } = require('../../lib/upstream');
    const upId = normalizeHostLabel(rawHost);
    if (upId && upId !== 'default' && !upId.includes('..')) {
      // We don't know METHOD here (router.all handles all methods);
      // check all common methods
      for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        candidates.push(path.join(root, upId, m, relative, 'index.js'));
      }
    }
  }

  // Old FQDN layout
  if (hostHeader) {
    const host = String(hostHeader).split(':')[0].replace(/[^a-zA-Z0-9._-]+/g, '_');
    if (host && !host.includes('..')) {
      candidates.push(path.join(root, host, relative, 'index.js'));
      candidates.push(path.join(root, host.replace(/\./g, '_'), relative, 'index.js'));
    }
  }
  candidates.push(path.join(root, '_default', relative, 'index.js'));
  candidates.push(path.join(root, relative, 'index.js'));

  for (const file of candidates) {
    const jailed = jailPath(root, file);
    if (!jailed) continue;
    if (fs.existsSync(jailed)) return jailed;
  }
  return null;
}

/**
 * Resolve a stub handler file by upstream identity (new catalog layout).
 *
 * Primary path (proxy traffic with stub header):
 *   1. Read x-mock-stub-id → parse METHOD / upstreamId / pathname
 *      → mocks/<upstreamId>/<METHOD>/<cleanPath>/index.js
 *   2. Not found → null (404)
 *
 * Direct mock port (no proxy, no stub header):
 *   1. Read x-forwarded-host → hostToUpstream(host) + req.method + req.path
 *      → mocks/<upstreamId>/<METHOD>/<cleanPath>/index.js
 *   2. Host not registered → null (404)
 *
 * @param {string} mocksRoot
 * @param {{ stubId?: string|null, method?: string, urlPath?: string, upstreamId?: string|null, forwardedHost?: string|null, hostToUpstream?: ((host: string) => string|null) }} ctx
 * @returns {string|null}
 */
function resolveStubHandlerFile(mocksRoot, ctx = {}) {
  const { stubId, method, urlPath, upstreamId, forwardedHost, hostToUpstream, resolveMocksRoot } =
    ctx;

  // Primary: stub header from proxy
  if (stubId) {
    let parsed;
    let decoded = stubId;
    try {
      decoded = decodeURIComponent(stubId);
      const { parseStubId } = require('../../lib/paths');
      parsed = parseStubId(decoded);
    } catch {
      return null;
    }
    let root = path.resolve(mocksRoot);
    if (typeof resolveMocksRoot === 'function') {
      const alt = resolveMocksRoot(decoded);
      if (alt) root = path.resolve(alt);
    }
    const up = (parsed.upstreamId || '').replace(/[^a-zA-Z0-9._-]+/g, '_');
    const m = (parsed.method || method || 'GET').toUpperCase();
    const relative = String(parsed.path || urlPath || '').replace(/^\//, '');
    if (isUnsafeRelative(relative)) return null;
    // Service catalog: mocksRoot = services/<up>/mocks → METHOD/path
    // Legacy project: mocksRoot = projects/<slug>/mocks → upstreamId/METHOD/path
    const candidates = [
      path.join(root, m, relative, 'index.js'),
      path.join(root, up, m, relative, 'index.js'),
    ];
    for (const file of candidates) {
      const jailed = jailPath(root, file);
      if (jailed && fs.existsSync(jailed)) return jailed;
    }
    return null;
  }
  const root = path.resolve(mocksRoot);

  // Direct: host → upstream mapping
  if (forwardedHost && typeof hostToUpstream === 'function') {
    const up = hostToUpstream(forwardedHost);
    if (!up) return null;
    const cleanUp = up.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const m = (method || 'GET').toUpperCase();
    const relative = String(urlPath || '').replace(/^\//, '');
    if (isUnsafeRelative(relative)) return null;
    const candidates = [
      path.join(root, m, relative, 'index.js'),
      path.join(root, cleanUp, m, relative, 'index.js'),
    ];
    for (const file of candidates) {
      const jailed = jailPath(root, file);
      if (jailed && fs.existsSync(jailed)) return jailed;
    }
    return null;
  }

  return null;
}

/** mtime-based require cache: only reload when file changes */
const handlerCache = new Map(); // filePath -> { mtimeMs, mod }

function loadHandler(filePath) {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
  const cached = handlerCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.mod;

  try {
    delete require.cache[require.resolve(filePath)];
  } catch (_) {
    /* ignore */
  }
  const mod = require(filePath);
  handlerCache.set(filePath, { mtimeMs, mod });
  return mod;
}

/** @internal test helper */
function clearHandlerCache() {
  handlerCache.clear();
}

function sendPlan(res, plan, gateOpts = {}) {
  if (plan.fault === 'reset') {
    res.destroy();
    return;
  }
  if (plan.fault === 'hang') {
    // do not write anything; let client timeout
    return;
  }
  const gated = emptyMockGate(plan, gateOpts);
  if (gated.block) {
    if (gateOpts.serveCaptureIfEmpty && gateOpts.capturesDir) {
      const hit = findCaptureResponse(gateOpts.capturesDir, {
        host: gateOpts.host,
        path: gateOpts.path,
        method: gateOpts.method,
      });
      if (hit) {
        res.status(hit.status).json(hit.body);
        return;
      }
    }
    res.status(gated.status).json(gated.body);
    return;
  }
  const status = plan.httpStatus > 0 ? plan.httpStatus : 200;
  if (plan.body === undefined || plan.body === null) {
    res.status(status).end();
    return;
  }
  res.status(status).json(plan.body);
}

function createRouter({
  mocksRoot,
  caseHeader,
  resolveMocksRoot = null,
  mode = 'mock-lab',
  serveCaptureIfEmpty = false,
  capturesDir = null,
}) {
  const router = express.Router();
  const resolvedMode = normalizeProxyMode(mode);
  const serveCap = Boolean(serveCaptureIfEmpty);

  const handler = async (req, res) => {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const stubIdHeader = req.headers['x-mock-stub-id'] || null;
    let filePath;
    if (stubIdHeader) {
      filePath = resolveStubHandlerFile(mocksRoot, {
        stubId: stubIdHeader,
        method: req.method,
        urlPath: req.path,
        resolveMocksRoot,
      });
    } else {
      filePath = resolveHandlerFile(mocksRoot, req.path, host);
    }

    if (!filePath) {
      res.status(404).json({
        code: 404,
        message: `no mock handler for ${req.method} ${req.path}`,
        data: null,
      });
      return;
    }

    let delayTimer = null;
    const clearDelay = () => {
      if (delayTimer) {
        clearTimeout(delayTimer);
        delayTimer = null;
      }
    };
    req.on('close', clearDelay);

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (/^\s*{[\s\S]*}\s*$/.test(raw)) {
        // static JSON file (legacy)
        res.json(JSON.parse(raw));
        return;
      }
      const fn = loadHandler(filePath);
      if (typeof fn !== 'function') {
        res.status(500).json({
          code: 500,
          message: 'mock handler is not a function',
          data: null,
        });
        return;
      }
      const mockCase =
        req.headers[caseHeader] ||
        req.query.__mockCase ||
        req.query.mockCase;

      let upstreamId = null;
      let stubIdDecoded = stubIdHeader ? String(stubIdHeader) : null;
      if (stubIdDecoded) {
        try {
          stubIdDecoded = decodeURIComponent(stubIdDecoded);
          const { parseStubId } = require('../../lib/paths');
          upstreamId = parseStubId(stubIdDecoded).upstreamId;
        } catch {
          /* ignore */
        }
      }

      const { getStore, appendJournal } = require('../../lib/service-store');
      const store = getStore(upstreamId || '_default');
      appendJournal({
        stubId: stubIdDecoded,
        method: req.method,
        path: req.path,
        upstreamId: upstreamId || '_default',
      });

      const result = await fn({
        method: req.method,
        query: req.query,
        params: req.params,
        body: req.body,
        headers: req.headers,
        path: req.path,
        caseId: mockCase,
        store,
        upstreamId: upstreamId || '_default',
        stubId: stubIdDecoded,
      });

      // Legacy: handler returned a plain envelope body. Default 200, no delay/fault.
      // New: handler may return a descriptor { httpStatus, body, delayMs, fault } or a cases map + active caseId.
      let plan;
      if (isDescriptor(result)) {
        plan = resolveCase(mockCase, result);
      } else if (
        result &&
        typeof result === 'object' &&
        !Array.isArray(result) &&
        result.cases &&
        typeof result.cases === 'object'
      ) {
        const entry = pickCase(result.cases, mockCase || result.defaultCase || 'success');
        plan = resolveCase(mockCase || result.defaultCase || 'success', entry);
      } else {
        plan = resolveCase(mockCase, { response: result });
      }

      const gateOpts = {
        mode: resolvedMode,
        serveCaptureIfEmpty: serveCap,
        capturesDir,
        host: String(host).split(':')[0],
        path: req.path,
        method: req.method,
      };
      if (plan.delayMs && plan.delayMs > 0) {
        delayTimer = setTimeout(() => {
          delayTimer = null;
          if (!res.headersSent && !res.writableEnded) {
            sendPlan(res, plan, gateOpts);
          }
        }, plan.delayMs);
      } else {
        sendPlan(res, plan, gateOpts);
      }
    } catch (err) {
      clearDelay();
      if (!res.headersSent) {
        res.status(500).json({
          code: 500,
          message: err.message,
          data: null,
        });
      }
    }
  };

  router.all('/*', handler);
  return router;
}

module.exports = createRouter;
module.exports.resolveHandlerFile = resolveHandlerFile;
module.exports.resolveStubHandlerFile = resolveStubHandlerFile;
module.exports.jailPath = jailPath;
module.exports.clearHandlerCache = clearHandlerCache;
module.exports.loadHandler = loadHandler;
