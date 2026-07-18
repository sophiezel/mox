'use strict';

/**
 * Gap taxonomy + fidelity ladder — single source of truth.
 *
 * Gap types are produced by usage-io (scripts/infer-usage-io.js) and
 * capture-merge (scripts/capture-merge.js). This module is the canonical
 * list used by reports (scripts/init-project.js) and contracts.
 *
 * Design constraints:
 *  - No company brand strings; generic industry terms only.
 *  - Closed set: adding a gap requires updating tests + references.
 *  - Fidelity is derived from `response.source` + `response.shape` + `coverage.gaps`,
 *    never invented.
 */

const GAP_LAYERS = ['discover', 'bind', 'trace', 'value', 'unknown'];

const GAP_TYPES = {
  no_export_symbol: {
    layer: 'discover',
    staticallyResolvable: false,
    disposition: 'contract-only',
  },
  no_callsite: {
    layer: 'bind',
    staticallyResolvable: false,
    disposition: 'contract-only (dead export)',
  },
  bind_ambiguous: {
    layer: 'bind',
    staticallyResolvable: true,
    disposition: 'strengthen binding (exportKey / alias)',
  },
  TRACE_EMPTY: {
    layer: 'trace',
    staticallyResolvable: true,
    disposition: 'extend trace (BindingGraph) or capture-merge',
  },
  no_property_access: {
    layer: 'trace',
    staticallyResolvable: true,
    disposition: 'extend trace or capture-merge',
  },
  props_shallow_only: {
    layer: 'trace',
    staticallyResolvable: true,
    disposition: 'cross-file props-drill (BindingGraph edge)',
  },
  dynamic_key: {
    layer: 'trace',
    staticallyResolvable: false,
    disposition: 'capture-merge or import-openapi',
  },
};

const FIDELITY_LEVELS = {
  L0: {
    label: 'empty envelope',
    description: 'No response shape discovered; data is {} or null.',
    upgradeHint: 'Run `mox capture-merge` after browsing the flow, or `import-openapi` to supply shape.',
  },
  L1: {
    label: 'schema/usage shape + placeholder',
    description: 'Response shape inferred from usage (or OpenAPI); values are placeholders.',
    upgradeHint: 'Run `mox session` + `capture-merge` to replace placeholders with real values.',
  },
  L2: {
    label: 'captured example',
    description: 'Real response body captured via session and merged into the stub.',
    upgradeHint: 'Optional: add scenario cases via `set-case` for stateful behavior.',
  },
  L3: {
    label: 'scenario / stateful',
    description: 'Stub has multiple scenario cases beyond the standard success/empty/error set.',
    upgradeHint: 'L3 is reserved; not auto-detected from a single contract today.',
  },
};

function gapLayer(gap) {
  const meta = GAP_TYPES[gap];
  return meta ? meta.layer : 'unknown';
}

function _shapeHasFields(shape) {
  if (!shape || typeof shape !== 'object') return false;
  if (shape.type === 'array') {
    const item = shape.item || {};
    return Boolean(item.props && Object.keys(item.props).length > 0);
  }
  if (shape.type === 'object') {
    return Boolean(shape.props && Object.keys(shape.props).length > 0);
  }
  return false;
}

/**
 * Classify a contract's fidelity.
 * L0: empty shape + no capture
 * L1: non-empty shape (usage/openapi) but no capture
 * L2: capture present (source contains 'capture')
 * L3: reserved — not auto-detected today
 *
 * Defensive: missing fields collapse to L0.
 */
function classifyFidelity(contract) {
  if (!contract || typeof contract !== 'object') return 'L0';
  const resp = contract.response || {};
  const source = String(resp.source || 'empty');
  const shape = resp.shape || { type: 'object', props: {} };
  const hasCapture = source.indexOf('capture') !== -1;
  if (hasCapture) return 'L2';
  const hasShape = _shapeHasFields(shape);
  if (hasShape) return 'L1';
  return 'L0';
}

function _stubIdOf(contract) {
  if (!contract) return null;
  return contract.stubId || contract.id || contract.apiKey || null;
}

/**
 * Aggregate contracts into:
 *  - byGap: { [gapType]: [stubId,...] }   (only non-empty groups)
 *  - byLayer: { [layer]: N }              (count of stubs touching that layer)
 *  - fidelity: { L0: N, L1: N, L2: N, L3: N }
 *  - total: N
 */
function groupGaps(contracts) {
  const list = Array.isArray(contracts) ? contracts : [];
  const byGap = {};
  const byLayer = {};
  const fidelity = { L0: 0, L1: 0, L2: 0, L3: 0 };
  for (const c of list) {
    const sid = _stubIdOf(c) || `unknown-${Math.random().toString(36).slice(2, 8)}`;
    const gaps = (c && c.coverage && Array.isArray(c.coverage.gaps)) ? c.coverage.gaps : [];
    const fid = classifyFidelity(c);
    fidelity[fid] = (fidelity[fid] || 0) + 1;
    const layersTouched = new Set();
    for (const g of gaps) {
      if (!byGap[g]) byGap[g] = [];
      byGap[g].push(sid);
      const layer = gapLayer(g);
      if (layer !== 'unknown') layersTouched.add(layer);
    }
    for (const layer of layersTouched) {
      byLayer[layer] = (byLayer[layer] || 0) + 1;
    }
  }
  return {
    total: list.length,
    byGap,
    byLayer,
    fidelity,
  };
}

module.exports = {
  GAP_TYPES,
  GAP_LAYERS,
  FIDELITY_LEVELS,
  classifyFidelity,
  groupGaps,
  gapLayer,
};
