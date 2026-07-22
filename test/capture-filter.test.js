'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isCaptureNoiseHost,
  shouldWriteCapture,
  normalizeCaptureScope,
} = require('../lib/capture-filter');

test('isCaptureNoiseHost matches google and related suffixes', () => {
  assert.equal(isCaptureNoiseHost('clients2.google.com'), true);
  assert.equal(isCaptureNoiseHost('www.gstatic.com'), true);
  assert.equal(isCaptureNoiseHost('fonts.googleapis.com'), true);
  assert.equal(isCaptureNoiseHost('jian-j.guazi-cloud.com'), false);
  assert.equal(isCaptureNoiseHost('cdn.example.com'), false);
});

test('normalizeCaptureScope defaults to catalog', () => {
  assert.equal(normalizeCaptureScope(), 'catalog');
  assert.equal(normalizeCaptureScope('ALL'), 'all');
  assert.equal(normalizeCaptureScope('catalog'), 'catalog');
  assert.equal(normalizeCaptureScope('weird'), 'catalog');
});

const jianRules = [
  {
    stubId: 'GET jian-j/x',
    hosts: ['jian-j.guazi-cloud.com'],
    pathPrefix: '/x',
    methods: ['GET'],
  },
];

test('shouldWriteCapture: catalog miss on covered host', () => {
  assert.equal(
    shouldWriteCapture({
      host: 'jian-j.guazi-cloud.com',
      reason: 'miss',
      rules: jianRules,
      captureScope: 'catalog',
      recordMisses: true,
    }),
    true,
  );
});

test('shouldWriteCapture: catalog miss on uncovered host dropped', () => {
  assert.equal(
    shouldWriteCapture({
      host: 'cdn.example.com',
      reason: 'miss',
      rules: jianRules,
      captureScope: 'catalog',
      recordMisses: true,
    }),
    false,
  );
});

test('shouldWriteCapture: scope all still records non-noise uncovered', () => {
  assert.equal(
    shouldWriteCapture({
      host: 'cdn.example.com',
      reason: 'miss',
      rules: jianRules,
      captureScope: 'all',
      recordMisses: true,
    }),
    true,
  );
});

test('shouldWriteCapture: google noise always dropped even scope all', () => {
  assert.equal(
    shouldWriteCapture({
      host: 'clients2.google.com',
      reason: 'miss',
      rules: jianRules,
      captureScope: 'all',
      recordMisses: true,
    }),
    false,
  );
});

test('shouldWriteCapture: mock-hit follows recordMockHits only', () => {
  assert.equal(
    shouldWriteCapture({
      host: 'cdn.example.com',
      reason: 'mock-hit',
      rules: [],
      captureScope: 'catalog',
      recordMisses: true,
      recordMockHits: false,
    }),
    false,
  );
  assert.equal(
    shouldWriteCapture({
      host: 'cdn.example.com',
      reason: 'mock-hit',
      rules: [],
      captureScope: 'catalog',
      recordMisses: false,
      recordMockHits: true,
    }),
    true,
  );
});

test('shouldWriteCapture: recordMisses false drops miss', () => {
  assert.equal(
    shouldWriteCapture({
      host: 'jian-j.guazi-cloud.com',
      reason: 'miss',
      rules: jianRules,
      captureScope: 'catalog',
      recordMisses: false,
    }),
    false,
  );
});

test('shouldWriteCapture: capture-open allows non-catalog host when mitmPlaintext=true', () => {
  assert.equal(
    shouldWriteCapture({
      host: 'cdn.example.com',
      reason: 'miss',
      rules: jianRules,
      captureScope: 'catalog',
      recordMisses: true,
      mode: 'capture-open',
      mitmPlaintext: true,
    }),
    true,
  );
});

test('shouldWriteCapture: mock-lab still denies non-catalog under captureScope=catalog', () => {
  assert.equal(
    shouldWriteCapture({
      host: 'cdn.example.com',
      reason: 'miss',
      rules: jianRules,
      captureScope: 'catalog',
      recordMisses: true,
      mode: 'mock-lab',
      mitmPlaintext: true,
    }),
    false,
  );
});

test('shouldWriteCapture: capture-open still drops noise even with mitmPlaintext', () => {
  assert.equal(
    shouldWriteCapture({
      host: 'clients2.google.com',
      reason: 'miss',
      rules: jianRules,
      captureScope: 'catalog',
      recordMisses: true,
      mode: 'capture-open',
      mitmPlaintext: true,
    }),
    false,
  );
});
