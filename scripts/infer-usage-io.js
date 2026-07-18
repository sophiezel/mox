'use strict';

/**
 * L2–L6 usage IO enrichment via ts-morph.
 * Tracks export references → call args → assignment aliases → property chains → enums.
 */

const fs = require('fs');
const path = require('path');

function emptyShape() {
  return { type: 'object', props: {} };
}

function ensureProp(shape, parts) {
  let cur = shape;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!cur.props) cur.props = {};
    if (!cur.props[p]) {
      cur.props[p] =
        i === parts.length - 1
          ? { type: 'unknown' }
          : { type: 'object', props: {} };
    }
    // Prefer object if we dig deeper
    if (i < parts.length - 1) {
      if (cur.props[p].type === 'unknown' || cur.props[p].type === 'array') {
        cur.props[p] = {
          type: 'object',
          props: cur.props[p].props || {},
          enums: cur.props[p].enums,
        };
      }
      if (!cur.props[p].props) cur.props[p].props = {};
      cur = cur.props[p];
    } else {
      cur = cur.props[p];
    }
  }
  return cur;
}

function addEnum(shape, fieldPath, value, source) {
  const parts = fieldPath.split('.').filter(Boolean);
  if (!parts.length) return;
  const leaf = ensureProp(shape, parts);
  if (!leaf.enums) leaf.enums = [];
  if (!leaf.enums.some((e) => e === value || (e && e.value === value))) {
    leaf.enums.push(value);
  }
  leaf.enumSource = source;
}

function collectObjectLiteralKeys(node) {
  const keys = [];
  if (!node || !node.getProperties) return keys;
  for (const prop of node.getProperties()) {
    try {
      if (prop.getName) keys.push(prop.getName());
      else if (prop.getNameNode) keys.push(prop.getNameNode().getText());
    } catch {
      /* ignore */
    }
  }
  return keys;
}

function getPropertyAccessChain(node) {
  // Returns ['detail','foo','bar'] from detail.foo.bar (incl. optional chaining)
  const parts = [];
  let cur = node;
  while (cur) {
    const kind = cur.getKindName();
    if (kind === 'PropertyAccessExpression') {
      parts.unshift(cur.getName());
      cur = cur.getExpression();
    } else if (kind === 'ElementAccessExpression') {
      return null; // dynamic — gap
    } else if (kind === 'NonNullExpression' || kind === 'ParenthesizedExpression') {
      cur = cur.getExpression?.() || cur.getChildAtIndex?.(0);
    } else if (kind === 'Identifier') {
      parts.unshift(cur.getText());
      break;
    } else if (kind === 'ThisExpression' || kind === 'ThisKeyword') {
      parts.unshift('this');
      break;
    } else if (kind === 'CallExpression' || kind === 'AwaitExpression') {
      break;
    } else {
      break;
    }
  }
  return parts.length ? parts : null;
}

const ENVELOPE_KEYS = new Set(['code', 'message', 'msg', 'success', 'error']);

function unwrapDataPrefix(parts) {
  // res.data.foo → foo; data.foo → foo
  if (parts[0] === 'res' && parts[1] === 'data') return parts.slice(2);
  if (parts[0] === 'response' && parts[1] === 'data') return parts.slice(2);
  if (parts[0] === 'data') return parts.slice(1);
  if (parts[0] === 'result' && parts[1] === 'data') return parts.slice(2);
  return parts.slice(1); // drop root binding name
}

/** True when original access path is under an explicit response `.data` segment. */
function isUnderDataPath(parts) {
  if (!parts || !parts.length) return false;
  if (parts[0] === 'data') return true;
  if (parts[0] === 'res' && parts[1] === 'data') return true;
  if (parts[0] === 'response' && parts[1] === 'data') return true;
  if (parts[0] === 'result' && parts[1] === 'data') return true;
  return false;
}

/**
 * Reject envelope keys at shape root unless the source path was under `.data`.
 * Prevents `res.code` → shape.code pollution while allowing `res.data.code`.
 */
function shouldRejectEnvelopeField(fullPath, shapePath) {
  if (!shapePath || !shapePath.length) return false;
  if (!ENVELOPE_KEYS.has(shapePath[0])) return false;
  return !isUnderDataPath(fullPath);
}

/**
 * Register a receiver by its definition name node (Identifier on
 * BindingElement / Parameter / VariableDeclaration). Also stores the parent
 * declaration so getDefinitionNodes() hits match either form.
 * @param {Set<object>} receiverDefs
 * @param {object} nameNode
 */
