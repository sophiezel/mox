'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

/** Even without `npm test` preload, never write into the repo `.data`. */
const REPO_DATA = path.join(__dirname, '..', '.data');
if (
  !process.env.MOX_DATA_ROOT ||
  path.resolve(process.env.MOX_DATA_ROOT) === path.resolve(REPO_DATA)
) {
  process.env.MOX_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-promote-'));
}

const {
  ensureServiceDirs,
  serviceDataDir,
  serviceContractPath,
  serviceStubHandlerPath,
  listServiceIds,
} = require('../lib/paths');
const { captureMerge } = require('../scripts/capture-merge');
const { capturesDirFor } = require('../lib/catalog-merge');
const { decodeResponseBody, captureBodyFromDecoded } = require('../lib/decode-response-body');
const { resolveUpstreamId } = require('../lib/upstream');
const { resolveServiceIdFromHost } = require('../lib/resolve-service-id-from-host');

test('captureMerge: promotes missing stub when host maps to upstream', () => {
  const up = `promo-${Date.now().toString(36)}`;
  ensureServiceDirs(up);
  fs.writeFileSync(
    path.join(serviceDataDir(up), 'upstreams.json'),
    `${JSON.stringify({
      version: 1,
      upstreams: {
        [up]: { hosts: ['promo.example.com'], canonicalHost: 'promo.example.com' },
      },
    }, null, 2)}\n`,
  );
  // empty proxy-rules so listServiceIds sees it
  fs.writeFileSync(
    path.join(serviceDataDir(up), 'proxy-rules.json'),
    '[]\n',
  );

  const capturesDir = capturesDirFor(up);
  const urlPath = '/v1/brand-new';
  fs.writeFileSync(
    path.join(capturesDir, 'new.json'),
    JSON.stringify({
      host: 'promo.example.com',
      path: urlPath,
      method: 'GET',
      responseBody: { code: 0, data: { ok: true }, message: '' },
    }),
  );

  try {
    const r = captureMerge({ capturesDir });
    assert.equal(r.created, 1);
    assert.equal(r.merged, 1);
    const id = `GET ${up}/v1/brand-new`;
    const cPath = serviceContractPath(up, id);
    assert.ok(fs.existsSync(cPath));
    const contract = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    assert.equal(contract.cases[0].response.data.ok, true);
    assert.ok(String(contract.response.source).includes('capture'));
    const handler = serviceStubHandlerPath(up, 'GET', urlPath);
    assert.ok(fs.existsSync(handler));
    const rules = JSON.parse(
      fs.readFileSync(path.join(serviceDataDir(up), 'proxy-rules.json'), 'utf8'),
    );
    assert.ok(rules.some((x) => (x.stubId || x.id) === id));
  } finally {
    fs.rmSync(serviceDataDir(up), { recursive: true, force: true });
  }
});

test('captureMerge: stubId hit upgrades without relying on host map', () => {
  const up = `stubid-${Date.now().toString(36)}`;
  ensureServiceDirs(up);
  const urlPath = '/v1/by-stub';
  const id = `GET ${up}/v1/by-stub`;
  const contract = {
    id,
    stubId: id,
    upstreamId: up,
    method: ['GET'],
    path: urlPath,
    cases: [
      {
        id: 'success',
        response: { code: 0, data: { name: 'old' }, message: '' },
        httpStatus: 200,
      },
    ],
    response: { source: 'usage', shape: { type: 'object', props: {} } },
    coverage: { gaps: [], response: { pathsFound: [] } },
  };
  const cPath = serviceContractPath(up, id);
  fs.mkdirSync(path.dirname(cPath), { recursive: true });
  fs.writeFileSync(cPath, `${JSON.stringify(contract, null, 2)}\n`);
  fs.writeFileSync(path.join(serviceDataDir(up), 'proxy-rules.json'), '[]\n');

  const capturesDir = capturesDirFor(up);
  fs.writeFileSync(
    path.join(capturesDir, 's.json'),
    JSON.stringify({
      host: 'unknown-not-mapped.example.com',
      path: urlPath,
      method: 'GET',
      stubId: id,
      responseBody: { code: 0, data: { name: 'from-stubid' }, message: '' },
    }),
  );

  try {
    const r = captureMerge({ capturesDir });
    assert.equal(r.upgraded, 1);
    const next = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    assert.equal(next.cases[0].response.data.name, 'from-stubid');
  } finally {
    fs.rmSync(serviceDataDir(up), { recursive: true, force: true });
  }
});

