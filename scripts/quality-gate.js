'use strict';

/**
 * mox quality-gate —提测门禁（Z1）
 * exit 0 = 允许提测；exit≠0 = 禁止宣称「前端问题零溢出」。
 *
 * Checks:
 * 1. No TRACE_EMPTY / empty unmerged success.data in mounted catalog
 * 2. If scenario has requiredStubs, all exist and non-empty
 * 3. Write .data/reports/quality-gate-*.json
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { reportsDir, ensureDataDirs, scenariosDir } = require('../lib/paths');
const { listEmptyStubs } = require('../lib/list-empty');
const { loadSession } = require('../lib/session-config');
const { resolveActiveCatalogs, handlerExistsForContract, loadContractsAcross } = require('../lib/catalog-merge');

function parseArgs(argv) {
  const out = { requireMitmCheck: null, scenario: null, name: null };
  for (const a of argv) {
    if (a.startsWith('--require-mitm-check=')) {
      out.requireMitmCheck = a.slice('--require-mitm-check='.length);
    } else if (a.startsWith('--scenario=')) {
      out.scenario = a.slice('--scenario='.length);
    } else if (a.startsWith('--name=')) {
      out.name = a.slice('--name='.length);
    }
  }
  return out;
}

function loadScenarioRequiredStubs(scenarioName) {
  if (!scenarioName) return null;
  const dir = scenariosDir();
  const file = path.join(dir, `${scenarioName}.json`);
  if (!fs.existsSync(file)) {
    // also check examples / builtin
    const alt = path.join(__dirname, '..', 'examples', 'scenarios', `${scenarioName}.json`);
    if (fs.existsSync(alt)) {
      return JSON.parse(fs.readFileSync(alt, 'utf8'));
    }
    return { missingFile: true, requiredStubs: [] };
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function probeMitmCheck(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: 5000, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let ok = res.statusCode === 200 && /ok/i.test(body);
        try {
          const j = JSON.parse(body);
          if (j.ok === true || j.status === 'ok') ok = true;
        } catch {
          /* text ok */
        }
        resolve({ ok, status: res.statusCode, body: body.slice(0, 200) });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
  });
}

async function runQualityGate(opts = {}) {
  ensureDataDirs();
  const session = loadSession();
  const catalogs = resolveActiveCatalogs({
    names: opts.name
      ? String(opts.name).split(',')
      : session.activeCatalogs,
    allIfEmpty: true,
  });

  const emptyRows = listEmptyStubs(catalogs.length ? catalogs : null);
  const traceEmpty = emptyRows.filter(
    (r) =>
      (r.gaps || []).includes('TRACE_EMPTY') ||
      r.fidelity === 'L0',
  );

  const failures = [];
  if (traceEmpty.length) {
    failures.push({
      code: 'TRACE_EMPTY',
      message: `${traceEmpty.length} empty / TRACE_EMPTY stub(s)`,
      stubs: traceEmpty.map((r) => r.stubId),
    });
  }

  const scenarioName = opts.scenario || session.scenario || null;
  const scenario = loadScenarioRequiredStubs(scenarioName);
  if (scenario && Array.isArray(scenario.requiredStubs) && scenario.requiredStubs.length) {
    const contracts = loadContractsAcross(catalogs.length ? catalogs : null);
    const byId = new Map(contracts.map((c) => [c.stubId || c.id, c]));
    for (const stubId of scenario.requiredStubs) {
      const c = byId.get(stubId);
      if (!c) {
        failures.push({
          code: 'REQUIRED_STUB_MISSING',
          message: `requiredStub missing: ${stubId}`,
          stubId,
        });
        continue;
      }
      const gaps = (c.coverage && c.coverage.gaps) || [];
      if (gaps.includes('TRACE_EMPTY')) {
        failures.push({
          code: 'REQUIRED_STUB_EMPTY',
          message: `requiredStub empty: ${stubId}`,
          stubId,
        });
      }
      if (!handlerExistsForContract(c)) {
        failures.push({
          code: 'REQUIRED_STUB_NO_HANDLER',
          message: `requiredStub has no handler: ${stubId}`,
          stubId,
        });
      }
    }
  }

  let mitmProbe = null;
  if (opts.requireMitmCheck) {
    mitmProbe = await probeMitmCheck(opts.requireMitmCheck);
    if (!mitmProbe.ok) {
      failures.push({
        code: 'MITM_CHECK_FAILED',
        message: `mitm-check probe not ok: ${opts.requireMitmCheck}`,
        probe: mitmProbe,
      });
    }
  }

  const report = {
    at: new Date().toISOString(),
    ok: failures.length === 0,
    catalogs,
    scenario: scenarioName,
    emptyCount: emptyRows.length,
    traceEmptyCount: traceEmpty.length,
    failures,
    mitmProbe,
  };

  const stamp = report.at.replace(/[:.]/g, '-');
  const outPath = path.join(reportsDir(), `quality-gate-${stamp}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  report.reportPath = outPath;
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runQualityGate({
    requireMitmCheck: args.requireMitmCheck,
    scenario: args.scenario,
    name: args.name,
  });
  if (report.ok) {
    console.log(`[mox] quality-gate OK report=${report.reportPath}`);
    process.exit(0);
  }
  console.error(`[mox] quality-gate FAILED report=${report.reportPath}`);
  for (const f of report.failures) {
    console.error(`  - ${f.code}: ${f.message}`);
  }
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[mox] quality-gate error: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { runQualityGate, parseArgs, probeMitmCheck };
