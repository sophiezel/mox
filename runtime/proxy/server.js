'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const { applyCorsHeaders, handleOptions } = require('../../lib/cors');
const {
  matchRule,
  matchPassthroughHost,
  hostCoveredByRules,
  defaultPortForScheme,
  parseAuthority,
} = require('../../lib/match-rule');
const {
  shouldMock,
  trafficPassthroughReason,
  normalizeTrafficMode,
} = require('../../lib/traffic-mode');
const { forceCloseHttpServer } = require('../../lib/force-close-server');
const { createStatefulEngine } = require('../../lib/stateful');
const {
  shouldWriteCapture,
  normalizeCaptureScope,
  normalizeProxyMode,
} = require('../../lib/capture-filter');
const {
  decodeResponseBody,
  captureBodyFromDecoded,
} = require('../../lib/decode-response-body');
const {
  pruneCapturesDir,
  rotateAppendLog,
  resolveRetentionPolicy,
} = require('../../lib/data-retention');
const { appendUpstreamFailure } = require('../../lib/upstream-failure-journal');
const {
  enrichAccessEntry,
  formatConsoleLine,
  shouldPrintConsole,
  resolveProxyLogLevel,
  captureHasUsableBody,
} = require('../../lib/proxy-access-log');

const DEFAULT_BODY_LIMIT = 10 * 1024 * 1024; // 10mb
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

function loadRules(rulesPath) {
  if (!rulesPath || !fs.existsSync(rulesPath)) return [];
  return JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
}

