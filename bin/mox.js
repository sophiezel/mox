#!/usr/bin/env node
'use strict';

const path = require('path');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { _: [], flags: {} };
  const multiKeys = new Set(['name', 'rules']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key;
      let value;
      if (eq !== -1) {
        key = a.slice(2, eq);
        value = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        if (key === 'rules') {
          const values = [];
          while (args[i + 1] && !args[i + 1].startsWith('-')) {
            values.push(args[++i]);
          }
          value = values.length ? values : true;
        } else {
          const next = args[i + 1];
          if (next && !next.startsWith('-')) {
            value = next;
            i++;
          } else {
            value = true;
          }
        }
      }
      if (multiKeys.has(key)) {
        const prev = out.flags[key];
        const add = Array.isArray(value)
          ? value
          : value === true
            ? []
            : String(value)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        if (Array.isArray(prev)) {
          out.flags[key] = prev.concat(add);
        } else if (prev != null && prev !== true) {
          out.flags[key] = [prev].concat(add);
        } else {
          out.flags[key] = add;
        }
      } else {
        out.flags[key] = value;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      out.flags[a.slice(1)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function help(full = false) {
  const primary = `
mox — frontend API mock CLI (single proxy, multi catalog)

Primary:
  mox init [scanDir] [--task=ID] [--adapter=name] [--force] [--strict-usage]
  mox start [--name=serviceId…] [--rules kw…] [--start-url=URL] [--scan-dir=DIR] [--scenario=NAME] [--proxy-host=HOST] [--mitm=0] [--keep-state] [--detach]
  mox stop [--auto-merge]
  mox rules list|use <kw…>|save <name> [--rules-dir=DIR]
  mox scenario <name>
  mox smoke [--name=serviceId…] [--ci] [--cases=...] [--scenario=NAME]
  mox trust-ca [--open]
  mox device prepare --lan-ip=<ip> [--proxy-port=18999]

Optional (needs real upstream; not for E2E):
  mox start --capture-open [--name=serviceId…]
  mox mock
  mox merge [--name=serviceId…]
`;

  const advanced = `
Advanced / legacy (see references/guide-l6-advanced.md):
  mox service reset|journal|status [--upstream=ID]
  mox domain-draft --upstream=ID [--confirm]
  mox materialize-service --upstream=ID [--force]
  mox classify [--task=ID] [--related-from=path]
  mox generate [--task=ID] [--force] [--overwrite-capture]
  mox session start|stop [...]
  mox set-case <apiId> <caseId>
  mox set-scenario <name>
  mox traffic <all-mock|all-passthrough|selective|allow|deny|list|clear> [stubId]
  mox map import <file> [--save-as=name]
  mox capture-merge [...]
  mox list-empty [--gap=GAP] [--all] [--name=serviceId…]
  mox quality-gate [--scenario=NAME] [--require-mitm-check=URL]
  mox import-openapi --from=<spec>
  mox export-msw [--out=path]
  mox audit [--task=ID] [--api=host/path]
  mox install | uninstall

Session security:
  --proxy-host=127.0.0.1  desktop-only bind (default: 0.0.0.0, Whistle-like LAN)
  --no-open-proxy         lock CONNECT/passthrough on LAN bind (default: allow, like Whistle)
  --allow-open-proxy      compat alias (default already allows open proxy on LAN)
  --mitm=0                disable HTTPS MITM (default: on; first start installs system CA if needed)

Flags:
  --name=a --name=b    mount service ids (or --name=a,b); omit = all services
  --rules a,b / kw…    selective mock from rules/*.json or Whistle *.txt; comma/space multi merge; missing names skipped; with --capture-open still selective + capture-open
  --rules-dir=DIR      override rules directory (default: <pkg>/rules)
  --capture-open       proxy.mode=capture-open (widen MITM capture); pure all-passthrough: mox traffic all-passthrough
  --auto-merge         with stop: run capture-merge after stop
  --keep-state         with start: do not reset Virtual Service store / journal
  --detach             with start: spawn background session (survives shell exit); stop via mox stop
`;

  const footer = `
Install: bash scripts/install.sh
Catalog: .data/services/<serviceId>/   Ops: .data/{classify,reports,audit,scenarios}/
Session: .data/session.json   Rules: rules/
Glossary: docs/GLOSSARY.md
Learn:   references/learning-path.md  (L0→L6 layered guides)
Help:    mox help --all
`;

  console.log(
    full
      ? primary + advanced + footer
      : primary +
          `\n  mox help --all   # advanced commands (service / domain-draft / …)\n` +
          footer,
  );
}

/**
 * Map common errors to layered guide anchors (progressive disclosure).
 * @param {string} message
 * @returns {string|null}
 */
function hintForError(message) {
  const m = String(message || '');
  if (/port in use|EADDRINUSE/i.test(m)) {
    return 'see: references/guide-l0-getting-started.md#port-in-use';
  }
  if (/no classify|classify result|run mox init/i.test(m)) {
    return 'see: references/guide-l1-frontend-infer.md#no-classify';
  }
  if (/mutually exclusive|--rules forces|conflicting --traffic/i.test(m)) {
    return 'see: references/guide-l2-runtime.md#traffic-flags';
  }
  if (/unknown command/i.test(m)) {
    return 'see: references/guide-l6-advanced.md#commands';
  }
  if (/upstream|domain-draft|materialize|store handler|service reset/i.test(m)) {
    return 'see: references/guide-l6-advanced.md#repair';
  }
  if (/MITM|openssl|allow-open-proxy|0\.0\.0\.0/i.test(m)) {
    return 'see: references/guide-l2-runtime.md#device-proxy';
  }
  return 'see: references/learning-path.md';
}

function resolveStartTraffic(f) {
  const wantCaptureOpen = Boolean(f['capture-open']);
  const wantTraffic = f.traffic != null && f.traffic !== false && f.traffic !== '';
  const wantRules =
    f.rules != null &&
    f.rules !== false &&
    !(Array.isArray(f.rules) && f.rules.length === 0);
  if (wantCaptureOpen && wantTraffic) {
    throw new Error('--capture-open and --traffic= are mutually exclusive');
  }
  // --rules wins: stay selective; start-session sets proxy.mode=capture-open when --capture-open
  if (wantRules) {
    if (wantCaptureOpen) {
      console.log(
        '[mox] --capture-open with --rules: selective mock + capture-open',
      );
    }
    return null;
  }
  if (wantCaptureOpen) {
    console.log(
      '[mox] mode=capture-open (MITM decrypt+capture; map/allowlist still mock; all-passthrough → mox traffic all-passthrough)',
    );
    return null;
  }
  return wantTraffic ? f.traffic : null;
}

async function runSessionStart(f) {
  const wantDetach =
    f.detach === true || f.detach === '1' || f.detach === 1;

  if (wantDetach) {
    const fs = require('fs');
    const { spawn } = require('child_process');
    const {
      getDataRoot,
      getGlobalRuntimePath,
    } = require('../lib/paths');
    const childArgs = process.argv.slice(2).filter((a) => {
      if (a === '--detach') return false;
      if (a.startsWith('--detach=')) return false;
      return true;
    });
    // Detached sessions never auto-launch Chrome (no TTY / no GUI assumption).
    if (
      !childArgs.includes('--no-auto-launch') &&
      !childArgs.some((a) => a.startsWith('--no-auto-launch='))
    ) {
      childArgs.push('--no-auto-launch');
    }
    const logPath = path.join(getDataRoot(), 'session-start.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const outFd = fs.openSync(logPath, 'a');
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'mox.js'), ...childArgs],
      {
        detached: true,
        stdio: ['ignore', outFd, outFd],
        env: process.env,
        cwd: process.cwd(),
      },
    );
    child.unref();
    try {
      fs.closeSync(outFd);
    } catch {
      /* ignore */
    }

    const deadline = Date.now() + 10000;
    let state = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        if (!fs.existsSync(getGlobalRuntimePath())) continue;
        state = JSON.parse(fs.readFileSync(getGlobalRuntimePath(), 'utf8'));
        if (state?.mock?.pid === child.pid) break;
      } catch {
        /* retry */
      }
    }
    console.log(
      `[mox] detached pid=${child.pid} (stop with: mox stop) log=${logPath}`,
    );
    if (state?.mock?.port) {
      console.log(
        `[mox] mock http://${state.mock.host || '127.0.0.1'}:${state.mock.port}`,
      );
    }
    if (state?.proxy?.enabled && state.proxy.port) {
      console.log(
        `[mox] proxy http://${state.proxy.host || '127.0.0.1'}:${state.proxy.port}`,
      );
    }
    return;
  }

  const { startSession } = require('../scripts/start-session');
  const traffic = resolveStartTraffic(f);
  await startSession({
    projectDir: process.cwd(),
    name: f.name,
    names: f.name,
    rules: f.rules,
    rulesDir: f['rules-dir'],
    taskId: f.task || null,
    mockPort: f['mock-port'],
    proxyPort: f['proxy-port'],
    proxyHost: f['proxy-host'],
    proxy: f.proxy,
    startUrl: f['start-url'],
    scanDir: f['scan-dir'] || undefined,
    autoLaunch: f['no-auto-launch'] ? false : undefined,
    scenario: f.scenario,
    allowOpenProxy: f['no-open-proxy']
      ? false
      : f['allow-open-proxy']
        ? true
        : undefined,
    noOpenProxy: Boolean(f['no-open-proxy']),
    mitm:
      f.mitm === false || f.mitm === '0' || f.mitm === 0
        ? false
        : f.mitm === true || f.mitm === '1' || f.mitm === 1
          ? true
          : undefined,
    recordMockHits: Boolean(f['record-mock-hits']),
    captureOpen: Boolean(f['capture-open']),
    traffic,
    keepState: Boolean(f['keep-state']),
  });
}