test('captureMerge: bodyMeta.parseOk false → body_not_json skip', () => {
  const up = `badbody-${Date.now().toString(36)}`;
  ensureServiceDirs(up);
  fs.writeFileSync(path.join(serviceDataDir(up), 'proxy-rules.json'), '[]\n');
  const capturesDir = capturesDirFor(up);
  fs.writeFileSync(
    path.join(capturesDir, 'bad.json'),
    JSON.stringify({
      host: 'x.example.com',
      path: '/x',
      method: 'GET',
      responseBody: 'garbage',
      bodyMeta: { parseOk: false, encoding: 'gzip' },
    }),
  );
  try {
    const r = captureMerge({ capturesDir });
    assert.equal(r.merged, 0);
    assert.ok(r.skipped.some((s) => s.reason === 'body_not_json'));
  } finally {
    fs.rmSync(serviceDataDir(up), { recursive: true, force: true });
  }
});

test('gzip decode then captureBody shape is mergeable', () => {
  const payload = { code: 0, data: { n: 7 }, message: '' };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  const decoded = decodeResponseBody(gz, { 'content-encoding': 'gzip' });
  const fields = captureBodyFromDecoded(decoded);
  assert.equal(fields.bodyMeta.parseOk, true);
  assert.deepEqual(fields.responseBody, payload);
});

test('captureMerge: zero-init opens formal catalog from resolvable host', () => {
  const prev = process.env.MOX_DATA_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-zi-'));
  process.env.MOX_DATA_ROOT = tmp;
  const host = 'jian-j.example.com';
  const expectedId = resolveUpstreamId({ hosts: [host] });
  assert.equal(expectedId, 'jian-j');
  assert.equal(resolveServiceIdFromHost(host), expectedId);

  const capturesDir = path.join(tmp, 'inbox');
  fs.mkdirSync(capturesDir, { recursive: true });
  const urlPath = '/csp-task/external/trade/appoint/getTradeAppointList';
  fs.writeFileSync(
    path.join(capturesDir, 'cap.json'),
    JSON.stringify({
      host,
      path: urlPath,
      method: 'POST',
      responseBody: { code: 0, data: { list: [1] }, message: '' },
    }),
  );

  try {
    assert.deepEqual(listServiceIds(), []);
    const r = captureMerge({ capturesDir });
    assert.equal(r.created, 1);
    assert.equal(r.upgraded, 0);
    assert.ok(listServiceIds().includes(expectedId));
    const rules = JSON.parse(
      fs.readFileSync(path.join(serviceDataDir(expectedId), 'proxy-rules.json'), 'utf8'),
    );
    assert.ok(rules.length >= 1);
    const ups = JSON.parse(
      fs.readFileSync(path.join(serviceDataDir(expectedId), 'upstreams.json'), 'utf8'),
    );
    assert.ok(ups.upstreams[expectedId].hosts.includes(host));
    const stubId = `POST ${expectedId}${urlPath}`;
    assert.ok(fs.existsSync(serviceContractPath(expectedId, stubId)));
    assert.ok(fs.existsSync(serviceStubHandlerPath(expectedId, 'POST', urlPath)));
  } finally {
    if (prev === undefined) delete process.env.MOX_DATA_ROOT;
    else process.env.MOX_DATA_ROOT = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('captureMerge: noise host skip does not open catalog', () => {
  const prev = process.env.MOX_DATA_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-noise-'));
  process.env.MOX_DATA_ROOT = tmp;
  const capturesDir = path.join(tmp, 'inbox');
  fs.mkdirSync(capturesDir, { recursive: true });
  fs.writeFileSync(
    path.join(capturesDir, 'n.json'),
    JSON.stringify({
      host: 'www.google.com',
      path: '/x',
      method: 'GET',
      responseBody: { code: 0, data: {}, message: '' },
    }),
  );
  try {
    const r = captureMerge({ capturesDir });
    assert.equal(r.merged, 0);
    assert.ok(r.skipped.some((s) => s.reason === 'noise_host'));
    assert.deepEqual(listServiceIds(), []);
    assert.ok(!fs.existsSync(path.join(tmp, 'services', 'www')));
  } finally {
    if (prev === undefined) delete process.env.MOX_DATA_ROOT;
    else process.env.MOX_DATA_ROOT = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
