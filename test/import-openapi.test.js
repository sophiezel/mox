'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { importOpenApi, schemaToShape } = require('../scripts/import-openapi');
const { serviceDataDir } = require('../lib/paths');

test('schemaToShape: object props', () => {
  const shape = schemaToShape({
    type: 'object',
    properties: { id: { type: 'string' }, n: { type: 'integer' } },
  });
  assert.equal(shape.props.id.type, 'string');
  assert.equal(shape.props.n.type, 'number');
});

test('importOpenApi: generates contracts from spec', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-'));
  const specPath = path.join(tmp, 'openapi.json');
  fs.writeFileSync(
    specPath,
    JSON.stringify({
      openapi: '3.0.0',
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/v1/pets': {
          get: {
            operationId: 'listPets',
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        data: {
                          type: 'object',
                          properties: {
                            list: { type: 'array' },
                            total: { type: 'integer' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  );

  const slug = `oa-${Date.now()}`;
  try {
    const r = importOpenApi({
      projectDir: tmp,
      name: slug,
      from: specPath,
      taskId: 'oa-1',
      force: true,
    });
    assert.ok(r.roles.length >= 1);
    assert.ok(r.gen.generated >= 1);
    const contracts = fs.readdirSync(
      path.join(serviceDataDir('api'), 'contracts'),
    );
    assert.ok(contracts.some((f) => f.includes('pets')));
  } finally {
    try {
      fs.rmSync(serviceDataDir('api'), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
