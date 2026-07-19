'use strict';

/**
 * Upstream identity model (WireMock-style): stub catalog keyed by
 * `METHOD + upstreamId + path`; environment hosts are matchers only.
 *
 * No company/brand domain strings. Only generic industry env tokens.
 */

/**
 * Generic industry-standard environment tokens. Projects may APPEND
 * their own tokens via `.mox/infer.json#envHostTokens`; they
 * cannot replace this default set.
 */
const DEFAULT_ENV_TOKENS = [
  'production',
  'prod',
  'online',
  'staging',
  'stage',
  'uat',
  'qa',
  'preview',
  'dev',
  'test',
];

const DEFAULT_TOKEN_SET = new Set(DEFAULT_ENV_TOKENS);

/**
 * Strip leading/trailing env tokens from the first DNS label of a hostname.
 * @param {string} hostname
 * @param {{ envHostTokens?: string[] }} [opts]
 * @returns {string} familyToken (or 'default' when nothing remains)
 */
function normalizeHostLabel(hostname, opts = {}) {
  if (!hostname) return 'default';
  const extra = opts.envHostTokens || [];
  const tokenSet =
    extra.length === 0
      ? DEFAULT_TOKEN_SET
      : new Set([...DEFAULT_ENV_TOKENS, ...extra]);

  let label = String(hostname).split(':')[0].split('.')[0].toLowerCase();
  if (!label) return 'default';

  let changed = true;
  while (changed) {
    changed = false;
    // trailing env token: <base>-<token>
    const tail = label.match(/^(.+)-([a-z0-9]+)$/);
    if (tail && tokenSet.has(tail[2])) {
      label = tail[1];
      changed = true;
      continue;
    }
    // leading env token: <token>-<base>
    const head = label.match(/^([a-z0-9]+)-(.+)$/);
    if (head && tokenSet.has(head[1])) {
      label = head[2];
      changed = true;
      continue;
    }
  }

  // A label that is purely an env token (e.g. "dev", "stage.example.com")
  // carries no service identity.
  if (!label || tokenSet.has(label)) return 'default';

  return label;
}

/**
 * Sanitize an arbitrary string into a safe upstreamId segment.
 * @param {string} raw
 * @returns {string}
 */
function sanitizeUpstreamId(raw) {
  if (!raw) return '_default';
  const s = String(raw)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || '_default';
}

/**
 * Real hosts only (drop empty / _default).
 * @param {string[]} hosts
 * @returns {string[]}
 */
function realHostsOf(hosts) {
  if (!Array.isArray(hosts)) return [];
  return [...new Set(hosts.filter((h) => h && h !== '_default'))];
}

/**
 * Consensus host-family label for a set of environment hosts.
 * Unique label → that label; else the longest normalized label that is a
 * hyphen-segment prefix of every label (env-noise extensions collapse;
 * sibling forks like svc-a vs svc-b do not).
 * Generic only — no brand/domain hardcoding.
 *
 * @param {string[]} hosts
 * @param {{ envHostTokens?: string[] }} [opts]
 * @returns {string|null}
 */
function consensusHostLabel(hosts, opts = {}) {
  const real = realHostsOf(hosts);
  if (!real.length) return null;

  const labels = [
    ...new Set(real.map((h) => normalizeHostLabel(h, opts)).filter(Boolean)),
  ];
  if (labels.length === 1) {
    const only = labels[0];
    if (only === 'default') return null;
    return sanitizeUpstreamId(only);
  }

  let best = null;
  let bestLen = -1;
  for (const candidate of labels) {
    if (!candidate || candidate === 'default') continue;
    const candParts = String(candidate).split('-').filter(Boolean);
    if (!candParts.length) continue;
    const isPrefixOfAll = labels.every((l) => {
      const parts = String(l).split('-').filter(Boolean);
      if (parts.length < candParts.length) return false;
      return candParts.every((seg, i) => parts[i] === seg);
    });
    if (isPrefixOfAll && candParts.length > bestLen) {
      best = candidate;
      bestLen = candParts.length;
    }
  }
  return best ? sanitizeUpstreamId(best) : null;
}

