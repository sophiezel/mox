'use strict';

/**
 * Close an http.Server without waiting forever on keep-alive / CONNECT tunnels.
 * Uses closeAllConnections when available (Node >= 18.2), then close() with a timeout.
 */
function forceCloseHttpServer(server, { timeoutMs = 400 } = {}) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    try {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    } catch (_) {
      /* ignore */
    }
    const timer = setTimeout(finish, timeoutMs);
    try {
      server.close(() => finish());
    } catch (_) {
      finish();
    }
  });
}

module.exports = { forceCloseHttpServer };
