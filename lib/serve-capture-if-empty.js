'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Find a capture responseBody for host/path/method (read-only).
 * Prefer non-empty object/array data.
 *
 * @param {string|null} capturesDir
 * @param {{ host?: string, path?: string, method?: string }} req
 * @returns {{ body: object, status: number }|null}
 */
function findCaptureResponse(capturesDir, req = {}) {
  if (!capturesDir || !fs.existsSync(capturesDir)) return null;
  const method = String(req.method || 'GET').toUpperCase();
  const wantPath = String(req.path || '').split('?')[0] || '/';
  const wantHost = String(req.host || '')
    .split(':')[0]
    .toLowerCase();

  let files;
  try {
    files = fs.readdirSync(capturesDir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }

  for (const f of files) {
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(capturesDir, f), 'utf8'));
    } catch {
      continue;
    }
    const recMethod = String(rec.method || 'GET').toUpperCase();
    if (recMethod !== method) continue;
    const recPath = String(rec.path || rec.urlPath || '').split('?')[0];
    if (recPath && recPath !== wantPath) continue;
    if (wantHost && rec.host) {
      const rh = String(rec.host).split(':')[0].toLowerCase();
      if (rh !== wantHost) continue;
    }
    const body = rec.responseBody !== undefined ? rec.responseBody : rec.body;
    if (body === undefined || body === null) continue;
    if (typeof body === 'object' && !Array.isArray(body)) {
      const data = body.data;
      if (
        data === null ||
        data === undefined ||
        (typeof data === 'object' &&
          !Array.isArray(data) &&
          Object.keys(data).length === 0)
      ) {
        continue; // not a qualified capture
      }
    }
    return {
      body,
      status: Number(rec.status) > 0 ? Number(rec.status) : 200,
    };
  }
  return null;
}

module.exports = { findCaptureResponse };
