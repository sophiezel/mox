'use strict';

const fs = require('fs');
const path = require('path');
const {
  resolveProjectSlug,
  ensureProjectDirs,
  projectDataDir,
} = require('../lib/paths');
const { appendAudit } = require('../lib/audit');
const { buildInitReport } = require('../lib/init-report');
const { inferApiUsage } = require('./infer-api-usage');
const { classifyRequests, writeClassifyResult } = require('./classify-requests');
const {
  generateMocks,
  loadExistingContracts,
  listExistingMockKeys,
} = require('./generate-mock');
const { copyBuiltinScenarios } = require('../lib/scenario');

async function initProject(opts = {}) {
  const projectDir = path.resolve(opts.projectDir || process.cwd());
  const taskId = opts.taskId || null;
  const force = Boolean(opts.force);
  const overwriteCapture = Boolean(opts.overwriteCapture);
  const strictUsage = Boolean(opts.strictUsage);
  const relatedFrom = opts.relatedFrom || null;
  const nameOverride = opts.name || null;

  if (!fs.existsSync(projectDir)) {
    throw new Error(`projectDir not found: ${projectDir}`);
  }

  const projectSlug = resolveProjectSlug(projectDir, nameOverride);
  ensureProjectDirs(projectSlug);
  const copiedScenarios = copyBuiltinScenarios(projectSlug);

  console.log(`[mox] init projectDir=${projectDir}`);
  console.log(`[mox] projectSlug=${projectSlug} taskId=${taskId || 'adhoc'}`);

  const apis = inferApiUsage(projectDir, {
    withUsageIo: true,
    adapter: opts.adapter || null,
    forceRefresh: Boolean(opts.force),
  });
  const meta = apis.meta || {};
  // apis is array with meta property
  const apiList = Array.isArray(apis) ? apis : [];
  console.log(`[mox] discovered ${apiList.length} APIs`);
  if (meta.gatewayFilteredCount) {
    console.log(
      `[mox] filtered gateway/base URLs≈${meta.gatewayFilteredCount}`,
    );
  }

  const existingContracts = loadExistingContracts(projectSlug);
  const existingMockKeys = listExistingMockKeys(projectSlug);

  const classified = classifyRequests({
    apis: apiList,
    taskId,
    relatedFrom,
    relatedPaths: opts.relatedPaths || [],
    modifiedFiles: opts.modifiedFiles || [],
    existingMockKeys,
    existingContracts,
  });

  // Carry enrichment fields from apis onto roles (keyed by stubId)
  const apiByKey = new Map();
  for (const a of apiList) {
    const sid =
      a.stubId ||
      `${(a.method || 'GET').toUpperCase()} ${(a.upstreamId || a.host || '_default')}${a.path}`;
    apiByKey.set(sid, a);
    // legacy FQDN key for transitional lookup
    apiByKey.set(
      `${(a.method || 'GET').toUpperCase()} ${a.host || '_default'}${a.path}`,
      a,
    );
  }
  classified.roles = classified.roles.map((r) => {
    const a = apiByKey.get(r.stubId || r.apiKey) || apiByKey.get(r.apiKey);
    if (!a) return r;
    return {
      ...r,
      stubId: a.stubId || r.stubId || r.apiKey,
      upstreamId: a.upstreamId || r.upstreamId,
      hosts: a.hosts?.length ? [...a.hosts] : r.hosts || [],
      canonicalHost: a.canonicalHost || r.canonicalHost || null,
      hostVar: a.hostVar || r.hostVar || null,
      prefixKey: a.prefixKey || r.prefixKey || null,
      queryHints: a.queryHints || r.queryHints,
      bodyHints: a.bodyHints || r.bodyHints,
      responseHints: a.responseHints || r.responseHints,
      responseShape: a.responseShape,
      coverage: a.coverage,
      exportHint: a.exportHint,
      exportKey: a.exportKey,
      confidence: a.confidence || r.confidence,
    };
  });

  writeClassifyResult(projectSlug, classified);

  const roles = classified.roles.map((r) => {
    if (!taskId) return { ...r, blocked: false };
    if (r.role === 'new' && !relatedFrom) return { ...r, blocked: true };
    if (r.role === 'new' && relatedFrom) return { ...r, blocked: false };
    return r;
  });

  const gen = generateMocks({
    projectSlug,
    roles,
    conflicts: classified.conflicts,
    taskId,
    force,
    merge: !force,
    overwriteCapture,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportName = taskId
    ? `init-${taskId}-${stamp}.md`
    : `init-${stamp}.md`;
  const reportPath = path.join(
    projectDataDir(projectSlug),
    'reports',
    reportName,
  );

  const { md, summary } = buildInitReport({
    apiList, gen, roles,
    projectDir, projectSlug, taskId,
    existingContracts,
  });
  const {
    stubsTotal,
    upstreamsTotal,
    multiHostStubs,
    emptyStubs,
  } = summary;

  fs.writeFileSync(reportPath, md);
  fs.writeFileSync(
    path.join(projectDataDir(projectSlug), 'reports', 'coverage-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  appendAudit(projectSlug, {
    command: 'init',
    taskId,
    summary: `discovered=${apiList.length} generated=${gen.generated} usageBacked=${gen.usageBackedCount} empty=${gen.emptyDataCount} TRACE_EMPTY=${gen.traceEmptyCount || 0} capturePreserved=${gen.capturePreservedCount || 0} fidelity=L0:${summary.fidelity.L0}/L1:${summary.fidelity.L1}/L2:${summary.fidelity.L2}/L3:${summary.fidelity.L3}`,
    reportPath,
  });

  console.log(`[mox] report: ${reportPath}`);
  if (copiedScenarios.length) {
    console.log(`[mox] scenarios copied: ${copiedScenarios.map((f) => f.replace(/\.json$/, '')).join(', ')}`);
  }
  console.log(
    `[mox] done stubs=${stubsTotal} upstreams=${upstreamsTotal} multiHost=${multiHostStubs} empty=${emptyStubs} fidelity=L0:${summary.fidelity.L0}/L1:${summary.fidelity.L1}/L2:${summary.fidelity.L2}/L3:${summary.fidelity.L3} generated=${gen.generated} usageBacked=${gen.usageBackedCount} emptyData=${gen.emptyDataCount} usageBackedHints=${gen.usageBackedHints || 0} emptyDataHints=${gen.emptyDataHints || 0} TRACE_EMPTY=${gen.traceEmptyCount || 0} capturePreserved=${gen.capturePreservedCount || 0} skippedEmpty=${gen.skippedEmptyCount || 0} prunedHandlers=${gen.prunedHandlers || 0} prunedContracts=${gen.prunedContracts || 0} gaps=${(gen.gapApis || []).length}`,
  );

  if (strictUsage && (gen.traceEmptyCount || 0) > 0) {
    const err = new Error(
      `strict-usage: TRACE_EMPTY=${gen.traceEmptyCount} (callsite with empty response shape)`,
    );
    err.code = 'STRICT_USAGE';
    throw err;
  }

  return {
    projectSlug,
    projectDir,
    apis: apiList,
    roles,
    gen,
    reportPath,
  };
}

module.exports = { initProject };

if (require.main === module) {
  initProject({
    projectDir: process.argv[2] || process.cwd(),
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
