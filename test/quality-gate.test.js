'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ensureServiceDirs,
  serviceContractPath,
  serviceDataDir,
} = require('../lib/paths');

function withDataRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-qg-'));
  const prev = process.env.MOX_DATA_ROOT;
  process.env.MOX_DATA_ROOT = root;
  try {
    return fn(root);
  } finally {
    if (prev === undefined) delete process.env.MOX_DATA_ROOT;
    else process.env.MOX_DATA_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeServiceContract(upstreamId, contract) {
  ensureServiceDirs(upstreamId);
  const id = contract.stubId || contract.id;
  fs.writeFileSync(
    serviceContractPath(upstreamId, id),
    `${JSON.stringify(contract, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(serviceDataDir(upstreamId), 'proxy-rules.json'),
    JSON.stringify([
      {
        stubId: id,
        hosts: ['api.example.com'],
        pathPrefix: '/v1/x',
        methods: ['GET'],
      },
    ]),
  );
}

test('quality-gate exits 1 when TRACE_EMPTY stub present', () => {
  withDataRoot((root) => {
    const { ensureDataDirs } = require('../lib/paths');
    ensureDataDirs();
    writeServiceContract('api-example-com', {
      stubId: 'GET api-example-com/v1/x',
      id: 'GET api-example-com/v1/x',
      upstreamId: 'api-example-com',
      response: { source: 'empty', shape: { type: 'object', props: {} } },
      coverage: { gaps: ['TRACE_EMPTY'] },
    });
    const r = spawnSync(
      process.execPath,
      [path.join(__dirname, '../scripts/quality-gate.js')],
      {
        env: { ...process.env, MOX_DATA_ROOT: root },
        encoding: 'utf8',
      },
    );
    assert.notEqual(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
    const reports = path.join(root, 'reports');
    const files = fs.existsSync(reports)
      ? fs.readdirSync(reports).filter((f) => f.startsWith('quality-gate-'))
      : [];
    assert.ok(files.length >= 1, 'expected quality-gate report');
  });
});

test('quality-gate exits 0 on clean catalog fixture', () => {
  withDataRoot((root) => {
    const { ensureDataDirs } = require('../lib/paths');
    ensureDataDirs();
    writeServiceContract('api-example-com', {
      stubId: 'GET api-example-com/v1/x',
      id: 'GET api-example-com/v1/x',
      upstreamId: 'api-example-com',
      response: {
        source: 'capture',
        shape: {
          type: 'object',
          props: { id: { type: 'number' } },
        },
        sample: { code: 0, data: { id: 1 }, message: '' },
      },
      coverage: { gaps: [] },
    });
    const r = spawnSync(
      process.execPath,
      [path.join(__dirname, '../scripts/quality-gate.js')],
      {
        env: { ...process.env, MOX_DATA_ROOT: root },
        encoding: 'utf8',
      },
    );
    assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
    const reports = path.join(root, 'reports');
    const files = fs.readdirSync(reports).filter((f) => f.startsWith('quality-gate-'));
    assert.ok(files.length >= 1);
    const report = JSON.parse(
      fs.readFileSync(path.join(reports, files[0]), 'utf8'),
    );
    assert.equal(report.ok, true);
  });
});

test('quality-gate --require-mitm-check fails when probe not ok', async () => {
  const { runQualityGate } = require('../scripts/quality-gate');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-qg-mitm-'));
  const prev = process.env.MOX_DATA_ROOT;
  process.env.MOX_DATA_ROOT = root;
  try {
    const { ensureDataDirs } = require('../lib/paths');
    ensureDataDirs();
    writeServiceContract('api-example-com', {
      stubId: 'GET api-example-com/v1/x',
      id: 'GET api-example-com/v1/x',
      upstreamId: 'api-example-com',
      response: {
        source: 'capture',
        shape: { type: 'object', props: { id: { type: 'number' } } },
      },
      coverage: { gaps: [] },
    });
    const report = await runQualityGate({
      requireMitmCheck: 'http://127.0.0.1:1/__mox_mitm_check',
    });
    assert.equal(report.ok, false);
    assert.ok(
      report.failures.some((f) => f.code === 'MITM_CHECK_FAILED'),
      JSON.stringify(report.failures),
    );
  } finally {
    if (prev === undefined) delete process.env.MOX_DATA_ROOT;
    else process.env.MOX_DATA_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