/**
 * Strict plurality label (≥2 hosts, unique max count). Used when hostVar
 * co-provenance keeps one stub but prefix-consensus failed.
 * @param {string[]} hosts
 * @param {{ envHostTokens?: string[] }} [opts]
 * @returns {string|null}
 */
function pluralityHostLabel(hosts, opts = {}) {
  const counts = new Map();
  for (const h of realHostsOf(hosts)) {
    const l = normalizeHostLabel(h, opts);
    if (!l || l === 'default') continue;
    counts.set(l, (counts.get(l) || 0) + 1);
  }
  if (!counts.size) return null;
  let best = null;
  let bestN = 0;
  let tied = false;
  for (const [l, n] of counts) {
    if (n > bestN) {
      best = l;
      bestN = n;
      tied = false;
    } else if (n === bestN) {
      tied = true;
    }
  }
  if (tied || bestN < 2) return null;
  return sanitizeUpstreamId(best);
}

/**
 * Resolve a stable service id (persisted as upstreamId) from provenance hints.
 *
 * Priority (high → low):
 * 1. consensus host-family label from real hosts (prefix consensus when labels differ)
 * 2. prefixKey (sanitized only; no `prefix-` meta marker)
 * 3. null (no signal — callers may map to `_default`)
 *
 * `hostVar` is ignored (FE symbol ≠ service id).
 *
 * @param {{ hostVar?: string, prefixKey?: string, hosts?: string[], envHostTokens?: string[] }} ctx
 * @returns {string|null}
 */
function resolveUpstreamId(ctx = {}) {
  const { prefixKey, hosts = [], envHostTokens } = ctx;

  const consensus = consensusHostLabel(hosts, { envHostTokens });
  if (consensus) return consensus;

  if (prefixKey) {
    const s = sanitizeUpstreamId(prefixKey);
    return s.length > 48 ? s.slice(0, 48) : s;
  }

  return null;
}

/**
 * Extract hints from a role/api row and resolve service id.
 * Trusted persisted `upstreamId` is sanitized only (not recomputed).
 * `hostVar` never becomes the id.
 *
 * @param {object} roleLike
 * @returns {string|null} string id, or null when hosts present but consensus failed
 *   (collapse must split); `_default` only when truly no signal.
 */
function resolveUpstreamIdFromRole(roleLike = {}) {
  if (roleLike.upstreamId) {
    return sanitizeUpstreamId(roleLike.upstreamId);
  }

  const hosts = Array.isArray(roleLike.hosts)
    ? roleLike.hosts
    : roleLike.host && roleLike.host !== '_default'
      ? [roleLike.host]
      : [];
  const real = realHostsOf(hosts);
  const resolved = resolveUpstreamId({
    prefixKey: roleLike.prefixKey,
    hosts,
    envHostTokens: roleLike.envHostTokens,
  });
  if (resolved) return resolved;
  if (real.length) return null;
  if (roleLike.prefixKey) return null;
  return '_default';
}

/** @deprecated use resolveUpstreamId — kept as alias */
function deriveUpstreamId(ctx) {
  return resolveUpstreamId(ctx);
}

/**
 * Fail closed when two non-empty host sets claim the same service id but share no host.
 * Same path under different backends must not silently merge catalogs.
 *
 * @param {string[]} existing
 * @param {string[]} incoming
 * @param {{ serviceId?: string }} [opts]
 */
function assertHostsCompatible(existing, incoming, opts = {}) {
  const a = realHostsOf(existing);
  const b = realHostsOf(incoming);
  if (!a.length || !b.length) return;
  const setB = new Set(b);
  const overlap = a.some((h) => setB.has(h));
  if (overlap) return;
  const id = opts.serviceId || '(unknown)';
  throw new Error(
    `service id "${id}" host conflict: existing=[${a.sort().join(',')}] incoming=[${b.sort().join(',')}] (disjoint — refusing silent merge)`,
  );
}

