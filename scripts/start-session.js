'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const {
  chromeProfileDir,
  ensureChromeProfileDir,
  auditDir,
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
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'chromium',
    'microsoft-edge',
  ];
  for (const c of candidates) {
    if (c.startsWith('/') && fs.existsSync(c)) return c;
    if (!c.startsWith('/')) return c;
  }
  return null;
}

/** Chromium-family flags: proxy remote APIs, direct to local HTTP pages. No ignore-certificate* flags. */
function buildChromiumLaunchArgs({
  userDataDir,
  proxyServerArg,
  clientProxyHost,
  proxyPort,
  startUrl = '',
}) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--proxy-server=${proxyServerArg}`,
    '--proxy-bypass-list=127.0.0.1;localhost;::1',
    '--no-first-run',
    '--new-window',
  ];
  if (startUrl) args.push(startUrl);
  else args.push(`http://${clientProxyHost}:${proxyPort}/`);
  return args;
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
  if (
    opts.noOpenProxy === true ||
    opts['no-open-proxy'] === true ||
    opts.allowOpenProxy === false
  ) {
    patch.proxy = { ...(patch.proxy || {}), allowOpenProxy: false };
  } else if (opts.allowOpenProxy === true || opts['allow-open-proxy'] === true) {
    patch.proxy = { ...(patch.proxy || {}), allowOpenProxy: true };
  }
  if (opts.mitm === false || opts.mitm === '0' || opts.mitm === 0) {
    patch.proxy = { ...(patch.proxy || {}), mitm: { enabled: false } };
  } else if (opts.mitm === true || opts.mitm === '1' || opts.mitm === 1) {
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
  const { ensureServiceDirs, ensureDataDirs, auditDir } = require('../lib/paths');
  ensureDataDirs();
  for (const key of catalogs) {
    const { services } = expandMountKey(key);
    for (const up of services.length ? services : [key]) {
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
  const proxyHost = cfg.proxy.host || '0.0.0.0';
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
  let mitm = null;
  if (cfg.proxy.enabled) {
    const casesLoader = () => {
      const live = loadSession();
      return live.cases || { default: 'success', active: {} };
    };
    const allowOpenProxy = cfg.proxy.allowOpenProxy !== false;
    const wantMitm = cfg.proxy.mitm?.enabled !== false;
    if (wantMitm) {
      const {
        createMitmCa,
        ensureMitmCaReady,
        logTrustedCaResult,
      } = require('../lib/mitm-ca');
      const trust = ensureMitmCaReady();
      logTrustedCaResult(trust);
      if (!trust.ok) {
        throw new Error(
          `MITM CA not trusted — finish Always Trust in Keychain, then re-run mox start in Terminal.app (${trust.error || 'install failed'})`,
        );
      }
      const ca = createMitmCa(primary);
      mitm = {
        enabled: true,
        getSecureContext: (hostname) => ca.getSecureContext(hostname),
        caCertPath: ca.caCertPath,
      };
      console.log(`[mox] HTTPS MITM enabled; CA: ${ca.caCertPath}`);
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
      accessLogPath: path.join(auditDir(), 'proxy-access.jsonl'),
    });
    console.log(
      `[mox] proxy ${proxy.url} missPolicy=${proxy.missPolicy} trafficMode=${cfg.proxy.trafficMode || 'all-mock'} allowlist=${(cfg.proxy.mockAllowlist || []).length} rules=${merged.rules.length}`,
    );
    {
      const ip = lanIp();
      const scenarioLabel = cfg.scenario || opts.scenario || '(unset)';
      const wifiHost = ip || resolveClientProxyHost(proxyHost);
      console.log('');
      console.log('===【真机 Wi‑Fi 代理】手机 Wi‑Fi 手动代理填写===');
      if (ip) {
        console.log(`  host: ${ip}`);
        console.log(`  port: ${proxyPort}`);
        console.log(`  Wi-Fi 代理: ${ip}:${proxyPort}`);
      } else {
        console.log(`  host: (未检测到局域网 IP；本机可用 ${wifiHost})`);
        console.log(`  port: ${proxyPort}`);
      }
      console.log(`  scenario: ${scenarioLabel}`);
      if (proxyHost === '0.0.0.0' || proxyHost === '::') {
        console.log('  仅信任局域网，勿在公共 Wi‑Fi 使用（默认对 LAN 开放，同 Whistle）');
      } else {
        console.log(`  bind: ${proxyHost}（本机限定；真机请用默认 0.0.0.0 或改 --proxy-host）`);
      }
      if (!allowOpenProxy) {
        console.log('  missPolicy/CONNECT 已收紧（--no-open-proxy）；CONNECT 仅放行 passthroughHosts');
      }
      if (mitm?.caCertPath) {
        console.log(`  HTTPS MITM CA（电脑+手机同一份）: ${mitm.caCertPath}`);
        if (ip) {
          const base = `http://${ip}:${proxyPort}`;
          console.log(`  手机安装: ${base}/mox/ca.cer`);
        } else {
          console.log(
            `  手机安装: http://<电脑局域网IP>:${proxyPort}/mox/ca.cer（先确认电脑与手机同网）`,
          );
        }
        console.log('  iOS: 安装后 → 设置 → 通用 → 关于本机 → 证书信任设置 → 打开完全信任');
        console.log('  Android: 设置 → 安全 → 安装证书 → CA；WebView 可能仍不信任用户 CA');
        console.log('  电脑重试: 再执行一次 mox start（或 mox trust-ca）');
      } else {
        console.log('  HTTPS: 当前未启用 MITM（--mitm=0）；catalog host 无法改写');
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
  const startUrl = cfg.browser.startUrl || 'http://127.0.0.1:8000';
  const launchArgs = buildChromiumLaunchArgs({
    userDataDir,
    proxyServerArg,
    clientProxyHost,
    proxyPort,
    startUrl,
  });
  const chromeCmd = chrome
    ? `"${chrome}" ${launchArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`
    : `(find Chromium/Chrome/Edge) ${launchArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;

  if (cfg.proxy.enabled) {
    console.log('');
    console.log(
      '[mox] proxy tip: local pages bypass proxy (127.0.0.1;localhost;::1); remote APIs via mox. MITM uses system-trusted CA (no Chrome ignore-certificate flags). Firefox/Safari: system proxy bypass list.',
    );
  }

  console.log('');
  console.log('===【Mock 自测浏览器】请只在此窗口自测===');
  console.log(chromeCmd);
  console.log('');

  let chromePid = null;
  if (cfg.proxy.enabled && cfg.browser.autoLaunch && chrome && fs.existsSync(chrome)) {
    ensureChromeProfileDir(primary);
    const child = spawn(chrome, launchArgs, { detached: true, stdio: 'ignore' });
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
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[mox] stopping...');
    if (chromePid) {
      try {
        process.kill(chromePid, 'SIGTERM');
      } catch (_) {
        /* ignore */
      }
    }
    // Hard deadline so one Ctrl+C never hangs on keep-alive / CONNECT tunnels.
    const hardExit = setTimeout(() => process.exit(0), 1000);
    if (typeof hardExit.unref === 'function') hardExit.unref();
    (async () => {
      try {
        if (proxy) await proxy.close().catch(() => {});
        await mock.close().catch(() => {});
        saveRuntimeState({ ...state, stoppedAt: new Date().toISOString() });
        appendAudit(primary, {
          command: 'session stop',
          taskId,
          summary: 'stopped',
        });
        console.log(journalSummary().line);
      } catch (_) {
        /* ignore — still exit */
      } finally {
        clearTimeout(hardExit);
        process.exit(0);
      }
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
}

module.exports = {
  startSession,
  findChrome,
  buildChromiumLaunchArgs,
  resolveClientProxyHost,
  applySessionOpts,
  lanIp,
};

if (require.main === module) {
  startSession({
    projectDir: process.cwd(),
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
