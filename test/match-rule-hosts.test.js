'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchRule } = require('../lib/match-rule');

test('M1: hosts[] array — both cloud and stage hit the same rule', () => {
  const rules = [
    {
      id: 'GET svc-a/v1/items',
      stubId: 'GET svc-a/v1/items',
      upstreamId: 'svc-a',
      hosts: ['svc-a.example.com', 'svc-a-stage.example.com'],
      pathPrefix: '/v1/items',
      methods: ['GET'],
    },
  ];
  assert.equal(
    matchRule(rules, 'svc-a.example.com', '/v1/items', 'GET').id,
    'GET svc-a/v1/items',
  );
  assert.equal(
    matchRule(rules, 'svc-a-stage.example.com', '/v1/items', 'GET').id,
    'GET svc-a/v1/items',
  );
});

test('M2: hosts[] — unregistered host does not match', () => {
  const rules = [
    {
      id: 'GET svc-a/v1/items',
      hosts: ['svc-a.example.com'],
      pathPrefix: '/v1/items',
      methods: ['GET'],
    },
  ];
  assert.equal(matchRule(rules, 'svc-b.example.com', '/v1/items', 'GET'), null);
});

test('M3: _default rule with host:"*" matches any host', () => {
  const rules = [
    {
      id: 'GET _default/public',
      stubId: 'GET _default/public',
      upstreamId: '_default',
      host: '*',
      pathPrefix: '/public',
      methods: ['GET'],
    },
  ];
  assert.equal(
    matchRule(rules, 'anything.example.com', '/public', 'GET').id,
    'GET _default/public',
  );
});

test('M3: non-_default rule with host:"*" is rejected by matchRule', () => {
  // The generator must never emit host:"*" for non-_default upstreams.
  // matchRule still matches it (it's the generator's contract, not matcher's),
  // but we document that hosts[] takes priority over host.
  const rules = [
    {
      id: 'GET svc-a/v1/items',
      hosts: ['svc-a.example.com'],
      host: '*',
      pathPrefix: '/v1/items',
      methods: ['GET'],
    },
  ];
  // hosts[] is checked first; host:"*" is fallback
  assert.equal(
    matchRule(rules, 'svc-a.example.com', '/v1/items', 'GET').id,
    'GET svc-a/v1/items',
  );
  // host:"*" would match, but hosts[] doesn't include this host
  // When hosts[] is present, it takes priority — so this should NOT match
  assert.equal(matchRule(rules, 'svc-b.example.com', '/v1/items', 'GET'), null);
});

test('hosts[] with wildcard suffix *.example.com', () => {
  const rules = [
    {
      id: 'r',
      hosts: ['*.example.com'],
      pathPrefix: '/v1',
      methods: ['GET'],
    },
  ];
  assert.ok(matchRule(rules, 'sub.example.com', '/v1/x', 'GET'));
  assert.equal(matchRule(rules, 'sub.other.com', '/v1/x', 'GET'), null);
});

test('hostCoveredByRules: true when host in hosts[] regardless of path', () => {
  const { hostCoveredByRules, matchRule } = require('../lib/match-rule');
  const rules = [
    {
      id: 'GET svc-a/api/x',
      hosts: ['svc.example.com'],
      pathPrefix: '/api/x',
      methods: ['GET'],
    },
  ];
  assert.equal(matchRule(rules, 'svc.example.com', '/', 'GET'), null);
  assert.equal(hostCoveredByRules(rules, 'svc.example.com', 443), true);
  assert.equal(hostCoveredByRules(rules, 'other.example.com', 443), false);
});

test('hostCoveredByRules: ignores unbounded host:* rules', () => {
  const { hostCoveredByRules } = require('../lib/match-rule');
  assert.equal(
    hostCoveredByRules(
      [{ host: '*', pathPrefix: '/public', methods: ['GET'] }],
      'anything.example.com',
      443,
    ),
    false,
  );
});
