'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const {
  ensureProjectDirs,
  projectDataDir,
  chromeProfileDir,
  ensureChromeProfileDir,
} = require('../lib/paths');
const {
  loadSession,
  saveSession,
  saveRuntimeState,
  deepMerge,
} = require('../lib/session-config');
const { appendAudit } = require('../lib/audit');
const {
  resolveActiveCatalogs,
  mergeCatalogs,
  mocksRootFor,
  capturesDirFor,
  parseNameList,
  expandMountKey,
  readProjectIndex,
} = require('../lib/catalog-merge');
const {
  parseRulesKeywords,
  applyRulesToSession,
} = require('../lib/rules');
const { startMockServer } = require('../runtime/mock-server/server');
const { startProxyServer } = require('../runtime/proxy/server');

function portFree(host, port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'chromium',
  ];
  for (const c of candidates) {
    if (c.startsWith('/') && fs.existsSync(c)) return c;
    if (!c.startsWith('/')) return c;
  }
  return null;
}

function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) return it.address;
    }
  }
  return null;
}

/** Bind may be 0.0.0.0 for LAN; Chrome/desktop proxy target must be loopback. */
function resolveClientProxyHost(bindHost) {
  if (!bindHost || bindHost === '0.0.0.0' || bindHost === '::') return '127.0.0.1';
  return bindHost;
}

/** Apply CLI overrides without mutating the loaded session object. */
function applySessionOpts(base, opts = {}) {
  const patch = {};
  if (opts.mockPort != null && opts.mockPort !== '') {
    patch.mock = { port: Number(opts.mockPort) };
  }
  if (opts.proxyPort != null && opts.proxyPort !== '') {
    patch.proxy = { ...(patch.proxy || {}), port: Number(opts.proxyPort) };
  }
  if (opts.proxyHost) {
    patch.proxy = { ...(patch.proxy || {}), host: opts.proxyHost };
  }
  if (opts.proxyEnabled === false || opts.proxy === '0' || opts.proxy === 0) {
    patch.proxy = { ...(patch.proxy || {}), enabled: false };
  }
  if (opts.proxyEnabled === true || opts.proxy === '1') {
    patch.proxy = { ...(patch.proxy || {}), enabled: true };
  }
  if (opts.startUrl) {
    patch.browser = { ...(patch.browser || {}), startUrl: opts.startUrl };
  }
  if (opts.autoLaunch === false) {
    patch.browser = { ...(patch.browser || {}), autoLaunch: false };
  }
  if (opts.allowOpenProxy === true || opts['allow-open-proxy'] === true) {
    patch.proxy = { ...(patch.proxy || {}), allowOpenProxy: true };
  }
  if (opts.mitm === true || opts.mitm === '1') {
    patch.proxy = { ...(patch.proxy || {}), mitm: { enabled: true } };
  }
  if (opts.recordMockHits === true) {
    patch.proxy = { ...(patch.proxy || {}), recordMockHits: true };
  }
  if (opts.traffic) {
    const { normalizeTrafficMode } = require('../lib/traffic-mode');
    patch.proxy = {
      ...(patch.proxy || {}),
      trafficMode: normalizeTrafficMode(opts.traffic),
    };
  }
  if (patch.mock?.port != null && !Number.isFinite(patch.mock.port)) {
    throw new Error(`invalid --mock-port: ${opts.mockPort}`);
  }
  if (patch.proxy?.port != null && !Number.isFinite(patch.proxy.port)) {
    throw new Error(`invalid --proxy-port: ${opts.proxyPort}`);
  }
  return Object.keys(patch).length ? deepMerge(base, patch) : base;
}

/**
 * @param {object} opts
 * @param {string|string[]} [opts.name] — one or more catalog slugs
 * @param {string|string[]} [opts.rules] — rule keywords
 */
