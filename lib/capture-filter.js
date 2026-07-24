'use strict';

/**
 * Decide whether a proxy capture should be written to disk.
 * Default: catalog-scoped + browser/CDN noise denylist.
 */

const { hostMatches, hostCoveredByRules } = require('./match-rule');

/** Registrable suffixes / apex domains that are browser / CDN / telemetry noise. */
const DEFAULT_NOISE_SUFFIXES = [
  'google.com',
  'gstatic.com',
  'googleapis.com',
  'googleusercontent.com',
  'doubleclick.net',
  'googletagmanager.com',
  'google-analytics.com',
  'googlesyndication.com',
  'chrome.com',
  'chromium.org',
  'mozilla.org',
  'firefox.com',
  'microsoft.com',
  'bing.com',
  'live.com',
  'office.com',
  'office.net',
  'apple.com',
  'icloud.com',
  'mzstatic.com',
  'facebook.com',
  'fbcdn.net',
  'sentry.io',
  'getui.com',
];

function normalizeCaptureScope(scope) {
  const s = String(scope || 'catalog').toLowerCase();
  return s === 'all' ? 'all' : 'catalog';
}

/** Session proxy.mode: mock-lab (default) | capture-open */
function normalizeProxyMode(mode) {
  const m = String(mode || 'mock-lab').toLowerCase().replace(/_/g, '-');
  return m === 'capture-open' ? 'capture-open' : 'mock-lab';
}

/**
 * @param {string} hostname
 * @param {string[]} [extraSuffixes]
 */
function isCaptureNoiseHost(hostname, extraSuffixes = []) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host) return false;
  const suffixes = [
    ...DEFAULT_NOISE_SUFFIXES,
    ...(Array.isArray(extraSuffixes) ? extraSuffixes : []),
  ];
  for (const suf of suffixes) {
    const s = String(suf || '')
      .trim()
      .toLowerCase()
      .replace(/^\*\./, '');
    if (!s) continue;
    if (host === s) return true;
    if (hostMatches(`*.${s}`, host)) return true;
  }
  return false;
}

/**
 * @param {object} opts
 * @param {string} opts.host
 * @param {string} [opts.reason]
 * @param {Array<object>} [opts.rules]
 * @param {string} [opts.captureScope] catalog | all
 * @param {boolean} [opts.recordMisses]
 * @param {boolean} [opts.recordMockHits]
 * @param {string} [opts.mode] mock-lab | capture-open
 * @param {boolean} [opts.mitmPlaintext] true when body was decrypted via MITM
 * @param {number|null} [opts.port]
 */
function shouldWriteCapture(opts = {}) {
  const {
    host,
    reason,
    rules = [],
    captureScope = 'catalog',
    recordMisses = true,
    recordMockHits = false,
    captureNoiseSuffixes = [],
    port = null,
    mode = 'mock-lab',
    mitmPlaintext = false,
  } = opts;

  if (reason === 'mock-hit') {
    return Boolean(recordMockHits);
  }

  if (!recordMisses) return false;

  if (isCaptureNoiseHost(host, captureNoiseSuffixes)) return false;

  const scope = normalizeCaptureScope(captureScope);
  if (scope === 'all') return true;

  // capture-open: any MITM-decrypted exchange may be captured (noise already filtered)
  if (normalizeProxyMode(mode) === 'capture-open' && mitmPlaintext) {
    return true;
  }

  return hostCoveredByRules(rules, host, port);
}

/**
 * Effective write-block flag: mock-lab defaults on; capture-open defaults off
 * (recording needs POST passthrough). Explicit `true` under capture-open still blocks.
 *
 * @param {{ mode?: string, blockWritePassthrough?: boolean }} [proxy]
 * @returns {boolean}
 */
function resolveBlockWritePassthrough(proxy = {}) {
  const mode = normalizeProxyMode(proxy.mode);
  if (mode === 'capture-open') {
    return proxy.blockWritePassthrough === true;
  }
  return proxy.blockWritePassthrough !== false;
}

module.exports = {
  DEFAULT_NOISE_SUFFIXES,
  isCaptureNoiseHost,
  normalizeCaptureScope,
  normalizeProxyMode,
  shouldWriteCapture,
  resolveBlockWritePassthrough,
};
