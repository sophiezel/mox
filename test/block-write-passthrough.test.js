'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeProxyMode,
  resolveBlockWritePassthrough,
} = require('../lib/capture-filter');

test('resolveBlockWritePassthrough: mock-lab defaults to block writes', () => {
  assert.equal(resolveBlockWritePassthrough({}), true);
  assert.equal(resolveBlockWritePassthrough({ mode: 'mock-lab' }), true);
  assert.equal(
    resolveBlockWritePassthrough({ mode: 'mock-lab', blockWritePassthrough: false }),
    false,
  );
});

test('resolveBlockWritePassthrough: capture-open defaults to allow writes', () => {
  assert.equal(
    resolveBlockWritePassthrough({ mode: 'capture-open' }),
    false,
  );
  // Persisted mock-lab default true must not block once mode is capture-open
  // *and* CLI/session rewrite cleared the flag — explicit true still blocks.
  assert.equal(
    resolveBlockWritePassthrough({
      mode: normalizeProxyMode('capture-open'),
      blockWritePassthrough: true,
    }),
    true,
  );
  assert.equal(
    resolveBlockWritePassthrough({
      mode: 'capture-open',
      blockWritePassthrough: false,
    }),
    false,
  );
});
