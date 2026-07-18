'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SESSION = path.join(ROOT, 'config', 'default.session.json');
const DEFAULT_RULES_DIR = path.join(ROOT, 'rules');

function getDataRoot() {
  return process.env.MOX_DATA_ROOT
    ? path.resolve(process.env.MOX_DATA_ROOT)
    : path.join(ROOT, '.data');
}

function getGlobalSessionPath() {
  return process.env.MOX_SESSION_FILE
    ? path.resolve(process.env.MOX_SESSION_FILE)
    : path.join(getDataRoot(), 'session.json');
}

function getGlobalRuntimePath() {
  return process.env.MOX_RUNTIME_FILE
    ? path.resolve(process.env.MOX_RUNTIME_FILE)
    : path.join(getDataRoot(), 'runtime.json');
}

/** Persisted Virtual Service hit journal (cross-process stop summary). */
function getServiceJournalPath() {
  return process.env.MOX_JOURNAL_FILE
    ? path.resolve(process.env.MOX_JOURNAL_FILE)
    : path.join(getDataRoot(), 'service-journal.json');
}

/**
 * Resolve shared rules directory (not under projects/).
 * @param {string} [override]
 * @returns {string}
 */
function rulesDir(override) {
  if (override) return path.resolve(override);
  if (process.env.MOX_RULES_DIR) {
    return path.resolve(process.env.MOX_RULES_DIR);
  }
  return DEFAULT_RULES_DIR;
}

/**
 * List mountable catalog keys: project slugs with index.json or proxy-rules.json.
 * Prefer services via listServiceIds() for "all services" mounts.
 * @returns {string[]}
 */
function listCatalogSlugs() {
  const root = path.join(getDataRoot(), 'projects');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => {
      const base = path.join(root, name);
      return (
        fs.existsSync(path.join(base, 'proxy-rules.json')) ||
        fs.existsSync(path.join(base, 'index.json'))
      );
    })
    .sort();
}

function sanitizeSlug(raw) {
  if (!raw || typeof raw !== 'string') return 'unnamed';
  let s = raw.trim();
  if (s.startsWith('@')) {
    const slash = s.indexOf('/');
    if (slash !== -1) s = s.slice(slash + 1);
  }
  s = s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return s || 'unnamed';
}

function resolveProjectSlug(projectDir, nameOverride) {
  // CLI --name may arrive as string[] from multi-flag parseArgs
  if (Array.isArray(nameOverride)) {
    nameOverride = nameOverride.find((x) => x != null && x !== true && String(x).trim()) || null;
  }
  if (nameOverride != null && nameOverride !== true) {
    return sanitizeSlug(String(nameOverride));
  }
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name) return sanitizeSlug(pkg.name);
    } catch (_) {
      /* ignore */
    }
  }
  return sanitizeSlug(path.basename(projectDir));
}

function projectDataDir(projectSlug) {
  return path.join(getDataRoot(), 'projects', projectSlug);
}

/**
 * Sanitize upstreamId for filesystem (service catalog key).
 * @param {string} raw
 * @returns {string}
 */
function sanitizeUpstreamId(raw) {
  if (!raw || typeof raw !== 'string') return '_default';
  const s = raw.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_+/g, '_');
  return s || '_default';
}

/**
 * Service catalog root: .data/services/<upstreamId>/
 * @param {string} upstreamId
 * @returns {string}
 */
function serviceDataDir(upstreamId) {
  return path.join(getDataRoot(), 'services', sanitizeUpstreamId(upstreamId));
}

/**
 * List upstreamIds that have a service proxy-rules.json.
 * @returns {string[]}
 */
function listServiceIds() {
  const root = path.join(getDataRoot(), 'services');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => {
      const rules = path.join(root, name, 'proxy-rules.json');
      return fs.existsSync(rules);
    })
    .sort();
}

function ensureServiceDirs(upstreamId) {
  const base = serviceDataDir(upstreamId);
  for (const sub of ['contracts', 'mocks', 'captures']) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
  return base;
}

/**
 * Handler path under service catalog:
 *   services/<upstreamId>/mocks/<METHOD>/<path>/index.js
 * @param {string} upstreamId
 * @param {string} method
 * @param {string} urlPath
 * @returns {string}
 */