/**
 * Pick a canonical host for display/smoke. Pure-generic, no domain allowlist.
 *
 * 1. Prefer a host whose normalized label equals upstreamId AND whose first
 *    DNS label contains no env token (a "production-shaped" hostname).
 * 2. Otherwise the lexicographically smallest host (stable, brand-agnostic).
 * 3. null when hosts empty.
 *
 * @param {string[]} hosts
 * @param {string} upstreamId
 * @param {{ envHostTokens?: string[] }} [opts]
 * @returns {string|null}
 */
function pickCanonicalHost(hosts, upstreamId, opts = {}) {
  if (!hosts || hosts.length === 0) return null;
  const extra = opts.envHostTokens || [];
  const tokenSet =
    extra.length === 0
      ? DEFAULT_TOKEN_SET
      : new Set([...DEFAULT_ENV_TOKENS, ...extra]);

  const hasEnvTokenInFirstLabel = (h) => {
    const first = String(h).split(':')[0].split('.')[0].toLowerCase();
    // first label is `token-base` or `base-token` with token in set
    const parts = first.split('-');
    return parts.some((p) => tokenSet.has(p));
  };

  for (const h of hosts) {
    const label = normalizeHostLabel(h, opts);
    if (label === upstreamId && !hasEnvTokenInFirstLabel(h)) return h;
  }
  return [...hosts].sort()[0];
}

const CONFIDENCE_RANK = { low: 1, medium: 2, high: 3 };

function maxConfidence(a, b) {
  const ra = CONFIDENCE_RANK[a] || 0;
  const rb = CONFIDENCE_RANK[b] || 0;
  return ra >= rb ? a : b;
}

function shapeRichness(shape) {
  if (!shape) return 0;
  let n = 1;
  if (shape.props) n += Object.keys(shape.props).length;
  if (shape.item) n += 2 + shapeRichness(shape.item);
  return n;
}

