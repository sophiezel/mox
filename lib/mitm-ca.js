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
    'Android: Settings → Security → Install a certificate → CA certificate（用户凭据即可；CA 须含 keyUsage=keyCertSign，与 Whistle 同类）。',
    'If CA was regenerated: delete old mox CA on phone, re-download /mox/ca.cer, then mox trust-ca on Mac.',
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

/**
 * Android / Chrome trust user CAs that can actually sign leaves.
 * Whistle & mitmproxy ship keyUsage=keyCertSign; bare openssl req -x509 often omits it
 * and Android then rejects the chain even when the CA is under 「用户」凭据.
 */
function caHasKeyCertSign(certPath) {
  if (!certPath || !fs.existsSync(certPath)) return false;
  const r = spawnSync(
    'openssl',
    ['x509', '-in', certPath, '-noout', '-text'],
    { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
  );
  if (r.status !== 0) return false;
  const text = `${r.stdout || ''}`;
  // "Certificate Sign" or OpenSSL 3 "Key Cert Sign"
  return /Key Usage/i.test(text) && /Cert(?:ificate)? Sign/i.test(text);
}

function writeCaExtFile(extPath) {
  // Align with whistle / mitmproxy: CA:TRUE + keyCertSign (+ server/client EKU for install UX)
  // Full openssl.cnf so LibreSSL (macOS) accepts -sha256 with extensions.
  fs.writeFileSync(
    extPath,
    [
      '[req]',
      'distinguished_name = req_dn',
      'x509_extensions = v3_ca',
      'prompt = no',
      '[req_dn]',
      'CN = mox Local MITM CA',
      '[v3_ca]',
      'basicConstraints = critical,CA:TRUE',
      'keyUsage = critical,keyCertSign,cRLSign,digitalSignature',
      'extendedKeyUsage = serverAuth,clientAuth',
      'subjectKeyIdentifier = hash',
      'authorityKeyIdentifier = keyid:always,issuer',
      '',
    ].join('\n'),
  );
}

function clearHostCertCache(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name === 'ca.key.pem' || name === 'ca.cert.pem' || name === 'ca.cer') {
      continue;
    }
    if (
      name.endsWith('.key.pem') ||
      name.endsWith('.cert.pem') ||
      name.endsWith('.csr.pem') ||
      name.endsWith('.ext') ||
      name.endsWith('.srl') ||
      name === 'ca.cnf'
    ) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        /* ignore */
      }
    }
  }
}

function generateCaFiles(dir, keyPath, certPath) {
  if (!opensslAvailable()) {
    throw new Error(
      'HTTPS MITM requires openssl on PATH to generate a local CA',
    );
  }
  const cnfPath = path.join(dir, 'ca.cnf');
  writeCaExtFile(cnfPath);
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
    '-config',
    cnfPath,
  ]);
}

/** Compat: ensureCa() or ensureCa(_ignoredSlug) */
function ensureCa(opts = {}) {
  const dir = mitmDir();
  const keyPath = path.join(dir, 'ca.key.pem');
  const certPath = path.join(dir, 'ca.cert.pem');
  const forceRegen = Boolean(opts.forceRegen);

  const exists = fs.existsSync(keyPath) && fs.existsSync(certPath);
  const weak = exists && !caHasKeyCertSign(certPath);

  if (exists && !forceRegen && !weak) {
    return { keyPath, certPath, dir, regenerated: false };
  }

  if (weak || forceRegen) {
    console.warn(
      '[mox] regenerating MITM CA (need keyUsage=keyCertSign for Android user trust, same as Whistle)',
    );
    try {
      if (fs.existsSync(keyPath)) fs.renameSync(keyPath, `${keyPath}.bak`);
      if (fs.existsSync(certPath)) fs.renameSync(certPath, `${certPath}.bak`);
    } catch {
      /* ignore */
    }
    clearHostCertCache(dir);
  }

  generateCaFiles(dir, keyPath, certPath);
  return {
    keyPath,
    certPath,
    dir,
    regenerated: Boolean(weak || forceRegen || !exists),
  };
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
    [
      'basicConstraints=CA:FALSE',
      'subjectAltName=DNS:' + hostname,
      'keyUsage=digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      '',
    ].join('\n'),
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
      // Force HTTP/1.1 so mobile browsers do not speak h2 into our http.Server MITM bridge.
      try {
        ctx.context.setALPNProtocols(['http/1.1']);
      } catch {
        /* older Node — ignore */
      }
      cache.set(hostname, ctx);
      return ctx;
    },
  };
}

module.exports = {
  CA_COMMON_NAME,
  caHasKeyCertSign,
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
