'use strict';

/**
 * list-empty — read persisted contracts for a project slug and surface
 * empty / low-fidelity stubs, optionally filtered by gap type.
 *
 * Used by `mox list-empty [--gap=]` and by reports.
 *
 * "Empty" here means: needs capture-merge or import-openapi to become useful.
 * A captured stub (L2) with an empty shape is NOT listed — it already has a
 * real body in cases.success.response.data.
 */

const fs = require('fs');
const path = require('path');
const { loadContractsForCatalog } = require('./catalog-merge');
const { classifyFidelity, FIDELITY_LEVELS } = require('./gap-taxonomy');

function _loadContracts(projectSlug) {
  return loadContractsForCatalog(projectSlug);
}

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

/**
 * List stubs that are "empty" (need filling).
 * Returns array of { stubId, fidelity, gaps, exportHint, upgradeHint }.
 */
function listEmptyStubs(projectSlug, opts = {}) {
  const gapFilter = opts.gap || null;
  const contracts = _loadContracts(projectSlug);
  const rows = [];
  for (const c of contracts) {
    const fid = classifyFidelity(c);
    // L2+ stubs already have real data; not candidates for capture-merge
    if (fid === 'L2' || fid === 'L3') continue;
    const shape = c.response && c.response.shape;
    if (!_shapeIsEmpty(shape)) continue; // has usage shape → L1, not "empty"
    const gaps = (c.coverage && Array.isArray(c.coverage.gaps)) ? c.coverage.gaps : [];
    if (gapFilter && !gaps.includes(gapFilter)) continue;
    rows.push({
      stubId: c.stubId || c.id,
      fidelity: fid,
      gaps,
      exportHint: c.exportHint || null,
      upstreamId: c.upstreamId || null,
      upgradeHint: FIDELITY_LEVELS[fid].upgradeHint,
    });
  }
  return rows;
}

/**
 * Group all stubs by fidelity level.
 * Returns { L0: [...], L1: [...], L2: [...], L3: [...] } with stubId + gaps.
 */
function listByFidelity(projectSlug) {
  const contracts = _loadContracts(projectSlug);
  const out = { L0: [], L1: [], L2: [], L3: [] };
  for (const c of contracts) {
    const fid = classifyFidelity(c);
    out[fid].push({
      stubId: c.stubId || c.id,
      gaps: (c.coverage && Array.isArray(c.coverage.gaps)) ? c.coverage.gaps : [],
    });
  }
  return out;
}

module.exports = {
  listEmptyStubs,
  listByFidelity,
};
