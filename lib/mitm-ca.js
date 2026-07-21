'use strict';

/**
 * Minimal local CA for HTTPS MITM.
 * Generates PEM under .data/mitm/. Default ON via session; Chrome uses system trust (no ignore-* flags).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { getDataRoot, ensureDataDirs } = require('./paths');

/** Must match -subj CN when generating the CA. */
const CA_COMMON_NAME = 'mox Local MITM CA';

function mitmDir() {
  ensureDataDirs();
  const dir = path.join(getDataRoot(), 'mitm');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loginKeychainPath() {
  return path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
}

function systemKeychainPath() {
  return '/Library/Keychains/System.keychain';
}

function defaultRunSecurity(args) {
  return spawnSync('security', args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
}

/** Read-only: true when macOS trust-settings list the mox CA. */
function isCaTrusted(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'darwin') return false;
  const runSecurity = opts.runSecurity || defaultRunSecurity;
  return isCaInTrustSettings(runSecurity);
}

function isCaInTrustSettings(runSecurity) {
  for (const args of [['dump-trust-settings', '-d'], ['dump-trust-settings']]) {
    const dump = runSecurity(args);
    const out = `${dump.stdout || ''}${dump.stderr || ''}`;
    if (out.includes(CA_COMMON_NAME)) return true;
  }
  return false;
}

/**
 * Write mox CA as SSL TrustRoot (system-level).
 * Order: login keychain (mkcert-style GUI auth) → System.keychain admin → open .cer for Always Trust.
 */
function installTrustedCa(opts = {}) {
  const { certPath } = ensureCa();
  const platform = opts.platform || process.platform;
  const runSecurity = opts.runSecurity || defaultRunSecurity;
  const cerPath = ensureCaCerFile(certPath);
  const manualCmd = `security add-trusted-cert -d -r trustRoot -p ssl -p basic -k ${JSON.stringify(loginKeychainPath())} ${JSON.stringify(certPath)}`;

  if (platform !== 'darwin') {
    return {
      ok: false,
      already: false,
      skipped: true,
      caCertPath: certPath,
      error: `auto-install unsupported on ${platform}; install ${certPath} into the OS trust store manually`,
      manualCmd: null,
    };
  }

  if (isCaInTrustSettings(runSecurity)) {
    return { ok: true, already: true, caCertPath: certPath };
  }

  // Remove stale untrusted copies so a fresh add can attach TrustRoot.
  runSecurity(['delete-certificate', '-c', CA_COMMON_NAME, loginKeychainPath()]);

  // 1) login.keychain — same as mkcert; SecurityAgent password sheet when stdin is a real TTY.
  const loginAdd = tryAddTrustedCert(certPath, loginKeychainPath(), opts);
  if (loginAdd.status === 0 && isCaInTrustSettings(runSecurity)) {
    return { ok: true, already: false, caCertPath: certPath, via: 'login' };
  }

  // 2) System.keychain via admin osascript (works in Terminal.app; often fails in IDE terminals).
  const admin = tryAddTrustedCaWithAdmin(certPath, opts);
  if (admin.ok && isCaInTrustSettings(runSecurity)) {
    return { ok: true, already: false, caCertPath: certPath, viaAdmin: true, via: 'system' };
  }

  // 3) Open .cer in Keychain Access and wait for user to set Always Trust (TTY only).
  const guided = tryGuidedKeychainTrust(cerPath, opts);
  if (guided.ok) {
    return { ok: true, already: false, caCertPath: certPath, via: 'keychain-ui' };
  }

  const errParts = [
    loginAdd.error,
    admin.error,
    guided.error,
  ].filter(Boolean);
  return {
    ok: false,
    already: false,
    caCertPath: certPath,
    cerPath,
    error:
      errParts.join(' | ') ||
      'CA not in trust settings — open Keychain Access, set "mox Local MITM CA" → Trust → Always Trust, then re-run mox start',
    manualCmd,
  };
}

/** Ensure DER .cer next to PEM for Keychain Access / double-click install. */
function ensureCaCerFile(certPath) {
  const cerPath = certPath.replace(/\.pem$/i, '.cer');
  const { der } = readCaDownloadFiles();
  fs.writeFileSync(cerPath, der);
  return cerPath;
}

function tryAddTrustedCert(certPath, keychain, opts = {}) {
  if (opts.runSecurity) {
    const r = opts.runSecurity([
      'add-trusted-cert',
      '-d',
      '-r',
      'trustRoot',
      '-p',
      'ssl',
      '-p',
      'basic',
      '-k',
      keychain,
      certPath,
    ]);
    return {
      status: r.status,
      error: (r.stderr || r.stdout || '').trim() || null,
    };
  }
  // stdio inherit so macOS can show the authorization dialog
  const r = spawnSync(
    'security',
    [
      'add-trusted-cert',
      '-d',
      '-r',
      'trustRoot',
      '-p',
      'ssl',
      '-p',
      'basic',
      '-k',
      keychain,
      certPath,
    ],
    { encoding: 'utf8', stdio: 'inherit' },
  );
  return {
    status: r.status,
    error: r.status === 0 ? null : `security add-trusted-cert exited ${r.status}`,
  };
}

/**
 * Open .cer and wait for Always Trust (interactive TTY).
 * Non-TTY (CI / pipes): skip wait, return fail so caller prints instructions.
 */
function tryGuidedKeychainTrust(cerPath, opts = {}) {
  if (opts.allowGuidedUi === false) {
    return { ok: false, error: 'guided Keychain UI disabled' };
  }
  const runOpen =
    opts.runOpen ||
    ((args) => spawnSync('open', args, { encoding: 'utf8', stdio: 'ignore' }));
  try {
    runOpen([cerPath]);
  } catch (e) {
    return { ok: false, error: `open cer failed: ${e.message}` };
  }

  console.log('');
  console.log('[mox] === 请在「钥匙串访问」中信任 CA（只需一次）===');
  console.log('[mox] 1. 双击已打开的证书（或搜索 mox Local MITM CA）');
  console.log('[mox] 2. 展开「信任」→「使用此证书时」→ 选「始终信任」');
  console.log('[mox] 3. 关闭窗口，输入登录密码确认');
  console.log('[mox] 4. 回到此终端按 Enter 继续');
  console.log('');

  const canPrompt =
    opts.forceGuidedPrompt === true ||
    (opts.forceGuidedPrompt !== false &&
      process.stdin.isTTY &&
      process.stdout.isTTY);
  if (!canPrompt) {
    return {
      ok: false,
      error:
        'no TTY for Keychain guided trust — re-run `mox start` in Terminal.app (or set Always Trust then re-run)',
    };
  }

  const wait =
    opts.waitForEnter ||
    (() =>
      spawnSync(
        'bash',
        ['-c', 'read -r -p "[mox] Press Enter after Always Trust… " _'],
        { stdio: 'inherit' },
      ));
  wait();

  const runSecurity = opts.runSecurity || defaultRunSecurity;
  if (isCaInTrustSettings(runSecurity)) {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      'still not trusted after Keychain step — confirm Always Trust was saved, then mox trust-ca',
  };
}

/**
 * For start: if trusted, no-op; else install once (may prompt password / Keychain UI).
 */
function ensureMitmCaReady(opts = {}) {
  const { certPath } = ensureCa();
  if (isCaTrusted(opts)) {
    return { ok: true, already: true, caCertPath: certPath };
  }
  console.log(
    '[mox] MITM CA not yet in macOS trust settings — installing (one-time password / Keychain Always Trust)…',
  );
  return installTrustedCa(opts);
}

function tryAddTrustedCaWithAdmin(certPath, opts = {}) {
  if ((opts.platform || process.platform) !== 'darwin') {
    return { ok: false, error: 'not darwin' };
  }
  if (opts.allowAdminPrompt === false) {
    return { ok: false, error: 'admin prompt disabled' };
  }
  const runOsascript =
    opts.runOsascript ||
    ((args) =>
      spawnSync('osascript', args, {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      }));
  const shellCmd = `security add-trusted-cert -d -r trustRoot -p ssl -p basic -k ${systemKeychainPath()} ${JSON.stringify(certPath)}`;
  const asLiteral = shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `do shell script "${asLiteral}" with administrator privileges`;
  const r = runOsascript(['-e', script]);
  if (r.status === 0) return { ok: true };
  return {
    ok: false,
    error: (r.stderr || r.stdout || `osascript exited ${r.status}`).trim(),
  };
}

/** PEM and DER buffers for /mox/ca.* downloads. */
function readCaDownloadFiles() {
  const { certPath } = ensureCa();
  const pem = fs.readFileSync(certPath);
  const der = (() => {
    const r = spawnSync(
      'openssl',
      ['x509', '-in', certPath, '-outform', 'DER'],
      { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 },
    );
    if (r.status !== 0) {
      throw new Error(`openssl DER export failed: ${(r.stderr || '').toString()}`);
    }
    return r.stdout;
  })();
  return { certPath, pem, der };
}

/** Log lines for phone Hybrid. */
function formatDeviceCaHints(caCertPath, { proxyDownloadBase } = {}) {
  const lines = [
    `CA file (same for desktop + phone): ${caCertPath}`,
  ];
  if (proxyDownloadBase) {
    lines.push(`Phone browser: ${proxyDownloadBase}/mox/ca.cer`);
    lines.push(`Or PEM: ${proxyDownloadBase}/mox/ca.pem`);
  }
  lines.push(
    'iOS: install profile → Settings → General → About → Certificate Trust Settings → enable full trust for "mox Local MITM CA".',
    'Android: Settings → Security → Install a certificate → CA certificate; many WebViews ignore user CAs.',
    'Retry / repair desktop trust: mox trust-ca',
  );
  return lines;
}

function logTrustedCaResult(result, { prefix = '[mox]' } = {}) {
  if (!result) return;
  if (result.ok && result.already) {
    console.log(`${prefix} MITM CA already trusted (system): ${result.caCertPath}`);
    return;
  }
  if (result.ok) {
    const where =
      result.via === 'login'
        ? 'login.keychain'
        : result.via === 'keychain-ui'
          ? 'Keychain Always Trust'
          : result.via === 'system' || result.viaAdmin
            ? 'System.keychain'
            : 'trust store';
    console.log(`${prefix} MITM CA trusted (${where}): ${result.caCertPath}`);
    return;
  }
  if (result.skipped) {
    console.warn(`${prefix} ${result.error}`);
    for (const line of formatDeviceCaHints(result.caCertPath)) {
      console.warn(`${prefix}   ${line}`);
    }
    return;
  }
  console.warn(`${prefix} MITM CA install failed: ${result.error}`);
  if (result.manualCmd) {
    console.warn(`${prefix}   ${result.manualCmd}`);
  }
  console.warn(
    `${prefix}   or Keychain Access → find "mox Local MITM CA" → Trust → Always Trust, then mox trust-ca`,
  );
}

/** @deprecated use ensureMitmCaReady / installTrustedCa */
function ensureTrustedCa(opts = {}) {
  return ensureMitmCaReady(opts);
}

function opensslAvailable() {
  const r = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  return r.status === 0;
}

function runOpenssl(args, input) {
  const r = spawnSync('openssl', args, {
    input,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`openssl ${args[0]} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

/** Compat: ensureCa() or ensureCa(_ignoredSlug) */
function ensureCa() {
  const dir = mitmDir();
  const keyPath = path.join(dir, 'ca.key.pem');
  const certPath = path.join(dir, 'ca.cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { keyPath, certPath, dir };
  }
  if (!opensslAvailable()) {
    throw new Error(
      'HTTPS MITM requires openssl on PATH to generate a local CA',
    );
  }
  runOpenssl(['genrsa', '-out', keyPath, '2048']);
  runOpenssl([
    'req',
    '-x509',
    '-new',
    '-nodes',
    '-key',
    keyPath,
    '-sha256',
    '-days',
    '3650',
    '-out',
    certPath,
    '-subj',
    '/CN=mox Local MITM CA',
  ]);
  return { keyPath, certPath, dir };
}

/** Compat: hostCert(hostname) or hostCert(_slug, hostname) */
function hostCert(a, b) {
  const hostname = b != null ? b : a;
  const { keyPath: caKey, certPath: caCert, dir } = ensureCa();
  const safe = hostname.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const hostKey = path.join(dir, `${safe}.key.pem`);
  const hostCsr = path.join(dir, `${safe}.csr.pem`);
  const hostCertPath = path.join(dir, `${safe}.cert.pem`);
  const extFile = path.join(dir, `${safe}.ext`);

  if (fs.existsSync(hostKey) && fs.existsSync(hostCertPath)) {
    return {
      key: fs.readFileSync(hostKey),
      cert: fs.readFileSync(hostCertPath),
      ca: fs.readFileSync(caCert),
    };
  }

  runOpenssl(['genrsa', '-out', hostKey, '2048']);
  runOpenssl([
    'req',
    '-new',
    '-key',
    hostKey,
    '-out',
    hostCsr,
    '-subj',
    `/CN=${hostname}`,
  ]);
  fs.writeFileSync(
    extFile,
    `basicConstraints=CA:FALSE\nsubjectAltName=DNS:${hostname}\nextendedKeyUsage=serverAuth\n`,
  );
  runOpenssl([
    'x509',
    '-req',
    '-in',
    hostCsr,
    '-CA',
    caCert,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-out',
    hostCertPath,
    '-days',
    '825',
    '-sha256',
    '-extfile',
    extFile,
  ]);
  return {
    key: fs.readFileSync(hostKey),
    cert: fs.readFileSync(hostCertPath),
    ca: fs.readFileSync(caCert),
  };
}

/** Compat: createMitmCa() or createMitmCa(_ignoredSlug) */
function createMitmCa() {
  const tls = require('tls');
  const { certPath } = ensureCa();
  const cache = new Map();

  return {
    caCertPath: certPath,
    getSecureContext(hostname) {
      if (cache.has(hostname)) return cache.get(hostname);
      const pems = hostCert(hostname);
      const ctx = tls.createSecureContext({
        key: pems.key,
        cert: Buffer.concat([pems.cert, pems.ca]),
        ca: pems.ca,
      });
      cache.set(hostname, ctx);
      return ctx;
    },
  };
}

module.exports = {
  CA_COMMON_NAME,
  createMitmCa,
  ensureCa,
  ensureMitmCaReady,
  ensureTrustedCa,
  formatDeviceCaHints,
  hostCert,
  installTrustedCa,
  isCaTrusted,
  isCaInTrustSettings,
  logTrustedCaResult,
  loginKeychainPath,
  mitmDir,
  opensslAvailable,
  readCaDownloadFiles,
  systemKeychainPath,
  tryAddTrustedCaWithAdmin,
};
