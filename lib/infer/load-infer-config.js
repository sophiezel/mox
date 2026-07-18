'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WRAPPERS = [
  {
    callee: '$HTTP',
    methods: {
      get: 'GET',
      getP: 'GET',
      post: 'POST',
      postP: 'POST',
      postJson: 'POST',
    },
  },
  {
    callee: 'http',
    methods: {
      get: 'GET',
      post: 'POST',
      put: 'PUT',
      delete: 'DELETE',
      patch: 'PATCH',
    },
  },
  {
    callee: 'request',
    methods: {
      get: 'GET',
      post: 'POST',
      put: 'PUT',
      delete: 'DELETE',
      patch: 'PATCH',
    },
  },
  {
    callee: 'api',
    methods: {
      get: 'GET',
      post: 'POST',
      put: 'PUT',
      delete: 'DELETE',
      patch: 'PATCH',
    },
  },
  {
    callee: 'apiClient',
    methods: {
      get: 'GET',
      post: 'POST',
      put: 'PUT',
      delete: 'DELETE',
      patch: 'PATCH',
    },
  },
];

/**
 * Deep-merge infer profiles. Deny-list arrays and httpWrappers are concatenated
 * and deduped; pathAliases / methods objects are shallow-merged with project winning.
 * @param {object} base
 * @param {object} over
 */
function mergeInferConfig(base, over) {
  const out = { ...(base || {}) };
  if (!over || typeof over !== 'object') return out;

  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (
      ['denyHostSuffixes', 'denyHostKeywords', 'denyPathSubstrings'].includes(k) &&
      Array.isArray(v)
    ) {
      const prev = Array.isArray(out[k]) ? out[k] : [];
      out[k] = [...new Set([...prev, ...v])];
      continue;
    }
    if (k === 'httpWrappers' && Array.isArray(v)) {
      const prev = Array.isArray(out.httpWrappers) ? out.httpWrappers : [];
      // Project wrappers appended; later same callee replaces methods via normalize
      out.httpWrappers = [...prev, ...v];
      continue;
    }
    if (k === 'pathAliases' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.pathAliases = { ...(out.pathAliases || {}), ...v };
      continue;
    }
    if (
      (k === 'callShapes' || k === 'importSources') &&
      Array.isArray(v)
    ) {
      out[k] = [...new Set(v.map(String))];
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Normalize httpWrappers: merge by callee (project overrides methods).
 * @param {object} cfg
 * @returns {object}
 */
function normalizeInferConfig(cfg) {
  const c = { ...(cfg || {}) };
  const list = Array.isArray(c.httpWrappers) ? c.httpWrappers : [...DEFAULT_WRAPPERS];
  /** @type {Map<string, { callee: string, methods: Record<string, string> }>} */
  const byCallee = new Map();
  for (const w of list) {
    if (!w || !w.callee) continue;
    const callee = String(w.callee);
    const methods = {};
    for (const [verb, method] of Object.entries(w.methods || {})) {
      methods[String(verb)] = String(method).toUpperCase();
    }
    const prev = byCallee.get(callee);
    byCallee.set(callee, {
      callee,
      methods: { ...(prev?.methods || {}), ...methods },
    });
  }
  // Ensure defaults exist even if project replaced array entirely with empty-ish
  if (byCallee.size === 0) {
    for (const w of DEFAULT_WRAPPERS) byCallee.set(w.callee, { ...w, methods: { ...w.methods } });
  }
  c.httpWrappers = [...byCallee.values()];
  c.pathAliases = c.pathAliases && typeof c.pathAliases === 'object' ? c.pathAliases : {};
  c.denyHostSuffixes = Array.isArray(c.denyHostSuffixes) ? c.denyHostSuffixes : [];
  c.denyHostKeywords = Array.isArray(c.denyHostKeywords) ? c.denyHostKeywords : [];
  c.denyPathSubstrings = Array.isArray(c.denyPathSubstrings) ? c.denyPathSubstrings : [];
  c.callShapes = Array.isArray(c.callShapes) && c.callShapes.length
    ? c.callShapes.map(String)
    : ['member', 'direct', 'config'];
  c.importSources = Array.isArray(c.importSources) && c.importSources.length
    ? c.importSources.map(String)
    : ['@umijs/max', 'umi', '@umijs/request', 'axios', 'umi-request'];
  return c;
}

/**
 * Load default.infer.json merged with <projectDir>/.mox/infer.json
 * @param {string} [projectDir]
 * @returns {object}
 */
function loadInferConfig(projectDir) {
  const root = path.join(__dirname, '..', '..');
  let base = {
    denyHostSuffixes: [],
    denyHostKeywords: [],
    denyPathSubstrings: [],
    pathAliases: {},
    httpWrappers: DEFAULT_WRAPPERS,
    callShapes: ['member', 'direct', 'config'],
    importSources: [
      '@umijs/max',
      'umi',
      '@umijs/request',
      'axios',
      'umi-request',
    ],
  };
  try {
    const file = path.join(root, 'config', 'default.infer.json');
    base = mergeInferConfig(base, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    /* keep defaults */
  }

  if (projectDir) {
    const projectFile = path.join(projectDir, '.mox', 'infer.json');
    if (fs.existsSync(projectFile)) {
      try {
        const over = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
        base = mergeInferConfig(base, over);
      } catch {
        /* ignore corrupt project config */
      }
    }
  }

  return normalizeInferConfig(base);
}

module.exports = {
  DEFAULT_WRAPPERS,
  loadInferConfig,
  mergeInferConfig,
  normalizeInferConfig,
};
