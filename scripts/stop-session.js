'use strict';

const fs = require('fs');
const path = require('path');
const { resolveProjectSlug, projectDataDir } = require('../lib/paths');
const {
  loadRuntimeState,
  saveRuntimeState,
  loadSession,
} = require('../lib/session-config');
const { appendAudit } = require('../lib/audit');
const { journalSummary } = require('../lib/service-store');

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

/** Count capture artifact files under captures/. */
function countCaptureFiles(projectSlug) {
  const root = path.join(projectDataDir(projectSlug), 'captures');
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && (name.endsWith('.json') || name.endsWith('.jsonl'))) n += 1;
    }
  };
  walk(root);
  return n;
}

function hintMergeIfCaptures(projectSlug) {
  const n = countCaptureFiles(projectSlug);
  if (n > 0) {
    console.log(
      `[mox] hint: ${n} capture file(s) in ${projectSlug} — run: mox merge --name=${projectSlug}`,
    );
    console.log(
      `[mox] hint: or next time: mox stop --auto-merge`,
    );
  }
  return n;
}

function stopSession(opts = {}) {
  const projectDir = opts.projectDir || process.cwd();
  const hintSlug = resolveProjectSlug(projectDir, opts.name);
  const state = loadRuntimeState(hintSlug);

  let catalogs;
  if (state && Array.isArray(state.activeCatalogs) && state.activeCatalogs.length) {
    catalogs = state.activeCatalogs;
  } else if (opts.name) {
    catalogs = [hintSlug];
  } else {
    const sessionCatalogs = loadSession().activeCatalogs || [];
    catalogs = sessionCatalogs.length ? sessionCatalogs : [hintSlug];
  }
  const primary = (state && state.projectSlug) || catalogs[0] || hintSlug;

  if (!state) {
    console.log('[mox] no runtime state; nothing to stop');
    const journal = journalSummary();
    console.log(journal.line);
    let captureCount = 0;
    for (const slug of catalogs) {
      captureCount += hintMergeIfCaptures(slug) || 0;
    }
    let mergeResult = null;
    if (opts.autoMerge) {
      const { captureMerge } = require('./capture-merge');
      mergeResult = catalogs.map((slug) =>
        captureMerge(slug, { taskId: opts.taskId || null }),
      );
    }
    return {
      killed: false,
      captureCount,
      journalHits: journal.hits,
      mergeResult,
      catalogs,
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
    `[mox] stop catalogs=${catalogs.join(',')} sessionPid=${sessionPid || '-'} killed=${killedSession} chromePid=${chromePid || '-'} killed=${killedChrome}`,
  );

  const journal = journalSummary();
  console.log(journal.line);

  let captureCount = 0;
  for (const slug of catalogs) {
    captureCount += hintMergeIfCaptures(slug) || 0;
  }
  let mergeResult = null;
  if (opts.autoMerge) {
    const { captureMerge } = require('./capture-merge');
    mergeResult = catalogs.map((slug) =>
      captureMerge(slug, {
        taskId: opts.taskId || state.taskId || null,
      }),
    );
  }

  return {
    killed: killedSession || killedChrome,
    killedSession,
    killedChrome,
    captureCount,
    journalHits: journal.hits,
    mergeResult,
    catalogs,
  };
}

module.exports = { stopSession, pidAlive, tryKill, countCaptureFiles, hintMergeIfCaptures };

if (require.main === module) {
  stopSession({ projectDir: process.cwd() });
}
