'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  projectDataDir,
  serviceDataDir,
  serviceContractPath,
} = require('../lib/paths');
const { generateMocks } = require('../scripts/generate-mock');

function withTempProject(fn) {
  const slug = `cap-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const root = projectDataDir(slug);
  fs.mkdirSync(path.join(root, 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, 'captures'), { recursive: true });
  try {
    return fn(slug);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    for (const up of ['svc-a', 'svc-b']) {
      try {
        fs.rmSync(serviceDataDir(up), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function makeRole() {
  return {
    role: 'dependency',
    method: 'GET',
    path: '/v1/items',
    upstreamId: 'svc-a',
    hosts: ['svc-a.example.com', 'svc-a-stage.example.com'],
    canonicalHost: 'svc-a.example.com',
    stubId: 'GET svc-a/v1/items',
    exportHint: 'getList',
    responseShape: { type: 'array', item: { props: { name: { type: 'string' } } } },
    coverage: {
      request: { keysFound: [], confidence: 'high' },
      response: { pathsFound: ['name'], confidence: 'high' },
      enums: [],
      gaps: [],
    },
    evidences: ['src/api.js:1'],
  };
}

test('C1: capture-merge with known host writes to stub path, source=usage+capture', () => {
  withTempProject((slug) => {
    const roles = [makeRole()];
    generateMocks({ projectSlug: slug, roles, force: true, merge: false });

    // Simulate a capture record from a known host
    const capturesDir = path.join(projectDataDir(slug), 'captures');
    const captureFile = path.join(capturesDir, 'test-capture.json');
    fs.writeFileSync(
      captureFile,
      JSON.stringify({
        host: 'svc-a.example.com',
        path: '/v1/items',
        method: 'GET',
        responseBody: { code: 0, data: [{ name: 'captured-item', id: 1 }] },
      }, null, 2),
    );

    const { captureMerge } = require('../scripts/capture-merge');
    const result = captureMerge(slug, { capturesDir });
    assert.ok(result.merged >= 1, `expected merged>=1, got ${JSON.stringify(result)}`);

    // Contract should have source=usage+capture under services/
    const cPath = serviceContractPath('svc-a', 'GET svc-a/v1/items');
    const contract = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    assert.ok(
      String(contract.response?.source || '').includes('capture'),
      `source should include capture, got ${contract.response?.source}`,
    );
  });
});

test('C2: capture-merge with unknown host + unique path learns host into upstreams.json', () => {
  withTempProject((slug) => {
    const roles = [makeRole()];
    generateMocks({ projectSlug: slug, roles, force: true, merge: false });

    // Simulate a capture from an unknown host alias
    const capturesDir = path.join(projectDataDir(slug), 'captures');
    const captureFile = path.join(capturesDir, 'test-alias.json');
    fs.writeFileSync(
      captureFile,
      JSON.stringify({
        host: 'svc-a-internal.example.com',
        path: '/v1/items',
        method: 'GET',
        responseBody: { code: 0, data: [{ name: 'alias-data' }] },
      }, null, 2),
    );

    const { captureMerge } = require('../scripts/capture-merge');
    const result = captureMerge(slug, { capturesDir });
    assert.ok(result.merged >= 1, 'alias host should be learned');

    // upstreams.json under service should now include the alias
    const upstreams = JSON.parse(
      fs.readFileSync(path.join(serviceDataDir('svc-a'), 'upstreams.json'), 'utf8'),
    );
    assert.ok(
      upstreams.upstreams['svc-a'].hosts.includes('svc-a-internal.example.com'),
      `alias should be learned: ${JSON.stringify(upstreams.upstreams['svc-a'].hosts)}`,
    );
  });
});

test('C3: capture-merge with ambiguous path (multiple upstreams) → skip + report', () => {
  withTempProject((slug) => {
    // Two upstreams, same path
    const roles = [
      makeRole(),
      {
        ...makeRole(),
        path: '/v1/items',
        upstreamId: 'svc-b',
        hosts: ['svc-b.example.com'],
        canonicalHost: 'svc-b.example.com',
        stubId: 'GET svc-b/v1/items',
      },
    ];
    generateMocks({ projectSlug: slug, roles, force: true, merge: false });

    // Capture from a host not in any upstream
    const capturesDir = path.join(projectDataDir(slug), 'captures');
    const captureFile = path.join(capturesDir, 'test-ambig.json');
    fs.writeFileSync(
      captureFile,
      JSON.stringify({
        host: 'unknown.example.com',
        path: '/v1/items',
        method: 'GET',
        responseBody: { code: 0, data: [] },
      }, null, 2),
    );

    const { captureMerge } = require('../scripts/capture-merge');
    const result = captureMerge(slug, { capturesDir });
    // Should skip because path is ambiguous (matches both svc-a and svc-b)
    assert.ok(result.skipped.length >= 1, `expected skipped.length>=1, got ${JSON.stringify(result)}`);
  });
});
