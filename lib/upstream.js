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
 * Derive a stable upstreamId from provenance hints.
 *
 * Priority (high → low):
 * 1. hostVar (from source `${apiPrefix}/x` expansion)
 * 2. prefixKey (from prefixList longest-match)
 * 3. hosts family token (when all hosts share one family)
 * 4. _default
 *
 * Returns null when hosts span multiple families and no var/prefix is given
 * (caller must NOT merge in that case).
 *
 * @param {{ hostVar?: string, prefixKey?: string, hosts?: string[], envHostTokens?: string[] }} ctx
 * @returns {string|null}
 */
function deriveUpstreamId(ctx = {}) {
  const { hostVar, prefixKey, hosts = [], envHostTokens } = ctx;

  if (hostVar) return sanitizeUpstreamId(hostVar);

  if (prefixKey) {
    const s = sanitizeUpstreamId(prefixKey);
    const trimmed = s.length > 48 ? `${s.slice(0, 48)}` : s;
    return `prefix-${trimmed}`;
  }

  if (hosts && hosts.length) {
    const realHosts = hosts.filter((h) => h && h !== '_default');
    if (realHosts.length === 0) return '_default';
    const tokens = new Set(
      realHosts.map((h) => normalizeHostLabel(h, { envHostTokens })),
    );
    if (tokens.size === 1) {
      const t = [...tokens][0];
      return sanitizeUpstreamId(t);
    }
    return null;
  }

  return '_default';
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
 * Grouping key: `${METHOD} ${pathname}`. Members of a group merge into ONE
 * stub only when they share provenance:
 *   - same hostVar, OR
 *   - same prefixKey, OR
 *   - all normalizeHostLabel(host) values are identical
 * Otherwise the group splits by family → multiple stubs.
 *
 * `_default` rows are dropped when a real-host twin exists for the same
 * (method, path).
 *
 * @param {Array<object>} apis
 * @param {{ envHostTokens?: string[] }} [opts]
 * @returns {Array<object>}
 */
function collapseByUpstream(apis, opts = {}) {
  if (!apis || apis.length === 0) return [];
  const extra = opts.envHostTokens || [];

  // 1. Partition into (method, path) groups.
  const byMethodPath = new Map();
  for (const a of apis) {
    if ((a.path || '').includes('#/')) continue;
    const method = (a.method || 'GET').toUpperCase();
    const pathname = a.path.startsWith('/') ? a.path : `/${a.path}`;
    const key = `${method} ${pathname}`;
    if (!byMethodPath.has(key)) byMethodPath.set(key, []);
    byMethodPath.get(key).push(a);
  }

  // 2. Within each (method, path) group, split by family.
  const stubs = [];
  for (const [, members] of byMethodPath) {
    const families = new Map(); // familyKey -> members
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

    // Merge families that share the SAME host label (var/prefix families
    // whose hosts collapse to one label join the host family). We only merge
    // host-based families with identical labels; var/prefix families stay
    // independent unless their host labels all match.
    const familyList = [...families.values()];

    // 3. Drop _default rows at the GROUP level when any real-host member
    //    exists for the same (method, path). This prevents a stray _default
    //    row from spawning a duplicate stub.
    const groupHasRealHost = familyList.some((fam) =>
      fam.some((m) => m.host && m.host !== '_default'),
    );
    const cleanedFamilies = familyList.map((fam) => {
      if (!groupHasRealHost) return fam;
      return fam.filter((m) => m.host !== '_default');
    });

    // 4. Build a stub per family.
    for (const fam of cleanedFamilies) {
      if (fam.length === 0) continue;
      const first = fam[0];
      const method = (first.method || 'GET').toUpperCase();
      const pathname = first.path.startsWith('/') ? first.path : `/${first.path}`;
      const hostSet = new Set();
      for (const m of fam) {
        if (m.host && m.host !== '_default') hostSet.add(m.host);
      }
      const hosts = [...hostSet];
      const ctx = {
        hostVar: first.hostVar || null,
        prefixKey: first.prefixKey || null,
        hosts,
        envHostTokens: extra,
      };
      const upstreamId = deriveUpstreamId(ctx) || '_default';
      const canonicalHost =
        hosts.length > 0 ? pickCanonicalHost(hosts, upstreamId, { envHostTokens: extra }) : null;
      const evidences = [];
      const exportHints = [];
      const exportKeys = [];
      let confidence = first.confidence || 'medium';
      for (const m of fam) {
        if (m.evidence) evidences.push(m.evidence);
        if (m.exportHint && !exportHints.includes(m.exportHint)) exportHints.push(m.exportHint);
        if (m.exportKey && !exportKeys.includes(m.exportKey)) exportKeys.push(m.exportKey);
        confidence = maxConfidence(confidence, m.confidence || 'medium');
      }
      const id = `${method} ${upstreamId}${pathname}`;
      stubs.push({
        method,
        host: hosts[0] || '_default', // transitional display host
        hosts,
        upstreamId,
        canonicalHost,
        path: pathname,
        stubId: id,
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
  }

  return stubs;
}

module.exports = {
  DEFAULT_ENV_TOKENS,
  normalizeHostLabel,
  sanitizeUpstreamId,
  deriveUpstreamId,
  pickCanonicalHost,
  collapseByUpstream,
};
