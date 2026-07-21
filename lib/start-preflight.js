'use strict';

/**
 * Start helpers that do not couple mox to any frontend project.
 */

const fs = require('fs');

/**
 * If port busy, detect whether it is our previous mox session.
 * @param {{ runtimePath: string, port: number, kind: 'mock'|'proxy' }} opts
 */
function explainPortBusy({ runtimePath, port, kind }) {
  let hint = `port in use — run: mox stop   (or free ${kind} port ${port})`;
  try {
    if (!runtimePath || !fs.existsSync(runtimePath)) {
      return { ours: false, hint };
    }
    const rt = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    const pid = rt?.mock?.pid;
    const mockPort = rt?.mock?.port;
    const proxyPort = rt?.proxy?.port;
    const match =
      (kind === 'mock' && Number(mockPort) === Number(port)) ||
      (kind === 'proxy' && Number(proxyPort) === Number(port));
    if (match && pid) {
      try {
        process.kill(pid, 0);
        return {
          ours: true,
          pid,
          hint: `mox session already running (pid=${pid}) — run: mox stop`,
        };
      } catch {
        return {
          ours: false,
          hint: `stale runtime pid=${pid}; free port ${port} then mox start`,
        };
      }
    }
  } catch {
    /* ignore */
  }
  return { ours: false, hint };
}

module.exports = {
  explainPortBusy,
};