function registerReceiver(receiverDefs, nameNode) {
  if (!nameNode || !receiverDefs) return;
  try {
    receiverDefs.add(nameNode);
    const parent = nameNode.getParent?.();
    if (parent) {
      const kind = parent.getKindName();
      if (
        kind === 'BindingElement' ||
        kind === 'Parameter' ||
        kind === 'VariableDeclaration'
      ) {
        receiverDefs.add(parent);
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * True if identifier's definition nodes intersect registered receivers.
 * Same textual name with a different definition (e.g. useState `data` vs
 * `.then(({ data })`) never matches.
 */
function isRegisteredReceiver(idNode, receiverDefs) {
  if (!idNode || !receiverDefs || !receiverDefs.size) return false;
  if (idNode.getKindName() !== 'Identifier') return false;
  try {
    if (receiverDefs.has(idNode)) return true;
    const defs = idNode.getDefinitionNodes?.() || [];
    for (const d of defs) {
      if (receiverDefs.has(d)) return true;
      if (d.getNameNode) {
        const nn = d.getNameNode();
        if (nn && receiverDefs.has(nn)) return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Root Identifier of a PropertyAccessExpression chain, or null. */
function getPropertyAccessRootIdentifier(node) {
  let cur = node;
  while (cur) {
    const kind = cur.getKindName();
    if (kind === 'PropertyAccessExpression') {
      cur = cur.getExpression();
    } else if (kind === 'Identifier') {
      return cur;
    } else if (kind === 'ThisExpression' || kind === 'ThisKeyword') {
      return null; // this.foo — use chain alias, not identifier root
    } else {
      return null;
    }
  }
  return null;
}

/**
 * Extract receiver defs + shape fields from a .then() callback parameter.
 * Handles: (res) => ...  and  ({ data }) => ...  and  ({ data: { x } }) => ...
 */
function collectBindingFromParam(param, receiverDefs, shape, responsePaths) {
  try {
    const nameNode = param.getNameNode();
    if (!nameNode) return;
    if (nameNode.getKindName() === 'Identifier') {
      registerReceiver(receiverDefs, nameNode);
      return;
    }
    if (nameNode.getKindName() === 'ObjectBindingPattern') {
      for (const be of nameNode.getElements()) {
        collectBindingElement(be, [], receiverDefs, shape, responsePaths);
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Process one BindingElement at a given shape-path prefix.
 * Registers destructured API fields in the shape.
 * Only envelope bindings (e.g. `{ data }` / `{ data: payload }` where unwrap yields
 * empty path) become receivers — leaf fields like `city_id` must NOT, or UI renames
 * (setData({ cityId })) get confused with response roots.
 */
function collectBindingElement(be, prefixPath, receiverDefs, shape, responsePaths) {
  try {
    if (be.getKindName() !== 'BindingElement') return;
    const propNameNode = be.getPropertyNameNode();
    const boundNode = be.getNameNode();
    // Property name from source object; falls back to bound name when shorthand.
    const propName = propNameNode ? propNameNode.getText() : boundNode?.getText();
    if (!propName) return;
    const fullPath = [...prefixPath, propName];
    // Register in shape (unwrap data-prefix convention: shape root = response.data)
    const shapePath = unwrapDataPrefix(fullPath);
    if (shapePath.length && !shouldRejectEnvelopeField(fullPath, shapePath)) {
      ensureProp(shape, shapePath);
      responsePaths.push(shapePath.join('.'));
    }
    // Nested destructuring: { data: { x } }
    if (boundNode && boundNode.getKindName() === 'ObjectBindingPattern') {
      for (const nested of boundNode.getElements()) {
        collectBindingElement(nested, fullPath, receiverDefs, shape, responsePaths);
      }
    } else if (boundNode && boundNode.getKindName() === 'Identifier') {
      // Envelope payload only: .then(({ data }) =>) / ({ data: payload }) =>
      // Do NOT register error/code/message/success as receivers.
      const PAYLOAD = new Set(['data', 'result', 'payload']);
      if (shapePath.length === 0 && PAYLOAD.has(propName)) {
        registerReceiver(receiverDefs, boundNode);
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Resolve the receiver identifier from a VariableDeclaration initializer,
 * handling `data || {}` / `data ?? {}` fallback patterns.
 * Returns the init Identifier when it resolves to a registered receiver def.
 */
function resolveReceiverInit(init, receiverDefs) {
  if (!init) return null;
  if (init.getKindName() === 'Identifier') {
    return isRegisteredReceiver(init, receiverDefs) ? init : null;
  }
  if (init.getKindName() === 'BinaryExpression') {
    const op = init.getOperatorToken?.()?.getText();
    if (op === '||' || op === '??') {
      const left = init.getLeft();
      if (left.getKindName() === 'Identifier' && isRegisteredReceiver(left, receiverDefs)) {
        return left;
      }
    }
  }
  return null;
}

/**
 * Walk projectDir for .vue files (excluding node_modules, tests, etc.).
 */
function walkVue(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const SKIP = new Set([
    'node_modules', 'dist', 'build', '.git', 'coverage', '.next', 'vendor', '.data', '__tests__',
  ]);
  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.name !== '.env') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP.has(ent.name)) continue;
      walkVue(full, out);
    } else if (path.extname(ent.name) === '.vue') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Evidence file paths from an API (strip :line).
 * @param {object} api
 * @returns {string[]}
 */
function evidenceRelPaths(api) {
  const raw = [...(api.evidences || []), api.evidence].filter(Boolean);
  return raw.map((e) =>
    String(e)
      .split(':')[0]
      .replace(/\\/g, '/'),
  );
}

/**
 * Absolute decl file → project-relative posix path.
 * @param {object} decl
 * @param {string} projectDir
 */
function declRelPath(decl, projectDir) {
  try {
    const abs = decl.getSourceFile().getFilePath().replace(/\\/g, '/');
    return path.relative(projectDir, abs).replace(/\\/g, '/');
  } catch {
    return '';
  }
}

/**
 * Whether API evidence points at this declaration's defining module.
 * Prevents same-named exports in different services from sharing usage-io.
 * @param {object} api
 * @param {object} decl
 * @param {string} projectDir
 */
function apiBelongsToDecl(api, decl, projectDir) {
  const declRel = declRelPath(decl, projectDir);
  if (!declRel) return false;
  const declBase = path.posix.basename(declRel);
  const declDir = path.posix.dirname(declRel);
  for (const e of evidenceRelPaths(api)) {
    const eNorm = e.replace(/^\.\//, '');
    if (eNorm === declRel || eNorm.endsWith('/' + declRel) || declRel.endsWith(eNorm)) {
      return true;
    }
    // evidence may be `src/services/foo/index.tsx` vs decl same
    if (declDir !== '.' && (eNorm.includes(declDir) || declRel.includes(eNorm.replace(/\/[^/]+$/, '')))) {
      if (eNorm.endsWith(declBase) || eNorm.includes(declDir + '/')) return true;
    }
  }
  return false;
}

/**
 * Module path fragments for scoping import-name fallback (e.g. rejectReason).
 * @param {object} decl
 * @param {string} projectDir
 * @returns {string[]}
 */
function declModuleHints(decl, projectDir) {
  const rel = declRelPath(decl, projectDir);
  if (!rel) return [];
  const noExt = rel.replace(/\.[^.]+$/, '');
  const parts = noExt.split('/').filter(Boolean);
  const hints = [];
  if (parts.length >= 2) hints.push(parts.slice(-2).join('/'));
  if (parts.length >= 1) {
    const folder = parts[parts.length - 1] === 'index' ? parts[parts.length - 2] : parts[parts.length - 1];
    if (folder) hints.push(folder);
  }
  return [...new Set(hints.filter(Boolean))];
}

/**
 * Collect local binding names for `exportName` from import { ... } in a source file.
 * @param {object} sf - ts-morph SourceFile
 * @param {string} exportName
 * @param {string[]} [moduleHints] - if set, only imports whose specifier contains a hint
 * @returns {Set<string>}
 */
function collectImportLocalNames(sf, exportName, moduleHints) {
  const locals = new Set();
  const hints = moduleHints?.length ? moduleHints : null;
  function specOk(spec) {
    if (!hints) return true;
    const s = String(spec || '');
    return hints.some((h) => s.includes(h));
  }
  try {
    for (const imp of sf.getImportDeclarations()) {
      const spec = imp.getModuleSpecifierValue?.() || '';
      if (!specOk(spec)) continue;
      for (const n of imp.getNamedImports()) {
        if (n.getName() === exportName) {
          locals.add(n.getAliasNode()?.getText() || n.getName());
        }
      }
    }
  } catch {
    /* ignore */
  }
  // Text fallback when ts-morph named imports fail on odd syntax
  if (locals.size === 0) {
    const text = sf.getFullText();
    const re = /import\s*\{([^}]+)\}\s*from\s*['"`]([^'"`]+)['"`]/g;
    let m;
    while ((m = re.exec(text))) {
      if (!specOk(m[2])) continue;
      const specs = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      for (const spec of specs) {
        const parts = spec.split(/\s+as\s+/);
        const imported = parts[0].trim();
        const local = (parts[1] || parts[0]).trim();
        if (imported === exportName && /^[A-Za-z_$][\w$]*$/.test(local)) {
          locals.add(local);
        }
      }
    }
  }
  return locals;
}

/**
 * Deep-merge response shapes (union props / item props; prefer array over unknown).
 * @param {object} into
 * @param {object} from
 */
function mergeResponseShapes(into, from) {
  if (!from) return into;
  if (!into) return JSON.parse(JSON.stringify(from));
  if (from.type === 'array' && into.type !== 'array') {
    into.type = 'array';
    into.item = into.item || { type: 'object', props: {} };
  }
  if (from.item) {
    if (!into.item) into.item = { type: 'object', props: {} };
    mergeResponseShapes(into.item, from.item);
  }
  if (from.props) {
    if (!into.props) into.props = {};
    for (const [k, v] of Object.entries(from.props)) {
      if (!into.props[k]) {
        into.props[k] = JSON.parse(JSON.stringify(v));
      } else {
        mergeResponseShapes(into.props[k], v);
      }
    }
  }
  if (from.enums?.length) {
    if (!into.enums) into.enums = [];
    for (const e of from.enums) {
      if (!into.enums.some((x) => x === e || (x && e && x.value === e.value))) {
        into.enums.push(e);
      }
    }
  }
  if (into.type === 'unknown' && from.type && from.type !== 'unknown') {
    into.type = from.type;
  }
  return into;
}

/**
 * Find CallExpressions for exportName via import-name matching.
 * @param {string[]} [moduleHints] - scope imports to the defining service module
 * @returns {Array<{ call: object, sf: object, ref: object }>}
 */
function findImportNameCallExpressions(sourceFiles, exportName, SyntaxKind, moduleHints) {
  const out = [];
  for (const sf of sourceFiles) {
    const text = sf.getFullText();
    if (!text.includes(exportName)) continue;
    const locals = collectImportLocalNames(sf, exportName, moduleHints);
    /** @type {Set<string>} namespace / default import local names */
    const namespaces = new Set();
    try {
      for (const imp of sf.getImportDeclarations()) {
        const ns = imp.getNamespaceImport?.();
        if (ns) namespaces.add(ns.getText());
        const def = imp.getDefaultImport?.();
        if (def) namespaces.add(def.getText());
      }
    } catch {
      /* ignore */
    }
    try {
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = call.getExpression();
        if (!expr) continue;
        if (
          expr.getKindName() === 'Identifier' &&
          locals.has(expr.getText())
        ) {
          out.push({ call, sf, ref: expr });
          continue;
        }
        // import * as svc / import svc from → svc.exportName(
        if (
          expr.getKindName() === 'PropertyAccessExpression' &&
          expr.getName() === exportName
        ) {
          const obj = expr.getExpression();
          if (
            obj?.getKindName() === 'Identifier' &&
            namespaces.has(obj.getText())
          ) {
            out.push({ call, sf, ref: expr });
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * From assignment `this.a.b = res.data.x` / `obj.y = data.z`, collect shape fields
 * when RHS chains through a registered receiver. Also handles `res && res.data`.
 */
function collectAssignmentShapes(sf, SyntaxKind, receiverDefs, shape, responsePaths) {
  try {
    for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      const op = bin.getOperatorToken()?.getText?.();
      if (op !== '=') continue;
      const right = bin.getRight();
      if (!right) continue;
      for (const pa of findPropertyAccessesInExpr(right, SyntaxKind)) {
        const chain = getPropertyAccessChain(pa);
        const rootId = getPropertyAccessRootIdentifier(pa);
        if (!chain || !rootId || !isRegisteredReceiver(rootId, receiverDefs)) continue;
        const rest = unwrapDataPrefix(chain);
        if (!rest.length) continue;
        if (shouldRejectEnvelopeField(chain, rest)) continue;
        const copy = [...rest];
        if (['map', 'filter', 'forEach', 'length', 'find'].includes(copy[copy.length - 1])) {
          copy.pop();
          if (copy.length) {
            const leaf = ensureProp(shape, copy);
            leaf.type = 'array';
            if (!leaf.item) leaf.item = { type: 'object', props: {} };
          } else {
            markShapeAsArray(shape);
          }
        } else {
          ensureProp(shape, copy);
          responsePaths.push(copy.join('.'));
        }
      }
    }
  } catch {
    /* ignore */
  }
}

/** Collect PropertyAccessExpression nodes under expr, descending through &&/||/??/(). */
function findPropertyAccessesInExpr(expr, SyntaxKind) {
  const out = [];
  if (!expr) return out;
  const kind = expr.getKindName();
  if (kind === 'PropertyAccessExpression') {
    out.push(expr);
    return out;
  }
  if (kind === 'BinaryExpression') {
    const op = expr.getOperatorToken?.()?.getText?.();
    if (op === '&&' || op === '||' || op === '??') {
      out.push(...findPropertyAccessesInExpr(expr.getLeft(), SyntaxKind));
      out.push(...findPropertyAccessesInExpr(expr.getRight(), SyntaxKind));
    }
    return out;
  }
  if (
    kind === 'ParenthesizedExpression' ||
    kind === 'AwaitExpression' ||
    kind === 'NonNullExpression'
  ) {
    return findPropertyAccessesInExpr(expr.getExpression?.(), SyntaxKind);
  }
  return out;
}

function markShapeAsArray(shape) {
  if (!shape || typeof shape !== 'object') return;
  shape.type = 'array';
  if (!shape.item) shape.item = { type: 'object', props: {} };
  if (!shape.item.props) shape.item.props = {};
}

/**
 * @param {string} projectDir
 * @param {Array} apis
 * @param {object} [opts]
 * @param {object} [opts.inferCfg]
 */
function enrichApisWithUsageIo(projectDir, apis, opts = {}) {
  let Project;
  let SyntaxKind;
  let ScriptTarget;
  let ModuleKind;
  let ModuleResolutionKind;
  try {
    ({ Project, SyntaxKind, ScriptTarget, ModuleKind, ModuleResolutionKind } =
      require('ts-morph'));
  } catch (e) {
    throw new Error(`ts-morph not installed: ${e.message}`);
  }

  const { loadInferConfig } = require('../lib/infer/load-infer-config');
  const { resolveCompilerPathOptions } = require('../lib/infer/path-aliases');
  const inferCfg = opts.inferCfg || loadInferConfig(projectDir);
  const pathOpts = resolveCompilerPathOptions(projectDir, inferCfg);

  const tsconfig = path.join(projectDir, 'tsconfig.json');
  const jsconfig = path.join(projectDir, 'jsconfig.json');
  const hasTsConfig = fs.existsSync(tsconfig);
  const hasJsConfig = fs.existsSync(jsconfig);

  const sharedCompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    baseUrl: pathOpts.baseUrl,
    paths: pathOpts.paths,
  };

  const project = hasTsConfig
    ? new Project({
        tsConfigFilePath: tsconfig,
        skipAddingFilesFromTsConfig: false,
        compilerOptions: sharedCompilerOptions,
      })
    : hasJsConfig
      ? new Project({
          tsConfigFilePath: jsconfig,
          skipAddingFilesFromTsConfig: false,
          compilerOptions: sharedCompilerOptions,
        })
      : new Project({
          compilerOptions: {
            ...sharedCompilerOptions,
            jsx: 2, // JsxEmit.React
            target: ScriptTarget.ES2020,
            module: ModuleKind.ESNext,
            moduleResolution: ModuleResolutionKind.NodeJs,
          },
        });

  if (!hasTsConfig && !hasJsConfig) {
    const src = path.join(projectDir, 'src');
    if (fs.existsSync(src)) {
      project.addSourceFilesAtPaths([
        `${src}/**/*.{ts,tsx,js,jsx}`,
        `!**/node_modules/**`,
        `!**/*.test.*`,
        `!**/*.spec.*`,
      ]);
    }
  }

  // Add .vue script blocks as virtual source files so ts-morph can resolve
  // references across service ↔ page boundaries within the same Project.
  const { extractVueScriptBlocks, virtualScriptPath } = require('../lib/vue-script');
  const vueFiles = walkVue(projectDir);
  for (const vueFile of vueFiles) {
    let vueContent;
    try {
      vueContent = fs.readFileSync(vueFile, 'utf8');
    } catch {
      continue;
    }
    const blocks = extractVueScriptBlocks(vueContent);
    const rel = path.relative(projectDir, vueFile).replace(/\\/g, '/');
    blocks.forEach((blk, i) => {
      if (!blk.content || !blk.content.trim()) return;
      const vPath = path.join(projectDir, virtualScriptPath(rel, i, blk.lang));
      try {
        project.createSourceFile(vPath, blk.content, { overwrite: true });
      } catch {
        /* ignore duplicate */
      }
    });
  }

  // Index export name → api keys
  const exportToApis = new Map();
  for (const api of apis) {
    const hints = api.exportHints || (api.exportHint ? [api.exportHint] : []);
    for (const h of hints) {
      if (!exportToApis.has(h)) exportToApis.set(h, []);
      exportToApis.get(h).push(api);
    }
  }

  // Also map by scanning source for export const X matching path in nearby createRequest
  // Already have exportHint from infer

  const sourceFiles = project.getSourceFiles().filter((sf) => {
    const fp = sf.getFilePath();
    if (fp.includes(`${path.sep}node_modules${path.sep}`)) return false;
    if (/\.(test|spec)\./.test(fp)) return false;
    // Include src/ files and virtual .vue script files (path contains .vue.__script)
    if (fp.includes('.vue.__script')) return true;
    return fp.includes(`${path.sep}src${path.sep}`);
  });

  // Build declaration map: export name → all defining Nodes (same name in different modules)
  /** @type {Map<string, object[]>} */
  const exportDeclsByName = new Map();
  for (const sf of sourceFiles) {
    for (const entry of sf.getExportedDeclarations()) {
      const [name, decls] = entry;
      if (!exportToApis.has(name)) continue;
      if (!exportDeclsByName.has(name)) exportDeclsByName.set(name, []);
      const bucket = exportDeclsByName.get(name);
      for (const d of decls) {
        if (d && !bucket.includes(d)) bucket.push(d);
      }
    }
  }

  // Fallback: exportHint may be a local binding used in `export default { name }`
  // without a named export — resolve VariableDeclaration / FunctionDeclaration by name.
  for (const name of exportToApis.keys()) {
    if (exportDeclsByName.has(name) && exportDeclsByName.get(name).length) continue;
    for (const sf of sourceFiles) {
      let found = null;
      for (const vd of sf.getVariableDeclarations()) {
        if (vd.getName() === name) {
          found = vd;
          break;
        }
      }
      if (!found) {
        for (const fn of sf.getFunctions()) {
          if (fn.getName() === name) {
            found = fn;
            break;
          }
        }
      }
      if (found) {
        if (!exportDeclsByName.has(name)) exportDeclsByName.set(name, []);
        exportDeclsByName.get(name).push(found);
        break;
      }
    }
  }

  /** @type {Array<[string, object]>} */
  const exportDeclPairs = [];
  for (const [name, decls] of exportDeclsByName) {
    for (const d of decls) exportDeclPairs.push([name, d]);
  }

  let processed = 0;
  for (const [exportName, decl] of exportDeclPairs) {
    const allNamedApis = exportToApis.get(exportName) || [];
    const declsForName = exportDeclsByName.get(exportName) || [];
    let relatedApis = allNamedApis.filter((api) =>
      apiBelongsToDecl(api, decl, projectDir),
    );
    // Sole declaration for this name owns all APIs with that exportHint
    if (!relatedApis.length && declsForName.length === 1) {
      relatedApis = allNamedApis;
    }
    if (!relatedApis.length) continue;

    const shape = emptyShape();
    const queryKeys = new Set();
    const bodyKeys = new Set();
    const responsePaths = [];
    const enums = [];
    const gaps = new Set();
    /** @type {Map<string, Set<object>>} filePath → response receiver definition nodes */
    const receiversByFile = new Map();
    let hasCall = false;
    let dynamicKeyRisk = false;

    function fileReceivers(sf) {
      const fp = sf.getFilePath();
      if (!receiversByFile.has(fp)) receiversByFile.set(fp, new Set());
      return receiversByFile.get(fp);
    }

    function registerAssignmentReceiver(localReceivers, leftOrDecl) {
      if (!leftOrDecl) return;
      try {
        if (leftOrDecl.getKindName() === 'VariableDeclaration') {
          const nn = leftOrDecl.getNameNode();
          if (!nn) return;
          // const data = await api()
          if (nn.getKindName() === 'Identifier') {
            registerReceiver(localReceivers, nn);
            return;
          }
          // const { error, data } = await api()  — envelope BindingElements
          if (nn.getKindName() === 'ObjectBindingPattern') {
            for (const be of nn.getElements()) {
              collectBindingElement(be, [], localReceivers, shape, responsePaths);
            }
          }
          return;
        }
        if (leftOrDecl.getKindName() === 'Identifier') {
          // Always register the assignment target itself (covers `let res; res = await api()`)
          registerReceiver(localReceivers, leftOrDecl);
          try {
            const defs = leftOrDecl.getDefinitionNodes?.() || [];
            for (const d of defs) {
              if (d.getNameNode) {
                const nn = d.getNameNode();
                if (nn && nn.getKindName() === 'Identifier') {
                  registerReceiver(localReceivers, nn);
                } else {
                  registerReceiver(localReceivers, d);
                }
              } else {
                registerReceiver(localReceivers, d);
              }
            }
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }

    let refs = [];
    try {
      if (typeof decl.findReferencesAsNodes === 'function') {
        refs = decl.findReferencesAsNodes();
      } else if (decl.getNameNode) {
        const nameNode = decl.getNameNode();
        if (nameNode && nameNode.findReferencesAsNodes) {
          refs = nameNode.findReferencesAsNodes();
        }
      }
    } catch {
      gaps.add('ref_lookup_failed');
    }

    function processCallExpression(call, refSf) {
      if (!call || call.getKindName() !== 'CallExpression') return;
      hasCall = true;
      const localReceivers = fileReceivers(refSf);
      const args = call.getArguments();
      for (const arg of args) {
        if (arg.getKindName() === 'ObjectLiteralExpression') {
          for (const k of collectObjectLiteralKeys(arg)) {
            const method = (relatedApis[0].method || 'GET').toUpperCase();
            if (method === 'GET' || method === 'DELETE') queryKeys.add(k);
            else bodyKeys.add(k);
          }
        } else if (arg.getKindName() === 'Identifier') {
          try {
            const defs = arg.getDefinitionNodes?.() || [];
            for (const d of defs) {
              if (d.getKindName() === 'VariableDeclaration') {
                const i = d.getInitializer();
                if (i && i.getKindName() === 'ObjectLiteralExpression') {
                  for (const k of collectObjectLiteralKeys(i)) {
                    const method = (relatedApis[0].method || 'GET').toUpperCase();
                    if (method === 'GET') queryKeys.add(k);
                    else bodyKeys.add(k);
                  }
                }
              }
            }
          } catch {
            /* ignore */
          }
        } else if (arg.getKindName() === 'ElementAccessExpression') {
          dynamicKeyRisk = true;
          gaps.add('dynamic_key');
        }
      }

      const callParent = call.getParent();
      if (
        callParent &&
        callParent.getKindName() === 'PropertyAccessExpression' &&
        callParent.getName() === 'then'
      ) {
        const thenCall = callParent.getParent();
        if (thenCall && thenCall.getKindName() === 'CallExpression') {
          const cb = thenCall.getArguments()[0];
          if (
            cb &&
            (cb.getKindName() === 'ArrowFunction' ||
              cb.getKindName() === 'FunctionExpression')
          ) {
            const params = cb.getParameters();
            if (params[0]) {
              collectBindingFromParam(
                params[0],
                localReceivers,
                shape,
                responsePaths,
              );
            }
          }
        }
      }

      let walk = call.getParent();
      if (walk && walk.getKindName() === 'AwaitExpression') walk = walk.getParent();
      if (walk && walk.getKindName() === 'BinaryExpression') {
        const left = walk.getLeft?.() || walk.getChildren()[0];
        registerAssignmentReceiver(localReceivers, left);
      }
      if (walk && walk.getKindName() === 'VariableDeclaration') {
        registerAssignmentReceiver(localReceivers, walk);
      }
    }

    for (const ref of refs) {
      const parent = ref.getParent();
      if (!parent) continue;
      let call = parent;
      if (call.getKindName() === 'PropertyAccessExpression') {
        call = call.getParent();
      }
      if (call && call.getKindName() === 'CallExpression') {
        processCallExpression(call, ref.getSourceFile());
      }
    }

    const moduleHints = declModuleHints(decl, projectDir);
    const exportKey = (() => {
      const { makeExportKey } = require('../lib/infer/shape-json-schema');
      return makeExportKey(declRelPath(decl, projectDir), exportName);
    })();
    for (const api of relatedApis) {
      if (exportKey) api.exportKey = api.exportKey || exportKey;
    }

    // Import-name fallback when @/ ~/ aliases break findReferences
    if (!hasCall) {
      if (!moduleHints.length) {
        gaps.add('bind_ambiguous');
      } else {
        const fallback = findImportNameCallExpressions(
          sourceFiles,
          exportName,
          SyntaxKind,
          moduleHints,
        );
        for (const { call, sf } of fallback) {
          processCallExpression(call, sf);
        }
      }
    }

    // Scan files that reference the export — receivers are per-file to avoid
    // FileA `.then(({ data })` enabling FileB UI `data.cityId` pollution.
    const importFiles = new Set();
    for (const ref of refs) {
      importFiles.add(ref.getSourceFile());
    }
    if (hasCall) {
      for (const sf of sourceFiles) {
        if (collectImportLocalNames(sf, exportName, moduleHints).size) {
          importFiles.add(sf);
        }
      }
    }

    for (const sf of importFiles) {
      const text = sf.getFullText();
      if (!text.includes(exportName)) continue;
      const receiverDefs = fileReceivers(sf);

      // Destructuring first so nested receivers exist before PA scan
      // (const { data } = res → data?.total)
      for (const vd of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const nameNode = vd.getNameNode();
        if (!nameNode || nameNode.getKindName() !== 'ObjectBindingPattern') continue;
        const init = vd.getInitializer();
        const srcId = resolveReceiverInit(init, receiverDefs);
        if (!srcId) continue;
        const srcName = srcId.getText();
        for (const be of nameNode.getElements()) {
          collectBindingElement(be, [srcName], receiverDefs, shape, responsePaths);
        }
      }

      // Collect property accesses — match by definition node, not name string
      for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const chain = getPropertyAccessChain(pa);
        if (!chain || chain.length < 2) continue;
        const rootId = getPropertyAccessRootIdentifier(pa);
        if (!rootId || !isRegisteredReceiver(rootId, receiverDefs)) continue;

        // Skip .then .catch .data alone
        const rest = unwrapDataPrefix(chain);
        if (!rest.length) continue;
        if (rest[0] === 'then' || rest[0] === 'catch' || rest[0] === 'finally') {
          continue;
        }
        if (shouldRejectEnvelopeField(chain, rest)) continue;

        // Mark array if .map/.length/.filter on last-1
        const copy = [...rest];
        if (['map', 'filter', 'forEach', 'length', 'find'].includes(copy[copy.length - 1])) {
          copy.pop();
          if (copy.length) {
            const leaf = ensureProp(shape, copy);
            leaf.type = 'array';
            if (!leaf.item) leaf.item = { type: 'object', props: {} };
          }
        } else {
          ensureProp(shape, copy);
          responsePaths.push(copy.join('.'));
        }

        // Element access sibling — check parent
        const grand = pa.getParent();
        if (grand && grand.getKindName() === 'ElementAccessExpression') {
          dynamicKeyRisk = true;
          gaps.add('dynamic_key');
        }
      }

      // this.foo = res.data.bar — reinforce field collection from assignments
      collectAssignmentShapes(sf, SyntaxKind, receiverDefs, shape, responsePaths);
      // L3 BindingGraph: alias propagation + array/item from script AST
      const {
        applyScriptBindingGraph,
        applyTemplateEvents,
      } = require('../lib/infer/script-binding');
      // Resolve an imported component name to its ts-morph SourceFile for
      // the bounded one-layer cross-file props-drill (Pass 5).
      const resolveComponentFile = (componentName) => {
        try {
          for (const imp of sf.getImportDeclarations()) {
            const named = imp.getNamedImports?.() || [];
            const matchesNamed = named.some((n) => n.getName?.() === componentName);
            const defaultImp = imp.getDefaultImport?.();
            const matchesDefault = !!defaultImp && defaultImp.getText?.() === componentName;
            if (!matchesNamed && !matchesDefault) continue;
            const target = imp.getModuleSpecifierSourceFile?.();
            if (target) return target;
          }
        } catch {
          /* ignore */
        }
        return null;
      };
      const graph = applyScriptBindingGraph({
        sf,
        SyntaxKind,
        receiverDefs,
        shape,
        responsePaths,
        getPropertyAccessChain,
        getPropertyAccessRootIdentifier,
        isRegisteredReceiver,
        unwrapDataPrefix,
        isUnderDataPath,
        shouldRejectEnvelopeField,
        registerReceiver,
        fieldSources: inferCfg.declarativeFieldSources || [],
        resolveComponentFile,
      });
      // L2 Vue template AST → same BindingGraph (when virtual script from .vue)
      const { vuePathFromVirtualScript } = require('../lib/vue-script');
      const {
        collectVueTemplateBindingEvents,
      } = require('../lib/infer/vue-template-ast');
      const vueAbs = vuePathFromVirtualScript(sf.getFilePath());
      if (vueAbs && fs.existsSync(vueAbs)) {
        try {
          const vueSrc = fs.readFileSync(vueAbs, 'utf8');
          const tplEvents = collectVueTemplateBindingEvents(vueSrc);
          applyTemplateEvents(graph, tplEvents);
        } catch {
          /* ignore template parse errors */
        }
      }

      // Enums: status === 1, detail.status === 'x'
      for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        try {
          const op = bin.getOperatorToken().getText();
          if (!['===', '!==', '==', '!='].includes(op)) continue;
          const left = bin.getLeft();
          const right = bin.getRight();
          let fieldPath = null;
          let lit = null;
          if (left.getKindName() === 'PropertyAccessExpression') {
            const chain = getPropertyAccessChain(left);
            const rootId = getPropertyAccessRootIdentifier(left);
            if (chain && rootId && isRegisteredReceiver(rootId, receiverDefs)) {
              const rest = unwrapDataPrefix(chain);
              if (rest.length && !shouldRejectEnvelopeField(chain, rest)) {
                fieldPath = rest.join('.');
              }
            }
            if (
              right.getKindName() === 'StringLiteral' ||
              right.getKindName() === 'NumericLiteral' ||
              right.getKindName() === 'TrueKeyword' ||
              right.getKindName() === 'FalseKeyword'
            ) {
              lit = right.getLiteralValue?.() ?? JSON.parse(right.getText());
            }
          }
          if (fieldPath && lit !== null && lit !== undefined) {
            addEnum(shape, fieldPath, lit, 'comparison');
            enums.push({ field: fieldPath, values: [lit], source: 'comparison' });
          }
        } catch {
          /* ignore */
        }
      }

      // switch(detail.status)
      for (const sw of sf.getDescendantsOfKind(SyntaxKind.SwitchStatement)) {
        try {
          const expr = sw.getExpression();
          if (expr.getKindName() !== 'PropertyAccessExpression') continue;
          const chain = getPropertyAccessChain(expr);
          const rootId = getPropertyAccessRootIdentifier(expr);
          if (!chain || !rootId || !isRegisteredReceiver(rootId, receiverDefs)) continue;
          const rest = unwrapDataPrefix(chain);
          if (!rest.length || shouldRejectEnvelopeField(chain, rest)) continue;
          const fieldPath = rest.join('.');
          for (const clause of sw.getClauses()) {
            if (clause.getKindName() !== 'CaseClause') continue;
            const ce = clause.getExpression();
            if (!ce) continue;
            if (
              ce.getKindName() === 'StringLiteral' ||
              ce.getKindName() === 'NumericLiteral'
            ) {
              const lit = ce.getLiteralValue?.() ?? JSON.parse(ce.getText());
              addEnum(shape, fieldPath, lit, 'switch');
              enums.push({ field: fieldPath, values: [lit], source: 'switch' });
            }
          }
        } catch {
          /* ignore */
        }
      }

      // Shallow props: <Child detail={detail} /> or data={detail}
      for (const jsx of sf.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
        try {
          const name = jsx.getNameNode?.()?.getText?.() || jsx.getName?.();
          const init = jsx.getInitializer();
          if (!init) continue;
          const expr = init.getExpression?.() || init;
          if (expr && expr.getKindName() === 'Identifier') {
            if (
              isRegisteredReceiver(expr, receiverDefs) &&
              (name === expr.getText() || name === 'data' || name === 'detail' || name === 'info')
            ) {
              gaps.add('props_shallow_only');
            }
          }
        } catch {
          /* ignore */
        }
      }
    }

    if (!hasCall) {
      gaps.add('no_callsite');
    }
    const hasObjProps = Object.keys(shape.props || {}).length > 0;
    const hasItemProps =
      shape.type === 'array' && Object.keys(shape.item?.props || {}).length > 0;
    const isArrayPayload = shape.type === 'array';
    if (
      !responsePaths.length &&
      !hasObjProps &&
      !hasItemProps &&
      !isArrayPayload
    ) {
      gaps.add('no_property_access');
    } else {
      gaps.delete('no_property_access');
    }
    // Layer gate: callsite exists but shape empty → TRACE_EMPTY
    if (
      hasCall &&
      !hasObjProps &&
      !hasItemProps &&
      !isArrayPayload &&
      !responsePaths.length
    ) {
      gaps.add('TRACE_EMPTY');
    }

    const layer = {
      discover: 'ok',
      bind: gaps.has('bind_ambiguous')
        ? 'ambiguous'
        : gaps.has('no_callsite')
          ? 'no_callsite'
          : 'ok',
      trace: gaps.has('TRACE_EMPTY') || gaps.has('no_property_access')
        ? 'empty'
        : 'ok',
      materialize: 'pending',
    };

    // Merge into related APIs (union when multiple decls enrich same API)
    for (const api of relatedApis) {
      api.queryHints = [
        ...new Set([...(api.queryHints || []), ...queryKeys]),
      ];
      api.bodyHints = [...new Set([...(api.bodyHints || []), ...bodyKeys])];
      api.responseShape = mergeResponseShapes(api.responseShape || emptyShape(), shape);
      api.responseHints = [
        ...Object.keys(api.responseShape.props || {}),
        ...(api.responseShape.type === 'array'
          ? Object.keys(api.responseShape.item?.props || {}).map((k) => `[].${k}`)
          : []),
      ];
      const prevGaps = new Set(api.coverage?.gaps || []);
      for (const g of gaps) prevGaps.add(g);
      const mergedHasShape =
        responsePaths.length > 0 ||
        Object.keys(api.responseShape.props || {}).length > 0 ||
        (api.responseShape.type === 'array' &&
          Object.keys(api.responseShape.item?.props || {}).length > 0) ||
        api.responseShape.type === 'array';
      // Drop stale emptiness gaps if merged shape / this pass has signal
      if (mergedHasShape) {
        prevGaps.delete('no_property_access');
        prevGaps.delete('TRACE_EMPTY');
        // Keep no_callsite only when NO export for this API has a callsite yet
        if (hasCall || api.coverage?.layer?.bind === 'ok') {
          prevGaps.delete('no_callsite');
        }
      }
      // Prefer export with callsite + shape over unused twin on same path
      if (
        hasCall &&
        (responsePaths.length ||
          hasObjProps ||
          hasItemProps ||
          isArrayPayload)
      ) {
        api.exportHint = exportName;
        if (exportKey) api.exportKey = exportKey;
      } else if (!api.exportHint) {
        api.exportHint = exportName;
        if (exportKey) api.exportKey = api.exportKey || exportKey;
      }
      api.coverage = {
        request: {
          keysFound: [...new Set([...(api.coverage?.request?.keysFound || []), ...queryKeys, ...bodyKeys])],
          dynamicKeyRisk:
            Boolean(api.coverage?.request?.dynamicKeyRisk) || dynamicKeyRisk,
          confidence:
            queryKeys.size || bodyKeys.size || api.coverage?.request?.keysFound?.length
              ? 'high'
              : prevGaps.has('no_callsite')
                ? 'low'
                : 'medium',
        },
        response: {
          pathsFound: [
            ...new Set([
              ...(api.coverage?.response?.pathsFound || []),
              ...responsePaths,
            ]),
          ],
          confidence:
            responsePaths.length ||
            api.coverage?.response?.pathsFound?.length ||
            (api.responseShape.type === 'array' &&
              Object.keys(api.responseShape.item?.props || {}).length > 0)
              ? 'high'
              : prevGaps.has('no_property_access')
                ? 'low'
                : 'medium',
        },
        enums: mergeEnumEntries([
          ...(api.coverage?.enums || []),
          ...enums,
        ]),
        gaps: [...prevGaps],
        layer: api.coverage?.layer && api.coverage.layer.trace === 'ok'
          ? api.coverage.layer
          : layer,
      };
      api.confidence =
        api.coverage.response.confidence === 'high' ||
        api.coverage.request.confidence === 'high'
          ? 'high'
          : api.confidence;
    }
    processed++;
  }

  // APIs without exportHint get gap
  for (const api of apis) {
    if (!api.coverage) {
      api.coverage = {
        request: { keysFound: [], dynamicKeyRisk: false, confidence: 'low' },
        response: { pathsFound: [], confidence: 'low' },
        enums: [],
        gaps: ['no_export_symbol'],
      };
      api.responseShape = api.responseShape || emptyShape();
    }
  }

  console.log(
    `[mox] usage-io enriched ${processed}/${exportDeclPairs.length} exports (${apis.length} apis)`,
  );
  return apis;
}

function mergeEnumEntries(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.field)) {
      map.set(e.field, { field: e.field, values: [], source: e.source });
    }
    const cur = map.get(e.field);
    for (const v of e.values) {
      if (!cur.values.includes(v)) cur.values.push(v);
    }
  }
  return [...map.values()];
}

module.exports = {
  enrichApisWithUsageIo,
  emptyShape,
  ensureProp,
  collectImportLocalNames,
  findImportNameCallExpressions,
};

if (require.main === module) {
  const { inferApiUsage } = require('./infer-api-usage');
  const dir = process.argv[2] || process.cwd();
  const apis = inferApiUsage(dir, { withUsageIo: true });
  const sample = apis.filter((a) => a.responseHints?.length).slice(0, 5);
  console.log(JSON.stringify(sample, null, 2));
}