function richestShape(members) {
  let best = null;
  let bestScore = -1;
  for (const m of members) {
    const score = shapeRichness(m.responseShape);
    if (score > bestScore) {
      best = m.responseShape;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Collapse raw API rows into stubs keyed by upstream identity.
 *
 * Grouping key: `${METHOD} ${pathname}`. Candidate families use hostVar /
 * prefixKey / host label as clues. Within a family:
 *   - consensus label or prefixKey → ONE stub with full hosts[]
 *   - true fork (no LCP, no prefixKey) → split by host label (never `_default`)
 *
 * `hostVar` never becomes upstreamId. `_default` rows drop when a real-host
 * twin exists for the same (method, path).
 *
 * @param {Array<object>} apis
 * @param {{ envHostTokens?: string[] }} [opts]
 * @returns {Array<object>}
 */
function collapseByUpstream(apis, opts = {}) {
  if (!apis || apis.length === 0) return [];
  const extra = opts.envHostTokens || [];

  const byMethodPath = new Map();
  for (const a of apis) {
    if ((a.path || '').includes('#/')) continue;
    const method = (a.method || 'GET').toUpperCase();
    const pathname = a.path.startsWith('/') ? a.path : `/${a.path}`;
    const key = `${method} ${pathname}`;
    if (!byMethodPath.has(key)) byMethodPath.set(key, []);
    byMethodPath.get(key).push(a);
  }

  const stubs = [];

  function pushStub(fam, method, pathname, upstreamId, hosts) {
    const first = fam[0];
    const canonicalHost =
      hosts.length > 0
        ? pickCanonicalHost(hosts, upstreamId, { envHostTokens: extra })
        : null;
    const evidences = [];
    const exportHints = [];
    const exportKeys = [];
    let confidence = first.confidence || 'medium';
    for (const m of fam) {
      if (m.evidence) evidences.push(m.evidence);
      if (m.exportHint && !exportHints.includes(m.exportHint)) {
        exportHints.push(m.exportHint);
      }
      if (m.exportKey && !exportKeys.includes(m.exportKey)) {
        exportKeys.push(m.exportKey);
      }
      confidence = maxConfidence(confidence, m.confidence || 'medium');
    }
    stubs.push({
      method,
      host: hosts[0] || '_default',
      hosts,
      upstreamId,
      canonicalHost,
      path: pathname,
      stubId: `${method} ${upstreamId}${pathname}`,
      confidence,
      evidence: evidences[0] || null,
      evidences,
      exportHint: exportHints[0] || null,
      exportHints,
      exportKey: exportKeys[0] || null,
      exportKeys,
      queryHints: first.queryHints || [],
      bodyHints: first.bodyHints || [],
      responseHints: first.responseHints || [],
      responseShape: richestShape(fam),
      serviceKey: first.serviceKey || null,
    });
  }

  for (const [, members] of byMethodPath) {
    const families = new Map();
    for (const m of members) {
      const hostVar = m.hostVar || null;
      const prefixKey = m.prefixKey || null;
      let familyKey;
      if (hostVar) {
        familyKey = `var:${hostVar}`;
      } else if (prefixKey) {
        familyKey = `prefix:${prefixKey}`;
      } else {
        const label = normalizeHostLabel(m.host, { envHostTokens: extra });
        familyKey = `host:${label}`;
      }
      if (!families.has(familyKey)) families.set(familyKey, []);
      families.get(familyKey).push(m);
    }

    const familyList = [...families.values()];
    const groupHasRealHost = familyList.some((fam) =>
      fam.some((m) => m.host && m.host !== '_default'),
    );
    const cleanedFamilies = familyList.map((fam) => {
      if (!groupHasRealHost) return fam;
      return fam.filter((m) => m.host !== '_default');
    });

    for (const fam of cleanedFamilies) {
      if (fam.length === 0) continue;
      const first = fam[0];
      const method = (first.method || 'GET').toUpperCase();
      const pathname = first.path.startsWith('/')
        ? first.path
        : `/${first.path}`;
      const hostSet = new Set();
      for (const m of fam) {
        if (m.host && m.host !== '_default') hostSet.add(m.host);
      }
      const hosts = [...hostSet];
      const prefixKey = first.prefixKey || null;
      const resolved = resolveUpstreamId({
        prefixKey,
        hosts,
        envHostTokens: extra,
      });

      if (resolved) {
        pushStub(fam, method, pathname, resolved, hosts);
        continue;
      }

      // hostVar co-provenance with messy env hostnames: keep one stub if a
      // strict plurality label exists (never use hostVar string as id).
      if (hosts.length > 0 && first.hostVar) {
        const plurality = pluralityHostLabel(hosts, { envHostTokens: extra });
        if (plurality) {
          pushStub(fam, method, pathname, plurality, hosts);
          continue;
        }
      }

      if (hosts.length > 0) {
        const byLabel = new Map();
        for (const m of fam) {
          if (!m.host || m.host === '_default') continue;
          const label = normalizeHostLabel(m.host, { envHostTokens: extra });
          const id =
            label && label !== 'default'
              ? sanitizeUpstreamId(label)
              : null;
          if (!id) continue;
          if (!byLabel.has(id)) byLabel.set(id, { members: [], hosts: new Set() });
          byLabel.get(id).members.push(m);
          byLabel.get(id).hosts.add(m.host);
        }
        for (const [id, bucket] of byLabel) {
          pushStub(
            bucket.members,
            method,
            pathname,
            id,
            [...bucket.hosts],
          );
        }
        continue;
      }

      pushStub(
        fam,
        method,
        pathname,
        prefixKey ? sanitizeUpstreamId(prefixKey) : '_default',
        [],
      );
    }
  }

  return stubs;
}

module.exports = {
  DEFAULT_ENV_TOKENS,
  normalizeHostLabel,
  sanitizeUpstreamId,
  consensusHostLabel,
  resolveUpstreamId,
  resolveUpstreamIdFromRole,
  deriveUpstreamId,
  assertHostsCompatible,
  realHostsOf,
  pickCanonicalHost,
  collapseByUpstream,
};
