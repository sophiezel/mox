'use strict';

/**
 * Page-scoped API discovery for on-demand mock.
 * Referer → entry files → bounded import graph → infer APIs in that graph,
 * classified as page-prereq vs silent (event-handler).
 */

const fs = require('fs');
const path = require('path');

const MAX_GRAPH_DEPTH = 6;
const PAGE_DIR_RE = /(^|\/)(pages|views|routes|src)(\/|$)/i;
const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.vue', '.mjs', '.cjs']);

const PREREQ_MARKERS =
  /\b(onMounted|created|setup|beforeMount|beforeCreate|useEffect|loader)\b/;
const SILENT_MARKERS =
  /\b(onClick|onclick|@click|addEventListener|onSubmit|@submit|onChange|@change)\b/;

/** @type {Map<string, { at: number, apis: object[] }>} */
const inferCache = new Map();
const INFER_TTL_MS = 60_000;

function stripEvidenceLine(ev) {
  return String(ev || '')
    .replace(/:\d+\s*$/, '')
    .replace(/\\/g, '/');
}

function evidenceRelFiles(api) {
  const raw = [];
  if (Array.isArray(api.evidences)) raw.push(...api.evidences);
  if (api.evidence) raw.push(api.evidence);
  const out = [];
  for (const e of raw) {
    const f = stripEvidenceLine(e);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

function evidenceLine(api) {
  const first = (api.evidences && api.evidences[0]) || api.evidence || '';
  const m = String(first).match(/:(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

function normalizeDocPath(refererUrlOrPath) {
  if (!refererUrlOrPath) return null;
  try {
    const u =
      String(refererUrlOrPath).startsWith('http://') ||
      String(refererUrlOrPath).startsWith('https://')
        ? new URL(refererUrlOrPath)
        : null;
    let p = u ? u.pathname : String(refererUrlOrPath);
    p = p.split('?')[0].split('#')[0];
    if (!p || p === '/') return '/';
    return p.endsWith('/') && p.length > 1 ? p.slice(0, -1) : p;
  } catch {
    return null;
  }
}

function walkCodeFiles(root, maxFiles = 4000) {
  const out = [];
  const skip = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '.data',
  ]);
  function walk(dir) {
    if (out.length >= maxFiles) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (out.length >= maxFiles) return;
      if (ent.name.startsWith('.') && ent.name !== '.') continue;
      if (skip.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile() && CODE_EXT.has(path.extname(ent.name))) {
        out.push(abs);
      }
    }
  }
  walk(root);
  return out;
}

/**
 * Heuristic: match Referer path segments to pages/views/routes/src files.
 * @returns {string[]} absolute entry file paths
 */
function resolvePageEntryFiles(scanDir, documentPath) {
  const doc = normalizeDocPath(documentPath);
  if (!doc || !scanDir) return [];
  const segments = doc.split('/').filter(Boolean);
  const last = segments[segments.length - 1] || 'index';
  const lastLower = last.toLowerCase();
  const files = walkCodeFiles(scanDir);
  const scored = [];

  for (const abs of files) {
    const rel = path.relative(scanDir, abs).split(path.sep).join('/');
    if (!PAGE_DIR_RE.test(`/${rel}`)) continue;
    const base = path.basename(abs, path.extname(abs)).toLowerCase();
    const relLower = rel.toLowerCase();
    let score = 0;
    if (base === lastLower || base === `${lastLower}-page`) score += 5;
    if (base === 'index' && relLower.includes(`/${lastLower}/`)) score += 4;
    for (const seg of segments) {
      if (relLower.includes(`/${seg.toLowerCase()}/`) || relLower.includes(`/${seg.toLowerCase()}.`)) {
        score += 1;
      }
    }
    if (score > 0) scored.push({ abs, score, rel });
  }

  scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  const top = scored.filter((s) => s.score >= scored[0]?.score).slice(0, 8);
  return top.map((s) => s.abs);
}

function readText(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

function resolveImportSpec(fromFile, spec, scanDir) {
  if (!spec || spec.startsWith('http')) return null;
  let target = spec;
  if (target.startsWith('@/') || target.startsWith('~/')) {
    target = path.join(scanDir, 'src', target.slice(2));
  } else if (target.startsWith('.')) {
    target = path.resolve(path.dirname(fromFile), target);
  } else {
    return null; // bare package
  }
  const candidates = [
    target,
    `${target}.js`,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.jsx`,
    `${target}.vue`,
    path.join(target, 'index.js'),
    path.join(target, 'index.ts'),
    path.join(target, 'index.vue'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function extractImportSpecs(source) {
  const specs = [];
  const re =
    /(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+[\s\S]*?\s+from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source))) {
    specs.push(m[1]);
  }
  return specs;
}

/**
 * Bounded BFS import graph from entry files.
 * @returns {Set<string>} absolute file paths
 */
function buildModuleGraph(scanDir, entryFiles, maxDepth = MAX_GRAPH_DEPTH) {
  const seen = new Set();
  /** @type {{ file: string, depth: number }[]} */
  const queue = [];
  for (const f of entryFiles) {
    const abs = path.resolve(f);
    if (!seen.has(abs)) {
      seen.add(abs);
      queue.push({ file: abs, depth: 0 });
    }
  }
  while (queue.length) {
    const { file, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    const src = readText(file);
    for (const spec of extractImportSpecs(src)) {
      const resolved = resolveImportSpec(file, spec, scanDir);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push({ file: resolved, depth: depth + 1 });
    }
  }
  return seen;
}

/**
 * @returns {'prereq'|'silent'}
 */
function classifyCallKind(source, line) {
  if (!source || !line) return 'prereq';
  const lines = source.split(/\r?\n/);
  const idx = Math.max(0, line - 1);
  const from = Math.max(0, idx - 25);
  const to = Math.min(lines.length, idx + 8);
  const window = lines.slice(from, to).join('\n');
  if (SILENT_MARKERS.test(window) && !PREREQ_MARKERS.test(window)) {
    return 'silent';
  }
  if (PREREQ_MARKERS.test(window)) return 'prereq';
  // Default: top-level / unclear → prereq when document GET (caller may override)
  return 'prereq';
}

function loadInferredApis(scanDir) {
  const key = path.resolve(scanDir);
  const hit = inferCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < INFER_TTL_MS) return hit.apis;
  const { inferApiUsage } = require('../scripts/infer-api-usage');
  const raw = inferApiUsage(key, { withUsageIo: true });
  const apis = Array.isArray(raw) ? raw : [];
  inferCache.set(key, { at: now, apis });
  return apis;
}

function clearInferCache() {
  inferCache.clear();
}

function apiInGraph(api, graphRelSet, scanDir) {
  for (const rel of evidenceRelFiles(api)) {
    const abs = path.isAbsolute(rel) ? rel : path.join(scanDir, rel);
    const norm = path.resolve(abs);
    if (graphRelSet.has(norm)) return true;
    // also try posix rel match
    const asRel = path.relative(scanDir, norm).split(path.sep).join('/');
    for (const g of graphRelSet) {
      const gRel = path.relative(scanDir, g).split(path.sep).join('/');
      if (gRel === asRel || gRel.endsWith(rel) || rel.endsWith(gRel)) return true;
    }
  }
  return false;
}

function pathsMatch(apiPath, reqPath) {
  if (!apiPath || !reqPath) return false;
  if (apiPath === reqPath) return true;
  // rule pathPrefix style
  if (reqPath === apiPath || reqPath.startsWith(apiPath.endsWith('/') ? apiPath : `${apiPath}/`)) {
    return true;
  }
  return false;
}

function hostsMatch(api, host) {
  if (!host) return true;
  const hosts = Array.isArray(api.hosts)
    ? api.hosts
    : api.host && api.host !== '_default'
      ? [api.host]
      : [];
  if (!hosts.length) return true;
  return hosts.includes(host);
}

/**
 * @param {{ scanDir: string, referer?: string|null, method: string, host: string, path: string }} opts
 */
function resolvePageApisForMiss(opts) {
  const scanDir = path.resolve(opts.scanDir || '');
  if (!scanDir || !fs.existsSync(scanDir)) {
    return {
      ok: false,
      reason: 'no_scan_dir',
      pageApis: [],
      matched: null,
      kind: null,
    };
  }

  const docPath = normalizeDocPath(opts.referer);
  const entries = resolvePageEntryFiles(scanDir, docPath);
  if (!entries.length) {
    return {
      ok: false,
      reason: 'page_map_failed',
      pageApis: [],
      matched: null,
      kind: null,
      documentPath: docPath,
    };
  }

  const graph = buildModuleGraph(scanDir, entries);
  const allApis = loadInferredApis(scanDir);
  const pageApis = [];

  for (const api of allApis) {
    if (!apiInGraph(api, graph, scanDir)) continue;
    const files = evidenceRelFiles(api);
    let kind = 'prereq';
    for (const rel of files) {
      const abs = path.isAbsolute(rel) ? rel : path.join(scanDir, rel);
      const src = readText(abs);
      kind = classifyCallKind(src, evidenceLine(api));
      break;
    }
    pageApis.push({ api, kind });
  }

  const method = String(opts.method || 'GET').toUpperCase();
  const reqPath = opts.path || '/';
  const host = opts.host || '';

  let matched = null;
  for (const row of pageApis) {
    const a = row.api;
    if (String(a.method || 'GET').toUpperCase() !== method) continue;
    if (!pathsMatch(a.path, reqPath)) continue;
    if (!hostsMatch(a, host)) continue;
    matched = row;
    break;
  }

  // Fallback kind when matched but unclear: document GET → prereq
  let kind = matched?.kind || null;
  if (matched && kind !== 'silent' && kind !== 'prereq') {
    kind =
      method === 'GET' && docPath ? 'prereq' : 'silent';
  }
  if (matched && !kind) {
    kind =
      method === 'GET' && docPath ? 'prereq' : 'silent';
  }

  return {
    ok: true,
    reason: null,
    documentPath: docPath,
    entries: entries.map((e) => path.relative(scanDir, e)),
    pageApis,
    matched: matched ? matched.api : null,
    kind: matched ? kind || matched.kind : null,
  };
}

function shapeIsEmpty(api) {
  const shape = api?.responseShape;
  if (!shape || typeof shape !== 'object') return true;
  if (shape.type === 'array') {
    const item = shape.item || {};
    return !item.props || Object.keys(item.props).length === 0;
  }
  if (shape.type === 'object') {
    return !shape.props || Object.keys(shape.props).length === 0;
  }
  return true;
}

module.exports = {
  normalizeDocPath,
  resolvePageEntryFiles,
  buildModuleGraph,
  classifyCallKind,
  resolvePageApisForMiss,
  loadInferredApis,
  clearInferCache,
  shapeIsEmpty,
  evidenceRelFiles,
  pathsMatch,
  hostsMatch,
};
