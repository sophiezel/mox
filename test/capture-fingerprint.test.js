'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  captureContentKey,
  CaptureSeenIndex,
  canonicalJson,
} = require('../lib/capture-fingerprint');

test('captureContentKey: same body same key; different page differs', () => {
  const a = {
    method: 'POST',
    host: 'h.example',
    path: '/list',
    status: 200,
    responseBody: { code: 0, data: { page: 1, detail: [{ id: 1 }] } },
  };
  const b = { ...a, responseBody: { code: 0, data: { page: 2, detail: [{ id: 2 }] } } };
  const c = {
    ...a,
    responseBody: JSON.stringify(a.responseBody),
  };
  assert.equal(captureContentKey(a), captureContentKey(c));
  assert.notEqual(captureContentKey(a), captureContentKey(b));
});

test('CaptureSeenIndex tracks per dir', () => {
  const idx = new CaptureSeenIndex();
  const key = captureContentKey({
    method: 'GET',
    host: 'a',
    path: '/x',
    status: 200,
    responseBody: { ok: true },
  });
  assert.equal(idx.has('/tmp/c1', key), false);
  idx.add('/tmp/c1', key);
  assert.equal(idx.has('/tmp/c1', key), true);
  assert.equal(idx.has('/tmp/c2', key), false);
});

test('canonicalJson sorts object keys', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
});
