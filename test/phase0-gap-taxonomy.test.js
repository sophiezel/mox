'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GAP_TYPES,
  GAP_LAYERS,
  FIDELITY_LEVELS,
  classifyFidelity,
  groupGaps,
  gapLayer,
} = require('../lib/gap-taxonomy');

test('P0-G1: GAP_TYPES is a closed set matching infer-usage-io output', () => {
  const expected = [
    'no_export_symbol',
    'no_callsite',
    'bind_ambiguous',
    'TRACE_EMPTY',
    'no_property_access',
    'props_shallow_only',
    'dynamic_key',
  ];
  for (const g of expected) {
    assert.ok(GAP_TYPES[g], `missing gap type: ${g}`);
  }
  // closed set: no extra keys beyond expected + metadata
  for (const key of Object.keys(GAP_TYPES)) {
    assert.ok(expected.includes(key), `unexpected gap type: ${key}`);
  }
});

test('P0-G2: each gap type carries layer + staticallyResolvable + disposition', () => {
  for (const [name, meta] of Object.entries(GAP_TYPES)) {
    assert.ok(GAP_LAYERS.includes(meta.layer), `${name} layer invalid`);
    assert.equal(typeof meta.staticallyResolvable, 'boolean', `${name} staticallyResolvable missing`);
    assert.equal(typeof meta.disposition, 'string', `${name} disposition missing`);
    assert.ok(meta.disposition.length > 0, `${name} disposition empty`);
  }
});

test('P0-G3: gapLayer maps a gap to its failure layer', () => {
  assert.equal(gapLayer('no_export_symbol'), 'discover');
  assert.equal(gapLayer('no_callsite'), 'bind');
  assert.equal(gapLayer('bind_ambiguous'), 'bind');
  assert.equal(gapLayer('TRACE_EMPTY'), 'trace');
  assert.equal(gapLayer('no_property_access'), 'trace');
  assert.equal(gapLayer('props_shallow_only'), 'trace');
  assert.equal(gapLayer('dynamic_key'), 'trace');
  assert.equal(gapLayer('unknown_gap'), 'unknown');
});

test('P0-G4: GAP_TYPES contains no company brand strings', () => {
  const serialized = JSON.stringify(GAP_TYPES);
  assert.ok(!/guazi|tower|jian|company|brand/i.test(serialized), 'brand leak in gap taxonomy');
});

test('P0-F1: FIDELITY_LEVELS exposes L0..L3 with monotonic richness', () => {
  assert.deepEqual(Object.keys(FIDELITY_LEVELS), ['L0', 'L1', 'L2', 'L3']);
  for (const [k, v] of Object.entries(FIDELITY_LEVELS)) {
    assert.equal(typeof v.label, 'string');
    assert.equal(typeof v.description, 'string');
    assert.equal(typeof v.upgradeHint, 'string');
  }
});

test('P0-F2: classifyFidelity L0 = empty envelope, no shape, no capture', () => {
  const c = {
    response: { source: 'empty', shape: { type: 'object', props: {} } },
    coverage: { gaps: ['no_export_symbol'] },
  };
  assert.equal(classifyFidelity(c), 'L0');
});

test('P0-F3: classifyFidelity L0 also for TRACE_EMPTY with empty shape', () => {
  const c = {
    response: { source: 'empty', shape: { type: 'object', props: {} } },
    coverage: { gaps: ['TRACE_EMPTY'] },
  };
  assert.equal(classifyFidelity(c), 'L0');
});

test('P0-F4: classifyFidelity L1 = usage shape with placeholder (non-empty shape, source usage/empty/openapi)', () => {
  const c = {
    response: { source: 'usage', shape: { type: 'object', props: { id: { type: 'string' } } } },
    coverage: { gaps: [] },
  };
  assert.equal(classifyFidelity(c), 'L1');
});

test('P0-F5: classifyFidelity L1 for array shape with item props (placeholder)', () => {
  const c = {
    response: { source: 'empty',
      shape: { type: 'array', item: { type: 'object', props: { id: { type: 'string' } } } } },
    coverage: { gaps: [] },
  };
  assert.equal(classifyFidelity(c), 'L1');
});

test('P0-F6: classifyFidelity L2 = captured real body (source usage+capture or capture)', () => {
  for (const src of ['usage+capture', 'capture']) {
    const c = {
      response: { source: src, shape: { type: 'object', props: { id: { type: 'string' } } } },
      coverage: { gaps: [] },
    };
    assert.equal(classifyFidelity(c), 'L2', `source=${src}`);
  }
});

