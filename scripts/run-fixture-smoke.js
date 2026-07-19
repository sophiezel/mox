'use strict';

/**
 * Fixture smoke pipeline (CI gate):
 *   init fixtures/generic-web → start mock → smoke --ci → set-scenario e2e-fault → smoke → stop
 * Exits non-zero on any failure. Designed to run against the bundled generic-web fixture
 * (axios + fetch, no company domain).
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { initProject } = require('./init-project');
const { startMockServer } = require('../runtime/mock-server/server');
const { startProxyServer } = require('../runtime/proxy/server');
const { smokeCases } = require('./smoke-cases');
const { setScenario } = require('./set-scenario');
const { loadSession, saveSession } = require('../lib/session-config');
const { getDataRoot, ensureDataDirs, listServiceIds } = require('../lib/paths');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'generic-web');
const TASK_ID = 'fixture-smoke';

function reqProxy(proxyUrl, target) {
  return new Promise((resolve, reject) => {
    const u = new URL(proxyUrl);
    http
      .request(
        { hostname: u.hostname, port: u.port, path: target, method: 'GET' },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode }));
        },
      )
      .on('error', reject)
      .end();
  });
}

async function verifyScenarioViaProxy(proxyUrl, rules, expectedStatus, proxy) {
  if (!rules || rules.length === 0) {
    console.error('[fixture-smoke] no proxy rules — cannot verify scenario (fail closed)');
    return 1;
  }
  if (proxy && typeof proxy.invalidateCasesCache === 'function') {
    proxy.invalidateCasesCache();
  }
  let fails = 0;
  for (const rule of rules) {
    const ruleHost = rule.hosts?.[0] || rule.host || '127.0.0.1';
    const target = `http://${ruleHost}${rule.pathPrefix}`;
    try {
      const res = await reqProxy(proxyUrl, target);
      if (res.status !== expectedStatus) {
        console.error(
          `[fixture-smoke]   ${target} -> ${res.status} (expected ${expectedStatus})`,
        );
        fails++;
      }
    } catch (e) {
      console.error(`[fixture-smoke]   ${target} error: ${e.message}`);
      fails++;
    }
  }
  return fails;
}

async function run() {
  // Isolate fixture smoke under a temp data root when not already set
  if (!process.env.MOX_DATA_ROOT) {
    const tmp = path.join(getDataRoot(), '..', `.data-fixture-smoke-${Date.now()}`);
    process.env.MOX_DATA_ROOT = tmp;
  }
  const dataRoot = getDataRoot();
  fs.rmSync(dataRoot, { recursive: true, force: true });
  ensureDataDirs();

  console.log('[fixture-smoke] init fixtures/generic-web');
  const initRes = await initProject({
    projectDir: FIXTURE_DIR,
    taskId: TASK_ID,
    force: true,
  });
  console.log(
    `[fixture-smoke] discovered=${initRes.apis.length} generated=${initRes.gen.generated} skippedEmpty=${initRes.gen.skippedEmptyCount ?? '?'}`,
  );

  const {
    mocksRootFor,
    mergeCatalogs,
    loadContractsAcross,
    handlerExistsForContract,
  } = require('../lib/catalog-merge');
  const services = listServiceIds();
  if (!services.length) {
    throw new Error('no services after init');
  }
  const contracts = loadContractsAcross(services);
  const hasHandler = contracts.some((c) => handlerExistsForContract(c));
  if (!hasHandler) {
    throw new Error('no mocks generated for fixture');
  }

  const rules = mergeCatalogs(services).rules;
  if (rules.length === 0) {
    throw new Error(
      'no proxy-rules after init — fixture pages must consume APIs so handlers materialize',
    );
  }

  const merged = mergeCatalogs(services);
  const primaryRoot = mocksRootFor(merged.catalogs[0]);
  const stubToCatalog = merged.stubToCatalog;
  const resolveMocksRoot = (stubId) => {
    const key = stubToCatalog[stubId];
    return key ? mocksRootFor(key) : primaryRoot;
  };

  const srv = await startMockServer({
    mocksRoot: primaryRoot,
    resolveMocksRoot,
    host: '127.0.0.1',
    port: 0,
  });
  console.log(`[fixture-smoke] mock listening ${srv.url}`);

  let failed = 0;
  try {
    saveSession({ mock: { host: '127.0.0.1', port: srv.port }, activeCatalogs: services });

    const r1 = await smokeCases({ ci: true, taskId: TASK_ID });
    failed += r1.failed;
    console.log(`[fixture-smoke] smoke --ci: failed=${r1.failed} results=${r1.results.length}`);

    setScenario({ scenario: 'e2e-fault' });
    const casesLoader = () => loadSession().cases || { default: 'success', active: {} };
    const proxy = await startProxyServer({
      host: '127.0.0.1',
      port: 0,
      mockTarget: srv.url,
      rules,
      cases: loadSession().cases,
      casesLoader,
      caseHeader: 'x-mock-case',
    });
    console.log(`[fixture-smoke] proxy listening ${proxy.url}`);
    try {
      const faultFails = await verifyScenarioViaProxy(proxy.url, rules, 500, proxy);
      if (faultFails > 0) {
        console.error(`[fixture-smoke] e2e-fault: ${faultFails} APIs did NOT return 500 via proxy`);
        failed += faultFails;
      } else {
        console.log('[fixture-smoke] e2e-fault default=500 via proxy: verified');
      }

      setScenario({ scenario: 'e2e-happy' });
      proxy.invalidateCasesCache();
      const happyFails = await verifyScenarioViaProxy(proxy.url, rules, 200, proxy);
      if (happyFails > 0) {
        console.error(`[fixture-smoke] e2e-happy: ${happyFails} APIs did NOT return 200 via proxy`);
        failed += happyFails;
      } else {
        console.log('[fixture-smoke] e2e-happy default=200 via proxy: verified');
      }
    } finally {
      await proxy.close();
    }
  } finally {
    await srv.close();
  }

  if (failed > 0) {
    console.error(`[fixture-smoke] FAILED: ${failed} failures`);
    process.exitCode = 1;
  } else {
    console.log('[fixture-smoke] PASS');
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error(`[fixture-smoke] error: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  });
}

module.exports = { run };
