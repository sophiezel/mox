'use strict';

/**
 * list-empty — read persisted contracts and surface empty / low-fidelity stubs.
 *
 * Used by `mox list-empty [--gap=] [--name=upstreamId…]` and by reports.
 */

const { loadContractsAcross } = require('./catalog-merge');
const { classifyFidelity, FIDELITY_LEVELS } = require('./gap-taxonomy');

function _loadContracts(names) {
  return loadContractsAcross(names);
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
 * @param {string|string[]|null} names upstreamId(s); null/empty = all
 */
function listEmptyStubs(names, opts = {}) {
  const gapFilter = opts.gap || null;
  const contracts = _loadContracts(names);
  const rows = [];
  for (const c of contracts) {
    const fid = classifyFidelity(c);
    if (fid === 'L2' || fid === 'L3') continue;
    const shape = c.response && c.response.shape;
    if (!_shapeIsEmpty(shape)) continue;
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
 */
function listByFidelity(names) {
  const contracts = _loadContracts(names);
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
