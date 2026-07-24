'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractEndpoints } = require('../lib/doc-source/extract');
const { fetchDoc } = require('../lib/doc-source/fetch');
const { observationFromDoc } = require('../lib/virtual-service/observation');
const { importDoc, applyWikiToContract } = require('../scripts/import-doc');
const {
  serviceDataDir,
  serviceContractPath,
  stubHandlerPath,
  docsDir,
} = require('../lib/paths');
const { stubId: makeStubId } = require('../lib/paths');

function withTempData(fn) {
  const prev = process.env.MOX_DATA_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-doc-'));
  process.env.MOX_DATA_ROOT = tmp;
  try {
    return fn(tmp);
  } finally {
    process.env.MOX_DATA_ROOT = prev;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

test('extractEndpoints: http fence + json response', () => {
  const md = `
## API

\`\`\`http
POST /csp-task/list

{"page":1}
\`\`\`

\`\`\`json
{"code":0,"data":{"list":[{"id":1}],"totalNum":1},"message":""}
\`\`\`
`;
  const eps = extractEndpoints(md);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].method, 'POST');
  assert.equal(eps[0].path, '/csp-task/list');
  assert.equal(eps[0].responseBody.data.list[0].id, 1);
});

test('extractEndpoints: method then json', () => {
  const md = `
GET /v1/pets
\`\`\`json
{"code":0,"data":{"name":"a"},"message":""}
\`\`\`
`;
  const eps = extractEndpoints(md);
  assert.ok(eps.some((e) => e.method === 'GET' && e.path === '/v1/pets'));
});

test('extractEndpoints: markdown table', () => {
  const md = `
| Method | Path | Response |
| --- | --- | --- |
| POST | /api/foo | \`{"code":0,"data":{"ok":true},"message":""}\` |
`;
  const eps = extractEndpoints(md);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].path, '/api/foo');
  assert.equal(eps[0].responseBody.data.ok, true);
});

test('observationFromDoc: source=wiki fidelity=doc', () => {
  const obs = observationFromDoc({
    method: 'GET',
    path: '/x',
    responseBody: { code: 0, data: { a: 1 }, message: '' },
  });
  assert.equal(obs.source, 'wiki');
  assert.equal(obs.fidelity, 'doc');
  assert.equal(obs.data.a, 1);
});

