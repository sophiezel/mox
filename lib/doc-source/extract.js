'use strict';

/**
 * Deterministic Markdown → endpoint candidates.
 * Skip when incomplete; never invent fields.
 */

function tryParseJson(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizePath(p) {
  if (!p || typeof p !== 'string') return null;
  let s = p.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = u.pathname + (u.search || '');
    } catch {
      return null;
    }
  }
  if (!s.startsWith('/')) s = `/${s}`;
  return s;
}

function pushEndpoint(out, ep) {
  if (!ep || !ep.method || !ep.path) return;
  const method = String(ep.method).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
  const urlPath = normalizePath(ep.path);
  if (!urlPath) return;
  if (ep.responseBody == null && ep.data == null) return;
  out.push({
    method,
    path: urlPath,
    host: ep.host || null,
    requestBody: ep.requestBody && typeof ep.requestBody === 'object' ? ep.requestBody : {},
    responseBody: ep.responseBody != null ? ep.responseBody : { code: 0, data: ep.data, message: '' },
    status: ep.status != null ? Number(ep.status) : 200,
    evidence: ep.evidence || 'extract',
  });
}

/**
 * ```http
 * POST /api/foo
 *
 * {"a":1}
 * ```
 * optionally followed by ```json response
 */
function extractHttpFences(markdown, out) {
  const re = /```(?:http|HTTP)\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(markdown))) {
    const block = m[1];
    const lines = block.split(/\r?\n/);
    const first = (lines[0] || '').trim();
    const hm = first.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/i);
    if (!hm) continue;
    let bodyStart = 1;
    while (bodyStart < lines.length && !lines[bodyStart].trim()) bodyStart += 1;
    const reqText = lines.slice(bodyStart).join('\n').trim();
    const requestBody = tryParseJson(reqText) || {};

    let responseBody = null;
    const after = markdown.slice(m.index + m[0].length);
    const jsonFence = after.match(/^\s*```(?:json|JSON)?\s*\n([\s\S]*?)```/);
    if (jsonFence) {
      responseBody = tryParseJson(jsonFence[1]);
    }
    if (responseBody == null && reqText && tryParseJson(reqText) && Object.keys(requestBody).length) {
      // Sometimes the http fence only contains the response JSON (no req body)
      if (requestBody.code != null || requestBody.data !== undefined) {
        responseBody = requestBody;
        pushEndpoint(out, {
          method: hm[1],
          path: hm[2],
          requestBody: {},
          responseBody,
          evidence: 'http-fence',
        });
        continue;
      }
    }
    if (responseBody == null) continue;
    pushEndpoint(out, {
      method: hm[1],
      path: hm[2],
      requestBody: responseBody === requestBody ? {} : requestBody,
      responseBody,
      evidence: 'http-fence',
    });
  }
}

/**
 * METHOD /path then ```json response
 */
function extractMethodThenJson(markdown, out) {
  const re =
    /(?:^|\n)\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+|https?:\/\/\S+)\s*\n\s*```(?:json|JSON)?\s*\n([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(markdown))) {
    const responseBody = tryParseJson(m[3]);
    if (!responseBody) continue;
    pushEndpoint(out, {
      method: m[1],
      path: m[2],
      responseBody,
      evidence: 'method-json',
    });
  }
}

/**
 * Markdown table with Method/Path/Response (中英列名)
 */
function extractTables(markdown, out) {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 2; i++) {
    const header = lines[i];
    if (!/\|/.test(header)) continue;
    const cols = header.split('|').map((c) => c.trim()).filter(Boolean);
    if (cols.length < 3) continue;
    const lower = cols.map((c) => c.toLowerCase());
    const methodIdx = lower.findIndex((c) =>
      /^(method|方法|http.?method)$/.test(c),
    );
    const pathIdx = lower.findIndex((c) =>
      /^(path|url|路径|接口|uri)$/.test(c),
    );
    const respIdx = lower.findIndex((c) =>
      /^(response|响应|返回|resp|body)$/.test(c),
    );
    if (methodIdx < 0 || pathIdx < 0 || respIdx < 0) continue;
    const sep = lines[i + 1] || '';
    if (!/^\s*\|?[\s:-]+\|/.test(sep)) continue;
    for (let r = i + 2; r < lines.length; r++) {
      if (!/\|/.test(lines[r])) break;
      const rawCells = lines[r].split('|').map((c) => c.trim());
      const parts = rawCells[0] === '' ? rawCells.slice(1) : rawCells.slice();
      if (parts.length && parts[parts.length - 1] === '') parts.pop();
      if (parts.length < cols.length) continue;
      const method = parts[methodIdx];
      const p = parts[pathIdx];
      let respRaw = parts[respIdx] || '';
      respRaw = respRaw.replace(/^`+|`+$/g, '').trim();
      const responseBody = tryParseJson(respRaw);
      if (!responseBody) continue;
      pushEndpoint(out, {
        method,
        path: p,
        responseBody,
        evidence: 'table',
      });
    }
  }
}

/**
 * Embedded OpenAPI JSON fence with paths
 */
function extractOpenApiFence(markdown, out) {
  const re = /```(?:json|JSON|yaml|YAML)?\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(markdown))) {
    const raw = m[1].trim();
    if (!/"paths"\s*:/.test(raw) && !/openapi\s*:/i.test(raw)) continue;
    let spec;
    try {
      spec = JSON.parse(raw);
    } catch {
      continue;
    }
    const paths = spec.paths || {};
    const base =
      (spec.servers && spec.servers[0] && spec.servers[0].url) || '';
    let basePath = '';
    let host = null;
    if (base) {
      try {
        const u = new URL(base);
        host = u.host;
        basePath = u.pathname.replace(/\/$/, '') || '';
      } catch {
        basePath = String(base).replace(/\/$/, '');
      }
    }
    for (const [p, methods] of Object.entries(paths)) {
      if (!methods || typeof methods !== 'object') continue;
      for (const [method, op] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        const success =
          op.responses?.['200'] ||
          op.responses?.['201'] ||
          op.responses?.default;
        const example =
          success?.content?.['application/json']?.example ||
          success?.content?.['application/json']?.examples?.default?.value ||
          success?.example ||
          null;
        if (example == null) continue;
        const fullPath = `${basePath}${p}`.replace(/\{[^}]+\}/g, '1') || '/';
        pushEndpoint(out, {
          method,
          path: fullPath,
          host,
          responseBody:
            typeof example === 'object' ? example : { code: 0, data: example, message: '' },
          evidence: 'openapi-fence',
        });
      }
    }
  }
}

/**
 * @param {string} markdown
 * @returns {object[]}
 */
function extractEndpoints(markdown) {
  const text = String(markdown || '');
  const out = [];
  extractHttpFences(text, out);
  extractMethodThenJson(text, out);
  extractTables(text, out);
  extractOpenApiFence(text, out);

  /** @type {Map<string, object>} */
  const byKey = new Map();
  for (const ep of out) {
    const key = `${ep.method} ${ep.host || ''} ${ep.path}`;
    if (!byKey.has(key)) byKey.set(key, ep);
  }
  return [...byKey.values()];
}

module.exports = {
  extractEndpoints,
  tryParseJson,
  normalizePath,
};
