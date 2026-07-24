'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  deriveAndMaterializeVirtualService,
} = require('../../lib/virtual-service/derive');
const { readSeed } = require('../../lib/virtual-service/seed-store');
const { _resetAllForTests } = require('../../lib/service-store');

let tmpRoot;
let prevDataRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-derive-'));
  prevDataRoot = process.env.MOX_DATA_ROOT;
  process.env.MOX_DATA_ROOT = tmpRoot;
  _resetAllForTests();
});

afterEach(() => {
  if (prevDataRoot === undefined) delete process.env.MOX_DATA_ROOT;
  else process.env.MOX_DATA_ROOT = prevDataRoot;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  _resetAllForTests();
});

test('deriveAndMaterializeVirtualService: seeds rows and writes store handler', () => {
  const observations = [
    {
      stubId: 'POST demo/appoint/getTradeAppointList',
      method: 'POST',
      path: '/appoint/getTradeAppointList',
      requestBody: { page: 1, pageSize: 2 },
      responseBody: {
        code: 0,
        data: {
          page: 1,
          pageSize: 2,
          totalNum: 3,
          totalPage: 2,
          detail: [{ id: 1, title: 'a' }, { id: 2, title: 'b' }],
        },
        message: '',
      },
      data: {
        page: 1,
        pageSize: 2,
        totalNum: 3,
        totalPage: 2,
        detail: [{ id: 1, title: 'a' }, { id: 2, title: 'b' }],
      },
    },
    {
      stubId: 'POST demo/appoint/getTradeAppointList',
      method: 'POST',
      path: '/appoint/getTradeAppointList',
      requestBody: { page: 2, pageSize: 2 },
      responseBody: {
        code: 0,
        data: {
          page: 2,
          pageSize: 2,
          totalNum: 3,
          totalPage: 2,
          detail: [{ id: 3, title: 'c' }],
        },
        message: '',
      },
      data: {
        page: 2,
        pageSize: 2,
        totalNum: 3,
        totalPage: 2,
        detail: [{ id: 3, title: 'c' }],
      },
    },
  ];

  const contract = {
    id: 'POST demo/appoint/getTradeAppointList',
    stubId: 'POST demo/appoint/getTradeAppointList',
    upstreamId: 'demo',
    path: '/appoint/getTradeAppointList',
    method: ['POST'],
    cases: [
      {
        id: 'success',
        response: { code: 0, data: {}, message: '' },
        httpStatus: 200,
      },
    ],
    response: { source: 'usage' },
  };

  const result = deriveAndMaterializeVirtualService({
    observations,
    contract,
    upstreamId: 'demo',
    stubId: contract.stubId,
    method: 'POST',
    path: '/appoint/getTradeAppointList',
  });
  assert.equal(result.ok, true);
  assert.equal(result.seeded, 3);
  assert.equal(readSeed('demo', 'getTradeAppointList').rows.length, 3);

  const handler = path.join(
    tmpRoot,
    'services/demo/mocks/POST/appoint/getTradeAppointList/index.js',
  );
  assert.ok(fs.existsSync(handler));
  const src = fs.readFileSync(handler, 'utf8');
  assert.match(src, /mox:store/);
  assert.match(src, /paginated-list/);

  const fn = require(handler);
  const { getStore } = require('../../lib/service-store');
  const { hydrateSeedsIntoStores } = require('../../lib/virtual-service/seed-store');
  fs.writeFileSync(
    path.join(tmpRoot, 'services/demo/proxy-rules.json'),
    '[]\n',
  );
  hydrateSeedsIntoStores(['demo']);
  const page1 = fn({
    body: { page: 1, pageSize: 2 },
    store: getStore('demo'),
  });
  assert.equal(page1.response.data.detail.length, 2);
  assert.equal(page1.response.data.totalNum, 3);
  const page2 = fn({
    body: { page: 2, pageSize: 2 },
    store: getStore('demo'),
  });
  assert.equal(page2.response.data.detail.length, 1);
  assert.equal(page2.response.data.detail[0].id, '3');
});

test('deriveAndMaterializeVirtualService: respects mox:manual', () => {
  const handlerDir = path.join(
    tmpRoot,
    'services/demo/mocks/POST/appoint/list',
  );
  fs.mkdirSync(handlerDir, { recursive: true });
  fs.writeFileSync(
    path.join(handlerDir, 'index.js'),
    '/** mox:manual */\nmodule.exports = () => ({ response: { code: 0, data: { manual: true }, message: \"\" }, httpStatus: 200 });\n',
  );
  const observations = [
    {
      requestBody: { page: 1 },
      data: { page: 1, totalNum: 1, detail: [{ id: 9 }] },
      responseBody: { code: 0, data: { page: 1, totalNum: 1, detail: [{ id: 9 }] }, message: '' },
      method: 'POST',
      path: '/appoint/list',
      stubId: 'POST demo/appoint/list',
    },
  ];
  const result = deriveAndMaterializeVirtualService({
    observations,
    upstreamId: 'demo',
    stubId: 'POST demo/appoint/list',
    method: 'POST',
    path: '/appoint/list',
  });
  assert.equal(result.ok, true);
  assert.equal(result.manualSkipped, true);
  assert.equal(readSeed('demo', 'list').rows.length, 1);
  const src = fs.readFileSync(path.join(handlerDir, 'index.js'), 'utf8');
  assert.match(src, /mox:manual/);
});
