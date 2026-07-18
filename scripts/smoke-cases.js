'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  resolveProjectSlug,
  projectDataDir,
  ensureProjectDirs,
} = require('../lib/paths');
const {
  loadContractsForCatalog,
  handlerExistsForContract,
} = require('../lib/catalog-merge');
const { loadSession } = require('../lib/session-config');
const { appendAudit } = require('../lib/audit');

const DEFAULT_SKIP_CASES = ['timeout', 'offline'];

function requestJson(url, headers = {}, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
          resolve({ status: res.statusCode, body, headers: res.headers });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function expectedStatusFor(caseId, contractCase) {
  return contractCase?.httpStatus || 200;
}

async function smokeCases(opts = {}) {
  const projectSlug = resolveProjectSlug(
    opts.projectDir || process.cwd(),
    opts.name,
  );
  ensureProjectDirs(projectSlug);
  const cfg = loadSession(projectSlug);
  const contracts = loadContractsForCatalog(projectSlug);
  if (!contracts.length) {
    throw new Error('no contracts — run mox init first');
  }

  const ci = Boolean(opts.ci);
  const includeCases = opts.cases
    ? new Set(opts.cases.split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  const skipCases = ci ? new Set(DEFAULT_SKIP_CASES) : new Set();

  const mockBase = `http://${cfg.mock.host}:${cfg.mock.port}`;
  const caseHeader = cfg.proxy?.injectCaseHeader || 'x-mock-case';
  const results = [];
  let failed = 0;
  let skippedNoHandler = 0;

  for (const contract of contracts) {
    if (!handlerExistsForContract(contract, projectSlug)) {
      skippedNoHandler++;
      continue;
    }
    const cases = contract.cases || [{ id: 'success', httpStatus: 200 }];
    for (const c of cases) {
      if (includeCases && !includeCases.has(c.id)) continue;
      if (!includeCases && skipCases.has(c.id)) continue;

      const url = `${mockBase}${contract.path}`;
      const expected = expectedStatusFor(c.id, c);
      const fwdHost = contract.hosts?.[0] || contract.host || 'localhost';
      const stubIdVal = contract.stubId || contract.id;
      try {
        const res = await requestJson(url, {
          [caseHeader]: c.id,
          'x-forwarded-host': fwdHost === '_default' ? 'localhost' : fwdHost,
          'x-mock-stub-id': encodeURIComponent(stubIdVal),
          host: `${cfg.mock.host}:${cfg.mock.port}`,
        });
        const ok = ci ? res.status === expected : true;
        if (!ok) failed++;
        results.push({
          api: contract.id,
          caseId: c.id,
          status: res.status,
          expected,
          code: res.body?.code,
          ok,
        });
      } catch (e) {
        const expectedError = skipCases.has(c.id);
        const ok = expectedError;
        if (!ok) failed++;
        results.push({
          api: contract.id,
          caseId: c.id,
          expected,
          ok,
          error: e.message,
        });
      }
    }
  }

  const report = path.join(
    projectDataDir(projectSlug),
    'reports',
    `smoke-${Date.now()}.md`,
  );
  const md = [
    '# smoke report',
    '',
    `- mock: ${mockBase}`,
    `- ci: ${ci}`,
    `- total: ${results.length}`,
    `- failed: ${failed}`,
    `- skippedNoHandler: ${skippedNoHandler}`,
    '',
    ...results.map(
      (r) =>
        `- ${r.ok ? 'OK' : 'FAIL'} ${r.api} case=${r.caseId} status=${r.status || '-'} expected=${r.expected} code=${r.code ?? r.error ?? '-'}`,
    ),
    '',
  ].join('\n');
  fs.writeFileSync(report, md);
  appendAudit(projectSlug, {
    command: 'smoke',
    taskId: opts.taskId || null,
    summary: `ci=${ci} total=${results.length} failed=${failed}`,
  });
  console.log(md);
  console.log(`[mox] smoke report: ${report}`);
  if (ci && results.length === 0) {
    console.error('[mox] smoke --ci: no handlers to smoke (all contracts skipped)');
    failed = failed || 1;
  }
  if (failed) process.exitCode = 1;
  return { results, failed, report, skippedNoHandler };
}

module.exports = { smokeCases };

if (require.main === module) {
  smokeCases({ projectDir: process.cwd() }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
