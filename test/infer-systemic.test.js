'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { inferApiUsage } = require('../scripts/infer-api-usage');
const {
  loadInferConfig,
  mergeInferConfig,
} = require('../lib/infer/load-infer-config');
const { resolveCompilerPathOptions } = require('../lib/infer/path-aliases');

function withTempProject(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'infer-sys-'));
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

function shapeKeys(api) {
  return Object.keys(api?.responseShape?.props || {});
}

test('infer profile: project .mox/infer.json merges over defaults', () => {
  withTempProject(
    {
      '.mox/infer.json': JSON.stringify({
        httpWrappers: [
          {
            callee: '$API',
            methods: { getP: 'GET', postP: 'POST' },
          },
        ],
        denyHostKeywords: ['my-cdn.'],
      }),
    },
    (root) => {
      const cfg = loadInferConfig(root);
      assert.ok(cfg.httpWrappers.some((w) => w.callee === '$API'));
      assert.ok(cfg.httpWrappers.some((w) => w.callee === '$HTTP'));
      assert.ok(cfg.denyHostKeywords.includes('my-cdn.'));
    },
  );
});

test('path aliases: convention @ and ~ when src exists and no jsconfig', () => {
  withTempProject({ 'src/a.js': 'export const x = 1;' }, (root) => {
    const opts = resolveCompilerPathOptions(root, {});
    assert.deepEqual(opts.paths['@/*'], ['src/*']);
    assert.deepEqual(opts.paths['~/*'], ['src/*']);
  });
});

test('matrix A: import from @/service + res.data.itemId → static usageBacked', () => {
  withTempProject(
    {
      'src/service/index.js': `
export function getList(params) {
  return fetch('https://api.example.com/v1/items');
}
`,
      'src/page/List.vue': `
<script>
import { getList } from '@/service'
export default {
  methods: {
    load() {
      getList().then(res => {
        this.itemId = res.data.itemId
        this.title = res.data.title
      })
    }
  }
}
</script>
`,
    },
    (root) => {
      const apis = inferApiUsage(root, { forceRefresh: true });
      const hit = apis.find(
        (a) => a.path === '/v1/items' && a.exportHint === 'getList',
      );
      assert.ok(hit, JSON.stringify(apis.map((a) => a.path)));
      const keys = shapeKeys(hit);
      assert.ok(keys.includes('itemId'), keys.join(','));
      assert.ok(keys.includes('title'), keys.join(','));
      assert.ok(!(hit.coverage?.gaps || []).includes('no_callsite'));
    },
  );
});

test('matrix B: import from ~/api + destructure { data: { a } }', () => {
  withTempProject(
    {
      'src/api/index.js': `
export function fetchUser() {
  return fetch('https://api.example.com/v1/user');
}
`,
      'src/page/User.vue': `
<script>
import { fetchUser } from '~/api'
export default {
  async mounted() {
    fetchUser().then(({ data: { a, b } }) => {
      this.a = a
      this.b = b
    })
  }
}
</script>
`,
    },
    (root) => {
      const apis = inferApiUsage(root, { forceRefresh: true });
      const hit = apis.find((a) => a.exportHint === 'fetchUser');
      assert.ok(hit, apis.map((a) => a.exportHint).join(','));
      const keys = shapeKeys(hit);
      assert.ok(keys.includes('a'), keys.join(','));
      assert.ok(keys.includes('b'), keys.join(','));
    },
  );
});

test('matrix C: relative path import still works', () => {
  withTempProject(
    {
      'src/service/orders.js': `
export async function getOrder() {
  return fetch('https://api.example.com/v1/orders/1');
}
`,
      'src/page/Order.js': `
import { getOrder } from '../service/orders'
export async function load() {
  const res = await getOrder()
  return res.data.orderId
}
`,
    },
    (root) => {
      const apis = inferApiUsage(root, { forceRefresh: true });
      const hit = apis.find((a) => a.exportHint === 'getOrder');
      assert.ok(hit);
      // relative may resolve via findReferences; either way expect no_callsite absent or shape
      const gaps = hit.coverage?.gaps || [];
      const keys = shapeKeys(hit);
      assert.ok(
        keys.includes('orderId') || !gaps.includes('no_callsite'),
        JSON.stringify({ keys, gaps }),
      );
    },
  );
});

test('matrix D: custom $API only via project infer.json wrappers', () => {
  withTempProject(
    {
      '.mox/infer.json': JSON.stringify({
        httpWrappers: [
          {
            callee: '$API',
            methods: { getP: 'GET', postP: 'POST' },
          },
        ],
      }),
      'src/service/index.js': `
let apiBase
apiBase = '//api.example.com'
apiBase = '//api-preview.example.com'
const getDemo = (data) => $API.getP(\`\${ apiBase }/demo/list\`, data)
export { getDemo }
`,
      'src/page/Demo.vue': `
<script>
import { getDemo } from '@/service'
export default {
  created() {
    getDemo().then(res => {
      this.name = res.data.name
    })
  }
}
</script>
`,
    },
    (root) => {
      const apis = inferApiUsage(root, { forceRefresh: true });
      const demos = apis.filter((a) => a.path === '/demo/list');
      assert.equal(demos.length, 1, `expected 1 collapsed stub, got ${demos.length}: ${JSON.stringify(demos)}`);
      assert.equal(demos[0].hosts.length, 2, '2 env hosts collapsed into one stub');
      assert.ok(demos.every((a) => a.exportHint === 'getDemo'));
      assert.ok(demos.every((a) => a.method === 'GET'));
      const withShape = demos.find((a) => shapeKeys(a).includes('name'));
      assert.ok(withShape, 'static shape should include name');
    },
  );
});

test('matrix E: whole-data assign this.x = res.data allows empty props', () => {
  withTempProject(
    {
      'src/service/index.js': `
export function getBlob() {
  return fetch('https://api.example.com/v1/blob');
}
`,
      'src/page/Blob.vue': `
<script>
import { getBlob } from '@/service'
export default {
  methods: {
    load() {
      getBlob().then(res => {
        this.payload = res.data
      })
    }
  }
}
</script>
`,
    },
    (root) => {
      const apis = inferApiUsage(root, { forceRefresh: true });
      const hit = apis.find((a) => a.exportHint === 'getBlob');
      assert.ok(hit);
      assert.ok(!(hit.coverage?.gaps || []).includes('no_callsite'));
      // No field drill-down → empty props is OK (no invented keys)
      assert.equal(shapeKeys(hit).length, 0);
    },
  );
});

test('mergeInferConfig: project pathAliases overlay', () => {
  const merged = mergeInferConfig(
    { pathAliases: { '@/*': ['src/*'] } },
    { pathAliases: { '~/*': ['app/*'] } },
  );
  assert.deepEqual(merged.pathAliases['@/*'], ['src/*']);
  assert.deepEqual(merged.pathAliases['~/*'], ['app/*']);
});
