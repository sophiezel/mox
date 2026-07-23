'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @typedef {{ path: string, mtimeMs: number, size?: number, name?: string }} RetentionEntry
 */

/**
 * @param {RetentionEntry[]} entries
 * @param {{ maxAgeDays?: number, now?: number }} opts
 * @returns {{ keep: RetentionEntry[], drop: RetentionEntry[] }}
 */
function pruneEntriesByAge(entries, opts = {}) {
  const maxAgeDays = Number(opts.maxAgeDays);
  const list = Array.isArray(entries) ? entries.slice() : [];
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    return { keep: list, drop: [] };
  }
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const keep = [];
  const drop = [];
  for (const e of list) {
    if ((e.mtimeMs || 0) < cutoff) drop.push(e);
    else keep.push(e);
  }
  return { keep, drop };
}

/**
 * @param {RetentionEntry[]} entries
 * @param {{ maxFiles?: number }} opts
 * @returns {{ keep: RetentionEntry[], drop: RetentionEntry[] }}
 */
function pruneEntriesByMaxCount(entries, opts = {}) {
  const maxFiles = Number(opts.maxFiles);
  const list = Array.isArray(entries) ? entries.slice() : [];
  if (!Number.isFinite(maxFiles) || maxFiles < 0) {
    return { keep: list, drop: [] };
  }
  if (list.length <= maxFiles) {
    return { keep: list, drop: [] };
  }
  const sorted = list.slice().sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0));
  const dropCount = sorted.length - maxFiles;
  return {
    drop: sorted.slice(0, dropCount),
    keep: sorted.slice(dropCount),
  };
}

/**
 * @param {string} dir
 * @param {(name: string, full: string) => boolean} [filter]
 * @returns {RetentionEntry[]}
 */
function listFileEntries(dir, filter) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (typeof filter === 'function' && !filter(name, full)) continue;
    out.push({ path: full, name, mtimeMs: st.mtimeMs, size: st.size });
  }
  return out;
}

/**
 * @param {string} dir
 * @returns {RetentionEntry[]}
 */
function listDirEntries(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    out.push({ path: full, name, mtimeMs: st.mtimeMs, size: st.size });
  }
  return out;
}

function removeEntry(entry, dryRun) {
  if (dryRun) return;
  fs.rmSync(entry.path, { recursive: true, force: true });
}

/**
 * Rotate a single append log when over maxBytes: file → file.1 → file.2 …
 * @param {string} filePath
 * @param {{ maxBytes?: number, keepRotated?: number, dryRun?: boolean }} opts
 * @returns {{ rotated: boolean, removed: string[] }}
 */
function rotateFileBySize(filePath, opts = {}) {
  const maxBytes = Number(opts.maxBytes);
  const keepRotated = Number.isFinite(Number(opts.keepRotated))
    ? Math.max(0, Number(opts.keepRotated))
    : 3;
  const dryRun = Boolean(opts.dryRun);
  const removed = [];
  if (!filePath || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { rotated: false, removed };
  }
  if (!fs.existsSync(filePath)) {
    return { rotated: false, removed };
  }
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return { rotated: false, removed };
  }
  if (!st.isFile() || st.size < maxBytes) {
    return { rotated: false, removed };
  }

  for (let i = keepRotated; i >= 1; i--) {
    const older = `${filePath}.${i}`;
    if (!fs.existsSync(older)) continue;
    if (i === keepRotated) {
      if (!dryRun) fs.rmSync(older, { force: true });
      removed.push(older);
    } else {
      const dest = `${filePath}.${i + 1}`;
      if (!dryRun) fs.renameSync(older, dest);
    }
  }
  if (keepRotated >= 1) {
    if (!dryRun) fs.renameSync(filePath, `${filePath}.1`);
  } else if (!dryRun) {
    fs.rmSync(filePath, { force: true });
    removed.push(filePath);
  }
  return { rotated: true, removed };
}

/**
 * @param {string} dir
 * @param {{ maxFiles?: number, maxAgeDays?: number, dryRun?: boolean, now?: number }} policy
 */
