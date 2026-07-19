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
 * Resolve shared rules directory.
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

/** Global ops dirs under .data/ (not per-frontend). */
function classifyDir() {
  return path.join(getDataRoot(), 'classify');
}

function reportsDir() {
  return path.join(getDataRoot(), 'reports');
}

function auditDir() {
  return path.join(getDataRoot(), 'audit');
}

function scenariosDir() {
  return path.join(getDataRoot(), 'scenarios');
}

function exportsDir() {
  return path.join(getDataRoot(), 'exports');
}

/** Ensure global ops directories exist. */
function ensureDataDirs() {
  for (const dir of [
    classifyDir(),
    reportsDir(),
    auditDir(),
    scenariosDir(),
    exportsDir(),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return getDataRoot();
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

/**
 * Optional label for logs/audit (NOT a filesystem namespace).
 * Prefer --name; else basename of scan dir; never creates directories.
 */
function resolveScanLabel(projectDir, nameOverride) {
  if (Array.isArray(nameOverride)) {
    nameOverride = nameOverride.find((x) => x != null && x !== true && String(x).trim()) || null;
  }
  if (nameOverride != null && nameOverride !== true) {
    return sanitizeSlug(String(nameOverride));
  }
  if (projectDir) {
    return sanitizeSlug(path.basename(projectDir));
  }
  return 'default';
}

/** @deprecated use resolveScanLabel — kept for call-site migration */
function resolveProjectSlug(projectDir, nameOverride) {
  return resolveScanLabel(projectDir, nameOverride);
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

/** @deprecated alias — catalogs are services only */
function listCatalogSlugs() {
  return listServiceIds();
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
 */
function serviceContractPath(upstreamId, apiKey) {
  const safe = String(apiKey).replace(/[^a-zA-Z0-9._-]+/g, '__');
  return path.join(serviceDataDir(upstreamId), 'contracts', `${safe}.json`);
}

function chromeProfileDir(label) {
  return path.join(getDataRoot(), 'chrome-profiles', sanitizeSlug(label || 'default'));
}

/** Create Chrome profile dir only when actually launching a browser. */
function ensureChromeProfileDir(label) {
  const dir = chromeProfileDir(label);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** @deprecated no-op wrapper — use ensureDataDirs() */
function ensureProjectDirs(_ignored) {
  return ensureDataDirs();
}

/**
 * @deprecated legacy path under projects/ — prefer serviceContractPath
 */
function projectDataDir(slug) {
  return path.join(getDataRoot(), 'projects', sanitizeSlug(slug || 'default'));
}

/**
 * @deprecated use serviceContractPath
 */
function contractPath(projectSlug, apiKey) {
  const safe = String(apiKey).replace(/[^a-zA-Z0-9._-]+/g, '__');
  return path.join(projectDataDir(projectSlug), 'contracts', `${safe}.json`);
}

/**
 * @deprecated legacy FQDN project mocks
 */
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
 */
function stubId({ upstreamId, method, path: p }) {
  const m = (method || 'GET').toUpperCase();
  const up = upstreamId || '_default';
  const pathname = p.startsWith('/') ? p : `/${p}`;
  return `${m} ${up}${pathname}`;
}

function isUnsafeRelativePath(relative) {
  if (!relative) return false;
  if (path.isAbsolute(relative)) return true;
  const parts = relative.split(/[/\\]/);
  return parts.some((p) => p === '..' || p === '');
}

/**
 * Filesystem path for a stub handler (always service catalog).
 */
function stubHandlerPath(_projectSlug, upstreamId, method, urlPath) {
  return serviceStubHandlerPath(upstreamId, method, urlPath);
}

/**
 * @deprecated legacy project-local stub handler path
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
  classifyDir,
  reportsDir,
  auditDir,
  scenariosDir,
  exportsDir,
  ensureDataDirs,
  listCatalogSlugs,
  listServiceIds,
  sanitizeSlug,
  sanitizeUpstreamId,
  resolveScanLabel,
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
