'use strict';

/**
 * Decode upstream response bytes for capture/merge (not for client forwarding).
 * Client still receives the original wire buffer + Content-Encoding.
 */

const zlib = require('zlib');

/**
 * @param {Buffer|Uint8Array|string} buf
 * @param {Record<string, string|string[]|undefined>} [headers]
 * @returns {{
 *   bodyJson: any,
 *   bodyText: string|undefined,
 *   encoding: string,
 *   parseOk: boolean,
 *   contentType: string,
 *   byteLength: number,
 *   error?: string,
 * }}
 */
function decodeResponseBody(buf, headers = {}) {
  const headerGet = (name) => {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers || {})) {
      if (String(k).toLowerCase() === lower) {
        return Array.isArray(v) ? v[0] : v;
      }
    }
    return undefined;
  };

  const contentType = String(headerGet('content-type') || '');
  const encodingRaw = String(headerGet('content-encoding') || '')
    .toLowerCase()
    .split(',')[0]
    .trim();

  let raw = Buffer.isBuffer(buf)
    ? buf
    : Buffer.from(buf == null ? '' : buf);
  const wireLength = raw.length;
  let encoding = encodingRaw || 'identity';

  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      raw = zlib.gunzipSync(raw);
      encoding = 'gzip';
    } else if (encoding === 'deflate') {
      try {
        raw = zlib.inflateSync(raw);
      } catch {
        raw = zlib.inflateRawSync(
          Buffer.isBuffer(buf) ? buf : Buffer.from(buf == null ? '' : buf),
        );
      }
      encoding = 'deflate';
    } else if (encoding === 'br') {
      raw = zlib.brotliDecompressSync(raw);
      encoding = 'br';
    } else {
      encoding = 'identity';
    }
  } catch (e) {
    return {
      bodyJson: undefined,
      bodyText: undefined,
      encoding: encodingRaw || 'identity',
      parseOk: false,
      contentType,
      byteLength: wireLength,
      error: e.message || String(e),
    };
  }

  const bodyText = raw.toString('utf8');
  try {
    const bodyJson = JSON.parse(bodyText);
    return {
      bodyJson,
      bodyText: undefined,
      encoding,
      parseOk: true,
      contentType,
      byteLength: raw.length,
    };
  } catch {
    return {
      bodyJson: undefined,
      bodyText: bodyText.length > 64 * 1024 ? bodyText.slice(0, 64 * 1024) : bodyText,
      encoding,
      parseOk: false,
      contentType,
      byteLength: raw.length,
    };
  }
}

/**
 * Fields safe to persist on a capture record (never utf8-mojibake binary).
 * @param {ReturnType<typeof decodeResponseBody>} decoded
 */
function captureBodyFromDecoded(decoded) {
  const bodyMeta = {
    encoding: decoded.encoding,
    parseOk: Boolean(decoded.parseOk),
    contentType: decoded.contentType || '',
    byteLength: decoded.byteLength || 0,
    ...(decoded.error ? { error: decoded.error } : {}),
  };
  if (decoded.parseOk && decoded.bodyJson !== undefined) {
    return { responseBody: decoded.bodyJson, bodyMeta };
  }
  return { responseBody: undefined, bodyMeta };
}

module.exports = {
  decodeResponseBody,
  captureBodyFromDecoded,
};
