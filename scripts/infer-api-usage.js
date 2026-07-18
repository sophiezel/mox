'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  '.next',
  'vendor',
  '.data',
  '__tests__',
  '__mocks__',
  'e2e',
  'tests',
]);

const EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue']);
const STATIC_EXT =
  /\.(mp3|mp4|png|jpe?g|gif|webp|svg|css|woff2?|ttf|ico|map|pdf)(\?.*)?$/i;
const TEST_FILE_RE = /\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs)$/i;
const REQ_CTX_RE =
  /\b(createRequest|fetch\s*\(|axios\.|request\.(get|post|put|delete|patch)\s*\(|\$HTTP\.(get|getP|post|postP|postJson)\s*\()/;

const NAV_CTX_RE =
  /location\.href\s*=|window\.location|createWebView|:url\s*=|\burl\s*[:=]/;

const {
  extractHttpWrapperApis,
  buildWrapperPresenceRe,
  buildReqCtxRe,
  resolveWrapperMethod,
} = require('../lib/infer/http-wrappers');
const { collapseByUpstream } = require('../lib/upstream');

/**
 * Map legacy $HTTP verb → HTTP method (kept for tests / callers).
 * @param {string} verb
 * @returns {'GET'|'POST'}
 */
function httpWrapperMethod(verb) {
  return resolveWrapperMethod(verb, {
    get: 'GET',
    getp: 'GET',
    post: 'POST',
    postp: 'POST',
    postjson: 'POST',
  });
}

/**
 * Parse `//host[/prefix]` or `https://host[/prefix]` into { host, prefix }.
 * @param {string} raw
 * @returns {{ host: string, prefix: string }|null}
 */
function parseHostUrlLiteral(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url = raw.trim();
  if (url.startsWith('//')) url = `https:${url}`;
  try {
    const u = new URL(url);
    if (!u.host) return null;
    if (STATIC_EXT.test(u.pathname)) return null;
    return {
      host: u.host,
      prefix: u.pathname.replace(/\/+$/, '') || '',
    };
  } catch {
    return null;
  }
}

/**
 * Collect identifier = '//host' | 'https://host' assignments across the project.
 * Same variable may have multiple env hosts — all are kept (full expansion).
 * @param {string} projectDir
 * @param {string[]} [files]
 * @returns {Map<string, Array<{ host: string, prefix: string }>>}
 */
function discoverHostVarAssignments(projectDir, files) {
  const fileList = files || walk(projectDir);
  /** @type {Map<string, Array<{ host: string, prefix: string }>>} */
  const map = new Map();
  const assignRe =
    /\b([A-Za-z_$][\w$]*)\s*=\s*['"`]((?:https?:)?\/\/[^'"`]+)['"`]/g;

  function ingest(content) {
    let m;
    assignRe.lastIndex = 0;
    while ((m = assignRe.exec(content))) {
      const varName = m[1];
      const parsed = parseHostUrlLiteral(m[2]);
      if (!parsed) continue;
      if (!map.has(varName)) map.set(varName, []);
      const list = map.get(varName);
      if (!list.some((e) => e.host === parsed.host && e.prefix === parsed.prefix)) {
        list.push(parsed);
      }
    }
  }

  for (const file of fileList) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (content.length > 1_500_000) continue;
    if (path.extname(file) === '.vue') {
      const { extractVueScriptBlocks } = require('../lib/vue-script');
      for (const blk of extractVueScriptBlocks(content)) {
        if (blk.content && blk.content.trim()) ingest(blk.content);
      }
    } else {
      ingest(content);
    }
  }
  return map;
}

/**
 * True when an absolute URL on this line is navigation / WebView, not an API call.
 * @param {string} line
 * @param {string} [nearby]
 */
function isNavigationContext(line, nearby) {
  if (
    /\$HTTP\.|\bfetch\s*\(|\baxios\.|\brequest\.(get|post|put|delete|patch)/.test(
      line,
    )
  ) {
    return false;
  }
  const ctx = nearby || line;
  return NAV_CTX_RE.test(ctx);
}

function shouldSkipFile(relPath, fileName) {
  const norm = relPath.replace(/\\/g, '/');
  if (TEST_FILE_RE.test(fileName)) return true;
  if (/(^|\/)(e2e|__mocks__)(\/|$)/i.test(norm)) return true;
  if (/(^|\/)src\/mock(\/|$)/i.test(norm)) return true;
  return false;
}

function walk(dir, out = [], rootDir = dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.name !== '.env') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      // Also skip dirs named mock at project root / src/mock already covered by name
      if (ent.name === 'mock' || ent.name === 'mocks') continue;
      walk(full, out, rootDir);
    } else if (EXT.has(path.extname(ent.name))) {
      const rel = path.relative(rootDir, full);
      if (shouldSkipFile(rel, ent.name)) continue;
      out.push(full);
    }
  }
  return out;
}

function pathDepth(pathname) {
  return pathname.split('/').filter(Boolean).length;
}

function joinPrefix(prefix, uri) {
  const p = (prefix || '').replace(/\/+$/, '');
  const u = uri.startsWith('/') ? uri : `/${uri}`;
  if (!p) return u;
  if (u === p || u.startsWith(`${p}/`)) return u;
  return `${p}${u}`;
}

/**
 * Discover service bases from env/config: KEY: 'https://host[/prefix]'
 */
function discoverServiceBases(projectDir) {
  const files = walk(projectDir).filter((f) => {
    const rel = path.relative(projectDir, f);
    return (
      /(?:^|\/)(config|env|environments?)\//i.test(rel) ||
      /env\.(js|ts|mjs|cjs)$/i.test(rel) ||
      /config\.(js|ts)$/i.test(path.basename(rel))
    );
  });

  /** @type {Map<string, { key: string, host: string, prefix: string, url: string }>} */
  const byKey = new Map();
  const keyUrlRe =
    /\b([A-Z][A-Z0-9_]*)\s*:\s*['"`](https?:\/\/[^'"`]+)['"`]/g;
  const baseUrlRe = /baseURL\s*[:=]\s*['"`](https?:\/\/[^'"`]+)['"`]/g;

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let m;
    keyUrlRe.lastIndex = 0;
    while ((m = keyUrlRe.exec(content))) {
      try {
        const u = new URL(m[2]);
        if (STATIC_EXT.test(u.pathname)) continue;
        const prefix = u.pathname.replace(/\/+$/, '') || '';
        const depth = pathDepth(prefix || '/');
        // Always register KEY; even host-only (depth 0)
        const entry = {
          key: m[1],
          host: u.host,
          prefix: prefix || '',
          url: m[2],
          depth,
        };
        const prev = byKey.get(m[1]);
        // Generic preference: keep the entry with a deeper prefix (more specific),
        // otherwise keep the first seen. No company-specific host preference.
        if (!prev || entry.depth > prev.depth) {
          byKey.set(m[1], entry);
        }
      } catch {
        /* ignore */
      }
    }
    baseUrlRe.lastIndex = 0;
    while ((m = baseUrlRe.exec(content))) {
      try {
        const u = new URL(m[1]);
        const prefix = u.pathname.replace(/\/+$/, '') || '';
        byKey.set(`__baseURL__${u.host}`, {
          key: '__baseURL__',
          host: u.host,
          prefix,
          url: m[1],
          depth: pathDepth(prefix || '/'),
        });
      } catch {
        /* ignore */
      }
    }
  }

  return [...byKey.values()];
}

function isGatewayOnlyPath(pathname, serviceBases) {
  const p = (pathname || '/').replace(/\/+$/, '') || '/';
  if (p === '/') return true;
  if (pathDepth(p) <= 1) {
    // Exact match to a known service prefix
    return serviceBases.some((b) => b.prefix === p || `/${b.prefix}` === p);
  }
  return false;
}

function isStaticAsset(pathname) {
  return STATIC_EXT.test(pathname || '');
}

/**
 * Scan helper: skip strings / comments; track (), {}, <> depth.
 * Used to locate function bodies past long TS parameter / return types.
 */
function createScanState() {
  return {
    inStr: null,
    escape: false,
    inLineComment: false,
    inBlockComment: false,
    paren: 0,
    brace: 0,
    angle: 0,
  };
}

function scanStep(content, i, st) {
  const ch = content[i];
  const next = content[i + 1];
  if (st.inLineComment) {
    if (ch === '\n') st.inLineComment = false;
    return;
  }
  if (st.inBlockComment) {
    if (ch === '*' && next === '/') {
      st.inBlockComment = false;
      return 1; // skip extra
    }
    return;
  }
  if (st.inStr) {
    if (st.escape) {
      st.escape = false;
      return;
    }
    if (ch === '\\') {
      st.escape = true;
      return;
    }
    if (ch === st.inStr) st.inStr = null;
    return;
  }
  if (ch === '/' && next === '/') {
    st.inLineComment = true;
    return 1;
  }
  if (ch === '/' && next === '*') {
    st.inBlockComment = true;
    return 1;
  }
  if (ch === "'" || ch === '"' || ch === '`') {
    st.inStr = ch;
    return;
  }
  if (ch === '(') st.paren++;
  else if (ch === ')') st.paren--;
  else if (ch === '{') st.brace++;
  else if (ch === '}') st.brace--;
  else if (ch === '<') st.angle++;
  else if (ch === '>' && st.angle > 0) st.angle--;
}

/**
 * Locate `{...}` function body after `function Name(…)` / optional TS return type.
 * Skips param object types and return types that contain braces.
 * @returns {string|null}
 */
function extractFunctionBodyAfterParen(content, openParenIdx) {
  if (!content || content[openParenIdx] !== '(') return null;
  const st = createScanState();
  st.paren = 1;
  let i = openParenIdx + 1;
  for (; i < content.length; i++) {
    const skip = scanStep(content, i, st);
    if (typeof skip === 'number') i += skip;
    if (
      !st.inStr &&
      !st.inLineComment &&
      !st.inBlockComment &&
      st.paren === 0
    ) {
      i++;
      break;
    }
  }
  const rt = createScanState();
  let seenColon = false;
  for (; i < content.length; i++) {
    const ch = content[i];
    if (!seenColon) {
      if (/\s/.test(ch)) continue;
      if (ch === '{') return extractBalancedBlock(content, i);
      if (ch === ':') {
        seenColon = true;
        continue;
      }
      continue;
    }
    // In return type — body `{` appears only when nest depths are all 0
    if (
      !rt.inStr &&
      !rt.inLineComment &&
      !rt.inBlockComment &&
      rt.paren === 0 &&
      rt.brace === 0 &&
      rt.angle === 0 &&
      ch === '{'
    ) {
      return extractBalancedBlock(content, i);
    }
    const skip = scanStep(content, i, rt);
    if (typeof skip === 'number') i += skip;
  }
  return null;
}

/**
 * Extract a `{ ... }` block starting at openBraceIdx (must point at `{`).
 * @returns {string|null}
 */
function extractBalancedBlock(content, openBraceIdx) {
  if (!content || content[openBraceIdx] !== '{') return null;
  const st = createScanState();
  for (let i = openBraceIdx; i < content.length; i++) {
    const ch = content[i];
    const skip = scanStep(content, i, st);
    if (typeof skip === 'number') i += skip;
    if (
      !st.inStr &&
      !st.inLineComment &&
      !st.inBlockComment &&
      st.brace === 0 &&
      i > openBraceIdx
    ) {
      // scanStep already applied `}` → brace became 0
      if (ch === '}') return content.slice(openBraceIdx, i + 1);
    }
  }
  return null;
}

/**
 * Extract APIs from one file using createRequest + path literals.
 */
function extractCreateRequestApis(content, file, serviceBases) {
  const apis = [];
  const keyMap = new Map(serviceBases.map((b) => [b.key, b]));
  const varToKey = new Map();

  // const xxx = request.createRequest({ key: "SERVICE_KEY" ...})
  const createRe =
    /(?:const|let|var)\s+(\w+)\s*=\s*[^\n]*createRequest\s*\(\s*\{([^}]*)\}\s*\)/g;
  let m;
  while ((m = createRe.exec(content))) {
    const varName = m[1];
    const body = m[2];
    const keyM = body.match(/key\s*:\s*['"`]([^'"`]+)['"`]/);
    const prefixM = body.match(/prefix\s*:\s*['"`]([^'"`]*)['"`]/);
    if (!keyM) continue;
    const base = keyMap.get(keyM[1]);
    if (!base) {
      varToKey.set(varName, {
        key: keyM[1],
        host: null,
        prefix: prefixM ? prefixM[1] : '',
      });
      continue;
    }
    const prefix =
      prefixM
        ? prefixM[1] === ''
          ? base.prefix // prefix: "" → still use env pathname for mock key
          : prefixM[1]
        : base.prefix;
    varToKey.set(varName, {
      key: base.key,
      host: base.host,
      prefix: prefix || '',
    });
  }

  // xxx("/external/...") or xxx({ uri: "...", type: "post" })
  for (const [varName, base] of varToKey) {
    const callStrRe = new RegExp(
      `\\b${varName}\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*\\)`,
      'g',
    );
    while ((m = callStrRe.exec(content))) {
      const uri = m[1].split('?')[0];
      if (!uri.startsWith('/') || /\$\{/.test(uri)) continue;
      const fullPath = joinPrefix(base.prefix, uri);
      if (isGatewayOnlyPath(fullPath, serviceBases) || isStaticAsset(fullPath)) {
        continue;
      }
      const line = content.slice(0, m.index).split(/\n/).length;
      apis.push({
        method: 'GET',
        host: base.host || '_default',
        path: fullPath,
        evidence: `${file}:${line}`,
        confidence: base.host ? 'high' : 'medium',
        exportHint: null,
        queryHints: [],
        bodyHints: [],
        responseHints: [],
        responseShape: null,
        serviceKey: base.key,
      });
    }

    const callObjRe = new RegExp(
      `\\b${varName}\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`,
      'g',
    );
    while ((m = callObjRe.exec(content))) {
      const obj = m[1];
      const uriM = obj.match(/uri\s*:\s*['"`]([^'"`]+)['"`]/);
      if (!uriM) continue;
      const uri = uriM[1].split('?')[0];
      if (!uri.startsWith('/')) continue;
      const typeM = obj.match(/type\s*:\s*['"`]([^'"`]+)['"`]/);
      const method = (typeM ? typeM[1] : 'get').toUpperCase();
      const fullPath = joinPrefix(base.prefix, uri);
      if (isGatewayOnlyPath(fullPath, serviceBases) || isStaticAsset(fullPath)) {
        continue;
      }
      const line = content.slice(0, m.index).split(/\n/).length;
      apis.push({
        method: method === 'FORM' ? 'POST' : method,
        host: base.host || '_default',
        path: fullPath,
        evidence: `${file}:${line}`,
        confidence: base.host ? 'high' : 'medium',
        exportHint: null,
        queryHints: [],
        bodyHints: [],
        responseHints: [],
        responseShape: null,
        serviceKey: base.key,
      });
    }
  }

  // export const foo = varName("/path") — reliable export binding
  const exportStrRe =
    /export\s+const\s+(\w+)\s*=\s*(\w+)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = exportStrRe.exec(content))) {
    const exportName = m[1];
    const base = varToKey.get(m[2]);
    if (!base) continue;
    const uri = m[3].split('?')[0];
    const fullPath = joinPrefix(base.prefix, uri);
    const line = content.slice(0, m.index).split(/\n/).length;
    const hit = apis.find(
      (a) => a.path === fullPath && a.host === (base.host || '_default'),
    );
    if (hit) hit.exportHint = exportName;
    else if (!isGatewayOnlyPath(fullPath, serviceBases)) {
      apis.push({
        method: 'GET',
        host: base.host || '_default',
        path: fullPath,
        evidence: `${file}:${line}`,
        confidence: 'high',
        exportHint: exportName,
        queryHints: [],
        bodyHints: [],
        responseHints: [],
        responseShape: null,
        serviceKey: base.key,
      });
    }
  }

  const exportObjRe =
    /export\s+const\s+(\w+)\s*=\s*(\w+)\s*\(\s*\{[\s\S]*?uri\s*:\s*['"`]([^'"`]+)['"`][\s\S]*?type\s*:\s*['"`]([^'"`]+)['"`]/g;
  while ((m = exportObjRe.exec(content))) {
    const exportName = m[1];
    const base = varToKey.get(m[2]);
    if (!base) continue;
    const uri = m[3].split('?')[0];
    const method = (m[4] || 'get').toUpperCase();
    const fullPath = joinPrefix(base.prefix, uri);
    const hit = apis.find(
      (a) =>
        a.path === fullPath &&
        a.host === (base.host || '_default') &&
        a.method === method,
    );
    if (hit) hit.exportHint = exportName;
  }

  // Fallback: nearby line match for multiline export const x = req(\n  "/path"
  const exportRe = /export\s+const\s+(\w+)\s*=\s*(\w+)\s*\(/g;
  while ((m = exportRe.exec(content))) {
    const exportName = m[1];
    if (!varToKey.has(m[2])) continue;
    const exportLine = content.slice(0, m.index).split(/\n/).length;
    let best = null;
    let bestDist = 6;
    for (const api of apis) {
      if (api.exportHint) continue;
      const line = Number(String(api.evidence).split(':').pop());
      const dist = Math.abs(line - exportLine);
      if (dist < bestDist) {
        best = api;
        bestDist = dist;
      }
    }
    if (best) best.exportHint = exportName;
  }

  // Track const VARNAME = reqVar("/path") → link to API entry for export { VARNAME }
  const varNameToApi = new Map();
  for (const [varName, base] of varToKey) {
    const assignStrRe = new RegExp(
      `(?:const|let|var)\\s+(\\w+)\\s*=\\s*\\b${varName}\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*\\)`,
      'g',
    );
    while ((m = assignStrRe.exec(content))) {
      const assignedVar = m[1];
      const uri = m[2].split('?')[0];
      if (!uri.startsWith('/')) continue;
      const fullPath = joinPrefix(base.prefix, uri);
      const hit = apis.find(
        (a) =>
          a.path === fullPath && a.host === (base.host || '_default'),
      );
      if (hit) varNameToApi.set(assignedVar, hit);
    }
    const assignObjRe = new RegExp(
      `(?:const|let|var)\\s+(\\w+)\\s*=\\s*\\b${varName}\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`,
      'g',
    );
    while ((m = assignObjRe.exec(content))) {
      const assignedVar = m[1];
      const obj = m[2];
      const uriM = obj.match(/uri\s*:\s*['"`]([^'"`]+)['"`]/);
      if (!uriM) continue;
      const uri = uriM[1].split('?')[0];
      if (!uri.startsWith('/')) continue;
      const typeM = obj.match(/type\s*:\s*['"`]([^'"`]+)['"`]/);
      const method = (typeM ? typeM[1] : 'get').toUpperCase();
      const fullPath = joinPrefix(base.prefix, uri);
      const hit = apis.find(
        (a) =>
          a.path === fullPath &&
          a.host === (base.host || '_default') &&
          a.method === (method === 'FORM' ? 'POST' : method),
      );
      if (hit) varNameToApi.set(assignedVar, hit);
    }
  }

  // export { a, b as c } — bind exportHint by local name
  const exportListRe = /export\s*\{([^}]+)\}/g;
  while ((m = exportListRe.exec(content))) {
  // Skip re-exports: export { x } from '...'
    const after = content.slice(m.index + m[0].length);
    if (/^\s*from\s*['"`]/.test(after)) continue;
    const specs = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const spec of specs) {
      const parts = spec.split(/\s+as\s+/);
      const localName = parts[0].trim();
      const exportName = parts[1]?.trim() || localName;
      const hit = varNameToApi.get(localName);
      if (hit && !hit.exportHint) hit.exportHint = exportName;
    }
  }

  // Async / rename wrappers: find export function body, then search for inner call
  // (no fixed char window — long TS param/return types must not break binding)
  for (const [innerName, hit] of varNameToApi) {
    if (hit.exportHint) continue;
    const innerCall = new RegExp(`\\b${innerName}\\s*\\(`);
    const fnRe = /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g;
    let fm;
    while ((fm = fnRe.exec(content))) {
      const exportName = fm[1];
      const openParen = fm.index + fm[0].length - 1;
      const body = extractFunctionBodyAfterParen(content, openParen);
      if (body && innerCall.test(body)) {
        hit.exportHint = exportName;
        break;
      }
    }
    if (hit.exportHint) continue;
    const arrowRe =
      /export\s+const\s+(\w+)\s*=\s*async\s*(?:\([^)]*\)|[\w]+)\s*(?::\s*[^=]+)?\s*=>/g;
    while ((fm = arrowRe.exec(content))) {
      const exportName = fm[1];
      const after = content.slice(fm.index + fm[0].length);
      const trimmed = after.replace(/^\s*/, '');
      let body = null;
      if (trimmed.startsWith('{')) {
        body = extractBalancedBlock(
          content,
          fm.index + fm[0].length + (after.length - trimmed.length),
        );
      } else {
        const m = trimmed.match(/^[^;\n]+/);
        body = m ? m[0] : trimmed.slice(0, 400);
      }
      if (body && innerCall.test(body)) {
        hit.exportHint = exportName;
        break;
      }
    }
  }

  // Small wrapper: export const x = (data) => reqVar({ uri: "..." })(data)
  // or export const x = (...) => innerReq(...)
  const wrapRe =
    /export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*(\w+)\s*\(/g;
  while ((m = wrapRe.exec(content))) {
    const exportName = m[1];
    const callee = m[2];
    const hit = varNameToApi.get(callee);
    if (hit && !hit.exportHint) hit.exportHint = exportName;
    else if (varToKey.has(callee)) {
      // export const x = (d) => req({ uri })(d) — find nearby api without hint
      const exportLine = content.slice(0, m.index).split(/\n/).length;
      let best = null;
      let bestDist = 8;
      for (const api of apis) {
        if (api.exportHint) continue;
        const line = Number(String(api.evidence).split(':').pop());
        const dist = Math.abs(line - exportLine);
        if (dist < bestDist) {
          best = api;
          bestDist = dist;
        }
      }
      if (best) best.exportHint = exportName;
    }
  }

  // export default { getX, getY } — bind object keys that match local req bindings
  const defaultObjRe = /export\s+default\s*\{([^}]+)\}/g;
  while ((m = defaultObjRe.exec(content))) {
    const keys = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const key of keys) {
      // support shorthand getX or getX: getX / getX: foo
      const parts = key.split(':').map((s) => s.trim());
      const exportName = parts[0].replace(/\s+/g, '');
      const localName = (parts[1] || parts[0]).replace(/\s+/g, '');
      if (!/^[A-Za-z_]\w*$/.test(exportName)) continue;
      const hit = varNameToApi.get(localName);
      if (hit && !hit.exportHint) hit.exportHint = exportName;
    }
  }

  return apis;
}

/**
 * request.get|post({ key: 'SERVICE_KEY', uri: '/api/...' })
 */
function extractRequestKeyUriApis(content, file, serviceBases) {
  const apis = [];
  const keyMap = new Map(serviceBases.map((b) => [b.key, b]));
  const re =
    /\brequest\.(get|post|put|delete|patch)\s*\(\s*\{([\s\S]*?)\}\s*\)/gi;
  let m;
  while ((m = re.exec(content))) {
    const method = m[1].toUpperCase();
    const obj = m[2];
    const keyM = obj.match(/key\s*:\s*['"`]([^'"`]+)['"`]/);
    const uriM = obj.match(/uri\s*:\s*['"`]([^'"`]+)['"`]/);
    if (!keyM || !uriM) continue;
    const uri = uriM[1].split('?')[0];
    if (!uri.startsWith('/') || /\$\{/.test(uri)) continue;
    const base = keyMap.get(keyM[1]);
    const host = base?.host || '_default';
    const fullPath = joinPrefix(base?.prefix || '', uri);
    if (isGatewayOnlyPath(fullPath, serviceBases) || isStaticAsset(fullPath)) {
      continue;
    }
    const line = content.slice(0, m.index).split(/\n/).length;
    // Try to find export binding on same/nearby assignment
    let exportHint = null;
    const before = content.slice(Math.max(0, m.index - 120), m.index);
    const assignM =
      /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*$/.exec(before) ||
      /export\s+(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{[^}]*$/.exec(
        content.slice(Math.max(0, m.index - 200), m.index),
      );
    if (assignM) exportHint = assignM[1];
    apis.push({
      method,
      host,
      path: fullPath,
      evidence: `${file}:${line}`,
      confidence: base?.host ? 'high' : 'medium',
      exportHint,
      queryHints: [],
      bodyHints: [],
      responseHints: [],
      responseShape: null,
      serviceKey: keyM[1],
    });
  }
  return apis;
}

function extractLegacyApis(content, file, serviceBases, hostVars = new Map(), wrappers = null) {
  const { loadInferConfig } = require('../lib/infer/load-infer-config');
  const wrapperList = wrappers || loadInferConfig().httpWrappers || [];
  const wrapperPresenceRe = buildWrapperPresenceRe(wrapperList);
  const reqCtxRe = buildReqCtxRe(wrapperList);

  const apis = [];
  const push = (partial) => {
    if (!partial.path || isStaticAsset(partial.path)) return;
    if (isGatewayOnlyPath(partial.path, serviceBases)) return;
    // If path equals a service prefix only — skip
    if (
      serviceBases.some(
        (b) =>
          b.prefix &&
          (partial.path === b.prefix ||
            (partial.host === b.host && partial.path === b.prefix)),
      )
    ) {
      return;
    }
    apis.push({
      method: (partial.method || 'GET').toUpperCase(),
      host: partial.host || '_default',
      path: partial.path,
      evidence: `${file}:${partial.line || 0}`,
      confidence: partial.confidence || 'medium',
      exportHint: null,
      queryHints: partial.queryHints || [],
      bodyHints: partial.bodyHints || [],
      responseHints: partial.responseHints || [],
      responseShape: null,
      hostVar: partial.hostVar || null,
      prefixKey: partial.prefixKey || null,
    });
  };

  const lines = content.split(/\r?\n/);
  const absRe = /(['"`])https?:\/\/([^'"`/?#]+)(\/[^'"`]*)?\1/g;
  const axiosUrlRe =
    /axios\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  const fetchUrlRe = /\bfetch\s*\(\s*(['"`])([^'"`]+)\1/gi;
  // Generic: any quoted multi-segment path literal (e.g. '/v1/users', '/users/{id}').
  // Host is resolved from matching service-base prefix; no hardcoded gateway names.
  const pathLiteralRe =
    /['"`](\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._{}$\-]+(?:\?[^'"`]*)?)['"`]/g;

  const prefixByHost = new Map();
  for (const b of serviceBases) {
    if (!prefixByHost.has(b.host)) prefixByHost.set(b.host, []);
    prefixByHost.get(b.host).push(b);
  }

  function methodFromFetchLine(line, fromIndex) {
    const slice = line.slice(fromIndex);
    const m = /method\s*:\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`]/i.exec(slice);
    if (m) return m[1].toUpperCase();
    return 'GET';
  }

  function nearbyText(lineIdx) {
    const from = Math.max(0, lineIdx - 8);
    const to = Math.min(lines.length, lineIdx + 9);
    return lines.slice(from, to).join('\n');
  }

  // Configured HTTP wrappers: callee.`${hostVar}/path` and absolute URLs
  extractHttpWrapperApis({
    content,
    hostVars,
    serviceBases,
    wrappers: wrapperList,
    isGatewayOnlyPath,
    parseHostUrlLiteral,
    pathDepth,
    push,
  });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    // Skip pure env assignment lines of gateway bases
    if (/^\s*[A-Z][A-Z0-9_]*\s*:\s*['"`]https?:\/\//.test(line)) {
      continue;
    }

    const hasFetch = /\bfetch\s*\(/.test(line);
    const hasAxios = /\baxios\./.test(line);
    const hasHttpWrapper = wrapperPresenceRe.test(line);

    absRe.lastIndex = 0;
    let m;
    while ((m = absRe.exec(line))) {
      // Dedicated fetch/axios/$HTTP extractors own method detection on these lines
      if (hasFetch || hasAxios || hasHttpWrapper) continue;
      if (isNavigationContext(line, nearbyText(i))) continue;
      const p = (m[3] || '/').split('?')[0];
      if (!p || p === '/') continue;
      if (isGatewayOnlyPath(p, serviceBases)) continue;
      push({
        host: m[2],
        path: p,
        method: /post/i.test(line) ? 'POST' : 'GET',
        line: lineNo,
        confidence: 'high',
      });
    }

    axiosUrlRe.lastIndex = 0;
    while ((m = axiosUrlRe.exec(line))) {
      const raw = m[2];
      if (raw.startsWith('http')) {
        try {
          const u = new URL(raw);
          if (isGatewayOnlyPath(u.pathname, serviceBases)) continue;
          push({
            method: m[1].toUpperCase(),
            host: u.host,
            path: u.pathname,
            line: lineNo,
            confidence: 'high',
          });
        } catch {
          /* ignore */
        }
      } else if (raw.startsWith('/')) {
        const full = raw.split('?')[0];
        if (isGatewayOnlyPath(full, serviceBases)) continue;
        push({
          method: m[1].toUpperCase(),
          host: '_default',
          path: full,
          line: lineNo,
          confidence: 'medium',
        });
      }
    }

    fetchUrlRe.lastIndex = 0;
    while ((m = fetchUrlRe.exec(line))) {
      const raw = m[2];
      const method = methodFromFetchLine(line, m.index);
      if (raw.startsWith('http')) {
        try {
          const u = new URL(raw.replace(/\$\{[^}]+\}/g, '1'));
          if (isGatewayOnlyPath(u.pathname, serviceBases)) continue;
          push({
            method,
            host: u.host,
            path: u.pathname,
            line: lineNo,
            confidence: 'high',
          });
        } catch {
          /* ignore */
        }
      } else if (raw.startsWith('/')) {
        const full = raw.split('?')[0];
        if (isGatewayOnlyPath(full, serviceBases)) continue;
        push({
          method,
          host: '_default',
          path: full,
          line: lineNo,
          confidence: 'medium',
        });
      }
    }
  }

  pathLiteralRe.lastIndex = 0;
  let pm;
  while ((pm = pathLiteralRe.exec(content))) {
    const rawCap = pm[1];
    // Drop unresolved path interpolations (e.g. /users/${id}); host-var templates
    // are handled by $HTTP extractor above.
    if (/\$\{/.test(rawCap)) continue;
    const p = rawCap.split('?')[0];
    if (isGatewayOnlyPath(p, serviceBases)) continue;
    if (isStaticAsset(p)) continue;
    // Require request-like context near the literal (avoid SPA navigate / JSDoc)
    const ctxStart = Math.max(0, pm.index - 120);
    const ctxEnd = Math.min(content.length, pm.index + rawCap.length + 80);
    const ctx = content.slice(ctxStart, ctxEnd);
    if (!reqCtxRe.test(ctx) && !REQ_CTX_RE.test(ctx)) continue;
    // Resolve host from matching service-base prefix
    let host = '_default';
    for (const b of serviceBases) {
      if (b.prefix && (p === b.prefix || p.startsWith(`${b.prefix}/`))) {
        host = b.host;
        break;
      }
    }
    const line = content.slice(0, pm.index).split(/\n/).length;
    if (!apis.some((a) => a.path === p && a.host === host)) {
      push({
        method: 'GET',
        host,
        path: p,
        line,
        confidence: host === '_default' ? 'low' : 'medium',
      });
    }
  }

  // Bind export function/const wrappers that contain the URL/path (fetch/axios/$HTTP)
  bindLegacyExportHints(content, apis);

  return apis;
}

/**
 * Link export async function foo(){ fetch('.../path') } → exportHint=foo
 * Also: const foo = () => $HTTP.getP(...) + export { foo }
 * Binding uses evidence line ∈ function body line range (avoids path substring collisions).
 */
function bindLegacyExportHints(content, apis) {
  const unbound = apis.filter((a) => !a.exportHint);
  if (unbound.length === 0) return;

  /** @type {Map<string, typeof apis>} */
  const localNameToApis = new Map();

  function evidenceLine(api) {
    const n = Number(String(api.evidence || '').split(':').pop());
    return Number.isFinite(n) ? n : -1;
  }

  function bindRange(exportName, startIdx, endIdx, asLocal) {
    const startLine = content.slice(0, startIdx).split(/\n/).length;
    const endLine = content.slice(0, endIdx).split(/\n/).length;
    for (const api of unbound) {
      if (api.exportHint) continue;
      const line = evidenceLine(api);
      if (line >= startLine && line <= endLine) {
        if (asLocal) {
          if (!localNameToApis.has(exportName)) localNameToApis.set(exportName, []);
          localNameToApis.get(exportName).push(api);
        } else {
          api.exportHint = exportName;
        }
      }
    }
  }

  const fnRe = /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g;
  let fm;
  while ((fm = fnRe.exec(content))) {
    const exportName = fm[1];
    const openParen = fm.index + fm[0].length - 1;
    const body = extractFunctionBodyAfterParen(content, openParen);
    if (!body) continue;
    // body is the block content; locate its span in content
    const bodyStart = content.indexOf(body, fm.index);
    const bodyEnd = bodyStart >= 0 ? bodyStart + body.length : fm.index + fm[0].length;
    bindRange(exportName, fm.index, bodyEnd, false);
  }

  const arrowRe =
    /export\s+(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w]+)\s*(?::\s*[^=]+)?\s*=>/g;
  while ((fm = arrowRe.exec(content))) {
    const exportName = fm[1];
    const after = content.slice(fm.index + fm[0].length);
    const trimmed = after.replace(/^\s*/, '');
    let bodyEnd = fm.index + fm[0].length;
    if (trimmed.startsWith('{')) {
      const abs = fm.index + fm[0].length + (after.length - trimmed.length);
      const body = extractBalancedBlock(content, abs);
      if (body) bodyEnd = abs + body.length + 2;
    } else {
      const m = trimmed.match(/^[^;\n]+/);
      bodyEnd = fm.index + fm[0].length + (after.length - trimmed.length) + (m ? m[0].length : 0);
    }
    bindRange(exportName, fm.index, bodyEnd, false);
  }

  // Non-export: const getList = (data) => $HTTP.getP(...)  (possibly multi-line)
  const localArrowRe =
    /(?:^|[\n;])\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w]+)\s*(?::\s*[^=]+)?\s*=>/g;
  while ((fm = localArrowRe.exec(content))) {
    // Skip if this was already an export const (handled above)
    const before = content.slice(Math.max(0, fm.index - 12), fm.index + fm[0].length);
    if (/\bexport\s+(?:const|let|var)\s+\w+/.test(before)) continue;
    const localName = fm[1];
    const after = content.slice(fm.index + fm[0].length);
    const trimmed = after.replace(/^\s*/, '');
    let bodyEnd = fm.index + fm[0].length;
    if (trimmed.startsWith('{')) {
      const abs = fm.index + fm[0].length + (after.length - trimmed.length);
      const body = extractBalancedBlock(content, abs);
      if (body) bodyEnd = abs + body.length + 2;
    } else {
      // Expression body may span lines until `;` or blank-ish next statement
      const m = trimmed.match(/^[\s\S]*?(?=;|\n\s*(?:const|let|var|function|export|\/\*|\/\/)|\n\s*$)/);
      bodyEnd =
        fm.index +
        fm[0].length +
        (after.length - trimmed.length) +
        (m ? m[0].length : Math.min(trimmed.length, 400));
    }
    bindRange(localName, fm.index, bodyEnd, true);
  }

  // Non-export function declarations
  const localFnRe = /(?:^|[\n;])\s*(?:async\s+)?function\s+(\w+)\s*\(/g;
  while ((fm = localFnRe.exec(content))) {
    const before = content.slice(Math.max(0, fm.index - 12), fm.index + fm[0].length);
    if (/\bexport\s+(?:async\s+)?function\s+\w+/.test(before)) continue;
    const localName = fm[1];
    const openParen = fm.index + fm[0].length - 1;
    const body = extractFunctionBodyAfterParen(content, openParen);
    if (!body) continue;
    const bodyStart = content.indexOf(body, fm.index);
    const bodyEnd = bodyStart >= 0 ? bodyStart + body.length : fm.index + fm[0].length;
    bindRange(localName, fm.index, bodyEnd, true);
  }

  // export { a, b as c } — bind exportHint by local name (all host copies share hint)
  const exportListRe = /export\s*\{([^}]+)\}/g;
  let em;
  while ((em = exportListRe.exec(content))) {
    const after = content.slice(em.index + em[0].length);
    if (/^\s*from\s*['"`]/.test(after)) continue;
    const specs = em[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const spec of specs) {
      const parts = spec.split(/\s+as\s+/);
      const localName = parts[0].trim();
      const exportName = parts[1]?.trim() || localName;
      const hits = localNameToApis.get(localName) || [];
      for (const hit of hits) {
        if (!hit.exportHint) hit.exportHint = exportName;
      }
      // Also: already-unbound apis whose evidence is near a const localName assignment
      // covered via localNameToApis above.
    }
  }
}

function dedupe(apis) {
  const map = new Map();
  for (const a of apis) {
    const host = a.host || '_default';
    // Skip hash-router / UI paths
    if ((a.path || '').includes('#/')) continue;
    // Prefer stubId when present (post-collapse); otherwise fall back to
    // the legacy METHOD host+path key for raw extractor output.
    const key = a.stubId || `${a.method.toUpperCase()} ${host}${a.path}`;
    if (!map.has(key)) {
      map.set(key, {
        ...a,
        host,
        evidences: [a.evidence].filter(Boolean),
        // Preserve exportHints from collapse; only rebuild from exportHint
        // when no array is present (raw extractor output).
        exportHints: a.exportHints?.length
          ? [...a.exportHints]
          : a.exportHint
            ? [a.exportHint]
            : [],
        exportKeys: a.exportKeys?.length
          ? [...a.exportKeys]
          : a.exportKey
            ? [a.exportKey]
            : [],
      });
    } else {
      const cur = map.get(key);
      if (a.evidence) cur.evidences.push(a.evidence);
      if (a.exportHint && !cur.exportHints.includes(a.exportHint)) {
        cur.exportHints.push(a.exportHint);
      }
      if (a.exportKey && !cur.exportKeys.includes(a.exportKey)) {
        cur.exportKeys.push(a.exportKey);
      }
      if (a.confidence === 'high') cur.confidence = 'high';
      // Merge hosts[] when both carry upstream identity
      if (a.hosts && cur.hosts) {
        for (const h of a.hosts) {
          if (!cur.hosts.includes(h)) cur.hosts.push(h);
        }
      }
      // Keep richer responseShape
      if (a.responseShape && !cur.responseShape) cur.responseShape = a.responseShape;
    }
  }
  let list = [...map.values()].map((a) => ({
    ...a,
    // Prefer first hint for display; usage-io may rewrite to the callsite-rich one
    exportHint: a.exportHints?.[0] || null,
    exportKey: a.exportKeys?.[0] || a.exportKey || null,
  }));

  // Drop _default twin when a real-host API already covers the same method+path
  // (path equal, or real path ends with the _default path — no project-specific segments).
  // When stubId is present, collapseByUpstream already handled this; this guard
  // covers raw extractor output that bypassed collapse.
  const qualified = list.filter((a) => a.host && a.host !== '_default');
  list = list.filter((a) => {
    if (a.host !== '_default') return true;
    // Low-confidence path literals without export binding are usually noise
    if (a.confidence === 'low' && !a.exportHint) return false;
    const method = a.method.toUpperCase();
    const hasTwin = qualified.some(
      (b) =>
        b.method.toUpperCase() === method &&
        (b.path === a.path || b.path.endsWith(a.path)),
    );
    return !hasTwin;
  });
  return list;
}

function loadInferConfig(projectDir) {
  return require('../lib/infer/load-infer-config').loadInferConfig(projectDir);
}

function isDeniedHost(host, cfg) {
  if (!host || host === '_default') return false;
  const h = host.toLowerCase();
  const suffixes = cfg?.denyHostSuffixes || [];
  const keywords = cfg?.denyHostKeywords || [];
  if (suffixes.some((s) => h.endsWith(s.toLowerCase()))) return true;
  if (keywords.some((k) => h.includes(k.toLowerCase()))) return true;
  return false;
}

function isDeniedPath(pathname, cfg) {
  if (!pathname) return false;
  const subs = cfg?.denyPathSubstrings || [];
  return subs.some((s) => pathname.includes(s));
}

function loadAdapter(name) {
  if (!name) return null;
  const safe = String(name);
  if (!/^[a-zA-Z0-9_-]+$/.test(safe)) {
    throw new Error(`invalid adapter name: ${name}`);
  }
  const file = path.join(__dirname, '..', 'adapters', `${safe}.js`);
  if (!fs.existsSync(file)) {
    throw new Error(`adapter not found: ${name} (expected adapters/${safe}.js)`);
  }
  // Fresh require so tests can swap; adapters are small.
  delete require.cache[require.resolve(file)];
  return require(file);
}

function inferApiUsage(projectDir, opts = {}) {
  const serviceBases = discoverServiceBases(projectDir);
  const inferCfg = loadInferConfig(projectDir);
  const adapter = opts.adapter ? loadAdapter(opts.adapter) : null;
  const files = walk(projectDir);
  const hostVars = discoverHostVarAssignments(projectDir, files);
  const wrappers = inferCfg.httpWrappers || [];

  // mtime cache (skip when forceRefresh)
  if (!opts.forceRefresh) {
    try {
      const { getCached, setCached } = require('../lib/infer/cache');
      const cached = getCached(projectDir, files, opts);
      if (cached.hit && cached.value?.apis) {
        const clone = cached.value.apis.map((a) => ({ ...a }));
        Object.defineProperty(clone, 'meta', {
          value: { ...(cached.value.meta || {}), cacheHit: true },
          enumerable: false,
          writable: true,
        });
        return clone;
      }
      opts.__cacheWrite = {
        key: cached.key,
        fingerprint: cached.fingerprint,
        setCached,
      };
    } catch {
      /* cache optional */
    }
  }

  const all = [];
  let gatewayFilteredCount = 0;

  // AST CallShape discover (primary for direct/config; also covers member)
  try {
    const { discoverPrefixOriginMaps } = require('../lib/infer/prefix-origin-map');
    const { extractHttpCallShapeApis } = require('../lib/infer/http-call-shapes');
    const prefixMaps = discoverPrefixOriginMaps(projectDir, files);
    const shapeApis = extractHttpCallShapeApis({
      projectDir,
      files,
      hostVars,
      serviceBases,
      wrappers,
      callShapes: inferCfg.callShapes,
      importSources: inferCfg.importSources,
      prefixMaps,
      isGatewayOnlyPath,
    });
    all.push(...shapeApis);
  } catch (err) {
    console.warn(`[mox] call-shapes discover skipped: ${err.message}`);
  }

  // Count filtered gateway URLs for report
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (content.length > 1_500_000) continue;
    const rel = path.relative(projectDir, file);
    const isVue = path.extname(file) === '.vue';

    // For .vue files, extract script blocks and run discover on each.
    if (isVue) {
      const { extractVueScriptBlocks } = require('../lib/vue-script');
      const blocks = extractVueScriptBlocks(content);
      for (const blk of blocks) {
        const scriptContent = blk.content;
        if (!scriptContent || !scriptContent.trim()) continue;
        // Count abs URLs that are gateway-only in script content
        const absRe2 = /(['"`])https?:\/\/([^'"`/?#]+)(\/[^'"`]*)?\1/g;
        let m2;
        while ((m2 = absRe2.exec(scriptContent))) {
          const p = (m2[3] || '/').split('?')[0];
          if (p && isGatewayOnlyPath(p, serviceBases)) gatewayFilteredCount++;
        }
        all.push(...extractCreateRequestApis(scriptContent, rel, serviceBases));
        all.push(...extractRequestKeyUriApis(scriptContent, rel, serviceBases));
        all.push(...extractLegacyApis(scriptContent, rel, serviceBases, hostVars, wrappers));
        if (adapter && typeof adapter.extract === 'function') {
          const extra = adapter.extract({ content: scriptContent, rel, serviceBases, hostVars, wrappers }) || [];
          all.push(...extra);
        }
      }
      continue;
    }

    // Count abs URLs that are gateway-only
    const absRe = /(['"`])https?:\/\/([^'"`/?#]+)(\/[^'"`]*)?\1/g;
    let m;
    while ((m = absRe.exec(content))) {
      const p = (m[3] || '/').split('?')[0];
      if (p && isGatewayOnlyPath(p, serviceBases)) gatewayFilteredCount++;
    }

    all.push(...extractCreateRequestApis(content, rel, serviceBases));
    all.push(...extractRequestKeyUriApis(content, rel, serviceBases));
    all.push(...extractLegacyApis(content, rel, serviceBases, hostVars, wrappers));
    if (adapter && typeof adapter.extract === 'function') {
      const extra = adapter.extract({ content, rel, serviceBases, hostVars, wrappers }) || [];
      all.push(...extra);
    }
  }

  const collapsed = collapseByUpstream(all);
  const deduped = dedupe(collapsed);
  const filtered = deduped.filter(
    (a) => !isDeniedHost(a.host, inferCfg) && !isDeniedPath(a.path, inferCfg),
  );

  // Optionally enrich with ts-morph usage IO (deny-filtered list only)
  let enriched = filtered;
  if (opts.withUsageIo !== false) {
    try {
      const { enrichApisWithUsageIo } = require('./infer-usage-io');
      enriched = enrichApisWithUsageIo(projectDir, filtered, { inferCfg });
    } catch (err) {
      console.warn(
        `[mox] usage-io enrich skipped: ${err.message}`,
      );
      enriched = filtered;
    }
  }

  Object.defineProperty(enriched, 'meta', {
    value: {
      serviceBases,
      hostVars: [...hostVars.entries()].map(([k, v]) => ({
        key: k,
        hosts: v.map((h) => h.host),
      })),
      gatewayFilteredCount,
      adapter: adapter ? adapter.name || opts.adapter : null,
      cacheHit: false,
    },
    enumerable: false,
    writable: true,
  });

  if (opts.__cacheWrite) {
    try {
      opts.__cacheWrite.setCached(opts.__cacheWrite.key, opts.__cacheWrite.fingerprint, {
        apis: enriched.map((a) => ({ ...a })),
        meta: enriched.meta,
      });
    } catch {
      /* ignore */
    }
  }
  return enriched;
}

module.exports = {
  inferApiUsage,
  discoverServiceBases,
  discoverHostVarAssignments,
  joinPrefix,
  isGatewayOnlyPath,
  pathDepth,
  extractCreateRequestApis,
  extractRequestKeyUriApis,
  extractLegacyApis,
  parseHostUrlLiteral,
  httpWrapperMethod,
  loadAdapter,
};

if (require.main === module) {
  const dir = process.argv[2] || process.cwd();
  const result = inferApiUsage(dir);
  console.log(JSON.stringify(result, null, 2));
}