function pruneCapturesDir(dir, policy = {}) {
  const dryRun = Boolean(policy.dryRun);
  let entries = listFileEntries(dir, (name) => name.endsWith('.json'));
  const byAge = pruneEntriesByAge(entries, {
    maxAgeDays: policy.maxAgeDays,
    now: policy.now,
  });
  for (const e of byAge.drop) removeEntry(e, dryRun);
  const byCount = pruneEntriesByMaxCount(byAge.keep, { maxFiles: policy.maxFiles });
  for (const e of byCount.drop) removeEntry(e, dryRun);
  return {
    removed: byAge.drop.length + byCount.drop.length,
    kept: byCount.keep.length,
  };
}

/**
 * @param {string} filePath
 * @param {{ maxBytes?: number, keepRotated?: number, dryRun?: boolean }} policy
 */
function rotateAppendLog(filePath, policy = {}) {
  return rotateFileBySize(filePath, policy);
}

/** Strip trailing numeric/timestamp-ish suffix for prefix grouping. */
function reportPrefix(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '');
  return (
    base
      .replace(/[-_]\d{4}-\d{2}-\d{2}.*$/, '')
      .replace(/[-_]\d{8}T\d{6}.*$/, '')
      .replace(/[-_]\d{10,}.*$/, '')
      .replace(/[-_]\d+$/, '') || base
  );
}

/**
 * @param {string} reportsDir
 * @param {{ maxAgeDays?: number, keepPerPrefix?: number, dryRun?: boolean, now?: number }} policy
 */
