'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ensureDataDirs,
  scenariosDir,
  ensureServiceDirs,
  serviceContractPath,
  serviceDataDir,
} = require('../lib/paths');
const { setScenario } = require('../scripts/set-scenario');

function withIso(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-req-stub-'));
  const prevData = process.env.MOX_DATA_ROOT;
  const prevSession = process.env.MOX_SESSION_FILE;
  process.env.MOX_DATA_ROOT = root;
  process.env.MOX_SESSION_FILE = path.join(root, 'session.json');
  try {
    return fn(root);
  } finally {
    if (prevData === undefined) delete process.env.MOX_DATA_ROOT;
    else process.env.MOX_DATA_ROOT = prevData;
    if (prevSession === undefined) delete process.env.MOX_SESSION_FILE;
    else process.env.MOX_SESSION_FILE = prevSession;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('set-scenario fails when requiredStubs missing from catalog', () => {
  withIso(() => {
    ensureDataDirs();
    const dir = scenariosDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'needs-stubs.json'),
      JSON.stringify({
        default: 'success',
        apis: {},
        requiredStubs: ['GET missing-svc/v1/gone'],
      }),
    );
    assert.throws(
      () => setScenario({ scenario: 'needs-stubs' }),
      /requiredStubs missing/i,
    );
  });
});

test('set-scenario succeeds when requiredStubs exist and non-empty', () => {
  withIso(() => {
    ensureDataDirs();
    const up = 'demo-svc';
    ensureServiceDirs(up);
    const stubId = 'GET demo-svc/v1/ok';
    fs.writeFileSync(
      serviceContractPath(up, stubId),
      JSON.stringify({
        stubId,
        id: stubId,
        upstreamId: up,
        path: '/v1/ok',
        method: ['GET'],
        response: {
          source: 'capture',
          shape: { type: 'object', props: { id: { type: 'number' } } },
        },
        coverage: { gaps: [] },
      }),
    );
    fs.writeFileSync(
      path.join(serviceDataDir(up), 'proxy-rules.json'),
      JSON.stringify([{ stubId, hosts: ['demo.example.com'], pathPrefix: '/v1/ok', methods: ['GET'] }]),
    );
    // minimal handler so handlerExists passes if checked
    const handlerDir = path.join(serviceDataDir(up), 'mocks', 'GET', 'v1', 'ok');
    fs.mkdirSync(handlerDir, { recursive: true });
    fs.writeFileSync(
      path.join(handlerDir, 'index.js'),
      'module.exports = () => ({ code: 0, data: { id: 1 }, message: "" });\n',
    );

    const dir = scenariosDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'has-stubs.json'),
      JSON.stringify({
        default: 'success',
        requiredStubs: [stubId],
      }),
    );
    setScenario({ scenario: 'has-stubs' });
    const { loadSession } = require('../lib/session-config');
    assert.equal(loadSession().scenario, 'has-stubs');
  });
});
