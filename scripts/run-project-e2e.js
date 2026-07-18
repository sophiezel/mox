'use strict';

/**
 * Project full-chain E2E using the public CLI surface:
 *   init → start --detach → scenario/smoke → stop
 *
 * Usage:
 *   FRONTEND_DIR=/path/to/app MOCK_NAME=myapp \
 *     node scripts/run-project-e2e.js [--skip-init]
 *
 * Env:
 *   FRONTEND_DIR  (required) — frontend repo cwd for init/start
 *   MOCK_NAME     (default: basename of FRONTEND_DIR)
 *   MOCK_TASK     (default: <name>-e2e)
 *   MOCK_PORT     (default: 3900)
 *   PROXY_PORT    (default: 18999)
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'mox.js');
const FRONTEND_DIR = process.env.FRONTEND_DIR;
const skipInit = process.argv.includes('--skip-init');

if (!FRONTEND_DIR) {
  console.error(
    '[project-e2e] FRONTEND_DIR is required (path to the frontend repo)',
  );
  process.exit(2);
}

const SLUG = process.env.MOCK_NAME || path.basename(path.resolve(FRONTEND_DIR));
const TASK = process.env.MOCK_TASK || `${SLUG}-e2e`;
const MOCK_PORT = Number(process.env.MOCK_PORT || 3900);
const PROXY_PORT = Number(process.env.PROXY_PORT || 18999);

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd || FRONTEND_DIR,
    encoding: 'utf8',
    env: process.env,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status && r.status !== 0) {
    throw new Error(`mox ${args.join(' ')} exited ${r.status}`);
  }
  return r;
}

function req(opts) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    r.on('error', reject);
    r.setTimeout(5000, () => r.destroy(new Error('timeout')));
    r.end();
  });
}

function parseSmokeSummary(stdout) {
  const total = Number((stdout.match(/^- total: (\d+)/m) || [])[1] || 0);
  const failed = Number((stdout.match(/^- failed: (\d+)/m) || [])[1] || 0);
  const skipped = Number(
    (stdout.match(/^- skippedNoHandler: (\d+)/m) || [])[1] || 0,
  );
  return { total, failed, skippedNoHandler: skipped };
}

async function main() {
  spawnSync(process.execPath, [BIN, 'stop', `--name=${SLUG}`], {
    cwd: FRONTEND_DIR,
    encoding: 'utf8',
    env: process.env,
  });

  if (!skipInit) {
    console.log('[project-e2e] init…');
    run(['init', `--name=${SLUG}`, `--task=${TASK}`, '--force']);
  }

  console.log('[project-e2e] start --detach…');
  run([
    'start',
    `--name=${SLUG}`,
    `--task=${TASK}`,
    '--detach',
    `--mock-port=${MOCK_PORT}`,
    `--proxy-port=${PROXY_PORT}`,
  ]);

  const summary = { happy: null, fault: null, proxy: null, ok: true };
  try {
    run(['scenario', 'e2e-happy', `--name=${SLUG}`]);
    await new Promise((r) => setTimeout(r, 1100));
    console.log('[project-e2e] smoke success…');
    const happyOut = run([
      'smoke',
      `--name=${SLUG}`,
      '--ci',
      '--cases=success',
      `--task=${TASK}`,
    ]);
    summary.happy = parseSmokeSummary(happyOut.stdout || '');
    if (summary.happy.failed) summary.ok = false;

    run(['scenario', 'e2e-fault', `--name=${SLUG}`]);
    await new Promise((r) => setTimeout(r, 1100));
    console.log('[project-e2e] smoke http_500…');
    const faultOut = run([
      'smoke',
      `--name=${SLUG}`,
      '--ci',
      '--cases=http_500',
      `--task=${TASK}`,
    ]);
    summary.fault = parseSmokeSummary(faultOut.stdout || '');
    if (summary.fault.failed) summary.ok = false;

    const rulesPath = path.join(
      require('../lib/paths').projectDataDir(SLUG),
      'proxy-rules.json',
    );
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const rule =
      rules.find((x) => (x.methods || []).map(String).includes('GET')) ||
      rules[0];
    if (rule) {
      const host = rule.hosts?.[0] || 'localhost';
      const proxyRes = await req({
        hostname: '127.0.0.1',
        port: PROXY_PORT,
        path: rule.pathPrefix,
        method: 'GET',
        headers: { Host: host, 'x-mock-case': 'http_500' },
      });
      summary.proxy = {
        stubId: rule.stubId || rule.id,
        host,
        path: rule.pathPrefix,
        status: proxyRes.status,
      };
      if (proxyRes.status !== 500) summary.ok = false;
      console.log(
        `[project-e2e] proxy ${host}${rule.pathPrefix} -> ${proxyRes.status}`,
      );
    }
  } finally {
    console.log('[project-e2e] stop…');
    spawnSync(process.execPath, [BIN, 'stop', `--name=${SLUG}`], {
      cwd: FRONTEND_DIR,
      encoding: 'utf8',
      env: process.env,
    });
  }

  const out = path.join(
    require('../lib/paths').projectDataDir(SLUG),
    'reports',
    `project-e2e-${Date.now()}.json`,
  );
  fs.writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log('[project-e2e] summary', JSON.stringify(summary, null, 2));
  console.log('[project-e2e] wrote', out);
  if (!summary.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[project-e2e] fatal', e);
  process.exit(1);
});
