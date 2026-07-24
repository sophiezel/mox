'use strict';

/**
 * DocFetcher: local file or MOX_DOC_FETCH_CMD → Markdown snapshot under .data/docs/.
 * Does not implement Confluence SSO; optional external command only.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { docsDir, sanitizeSlug } = require('../paths');

function isHttpUrl(raw) {
  return /^https?:\/\//i.test(String(raw || '').trim());
}

function slugFromInput(from, file) {
  const raw = String(file || from || 'doc').trim();
  if (isHttpUrl(raw)) {
    try {
      const u = new URL(raw);
      const pageId = u.searchParams.get('pageId');
      if (pageId) return sanitizeSlug(`cwiki-${pageId}`);
      return sanitizeSlug(`${u.hostname}${u.pathname}`.replace(/\//g, '-'));
    } catch {
      return sanitizeSlug(raw);
    }
  }
  return sanitizeSlug(path.basename(raw, path.extname(raw)) || 'doc');
}

function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

function wrapFrontmatter(body, meta) {
  const lines = ['---', 'doc:'];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === '') continue;
    const s = String(v).replace(/"/g, '\\"');
    lines.push(`  ${k}: "${s}"`);
  }
  lines.push('---', '', stripBom(body).replace(/^\s+/, ''));
  return `${lines.join('\n')}\n`;
}

function writeSnapshot(slug, markdown, meta) {
  const dir = path.join(docsDir(), sanitizeSlug(slug));
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(dir, 'index.md');
  const content = wrapFrontmatter(markdown, meta);
  fs.writeFileSync(indexPath, content);
  return { dir, indexPath, content };
}

/**
 * @param {{ from?: string, file?: string, projectDir?: string, env?: NodeJS.ProcessEnv, slug?: string }} opts
 * @returns {{ slug: string, indexPath: string, markdown: string, fetcher: 'file'|'cmd', meta: object }}
 */
function fetchDoc(opts = {}) {
  const env = opts.env || process.env;
  const projectDir = path.resolve(opts.projectDir || process.cwd());
  const file = opts.file || null;
  const from = opts.from || null;
  if (!file && !from) {
    throw new Error('Usage: mox import-doc --from=<url|path> or --file=<path>');
  }

  const input = file || from;
  const slug = opts.slug || slugFromInput(from || file, file);
  const fetchedAt = new Date().toISOString();

  if (!isHttpUrl(input)) {
    const abs = path.resolve(projectDir, input);
    if (!fs.existsSync(abs)) {
      throw new Error(`Doc file not found: ${abs}`);
    }
    const markdown = fs.readFileSync(abs, 'utf8');
    const meta = {
      source_path: abs,
      fetcher: 'file',
      fetched_at: fetchedAt,
    };
    const snap = writeSnapshot(slug, markdown, meta);
    return {
      slug,
      indexPath: snap.indexPath,
      markdown: snap.content,
      fetcher: 'file',
      meta,
    };
  }

  const cmdTpl = env.MOX_DOC_FETCH_CMD;
  if (!cmdTpl || !String(cmdTpl).trim()) {
    throw new Error(
      'URL import requires MOX_DOC_FETCH_CMD (placeholders: {url} {outDir}), or use --file=<local.md>',
    );
  }

  const outDir = path.join(docsDir(), sanitizeSlug(slug));
  fs.mkdirSync(outDir, { recursive: true });
  const cmd = String(cmdTpl)
    .replaceAll('{url}', input)
    .replaceAll('{outDir}', outDir);

  const result = spawnSync(cmd, {
    shell: true,
    encoding: 'utf8',
    env: { ...env },
    cwd: projectDir,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || '').trim() || `exit ${result.status}`;
    throw new Error(`MOX_DOC_FETCH_CMD failed: ${err}`);
  }

  const indexCandidate = path.join(outDir, 'index.md');
  let markdown;
  if (fs.existsSync(indexCandidate)) {
    markdown = fs.readFileSync(indexCandidate, 'utf8');
  } else if (result.stdout && String(result.stdout).trim()) {
    markdown = result.stdout;
  } else {
    throw new Error(
      'MOX_DOC_FETCH_CMD produced no Markdown (expected stdout or {outDir}/index.md)',
    );
  }

  const meta = {
    url: input,
    fetcher: 'cmd',
    fetched_at: fetchedAt,
  };
  const snap = writeSnapshot(slug, markdown, meta);
  return {
    slug,
    indexPath: snap.indexPath,
    markdown: snap.content,
    fetcher: 'cmd',
    meta,
  };
}

module.exports = {
  fetchDoc,
  slugFromInput,
  isHttpUrl,
  writeSnapshot,
  wrapFrontmatter,
};
