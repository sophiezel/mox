'use strict';

/**
 * HTTP CallShape AST IR — discover APIs from CallExpressions via ts-morph.
 *
 * Shapes (config callShapes):
 *   member — callee.verb(url, …)
 *   direct — callee(url, { method }?)
 *   config — callee({ url|uri|path, method|type })
 *
 * Callee recognition (either):
 *   1. Identifier in httpWrappers[].callee
 *   2. Import from importSources (local binding name arbitrary)
 *
 * No brand-specific hardcoding beyond configurable importSources.
 */

const fs = require('fs');
const path = require('path');
const {
  resolveRelativePath,
} = require('./prefix-origin-map');
const { resolveWrapperMethod } = require('./http-wrappers');

const DEFAULT_CALL_SHAPES = ['member', 'direct', 'config'];
const DEFAULT_IMPORT_SOURCES = [
  '@umijs/max',
  'umi',
  '@umijs/request',
  'axios',
  'umi-request',
];

/**
 * @param {string} moduleSpecifier
 * @param {string[]} importSources
 */
function isHttpImportSource(moduleSpecifier, importSources) {
  if (!moduleSpecifier) return false;
  const sources = importSources || DEFAULT_IMPORT_SOURCES;
  return sources.some(
    (s) =>
      moduleSpecifier === s ||
      moduleSpecifier.startsWith(`${s}/`) ||
      moduleSpecifier.endsWith(`/${s}`),
  );
}

/**
 * Build maps: localName → true if HTTP client binding.
 * @param {object} sf - ts-morph SourceFile
 * @param {Array<{callee:string, methods:Record<string,string>}>} wrappers
 * @param {string[]} importSources
 */
function collectHttpCalleeBindings(sf, wrappers, importSources) {
  /** @type {Map<string, { kind: 'wrapper'|'import', methods?: Record<string,string>, fromImport?: boolean }>} */
  const map = new Map();

  const wrapperByName = new Map(
    (wrappers || []).map((w) => [w.callee, w]),
  );

  // Register wrapper callees by name (always available as identifier match)
  for (const [name, w] of wrapperByName) {
    map.set(name, { kind: 'wrapper', methods: w.methods || {} });
  }

  // Import bindings from known HTTP modules
  for (const decl of sf.getImportDeclarations?.() || []) {
    const spec = decl.getModuleSpecifierValue?.();
    if (!isHttpImportSource(spec, importSources)) continue;

    for (const ni of decl.getNamedImports?.() || []) {
      const local = ni.getAliasNode?.()?.getText?.() || ni.getName?.();
      if (!local) continue;
      const existing = map.get(local);
      map.set(local, {
        kind: 'import',
        fromImport: true,
        methods: existing?.methods || wrapperByName.get(local)?.methods || {},
      });
    }
    const def = decl.getDefaultImport?.();
    if (def) {
      const local = def.getText?.();
      if (local) {
        const existing = map.get(local);
        map.set(local, {
          kind: 'import',
          fromImport: true,
          methods: existing?.methods || {},
        });
      }
    }
    const ns = decl.getNamespaceImport?.();
    if (ns) {
      const local = ns.getText?.();
      if (local) {
        map.set(local, { kind: 'import', fromImport: true, methods: {} });
      }
    }
  }

  // Also treat bare `fetch` as HTTP (direct shape)
  if (!map.has('fetch')) {
    map.set('fetch', { kind: 'wrapper', methods: {} });
  }
  if (!map.has('axios')) {
    map.set('axios', {
      kind: 'wrapper',
      methods: {
        get: 'GET',
        post: 'POST',
        put: 'PUT',
        delete: 'DELETE',
        patch: 'PATCH',
      },
    });
  }

  return map;
}

/**
 * Resolve URL expression to { kind, path?, host?, hostVar?, abs? } or null if dynamic.
 * @param {object} expr - ts-morph Node
 * @param {object} SyntaxKind
 */
