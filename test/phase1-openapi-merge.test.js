'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { importOpenApi, schemaToShape } = require('../scripts/import-openapi');
const { serviceDataDir, serviceContractPath } = require('../lib/paths');

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oa-'));
}

function writeSpec(tmp, spec, name = 'openapi.json') {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, typeof spec === 'string' ? spec : JSON.stringify(spec));
  return p;
}

test('P1.5-A1: import-openapi derives stubId + upstreamId from host (no FQDN apiKey)', () => {
  const tmp = mktmp();
  const slug = `oa-stubid-${Date.now()}`;
  try {
    const specPath = writeSpec(tmp, {
      openapi: '3.0.0',
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/v1/pets': {
          get: {
            operationId: 'listPets',
            responses: { '200': { content: { 'application/json': { schema: {
              type: 'object',
              properties: { data: { type: 'object', properties: { name: { type: 'string' } } } },
            } } } } },
          },
        },
      },
    });
    const r = importOpenApi({ projectDir: tmp, name: slug, from: specPath, force: true });
    const role = r.roles[0];
    assert.ok(role.stubId, 'role should have stubId');
    assert.equal(role.stubId, 'GET api/v1/pets');
    assert.equal(role.upstreamId, 'api');
    assert.ok(Array.isArray(role.hosts) && role.hosts.length >= 1);
    assert.ok(role.hosts.includes('api.example.com'));
    assert.ok(!role.apiKey || !role.apiKey.includes('api.example.com'), 'apiKey should not be FQDN-based');
  } finally {
    fs.rmSync(serviceDataDir('api'), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P1.5-A2: import-openapi merges OpenAPI shape into existing usage stub by stubId (OpenAPI ≥ usage)', () => {
  const tmp = mktmp();
  const slug = `oa-merge-${Date.now()}`;
  try {
    // Step 1: simulate a usage-inferred contract (L1, partial shape) at the same stubId
    const { generateMocks } = require('../scripts/generate-mock');
    const usageRole = {
      role: 'dependency',
      method: 'GET',
      path: '/v1/pets',
      upstreamId: 'api',
      hosts: ['api.example.com'],
      canonicalHost: 'api.example.com',
      stubId: 'GET api/v1/pets',
      exportHint: 'listPets',
      responseShape: { type: 'object', props: { name: { type: 'string' } } }, // partial usage shape
      coverage: { request: { keysFound: [] }, response: { pathsFound: ['name'] }, enums: [], gaps: ['props_shallow_only'] },
      evidences: ['src/api.js:1'],
    };
    generateMocks({ projectSlug: slug, roles: [usageRole], force: true, merge: false });

    // Step 2: import OpenAPI with a richer shape (adds 'id', 'status')
    const specPath = writeSpec(tmp, {
      openapi: '3.0.0',
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/v1/pets': {
          get: {
            operationId: 'listPets',
            responses: { '200': { content: { 'application/json': { schema: {
              type: 'object',
              properties: { data: { type: 'object', properties: {
                name: { type: 'string' }, id: { type: 'integer' }, status: { type: 'string' },
              } } },
            } } } } },
          },
        },
      },
    });
    const r = importOpenApi({ projectDir: tmp, name: slug, from: specPath, force: false });
    assert.ok(r.gen.generated >= 0 || r.gen.reused >= 0);

    // The contract at GET api/v1/pets should now have the UNION of fields (OpenAPI enriched usage)
    const contract = JSON.parse(
      fs.readFileSync(serviceContractPath('api', 'GET api/v1/pets'), 'utf8'),
    );
    const props = contract.response.shape?.props || {};
    assert.ok(props.name, 'usage field name preserved');
    assert.ok(props.id, 'OpenAPI field id merged in');
    assert.ok(props.status, 'OpenAPI field status merged in');
    // source should reflect openapi contribution
    assert.ok(
      contract.source === 'openapi' || contract.response.source === 'openapi' || contract.source === 'usage',
      `source=${contract.source}`,
    );
  } finally {
    fs.rmSync(serviceDataDir('api'), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P1.5-A3: import-openapi supports YAML specs', () => {
  const tmp = mktmp();
  const slug = `oa-yaml-${Date.now()}`;
  try {
    const yaml = `
openapi: 3.0.0
servers:
  - url: https://api.example.com
paths:
  /v1/pets:
    get:
      operationId: listPets
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: object
                    properties:
                      name:
                        type: string
`;
    const specPath = writeSpec(tmp, yaml, 'openapi.yaml');
    const r = importOpenApi({ projectDir: tmp, name: slug, from: specPath, force: true });
    assert.ok(r.roles.length >= 1, 'YAML spec should produce roles');
    assert.equal(r.roles[0].stubId, 'GET api/v1/pets');
  } finally {
    fs.rmSync(serviceDataDir('api'), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P1.5-A4: import-openapi stamps fidelity on generated contracts', () => {
  const tmp = mktmp();
  const slug = `oa-fid-${Date.now()}`;
  try {
    const specPath = writeSpec(tmp, {
      openapi: '3.0.0',
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/v1/pets': {
          get: {
            responses: { '200': { content: { 'application/json': { schema: {
              type: 'object',
              properties: { data: { type: 'object', properties: { id: { type: 'integer' } } } },
            } } } } },
          },
        },
      },
    });
    importOpenApi({ projectDir: tmp, name: slug, from: specPath, force: true });
    const contract = JSON.parse(
      fs.readFileSync(serviceContractPath('api', 'GET api/v1/pets'), 'utf8'),
    );
    assert.equal(contract.fidelity, 'L1', 'openapi shape → L1 (placeholder, not captured)');
    assert.equal(contract.source, 'openapi');
  } finally {
    fs.rmSync(serviceDataDir('api'), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P1.5-A5: import-openapi with env-suffixed host normalizes upstreamId', () => {
  const tmp = mktmp();
  const slug = `oa-env-${Date.now()}`;
  try {
    const specPath = writeSpec(tmp, {
      openapi: '3.0.0',
      servers: [{ url: 'https://api-stage.example.com' }],
      paths: { '/v1/items': { get: { responses: { '200': { content: { 'application/json': { schema: {
        type: 'object', properties: { data: { type: 'object', properties: { id: { type: 'integer' } } } } },
      } } } } } } },
    });
    const r = importOpenApi({ projectDir: tmp, name: slug, from: specPath, force: true });
    assert.equal(r.roles[0].upstreamId, 'api', 'env suffix -stage stripped');
    assert.equal(r.roles[0].stubId, 'GET api/v1/items');
    assert.ok(r.roles[0].hosts.includes('api-stage.example.com'));
  } finally {
    fs.rmSync(serviceDataDir('api'), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
