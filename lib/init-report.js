'use strict';

/**
 * Init report builder — extracted from scripts/init-project.js so the
 * gap taxonomy + fidelity metrics are unit-testable without a real project.
 *
 * Output:
 *  - computeStubMetrics(apiList) → { stubsTotal, upstreamsTotal, multiHostStubs,
 *      emptyStubs, emptyStubIds, fidelity, gapsByType, emptyStubsByGap, deadExports }
 *  - buildInitReport({ apiList, gen, roles, projectDir, projectSlug, taskId })
 *      → { md, summary }
 */

const {
  classifyFidelity,
  groupGaps,
  gapLayer,
  GAP_TYPES,
  FIDELITY_LEVELS,
} = require('./gap-taxonomy');

function _shapeIsEmpty(shape) {
  if (!shape || typeof shape !== 'object') return true;
  if (shape.type === 'array') {
    const item = shape.item || {};
    return !item.props || Object.keys(item.props).length === 0;
  }
  if (shape.type === 'object') {
    return !shape.props || Object.keys(shape.props).length === 0;
  }
  return false;
}

function _toContractShape(api) {
  // apiList entries carry responseShape + responseSource (capture marker);
  // synthesize a contract-like object for classifyFidelity.
  const source = api.responseSource
    || (api.coverage && api.coverage.captureMerged ? 'usage+capture' : 'usage');
  return {
    response: {
      source,
      shape: api.responseShape || { type: 'object', props: {} },
    },
    coverage: api.coverage || { gaps: [] },
  };
}

function computeStubMetrics(apiList, existingContracts) {
  const contractByStub = existingContracts instanceof Map
    ? existingContracts
    : new Map((existingContracts || []).map((c) => [c.stubId || c.id, c]));
  const stubSet = new Set();
  const upstreamSet = new Set();
  let multiHostStubs = 0;
  let emptyStubs = 0;
  const emptyStubIds = [];
  const fidelity = { L0: 0, L1: 0, L2: 0, L3: 0 };
  const gapsByType = {};
  const emptyStubsByGap = {};
  const deadExports = [];

  for (const a of apiList) {
    const sid = a.stubId || a.id;
    if (!sid || stubSet.has(sid)) continue;
    stubSet.add(sid);
    if (a.upstreamId) upstreamSet.add(a.upstreamId);
    if (a.hosts && a.hosts.length >= 2) multiHostStubs++;

    // Prefer persisted contract for fidelity (carries capture state across re-init)
    const persisted = contractByStub.get(sid);
    const fidSource = persisted
      ? classifyFidelity(persisted)
      : classifyFidelity(_toContractShape(a));
    fidelity[fidSource] = (fidelity[fidSource] || 0) + 1;

    const gaps = (a.coverage && Array.isArray(a.coverage.gaps)) ? a.coverage.gaps : [];
    for (const g of gaps) {
      gapsByType[g] = (gapsByType[g] || 0) + 1;
    }

    if (_shapeIsEmpty(a.responseShape)) {
      emptyStubs++;
      emptyStubIds.push(sid);
      for (const g of gaps) {
        if (!emptyStubsByGap[g]) emptyStubsByGap[g] = [];
        emptyStubsByGap[g].push(sid);
      }
      // dead export candidate: empty + no_callsite
      if (gaps.includes('no_callsite')) {
        deadExports.push({
          stubId: sid,
          exportHint: a.exportHint || null,
          upstreamId: a.upstreamId || null,
        });
      }
    }
  }

  return {
    stubsTotal: stubSet.size,
    upstreamsTotal: upstreamSet.size,
    multiHostStubs,
    emptyStubs,
    emptyStubIds,
    fidelity,
    gapsByType,
    emptyStubsByGap,
    deadExports,
  };
}

function _fidelityLine(label) {
  const f = FIDELITY_LEVELS[label];
  return `- **${label}**: ${f.label} — ${f.description} _升级: ${f.upgradeHint}_`;
}

