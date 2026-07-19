'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  ensureServiceDirs,
  serviceDataDir,
  serviceContractPath,
  serviceStubHandlerPath,
} = require('../lib/paths');
const { captureMerge } = require('../scripts/capture-merge');
const { renderHandler } = require('../scripts/generate-mock');
const { capturesDirFor } = require('../lib/catalog-merge');

test('captureMerge: merges real body into contract + handler', () => {
  const up = 'api';
  ensureServiceDirs(up);
  const urlPath = '/v1/items';
  const id = 'GET api/v1/items';
  const contract = {
    id,
    stubId: id,
    upstreamId: up,
    method: ['GET'],
    hosts: ['api.example.com'],
    path: urlPath,
    cases: [
      {
        id: 'success',
        response: { code: 0, data: { name: 'placeholder' }, message: '' },
        httpStatus: 200,
      },
    ],
    response: {
      source: 'usage',
      shape: { type: 'object', props: { name: { type: 'string' } } },
    },
    coverage: { gaps: ['no_property_access'], response: { pathsFound: [] } },
  };
  const cPath = serviceContractPath(up, id);
  fs.mkdirSync(path.dirname(cPath), { recursive: true });
  fs.writeFileSync(cPath, `${JSON.stringify(contract, null, 2)}\n`);
  const handlerFile = serviceStubHandlerPath(up, 'GET', urlPath);
  fs.mkdirSync(path.dirname(handlerFile), { recursive: true });
  fs.writeFileSync(handlerFile, renderHandler(contract));

  fs.writeFileSync(
    path.join(serviceDataDir(up), 'upstreams.json'),
    `${JSON.stringify({
      version: 1,
      upstreams: { [up]: { hosts: ['api.example.com'], canonicalHost: 'api.example.com' } },
    }, null, 2)}\n`,
  );

  const capturesDir = capturesDirFor(up);
  fs.writeFileSync(
    path.join(capturesDir, '1.json'),
    JSON.stringify({
      host: 'api.example.com',
      path: urlPath,
      method: 'GET',
      responseBody: { code: 0, data: { name: 'real-name', extra: 1 }, message: '' },
    }),
  );

  try {
    const r = captureMerge({ capturesDir, taskId: 't1' });
    assert.equal(r.merged, 1);
    const next = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    assert.equal(next.cases[0].response.data.name, 'real-name');
    assert.equal(next.cases[0].response.data.extra, 1);
    assert.ok(!next.coverage.gaps.includes('no_property_access'));
  } finally {
    fs.rmSync(serviceDataDir(up), { recursive: true, force: true });
  }
});

test('captureMerge: empty responseBody is skipped with report', () => {
  const up = 'cap-empty';
  const capturesDir = capturesDirFor(up);
  fs.writeFileSync(
    path.join(capturesDir, 'empty.json'),
    JSON.stringify({ host: 'h', path: '/p', method: 'GET' }),
  );
  try {
    const r = captureMerge({ capturesDir });
    assert.equal(r.merged, 0);
    assert.ok(r.skipped?.length >= 1);
  } finally {
    fs.rmSync(serviceDataDir(up), { recursive: true, force: true });
  }
});