function pruneReports(reportsDir, policy = {}) {
  const dryRun = Boolean(policy.dryRun);
  let removed = 0;
  let entries = listFileEntries(reportsDir);
  const byAge = pruneEntriesByAge(entries, {
    maxAgeDays: policy.maxAgeDays,
    now: policy.now,
  });
  for (const e of byAge.drop) {
    removeEntry(e, dryRun);
    removed += 1;
  }
  const groups = new Map();
  for (const e of byAge.keep) {
    const key = reportPrefix(e.name || path.basename(e.path));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  let kept = 0;
  const keepPerPrefix = Number(policy.keepPerPrefix);
  for (const group of groups.values()) {
    if (!Number.isFinite(keepPerPrefix) || keepPerPrefix < 0) {
      kept += group.length;
      continue;
    }
    const byCount = pruneEntriesByMaxCount(group, { maxFiles: keepPerPrefix });
    for (const e of byCount.drop) {
      removeEntry(e, dryRun);
      removed += 1;
    }
    kept += byCount.keep.length;
  }
  return { removed, kept };
}

/**
 * @param {string} profilesRoot
 * @param {{ maxAgeDays?: number, dryRun?: boolean, now?: number }} policy
 */
function pruneChromeProfiles(profilesRoot, policy = {}) {
  const dryRun = Boolean(policy.dryRun);
  const entries = listDirEntries(profilesRoot);
  const byAge = pruneEntriesByAge(entries, {
    maxAgeDays: policy.maxAgeDays,
    now: policy.now,
  });
  for (const e of byAge.drop) removeEntry(e, dryRun);
  return { removed: byAge.drop.length, kept: byAge.keep.length };
}

function dirHasSubstance(dir) {
  if (!fs.existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let names;
    try {
      names = fs.readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      const full = path.join(cur, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isFile()) return true;
      if (st.isDirectory()) stack.push(full);
    }
  }
  return false;
}

/**
 * Remove service dirs without proxy-rules.json and without substantive files.
 * @param {string} servicesRoot
 * @param {{ dryRun?: boolean }} [opts]
 */
function pruneOrphanServiceDirs(servicesRoot, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  if (!servicesRoot || !fs.existsSync(servicesRoot)) {
    return { removed: 0, kept: 0 };
  }
  let removed = 0;
  let kept = 0;
  for (const name of fs.readdirSync(servicesRoot)) {
    const full = path.join(servicesRoot, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const rules = path.join(full, 'proxy-rules.json');
    if (fs.existsSync(rules)) {
      kept += 1;
      continue;
    }
    if (dirHasSubstance(full)) {
      kept += 1;
      continue;
    }
    if (!dryRun) fs.rmSync(full, { recursive: true, force: true });
    removed += 1;
  }
  return { removed, kept };
}

function defaultPolicy() {
  return {
    captures: { maxFiles: 500, maxAgeDays: 7 },
    appendLogs: {
      maxBytes: 20 * 1024 * 1024,
      keepRotated: 3,
      targets: [
        'audit/proxy-access.jsonl',
        'audit/changelog.jsonl',
        'reports/upstream-failures.jsonl',
        'session-start.log',
      ],
    },
    reports: { maxAgeDays: 14, keepPerPrefix: 20 },
    chromeProfiles: { maxAgeDays: 14 },
    orphanServiceDirs: true,
  };
}

/**
 * @param {object} [partial]
 */
function resolveRetentionPolicy(partial) {
  const base = defaultPolicy();
  if (!partial || typeof partial !== 'object') return base;
  return {
    captures: { ...base.captures, ...(partial.captures || {}) },
    appendLogs: {
      ...base.appendLogs,
      ...(partial.appendLogs || {}),
      targets:
        partial.appendLogs?.targets ||
        base.appendLogs.targets,
    },
    reports: { ...base.reports, ...(partial.reports || {}) },
    chromeProfiles: { ...base.chromeProfiles, ...(partial.chromeProfiles || {}) },
    orphanServiceDirs:
      partial.orphanServiceDirs == null
        ? base.orphanServiceDirs
        : Boolean(partial.orphanServiceDirs),
  };
}

/**
 * @param {string} dataRoot
 * @param {object} [policy]
 * @param {{ dryRun?: boolean, now?: number, scopes?: string[] }} [opts]
 */
function runDataRetention(dataRoot, policy, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const now = opts.now;
  const p = resolveRetentionPolicy(policy);
  const scopes = opts.scopes
    ? new Set(opts.scopes)
    : new Set(['captures', 'appendLogs', 'reports', 'chromeProfiles', 'orphanServiceDirs']);
  const summary = {
    removed: 0,
    rotated: 0,
    kept: 0,
    details: {},
  };

  if (scopes.has('captures')) {
    const servicesRoot = path.join(dataRoot, 'services');
    let removed = 0;
    let kept = 0;
    if (fs.existsSync(servicesRoot)) {
      for (const name of fs.readdirSync(servicesRoot)) {
        const cap = path.join(servicesRoot, name, 'captures');
        if (!fs.existsSync(cap)) continue;
        const r = pruneCapturesDir(cap, { ...p.captures, dryRun, now });
        removed += r.removed;
        kept += r.kept;
      }
    }
    summary.details.captures = { removed, kept };
    summary.removed += removed;
    summary.kept += kept;
  }

  if (scopes.has('appendLogs')) {
    let rotated = 0;
    let removed = 0;
    for (const rel of p.appendLogs.targets || []) {
      const file = path.isAbsolute(rel) ? rel : path.join(dataRoot, rel);
      const r = rotateAppendLog(file, {
        maxBytes: p.appendLogs.maxBytes,
        keepRotated: p.appendLogs.keepRotated,
        dryRun,
      });
      if (r.rotated) rotated += 1;
      removed += r.removed.length;
    }
    summary.details.appendLogs = { rotated, removed };
    summary.rotated += rotated;
    summary.removed += removed;
  }

  if (scopes.has('reports')) {
    const r = pruneReports(path.join(dataRoot, 'reports'), {
      ...p.reports,
      dryRun,
      now,
    });
    summary.details.reports = r;
    summary.removed += r.removed;
    summary.kept += r.kept;
  }

  if (scopes.has('chromeProfiles')) {
    const r = pruneChromeProfiles(path.join(dataRoot, 'chrome-profiles'), {
      ...p.chromeProfiles,
      dryRun,
      now,
    });
    summary.details.chromeProfiles = r;
    summary.removed += r.removed;
    summary.kept += r.kept;
  }

  if (scopes.has('orphanServiceDirs') && p.orphanServiceDirs) {
    const r = pruneOrphanServiceDirs(path.join(dataRoot, 'services'), { dryRun });
    summary.details.orphanServiceDirs = r;
    summary.removed += r.removed;
    summary.kept += r.kept;
  }

  return summary;
}

module.exports = {
  pruneEntriesByAge,
  pruneEntriesByMaxCount,
  rotateFileBySize,
  listFileEntries,
  listDirEntries,
  pruneCapturesDir,
  rotateAppendLog,
  pruneReports,
  pruneChromeProfiles,
  pruneOrphanServiceDirs,
  reportPrefix,
  defaultPolicy,
  resolveRetentionPolicy,
  runDataRetention,
};