function readBody(req, { limit = DEFAULT_BODY_LIMIT } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new Error(`request body exceeds limit (${limit} bytes)`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isLanBind(host) {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

function isLoopbackBind(host) {
  return (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]'
  );
}

/** CONNECT / request target hostname is loopback (local HTTP/HTTPS origin). */
function isLoopbackHostname(hostname) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return (
    h === '127.0.0.1' ||
    h === 'localhost' ||
    h === '::1' ||
    h === '0.0.0.0'
  );
}

/**
 * Start forward proxy + optional HTTPS MITM for matched hosts.
 *
 * Security defaults:
 * - CONNECT MITM when --mitm and hostname is covered by rule hosts[]
 * - CONNECT to loopback targets always denied (local HTTP dev servers)
 * - CONNECT tunnel on loopback bind for non-covered remote hosts (CDN etc.)
 * - On 0.0.0.0 without allowOpenProxy: tunnel only passthroughHosts
 * - Body size limited; upstream timeout applied
 */
function startProxyServer(opts) {
  const {
    host = '127.0.0.1',
    port = 18999,
    mockTarget = 'http://127.0.0.1:3900',
    rules = [],
    rulesPath,
    cors = {},
    cases = { default: 'success', active: {} },
    casesLoader = null,
    /** optional () => stateful config from session */
    statefulLoader = null,
    caseHeader = 'x-mock-case',
    missPolicy = 'passthrough',
    blockWritePassthrough = true,
    passthroughHosts = [],
    recordMisses = true,
    recordMockHits = false,
    /** catalog = only hosts covered by rules; all = any miss (noise denylist still applies) */
    captureScope = 'catalog',
    /** mock-lab | capture-open */
    mode = 'mock-lab',
    /** capture-open: hosts eligible for MITM without path rule */
    captureMitmHosts = [],
    /** optional extra noise suffixes merged with defaults */
    captureNoiseSuffixes = [],
    capturesDir,
    /** optional (rec|{stubId,host}|stubId) => captures dir */
    resolveCapturesDir = null,
    taskId = null,
    accessLogPath,
    allowOpenProxy = false,
    bodyLimit = DEFAULT_BODY_LIMIT,
    upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
    rejectUnauthorized = true,
    /** Optional MITM: { enabled, getSecureContext(hostname) -> tls.SecureContext } */
    mitm = null,
    trafficMode = 'all-mock',
    mockAllowlist = [],
    /** optional () => ({ trafficMode, mockAllowlist }) from session */
    trafficLoader = null,
    /** optional () => rules[] from mergeCatalogs (hot-reload like trafficLoader) */
    rulesLoader = null,
    /** console access level: summary | verbose | silent (CLI --proxy-log / MOX_PROXY_LOG) */
    proxyLogLevel = undefined,
    /** session.dataRetention — captures prune + access log rotate */
    dataRetention = null,
    /**
     * Device hub / PAC public base: { lanIp, port }
     * When missing, derive from request Host header.
     */
    deviceSetup = null,
    /**
     * On-demand page mock: { enabled, scanDir, timeoutMs, getMergedRules }
     */
    onDemand = null,
  } = opts;

  let activeRules = rules.length ? rules : loadRules(rulesPath);
  let activeCases = { ...cases };
  let casesCacheAt = 0;
  const CASES_TTL_MS = 1000;
  let activeTraffic = {
    trafficMode: normalizeTrafficMode(trafficMode),
    mockAllowlist: Array.isArray(mockAllowlist) ? [...mockAllowlist] : [],
  };
  let trafficCacheAt = 0;
  let rulesCacheAt = 0;
  let statefulEngine = null;
  let statefulFingerprint = '';

  function currentStateful() {
    if (!statefulLoader) return null;
    const cfg = statefulLoader() || null;
    const fp = JSON.stringify(cfg || null);
    if (fp !== statefulFingerprint) {
      statefulFingerprint = fp;
      statefulEngine = cfg ? createStatefulEngine(cfg) : null;
    }
    return statefulEngine;
  }

  function resolveCaseId(cs, rule, method, hostname, urlPath) {
    const engine = currentStateful();
    const keys = [
      rule.stubId || rule.id,
      rule.id,
    ];
    if (engine) {
      for (const k of keys) {
        const picked = engine.pick(k);
        if (picked) return picked;
      }
    }
    return (
      cs.active?.[rule.stubId] ||
      cs.active?.[rule.id] ||
      cs.default ||
      'success'
    );
  }

  const forcedMissPolicy =
    isLanBind(host) && !allowOpenProxy && missPolicy === 'passthrough'
      ? 'reject'
      : missPolicy;

  if (isLanBind(host) && !allowOpenProxy) {
    console.warn(
      '[proxy] WARNING: bound to all interfaces with allowOpenProxy=false (--no-open-proxy); missPolicy forced to reject; CONNECT denied except passthroughHosts',
    );
  }

  function currentCases() {
    if (!casesLoader) return activeCases;
    const now = Date.now();
    if (now - casesCacheAt > CASES_TTL_MS) {
      activeCases = { ...casesLoader() };
      casesCacheAt = now;
    }
    return activeCases;
  }

  function currentTraffic() {
    if (!trafficLoader) return activeTraffic;
    const now = Date.now();
    if (now - trafficCacheAt > CASES_TTL_MS) {
      const live = trafficLoader() || {};
      activeTraffic = {
        trafficMode: normalizeTrafficMode(live.trafficMode || 'all-mock'),
        mockAllowlist: Array.isArray(live.mockAllowlist)
          ? [...live.mockAllowlist]
          : [],
      };
      trafficCacheAt = now;
    }
    return activeTraffic;
  }

  function currentRules() {
    if (!rulesLoader) return activeRules;
    const now = Date.now();
    if (now - rulesCacheAt > CASES_TTL_MS) {
      const live = rulesLoader();
      if (Array.isArray(live)) {
        activeRules = live;
      }
      rulesCacheAt = now;
    }
    return activeRules;
  }

  const mockUrl = new URL(mockTarget);
  const accessLogLevel = resolveProxyLogLevel(proxyLogLevel);
  const retention = resolveRetentionPolicy(dataRetention);
  let accessAppendCount = 0;

  function logAccess(entry) {
    const enriched = enrichAccessEntry(entry);
    const line = JSON.stringify({
      at: new Date().toISOString(),
      taskId,
      ...enriched,
    });
    if (accessLogPath) {
      fs.mkdirSync(path.dirname(accessLogPath), { recursive: true });
      fs.appendFile(accessLogPath, `${line}\n`, () => {
        accessAppendCount += 1;
        if (accessAppendCount % 32 === 0) {
          try {
            rotateAppendLog(accessLogPath, {
              maxBytes: retention.appendLogs.maxBytes,
              keepRotated: retention.appendLogs.keepRotated,
            });
          } catch {
            /* ignore rotate errors on hot path */
          }
        }
      });
    }
    if (shouldPrintConsole(enriched, accessLogLevel)) {
      console.log(formatConsoleLine(enriched));
    }
  }

  const resolvedCaptureScope = normalizeCaptureScope(captureScope);
  const resolvedProxyMode = normalizeProxyMode(mode);

  function recordCapture(rec) {
    let dir = capturesDir;
    if (typeof resolveCapturesDir === 'function') {
      const resolved = resolveCapturesDir(rec);
      if (resolved == null) return;
      dir = resolved;
    }
    if (!dir) return;
    if (
      !shouldWriteCapture({
        host: rec.host,
        reason: rec.reason,
        rules: currentRules(),
        captureScope: resolvedCaptureScope,
        recordMisses,
        recordMockHits,
        captureNoiseSuffixes,
        mode: rec.mode || resolvedProxyMode,
        mitmPlaintext: Boolean(rec.mitmPlaintext),
      })
    ) {
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${(rec.host || 'h').replace(/\W/g, '_')}-${rec.path
      .replace(/\W/g, '_')
      .slice(0, 80)}.json`;
    const file = path.join(dir, name);
    fs.writeFile(file, `${JSON.stringify(rec, null, 2)}\n`, (err) => {
      if (!err && captureHasUsableBody(rec)) {
        const pathPart = rec.path || '';
        const url =
          rec.url ||
          `${rec.mitmPlaintext ? 'https' : 'http'}://${rec.host || ''}${pathPart}`;
        logAccess({
          action: 'capture',
          method: rec.method,
          url,
          host: rec.host,
          mode: rec.mode || resolvedProxyMode,
        });
      }
      try {
        pruneCapturesDir(dir, retention.captures);
      } catch {
        /* ignore prune errors on hot path */
      }
    });
  }

  function isPassthroughHost(hostname, port = null) {
    return matchPassthroughHost(passthroughHosts, hostname, port);
  }

  function allowConnectTunnel(hostname, port = null) {
    // Never tunnel CONNECT to local page origins (any browser / system proxy).
    if (isLoopbackHostname(hostname)) return false;
    if (isPassthroughHost(hostname, port)) return true;
    if (allowOpenProxy && forcedMissPolicy === 'passthrough') return true;
    // Desktop self-test: loopback-bound proxy may tunnel remote HTTPS not in catalog
    // (static CDN, maps, browser noise). LAN bind stays locked down.
    if (isLoopbackBind(host) && !isLanBind(host)) return true;
    return false;
  }

  function ruleShouldMock(rule) {
    return shouldMock(rule, currentTraffic());
  }

  const server = http.createServer(async (req, res) => {
    try {
      const rawUrl = req.url || '/';
      // Absolute-form (phone Wi‑Fi proxy): "http://LAN:18999/mox/ca.cer"
      const pathOnly = (() => {
        const noQuery = rawUrl.split('?')[0];
        if (noQuery.startsWith('http://') || noQuery.startsWith('https://')) {
          try {
            return new URL(noQuery).pathname;
          } catch (_) {
            return noQuery;
          }
        }
        return noQuery;
      })();

      function resolveDeviceUrls() {
        const {
          buildDeviceSetupUrls,
        } = require('../../lib/device-setup');
        if (deviceSetup?.lanIp) {
          return buildDeviceSetupUrls({
            lanIp: deviceSetup.lanIp,
            proxyPort: deviceSetup.port || port,
          });
        }
        const hostHdr = String(req.headers.host || '')
          .split(':')[0]
          .trim();
        const lan =
          hostHdr && hostHdr !== '0.0.0.0' && hostHdr !== '127.0.0.1'
            ? hostHdr
            : null;
        return buildDeviceSetupUrls({
          lanIp: lan,
          proxyPort: deviceSetup?.port || port,
        });
      }

      // Device setup hub + PAC (absolute URL compatible via pathOnly)
      if (
        req.method === 'GET' &&
        (pathOnly === '/mox' || pathOnly === '/mox/')
      ) {
        try {
          const {
            buildDeviceHubHtml,
            qrDataUrl,
          } = require('../../lib/device-setup');
          const urls = resolveDeviceUrls();
          const [caQrDataUrl, pacQrDataUrl] = await Promise.all([
            urls.caCer ? qrDataUrl(urls.caCer) : null,
            urls.pac ? qrDataUrl(urls.pac) : null,
          ]);
          let caFingerprint = null;
          try {
            const { ensureCa, caFingerprintShort } = require('../../lib/mitm-ca');
            caFingerprint = caFingerprintShort(ensureCa().certPath) || null;
          } catch {
            /* hub still useful without fingerprint */
          }
          const html = buildDeviceHubHtml({
            urls,
            caQrDataUrl,
            pacQrDataUrl,
            caFingerprint,
          });
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(html);
          logAccess({ action: 'mox-hub', method: 'GET', url: pathOnly });
        } catch (e) {
          res.statusCode = 503;
          res.end(JSON.stringify({ code: 503, message: e.message }));
        }
        return;
      }

      if (req.method === 'GET' && pathOnly === '/mox/proxy.pac') {
        try {
          const { buildPacScript } = require('../../lib/device-setup');
          const urls = resolveDeviceUrls();
          const pacHost = urls.lanIp || '127.0.0.1';
          const pac = buildPacScript({
            host: pacHost,
            port: urls.proxyPort || port,
          });
          res.writeHead(200, {
            'Content-Type': 'application/x-ns-proxy-autoconfig',
            'Cache-Control': 'no-store',
          });
          res.end(pac);
          logAccess({ action: 'mox-pac', method: 'GET', url: pathOnly });
        } catch (e) {
          res.statusCode = 503;
          res.end(JSON.stringify({ code: 503, message: e.message }));
        }
        return;
      }

      // Device / desktop CA download (relative or absolute URL to this proxy)
      if (
        req.method === 'GET' &&
        (pathOnly === '/mox/ca.cer' ||
          pathOnly === '/mox/ca.crt' ||
          pathOnly === '/mox/ca.pem' ||
          pathOnly === '/mox/ca.cert.pem' ||
          pathOnly === '/mox/ca-info' ||
          pathOnly === '/mox/ca-info.json' ||
          pathOnly === '/__mox__/ca.cer' ||
          pathOnly === '/__mox__/ca.crt' ||
          pathOnly === '/__mox__/ca.pem' ||
          pathOnly === '/__mox__/ca.cert.pem')
      ) {
        try {
          const {
            readCaDownloadFiles,
            caFingerprintShort,
            ensureCa,
          } = require('../../lib/mitm-ca');
          if (
            pathOnly === '/mox/ca-info' ||
            pathOnly === '/mox/ca-info.json'
          ) {
            const { certPath } = ensureCa();
            const body = JSON.stringify({
              commonName: 'mox Local MITM CA',
              fingerprintShort: caFingerprintShort(certPath),
              download: '/mox/ca.cer',
            });
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(body);
            logAccess({ action: 'mox-ca-info', method: 'GET', url: pathOnly });
            return;
          }
          const { pem, der } = readCaDownloadFiles();
          if (pathOnly.endsWith('.cer') || pathOnly.endsWith('.crt')) {
            // Whistle: .cer → application/pkix-cert; .crt → application/x-x509-ca-cert
            const type = pathOnly.endsWith('.crt')
              ? 'application/x-x509-ca-cert'
              : 'application/pkix-cert';
            const filename = pathOnly.endsWith('.crt')
              ? 'mox-rootCA.crt'
              : 'mox-rootCA.cer';
            res.writeHead(200, {
              'Content-Type': type,
              'Content-Disposition': `attachment; filename="${filename}"`,
              'Content-Length': der.length,
              'Cache-Control': 'no-store',
            });
            res.end(der);
          } else {
            res.writeHead(200, {
              'Content-Type': 'application/x-pem-file',
              'Content-Disposition': 'attachment; filename="mox-ca.pem"',
              'Content-Length': pem.length,
              'Cache-Control': 'no-store',
            });
            res.end(pem);
          }
          logAccess({ action: 'mox-ca-download', method: 'GET', url: pathOnly });
        } catch (e) {
          res.statusCode = 503;
          res.end(JSON.stringify({ code: 503, message: e.message }));
        }
        return;
      }

      if (req.method === 'OPTIONS') {
        handleOptions(req, res, cors);
        logAccess({ action: 'options', method: 'OPTIONS', url: req.url });
        return;
      }

      let target;
      if (req.url.startsWith('http://') || req.url.startsWith('https://')) {
        target = new URL(req.url);
      } else {
        const hostHeader = req.headers.host || 'localhost';
        target = new URL(`http://${hostHeader}${req.url}`);
      }

      const hostname = target.hostname;
      const reqPort =
        target.port && String(target.port)
          ? Number(target.port)
          : defaultPortForScheme(target.protocol);
      const urlPath = target.pathname;
      const method = req.method || 'GET';
      let body = Buffer.alloc(0);
      try {
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
          body = await readBody(req, { limit: bodyLimit });
        }
      } catch (e) {
        applyCorsHeaders(req, res, cors);
        res.statusCode = 413;
        res.end(JSON.stringify({ code: 413, message: e.message, data: null }));
        return;
      }

      if (isPassthroughHost(hostname, reqPort)) {
        const up = await forwardUpstream(req, res, target, body, cors, true);
        logAccess({ action: 'passthrough-host', method, url: target.href });
        recordCapture({
          host: hostname,
          path: urlPath,
          method,
          reason: 'passthrough-host',
          responseBody: up?.bodyMeta?.parseOk ? up.bodyJson : undefined,
          bodyMeta: up?.bodyMeta,
        });
        return;
      }

      const cs = currentCases();
      const rule = matchRule(currentRules(), hostname, urlPath, method, {
        query: Object.fromEntries(target.searchParams),
        headers: req.headers,
        port: reqPort,
      });
      if (rule && ruleShouldMock(rule)) {
        const caseId = resolveCaseId(cs, rule, method, hostname, urlPath);

        const headers = { ...req.headers };
        headers.host = mockUrl.host;
        headers['x-forwarded-host'] = hostname;
        headers[caseHeader] = caseId;
        if (rule.stubId) {
          headers['x-mock-stub-id'] = encodeURIComponent(rule.stubId);
        }
        if (rule.upstreamId) {
          headers['x-mock-upstream'] = rule.upstreamId;
        }
        delete headers['content-length'];

        const mockPath = urlPath + target.search;
        const mockReq = http.request(
          {
            protocol: mockUrl.protocol,
            hostname: mockUrl.hostname,
            port: mockUrl.port,
            path: mockPath,
            method,
            headers,
            timeout: upstreamTimeoutMs,
          },
          (mockRes) => {
            applyCorsHeaders(req, res, cors);
            const outHeaders = { ...mockRes.headers };
            delete outHeaders['access-control-allow-origin'];
            const chunks = [];
            mockRes.on('data', (c) => chunks.push(c));
            mockRes.on('end', () => {
              const buf = Buffer.concat(chunks);
              res.writeHead(mockRes.statusCode || 200, outHeaders);
              res.end(buf);
              if (recordMockHits) {
                const decoded = decodeResponseBody(buf, mockRes.headers || {});
                const bodyFields = captureBodyFromDecoded(decoded);
                recordCapture({
                  host: hostname,
                  path: urlPath,
                  method,
                  reason: 'mock-hit',
                  caseId,
                  stubId: rule.stubId || rule.id || null,
                  ...bodyFields,
                });
              }
            });
          },
        );
        mockReq.on('timeout', () => {
          mockReq.destroy(new Error('mock upstream timeout'));
        });
        mockReq.on('error', (e) => {
          applyCorsHeaders(req, res, cors);
          if (!res.headersSent) {
            res.statusCode = 502;
            res.end(JSON.stringify({ code: 502, message: e.message }));
          }
        });
        if (body.length) mockReq.write(body);
        mockReq.end();
        logAccess({
          action: 'mock',
          method,
          url: target.href,
          caseId,
          ruleId: rule.id,
        });
        return;
      }

      // Matched rule but trafficMode says passthrough (or no rule)
      const trafficReason = rule
        ? trafficPassthroughReason(currentTraffic().trafficMode)
        : 'miss';

      // On-demand: page-prereq miss → sync generate from frontend scanDir
      if (
        !rule &&
        onDemand?.enabled &&
        onDemand.scanDir &&
        typeof onDemand.getMergedRules === 'function'
      ) {
        try {
          const { handleOnDemandMiss } = require('../../lib/on-demand-miss');
          const od = await handleOnDemandMiss({
            scanDir: onDemand.scanDir,
            method,
            host: hostname,
            path: urlPath,
            referer: req.headers.referer || req.headers.referrer || null,
            timeoutMs: onDemand.timeoutMs || 8000,
            getMergedRules: onDemand.getMergedRules,
            reloadRules: (next) => {
              if (Array.isArray(next)) {
                activeRules = next;
                rulesCacheAt = 0;
              }
            },
          });
          if (od.action === 'gap') {
            applyCorsHeaders(req, res, cors);
            res.statusCode = 503;
            res.end(
              JSON.stringify({
                code: 503,
                message: 'on-demand mock gap; no invent fields',
                gap: od.gap || 'TRACE_EMPTY',
                data: null,
              }),
            );
            logAccess({
              action: 'on-demand-gap',
              method,
              url: target.href,
              gap: od.gap,
            });
            return;
          }
          if (od.action === 'mock') {
            const nextRule = matchRule(currentRules(), hostname, urlPath, method, {
              query: Object.fromEntries(target.searchParams),
              headers: req.headers,
              port: reqPort,
            });
            if (nextRule && ruleShouldMock(nextRule)) {
              const caseId = resolveCaseId(
                cs,
                nextRule,
                method,
                hostname,
                urlPath,
              );
              const headers = { ...req.headers };
              headers.host = mockUrl.host;
              headers['x-forwarded-host'] = hostname;
              headers[caseHeader] = caseId;
              if (nextRule.stubId) {
                headers['x-mock-stub-id'] = encodeURIComponent(nextRule.stubId);
              }
              if (nextRule.upstreamId) {
                headers['x-mock-upstream'] = nextRule.upstreamId;
              }
              delete headers['content-length'];
              const mockPath = urlPath + target.search;
              const mockReq = http.request(
                {
                  protocol: mockUrl.protocol,
                  hostname: mockUrl.hostname,
                  port: mockUrl.port,
                  path: mockPath,
                  method,
                  headers,
                  timeout: upstreamTimeoutMs,
                },
                (mockRes) => {
                  applyCorsHeaders(req, res, cors);
                  const outHeaders = { ...mockRes.headers };
                  delete outHeaders['access-control-allow-origin'];
                  const chunks = [];
                  mockRes.on('data', (c) => chunks.push(c));
                  mockRes.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    res.writeHead(mockRes.statusCode || 200, outHeaders);
                    res.end(buf);
                  });
                },
              );
              mockReq.on('timeout', () => {
                mockReq.destroy(new Error('mock upstream timeout'));
              });
              mockReq.on('error', (e) => {
                applyCorsHeaders(req, res, cors);
                if (!res.headersSent) {
                  res.statusCode = 502;
                  res.end(JSON.stringify({ code: 502, message: e.message }));
                }
              });
              if (body.length) mockReq.write(body);
              mockReq.end();
              logAccess({
                action: 'on-demand-mock',
                method,
                url: target.href,
                caseId,
                ruleId: nextRule.id,
                stubId: od.stubId,
              });
              return;
            }
            logAccess({
              action: 'on-demand-no-rule-after-gen',
              method,
              url: target.href,
            });
          }
        } catch (e) {
          console.warn(`[proxy] on-demand miss hook error: ${e.message}`);
        }
      }

      const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
      if (isWrite && blockWritePassthrough && forcedMissPolicy !== 'reject') {
        applyCorsHeaders(req, res, cors);
        res.statusCode = 403;
        res.end(
          JSON.stringify({
            code: 403,
            message: 'write passthrough blocked; add mock rule or disable blockWritePassthrough',
            data: null,
          }),
        );
        logAccess({
          action: 'block-write',
          method,
          url: target.href,
          host: hostname,
          mode: resolvedProxyMode,
        });
        recordCapture({
          host: hostname,
          path: urlPath,
          method,
          reason: 'block-write',
          mode: resolvedProxyMode,
        });
        return;
      }

      // missPolicy=reject only blocks true misses (no rule). Traffic-mode
      // passthrough of a matched rule always forwards (WireMock-style record).
      if (forcedMissPolicy === 'reject' && !rule) {
        applyCorsHeaders(req, res, cors);
        res.statusCode = 404;
        res.end(JSON.stringify({ code: 404, message: 'no mock rule', data: null }));
        logAccess({ action: 'reject', method, url: target.href });
        return;
      }

      const up = await forwardUpstream(req, res, target, body, cors, true);
      logAccess({
        action: rule ? 'traffic-passthrough' : 'passthrough',
        method,
        url: target.href,
      });
      recordCapture({
        host: hostname,
        path: urlPath,
        method,
        query: Object.fromEntries(target.searchParams),
        reason: trafficReason,
        stubId: rule?.stubId || rule?.id || null,
        responseBody: up?.bodyMeta?.parseOk ? up.bodyJson : undefined,
        bodyMeta: up?.bodyMeta,
      });
    } catch (err) {
      applyCorsHeaders(req, res, cors);
      res.statusCode = 500;
      res.end(JSON.stringify({ code: 500, message: err.message }));
    }
  });

  // CONNECT: tunnel only when allowed; optional MITM for matched HTTPS hosts
  server.on('connect', (req, clientSocket, head) => {
    const parsed = parseAuthority(req.url || '');
    // net/tls want bare IPv6 (no brackets); catalogs / URL.hostname are bare too.
    const hostname = String(parsed.hostname || '').replace(/^\[|\]$/g, '');
    const portNum =
      parsed.port != null ? Number(parsed.port) : 443;
    if (
      !Number.isInteger(portNum) ||
      portNum < 0 ||
      portNum > 65535
    ) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.end();
      logAccess({
        action: 'connect-bad-port',
        method: 'CONNECT',
        url: req.url,
      });
      return;
    }

    // Local HTTP(S) origins must bypass the proxy in the browser — never CONNECT-tunnel them.
    if (isLoopbackHostname(hostname)) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.end();
      logAccess({
        action: 'connect-deny-loopback',
        method: 'CONNECT',
        url: req.url,
        hint: 'bypass loopback in browser proxy settings; do not HTTPS-CONNECT to local HTTP dev servers',
      });
      console.warn(
        `[proxy] connect-deny CONNECT ${req.url} (loopback target — bypass localhost/127.0.0.1 in browser proxy; local HTTP pages must not use CONNECT)`,
      );
      return;
    }

    const mitmEnabled = Boolean(mitm?.enabled && typeof mitm.getSecureContext === 'function');
    // Whistle: Cronet often rejects user CAs — skip MITM and tunnel.
    const ua = String(req.headers['user-agent'] || '');
    const isCronet = /\bCronet\b/i.test(ua);
    const catalogHit = hostCoveredByRules(currentRules(), hostname, portNum);
    const captureHostHit =
      normalizeProxyMode(mode) === 'capture-open' &&
      Array.isArray(captureMitmHosts) &&
      captureMitmHosts.some((h) => {
        const pat = String(h || '')
          .trim()
          .toLowerCase();
        if (!pat) return false;
        const bare = pat.split(':')[0];
        return hostname.toLowerCase() === bare || hostname.toLowerCase().endsWith(`.${bare}`);
      });
    // Host coverage only — pathPrefix rules never match CONNECT probe path "/"
    // capture-open + captureMitmHosts: MITM without path rule (map hosts)
    const ruleHit = mitmEnabled && !isCronet && (catalogHit || captureHostHit);
    const forceCronetTunnel = Boolean(isCronet && mitmEnabled && (catalogHit || captureHostHit));

    if (mitmEnabled && ruleHit) {
      try {
        const ctx = mitm.getSecureContext(hostname);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const tlsSock = new tls.TLSSocket(clientSocket, {
          isServer: true,
          secureContext: ctx,
          ALPNProtocols: ['http/1.1'],
        });
        tlsSock.on('error', (err) => {
          logAccess({
            action: 'connect-mitm-tls-error',
            method: 'CONNECT',
            url: req.url,
            error: err && err.message,
          });
          try {
            clientSocket.end();
          } catch (_) {
            /* ignore */
          }
        });
        // Minimal MITM: after handshake, parse as HTTP and reuse createServer logic via mock hop
        tlsSock.once('secure', () => {
          const fakeReq = new http.IncomingMessage(tlsSock);
          // Fall back to tunnel-style: pipe decrypted stream through a one-shot HTTP parser is complex;
          // for v1 MITM we forward decrypted bytes to a local HTTPS→mock bridge via absolute URL rewrite helper.
          handleMitmTlsSocket(tlsSock, hostname, portNum, head);
        });
        if (head && head.length) tlsSock.write(head);
        logAccess({ action: 'connect-mitm', method: 'CONNECT', url: req.url });
        return;
      } catch (e) {
        logAccess({
          action: 'connect-mitm-fail',
          method: 'CONNECT',
          url: req.url,
          error: e.message,
        });
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
        return;
      }
    }

    if (allowConnectTunnel(hostname, portNum) || forceCronetTunnel) {
      let upstream;
      try {
        upstream = net.connect(portNum, hostname, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
      } catch (err) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.end();
        logAccess({
          action: 'connect-tunnel-fail',
          method: 'CONNECT',
          url: req.url,
          error: err && err.message,
        });
        return;
      }
      upstream.on('error', () => clientSocket.end());
      clientSocket.on('error', () => upstream.end());
      logAccess({
        action: forceCronetTunnel ? 'connect-tunnel-cronet' : 'connect-tunnel',
        method: 'CONNECT',
        url: req.url,
      });
      return;
    }

    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    clientSocket.end();
    logAccess({ action: 'connect-deny', method: 'CONNECT', url: req.url });
  });

  /**
   * After TLS handshake with client, parse HTTP requests and route to mock/upstream.
   * Simplified: use HTTP parser on the decrypted socket.
   */
  function handleMitmTlsSocket(tlsSock, hostname, portNum, _head) {
    const bridge = http.createServer(async (req, res) => {
      const urlPath = req.url || '/';
      const method = req.method || 'GET';

      // Browser preflight never hits catalog method rules — answer CORS here.
      if (method === 'OPTIONS') {
        handleOptions(req, res, cors);
        logAccess({
          action: 'mitm-options',
          method: 'OPTIONS',
          url: `https://${hostname}${urlPath}`,
        });
        return;
      }

      // Objective CA trust check (not ping-fe green lock).
      const mitmCheckPath = urlPath.split('?')[0];
      if (
        method === 'GET' &&
        (mitmCheckPath === '/__mox_mitm_check' ||
          mitmCheckPath === '/mox/mitm-check')
      ) {
        let fp = '';
        try {
          const { caFingerprintShort, ensureCa } = require('../../lib/mitm-ca');
          fp = caFingerprintShort(ensureCa().certPath) || '';
        } catch {
          /* ignore */
        }
        const body = JSON.stringify({
          ok: true,
          fingerprintShort: fp,
          host: hostname,
        });
        applyCorsHeaders(req, res, cors);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
        logAccess({
          action: 'mitm-check',
          method: 'GET',
          url: `https://${hostname}${urlPath}`,
        });
        return;
      }

      let body = Buffer.alloc(0);
      try {
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
          body = await readBody(req, { limit: bodyLimit });
        }
      } catch (e) {
        applyCorsHeaders(req, res, cors);
        res.statusCode = 413;
        res.end(JSON.stringify({ code: 413, message: e.message }));
        return;
      }

      const cs = currentCases();
      const pathname = urlPath.split('?')[0];
      const search = urlPath.includes('?') ? urlPath.slice(urlPath.indexOf('?')) : '';
      const query = Object.fromEntries(new URL(`http://${hostname}${urlPath}`).searchParams);
      const reqPort = Number(portNum) || 443;
      const rule = matchRule(currentRules(), hostname, pathname, method, {
        query,
        headers: req.headers,
        port: reqPort,
      });

      if (!rule || !ruleShouldMock(rule)) {
        if (!rule && forcedMissPolicy === 'reject' && !allowOpenProxy) {
          applyCorsHeaders(req, res, cors);
          res.statusCode = 404;
          res.end(JSON.stringify({ code: 404, message: 'no mock rule (mitm)' }));
          return;
        }
        // passthrough over real HTTPS (true miss or traffic-mode passthrough)
        const upReq = https.request(
          {
            hostname,
            port: reqPort,
            path: urlPath,
            method,
            headers: { ...req.headers, host: hostname },
            rejectUnauthorized,
            timeout: upstreamTimeoutMs,
          },
          (upRes) => {
            const chunks = [];
            upRes.on('data', (c) => chunks.push(c));
            upRes.on('end', () => {
              const buf = Buffer.concat(chunks);
              const decoded = decodeResponseBody(buf, upRes.headers || {});
              const bodyFields = captureBodyFromDecoded(decoded);
              if (!res.headersSent) {
                res.writeHead(upRes.statusCode || 200, upRes.headers);
                res.end(buf);
              }
              const status = upRes.statusCode || 200;
              const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
              let requestBody;
              if (isWrite && body.length) {
                const reqText = body.toString('utf8');
                try {
                  requestBody = JSON.parse(reqText);
                } catch {
                  requestBody = reqText.slice(0, bodyLimit);
                }
              }
              if (status >= 400) {
                appendUpstreamFailure({
                  kind: 'http-error',
                  host: hostname,
                  path: pathname,
                  method,
                  status,
                  error: `HTTP ${status}`,
                  taskId,
                });
              }
              recordCapture({
                host: hostname,
                path: pathname,
                method,
                query: Object.fromEntries(
                  new URL(`http://${hostname}${urlPath}`).searchParams,
                ),
                reason: rule ? 'traffic-passthrough' : 'miss',
                stubId: rule?.stubId || rule?.id || null,
                status,
                ...bodyFields,
                mitmPlaintext: true,
                mode: resolvedProxyMode,
                ...(requestBody !== undefined ? { requestBody } : {}),
              });
              logAccess({
                action: rule ? 'mitm-traffic-passthrough' : 'mitm-passthrough',
                method,
                url: `https://${hostname}${urlPath}`,
                status,
              });
            });
          },
        );
        upReq.on('error', (e) => {
          applyCorsHeaders(req, res, cors);
          if (!res.headersSent) {
            res.statusCode = 502;
            res.end(JSON.stringify({ code: 502, message: e.message }));
          }
          appendUpstreamFailure({
            kind: 'connect-error',
            host: hostname,
            path: pathname,
            method,
            error: e.message,
            message: e.message,
            taskId,
          });
          logAccess({
            action: 'mitm-passthrough-error',
            method,
            url: `https://${hostname}${urlPath}`,
            error: e.message,
          });
        });
        if (body.length) upReq.write(body);
        upReq.end();
        return;
      }

      const caseId = resolveCaseId(cs, rule, method, hostname, pathname);
      const headers = { ...req.headers };
      headers.host = mockUrl.host;
      headers['x-forwarded-host'] = hostname;
      headers[caseHeader] = caseId;
      if (rule.stubId) {
        headers['x-mock-stub-id'] = encodeURIComponent(rule.stubId);
      }
      if (rule.upstreamId) {
        headers['x-mock-upstream'] = rule.upstreamId;
      }
      delete headers['content-length'];

      const mockReq = http.request(
        {
          protocol: mockUrl.protocol,
          hostname: mockUrl.hostname,
          port: mockUrl.port,
          path: pathname + search,
          method,
          headers,
          timeout: upstreamTimeoutMs,
        },
        (mockRes) => {
          res.writeHead(mockRes.statusCode || 200, mockRes.headers);
          mockRes.pipe(res);
        },
      );
      mockReq.on('error', (e) => {
        applyCorsHeaders(req, res, cors);
        res.statusCode = 502;
        res.end(JSON.stringify({ code: 502, message: e.message }));
      });
      if (body.length) mockReq.write(body);
      mockReq.end();
      logAccess({
        action: 'mitm-mock',
        method,
        url: `https://${hostname}${urlPath}`,
        caseId,
        ruleId: rule.id,
      });
    });
    bridge.emit('connection', tlsSock);
  }

  function forwardUpstream(clientReq, clientRes, target, body, corsCfg, injectCors) {
    return new Promise((resolve) => {
      const lib = target.protocol === 'https:' ? https : http;
      const headers = { ...clientReq.headers };
      headers.host = target.host;
      const upstream = lib.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: target.pathname + target.search,
          method: clientReq.method,
          headers,
          rejectUnauthorized,
          timeout: upstreamTimeoutMs,
        },
        (upRes) => {
          if (injectCors) applyCorsHeaders(clientReq, clientRes, corsCfg);
          const outHeaders = { ...upRes.headers };
          const chunks = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', () => {
            const buf = Buffer.concat(chunks);
            const decoded = decodeResponseBody(buf, upRes.headers || {});
            const status = upRes.statusCode || 200;
            if (status >= 400) {
              appendUpstreamFailure({
                kind: 'http-error',
                host: target.hostname,
                path: target.pathname,
                method: clientReq.method,
                status,
                error: `HTTP ${status}`,
                taskId,
              });
            }
            if (!clientRes.headersSent) {
              clientRes.writeHead(status, outHeaders);
              clientRes.end(buf);
            }
            resolve({
              status,
              bodyText: decoded.parseOk ? undefined : decoded.bodyText,
              bodyJson: decoded.parseOk ? decoded.bodyJson : undefined,
              bodyMeta: {
                encoding: decoded.encoding,
                parseOk: decoded.parseOk,
                contentType: decoded.contentType,
                byteLength: decoded.byteLength,
                ...(decoded.error ? { error: decoded.error } : {}),
              },
            });
          });
        },
      );
      upstream.on('timeout', () => {
        upstream.destroy(new Error('upstream timeout'));
      });
      upstream.on('error', (e) => {
        if (injectCors) applyCorsHeaders(clientReq, clientRes, corsCfg);
        if (!clientRes.headersSent) {
          clientRes.statusCode = 502;
          clientRes.end(JSON.stringify({ code: 502, message: e.message }));
        }
        appendUpstreamFailure({
          kind: 'connect-error',
          host: target.hostname,
          path: target.pathname,
          method: clientReq.method,
          error: e.message,
          message: e.message,
          taskId,
        });
        resolve({ error: e.message });
      });
      if (body.length) upstream.write(body);
      upstream.end();
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        host,
        port: boundPort,
        url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${boundPort}`,
        missPolicy: forcedMissPolicy,
        allowOpenProxy,
        trafficMode: activeTraffic.trafficMode,
        setCases(next) {
          activeCases = { ...activeCases, ...next };
          casesCacheAt = 0;
        },
        invalidateCasesCache() {
          casesCacheAt = 0;
        },
        reloadRules(nextRules) {
          if (Array.isArray(nextRules)) {
            activeRules = nextRules;
            rulesCacheAt = 0;
          }
        },
        setTraffic(next) {
          activeTraffic = {
            trafficMode: normalizeTrafficMode(
              next?.trafficMode || activeTraffic.trafficMode,
            ),
            mockAllowlist: Array.isArray(next?.mockAllowlist)
              ? [...next.mockAllowlist]
              : [...activeTraffic.mockAllowlist],
          };
          trafficCacheAt = 0;
        },
        close: () => forceCloseHttpServer(server),
      });
    });
  });
}

module.exports = {
  startProxyServer,
  matchRule,
  loadRules,
  readBody,
  isLanBind,
  isLoopbackBind,
  isLoopbackHostname,
};
