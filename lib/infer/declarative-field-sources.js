'use strict';

/**
 * DeclarativeFieldSource plugin registry.
 *
 * Abstracts "config-driven UI" field extraction (Table `columns[].dataIndex`,
 * Select `fieldNames`, etc.) into a pluggable, generic interface — matching by
 * JSX prop NAME, not by component library symbol. This removes the historical
 * "only recognizes antd symbols" brittleness: any component exposing
 * `dataSource` + `columns[].dataIndex` is handled, regardless of import name.
 *
 * Built-in plugins cover the two common industry patterns. Projects extend
 * via `.mox/infer.json#declarativeFieldSources` (declarative, no code):
 *
 *   "declarativeFieldSources": [
 *     { "name": "proj-datagrid", "dataSourceProp": "rows", "columnsProp": "fields", "fieldKey": "key" }
 *   ]
 *
 * The actual AST extraction still lives in script-binding.js (Pass 4), which
 * iterates `getDeclarativeFieldSources()` so project plugins are picked up.
 */

const BUILTIN_FIELD_SOURCES = [
  {
    name: 'table-columns-dataIndex',
    dataSourceProp: 'dataSource',
    columnsProp: 'columns',
    fieldKey: 'dataIndex',
    // Pure extractor for the common string-dataIndex case. Richer render()
    // extraction is layered by script-binding.js on top of this registry.
    extract: (columnsExpr, SyntaxKind) => extractDataIndexes(columnsExpr, SyntaxKind, 'dataIndex'),
  },
  {
    name: 'select-fieldNames',
    dataSourceProp: 'options',
    columnsProp: 'fieldNames',
    fieldKey: 'label', // Select fieldNames: { label, value }
    extract: (columnsExpr, SyntaxKind) => extractDataIndexes(columnsExpr, SyntaxKind, 'label'),
  },
];

const _registered = [];

function registerFieldSource(plugin) {
  if (!plugin || !plugin.name) return;
  _registered.push(plugin);
}

/**
 * Merge built-in sources with project-declared sources (from infer.json) and
 * any runtime-registered sources. Project entries with the same name override
 * built-ins; otherwise they are appended.
 */
function getDeclarativeFieldSources(projectSources) {
  const out = [];
  const byName = new Map();
  for (const p of BUILTIN_FIELD_SOURCES) {
    byName.set(p.name, { ...p });
  }
  for (const p of _registered) {
    byName.set(p.name, { ...p });
  }
  for (const p of projectSources || []) {
    if (!p || !p.name) continue;
    byName.set(p.name, {
      name: p.name,
      dataSourceProp: p.dataSourceProp || 'dataSource',
      columnsProp: p.columnsProp || 'columns',
      fieldKey: p.fieldKey || 'dataIndex',
      extract: p.extract || null,
    });
  }
  for (const p of byName.values()) out.push(p);
  return out;
}

/**
 * Pure helper: extract string `fieldKey` values from a columns-like array
 * literal node (ts-morph-shaped API). Used by built-in plugins and tests.
 * Skips `action` / `operation` (UI affordances, not data fields).
 *
 * @param {object} expr - ts-morph ArrayLiteralExpression-like node
 * @param {object} SyntaxKind - ts-morph SyntaxKind enum (or stub)
 * @param {string} [fieldKey='dataIndex']
 * @returns {string[]}
 */
function extractDataIndexes(expr, SyntaxKind, fieldKey = 'dataIndex') {
  if (!expr) return [];
  const kind = expr.getKindName?.();
  if (kind !== 'ArrayLiteralExpression') return [];
  const out = [];
  for (const el of expr.getElements()) {
    if (el.getKindName?.() !== 'ObjectLiteralExpression') continue;
    for (const prop of el.getProperties()) {
      if (prop.getKindName?.() !== 'PropertyAssignment') continue;
      const name = prop.getName?.();
      if (name !== fieldKey) continue;
      const init = prop.getInitializer?.();
      if (!init) continue;
      if (
        init.getKindName() === 'StringLiteral' ||
        init.getKindName() === 'NoSubstitutionTemplateLiteral'
      ) {
        const v = init.getLiteralValue?.() ?? init.getText()?.replace(/^['"`]|['"`]$/g, '');
        if (v && v !== 'action' && v !== 'operation') out.push(String(v));
      }
    }
  }
  return out;
}

module.exports = {
  BUILTIN_FIELD_SOURCES,
  getDeclarativeFieldSources,
  registerFieldSource,
  extractDataIndexes,
};