function buildInitReport({ apiList, gen, roles, projectDir, projectSlug, taskId, existingContracts }) {
  const metrics = computeStubMetrics(apiList, existingContracts);
  const gapLines = (gen.gapApis || [])
    .slice(0, 40)
    .map((g) => `- \`${g.id}\`: ${g.gaps.join(', ')}`);

  const md = [
    '# mox init report',
    '',
    `- projectDir: \`${projectDir}\``,
    `- projectSlug: \`${projectSlug}\``,
    `- taskId: \`${taskId || 'adhoc'}\``,
    `- discovered: ${apiList.length}`,
    `- stubsTotal: ${metrics.stubsTotal}`,
    `- upstreamsTotal: ${metrics.upstreamsTotal}`,
    `- multiHostStubs: ${metrics.multiHostStubs}`,
    `- emptyStubs: ${metrics.emptyStubs}`,
    `- generated: ${gen.generated}`,
    `- reused: ${gen.reused}`,
    `- skipped: ${gen.skipped}`,
    `- blocked: ${(gen.blocked || []).length}`,
    `- removedGatewayOnly: ${gen.removedGateway || 0}`,
    `- usageBackedCount: ${gen.usageBackedCount || 0}`,
    `- emptyDataCount: ${gen.emptyDataCount || 0}`,
    `- usageBackedHints: ${gen.usageBackedHints || 0}`,
    `- emptyDataHints: ${gen.emptyDataHints || 0}`,
    `- skippedEmptyCount: ${gen.skippedEmptyCount || 0}`,
    `- prunedHandlers: ${gen.prunedHandlers || 0}`,
    `- prunedContracts: ${gen.prunedContracts || 0}`,
    `- enumBackedCount: ${gen.enumBackedCount || 0}`,
    `- TRACE_EMPTY: ${gen.traceEmptyCount || 0}`,
    `- bind_ambiguous: ${gen.bindAmbiguousCount || 0}`,
    `- capturePreserved: ${gen.capturePreservedCount || 0}`,
    `- gatewayFilteredRoles: ${gen.gatewayFilteredRoles || 0}`,
    '',
    '## Stub catalog',
    '',
    `- **stubsTotal**: ${metrics.stubsTotal} unique stubs (METHOD + upstreamId + path), collapsed from ${apiList.length} API rows.`,
    `- **upstreamsTotal**: ${metrics.upstreamsTotal} unique upstream service identities.`,
    `- **multiHostStubs**: ${metrics.multiHostStubs} stubs with multiple environment hosts (matched via hosts[]).`,
    `- **emptyStubs**: ${metrics.emptyStubs} stubs with no response shape — candidates for capture-merge.`,
    '',
    '## Fidelity ladder',
    '',
    _fidelityLine('L0'),
    _fidelityLine('L1'),
    _fidelityLine('L2'),
    _fidelityLine('L3'),
    '',
    `**fidelity breakdown**: L0=${metrics.fidelity.L0} L1=${metrics.fidelity.L1} L2=${metrics.fidelity.L2} L3=${metrics.fidelity.L3}`,
    '',
    '## Gaps by type',
    '',
    ...Object.entries(metrics.gapsByType)
      .sort((a, b) => b[1] - a[1])
      .map(([g, n]) => `- **${g}**: ${n} stubs — ${GAP_TYPES[g] ? GAP_TYPES[g].disposition : '(unknown gap)'}`),
    metrics.gapsByType && Object.keys(metrics.gapsByType).length === 0
      ? '- _(no gaps detected)_'
      : '',
    '',
    '## Coverage note',
    '',
    '- **stubsTotal / upstreamsTotal**: post-collapse counts. One stub = one logical API; multi-env hosts are matchers, not duplicates.',
    '- **emptyStubs**: stubs with empty `responseShape`. These are generated as contract-only (no handler) when `no_export_symbol` gap exists. Run `mox capture-merge` to fill them with real response data.',
    '- **multiHostStubs**: stubs that match multiple environment hosts (e.g., prod + stage). The proxy matches any host in `hosts[]` to the same stub.',
    '- **Fidelity**: L0 empty / L1 usage-shape placeholder / L2 captured real body / L3 scenario. Upgrade path: capture-merge or import-openapi.',
    '- **Gaps by type**: aggregated from `coverage.gaps` per stub. See `references/infer-from-usage.md` for the gap taxonomy and dispositions.',
    '- **deadExports**: empty stubs with `no_callsite` gap — candidates for contract-only policy (Phase 3).',
    '- **emptyData**：`success.data` 无字段（静态用法倒推未抽出 props）。',
    '- **usageBackedHints / emptyDataHints**：按 `exportHint` 去重后的接口函数数。',
    '- **gaps**：静态分析声明的缺口（如 `no_export_symbol` / `no_callsite` / `TRACE_EMPTY` / `bind_ambiguous`）。',
    '- **TRACE_EMPTY**：有调用点但响应 shape 仍空——分层 trace 失败，不是「生成成功」。',
    '- **skippedEmpty**：`response.source===empty` 且 gaps 含 `no_export_symbol` → 只写 contract、不渲空 handler、不进 proxy-rules。',
    '- **prunedHandlers / prunedContracts**：`--force` 时删除不在本轮白名单且无 `mox:manual` 的孤儿产物；**默认不擦除** `usage+capture` 真值。',
    '- **capture-merge**：显式命令，写入真实响应并以 capture 数据为准（`response.source=usage+capture`）。不是补洞/自动兜底。',
    '- **覆盖矩阵**：普通 `init`/`generate` 保留已有 capture；仅 `--overwrite-capture` 允许 usage/jsf 盖掉 capture；裸 `--force` 不擦 capture。',
    '- 噪音过滤：跳过 `e2e/`、`*.spec.*`、`src/mock/`；pathLiteral 需 request 上下文。',
    '- 项目差异：`<project>/.mox/infer.json` 可覆盖 pathAliases / httpWrappers（合并 `config/default.infer.json`）。',
    '',
    '## Roles summary',
    '',
    ...['new', 'modify', 'dependency', 'unrelated'].map((role) => {
      const n = (roles || []).filter((r) => r.role === role).length;
      return `- ${role}: ${n}`;
    }),
    '',
    gapLines.length
      ? `## gapApis (sample)\n\n${gapLines.join('\n')}\n`
      : '',
    metrics.emptyStubsByGap && Object.keys(metrics.emptyStubsByGap).length
      ? `## Empty stubs by gap type\n\n${
          Object.entries(metrics.emptyStubsByGap)
            .sort((a, b) => b[1].length - a[1].length)
            .map(([g, ids]) => `### ${g} (${ids.length})\n\n${ids.slice(0, 50).map((id) => `- \`${id}\``).join('\n')}`)
            .join('\n\n')
        }\n`
      : (metrics.emptyStubIds.length
        ? `## Empty stubs (candidates for capture-merge)\n\n${metrics.emptyStubIds.slice(0, 50).map((id) => `- \`${id}\``).join('\n')}\n`
        : ''),
    metrics.deadExports.length
      ? `## Dead exports (no_callsite + empty)\n\n${metrics.deadExports.slice(0, 50).map((d) => `- \`${d.stubId}\`${d.exportHint ? ` — export: \`${d.exportHint}\`` : ''}`).join('\n')}\n`
      : '',
    '## Next',
    '',
    '```bash',
    `mox session start --name=${projectSlug}${taskId ? ` --task=${taskId}` : ''}`,
    '# after browsing main flows:',
    `mox capture-merge --name=${projectSlug}`,
    '# optionally fill shapes from OpenAPI:',
    `mox import-openapi --from=openapi.json --name=${projectSlug}`,
    '```',
    '',
  ].join('\n');

  const summary = {
    discovered: apiList.length,
    stubsTotal: metrics.stubsTotal,
    upstreamsTotal: metrics.upstreamsTotal,
    multiHostStubs: metrics.multiHostStubs,
    emptyStubs: metrics.emptyStubs,
    emptyStubIds: metrics.emptyStubIds,
    fidelity: metrics.fidelity,
    gapsByType: metrics.gapsByType,
    emptyStubsByGap: metrics.emptyStubsByGap,
    deadExports: metrics.deadExports,
    usageBackedCount: gen.usageBackedCount,
    emptyDataCount: gen.emptyDataCount,
    usageBackedHints: gen.usageBackedHints,
    emptyDataHints: gen.emptyDataHints,
    skippedEmptyCount: gen.skippedEmptyCount,
    prunedHandlers: gen.prunedHandlers || 0,
    prunedContracts: gen.prunedContracts || 0,
    enumBackedCount: gen.enumBackedCount,
    traceEmptyCount: gen.traceEmptyCount || 0,
    bindAmbiguousCount: gen.bindAmbiguousCount || 0,
    capturePreservedCount: gen.capturePreservedCount || 0,
    gapApis: gen.gapApis,
    removedGateway: gen.removedGateway,
  };

  return { md, summary, metrics };
}

module.exports = {
  buildInitReport,
  computeStubMetrics,
};
