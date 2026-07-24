'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inferOperatorsFromObservations } = require('../../lib/virtual-service/evidence-ops');

test('inferOperatorsFromObservations: eq when request field change correlates with result ids', () => {
  const ops = inferOperatorsFromObservations(
    [
      {
        requestBody: { page: 1, appointState: 7 },
        data: { detail: [{ id: 1, appointState: 7 }, { id: 2, appointState: 7 }] },
      },
      {
        requestBody: { page: 1, appointState: 8 },
        data: { detail: [{ id: 3, appointState: 8 }] },
      },
    ],
    { listKey: 'detail' },
  );
  const eq = ops.find((o) => o.type === 'eq' && o.field === 'appointState');
  assert.ok(eq, 'expected eq operator on appointState');
});

test('inferOperatorsFromObservations: no eq when field never changes', () => {
  const ops = inferOperatorsFromObservations(
    [
      {
        requestBody: { page: 1, appointState: 7 },
        data: { detail: [{ id: 1 }, { id: 2 }] },
      },
      {
        requestBody: { page: 2, appointState: 7 },
        data: { detail: [{ id: 3 }] },
      },
    ],
    { listKey: 'detail' },
  );
  assert.equal(
    ops.find((o) => o.field === 'appointState'),
    undefined,
  );
});

test('inferOperatorsFromObservations: ignores pagination keys', () => {
  const ops = inferOperatorsFromObservations(
    [
      { requestBody: { page: 1, pageSize: 5 }, data: { detail: [{ id: 1 }] } },
      { requestBody: { page: 2, pageSize: 5 }, data: { detail: [{ id: 2 }] } },
    ],
    { listKey: 'detail' },
  );
  assert.equal(ops.find((o) => o.field === 'page'), undefined);
  assert.equal(ops.find((o) => o.field === 'pageSize'), undefined);
});
