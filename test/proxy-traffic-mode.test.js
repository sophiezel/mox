'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startProxyServer } = require('../runtime/proxy/server');

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      resolve({
        server: s,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r, j) => s.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

function proxyGet(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    http
      .request(
        {
          hostname: '127.0.0.1',
          port: proxyPort,
          path: targetUrl,
          method: 'GET',
        },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () =>
            resolve({
              status: r.statusCode,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      )
      .on('error', reject)
      .end();
  });
}

const RULE = {
  id: 'GET svc-a/v1/items',
  stubId: 'GET svc-a/v1/items',
  upstreamId: 'svc-a',
  hosts: ['svc-a.example.com'],
  pathPrefix: '/v1/items',
  methods: ['GET'],
};

test('PT1: all-mock — matched rule goes to mock server', async () => {
  const mock = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ from: 'mock' }));
  });
  const upstream = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ from: 'upstream' }));
  });
  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: mock.url,
    rules: [RULE],
    missPolicy: 'passthrough',
    trafficMode: 'all-mock',
    blockWritePassthrough: false,
  });
  try {
    // Absolute-form request with Host of svc-a; upstream wouldn't be hit if mock works.
    // We rewrite by pointing Host — path uses absolute URL so hostname is svc-a.example.com
    const res = await proxyGet(
      proxy.port,
      'http://svc-a.example.com/v1/items',
    );
    assert.equal(res.status, 200);
    assert.match(res.body, /mock/);
  } finally {
    await proxy.close();
    await mock.close();
    await upstream.close();
  }
});

test('PT2: all-passthrough — matched rule still hits real upstream', async () => {
  const mock = await listen((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ from: 'mock' }));
  });
  // Real upstream on loopback — rewrite rule host to 127.0.0.1 via Host header absolute URL
  // forwardUpstream uses target hostname from URL, so we need the absolute URL to hit
  // our upstream. Use hosts that resolve... Actually forwardUpstream connects to
  // svc-a.example.com which won't resolve. Instead: use 127.0.0.1 as rule host.
  const upstream = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ from: 'upstream' }));
  });
  const rule = {
    ...RULE,
    hosts: ['127.0.0.1'],
  };
  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: mock.url,
    rules: [rule],
    missPolicy: 'passthrough',
    trafficMode: 'all-passthrough',
    blockWritePassthrough: false,
  });
  try {
    const res = await proxyGet(
      proxy.port,
      `http://127.0.0.1:${upstream.port}/v1/items`,
    );
    assert.equal(res.status, 200);
    assert.match(res.body, /upstream/);
  } finally {
    await proxy.close();
    await mock.close();
    await upstream.close();
  }
});

test('PT3: selective — allowlist mocks; others passthrough', async () => {
  const mock = await listen((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ from: 'mock' }));
  });
  const upstream = await listen((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ from: 'upstream' }));
  });
  const ruleMock = {
    id: 'GET svc-a/v1/items',
    stubId: 'GET svc-a/v1/items',
    hosts: ['127.0.0.1'],
    pathPrefix: '/v1/items',
    methods: ['GET'],
  };
  const rulePass = {
    id: 'GET svc-a/v1/other',
    stubId: 'GET svc-a/v1/other',
    hosts: ['127.0.0.1'],
    pathPrefix: '/v1/other',
    methods: ['GET'],
  };
  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: mock.url,
    rules: [ruleMock, rulePass],
    missPolicy: 'passthrough',
    trafficMode: 'selective',
    mockAllowlist: ['GET svc-a/v1/items'],
    blockWritePassthrough: false,
  });
  try {
    const mocked = await proxyGet(
      proxy.port,
      `http://127.0.0.1:${upstream.port}/v1/items`,
    );
    assert.match(mocked.body, /mock/);
    const passed = await proxyGet(
      proxy.port,
      `http://127.0.0.1:${upstream.port}/v1/other`,
    );
    assert.match(passed.body, /upstream/);
  } finally {
    await proxy.close();
    await mock.close();
    await upstream.close();
  }
});

test('PT4: passthroughHosts wins over trafficMode all-mock', async () => {
  const mock = await listen((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ from: 'mock' }));
  });
  const upstream = await listen((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ from: 'upstream' }));
  });
  const rule = {
    id: 'GET svc-a/v1/items',
    stubId: 'GET svc-a/v1/items',
    hosts: ['127.0.0.1'],
    pathPrefix: '/v1/items',
    methods: ['GET'],
  };
  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: mock.url,
    rules: [rule],
    missPolicy: 'passthrough',
    trafficMode: 'all-mock',
    passthroughHosts: [`127.0.0.1:${upstream.port}`],
    blockWritePassthrough: false,
  });
  try {
    const res = await proxyGet(
      proxy.port,
      `http://127.0.0.1:${upstream.port}/v1/items`,
    );
    assert.match(res.body, /upstream/);
  } finally {
    await proxy.close();
    await mock.close();
    await upstream.close();
  }
});

test('PT5: trafficLoader hot-reloads mode without restart', async () => {
  const mock = await listen((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ from: 'mock' }));
  });
  const upstream = await listen((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ from: 'upstream' }));
  });
  let live = { trafficMode: 'all-mock', mockAllowlist: [] };
  const rule = {
    id: 'GET svc-a/v1/items',
    stubId: 'GET svc-a/v1/items',
    hosts: ['127.0.0.1'],
    pathPrefix: '/v1/items',
    methods: ['GET'],
  };
  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: mock.url,
    rules: [rule],
    missPolicy: 'passthrough',
    trafficMode: 'all-mock',
    trafficLoader: () => live,
    blockWritePassthrough: false,
  });
  try {
    const a = await proxyGet(
      proxy.port,
      `http://127.0.0.1:${upstream.port}/v1/items`,
    );
    assert.match(a.body, /mock/);
    live = { trafficMode: 'all-passthrough', mockAllowlist: [] };
    await new Promise((r) => setTimeout(r, 1100)); // TTL
    const b = await proxyGet(
      proxy.port,
      `http://127.0.0.1:${upstream.port}/v1/items`,
    );
    assert.match(b.body, /upstream/);
  } finally {
    await proxy.close();
    await mock.close();
    await upstream.close();
  }
});

test('PT6: rulesLoader hot-reloads rules without restart', async () => {
  const mock = await listen((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ from: 'mock' }));
  });
  const upstream = await listen((req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ from: 'upstream' }));
  });
  const detailRule = {
    id: 'GET svc-a/v1/detail',
    stubId: 'GET svc-a/v1/detail',
    hosts: ['127.0.0.1'],
    pathPrefix: '/v1/detail',
    methods: ['GET'],
  };
  let liveRules = [];
  const proxy = await startProxyServer({
    host: '127.0.0.1',
    port: 0,
    mockTarget: mock.url,
    rules: [],
    missPolicy: 'passthrough',
    trafficMode: 'all-mock',
    rulesLoader: () => liveRules,
    blockWritePassthrough: false,
  });
  try {
    const a = await proxyGet(
      proxy.port,
      `http://127.0.0.1:${upstream.port}/v1/detail`,
    );
    assert.match(a.body, /upstream/);
    liveRules = [detailRule];
    await new Promise((r) => setTimeout(r, 1100)); // TTL
    const b = await proxyGet(
      proxy.port,
      `http://127.0.0.1:${upstream.port}/v1/detail`,
    );
    assert.match(b.body, /mock/);
  } finally {
    await proxy.close();
    await mock.close();
    await upstream.close();
  }
});