function resolveUrlExpression(expr, SyntaxKind) {
  if (!expr) return null;
  const kind = expr.getKind?.();

  // Strip parentheses / as / await
  if (
    kind === SyntaxKind.ParenthesizedExpression ||
    kind === SyntaxKind.AsExpression ||
    kind === SyntaxKind.SatisfiesExpression ||
    kind === SyntaxKind.NonNullExpression ||
    kind === SyntaxKind.AwaitExpression
  ) {
    return resolveUrlExpression(expr.getExpression?.(), SyntaxKind);
  }

  if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    const raw = expr.getLiteralText?.() ?? expr.getText?.().slice(1, -1);
    return parseUrlLiteral(raw);
  }

  if (kind === SyntaxKind.TemplateExpression) {
    const head = expr.getHead?.()?.getLiteralText?.() ?? '';
    const spans = expr.getTemplateSpans?.() || [];
    // Pattern: `${hostVar}/static/path` — single interpolation at start
    if (spans.length === 1 && head === '') {
      const span = spans[0];
      const mid = span.getExpression?.();
      const lit = span.getLiteral?.()?.getLiteralText?.() ?? '';
      if (mid?.getKind?.() === SyntaxKind.Identifier && lit && !/\$\{/.test(lit)) {
        let suffix = lit.split('?')[0];
        if (!suffix.startsWith('/')) suffix = `/${suffix}`;
        return { kind: 'hostVar', hostVar: mid.getText(), path: suffix };
      }
    }
    // Pattern: `${hostVar}/path/${param}/...` — leading hostVar Identifier,
    // subsequent Identifier interpolations become `:param` placeholders.
    // Bounded: only when head === '' and the FIRST span is an Identifier
    // (the hostVar). Non-Identifier / non-StringLiteral expressions still
    // rejected (truly dynamic, not parametrizable).
    if (spans.length >= 2 && head === '') {
      const firstMid = spans[0].getExpression?.();
      if (firstMid?.getKind?.() === SyntaxKind.Identifier) {
        let path = '';
        let ok = true;
        for (const span of spans) {
          const mid = span.getExpression?.();
          const lit = span.getLiteral?.()?.getLiteralText?.() ?? '';
          if (mid?.getKind?.() === SyntaxKind.Identifier) {
            // First span = hostVar (no path contribution); later = :param
            if (span !== spans[0]) path += `:${mid.getText()}`;
          } else if (mid?.getKind?.() === SyntaxKind.StringLiteral) {
            path += mid.getLiteralText?.() ?? '';
          } else {
            ok = false;
            break;
          }
          path += lit;
        }
        if (ok) {
          let suffix = path.split('?')[0];
          if (!suffix.startsWith('/')) suffix = `/${suffix}`;
          // collapse accidental `:param` from the hostVar span (first span has no :prefix)
          return { kind: 'hostVar', hostVar: firstMid.getText(), path: suffix };
        }
      }
    }
    // Fully static template (no expressions that are identifiers only — if any ${} with non-id, skip)
    let built = head;
    for (const span of spans) {
      const mid = span.getExpression?.();
      if (mid?.getKind?.() !== SyntaxKind.StringLiteral) {
        // dynamic — reject
        return null;
      }
      built += mid.getLiteralText?.() ?? '';
      built += span.getLiteral?.()?.getLiteralText?.() ?? '';
    }
    if (/\$\{/.test(built)) return null;
    return parseUrlLiteral(built);
  }

  return null;
}

/**
 * @param {string} raw
 */
function parseUrlLiteral(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.split('?')[0];
  if (/\$\{/.test(cleaned)) return null;
  if (/^https?:\/\//i.test(cleaned) || cleaned.startsWith('//')) {
    try {
      let u = cleaned;
      if (u.startsWith('//')) u = `https:${u}`;
      const parsed = new URL(u);
      return {
        kind: 'abs',
        host: parsed.host,
        path: parsed.pathname || '/',
      };
    } catch {
      return null;
    }
  }
  if (cleaned.startsWith('/')) {
    return { kind: 'relative', path: cleaned };
  }
  return null;
}

/**
 * Read method from object literal property `method` or `type`.
 * @param {object} objLit
 * @param {object} SyntaxKind
 */
function methodFromObjectLiteral(objLit, SyntaxKind) {
  if (!objLit || !objLit.getProperties) return null;
  for (const prop of objLit.getProperties()) {
    if (prop.getKind?.() !== SyntaxKind.PropertyAssignment) continue;
    const name = prop.getName?.();
    if (name !== 'method' && name !== 'type') continue;
    const init = prop.getInitializer?.();
    if (!init) continue;
    if (
      init.getKind?.() === SyntaxKind.StringLiteral ||
      init.getKind?.() === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      return String(init.getLiteralText?.() || '').toUpperCase();
    }
  }
  return null;
}

/**
 * Read url|uri|path from object literal.
 * @param {object} objLit
 * @param {object} SyntaxKind
 */
function urlFromObjectLiteral(objLit, SyntaxKind) {
  if (!objLit || !objLit.getProperties) return null;
  for (const prop of objLit.getProperties()) {
    if (prop.getKind?.() !== SyntaxKind.PropertyAssignment) continue;
    const name = prop.getName?.();
    if (name !== 'url' && name !== 'uri' && name !== 'path') continue;
    return resolveUrlExpression(prop.getInitializer?.(), SyntaxKind);
  }
  return null;
}

/**
 * Find enclosing export function / const name for exportHint.
 * @param {object} node
 */
function findEnclosingExportHint(node) {
  let cur = node;
  while (cur) {
    const kind = cur.getKindName?.() || '';

    if (kind === 'FunctionDeclaration') {
      const name = cur.getName?.();
      if (name && cur.isExported?.()) return name;
      // export async function — isExported true
      const mods = cur.getModifiers?.()?.map((m) => m.getText?.()) || [];
      if (name && mods.some((t) => t === 'export')) return name;
    }

    if (kind === 'VariableDeclaration') {
      const name = cur.getName?.();
      const varStmt = cur.getParent?.()?.getParent?.();
      if (
        name &&
        varStmt?.getKindName?.() === 'VariableStatement' &&
        (varStmt.isExported?.() ||
          (varStmt.getModifiers?.() || []).some((m) => m.getText?.() === 'export'))
      ) {
        return name;
      }
    }

    // export default function foo / export default async function
    if (kind === 'ExportAssignment') {
      /* skip */
    }

    cur = cur.getParent?.();
  }
  return null;
}

/**
 * Expand a resolved URL into API push records (multi-host for relative).
 */
function expandUrlToApis(resolved, opts) {
  const {
    method,
    line,
    exportHint,
    hostVars,
    prefixMaps,
    fileRel,
  } = opts;
  /** @type {Array<object>} */
  const out = [];
  if (!resolved) return out;

  if (resolved.kind === 'abs') {
    out.push({
      method,
      host: resolved.host,
      path: resolved.path,
      line,
      confidence: 'high',
      exportHint,
      evidence: `${fileRel}:${line}`,
    });
    return out;
  }

  if (resolved.kind === 'hostVar') {
    const hosts = hostVars?.get?.(resolved.hostVar) || [];
    if (!hosts.length) {
      out.push({
        method,
        host: '_default',
        path: resolved.path,
        line,
        confidence: 'medium',
        exportHint,
        evidence: `${fileRel}:${line}`,
        hostVar: resolved.hostVar,
      });
      return out;
    }
    for (const h of hosts) {
      out.push({
        method,
        host: h.host,
        path: resolved.path,
        line,
        confidence: 'high',
        exportHint,
        evidence: `${fileRel}:${line}`,
        hostVar: resolved.hostVar,
      });
    }
    return out;
  }

  if (resolved.kind === 'relative') {
    const resolvedHosts = resolveRelativePath(resolved.path, prefixMaps);
    for (const r of resolvedHosts) {
      out.push({
        method,
        host: r.host,
        path: r.path,
        line,
        confidence: r.confidence || 'medium',
        exportHint,
        evidence: `${fileRel}:${line}`,
        prefixKey: r.prefixKey || null,
      });
    }
  }
  return out;
}

/**
 * Classify and extract from one CallExpression.
 * @returns {Array<object>}
 */
function extractFromCallExpression(call, ctx) {
  const {
    SyntaxKind,
    calleeMap,
    callShapes,
    wrappers,
    hostVars,
    prefixMaps,
    fileRel,
    isGatewayOnlyPath,
    serviceBases,
  } = ctx;

  const shapes = new Set(callShapes || DEFAULT_CALL_SHAPES);
  const expr = call.getExpression?.();
  if (!expr) return [];

  const args = call.getArguments?.() || [];
  const line = call.getStartLineNumber?.() || 0;
  const exportHint = findEnclosingExportHint(call);

  /** @type {Array<object>} */
  let partials = [];

  // member: callee.verb(arg0)
  if (
    shapes.has('member') &&
    expr.getKind?.() === SyntaxKind.PropertyAccessExpression
  ) {
    const obj = expr.getExpression?.();
    const verb = expr.getName?.();
    if (obj?.getKind?.() === SyntaxKind.Identifier) {
      const name = obj.getText?.();
      const binding = calleeMap.get(name);
      // axios.get / request.get / $HTTP.get — binding must exist
      // Also allow axios even if only registered as axios
      if (binding || name === 'axios') {
        const methods =
          binding?.methods ||
          wrappers?.find?.((w) => w.callee === name)?.methods ||
          {};
        const method = resolveWrapperMethod(verb, methods);
        if (args[0]) {
          const url = resolveUrlExpression(args[0], SyntaxKind);
          partials = expandUrlToApis(url, {
            method,
            line,
            exportHint,
            hostVars,
            prefixMaps,
            fileRel,
          });
        }
      }
    }
  }

  // direct: callee(arg0, arg1?)
  if (
    shapes.has('direct') &&
    expr.getKind?.() === SyntaxKind.Identifier &&
    args.length >= 1
  ) {
    const name = expr.getText?.();
    const binding = calleeMap.get(name);
    // For direct shape: require registry name OR import binding.
    // Avoid treating every `request(`-named local helper wrongly — registry includes `request`.
    // Import-bound aliases always qualify.
    // Bare `fetch` qualifies.
    const allowDirect =
      binding &&
      (binding.fromImport ||
        binding.kind === 'wrapper' ||
        name === 'fetch');
    if (allowDirect) {
      // Skip if this looks like member was already intended — N/A for Identifier
      // Skip config-only if first arg is object — handled by config shape
      if (args[0].getKind?.() !== SyntaxKind.ObjectLiteralExpression) {
        const url = resolveUrlExpression(args[0], SyntaxKind);
        let method = 'GET';
        if (
          args[1] &&
          args[1].getKind?.() === SyntaxKind.ObjectLiteralExpression
        ) {
          method =
            methodFromObjectLiteral(args[1], SyntaxKind) || method;
        }
        partials = expandUrlToApis(url, {
          method,
          line,
          exportHint,
          hostVars,
          prefixMaps,
          fileRel,
        });
      }
    }
  }

  // config: callee({ url, method })
  if (
    shapes.has('config') &&
    expr.getKind?.() === SyntaxKind.Identifier &&
    args.length >= 1 &&
    args[0].getKind?.() === SyntaxKind.ObjectLiteralExpression
  ) {
    const name = expr.getText?.();
    const binding = calleeMap.get(name);
    if (binding) {
      const url = urlFromObjectLiteral(args[0], SyntaxKind);
      const method =
        methodFromObjectLiteral(args[0], SyntaxKind) || 'GET';
      partials = expandUrlToApis(url, {
        method,
        line,
        exportHint,
        hostVars,
        prefixMaps,
        fileRel,
      });
    }
  }

  // Filter gateway-only / static
  return partials.filter((p) => {
    if (!p.path || p.path === '/') return false;
    if (typeof isGatewayOnlyPath === 'function' && isGatewayOnlyPath(p.path, serviceBases)) {
      return false;
    }
    return true;
  });
}

/**
 * Extract APIs from project files using CallShape AST.
 *
 * @param {object} opts
 * @param {string} opts.projectDir
 * @param {string[]} opts.files - absolute paths
 * @param {Map} opts.hostVars
 * @param {Array} opts.serviceBases
 * @param {Array} opts.wrappers
 * @param {string[]} [opts.callShapes]
 * @param {string[]} [opts.importSources]
 * @param {Array} opts.prefixMaps
 * @param {function} opts.isGatewayOnlyPath
 * @returns {Array<object>}
 */
function extractHttpCallShapeApis(opts) {
  const {
    projectDir,
    files,
    hostVars,
    serviceBases,
    wrappers,
    callShapes = DEFAULT_CALL_SHAPES,
    importSources = DEFAULT_IMPORT_SOURCES,
    prefixMaps = [],
    isGatewayOnlyPath,
  } = opts;

  let Project;
  let SyntaxKind;
  let ScriptTarget;
  let ModuleKind;
  try {
    ({ Project, SyntaxKind, ScriptTarget, ModuleKind } = require('ts-morph'));
  } catch (e) {
    console.warn(`[mox] call-shapes skipped: ts-morph unavailable (${e.message})`);
    return [];
  }

  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      allowJs: true,
      target: ScriptTarget.ESNext,
      module: ModuleKind.ESNext,
      jsx: 2, // React
      strict: false,
      skipLibCheck: true,
      noResolve: true,
    },
  });

  const scriptExt = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  /** @type {Array<{ sf: object, rel: string }>} */
  const sources = [];

  for (const file of files || []) {
    const ext = path.extname(file);
    const rel = path.relative(projectDir, file);
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (content.length > 1_500_000) continue;

    if (ext === '.vue') {
      try {
        const { extractVueScriptBlocks } = require('../vue-script');
        const blocks = extractVueScriptBlocks(content);
        let i = 0;
        for (const blk of blocks) {
          if (!blk.content?.trim()) continue;
          const virtual = `${rel}.__script${i++}.ts`;
          const sf = project.createSourceFile(virtual, blk.content, {
            overwrite: true,
          });
          sources.push({ sf, rel });
        }
      } catch {
        /* skip vue */
      }
      continue;
    }

    if (!scriptExt.has(ext)) continue;
    // Skip ambient .d.ts
    if (file.endsWith('.d.ts')) continue;
    const sf = project.createSourceFile(rel, content, { overwrite: true });
    sources.push({ sf, rel });
  }

  /** @type {Array<object>} */
  const apis = [];

  for (const { sf, rel } of sources) {
    const calleeMap = collectHttpCalleeBindings(sf, wrappers, importSources);
    const ctx = {
      SyntaxKind,
      calleeMap,
      callShapes,
      wrappers,
      hostVars,
      prefixMaps,
      fileRel: rel,
      isGatewayOnlyPath,
      serviceBases,
    };

    let calls;
    try {
      calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
    } catch {
      continue;
    }

    for (const call of calls) {
      try {
        const partials = extractFromCallExpression(call, ctx);
        for (const p of partials) {
          apis.push({
            method: (p.method || 'GET').toUpperCase(),
            host: p.host || '_default',
            path: p.path,
            evidence: p.evidence || `${rel}:${p.line || 0}`,
            confidence: p.confidence || 'medium',
            exportHint: p.exportHint || null,
            exportKey: p.exportHint
              ? `${String(rel).replace(/\\/g, '/')}#${p.exportHint}`
              : null,
            queryHints: [],
            bodyHints: [],
            responseHints: [],
            responseShape: null,
            hostVar: p.hostVar || null,
            prefixKey: p.prefixKey || null,
          });
        }
      } catch {
        /* skip bad node */
      }
    }
  }

  return apis;
}

module.exports = {
  DEFAULT_CALL_SHAPES,
  DEFAULT_IMPORT_SOURCES,
  isHttpImportSource,
  collectHttpCalleeBindings,
  resolveUrlExpression,
  parseUrlLiteral,
  methodFromObjectLiteral,
  urlFromObjectLiteral,
  findEnclosingExportHint,
  extractHttpCallShapeApis,
};
