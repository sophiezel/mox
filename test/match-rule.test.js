'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchRule } = require('../lib/match-rule');

const rules = [
  { id: 'a', host: 'api.example.com', pathPrefix: '/v1/users', methods: ['GET'] },
  { id: 'b', host: '*.example.com', pathPrefix: '/v1/orders', methods: ['GET', 'POST'] },
  { id: 'c', host: 'api.example.com', pathPrefix: '/v1', methods: ['*'] },
  { id: 'd', pathPrefix: '/public', methods: ['GET'] },
];

test('exact host + path prefix match', () => {
  const r = matchRule(rules, 'api.example.com', '/v1/users', 'GET');
  assert.equal(r.id, 'a');
});

test('wildcard host match', () => {
  const r = matchRule(rules, 'sub.example.com', '/v1/orders', 'POST');
  assert.equal(r.id, 'b');
});

test('method wildcard', () => {
  const r = matchRule(rules, 'api.example.com', '/v1/anything', 'DELETE');
  assert.equal(r.id, 'c');
});

test('no host matches any host', () => {
  const r = matchRule(rules, 'other.host', '/public', 'GET');
  assert.equal(r.id, 'd');
});

test('method mismatch on a strict-method rule falls through to wildcard-method rule', () => {
  // rule a (GET only) won't match POST, but rule c (methods: ['*'], prefix /v1) will
  const r = matchRule(rules, 'api.example.com', '/v1/users', 'POST');
  assert.equal(r.id, 'c');
});

test('no match returns null', () => {
  const r = matchRule(rules, 'api.example.com', '/unknown', 'GET');
  assert.equal(r, null);
});

test('path prefix /v1 matches /v1/foo (wildcard-method rule)', () => {
  assert.ok(matchRule(rules, 'api.example.com', '/v1/foo', 'GET'));
});

test('Whistle / boundary: /v1 does not match /v1users', () => {
  const r = matchRule(rules, 'api.example.com', '/v1users', 'GET');
  assert.equal(r, null);
});

test('pathPrefix / matches any path', () => {
  const root = [
    { id: 'root', host: 'api.example.com', pathPrefix: '/', methods: ['GET'] },
  ];
  assert.equal(
    matchRule(root, 'api.example.com', '/anything', 'GET').id,
    'root',
  );
  assert.equal(matchRule(root, 'api.example.com', '/', 'GET').id, 'root');
});

test('empty rules returns null', () => {
  assert.equal(matchRule([], 'api.example.com', '/x', 'GET'), null);
});

test('when.query must match', () => {
  const withWhen = [
    {
      id: 'q',
      host: 'api.example.com',
      pathPrefix: '/v1/search',
      methods: ['GET'],
      when: { query: { q: 'foo' } },
    },
  ];
  assert.equal(
    matchRule(withWhen, 'api.example.com', '/v1/search', 'GET', {
      query: { q: 'bar' },
    }),
    null,
  );
  assert.equal(
    matchRule(withWhen, 'api.example.com', '/v1/search', 'GET', {
      query: { q: 'foo' },
    }).id,
    'q',
  );
});

test('when.header must match (case-insensitive header lookup)', () => {
  const withWhen = [
    {
      id: 'h',
      host: 'api.example.com',
      pathPrefix: '/v1/x',
      methods: ['GET'],
      when: { header: { 'x-tenant': 'a' } },
    },
  ];
  assert.equal(
    matchRule(withWhen, 'api.example.com', '/v1/x', 'GET', {
      headers: { 'x-tenant': 'b' },
    }),
    null,
  );
  assert.equal(
    matchRule(withWhen, 'api.example.com', '/v1/x', 'GET', {
      headers: { 'x-tenant': 'a' },
    }).id,
    'h',
  );
});
