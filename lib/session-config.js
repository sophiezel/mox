'use strict';

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_SESSION,
  getDataRoot,
  getGlobalSessionPath,
  getGlobalRuntimePath,
  projectDataDir,
  chromeProfileDir,
  ensureDataDirs,
  ROOT,
} = require('./paths');

function deepMerge(base, over) {
  if (!over) return { ...base };
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === 'object' &&
      !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function loadDefault() {
  return JSON.parse(fs.readFileSync(DEFAULT_SESSION, 'utf8'));
}

function ensureDataRoot() {
  fs.mkdirSync(getDataRoot(), { recursive: true });
}

/**
 * Normalize legacy `saveSession(slug, partial)` vs `saveSession(partial)`.
 * @param {string|object} a
 * @param {object} [b]
 * @returns {{ slugHint: string|null, partial: object }}
 */
function normalizeSaveArgs(a, b) {
  if (typeof a === 'string') {
    return { slugHint: a, partial: b && typeof b === 'object' ? b : {} };
  }
  return { slugHint: null, partial: a && typeof a === 'object' ? a : {} };
}

/**
 * One-time migrate: prefer newest per-project session.json into global.
 * @param {string|null} [preferSlug]
 */
function migrateLegacySessions(preferSlug) {
  ensureDataRoot();
  const globalFile = getGlobalSessionPath();
  if (fs.existsSync(globalFile)) return;

  const candidates = [];
  const projectsRoot = path.join(getDataRoot(), 'projects');
  if (fs.existsSync(projectsRoot)) {
    for (const name of fs.readdirSync(projectsRoot)) {
      const file = path.join(projectsRoot, name, 'session.json');
      if (!fs.existsSync(file)) continue;
      const st = fs.statSync(file);
      candidates.push({ slug: name, file, mtime: st.mtimeMs });
    }
  }
  if (!candidates.length) return;

  candidates.sort((x, y) => y.mtime - x.mtime);
  let chosen = candidates[0];
  if (preferSlug) {
    const hit = candidates.find((c) => c.slug === preferSlug);
    if (hit) chosen = hit;
  }

  const raw = JSON.parse(fs.readFileSync(chosen.file, 'utf8'));
  const activeCatalogs =
    Array.isArray(raw.activeCatalogs) && raw.activeCatalogs.length
      ? raw.activeCatalogs
      : [chosen.slug];
  const next = {
    ...raw,
    activeCatalogs,
  };
  delete next.projectSlug;
  fs.writeFileSync(globalFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/**
 * Load global session. Optional slug hint only for legacy migration / chrome profile default.
 * @param {string} [projectSlugHint]
 */
function loadSession(projectSlugHint) {
  migrateLegacySessions(
    typeof projectSlugHint === 'string' ? projectSlugHint : null,
  );
  ensureDataRoot();

  const defaults = loadDefault();
  let cfg = defaults;
  const localRoot = path.join(ROOT, 'session.local.json');
  if (fs.existsSync(localRoot)) {
    cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(localRoot, 'utf8')));
  }
  const globalFile = getGlobalSessionPath();
  if (fs.existsSync(globalFile)) {
    cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(globalFile, 'utf8')));
  }

  const catalogs = Array.isArray(cfg.activeCatalogs)
    ? cfg.activeCatalogs.filter(Boolean)
    : [];
  if (
    !catalogs.length &&
    typeof projectSlugHint === 'string' &&
    projectSlugHint
  ) {
    catalogs.push(projectSlugHint);
  }
  cfg.activeCatalogs = catalogs;

  const primary = catalogs[0] || projectSlugHint || 'default';
  try {
    ensureDataDirs();
  } catch (_) {
    /* ignore */
  }

  cfg.mock = cfg.mock || {};
  if (!cfg.mock.mocksRoot && primary && primary !== 'default') {
    const { mocksRootFor } = require('./catalog-merge');
    cfg.mock.mocksRoot = mocksRootFor(primary);
  }
  cfg.browser = cfg.browser || {};
  if (!cfg.browser.userDataDir) {
    cfg.browser.userDataDir = chromeProfileDir(primary || 'default');
  }
  cfg.projectSlug = primary;
  return cfg;
}

/**
 * Save partial into global session.
 * Compatible: saveSession(partial) | saveSession(projectSlug, partial).
 * @param {string|object} a
 * @param {object} [b]
 */
function saveSession(a, b) {
  const { slugHint, partial } = normalizeSaveArgs(a, b);
  migrateLegacySessions(slugHint);
  ensureDataRoot();
  const current = loadSession(slugHint || undefined);
  const next = deepMerge(current, partial);
  delete next.projectSlug;
  if (partial && Array.isArray(partial.activeCatalogs)) {
    next.activeCatalogs = partial.activeCatalogs;
  }
  fs.writeFileSync(
    getGlobalSessionPath(),
    `${JSON.stringify(next, null, 2)}\n`,
    'utf8',
  );
  return loadSession(slugHint || undefined);
}

function saveRuntimeState(a, b) {
  ensureDataRoot();
  const state =
    typeof a === 'string' ? b : a && typeof a === 'object' ? a : {};
  fs.writeFileSync(
    getGlobalRuntimePath(),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
}

function loadRuntimeState(projectSlugHint) {
  const globalRuntime = getGlobalRuntimePath();
  if (fs.existsSync(globalRuntime)) {
    return JSON.parse(fs.readFileSync(globalRuntime, 'utf8'));
  }
  if (typeof projectSlugHint === 'string' && projectSlugHint) {
    const legacy = path.join(projectDataDir(projectSlugHint), 'runtime.json');
    if (fs.existsSync(legacy)) {
      return JSON.parse(fs.readFileSync(legacy, 'utf8'));
    }
  }
  const projectsRoot = path.join(getDataRoot(), 'projects');
  if (fs.existsSync(projectsRoot)) {
    for (const name of fs.readdirSync(projectsRoot)) {
      const legacy = path.join(projectsRoot, name, 'runtime.json');
      if (fs.existsSync(legacy)) {
        return JSON.parse(fs.readFileSync(legacy, 'utf8'));
      }
    }
  }
  return null;
}

module.exports = {
  loadDefault,
  loadSession,
  saveSession,
  saveRuntimeState,
  loadRuntimeState,
  deepMerge,
  migrateLegacySessions,
  get GLOBAL_SESSION() {
    return getGlobalSessionPath();
  },
  get GLOBAL_RUNTIME() {
    return getGlobalRuntimePath();
  },
};
