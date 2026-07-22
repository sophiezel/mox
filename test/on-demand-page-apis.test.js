'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeDocPath,
  resolvePageEntryFiles,
  buildModuleGraph,
  classifyCallKind,
  shapeIsEmpty,
  pathsMatch,
  resolvePageApisForMiss,
  clearInferCache,
} = require('../lib/on-demand-page-apis');

test('normalizeDocPath strips query and hash', () => {
  assert.equal(
    normalizeDocPath('http://127.0.0.1:8000/order/list?x=1#/tab'),
    '/order/list',
  );
  assert.equal(normalizeDocPath('/foo/bar/'), '/foo/bar');
});

test('pathsMatch exact and prefix', () => {
  assert.equal(pathsMatch('/api/v1/user', '/api/v1/user'), true);
  assert.equal(pathsMatch('/api/v1', '/api/v1/user'), true);
  assert.equal(pathsMatch('/api/v2', '/api/v1/user'), false);
});

test('shapeIsEmpty detects empty object/array shapes', () => {
  assert.equal(shapeIsEmpty({ responseShape: null }), true);
  assert.equal(shapeIsEmpty({ responseShape: { type: 'object', props: {} } }), true);
  assert.equal(
    shapeIsEmpty({
      responseShape: { type: 'object', props: { name: { type: 'string' } } },
    }),
    false,
  );
});

test('classifyCallKind: onMounted → prereq, onClick → silent', () => {
  const prereqSrc = `
export default {
  setup() {
    onMounted(() => {
      fetchUser()
    })
  }
}
`;
  assert.equal(classifyCallKind(prereqSrc, 4), 'prereq');

  const silentSrc = `
function Comp() {
  return <button onClick={() => loadMore()}>more</button>
}
`;
  assert.equal(classifyCallKind(silentSrc, 3), 'silent');
});

test('resolvePageEntryFiles + module graph from fixture', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-page-'));
  try {
    const page = path.join(root, 'src', 'views', 'order', 'list.vue');
    const api = path.join(root, 'src', 'api', 'order.js');
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.mkdirSync(path.dirname(api), { recursive: true });
    fs.writeFileSync(
      page,
      `<script>
import { fetchOrderList } from '../../api/order'
onMounted(() => fetchOrderList())
</script>
`,
    );
    fs.writeFileSync(
      api,
      `export function fetchOrderList() {
  return fetch('/api/v1/order/list')
}
`,
    );

    const entries = resolvePageEntryFiles(root, 'http://127.0.0.1:8000/order/list');
    assert.ok(entries.some((e) => e.endsWith('list.vue')));

    const graph = buildModuleGraph(root, entries, 4);
    const rels = [...graph].map((g) => path.relative(root, g).split(path.sep).join('/'));
    assert.ok(rels.some((r) => r.includes('order.js')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolvePageApisForMiss continues when page map fails', () => {
  clearInferCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-empty-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const r = resolvePageApisForMiss({
      scanDir: root,
      referer: 'http://127.0.0.1:8000/no-such-page',
      method: 'GET',
      host: 'api.example.com',
      path: '/api/x',
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'page_map_failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
