'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { inferApiUsage } = require('../scripts/infer-api-usage');
const { buildContract } = require('../scripts/generate-mock');
const { materialize } = require('../lib/materialize');

function withTempProject(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-arr-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function findApi(apis, name) {
  return apis.find((a) => a.exportHint === name || a.path?.includes(name));
}

test('array+forEach: res=await; this.list=res&&res.data; item.cityId → item props', () => {
  withTempProject(
    {
      'src/service/index.js': `
export function getStoreListByCityId(params) {
  return fetch('https://api.example.com/v1/stores');
}
`,
      'src/page/AdjustData/index.vue': `
<script>
import { getStoreListByCityId } from '@/service'
export default {
  methods: {
    async load() {
      let res
      res = await getStoreListByCityId({ cityId: 1 })
      this.list = res && res.data
      this.list.forEach((item, index) => {
        this.ids.push(item.cityId)
        this.names.push(item.storeName)
      })
    }
  }
}
</script>
`,
    },
    (root) => {
      const apis = inferApiUsage(root, { withUsageIo: true });
      const api = findApi(apis, 'getStoreListByCityId');
      assert.ok(api, 'API discovered');
      assert.equal(api.responseShape?.type, 'array');
      const itemProps = api.responseShape?.item?.props || {};
      assert.ok(itemProps.cityId, `expected cityId in item.props, got ${Object.keys(itemProps)}`);
      assert.ok(itemProps.storeName, `expected storeName in item.props`);
      const contract = buildContract(
        { ...api, role: 'new', hasMock: false },
        { source: 'usage' },
      );
      assert.equal(contract.response.source, 'usage');
      assert.ok(Array.isArray(contract.cases.find((c) => c.id === 'success')?.response?.data));
    },
  );
});

test('nested object: const { data } = await api(); this.x = data.items', () => {
  withTempProject(
    {
      'src/service/index.js': `
export function getPage() {
  return fetch('https://api.example.com/v1/page');
}
`,
      'src/page/A.js': `
import { getPage } from '@/service'
export async function load() {
  const { data } = await getPage()
  this.x = data.items
  return data.total
}
`,
    },
    (root) => {
      const apis = inferApiUsage(root, { withUsageIo: true });
      const api = findApi(apis, 'getPage');
      assert.ok(api);
      const props = api.responseShape?.props || {};
      assert.ok(props.items, `expected items, got ${Object.keys(props)}`);
      assert.ok(props.total, `expected total, got ${Object.keys(props)}`);
    },
  );
});

test('optional chain: data?.total / res.data?.list', () => {
  withTempProject(
    {
      'src/service/index.js': `
export function getOpt() {
  return fetch('https://api.example.com/v1/opt');
}
`,
      'src/page/B.js': `
import { getOpt } from '@/service'
export async function load() {
  const res = await getOpt()
  const n = res.data?.list
  const { data } = res
  return data?.total
}
`,
    },
    (root) => {
      const apis = inferApiUsage(root, { withUsageIo: true });
      const api = findApi(apis, 'getOpt');
      assert.ok(api);
      const props = api.responseShape?.props || {};
      assert.ok(props.list, `expected list, got ${Object.keys(props)}`);
      assert.ok(props.total, `expected total, got ${Object.keys(props)}`);
    },
  );
});

test('whole-data assign without forEach: no invented item fields', () => {
  withTempProject(
    {
      'src/service/index.js': `
export function getRawList() {
  return fetch('https://api.example.com/v1/raw');
}
`,
      'src/page/C.js': `
import { getRawList } from '@/service'
export async function load() {
  const res = await getRawList()
  this.list = res && res.data
}
`,
    },
    (root) => {
      const apis = inferApiUsage(root, { withUsageIo: true });
      const api = findApi(apis, 'getRawList');
      assert.ok(api);
      // Arrayness only from forEach / ||[] / v-for — bare assign invents no item keys
      const itemProps =
        api.responseShape?.type === 'array'
          ? api.responseShape.item?.props
          : {};
      assert.deepEqual(Object.keys(itemProps || {}), []);
      assert.ok(!(api.coverage?.gaps || []).includes('no_callsite'));
    },
  );
});

test('materialize: empty array shape → []', () => {
  assert.deepEqual(
    materialize({ type: 'array', item: { type: 'object', props: {} } }),
    [],
  );
});

test('report hints: same exportHint across hosts de-dupes', () => {
  const { generateMocks } = require('../scripts/generate-mock');
  const { serviceDataDir } = require('../lib/paths');
  const slug = `hint-dedupe-${Date.now()}`;
  const roles = [
    {
      method: 'GET',
      host: 'a.example.com',
      path: '/v1/x',
      role: 'new',
      hasMock: false,
      exportHint: 'getX',
      responseShape: { type: 'object', props: { id: { type: 'number' } } },
      coverage: { gaps: [], request: {}, response: {}, enums: [] },
    },
    {
      method: 'GET',
      host: 'b.example.com',
      path: '/v1/x',
      role: 'new',
      hasMock: false,
      exportHint: 'getX',
      responseShape: { type: 'object', props: { id: { type: 'number' } } },
      coverage: { gaps: [], request: {}, response: {}, enums: [] },
    },
    {
      method: 'GET',
      host: 'a.example.com',
      path: '/v1/y',
      role: 'new',
      hasMock: false,
      exportHint: 'getY',
      responseShape: { type: 'object', props: {} },
      coverage: {
        gaps: ['no_property_access'],
        request: {},
        response: {},
        enums: [],
      },
    },
    {
      method: 'GET',
      host: 'b.example.com',
      path: '/v1/y',
      role: 'new',
      hasMock: false,
      exportHint: 'getY',
      responseShape: { type: 'object', props: {} },
      coverage: {
        gaps: ['no_property_access'],
        request: {},
        response: {},
        enums: [],
      },
    },
  ];
  try {
    const gen = generateMocks({
      projectSlug: slug,
      roles,
      force: true,
      merge: false,
    });
    assert.equal(gen.usageBackedCount, 2);
    assert.equal(gen.emptyDataCount, 2);
    assert.equal(gen.usageBackedHints, 1);
    assert.equal(gen.emptyDataHints, 1);
  } finally {
    const { serviceDataDir } = require('../lib/paths');
    if (fs.existsSync(serviceDataDir('svc-a'))) {
      fs.rmSync(serviceDataDir('svc-a'), { recursive: true, force: true });
    }
  }
});