function runSessionStop(f) {
  const { stopSession } = require('../scripts/stop-session');
  stopSession({
    projectDir: process.cwd(),
    name: f.name,
    taskId: f.task || null,
    autoMerge: Boolean(f['auto-merge']),
  });
}

function runTraffic(f, action, stubId) {
  const { setTraffic } = require('../scripts/set-traffic');
  if (action === 'allow' || action === 'deny') {
    setTraffic({
      projectDir: process.cwd(),
      name: f.name,
      action,
      stubId,
    });
    return;
  }
  setTraffic({
    projectDir: process.cwd(),
    name: f.name,
    action: action || 'list',
  });
}

function runMerge(f) {
  const { captureMerge } = require('../scripts/capture-merge');
  captureMerge({
    taskId: f.task || null,
    sanitize: f.sanitize !== false,
    sensitivePaths: f['sensitive-paths']
      ? String(f['sensitive-paths'])
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  });
}

function runScenario(f, scenario) {
  const { setScenario } = require('../scripts/set-scenario');
  setScenario({
    projectDir: process.cwd(),
    name: f.name,
    scenario,
    taskId: f.task || null,
  });
}

async function main() {
  const parsed = parseArgs(process.argv);
  const cmd = parsed._[0] || 'help';
  const rest = parsed._.slice(1);
  const f = parsed.flags;

  if (cmd === 'help' || f.help || f.h || f['help-all']) {
    help(
      Boolean(f.all) ||
        Boolean(f['help-all']) ||
        rest[0] === '--all' ||
        rest[0] === 'all',
    );
    return;
  }

  if (cmd === 'install') {
    const { spawnSync } = require('child_process');
    const sh = path.join(__dirname, '..', 'scripts', 'install.sh');
    const r = spawnSync('bash', [sh], { stdio: 'inherit' });
    process.exit(r.status || 0);
  }

  if (cmd === 'uninstall') {
    const { spawnSync } = require('child_process');
    const sh = path.join(__dirname, '..', 'scripts', 'uninstall.sh');
    const r = spawnSync('bash', [sh], { stdio: 'inherit' });
    process.exit(r.status || 0);
  }

  if (cmd === 'init') {
    const { initProject } = require('../scripts/init-project');
    await initProject({
      projectDir: rest[0] || process.cwd(),
      name: f.name,
      taskId: f.task || null,
      relatedFrom: f['related-from'] || null,
      adapter: f.adapter || null,
      force: Boolean(f.force),
      overwriteCapture: Boolean(f['overwrite-capture']),
      strictUsage: Boolean(f['strict-usage']),
      writeProjectConfig: Boolean(f['write-project-config']),
    });
    return;
  }

  if (cmd === 'classify') {
    const { inferApiUsage } = require('../scripts/infer-api-usage');
    const { classifyRequests, writeClassifyResult } = require('../scripts/classify-requests');
    const { ensureDataDirs, resolveScanLabel } = require('../lib/paths');
    const { loadExistingContracts, listExistingMockKeys } = require('../scripts/generate-mock');
    const projectDir = rest[0] || process.cwd();
    ensureDataDirs();
    const label = resolveScanLabel(projectDir, f.name);
    const apis = inferApiUsage(projectDir);
    const result = classifyRequests({
      apis,
      taskId: f.task || null,
      relatedFrom: f['related-from'] || null,
      existingMockKeys: listExistingMockKeys(),
      existingContracts: loadExistingContracts(),
    });
    const file = writeClassifyResult(label, result);
    console.log(
      `[mox] wrote ${file} (${result.roles.length} roles, ${result.conflicts.length} conflicts)`,
    );
    return;
  }

  if (cmd === 'generate') {
    const { ensureDataDirs, classifyDir, resolveScanLabel } = require('../lib/paths');
    const { generateMocks } = require('../scripts/generate-mock');
    const fs = require('fs');
    const projectDir = rest[0] || process.cwd();
    ensureDataDirs();
    const label = resolveScanLabel(projectDir, f.name);
    const rolesFile = path.join(classifyDir(), 'request-roles.json');
    if (!fs.existsSync(rolesFile)) {
      throw new Error('no classify result — run mox init or classify first');
    }
    const classified = JSON.parse(fs.readFileSync(rolesFile, 'utf8'));
    const gen = generateMocks({
      projectSlug: label,
      roles: classified.roles,
      conflicts: classified.conflicts || [],
      taskId: f.task || classified.taskId || null,
      force: Boolean(f.force),
      merge: !f.force,
      overwriteCapture: Boolean(f['overwrite-capture']),
    });
    console.log(`[mox] generate`, gen);
    return;
  }

  // Intent aliases (primary track)
  if (cmd === 'start') {
    await runSessionStart(f);
    return;
  }
  if (cmd === 'stop') {
    runSessionStop(f);
    return;
  }
  if (cmd === 'rules') {
    const { runRules } = require('../scripts/rules-cli');
    const sub = rest[0] || 'list';
    if (sub === 'list') {
      runRules({ action: 'list', rulesDir: f['rules-dir'] });
      return;
    }
    if (sub === 'use') {
      runRules({
        action: 'use',
        keywords: rest.slice(1),
        rulesDir: f['rules-dir'],
      });
      return;
    }
    if (sub === 'save') {
      runRules({
        action: 'save',
        name: rest[1] || rest[0],
        rulesDir: f['rules-dir'],
      });
      return;
    }
    console.error('Usage: mox rules list|use <kw…>|save <name>');
    process.exit(1);
  }
  if (cmd === 'map') {
    const sub = rest[0];
    if (sub === 'import') {
      const file = rest[1] || f.from || f.file;
      if (!file) {
        console.error('Usage: mox map import <file>');
        process.exit(1);
      }
      const { applyMapImport } = require('../lib/map-import');
      try {
        const out = applyMapImport(file, {
          saveAs: f['save-as'] || 'map-import',
          rulesDir: f['rules-dir'],
        });
        console.log(
          `[mox] map import rows=${out.rows.length} stubs=${out.stubIds.length} hosts=${out.hosts.join(',')}`,
        );
        console.log(
          `[mox] trafficMode=selective allowlist=${out.session.proxy.mockAllowlist.length}`,
        );
        if (out.savedRule) {
          console.log(`[mox] rules pack saved: ${out.savedRule.name}`);
        }
      } catch (e) {
        console.error(`[mox] ${e.message}`);
        process.exit(1);
      }
      return;
    }
    console.error('Usage: mox map import <file>');
    process.exit(1);
  }
  if (cmd === 'service') {
    const { runService } = require('../scripts/service-cli');
    runService({ _: [cmd, ...rest], flags: f });
    return;
  }
  if (cmd === 'domain-draft') {
    const { runDomainDraft } = require('../scripts/domain-draft-cli');
    runDomainDraft({ _: [cmd, ...rest], flags: f });
    return;
  }
  if (cmd === 'materialize-service') {
    const { runMaterializeService } = require('../scripts/domain-draft-cli');
    runMaterializeService({ _: [cmd, ...rest], flags: f });
    return;
  }
  if (cmd === 'scenario') {
    runScenario(f, rest[0]);
    return;
  }
  if (cmd === 'trust-ca') {
    const { trustCa } = require('../scripts/trust-ca');
    trustCa({ open: Boolean(f.open) });
    return;
  }
  if (cmd === 'device') {
    const sub = rest[0];
    if (sub === 'prepare') {
      const { devicePrepare } = require('../scripts/device-prepare');
      try {
        devicePrepare({
          lanIp: f['lan-ip'] || f.lanIp || rest[1],
          proxyPort: Number(f['proxy-port'] || f.proxyPort || 18999),
          catalogHost: f['catalog-host'] || undefined,
        });
      } catch (e) {
        console.error(`[mox] ${e.message}`);
        process.exit(1);
      }
      return;
    }
    console.error('Usage: mox device prepare --lan-ip=<ip> [--proxy-port=18999]');
    process.exit(1);
  }
  if (cmd === 'mock') {
    runTraffic(f, 'all-mock');
    return;
  }
  if (cmd === 'merge') {
    runMerge(f);
    return;
  }

  if (cmd === 'session') {
    const sub = rest[0];
    if (sub === 'start') {
      await runSessionStart(f);
      return;
    }
    if (sub === 'stop') {
      runSessionStop(f);
      return;
    }
    console.error('Usage: mox session start|stop');
    process.exit(1);
  }

  if (cmd === 'set-case') {
    const { setCase } = require('../scripts/set-case');
    setCase({
      projectDir: process.cwd(),
      name: f.name,
      apiId: rest[0],
      caseId: rest[1],
      taskId: f.task || null,
    });
    return;
  }

  if (cmd === 'set-scenario') {
    runScenario(f, rest[0]);
    return;
  }

  if (cmd === 'traffic') {
    const sub = rest[0];
    if (sub === 'allow' || sub === 'deny') {
      runTraffic(f, sub, rest.slice(1).join(' ') || rest[1]);
      return;
    }
    runTraffic(f, sub || 'list');
    return;
  }

  if (cmd === 'smoke') {
    const { smokeCases } = require('../scripts/smoke-cases');
    if (f.scenario) {
      runScenario(f, f.scenario);
    }
    await smokeCases({
      projectDir: process.cwd(),
      name: f.name,
      taskId: f.task || null,
      ci: Boolean(f.ci),
      cases: f.cases,
    });
    return;
  }

  if (cmd === 'audit') {
    const { readAudit } = require('../lib/audit');
    const rows = readAudit({ taskId: f.task, api: f.api });
    console.log(JSON.stringify(rows, null, 2));
    console.log(`[mox] ${rows.length} audit rows`);
    return;
  }

  if (cmd === 'capture-merge') {
    runMerge(f);
    return;
  }

  if (cmd === 'list-empty') {
    const { parseNameList } = require('../lib/catalog-merge');
    const { listEmptyStubs, listByFidelity } = require('../lib/list-empty');
    const names = parseNameList(f.name);
    const scope = names.length ? names : null;
    if (f.all) {
      const grouped = listByFidelity(scope);
      for (const lvl of ['L0', 'L1', 'L2', 'L3']) {
        console.log(`## ${lvl} (${grouped[lvl].length})`);
        for (const r of grouped[lvl]) {
          console.log(`- ${r.stubId}${r.gaps.length ? ` — ${r.gaps.join(',')}` : ''}`);
        }
      }
      return;
    }
    const rows = listEmptyStubs(scope, { gap: f.gap || null });
    if (!rows.length) {
      console.log('[mox] no empty stubs — all stubs have shape or capture');
      return;
    }
    console.log(`[mox] ${rows.length} empty stub(s) needing capture-merge / import-openapi:`);
    for (const r of rows) {
      console.log(
        `- ${r.stubId} [${r.fidelity}]${r.gaps.length ? ` gaps=${r.gaps.join(',')}` : ''}${r.exportHint ? ` export=${r.exportHint}` : ''}`,
      );
      console.log(`    upgrade: ${r.upgradeHint}`);
    }
    return;
  }

  if (cmd === 'quality-gate') {
    const { runQualityGate } = require('../scripts/quality-gate');
    const report = await runQualityGate({
      requireMitmCheck: f['require-mitm-check'] || null,
      scenario: f.scenario || null,
      name: Array.isArray(f.name) ? f.name.join(',') : f.name || null,
    });
    if (report.ok) {
      console.log(`[mox] quality-gate OK report=${report.reportPath}`);
      process.exitCode = 0;
      return;
    }
    console.error(`[mox] quality-gate FAILED report=${report.reportPath}`);
    for (const fail of report.failures) {
      console.error(`  - ${fail.code}: ${fail.message}`);
    }
    process.exitCode = 1;
    return;
  }

  if (cmd === 'import-openapi') {
    const { importOpenApi } = require('../scripts/import-openapi');
    importOpenApi({
      projectDir: process.cwd(),
      name: f.name,
      from: f.from,
      taskId: f.task || null,
      force: Boolean(f.force),
    });
    return;
  }

  if (cmd === 'export-msw') {
    const { exportMsw } = require('../scripts/export-msw');
    exportMsw({
      projectDir: process.cwd(),
      name: f.name,
      out: f.out,
      taskId: f.task || null,
    });
    return;
  }

  console.error(`[mox] unknown command: ${cmd}`);
  const hint = hintForError('unknown command');
  if (hint) console.error(`[mox] ${hint}`);
  help();
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[mox] error: ${e.message}`);
    const hint = hintForError(e.message);
    if (hint) console.error(`[mox] ${hint}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, resolveStartTraffic, help, hintForError };
