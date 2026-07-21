'use strict';

/**
 * Pure rule matcher. First matching rule wins, in array order.
 *
 * Rule fields:
 * - host | hosts[] (hostname or hostname:port)
 * - ports? number[] — optional port allowlist (intersection with host:port)
 * - pathPrefix, methods
 * - when?: { query?, header? }
 *
 * ctx.port: request port (defaults applied by caller for http/https)
 */

/**
 * @param {string} authority - "host" or "host:port"
 * @returns {{ hostname: string, port: number|null }}
 */
function parseAuthority(authority) {
  const raw = String(authority || '');
  // IPv6 in brackets: [2001:db8::1]:443
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end > 0) {
      const hostname = raw.slice(0, end + 1);
      const rest = raw.slice(end + 1);
      if (rest.startsWith(':') && /^\d+$/.test(rest.slice(1))) {
        return { hostname, port: Number(rest.slice(1)) };
      }
      return { hostname, port: null };
    }
  }
  const idx = raw.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(raw.slice(idx + 1))) {
    return {
      hostname: raw.slice(0, idx),
      port: Number(raw.slice(idx + 1)),
    };
  }
  return { hostname: raw, port: null };
}

/**
 * @param {string} [scheme] - e.g. "https:" or "http:"
 * @returns {number}
 */
function defaultPortForScheme(scheme) {
  const s = String(scheme || '').toLowerCase();
  if (s === 'https:' || s === 'https') return 443;
  return 80;
}

/**
 * @param {object} when
 * @param {{ query?: object, headers?: object }} [ctx]
 */
function matchWhen(when, ctx = {}) {
  if (!when || typeof when !== 'object') return true;
  const query = ctx.query || {};
  const headers = ctx.headers || {};

  if (when.query && typeof when.query === 'object') {
    for (const [k, v] of Object.entries(when.query)) {
      if (String(query[k] ?? '') !== String(v)) return false;
    }
  }
  if (when.header && typeof when.header === 'object') {
    for (const [k, v] of Object.entries(when.header)) {
      const hv = headers[k] ?? headers[k.toLowerCase()];
      if (String(hv ?? '') !== String(v)) return false;
    }
  }
  return true;
}

/**
 * @param {Array<object>} rules
 * @param {string} hostname
 * @param {string} urlPath
 * @param {string} [method='GET']
 * @param {{ query?: object, headers?: object, port?: number|null }} [ctx]
 * @returns {object|null}
 */
function matchRule(rules, hostname, urlPath, method, ctx = {}) {
  const m = (method || 'GET').toUpperCase();
  const port = ctx.port != null && ctx.port !== '' ? Number(ctx.port) : null;
  for (const rule of rules) {
    const hostOk = matchAuthority(rule, hostname, port);
    const pathOk =
      !rule.pathPrefix ||
      urlPath === rule.pathPrefix ||
      urlPath.startsWith(rule.pathPrefix.replace(/\/$/, '') + '/') ||
      urlPath.startsWith(rule.pathPrefix);
    const methodOk =
      !rule.methods ||
      rule.methods.map((x) => x.toUpperCase()).includes(m) ||
      rule.methods.includes('*');
    const whenOk = matchWhen(rule.when, ctx);
    if (hostOk && pathOk && methodOk && whenOk) return rule;
  }
  return null;
}

/**
 * Host + optional port matching.
 * hosts[] takes priority over single host field.
 * @param {object} rule
 * @param {string} hostname
 * @param {number|null} port
 * @returns {boolean}
 */
function matchAuthority(rule, hostname, port) {
  if (Array.isArray(rule.ports) && rule.ports.length > 0) {
    if (port == null || !rule.ports.map(Number).includes(Number(port))) {
      return false;
    }
  }
  if (rule.hosts && rule.hosts.length > 0) {
    return rule.hosts.some((h) => hostMatches(h, hostname, port));
  }
  if (rule.host) {
    return hostMatches(rule.host, hostname, port);
  }
  return true;
}

/** @deprecated prefer matchAuthority — kept for callers that only pass hostname */
function matchHost(rule, hostname, port = null) {
  return matchAuthority(rule, hostname, port);
}

/**
 * @param {string} pattern - "*" | "host" | "host:port" | "*.suffix" | "*.suffix:port"
 * @param {string} hostname
 * @param {number|null} [port]
 */
function hostMatches(pattern, hostname, port = null) {
  if (!pattern || pattern === '*') return true;
  const { hostname: patHost, port: patPort } = parseAuthority(pattern);
  if (patPort != null) {
    if (port == null || Number(port) !== Number(patPort)) return false;
  }
  if (patHost === hostname) return true;
  if (patHost.startsWith('*.')) {
    return hostname.endsWith(patHost.slice(1));
  }
  return false;
}

/**
 * Match passthroughHosts entries (same host / host:port / wildcard rules).
 * @param {string[]} patterns
 * @param {string} hostname
 * @param {number|null} port
 */
function matchPassthroughHost(patterns, hostname, port = null) {
  if (!Array.isArray(patterns) || !patterns.length) return false;
  return patterns.some((p) => hostMatches(p, hostname, port));
}

/**
 * True when hostname appears in any rule's explicit hosts[] / host
 * (ignores path/method). Used for CONNECT MITM coverage decisions —
 * pathPrefix-specific matchRule(path='/') would always miss.
 *
 * Unbounded rules (no host / host:"*") do not count as coverage.
 *
 * @param {Array<object>} rules
 * @param {string} hostname
 * @param {number|null} [port]
 * @returns {boolean}
 */
function hostCoveredByRules(rules, hostname, port = null) {
  if (!Array.isArray(rules) || !hostname) return false;
  const p = port != null && port !== '' ? Number(port) : null;
  for (const rule of rules) {
    const explicitHosts = Array.isArray(rule.hosts)
      ? rule.hosts.filter((h) => h && h !== '*')
      : [];
    const hasExplicit =
      explicitHosts.length > 0 || (rule.host && rule.host !== '*');
    if (!hasExplicit) continue;
    if (matchAuthority(rule, hostname, p)) return true;
  }
  return false;
}

module.exports = {
  matchRule,
  matchWhen,
  matchHost,
  matchAuthority,
  hostMatches,
  parseAuthority,
  defaultPortForScheme,
  matchPassthroughHost,
  hostCoveredByRules,
};