async function startSession(opts = {}) {
  const taskId = opts.taskId || null;
  const names = parseNameList(opts.names != null ? opts.names : opts.name);
  const ruleKeywords = parseRulesKeywords(opts.rules);
  const keepState =
    opts.keepState === true ||
    opts['keep-state'] === true ||
    opts.keepState === '1';

  // Fresh Virtual Service store each start (advanced: --keep-state).
  const { resetStore, journalSummary } = require('../lib/service-store');
  if (!keepState) {
    resetStore('*');
    console.log('[mox] store reset (use --keep-state to retain)');
  } else {
    console.log('[mox] store kept (--keep-state)');
  }

  // --rules wins: selective allowlist. Ignore all-passthrough / conflicting --traffic=.
  if (ruleKeywords.length && opts.traffic && opts.traffic !== 'selective') {
    if (opts.traffic === 'all-passthrough') {
      console.log(
        '[mox] ignoring all-passthrough/--record traffic mode; --rules keeps selective',
      );
    } else {
      throw new Error(
        '--rules forces selective traffic; do not pass conflicting --traffic=',
      );
    }
  }

  const catalogs = resolveActiveCatalogs({
    names: names.length ? names : undefined,
    allIfEmpty: true,
  });
  const { ensureServiceDirs } = require('../lib/paths');
  for (const key of catalogs) {
    const { services, legacyProject } = expandMountKey(key);
    // Project slug ≠ upstreamId: only ensure project dirs for projects
    if (readProjectIndex(key) || legacyProject) {
      try {
        ensureProjectDirs(key);
      } catch {
        /* ignore */
      }
    }
    for (const up of services) {
      try {
        ensureServiceDirs(up);
      } catch {
        /* ignore */
      }
    }
  }

  const merged = mergeCatalogs(catalogs);
  saveSession({ activeCatalogs: catalogs });

  if (ruleKeywords.length) {
    applyRulesToSession(ruleKeywords, { rulesDir: opts.rulesDir });
    if (opts.record) {
      saveSession({
        proxy: {
          ...(loadSession().proxy || {}),
          recordMisses: true,
        },
      });
    }
  }

  let cfg = applySessionOpts(loadSession(catalogs[0]), opts);
  if (opts.traffic && !ruleKeywords.length) {
    const { normalizeTrafficMode } = require('../lib/traffic-mode');
    saveSession({
      proxy: {
        ...(loadSession().proxy || {}),
        trafficMode: normalizeTrafficMode(opts.traffic),
      },
    });
    cfg = applySessionOpts(loadSession(), opts);
  }
  if (opts.scenario) {
    const { setScenario } = require('./set-scenario');
    setScenario({
      name: catalogs[0],
      scenario: opts.scenario,
      taskId,
    });
    cfg = applySessionOpts(loadSession(), opts);
  }

  const mockHost = cfg.mock.host || '127.0.0.1';
  const mockPort = cfg.mock.port || 3900;
  const proxyHost = cfg.proxy.host || '127.0.0.1';
  const proxyPort = cfg.proxy.port || 18999;

  if (!(await portFree(mockHost, mockPort))) {
    throw new Error(`mock port in use: ${mockHost}:${mockPort}`);
  }
  if (cfg.proxy.enabled && !(await portFree(proxyHost, proxyPort))) {
    throw new Error(`proxy port in use: ${proxyHost}:${proxyPort}`);
  }

  const primary = catalogs[0];
  const mocksRoot = mocksRootFor(primary);
  const stubToCatalog = merged.stubToCatalog;
  const resolveMocksRoot = (stubId) => {
    const slug = stubToCatalog[stubId];
    return slug ? mocksRootFor(slug) : mocksRoot;
  };
  const resolveCapturesDir = (stubId) => {
    const slug = stubToCatalog[stubId] || primary;
    return capturesDirFor(slug);
  };

  const mock = await startMockServer({
    mocksRoot,
    resolveMocksRoot,
    host: mockHost,
    port: mockPort,
    cors: cfg.cors,
    caseHeader: cfg.proxy.injectCaseHeader || 'x-mock-case',
  });
  console.log(
    `[mox] mock ${mock.url} catalogs=${catalogs.join(',')}`,
  );

  let proxy = null;
  if (cfg.proxy.enabled) {
    const casesLoader = () => {
      const live = loadSession();
      return live.cases || { default: 'success', active: {} };
    };
    const allowOpenProxy = Boolean(
      cfg.proxy.allowOpenProxy || opts.allowOpenProxy || opts['allow-open-proxy'],
    );
    let mitm = null;
    if (cfg.proxy.mitm?.enabled || opts.mitm === true || opts.mitm === '1') {
      try {
        const { createMitmCa } = require('../lib/mitm-ca');
        const ca = createMitmCa(primary);
        mitm = {
          enabled: true,
          getSecureContext: (hostname) => ca.getSecureContext(hostname),
          caCertPath: ca.caCertPath,
        };
        console.log(`[mox] HTTPS MITM enabled; trust CA: ${ca.caCertPath}`);
      } catch (e) {
        console.warn(`[mox] MITM unavailable: ${e.message}`);
      }
    }
    const statefulLoader = () => {
      const live = loadSession();
      return live.stateful || null;
    };
    const trafficLoader = () => {
      const live = loadSession();
      return {
        trafficMode: live.proxy?.trafficMode || 'all-mock',
        mockAllowlist: live.proxy?.mockAllowlist || [],
      };
    };
    proxy = await startProxyServer({
      host: proxyHost,
      port: proxyPort,
      mockTarget: mock.url,
      rules: merged.rules,
      cors: cfg.cors,
      cases: cfg.cases,
      casesLoader,
      statefulLoader,
      trafficLoader,
      trafficMode: cfg.proxy.trafficMode || 'all-mock',
      mockAllowlist: cfg.proxy.mockAllowlist || [],
      caseHeader: cfg.proxy.injectCaseHeader || 'x-mock-case',
      missPolicy: cfg.proxy.missPolicy || 'passthrough',
      blockWritePassthrough: cfg.proxy.blockWritePassthrough !== false,
      passthroughHosts: cfg.proxy.passthroughHosts || [],
      recordMisses: cfg.proxy.recordMisses !== false,
      recordMockHits: Boolean(cfg.proxy.recordMockHits || opts.recordMockHits),
      allowOpenProxy,
      rejectUnauthorized: cfg.proxy.rejectUnauthorized !== false,
      mitm,
      capturesDir: capturesDirFor(primary),
      resolveCapturesDir,
      taskId,
      accessLogPath: path.join(projectDataDir(primary), 'audit', 'proxy-access.jsonl'),
    });
    console.log(
      `[mox] proxy ${proxy.url} missPolicy=${proxy.missPolicy} trafficMode=${cfg.proxy.trafficMode || 'all-mock'} allowlist=${(cfg.proxy.mockAllowlist || []).length} rules=${merged.rules.length}`,
    );
    if (proxyHost === '0.0.0.0') {
      const ip = lanIp();
      const scenarioLabel = cfg.scenario || opts.scenario || '(unset)';
      console.log('');
      console.log('===【真机 Wi‑Fi 代理】手机 Wi‑Fi 手动代理填写===');
      console.log(`  host: ${ip || '<电脑LAN_IP>'}`);
      console.log(`  port: ${proxyPort}`);
      console.log(`  scenario: ${scenarioLabel}`);
      console.log('  仅信任局域网，勿在公共 Wi‑Fi 开 0.0.0.0');
      if (!allowOpenProxy) {
        console.log('  missPolicy=reject（未传 --allow-open-proxy）；CONNECT 仅放行 passthroughHosts');
      } else {
        console.log('  WARNING: --allow-open-proxy 已开启，本机可被用作开放代理');
      }
      if (mitm?.caCertPath) {
        console.log(`  HTTPS MITM CA（真机需安装信任）: ${mitm.caCertPath}`);
      } else {
        console.log('  HTTPS: 默认仅 CONNECT 隧道（无法改写）；启用 MITM: --mitm=1');
      }
      console.log('');
    }
  } else {
    console.log('[mox] proxy disabled');
  }

  const userDataDir = chromeProfileDir(primary);
  const chrome = findChrome();
  const clientProxyHost = resolveClientProxyHost(proxyHost);
  const proxyServerArg = `${clientProxyHost}:${proxyPort}`;
  const startUrl = cfg.browser.startUrl || '';
  const chromeCmd = chrome
    ? `"${chrome}" --user-data-dir="${userDataDir}" --proxy-server="${proxyServerArg}" --no-first-run ${
        startUrl ? `"${startUrl}"` : ''
      }`
    : `(find Google Chrome) --user-data-dir="${userDataDir}" --proxy-server="${proxyServerArg}" --no-first-run`;

  console.log('');
  console.log('===【Mock 自测浏览器】请只在此窗口自测===');
  console.log(chromeCmd);
  console.log('');

  let chromePid = null;
  if (cfg.proxy.enabled && cfg.browser.autoLaunch && chrome && fs.existsSync(chrome)) {
    ensureChromeProfileDir(primary);
    const args = [
      `--user-data-dir=${userDataDir}`,
      `--proxy-server=${proxyServerArg}`,
      '--no-first-run',
      '--new-window',
    ];
    if (startUrl) args.push(startUrl);
    else args.push(`http://${clientProxyHost}:${proxyPort}/`);
    const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
    child.unref();
    chromePid = child.pid;
    console.log(`[mox] launched Chrome pid=${chromePid}`);
  }

  const state = {
    activeCatalogs: catalogs,
    projectSlug: primary,
    taskId,
    mock: { host: mockHost, port: mockPort, pid: process.pid },
    proxy: cfg.proxy.enabled
      ? { host: proxyHost, port: proxyPort, enabled: true }
      : { enabled: false },
    chromePid,
    startedAt: new Date().toISOString(),
  };
  saveRuntimeState(state);
  appendAudit(primary, {
    command: 'session start',
    taskId,
    summary: `catalogs=${catalogs.join(',')} mock=${mockPort} proxy=${cfg.proxy.enabled ? proxyPort : 'off'}`,
  });

  if (opts.detach) {
    return { mock, proxy, state, chromeCmd, catalogs, rules: merged.rules };
  }

  console.log('[mox] session running — Ctrl+C to stop');
  // SIGHUP (terminal close / background without --detach) must not kill the session.
  // Use `mox stop` or SIGTERM/SIGINT to shut down.
  try {
    process.on('SIGHUP', () => {
      console.log('[mox] ignoring SIGHUP (use mox stop to end session)');
    });
  } catch {
    /* platform may not support SIGHUP */
  }
  const shutdown = async () => {
    console.log('\n[mox] stopping...');
    if (chromePid) {
      try {
        process.kill(chromePid, 'SIGTERM');
      } catch (_) {
        /* ignore */
      }
    }
    if (proxy) await proxy.close().catch(() => {});
    await mock.close().catch(() => {});
    saveRuntimeState({ ...state, stoppedAt: new Date().toISOString() });
    appendAudit(primary, { command: 'session stop', taskId, summary: 'stopped' });
    console.log(journalSummary().line);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
}

module.exports = { startSession, findChrome, resolveClientProxyHost, applySessionOpts };

if (require.main === module) {
  startSession({
    projectDir: process.cwd(),
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