function serviceStubHandlerPath(upstreamId, method, urlPath) {
  const m = (method || 'GET').toUpperCase();
  const relative = String(urlPath || '').replace(/^\//, '');
  if (isUnsafeRelativePath(relative)) {
    throw new Error(`unsafe path segments in serviceStubHandlerPath: ${urlPath}`);
  }
  return path.join(serviceDataDir(upstreamId), 'mocks', m, relative, 'index.js');
}

/**
 * Contract path under service catalog.
 * @param {string} upstreamId
 * @param {string} apiKey
 * @returns {string}
 */
function serviceContractPath(upstreamId, apiKey) {
  const safe = String(apiKey).replace(/[^a-zA-Z0-9._-]+/g, '__');
  return path.join(serviceDataDir(upstreamId), 'contracts', `${safe}.json`);
}

function chromeProfileDir(projectSlug) {
  return path.join(getDataRoot(), 'chrome-profiles', projectSlug);
}

/** Create Chrome profile dir only when actually launching a browser. */
function ensureChromeProfileDir(projectSlug) {
  const dir = chromeProfileDir(projectSlug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureProjectDirs(projectSlug) {
  const base = projectDataDir(projectSlug);
  for (const sub of [
    'contracts',
    'mocks',
    'classify',
    'captures',
    'reports',
    'audit',
    'scenarios',
    'exports',
  ]) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
  // Do NOT mkdir chrome-profiles here — that leaked hundreds of empty dirs from tests/init.
  return base;
}

function contractPath(projectSlug, apiKey) {
  const safe = apiKey.replace(/[^a-zA-Z0-9._-]+/g, '__');
  return path.join(projectDataDir(projectSlug), 'contracts', `${safe}.json`);
}

function mockHandlerPath(projectSlug, host, urlPath) {
  const cleanHost = (host || '_default').replace(/[^a-zA-Z0-9._-]+/g, '_');
  const cleanPath = urlPath.replace(/^\//, '').replace(/\.\./g, '');
  return path.join(projectDataDir(projectSlug), 'mocks', cleanHost, cleanPath, 'index.js');
}

function apiKey({ host, method, path: p }) {
  const m = (method || 'GET').toUpperCase();
  const h = host || '_default';
  const pathname = p.startsWith('/') ? p : `/${p}`;
  return `${m} ${h}${pathname}`;
}

/**
 * Build a stubId from upstream identity (NOT a FQDN host).
 * @param {{ upstreamId: string, method: string, path: string }} parts
 * @returns {string}
 */
function stubId({ upstreamId, method, path: p }) {
  const m = (method || 'GET').toUpperCase();
  const up = upstreamId || '_default';
  const pathname = p.startsWith('/') ? p : `/${p}`;
  return `${m} ${up}${pathname}`;
}

/**
 * Reject path segments that enable traversal or absolute escapes.
 * @param {string} relative
 */
function isUnsafeRelativePath(relative) {
  if (!relative) return false;
  if (path.isAbsolute(relative)) return true;
  const parts = relative.split(/[/\\]/);
  return parts.some((p) => p === '..' || p === '');
}

/**
 * Filesystem path for a stub handler.
 * Prefers service catalog layout; falls back to legacy project layout.
 *   services/<upstreamId>/mocks/<METHOD>/<path>/index.js
 *   projects/<slug>/mocks/<upstreamId>/<METHOD>/<path>/index.js (legacy)
 * @param {string} projectSlug
 * @param {string} upstreamId
 * @param {string} method
 * @param {string} urlPath
 * @returns {string}
 */
function stubHandlerPath(projectSlug, upstreamId, method, urlPath) {
  return serviceStubHandlerPath(upstreamId, method, urlPath);
}

/**
 * Legacy project-local stub handler path (pre service-catalog).
 * @param {string} projectSlug
 * @param {string} upstreamId
 * @param {string} method
 * @param {string} urlPath
 * @returns {string}
 */
function legacyStubHandlerPath(projectSlug, upstreamId, method, urlPath) {
  const up = sanitizeUpstreamId(upstreamId);
  const m = (method || 'GET').toUpperCase();
  const relative = String(urlPath || '').replace(/^\//, '');
  if (isUnsafeRelativePath(relative)) {
    throw new Error(`unsafe path segments in legacyStubHandlerPath: ${urlPath}`);
  }
  return path.join(
    projectDataDir(projectSlug),
    'mocks',
    up,
    m,
    relative,
    'index.js',
  );
}

/**
 * Parse a stubId back into { method, upstreamId, path }.
 * Format: `METHOD upstreamId/path`
 * @param {string} id
 * @returns {{ method: string, upstreamId: string, path: string }}
 */
function parseStubId(id) {
  const spaceIdx = String(id).indexOf(' ');
  if (spaceIdx === -1) {
    throw new Error(`invalid stubId: ${id}`);
  }
  const method = id.slice(0, spaceIdx).toUpperCase();
  const rest = id.slice(spaceIdx + 1);
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) {
    throw new Error(`invalid stubId (no path): ${id}`);
  }
  const upstreamId = rest.slice(0, slashIdx);
  const pathname = rest.slice(slashIdx);
  return { method, upstreamId, path: pathname };
}

function pathDepth(pathname) {
  return String(pathname || '')
    .split('/')
    .filter(Boolean).length;
}

module.exports = {
  ROOT,
  getDataRoot,
  getGlobalSessionPath,
  getGlobalRuntimePath,
  getServiceJournalPath,
  DEFAULT_SESSION,
  DEFAULT_RULES_DIR,
  rulesDir,
  listCatalogSlugs,
  listServiceIds,
  sanitizeSlug,
  sanitizeUpstreamId,
  resolveProjectSlug,
  projectDataDir,
  serviceDataDir,
  ensureServiceDirs,
  serviceStubHandlerPath,
  serviceContractPath,
  chromeProfileDir,
  ensureChromeProfileDir,
  ensureProjectDirs,
  contractPath,
  mockHandlerPath,
  apiKey,
  stubId,
  stubHandlerPath,
  legacyStubHandlerPath,
  parseStubId,
  pathDepth,
};

Object.defineProperty(module.exports, 'DATA_ROOT', {
  enumerable: true,
  get: getDataRoot,
});
Object.defineProperty(module.exports, 'GLOBAL_SESSION', {
  enumerable: true,
  get: getGlobalSessionPath,
});
Object.defineProperty(module.exports, 'GLOBAL_RUNTIME', {
  enumerable: true,
  get: getGlobalRuntimePath,
});
