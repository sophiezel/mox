'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedOrigin } = require('../lib/cors');

test('localhost allowed by default', () => {
  assert.equal(isAllowedOrigin('http://localhost:8080'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:3000'), true);
  assert.equal(isAllowedOrigin('https://[::1]:9000'), true);
  assert.equal(isAllowedOrigin('http://localhost'), true);
});

test('default reflectOrigin allows any remote Origin (no domain hardcode)', () => {
  assert.equal(isAllowedOrigin('https://api.example.com'), true);
  assert.equal(isAllowedOrigin('https://ping-fe.example.com'), true);
  assert.equal(isAllowedOrigin('https://foo.bar.baz'), true);
});

test('reflectOrigin false restores whitelist', () => {
  const cfg = { reflectOrigin: false };
  assert.equal(isAllowedOrigin('https://api.example.com', cfg), false);
  assert.equal(isAllowedOrigin('http://localhost:8080', cfg), true);
});

test('extraOrigins exact + wildcard when reflectOrigin false', () => {
  const cfg = {
    reflectOrigin: false,
    extraOrigins: ['https://h5.app', '*.my-scheme'],
  };
  assert.equal(isAllowedOrigin('https://h5.app', cfg), true);
  assert.equal(isAllowedOrigin('custom://my.my-scheme', cfg), true);
  assert.equal(isAllowedOrigin('https://other.app', cfg), false);
});

test('no company domain is hardcoded (allowance is reflect, not a brand list)', () => {
  // Allowed only because reflectOrigin defaults true — not a guazi allowlist.
  assert.equal(isAllowedOrigin('https://anything-example-cloud.com'), true);
  assert.equal(
    isAllowedOrigin('https://guazi.com', { reflectOrigin: false }),
    false,
  );
});

test('allowLocalhost false disables localhost when not reflecting', () => {
  assert.equal(
    isAllowedOrigin('http://localhost:8080', {
      reflectOrigin: false,
      allowLocalhost: false,
    }),
    false,
  );
});

test('empty origin rejected', () => {
  assert.equal(isAllowedOrigin(''), false);
  assert.equal(isAllowedOrigin(undefined), false);
});
