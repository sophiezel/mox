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
  getGlobalRuntimePath,
  serviceDataDir,
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
const { resolveCaptureStagingDir } = require('../lib/resolve-service-id-from-host');
const { applyRulesToSession } = require('../lib/rules');
const {
  resolveStartRuleKeywords,
  saveRulesActive,
  syncEmptyPackPreferenceToSession,
} = require('../lib/rules-active');
const { startMockServer } = require('../runtime/mock-server/server');
const { startProxyServer } = require('../runtime/proxy/server');
const {
  explainPortBusy,
} = require('../lib/start-preflight');

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

function scrubChromeSessionRestore(userDataDir) {
  if (!userDataDir || !fs.existsSync(userDataDir)) return;
  const def = path.join(userDataDir, 'Default');
  for (const name of [
    'Current Session',
    'Last Session',
    'Current Tabs',
    'Last Tabs',
    'Sessions',
  ]) {
    try {
      fs.rmSync(path.join(def, name), { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
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
    '--disable-session-crashed-bubble',
    '--disable-restore-session-state',
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

/**
 * Launch (or preview) a Chromium-family browser pointed at the mox proxy.
 * @param {{ profileLabel: string, proxyHost: string, proxyPort: number, startUrl?: string, dryRun?: boolean }} opts
 * @returns {{ chromePid: number|null, chromeCmd: string, chrome: string|null, startUrl: string }}
 */
function launchProxyBrowser(opts) {
  const profileLabel = opts.profileLabel || 'default';
  const proxyHost = opts.proxyHost || '127.0.0.1';
  const proxyPort = Number(opts.proxyPort) || 18999;
  const startUrl = opts.startUrl || 'http://127.0.0.1:8000';
  const userDataDir = chromeProfileDir(profileLabel);
  const chrome = findChrome();
  const clientProxyHost = resolveClientProxyHost(proxyHost);
  const proxyServerArg = `${clientProxyHost}:${proxyPort}`;
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

  if (opts.dryRun) {
    return { chromePid: null, chromeCmd, chrome, startUrl };
  }
  if (!chrome || (chrome.startsWith('/') && !fs.existsSync(chrome))) {
    return { chromePid: null, chromeCmd, chrome, startUrl };
  }
  ensureChromeProfileDir(profileLabel);
  scrubChromeSessionRestore(userDataDir);
  const child = spawn(chrome, launchArgs, { detached: true, stdio: 'ignore' });
  child.unref();
  return { chromePid: child.pid, chromeCmd, chrome, startUrl };
}

/**
 * Open proxy browser against an already-running session.
 * @param {{ startUrl?: string }} [opts]
 */
function openProxyBrowser(opts = {}) {
  const cfg = loadSession();
  let runtime = {};
  try {
    if (fs.existsSync(getGlobalRuntimePath())) {
      runtime = JSON.parse(fs.readFileSync(getGlobalRuntimePath(), 'utf8'));
    }
  } catch {
    runtime = {};
  }
  if (!runtime?.proxy?.enabled || !runtime.proxy.port) {
    throw new Error('no running proxy session — start with: mox start');
  }
  const primary =
    (Array.isArray(runtime.activeCatalogs) && runtime.activeCatalogs[0]) ||
    runtime.projectSlug ||
    (Array.isArray(cfg.activeCatalogs) && cfg.activeCatalogs[0]) ||
    'default';
  const startUrl =
    opts.startUrl || cfg.browser?.startUrl || 'http://127.0.0.1:8000';
  const launched = launchProxyBrowser({
    profileLabel: primary,
    proxyHost: runtime.proxy.host || cfg.proxy?.host || '127.0.0.1',
    proxyPort: runtime.proxy.port,
    startUrl,
  });
  if (!launched.chromePid) {
    throw new Error('Chrome/Chromium/Edge not found');
  }
  return launched;
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
  // Browser is opt-in via --open only; ignore stale session autoLaunch:true.
  if (opts.open === true || opts.autoLaunch === true) {
    patch.browser = { ...(patch.browser || {}), autoLaunch: true };
  } else {
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
  if (opts.captureOpen === true) {
    const { normalizeProxyMode } = require('../lib/capture-filter');
    patch.proxy = {
      ...(patch.proxy || {}),
      mode: normalizeProxyMode('capture-open'),
      recordMisses: true,
      // Override mock-lab session default (true) so recording can POST.
      // Set blockWritePassthrough:true under capture-open to re-block.
      blockWritePassthrough: false,
    };
  }
  if (opts.scanDir) {
    patch.scanDir = path.resolve(String(opts.scanDir));
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
  const { keywords: ruleKeywords, source: rulesSource } =
    resolveStartRuleKeywords(opts);
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

  // --rules / sticky packs: selective allowlist. Ignore all-passthrough / conflicting --traffic=.
  if (ruleKeywords.length && opts.traffic && opts.traffic !== 'selective') {
    if (opts.traffic === 'all-passthrough') {
      console.log(
        '[mox] ignoring all-passthrough traffic mode; rules keep selective',
      );
    } else {
      throw new Error(
        'rules force selective traffic; do not pass conflicting --traffic=',
      );
    }
  }

  const cfgForMode = applySessionOpts(loadSession(), opts);
  const { normalizeProxyMode } = require('../lib/capture-filter');
  const captureOpen =
    normalizeProxyMode(cfgForMode.proxy?.mode) === 'capture-open';

  let catalogs = resolveActiveCatalogs({
    names: names.length ? names : undefined,
    allIfEmpty: true,
    allowEmpty: captureOpen && !names.length,
  });
  if (!catalogs.length && captureOpen) {
    console.log(
      '[mox] no catalogs yet — capture-open stages by host; mox merge opens formal catalogs',
    );
  }
  const { ensureServiceDirs, ensureDataDirs, auditDir, parseStubId, serviceDataDir, getDataRoot } =
    require('../lib/paths');
  ensureDataDirs();
  {
    const {
      runDataRetention,
      resolveRetentionPolicy,
    } = require('../lib/data-retention');
    const cfgEarly = loadSession();
    const retentionPolicy = resolveRetentionPolicy(cfgEarly.dataRetention);
    const gc = runDataRetention(getDataRoot(), retentionPolicy, { dryRun: false });
    if (gc.removed || gc.rotated) {
      console.log(
        `[mox] data retention removed=${gc.removed} rotated=${gc.rotated}`,
      );
    }
  }
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

  {
    const { hydrateSeedsIntoStores } = require('../lib/virtual-service/seed-store');
    const seedIds = [];
    for (const key of catalogs) {
      const { services } = expandMountKey(key);
      for (const up of services.length ? services : [key]) seedIds.push(up);
    }
    const hydrated = hydrateSeedsIntoStores(
      seedIds.length ? [...new Set(seedIds)] : undefined,
    );
    if (hydrated) {
      console.log(`[mox] store seeds hydrated=${hydrated}`);
    }
  }

  let merged = mergeCatalogs(catalogs);
  saveSession({ activeCatalogs: catalogs });

  if (ruleKeywords.length) {
    if (rulesSource === 'rules-active') {
      console.log(
        `[mox] applying sticky rules-active: ${ruleKeywords.join(', ')}`,
      );
    }
    const { merged: appliedRules, applied } = applyRulesToSession(
      ruleKeywords,
      { rulesDir: opts.rulesDir },
    );
    if (applied && appliedRules.resolved.length) {
      saveRulesActive(appliedRules.resolved);
      if (rulesSource === 'cli') {
        console.log('[mox] sticky packs → .data/rules-active');
      }
    }
    // Remount after map upsert: pick up new services + refresh rules seed.
    if (!names.length) {
      catalogs = resolveActiveCatalogs({
        allIfEmpty: true,
        allowEmpty: captureOpen,
      });
    } else {
      const live = loadSession();
      const extra = [];
      for (const sid of live.proxy?.mockAllowlist || []) {
        const parsed = parseStubId(sid);
        const up = parsed?.upstreamId;
        if (!up || catalogs.includes(up) || extra.includes(up)) continue;
        if (
          fs.existsSync(path.join(serviceDataDir(up), 'proxy-rules.json'))
        ) {
          extra.push(up);
        }
      }
      if (extra.length) catalogs = [...catalogs, ...extra];
    }
    saveSession({ activeCatalogs: catalogs });
    merged = mergeCatalogs(catalogs);
  } else {
    // rules-active empty (≈ Whistle unselect): drop stale pack gate
    const sync = syncEmptyPackPreferenceToSession();
    if (sync.cleared) {
      console.log(
        '[mox] rules-active empty; cleared pack gate (selective, allowlist=0)',
      );
    }
  }
  if (opts.captureOpen) {
    const { normalizeProxyMode } = require('../lib/capture-filter');
    const prev = loadSession().proxy || {};
    saveSession({
      proxy: {
        ...prev,
        mode: normalizeProxyMode('capture-open'),
        recordMisses: true,
        blockWritePassthrough: false,
      },
    });
  }

  let cfg = applySessionOpts(loadSession(catalogs[0] || undefined), opts);
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
      name: catalogs[0] || 'bootstrap',
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
    const { hint } = explainPortBusy({
      runtimePath: getGlobalRuntimePath(),
      port: mockPort,
      kind: 'mock',
    });
    throw new Error(`mock port in use: ${mockHost}:${mockPort} — ${hint}`);
  }
  if (cfg.proxy.enabled && !(await portFree(proxyHost, proxyPort))) {
    const { hint } = explainPortBusy({
      runtimePath: getGlobalRuntimePath(),
      port: proxyPort,
      kind: 'proxy',
    });
    throw new Error(`proxy port in use: ${proxyHost}:${proxyPort} — ${hint}`);
  }

  const primary = catalogs[0] || null;
  const mocksRoot = primary
    ? mocksRootFor(primary)
    : path.join(getDataRoot(), 'services', '_bootstrap', 'mocks');
  if (!primary) {
    fs.mkdirSync(mocksRoot, { recursive: true });
  }
  const resolveMocksRoot = (stubId) => {
    const slug = merged.stubToCatalog[stubId];
    return slug ? mocksRootFor(slug) : mocksRoot;
  };

  const upstreamsSnap = { version: 1, upstreams: {} };
  for (const up of catalogs) {
    const p = path.join(serviceDataDir(up), 'upstreams.json');
    if (!fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      Object.assign(upstreamsSnap.upstreams, data.upstreams || {});
    } catch {
      /* ignore */
    }
  }
  const resolveCapturesDir = (rec) => {
    const stubId = typeof rec === 'string' ? rec : rec?.stubId;
    const host = typeof rec === 'string' ? null : rec?.host;
    return resolveCaptureStagingDir({
      stubId,
      host,
      stubToCatalog: merged.stubToCatalog,
      primary,
      upstreams: upstreamsSnap,
      captureNoiseSuffixes: cfg.proxy?.captureNoiseSuffixes || [],
    });
  };

  const mock = await startMockServer({
    mocksRoot,
    resolveMocksRoot,
    host: mockHost,
    port: mockPort,
    cors: cfg.cors,
    caseHeader: cfg.proxy.injectCaseHeader || 'x-mock-case',
    mode: cfg.proxy.mode || 'mock-lab',
    serveCaptureIfEmpty: Boolean(cfg.proxy.serveCaptureIfEmpty),
    capturesDir: primary ? capturesDirFor(primary) : null,
  });
  process.env.MOX_PROXY_MODE = cfg.proxy.mode || 'mock-lab';
  console.log(
    `[mox] mock ${mock.url} catalogs=${catalogs.length ? catalogs.join(',') : '(none)'} mode=${cfg.proxy.mode || 'mock-lab'}`,
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
      const ca = createMitmCa(primary || 'bootstrap');
      mitm = {
        enabled: true,
        getSecureContext: (hostname) => ca.getSecureContext(hostname),
        caCertPath: ca.caCertPath,
      };
      const {
        caFingerprintShort,
      } = require('../lib/mitm-ca');
      const fp = caFingerprintShort(ca.caCertPath) || '';
      console.log(`[mox] HTTPS MITM enabled; CA: ${ca.caCertPath}`);
      if (fp) console.log(`[mox] MITM CA fingerprint (sha256…): ${fp}…`);
      console.log(
        '[mox] phone trust check: open https://<catalog-host>/__mox_mitm_check (JSON ok:true) — do not use page green lock alone',
      );
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
    const rulesLoader = () => {
      const live = loadSession();
      const cats = resolveActiveCatalogs({
        names: live.activeCatalogs,
        allIfEmpty: true,
      });
      return mergeCatalogs(cats).rules;
    };
    const ip = lanIp();
    const scanDirRaw = opts.scanDir || cfg.scanDir || null;
    const scanDir =
      scanDirRaw && fs.existsSync(path.resolve(String(scanDirRaw)))
        ? path.resolve(String(scanDirRaw))
        : null;
    if (scanDirRaw && !scanDir) {
      console.warn(
        `[mox] scanDir not found (${scanDirRaw}); on-demand page mock disabled`,
      );
    } else if (scanDir) {
      console.log(`[mox] on-demand scanDir=${scanDir}`);
    } else {
      console.log(
        '[mox] on-demand page mock off (no scanDir; run mox init <frontend> or --scan-dir=)',
      );
    }
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
      rulesLoader,
      trafficMode: cfg.proxy.trafficMode || 'all-mock',
      mockAllowlist: cfg.proxy.mockAllowlist || [],
      caseHeader: cfg.proxy.injectCaseHeader || 'x-mock-case',
      missPolicy: cfg.proxy.missPolicy || 'passthrough',
      blockWritePassthrough: require('../lib/capture-filter').resolveBlockWritePassthrough(
        cfg.proxy || {},
      ),
      passthroughHosts: cfg.proxy.passthroughHosts || [],
      recordMisses: cfg.proxy.recordMisses !== false,
      recordMockHits: Boolean(cfg.proxy.recordMockHits || opts.recordMockHits),
      captureScope: cfg.proxy.captureScope || 'catalog',
      mode: cfg.proxy.mode || 'mock-lab',
      captureMitmHosts: cfg.proxy.captureMitmHosts || [],
      captureNoiseSuffixes: cfg.proxy.captureNoiseSuffixes || [],
      allowOpenProxy,
      rejectUnauthorized: cfg.proxy.rejectUnauthorized !== false,
      mitm,
      capturesDir: primary ? capturesDirFor(primary) : null,
      resolveCapturesDir,
      taskId,
      accessLogPath: path.join(auditDir(), 'proxy-access.jsonl'),
      proxyLogLevel: opts.proxyLog,
      dataRetention: cfg.dataRetention,
      deviceSetup: ip ? { lanIp: ip, port: proxyPort } : { lanIp: null, port: proxyPort },
      onDemand: scanDir
        ? {
            enabled: true,
            scanDir,
            timeoutMs: Number(cfg.proxy?.onDemandTimeoutMs) || 8000,
            getMergedRules: () => {
              const live = loadSession();
              const cats = resolveActiveCatalogs({
                names: live.activeCatalogs,
                allIfEmpty: true,
              });
              return mergeCatalogs(cats).rules;
            },
          }
        : { enabled: false },
    });
    console.log(
      `[mox] proxy ${proxy.url} missPolicy=${proxy.missPolicy} trafficMode=${cfg.proxy.trafficMode || 'all-mock'} allowlist=${(cfg.proxy.mockAllowlist || []).length} rules=${merged.rules.length}`,
    );
    {
      const { resolveProxyLogLevel } = require('../lib/proxy-access-log');
      const lvl = resolveProxyLogLevel(opts.proxyLog);
      console.log(
        `[mox] proxy log=${lvl}${
          lvl === 'summary'
            ? ' (mock+fail+capture; --proxy-log=verbose or MOX_PROXY_LOG=verbose for all)'
            : ''
        }`,
      );
    }
    {
      const {
        buildDeviceSetupUrls,
        printHubQrToTerminal,
      } = require('../lib/device-setup');
      const urls = buildDeviceSetupUrls({ lanIp: ip, proxyPort });
      const scenarioLabel = cfg.scenario || opts.scenario || '(unset)';
      const wifiHost = ip || resolveClientProxyHost(proxyHost);
      console.log('');
      console.log('===【真机接入】扫码或手填===');
      if (ip) {
        console.log(`  Wi-Fi 代理: ${urls.wifiProxy}`);
        console.log(`  接入页: ${urls.hub}`);
        console.log(`  CA: ${urls.caCer}`);
        console.log(`  PAC: ${urls.pac}`);
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
      console.log('  推荐：先扫下方二维码打开接入页 → 装 CA → 再设代理（手动 IP:port 或自动 PAC）');
      if (mitm?.caCertPath) {
        console.log(`  HTTPS MITM CA 文件: ${mitm.caCertPath}`);
        console.log('  iOS: CA 安装后 → 设置 → 通用 → 关于本机 → 证书信任设置 → 完全信任');
        console.log('  Android: 设置 → 安全 → 安装证书 → CA；WebView 可能仍不信任用户 CA');
      } else {
        console.log('  HTTPS: 当前未启用 MITM（--mitm=0）；catalog host 无法改写');
      }
      if (urls.hub) {
        console.log('');
        console.log('  [扫码打开接入页]');
        await printHubQrToTerminal(urls.hub);
      }
      console.log('');
    }
  } else {
    console.log('[mox] proxy disabled');
  }

  const clientProxyHost = resolveClientProxyHost(proxyHost);
  const startUrl = cfg.browser.startUrl || 'http://127.0.0.1:8000';
  const launchPreview = launchProxyBrowser({
    profileLabel: primary || 'bootstrap',
    proxyHost,
    proxyPort,
    startUrl,
    dryRun: true,
  });
  const chromeCmd = launchPreview.chromeCmd;

  if (cfg.proxy.enabled) {
    console.log('');
    console.log(
      '[mox] proxy tip: local pages bypass proxy (127.0.0.1;localhost;::1); remote APIs via mox. MITM uses system-trusted CA (no Chrome ignore-certificate flags). Firefox/Safari: system proxy bypass list.',
    );
  }

  console.log('');
  console.log('===【Mock 自测浏览器】mox start --open 或 mox open===');
  console.log(chromeCmd);
  console.log('');

  let chromePid = null;
  if (cfg.proxy.enabled && cfg.browser.autoLaunch) {
    const launched = launchProxyBrowser({
      profileLabel: primary || 'bootstrap',
      proxyHost,
      proxyPort,
      startUrl,
    });
    chromePid = launched.chromePid;
    if (chromePid) {
      console.log(`[mox] launched Chrome pid=${chromePid} → ${startUrl}`);
    } else {
      console.log('[mox] --open requested but Chrome/Chromium/Edge not found');
    }
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
    summary: `catalogs=${catalogs.length ? catalogs.join(',') : '(none)'} mock=${mockPort} proxy=${cfg.proxy.enabled ? proxyPort : 'off'}`,
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
  launchProxyBrowser,
  openProxyBrowser,
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