test('P0-F7: classifyFidelity L2 even when shape empty but capture present', () => {
  // capture-merge may fill data without enriching shape; source says captured
  const c = {
    response: { source: 'usage+capture', shape: { type: 'object', props: {} } },
    coverage: { gaps: [] },
  };
  assert.equal(classifyFidelity(c), 'L2');
});

test('P0-F8: classifyFidelity L3 when virtualService protocol present', () => {
  const c = {
    response: { source: 'usage+capture', shape: { type: 'object', props: { id: { type: 'string' } } } },
    coverage: { gaps: [] },
    cases: [{ id: 'success' }, { id: 'empty' }],
    virtualService: { protocol: 'paginated-list', resource: 'items' },
  };
  assert.equal(classifyFidelity(c), 'L3');
  const stillL2 = {
    response: { source: 'usage+capture', shape: { type: 'object', props: { id: { type: 'string' } } } },
    coverage: { gaps: [] },
    cases: [{ id: 'success' }, { id: 'empty' }],
  };
  assert.equal(classifyFidelity(stillL2), 'L2');
});

test('P0-F9: classifyFidelity handles missing fields defensively', () => {
  assert.equal(classifyFidelity({}), 'L0');
  assert.equal(classifyFidelity(null), 'L0');
  assert.equal(classifyFidelity(undefined), 'L0');
});

test('P0-G5: groupGaps aggregates stubs by gap type and layer', () => {
  const contracts = [
    { stubId: 'GET svc-a/v1/x', coverage: { gaps: ['TRACE_EMPTY'] },
      response: { source: 'empty', shape: { type: 'object', props: {} } } },
    { stubId: 'GET svc-a/v1/y', coverage: { gaps: ['no_callsite'] },
      response: { source: 'empty', shape: { type: 'object', props: {} } } },
    { stubId: 'GET svc-b/v1/z', coverage: { gaps: ['TRACE_EMPTY', 'props_shallow_only'] },
      response: { source: 'usage', shape: { type: 'object', props: {} } } },
    { stubId: 'GET svc-b/v1/w', coverage: { gaps: [] },
      response: { source: 'usage', shape: { type: 'object', props: { id: { type: 'string' } } } } },
  ];
  const grouped = groupGaps(contracts);
  assert.equal(grouped.byGap.TRACE_EMPTY.length, 2);
  assert.equal(grouped.byGap.no_callsite.length, 1);
  assert.equal(grouped.byGap.props_shallow_only.length, 1);
  assert.ok(!grouped.byGap.no_export_symbol || grouped.byGap.no_export_symbol.length === 0);
  // byLayer counts stubs per layer (a stub may appear in multiple layers)
  assert.ok(grouped.byLayer.trace >= 2);
  assert.ok(grouped.byLayer.bind >= 1);
});

test('P0-G6: groupGaps includes fidelity breakdown', () => {
  const contracts = [
    { stubId: 'a', coverage: { gaps: ['no_export_symbol'] },
      response: { source: 'empty', shape: { type: 'object', props: {} } } },
    { stubId: 'b', coverage: { gaps: [] },
      response: { source: 'usage', shape: { type: 'object', props: { id: { type: 'string' } } } } },
    { stubId: 'c', coverage: { gaps: [] },
      response: { source: 'usage+capture', shape: { type: 'object', props: { id: { type: 'string' } } } } },
  ];
  const grouped = groupGaps(contracts);
  assert.equal(grouped.fidelity.L0, 1);
  assert.equal(grouped.fidelity.L1, 1);
  assert.equal(grouped.fidelity.L2, 1);
  assert.equal(grouped.fidelity.L3, 0);
});

test('P0-G7: groupGaps uses stubId, falls back to id, then to apiKey', () => {
  const contracts = [
    { id: 'X', coverage: { gaps: ['TRACE_EMPTY'] },
      response: { source: 'empty', shape: { type: 'object', props: {} } } },
    { apiKey: 'Y', coverage: { gaps: ['no_callsite'] },
      response: { source: 'empty', shape: { type: 'object', props: {} } } },
  ];
  const grouped = groupGaps(contracts);
  assert.ok(grouped.byGap.TRACE_EMPTY.includes('X'));
  assert.ok(grouped.byGap.no_callsite.includes('Y'));
});

test('P0-G8: groupGaps tolerates contracts without coverage', () => {
  const contracts = [
    { stubId: 'a', response: { source: 'empty', shape: { type: 'object', props: {} } } },
  ];
  const grouped = groupGaps(contracts);
  // no coverage → treated as L0, no gap
  assert.equal(grouped.fidelity.L0, 1);
  assert.equal(Object.keys(grouped.byGap).length, 0);
});
