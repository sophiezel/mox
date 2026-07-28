'use strict';

const fs = require('fs');
const path = require('path');
const { getDataRoot, resolveScanLabel } = require('../lib/paths');
const {
  loadRuntimeState,
  saveRuntimeState,
  loadSession,
} = require('../lib/session-config');
const { appendAudit } = require('../lib/audit');
const { journalSummary } = require('../lib/service-store');
const { parseNameList } = require('../lib/catalog-merge');

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryKill(pid, signal = 'SIGTERM') {
  if (!pidAlive(pid)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Count capture artifact files under services/{id}/captures (or filtered). */
function countCaptureFiles(upstreamIds) {
  const root = path.join(getDataRoot(), 'services');
  if (!fs.existsSync(root)) return 0;
  const filter =
    Array.isArray(upstreamIds) && upstreamIds.length
      ? new Set(upstreamIds)
      : null;
  let n = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && (name.endsWith('.json') || name.endsWith('.jsonl'))) {
        n += 1;
      }
    }
  };
  for (const up of fs.readdirSync(root)) {
    if (filter && !filter.has(up)) continue;
    const cap = path.join(root, up, 'captures');
    if (fs.existsSync(cap)) walk(cap);
  }
  return n;
}

function hintMergeIfCaptures(upstreamIds) {
  const n = countCaptureFiles(upstreamIds);
  if (n > 0) {
    console.log(
      `[mox] hint: ${n} capture file(s) — run: mox merge`,
    );
    console.log(
      `[mox] hint: or next time: mox stop --auto-merge`,
    );
  }
  return n;
}

function clearDeviceProxyLease(opts = {}) {
  try {
    const {
      clearDeviceHttpProxyIfLease,
      CLEAR_FAILED,
    } = require('../lib/device-proxy');
    const out = clearDeviceHttpProxyIfLease({
      runAdb: opts.runAdb,
      leasePath: opts.leasePath,
    });
    if (out && out.ok === false && out.code === CLEAR_FAILED) {
      console.error(`[mox] ${CLEAR_FAILED}`);
    }
    return out;
  } catch (e) {
    console.error(`[mox] DEVICE_PROXY_CLEAR_FAILED: ${e.message}`);
    console.error('[mox] tip: mox device clear');
    return { ok: false, error: e.message };
  }
}

function stopSession(opts = {}) {
  const projectDir = opts.projectDir || process.cwd();
  const label = resolveScanLabel(projectDir, opts.name);
  const named = parseNameList(opts.name);
  const state = loadRuntimeState();

  let catalogs;
  if (state && Array.isArray(state.activeCatalogs) && state.activeCatalogs.length) {
    catalogs = state.activeCatalogs;
  } else if (named.length) {
    catalogs = named;
  } else {
    const sessionCatalogs = loadSession().activeCatalogs || [];
    catalogs = sessionCatalogs.length ? sessionCatalogs : [];
  }
  const primary = (state && state.projectSlug) || catalogs[0] || label;

  // Always try lease clear first (even with no runtime) so sticky proxy cannot linger.
  const deviceProxyClear = clearDeviceProxyLease(opts);

  if (!state) {
    console.log('[mox] no runtime state; nothing to stop');
    const journal = journalSummary();
    console.log(journal.line);
    const captureCount = hintMergeIfCaptures(catalogs);
    let mergeResult = null;
    if (opts.autoMerge) {
      const { captureMerge } = require('./capture-merge');
      mergeResult = captureMerge({
        taskId: opts.taskId || null,
      });
    }
    return {
      killed: false,
      captureCount,
      journalHits: journal.hits,
      mergeResult,
      catalogs,
      deviceProxyClear,
    };
  }

  const sessionPid = state.mock?.pid;
  const chromePid = state.chromePid;
  let killedSession = false;
  let killedChrome = false;

  if (sessionPid && sessionPid !== process.pid) {
    killedSession = tryKill(sessionPid, 'SIGTERM');
    if (killedSession) {
      const start = Date.now();
      while (pidAlive(sessionPid) && Date.now() - start < 1500) {
        /* spin */
      }
      if (pidAlive(sessionPid)) tryKill(sessionPid, 'SIGKILL');
    }
  }

  if (chromePid) {
    killedChrome = tryKill(chromePid, 'SIGTERM');
    if (killedChrome && pidAlive(chromePid)) {
      tryKill(chromePid, 'SIGKILL');
    }
  }

  saveRuntimeState({
    ...state,
    stoppedAt: new Date().toISOString(),
    note: killedSession
      ? 'stop-session sent SIGTERM to session process'
      : 'stop-session: session pid not alive or is current process — closed state only',
  });
  appendAudit(primary, {
    command: 'session stop',
    taskId: opts.taskId || state.taskId || null,
    summary: `stop killedSession=${killedSession} killedChrome=${killedChrome} catalogs=${catalogs.join(',')}`,
  });
  console.log(
    `[mox] stop catalogs=${catalogs.join(',') || '(none)'} sessionPid=${sessionPid || '-'} killed=${killedSession} chromePid=${chromePid || '-'} killed=${killedChrome}`,
  );

  const journal = journalSummary();
  console.log(journal.line);

  const captureCount = hintMergeIfCaptures(catalogs);
  let mergeResult = null;
  if (opts.autoMerge) {
    const { captureMerge } = require('./capture-merge');
    mergeResult = captureMerge({
      taskId: opts.taskId || state.taskId || null,
    });
  }

  return {
    killed: killedSession || killedChrome,
    killedSession,
    killedChrome,
    captureCount,
    journalHits: journal.hits,
    mergeResult,
    catalogs,
    deviceProxyClear,
  };
}

module.exports = {
  stopSession,
  pidAlive,
  tryKill,
  countCaptureFiles,
  hintMergeIfCaptures,
  clearDeviceProxyLease,
};

if (require.main === module) {
  stopSession({ projectDir: process.cwd() });
}
