'use strict';

/**
 * OpenAPI / Swagger import → classify-compatible roles for generateMocks.
 * Usage: mox import-openapi --from=./openapi.json|yaml [--task=ID]
 *
 * Phase 1.5:
 *  - Derives stubId / upstreamId / hosts[] from the spec host (same model as init),
 *    so OpenAPI stubs merge with usage-inferred stubs by stubId (OpenAPI ≥ usage).
 *  - Supports YAML specs (js-yaml) in addition to JSON.
 */

const fs = require('fs');
const path = require('path');
const {
  resolveProjectSlug,
  ensureProjectDirs,
  projectDataDir,
  stubId: makeStubId,
} = require('../lib/paths');
const { appendAudit } = require('../lib/audit');
const { writeClassifyResult } = require('./classify-requests');
const { generateMocks } = require('./generate-mock');
const { jsonSchemaToShape } = require('../lib/infer/shape-json-schema');
const {
  normalizeHostLabel,
  deriveUpstreamId,
  pickCanonicalHost,
} = require('../lib/upstream');

function schemaToShape(schema, components = {}) {
  return jsonSchemaToShape(schema, components);
}

function parseSpec(raw) {
  // Try JSON first, then YAML (js-yaml). YAML is an optional capability;
  // if js-yaml is unavailable, fall back to a clear error.
  try {
    return JSON.parse(raw);
  } catch {
    let yaml;
    try {
      yaml = require('js-yaml');
    } catch {
      throw new Error('OpenAPI YAML requires the `js-yaml` package; install it or convert to JSON');
    }
    try {
      return yaml.load(raw);
    } catch (e) {
      throw new Error(`Failed to parse OpenAPI spec (tried JSON then YAML): ${e.message}`);
    }
  }
}

function extractHost(spec) {
  if (spec.servers?.[0]?.url) {
    try {
      const u = new URL(spec.servers[0].url);
      return { host: u.host, basePath: u.pathname.replace(/\/$/, '') || '' };
    } catch {
      /* ignore */
    }
  }
  if (spec.host) {
    const scheme = (spec.schemes && spec.schemes[0]) || 'https';
    const basePath = spec.basePath || '';
    return { host: spec.host, basePath, scheme };
  }
  return { host: '_default', basePath: '' };
}

function importOpenApi(opts = {}) {
  const from = opts.from || opts['from'];
  if (!from) throw new Error('Usage: mox import-openapi --from=<openapi.json|yaml>');
  const abs = path.resolve(opts.projectDir || process.cwd(), from);
  if (!fs.existsSync(abs)) throw new Error(`OpenAPI file not found: ${abs}`);

  const raw = fs.readFileSync(abs, 'utf8');
  const spec = parseSpec(raw);

  const projectDir = path.resolve(opts.projectDir || process.cwd());
  const projectSlug = resolveProjectSlug(projectDir, opts.name);
  ensureProjectDirs(projectSlug);
  const taskId = opts.taskId || opts.task || null;
  const { host, basePath } = extractHost(spec);
  const components = spec.components || spec.definitions || {};
  const paths = spec.paths || {};
  const roles = [];

  // Derive upstream identity from the spec host (same model as init).
  const upstreamId = host && host !== '_default'
    ? (deriveUpstreamId({ hosts: [host] }) || normalizeHostLabel(host) || '_default')
    : '_default';
  const hosts = host && host !== '_default' ? [host] : [];
  const canonicalHost = hosts.length ? pickCanonicalHost(hosts, upstreamId) : null;

  for (const [p, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== 'object') continue;
    for (const [method, op] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) {
        continue;
      }
      const fullPath = `${basePath || ''}${p}`.replace(/\{[^}]+\}/g, '1') || '/';
      const success =
        op.responses?.['200'] ||
        op.responses?.['201'] ||
        op.responses?.default;
      const schema =
        success?.content?.['application/json']?.schema ||
        success?.schema ||
        null;
      // unwrap envelope data if present
      const rawShape = schemaToShape(schema, components);
      const shape = rawShape.props?.data ? rawShape.props.data : rawShape;
      const sid = makeStubId({ upstreamId, method: method.toUpperCase(), path: fullPath });
      roles.push({
        apiKey: sid,
        id: sid,
        stubId: sid,
        upstreamId,
        hosts: [...hosts],
        canonicalHost,
        method: method.toUpperCase(),
        host,
        path: fullPath,
        relatedToTask: Boolean(taskId),
        role: 'dependency',
        confidence: 'high',
        hasMock: false,
        evidences: [`openapi:${from}`],
        responseHints: Object.keys(shape.props || {}),
        queryHints: [],
        bodyHints: [],
        blocked: false,
        lastTaskId: taskId,
        responseShape: shape,
        coverage: {
          request: { keysFound: [], confidence: 'medium' },
          response: {
            pathsFound: Object.keys(shape.props || {}),
            confidence: 'high',
          },
          enums: [],
          gaps: [],
        },
        exportHint: op.operationId || null,
        source: 'openapi',
      });
    }
  }

  const classified = {
    taskId,
    roles,
    conflicts: [],
    source: 'openapi',
    from: abs,
  };
  writeClassifyResult(projectSlug, classified);

  const gen = generateMocks({
    projectSlug,
    roles,
    conflicts: [],
    taskId,
    force: Boolean(opts.force),
    merge: !opts.force,
  });

  appendAudit(projectSlug, {
    command: 'import-openapi',
    taskId,
    summary: `from=${from} roles=${roles.length} generated=${gen.generated}`,
  });

  const report = path.join(
    projectDataDir(projectSlug),
    'reports',
    `openapi-import-${Date.now()}.json`,
  );
  fs.writeFileSync(report, `${JSON.stringify({ roles: roles.length, gen }, null, 2)}\n`);
  console.log(`[mox] import-openapi roles=${roles.length} generated=${gen.generated}`);
  console.log(`[mox] report ${report}`);
  return { roles, gen, projectSlug };
}

module.exports = { importOpenApi, schemaToShape, extractHost, parseSpec };

if (require.main === module) {
  const from = process.argv.find((a) => a.startsWith('--from='))?.slice(7);
  importOpenApi({ from, projectDir: process.cwd() });
}
