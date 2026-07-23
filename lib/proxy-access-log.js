'use strict';

/**
 * Proxy access observability: keep detailed `action` in jsonl;
 * console shows short labels and is filtered by MOX_PROXY_LOG.
 */

/** @typedef {'mock'|'fail'|'upstream'|'connect'|'tool'} AccessLabel */
/** @typedef {'signal'|'noise'} AccessBucket */
/** @typedef {'summary'|'verbose'|'silent'} ProxyLogLevel */

/** @type {Record<string, { label: AccessLabel, bucket: AccessBucket }>} */
const ACTION_CLASS = {
  mock: { label: 'mock', bucket: 'signal' },
  'mitm-mock': { label: 'mock', bucket: 'signal' },
  'on-demand-mock': { label: 'mock', bucket: 'signal' },

  reject: { label: 'fail', bucket: 'signal' },
  'block-write': { label: 'fail', bucket: 'signal' },
  'on-demand-gap': { label: 'fail', bucket: 'signal' },
  'connect-bad-port': { label: 'fail', bucket: 'signal' },
  'connect-deny': { label: 'fail', bucket: 'signal' },
  'connect-deny-loopback': { label: 'fail', bucket: 'signal' },
  'connect-mitm-fail': { label: 'fail', bucket: 'signal' },
  'connect-mitm-tls-error': { label: 'fail', bucket: 'signal' },
  'connect-tunnel-fail': { label: 'fail', bucket: 'signal' },
  'mitm-passthrough-error': { label: 'fail', bucket: 'signal' },

  passthrough: { label: 'upstream', bucket: 'noise' },
  'mitm-passthrough': { label: 'upstream', bucket: 'noise' },
  'traffic-passthrough': { label: 'upstream', bucket: 'noise' },
  'mitm-traffic-passthrough': { label: 'upstream', bucket: 'noise' },
  'passthrough-host': { label: 'upstream', bucket: 'noise' },
  'on-demand-no-rule-after-gen': { label: 'upstream', bucket: 'noise' },

  'connect-mitm': { label: 'connect', bucket: 'noise' },
  'connect-tunnel': { label: 'connect', bucket: 'noise' },
  'connect-tunnel-cronet': { label: 'connect', bucket: 'noise' },

  'mox-hub': { label: 'tool', bucket: 'noise' },
  'mox-pac': { label: 'tool', bucket: 'noise' },
  'mox-ca-info': { label: 'tool', bucket: 'noise' },
  'mox-ca-download': { label: 'tool', bucket: 'noise' },
  options: { label: 'tool', bucket: 'noise' },
  'mitm-options': { label: 'tool', bucket: 'noise' },
  'mitm-check': { label: 'tool', bucket: 'noise' },
};

/**
 * @param {string} [action]
 * @returns {{ label: AccessLabel, bucket: AccessBucket }}
 */
function classifyAccess(action) {
  const a = String(action || '');
  const hit = ACTION_CLASS[a];
  if (hit) return hit;
  if (
    /-fail$/.test(a) ||
    /-error$/.test(a) ||
    a.startsWith('connect-deny') ||
    a === 'reject' ||
    a === 'block-write'
  ) {
    return { label: 'fail', bucket: 'signal' };
  }
  if (a.startsWith('connect-')) {
    return { label: 'connect', bucket: 'noise' };
  }
  if (a.startsWith('mox-') || a.includes('options') || a === 'mitm-check') {
    return { label: 'tool', bucket: 'noise' };
  }
  if (a.includes('mock')) {
    return { label: 'mock', bucket: 'signal' };
  }
  if (a.includes('passthrough')) {
    return { label: 'upstream', bucket: 'noise' };
  }
  return { label: 'tool', bucket: 'noise' };
}

/**
 * @param {string|boolean|undefined|null} raw
 * @returns {'summary'|'verbose'|'silent'|null} null = not provided
 */
function parseProxyLogLevelToken(raw) {
  if (raw == null || raw === true || raw === false) return null;
  const v = String(raw).trim().toLowerCase();
  if (!v) return null;
  if (v === 'summary' || v === 'default') return 'summary';
  if (v === 'verbose' || v === 'debug' || v === 'all') return 'verbose';
  if (v === 'silent' || v === 'off' || v === '0' || v === 'none') {
    return 'silent';
  }
  throw new Error(
    `invalid proxy-log "${raw}"; expected: summary | verbose | silent`,
  );
}

/**
 * Priority: explicit raw (CLI/opts) > MOX_PROXY_LOG > summary.
 * @param {string|boolean|undefined|null} [raw]
 * @returns {ProxyLogLevel}
 */
function resolveProxyLogLevel(raw) {
  const fromArg = parseProxyLogLevelToken(raw);
  if (fromArg) return fromArg;
  const fromEnv = parseProxyLogLevelToken(process.env.MOX_PROXY_LOG);
  if (fromEnv) return fromEnv;
  return 'summary';
}

/**
 * @param {{ action?: string, label?: AccessLabel, bucket?: AccessBucket }} entry
 * @param {ProxyLogLevel} [level]
 * @returns {boolean}
 */
function shouldPrintConsole(entry, level) {
  const lvl = level || resolveProxyLogLevel();
  if (lvl === 'silent') return false;
  if (lvl === 'verbose') return true;
  const { label, bucket } =
    entry.label && entry.bucket
      ? { label: entry.label, bucket: entry.bucket }
      : classifyAccess(entry.action);
  return bucket === 'signal' && (label === 'mock' || label === 'fail');
}

/**
 * @param {{ action?: string, method?: string, url?: string, label?: string }} entry
 * @returns {string}
 */
function formatConsoleLine(entry) {
  const { label } = entry.label
    ? { label: entry.label }
    : classifyAccess(entry.action);
  const method = entry.method || '';
  const url = entry.url || '';
  const base = `[proxy] ${label}  ${method} ${url}`.trimEnd();
  if (label === 'fail' && entry.action) {
    return `${base}  (${entry.action})`;
  }
  return base;
}

/**
 * Enrich entry for jsonl (keeps original action).
 * @param {object} entry
 * @returns {object}
 */
function enrichAccessEntry(entry) {
  const { label, bucket } = classifyAccess(entry.action);
  return { ...entry, label, bucket };
}

module.exports = {
  ACTION_CLASS,
  classifyAccess,
  parseProxyLogLevelToken,
  resolveProxyLogLevel,
  shouldPrintConsole,
  formatConsoleLine,
  enrichAccessEntry,
};
