'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchRule,
  hostMatches,
  parseAuthority,
  defaultPortForScheme,
} = require('../lib/match-rule');

test('P1: hosts entry with host:port matches only that port', () => {
  const rules = [
    {
      id: 'r8443',
      hosts: ['api.example.com:8443'],
      pathPrefix: '/v1',
      methods: ['GET'],
    },
  ];
  assert.ok(
    matchRule(rules, 'api.example.com', '/v1/x', 'GET', { port: 8443 }),
  );
  assert.equal(
    matchRule(rules, 'api.example.com', '/v1/x', 'GET', { port: 443 }),
    null,
  );
});

test('P2: bare host matches any port when rule has no ports[]', () => {
  const rules = [
    {
      id: 'r',
      hosts: ['api.example.com'],
      pathPrefix: '/v1',
      methods: ['GET'],
    },
  ];
  assert.ok(matchRule(rules, 'api.example.com', '/v1/x', 'GET', { port: 443 }));
  assert.ok(matchRule(rules, 'api.example.com', '/v1/x', 'GET', { port: 8443 }));
});

test('P3: ports[] constrains matching when set', () => {
  const rules = [
    {
      id: 'r',
      hosts: ['api.example.com'],
      ports: [443, 8443],
      pathPrefix: '/v1',
      methods: ['GET'],
    },
  ];
  assert.ok(matchRule(rules, 'api.example.com', '/v1/x', 'GET', { port: 443 }));
  assert.ok(matchRule(rules, 'api.example.com', '/v1/x', 'GET', { port: 8443 }));
  assert.equal(
    matchRule(rules, 'api.example.com', '/v1/x', 'GET', { port: 8080 }),
    null,
  );
});

test('P4: host:port + ports[] must satisfy both', () => {
  const rules = [
    {
      id: 'r',
      hosts: ['api.example.com:8443'],
      ports: [8443, 9443],
      pathPrefix: '/v1',
      methods: ['GET'],
    },
  ];
  assert.ok(matchRule(rules, 'api.example.com', '/v1/x', 'GET', { port: 8443 }));
  assert.equal(
    matchRule(rules, 'api.example.com', '/v1/x', 'GET', { port: 9443 }),
    null,
  );
});

test('P5: parseAuthority splits host:port; defaultPortForScheme', () => {
  assert.deepEqual(parseAuthority('api.example.com:8443'), {
    hostname: 'api.example.com',
    port: 8443,
  });
  assert.deepEqual(parseAuthority('api.example.com'), {
    hostname: 'api.example.com',
    port: null,
  });
  assert.deepEqual(parseAuthority('[2409:8c1e:75b0:1120::2d]:8080'), {
    hostname: '[2409:8c1e:75b0:1120::2d]',
    port: 8080,
  });
  assert.equal(defaultPortForScheme('https:'), 443);
  assert.equal(defaultPortForScheme('http:'), 80);
});

test('P6: hostMatches with port-aware pattern', () => {
  assert.equal(hostMatches('api.example.com:8443', 'api.example.com', 8443), true);
  assert.equal(hostMatches('api.example.com:8443', 'api.example.com', 443), false);
  assert.equal(hostMatches('api.example.com', 'api.example.com', 443), true);
  assert.equal(hostMatches('*.example.com:443', 'sub.example.com', 443), true);
  assert.equal(hostMatches('*.example.com:443', 'sub.example.com', 8443), false);
});