test('fetchDoc: local file writes .data/docs snapshot', () => {
  withTempData(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-md-'));
    const mdPath = path.join(dir, 'sample.md');
    fs.writeFileSync(
      mdPath,
      'GET /a\n```json\n{"code":0,"data":{},"message":""}\n```\n',
    );
    try {
      const r = fetchDoc({ file: mdPath, projectDir: dir });
      assert.equal(r.fetcher, 'file');
      assert.ok(fs.existsSync(r.indexPath));
      assert.ok(r.indexPath.startsWith(docsDir()));
      assert.match(r.markdown, /fetcher: "file"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('fetchDoc: URL without MOX_DOC_FETCH_CMD fails', () => {
  withTempData(() => {
    assert.throws(
      () =>
        fetchDoc({
          from: 'https://cwiki.example.com/pages/viewpage.action?pageId=1',
          env: {},
        }),
      /MOX_DOC_FETCH_CMD/,
    );
  });
});

test('fetchDoc: MOX_DOC_FETCH_CMD writes via outDir', () => {
  withTempData(() => {
    const env = {
      ...process.env,
      MOX_DOC_FETCH_CMD:
        'node -e "require(\'fs\').writeFileSync(require(\'path\').join(process.argv[1],\'index.md\'), \'GET /z\\n```json\\n{\\"code\\":0,\\"data\\":{\\"z\\":1},\\"message\\":\\"\\"}\\n```\\n\')" {outDir}',
    };
    // Simpler: printf style
    env.MOX_DOC_FETCH_CMD =
      'printf \'GET /z\\n```json\\n{"code":0,"data":{"z":1},"message":""}\\n```\\n\' > "{outDir}/index.md"';
    const r = fetchDoc({
      from: 'https://cwiki.example.com/pages/viewpage.action?pageId=99',
      env,
    });
    assert.equal(r.fetcher, 'cmd');
    assert.match(r.slug, /99/);
    assert.ok(fs.existsSync(r.indexPath));
  });
});

test('importDoc: --llm throws', () => {
  assert.throws(
    () => importDoc({ llm: true, file: '/tmp/x.md' }),
    /not implemented/,
  );
});

test('importDoc: creates contract+handler from markdown', () => {
  withTempData(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-imp-'));
    const mdPath = path.join(dir, 'api.md');
    fs.writeFileSync(
      mdPath,
      `
\`\`\`http
POST /demo/items

{"page":1}
\`\`\`
\`\`\`json
{"code":0,"data":{"list":[{"id":"a"}],"totalNum":1},"message":""}
\`\`\`
`,
    );
    try {
      const r = importDoc({
        file: mdPath,
        projectDir: dir,
        name: 'docsvc',
      });
      assert.equal(r.extracted, 1);
      assert.equal(r.created, 1);
      const id = makeStubId({
        upstreamId: 'docsvc',
        method: 'POST',
        path: '/demo/items',
      });
      const cPath = serviceContractPath('docsvc', id);
      assert.ok(fs.existsSync(cPath));
      const contract = JSON.parse(fs.readFileSync(cPath, 'utf8'));
      assert.equal(contract.response.source, 'wiki');
      assert.equal(contract.source, 'wiki');
      const h = stubHandlerPath(null, 'docsvc', 'POST', '/demo/items');
      assert.ok(fs.existsSync(h));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        fs.rmSync(serviceDataDir('docsvc'), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

test('importDoc: capture_wins skips overwrite', () => {
  withTempData(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-cap-'));
    const mdPath = path.join(dir, 'api.md');
    fs.writeFileSync(
      mdPath,
      `
GET /kept
\`\`\`json
{"code":0,"data":{"from":"wiki"},"message":""}
\`\`\`
`,
    );
    const upstreamId = 'capsvc';
    const id = makeStubId({ upstreamId, method: 'GET', path: '/kept' });
    const { ensureServiceDirs } = require('../lib/paths');
    ensureServiceDirs(upstreamId);
    const cPath = serviceContractPath(upstreamId, id);
    fs.mkdirSync(path.dirname(cPath), { recursive: true });
    fs.writeFileSync(
      cPath,
      JSON.stringify(
        {
          id,
          stubId: id,
          upstreamId,
          method: ['GET'],
          path: '/kept',
          source: 'capture',
          response: {
            source: 'usage+capture',
            shape: { type: 'object', props: { from: { type: 'string' } } },
          },
          cases: [
            {
              id: 'success',
              response: { code: 0, data: { from: 'capture' }, message: '' },
              httpStatus: 200,
            },
          ],
          coverage: { gaps: [] },
        },
        null,
        2,
      ),
    );
    try {
      const r = importDoc({
        file: mdPath,
        projectDir: dir,
        name: upstreamId,
      });
      assert.ok(r.skippedByReason.capture_wins >= 1);
      const contract = JSON.parse(fs.readFileSync(cPath, 'utf8'));
      assert.equal(contract.cases[0].response.data.from, 'capture');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        fs.rmSync(serviceDataDir(upstreamId), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

test('importDoc: mox:manual handler not overwritten', () => {
  withTempData(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-man-'));
    const mdPath = path.join(dir, 'api.md');
    fs.writeFileSync(
      mdPath,
      `
\`\`\`http
POST /manual/list
\`\`\`
\`\`\`json
{"code":0,"data":{"list":[{"id":1},{"id":2}],"page":1,"totalNum":2},"message":""}
\`\`\`
`,
    );
    const upstreamId = 'mansvc';
    const method = 'POST';
    const urlPath = '/manual/list';
    const id = makeStubId({ upstreamId, method, path: urlPath });
    const { ensureServiceDirs } = require('../lib/paths');
    ensureServiceDirs(upstreamId);
    const h = stubHandlerPath(null, upstreamId, method, urlPath);
    fs.mkdirSync(path.dirname(h), { recursive: true });
    const marker = '// mox:manual\nmodule.exports = () => ({ code: 0, data: { kept: true }, message: "" });\n';
    fs.writeFileSync(h, marker);
    const cPath = serviceContractPath(upstreamId, id);
    fs.mkdirSync(path.dirname(cPath), { recursive: true });
    fs.writeFileSync(
      cPath,
      JSON.stringify(
        {
          id,
          stubId: id,
          upstreamId,
          method: [method],
          path: urlPath,
          source: 'wiki',
          response: { source: 'empty', shape: { type: 'object', props: {} } },
          cases: [
            {
              id: 'success',
              response: { code: 0, data: {}, message: '' },
              httpStatus: 200,
            },
          ],
          coverage: { gaps: [] },
        },
        null,
        2,
      ),
    );
    try {
      const r = importDoc({
        file: mdPath,
        projectDir: dir,
        name: upstreamId,
      });
      assert.ok(r.upgraded >= 1 || r.vs_derived >= 0);
      const after = fs.readFileSync(h, 'utf8');
      assert.ok(after.includes('mox:manual'));
      assert.ok(after.includes('kept: true'));
      if (r.skippedByReason.handler_manual_skipped) {
        assert.ok(r.skippedByReason.handler_manual_skipped >= 1);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        fs.rmSync(serviceDataDir(upstreamId), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

test('applyWikiToContract: capture_wins', () => {
  const r = applyWikiToContract(
    {
      response: { source: 'usage+capture' },
      cases: [{ id: 'success', response: { data: { a: 1 } } }],
    },
    { a: 2 },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'capture_wins');
});
