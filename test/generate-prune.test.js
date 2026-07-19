'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  generateMocks,
  pruneOrphanArtifacts,
} = require('../scripts/generate-mock');
const {
  projectDataDir,
  serviceDataDir,
  stubHandlerPath,
  serviceContractPath,
  stubId,
} = require('../lib/paths');

function withTempProject(fn) {
  const slug = `prune-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const root = projectDataDir(slug);
  fs.mkdirSync(path.join(root, 'audit'), { recursive: true });
  try {
    return fn(slug);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    for (const up of ['prune-svc', 'orphan-svc']) {
      try {
        fs.rmSync(serviceDataDir(up), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function makeRole(overrides = {}) {
  return {
    role: 'modify',
    method: 'GET',
    path: '/v1/items/detail',
    upstreamId: 'prune-svc',
    hosts: ['api.example.com'],
    canonicalHost: 'api.example.com',
    stubId: 'GET prune-svc/v1/items/detail',
    exportHint: 'getItem',
    responseShape: {
      type: 'object',
      props: { item_id: { type: 'unknown' } },
    },
    coverage: {
      request: { keysFound: [], confidence: 'high' },
      response: { pathsFound: ['item_id'], confidence: 'high' },
      enums: [],
      gaps: [],
    },
    ...overrides,
  };
}

test('generate force: prunes orphan handlers and contracts', () => {
  withTempProject((slug) => {
    // Orphan under the same upstream this generate will touch (so prune walks that service)
    const orphanUp = 'prune-svc';
    const orphanHandler = stubHandlerPath(slug, orphanUp, 'GET', '/v1/orphan');
    fs.mkdirSync(path.dirname(orphanHandler), { recursive: true });
    fs.writeFileSync(orphanHandler, 'module.exports = () => ({});\n');
    const orphanKey = stubId({ upstreamId: orphanUp, method: 'GET', path: '/v1/orphan' });
    const orphanContract = serviceContractPath(orphanUp, orphanKey);
    fs.mkdirSync(path.dirname(orphanContract), { recursive: true });
    fs.writeFileSync(
      orphanContract,
      JSON.stringify({ id: orphanKey, stubId: orphanKey, upstreamId: orphanUp, path: '/v1/orphan', method: ['GET'] }, null, 2),
    );

    const roles = [makeRole()];
    const gen = generateMocks({ projectSlug: slug, roles, force: true, merge: false });
    assert.ok(gen.prunedHandlers >= 1, `expected prunedHandlers>=1 got ${gen.prunedHandlers}`);
    assert.ok(gen.prunedContracts >= 1, `expected prunedContracts>=1 got ${gen.prunedContracts}`);
    assert.ok(!fs.existsSync(orphanHandler), 'orphan handler should be removed');
    assert.ok(!fs.existsSync(orphanContract), 'orphan contract should be removed');

    const keepHandler = stubHandlerPath(slug, 'prune-svc', 'GET', '/v1/items/detail');
    assert.ok(fs.existsSync(keepHandler), 'whitelist handler should remain');
  });
});

test('generate: empty + exportHint still materializes handler (no_property_access alone is not contract-only)', () => {
  withTempProject((slug) => {
    const roles = [
      makeRole({
        path: '/v1/addr/init',
        stubId: 'GET prune-svc/v1/addr/init',
        exportHint: 'initAddr',
        responseShape: { type: 'object', props: {} },
        coverage: {
          request: { keysFound: [], confidence: 'low' },
          response: { pathsFound: [], confidence: 'low' },
          enums: [],
          gaps: ['no_property_access'],
        },
      }),
    ];
    const gen = generateMocks({ projectSlug: slug, roles, force: true, merge: false });
    assert.equal(gen.skippedEmptyCount, 0);
    assert.equal(gen.generated, 1);
    const rules = JSON.parse(
      fs.readFileSync(path.join(serviceDataDir('prune-svc'), 'proxy-rules.json'), 'utf8'),
    );
    assert.equal(rules.length, 1, 'exportHint empty shape still enters proxy-rules');
    assert.ok(
      fs.existsSync(stubHandlerPath(slug, 'prune-svc', 'GET', '/v1/addr/init')),
      'handler should be rendered',
    );
  });
});

test('generate: empty + no_export_symbol is contract-only (no proxy rule)', () => {
  withTempProject((slug) => {
    const roles = [
      makeRole({
        path: '/v1/addr/orphan',
        stubId: 'GET prune-svc/v1/addr/orphan',
        exportHint: null,
        responseShape: { type: 'object', props: {} },
        coverage: {
          request: { keysFound: [], confidence: 'low' },
          response: { pathsFound: [], confidence: 'low' },
          enums: [],
          gaps: ['no_export_symbol'],
        },
      }),
    ];
    const gen = generateMocks({ projectSlug: slug, roles, force: true, merge: false });
    assert.equal(gen.skippedEmptyCount, 1);
    const rulesPath = path.join(serviceDataDir('prune-svc'), 'proxy-rules.json');
    if (fs.existsSync(rulesPath)) {
      const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
      assert.equal(rules.length, 0, 'empty+no_export_symbol must not enter proxy-rules');
    }
    const key = 'GET prune-svc/v1/addr/orphan';
    assert.ok(fs.existsSync(serviceContractPath('prune-svc', key)), 'contract should still be written');
    assert.ok(
      !fs.existsSync(stubHandlerPath(slug, 'prune-svc', 'GET', '/v1/addr/orphan')),
      'handler should not be rendered',
    );
  });
});

test('pruneOrphanArtifacts: keeps mox:manual handlers', () => {
  withTempProject((slug) => {
    const handler = stubHandlerPath(slug, 'prune-svc', 'GET', '/v1/manual');
    fs.mkdirSync(path.dirname(handler), { recursive: true });
    fs.writeFileSync(
      handler,
      '/** mox:manual */\nmodule.exports = () => ({});\n',
    );
    const { prunedHandlers } = pruneOrphanArtifacts(slug, {
      keepHandlerKeys: new Set(),
      keepContractKeys: new Set(),
    });
    assert.equal(prunedHandlers, 0);
    assert.ok(fs.existsSync(handler));
  });
});
