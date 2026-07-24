'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectPaginatedList,
  learnEnvelope,
  extractListRows,
  resourceNameFromStub,
  renderPaginatedListHandler,
  applyPagination,
} = require('../../lib/virtual-service/protocols/paginated-list');

test('detectPaginatedList: page request + list+total envelope', () => {
  const obs = [
    {
      requestBody: { page: 1, pageSize: 5 },
      data: { page: 1, pageSize: 5, totalNum: 12, detail: [{ id: 1 }] },
    },
  ];
  const hit = detectPaginatedList(obs);
  assert.ok(hit);
  assert.equal(hit.protocol, 'paginated-list');
  assert.equal(hit.envelope.listKey, 'detail');
  assert.equal(hit.envelope.totalKey, 'totalNum');
  assert.equal(hit.envelope.pageKey, 'page');
});

test('detectPaginatedList: rejects plain array data', () => {
  assert.equal(
    detectPaginatedList([{ requestBody: {}, data: [{ id: 1 }] }]),
    null,
  );
});

test('extractListRows unions detail across observations', () => {
  const env = learnEnvelope([
    {
      requestBody: { page: 1 },
      data: { page: 1, totalNum: 3, detail: [{ id: 1 }, { id: 2 }] },
    },
    {
      requestBody: { page: 2 },
      data: { page: 2, totalNum: 3, detail: [{ id: 3 }] },
    },
  ]);
  const rows = extractListRows(
    [
      { data: { detail: [{ id: 1 }, { id: 2 }] } },
      { data: { detail: [{ id: 2, title: 'x' }, { id: 3 }] } },
    ],
    env,
  );
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => String(r.id) === '2').title, 'x');
});

test('applyPagination slices and fills envelope', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id }));
  const env = {
    listKey: 'detail',
    totalKey: 'totalNum',
    pageKey: 'page',
    pageSizeKey: 'pageSize',
    totalPageKey: 'totalPage',
  };
  const out = applyPagination(rows, { page: 2, pageSize: 3 }, env);
  assert.equal(out.page, 2);
  assert.equal(out.pageSize, 3);
  assert.equal(out.totalNum, 7);
  assert.equal(out.totalPage, 3);
  assert.deepEqual(
    out.detail.map((r) => r.id),
    [4, 5, 6],
  );
});

test('renderPaginatedListHandler embeds mox:store and snapshot fallback', () => {
  const src = renderPaginatedListHandler({
    stubId: 'POST jian-j/csp-task/list',
    resource: 'tradeAppoint',
    envelope: {
      listKey: 'detail',
      totalKey: 'totalNum',
      pageKey: 'page',
      pageSizeKey: 'pageSize',
      totalPageKey: 'totalPage',
    },
    operators: [],
    snapshotSuccess: {
      code: 0,
      data: { page: 1, pageSize: 5, totalNum: 0, detail: [] },
      message: '',
    },
  });
  assert.match(src, /mox:store/);
  assert.match(src, /paginated-list/);
  assert.match(src, /tradeAppoint/);
  assert.match(src, /SNAPSHOT_SUCCESS/);
});

test('resourceNameFromStub sanitizes path tail', () => {
  assert.equal(
    resourceNameFromStub('POST jian-j/csp-task/external/trade/appoint/getTradeAppointList'),
    'getTradeAppointList',
  );
});
