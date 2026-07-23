'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const {
  decodeResponseBody,
  captureBodyFromDecoded,
} = require('../lib/decode-response-body');

test('decodeResponseBody: plain JSON identity', () => {
  const payload = { code: 0, data: { a: 1 }, message: 'ok' };
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  const d = decodeResponseBody(buf, { 'content-type': 'application/json' });
  assert.equal(d.parseOk, true);
  assert.equal(d.encoding, 'identity');
  assert.deepEqual(d.bodyJson, payload);
});

test('decodeResponseBody: gzip JSON', () => {
  const payload = { code: 0, data: { list: [1, 2] }, message: '' };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const d = decodeResponseBody(gz, {
    'content-encoding': 'gzip',
    'content-type': 'application/json;charset=utf-8',
  });
  assert.equal(d.parseOk, true);
  assert.equal(d.encoding, 'gzip');
  assert.deepEqual(d.bodyJson, payload);
});

test('decodeResponseBody: brotli JSON', () => {
  const payload = { code: 0, data: null };
  const br = zlib.brotliCompressSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const d = decodeResponseBody(br, { 'content-encoding': 'br' });
  assert.equal(d.parseOk, true);
  assert.equal(d.encoding, 'br');
  assert.deepEqual(d.bodyJson, payload);
});

test('decodeResponseBody: invalid gzip → parseOk false', () => {
  const d = decodeResponseBody(Buffer.from('not-gzip'), {
    'content-encoding': 'gzip',
  });
  assert.equal(d.parseOk, false);
  assert.ok(d.error);
});

test('captureBodyFromDecoded: only persists JSON objects', () => {
  const ok = captureBodyFromDecoded({
    parseOk: true,
    bodyJson: { code: 0, data: {} },
    encoding: 'gzip',
    contentType: 'application/json',
    byteLength: 10,
  });
  assert.deepEqual(ok.responseBody, { code: 0, data: {} });
  assert.equal(ok.bodyMeta.parseOk, true);

  const bad = captureBodyFromDecoded({
    parseOk: false,
    bodyText: '\u001f\ufffd',
    encoding: 'gzip',
    contentType: '',
    byteLength: 3,
  });
  assert.equal(bad.responseBody, undefined);
  assert.equal(bad.bodyMeta.parseOk, false);
});
