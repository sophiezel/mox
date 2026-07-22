'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  preflightShape,
  apiToRole,
  generateOnDemandApis,
  clearInflight,
} = require('../lib/on-demand-generate');
const { handleOnDemandMiss } = require('../lib/on-demand-miss');

test('preflightShape rejects empty / TRACE_EMPTY', () => {
  assert.equal(preflightShape(null).ok, false);
  assert.equal(
    preflightShape({
      responseShape: { type: 'object', props: {} },
      coverage: { gaps: ['TRACE_EMPTY'] },
    }).gap,
    'TRACE_EMPTY',
  );
  assert.equal(
    preflightShape({
      responseShape: {
        type: 'object',
        props: { id: { type: 'string' } },
      },
    }).ok,
    true,
  );
});

test('apiToRole carries responseShape and dependency role', () => {
  const role = apiToRole({
    method: 'GET',
    path: '/api/v1/items',
    host: 'api.example.com',
    upstreamId: 'api-example-com',
    hosts: ['api.example.com'],
    stubId: 'GET api-example-com/api/v1/items',
    responseShape: { type: 'object', props: { id: { type: 'string' } } },
    exportHint: 'fetchItems',
  });
  assert.equal(role.role, 'dependency');
  assert.equal(role.blocked, false);
  assert.equal(role.responseShape.props.id.type, 'string');
  assert.equal(role.stubId, 'GET api-example-com/api/v1/items');
});

test('generateOnDemandApis refuses empty shape (no invent)', async () => {
  clearInflight();
  const r = await generateOnDemandApis({
    scanDir: process.cwd(),
    apis: [
      {
        method: 'GET',
        path: '/api/v1/empty-on-demand',
        host: 'od.example.com',
        upstreamId: 'od-example-com',
        hosts: ['od.example.com'],
        stubId: 'GET od-example-com/api/v1/empty-on-demand',
        responseShape: { type: 'object', props: {} },
        coverage: { gaps: ['TRACE_EMPTY'] },
      },
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.gap, 'TRACE_EMPTY');
  assert.equal(r.generated, 0);
});

test('generateOnDemandApis writes contract+rule for shaped API', async () => {
  clearInflight();
  const stubId = 'GET od-gen-test/api/v1/shaped';
  const r = await generateOnDemandApis({
    scanDir: process.cwd(),
    projectSlug: 'od-gen-test',
    apis: [
      {
        method: 'GET',
        path: '/api/v1/shaped',
        host: 'od-gen.test',
        upstreamId: 'od-gen-test',
        hosts: ['od-gen.test'],
        stubId,
        responseShape: {
          type: 'object',
          props: { title: { type: 'string' } },
        },
        coverage: {
          request: { keysFound: [], confidence: 'high' },
          response: { pathsFound: ['title'], confidence: 'high' },
          enums: [],
          gaps: [],
        },
        exportHint: 'fetchShaped',
      },
    ],
  });
  assert.equal(r.ok, true);
  assert.ok(r.generated + r.reused >= 1);
  assert.ok(r.rules.some((x) => (x.stubId || x.id) === stubId));

  const { serviceContractPath, serviceStubHandlerPath } = require('../lib/paths');
  const cPath = serviceContractPath('od-gen-test', stubId);
  assert.ok(fs.existsSync(cPath), cPath);
  const contract = JSON.parse(fs.readFileSync(cPath, 'utf8'));
  assert.ok(contract.response?.shape?.props?.title);
  const hPath = serviceStubHandlerPath('od-gen-test', 'GET', '/api/v1/shaped');
  assert.ok(fs.existsSync(hPath), hPath);
});

test('handleOnDemandMiss returns continue when page map fails', async () => {
  const cont = await handleOnDemandMiss({
    scanDir: osTmpEmpty(),
    method: 'GET',
    host: 'x.test',
    path: '/nope',
    referer: 'http://127.0.0.1:8000/unknown',
  });
  assert.equal(cont.action, 'continue');
});

function osTmpEmpty() {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-od-miss-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}
