'use strict';

/**
 * Local CA for HTTPS MITM (Whistle-like persistence).
 * Root lives under ~/.mox/certs/ by default — stable across projects and tests.
 * Override with MOX_MITM_DIR (tests only). Chrome uses OS trust (no ignore-* flags).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { getDataRoot, ensureDataDirs } = require('./paths');

/** Must match CN in generated CA / openssl.cnf. */
const CA_COMMON_NAME = 'mox Local MITM CA';

const ROOT_KEY_NAME = 'root.key';
const ROOT_CRT_NAME = 'root.crt';
const LEGACY_KEY_NAME = 'ca.key.pem';
const LEGACY_CERT_NAME = 'ca.cert.pem';

function defaultUserMitmDir() {
  return path.join(os.homedir(), '.mox', 'certs');
}

/** Project-local legacy dir (pre-Whistle layout). */
function legacyProjectMitmDir() {
  ensureDataDirs();
  return path.join(getDataRoot(), 'mitm');
}

function mitmDir() {
  const override = process.env.MOX_MITM_DIR;
  const dir = override
    ? path.resolve(String(override))
    : defaultUserMitmDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rootKeyPath(dir = mitmDir()) {
  return path.join(dir, ROOT_KEY_NAME);
}

function rootCertPath(dir = mitmDir()) {
  return path.join(dir, ROOT_CRT_NAME);
}

/**
 * One-time copy from project .data/mitm into ~/.mox/certs (no re-sign).
 * Also accepts legacy ca.*.pem names already in the target dir.
 */
function migrateLegacyCaIfNeeded(dir) {
  const keyPath = rootKeyPath(dir);
  const certPath = rootCertPath(dir);
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) return;

  // Legacy names already in target dir
  const localLegacyKey = path.join(dir, LEGACY_KEY_NAME);
  const localLegacyCert = path.join(dir, LEGACY_CERT_NAME);
  if (fs.existsSync(localLegacyKey) && fs.existsSync(localLegacyCert)) {
    fs.copyFileSync(localLegacyKey, keyPath);
    fs.copyFileSync(localLegacyCert, certPath);
    console.warn(
      '[mox] migrated MITM CA names ca.*.pem → root.key/root.crt (same fingerprint)',
    );
    return;
  }

  // Project .data/mitm (only when using default user dir, not test override)
  if (process.env.MOX_MITM_DIR) return;
  const legacyDir = legacyProjectMitmDir();
  const projKey = path.join(legacyDir, LEGACY_KEY_NAME);
  const projCert = path.join(legacyDir, LEGACY_CERT_NAME);
  const projRootKey = path.join(legacyDir, ROOT_KEY_NAME);
  const projRootCert = path.join(legacyDir, ROOT_CRT_NAME);
  const srcKey = fs.existsSync(projKey)
    ? projKey
    : fs.existsSync(projRootKey)
      ? projRootKey
      : null;
  const srcCert = fs.existsSync(projCert)
    ? projCert
    : fs.existsSync(projRootCert)
      ? projRootCert
      : null;
  if (srcKey && srcCert) {
    fs.copyFileSync(srcKey, keyPath);
    fs.copyFileSync(srcCert, certPath);
    console.warn(
      `[mox] migrated MITM CA from ${legacyDir} → ${dir} (same fingerprint; phones need no reinstall)`,
    );
  }
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

  if (!opts.forceReinstall && isCaInTrustSettings(runSecurity)) {
    return { ok: true, already: true, caCertPath: certPath };
  }

  // Remove stale copies so a fresh add can attach TrustRoot (and new fingerprint after regen).
  runSecurity(['delete-certificate', '-c', CA_COMMON_NAME, loginKeychainPath()]);
  if (opts.forceReinstall) {
    runSecurity([
      'delete-certificate',
      '-c',
      CA_COMMON_NAME,
      systemKeychainPath(),
    ]);
  }

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
  // root.crt (Whistle layout) must not be overwritten — only .pem/.crt → sibling .cer
  let cerPath = String(certPath).replace(/\.(pem|crt)$/i, '.cer');
  if (cerPath === certPath) {
    cerPath = path.join(path.dirname(certPath), 'root.cer');
  }
  fs.writeFileSync(cerPath, pemCertToDer(certPath));
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
 * After CA regen, always re-install — CN may still appear in trust settings while fingerprint changed.
 */
function ensureMitmCaReady(opts = {}) {
  const ensured = ensureCa(opts);
  const { certPath, regenerated } = ensured;
  if (!regenerated && isCaTrusted(opts)) {
    return { ok: true, already: true, caCertPath: certPath, regenerated: false };
  }
  if (regenerated) {
    console.log(
      '[mox] MITM CA regenerated — re-installing into macOS trust (same as mox trust-ca)…',
    );
  } else {
    console.log(
      '[mox] MITM CA not yet in macOS trust settings — installing (one-time password / Keychain Always Trust)…',
    );
  }
  const installed = installTrustedCa({
    ...opts,
    forceReinstall: Boolean(regenerated),
  });
  return { ...installed, regenerated: Boolean(regenerated) };
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
  const der = pemCertToDer(certPath);
  return { certPath, pem, der };
}

/** Short SHA-256 of current MITM CA (phone/desktop must match after regen). */
function caFingerprintShort(certPath) {
  try {
    const { X509Certificate } = require('crypto');
    const fp = new X509Certificate(fs.readFileSync(certPath)).fingerprint256;
    return String(fp || '')
      .replace(/:/g, '')
      .slice(0, 16)
      .toUpperCase();
  } catch {
    return '';
  }
}

/** Log lines for phone Hybrid. */
function formatDeviceCaHints(caCertPath, { proxyDownloadBase } = {}) {
  const lines = [
    `CA file (same for desktop + phone): ${caCertPath}`,
  ];
  const fp = caFingerprintShort(caCertPath);
  if (fp) {
    lines.push(`CA fingerprint (sha256…): ${fp}… — phone must install THIS file after regen`);
  }
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

function opensslAvailable(opts = {}) {
  const resolveBin = opts.resolveOpensslBin || resolveOpensslBin;
  return Boolean(resolveBin());
}

/** Prefer PATH, then common Homebrew / system locations (GUI/detached start often lacks brew PATH). */
function resolveOpensslBin() {
  const candidates = [
    process.env.MOX_OPENSSL,
    'openssl',
    '/opt/homebrew/bin/openssl',
    '/usr/local/bin/openssl',
    '/usr/bin/openssl',
  ].filter(Boolean);
  const env = {
    ...process.env,
    PATH: [
      process.env.PATH || '',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ].join(path.delimiter),
  };
  for (const bin of candidates) {
    const r = spawnSync(bin, ['version'], {
      encoding: 'utf8',
      env,
    });
    if (!r.error && r.status === 0) return bin;
  }
  return null;
}

/** PEM → DER via Node crypto (no openssl; phone /mox/ca.cer must not depend on PATH). */
function pemCertToDer(certPath) {
  const { X509Certificate } = require('crypto');
  return new X509Certificate(fs.readFileSync(certPath)).raw;
}

/**
 * Heal root.crt if ensureCaCerFile once overwrote PEM with DER (pre-Whistle bug).
 * X509Certificate accepts both; openssl leaf signing needs PEM on disk.
 */
function ensureRootCertPem(certPath) {
  if (!certPath || !fs.existsSync(certPath)) return;
  const raw = fs.readFileSync(certPath);
  if (raw.includes('BEGIN CERTIFICATE')) return;
  try {
    const { X509Certificate } = require('crypto');
    const pem = new X509Certificate(raw).toString();
    if (pem.includes('BEGIN CERTIFICATE')) {
      fs.writeFileSync(certPath, pem);
      console.warn('[mox] normalized MITM root.crt DER → PEM (same fingerprint)');
    }
  } catch {
    /* leave as-is; ensureCa may regen */
  }
}

/**
 * Detect keyUsage=keyCertSign in DER (OID 2.5.29.15).
 * Avoids false "weak CA" when openssl is missing from the process PATH.
 */
function derHasKeyCertSign(der) {
  if (!Buffer.isBuffer(der) || der.length < 8) return false;
  const oid = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0f]);
  const idx = der.indexOf(oid);
  if (idx < 0) return false;
  const slice = der.subarray(idx, Math.min(der.length, idx + 48));
  const bitIdx = slice.indexOf(0x03);
  if (bitIdx < 0 || bitIdx + 3 >= slice.length) return false;
  const bits = slice[bitIdx + 3];
  // RFC 5280 KeyUsage bit 5 = keyCertSign (MSB is bit 0)
  return (bits & 0x04) !== 0;
}

function runOpenssl(args, input, opts = {}) {
  const resolveBin = opts.resolveOpensslBin || resolveOpensslBin;
  const bin = resolveBin();
  if (!bin) {
    throw new Error(
      'HTTPS MITM requires openssl on PATH (or /opt/homebrew/bin/openssl / /usr/bin/openssl) to generate a local CA',
    );
  }
  const env = {
    ...process.env,
    PATH: [
      process.env.PATH || '',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ].join(path.delimiter),
  };
  const r = spawnSync(bin, args, {
    input,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    env,
  });
  if (r.status === 0) return r.stdout;
  // Some callers pass encoding:buffer via wrapper — keep string error readable
  throw new Error(`openssl ${args[0]} failed: ${r.stderr || r.stdout}`);
}

/**
 * Android / Chrome trust user CAs that can actually sign leaves.
 * Whistle & mitmproxy ship keyUsage=keyCertSign; bare openssl req -x509 often omits it
 * and Android then rejects the chain even when the CA is under 「用户」凭据.
 */
function caHasKeyCertSign(certPath) {
  if (!certPath || !fs.existsSync(certPath)) return false;
  try {
    if (derHasKeyCertSign(pemCertToDer(certPath))) return true;
  } catch {
    /* fall through to openssl text */
  }
  const bin = resolveOpensslBin();
  if (!bin) return false;
  const r = spawnSync(
    bin,
    ['x509', '-in', certPath, '-noout', '-text'],
    { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, env: process.env },
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
  // Flat legacy leaves next to root
  for (const name of fs.readdirSync(dir)) {
    if (
      name === ROOT_KEY_NAME ||
      name === ROOT_CRT_NAME ||
      name === LEGACY_KEY_NAME ||
      name === LEGACY_CERT_NAME ||
      name === 'ca.cer' ||
      name === 'root.cer' ||
      name === 'hosts'
    ) {
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
  // Fingerprint-bucketed leaves
  const hostsRoot = path.join(dir, 'hosts');
  if (fs.existsSync(hostsRoot)) {
    try {
      fs.rmSync(hostsRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function hostsDirForCa(dir, certPath) {
  const fp = caFingerprintShort(certPath) || 'unknown';
  const d = path.join(dir, 'hosts', fp);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** True when leaf PEM was signed by this CA (issuer fingerprint / verify). */
function leafMatchesCa(leafCertPath, caCertPath) {
  if (!fs.existsSync(leafCertPath) || !fs.existsSync(caCertPath)) return false;
  try {
    const { X509Certificate } = require('crypto');
    const leaf = new X509Certificate(fs.readFileSync(leafCertPath));
    const ca = new X509Certificate(fs.readFileSync(caCertPath));
    if (leaf.checkIssued(ca)) return true;
  } catch {
    /* fall through */
  }
  const bin = resolveOpensslBin();
  if (!bin) return false;
  const r = spawnSync(
    bin,
    ['verify', '-CAfile', caCertPath, leafCertPath],
    { encoding: 'utf8' },
  );
  return r.status === 0 && /: OK\s*$/m.test(String(r.stdout || ''));
}

function generateCaFiles(dir, keyPath, certPath, opts = {}) {
  if (!opensslAvailable(opts)) {
    throw new Error(
      'HTTPS MITM requires openssl on PATH (tried PATH, /opt/homebrew/bin/openssl, /usr/bin/openssl) to generate a local CA',
    );
  }
  const cnfPath = path.join(dir, 'ca.cnf');
  writeCaExtFile(cnfPath);
  runOpenssl(['genrsa', '-out', keyPath, '2048'], undefined, opts);
  runOpenssl(
    [
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
    ],
    undefined,
    opts,
  );
}

function restoreCaBackup(keyPath, certPath) {
  try {
    if (fs.existsSync(`${keyPath}.bak`)) {
      fs.renameSync(`${keyPath}.bak`, keyPath);
    }
    if (fs.existsSync(`${certPath}.bak`)) {
      fs.renameSync(`${certPath}.bak`, certPath);
    }
  } catch {
    /* ignore */
  }
}

/** Compat: ensureCa() or ensureCa(_ignoredSlug) */
function ensureCa(opts = {}) {
  const dir = mitmDir();
  migrateLegacyCaIfNeeded(dir);

  const keyPath = rootKeyPath(dir);
  const certPath = rootCertPath(dir);
  // Auto-rotating a good CA breaks phone trust. Only re-issue when missing or explicit.
  const forceRegen =
    Boolean(opts.forceRegen) || process.env.MOX_FORCE_REGEN_CA === '1';

  // Recover from a failed prior regen that left only *.bak
  if (
    !fs.existsSync(keyPath) &&
    !fs.existsSync(certPath) &&
    fs.existsSync(`${keyPath}.bak`) &&
    fs.existsSync(`${certPath}.bak`)
  ) {
    restoreCaBackup(keyPath, certPath);
    console.warn('[mox] restored MITM CA from *.bak after incomplete regen');
  }

  const exists = fs.existsSync(keyPath) && fs.existsSync(certPath);
  if (exists) ensureRootCertPem(certPath);
  const weak = exists && !caHasKeyCertSign(certPath);

  if (exists && !forceRegen) {
    if (weak) {
      console.warn(
        '[mox] MITM CA lacks keyCertSign — Android may reject MITM. Re-issue with MOX_FORCE_REGEN_CA=1 mox start (then reinstall CA on phone).',
      );
    }
    return { keyPath, certPath, dir, regenerated: false };
  }

  if (!opensslAvailable(opts)) {
    if (exists) {
      console.warn(
        '[mox] openssl unavailable — keeping existing MITM CA (skip regen)',
      );
      return { keyPath, certPath, dir, regenerated: false };
    }
    throw new Error(
      'HTTPS MITM requires openssl on PATH (tried PATH, /opt/homebrew/bin/openssl, /usr/bin/openssl) to generate a local CA',
    );
  }

  if (exists && forceRegen) {
    console.warn(
      '[mox] regenerating MITM CA (explicit force) — phones must delete old mox CA and reinstall',
    );
    try {
      if (fs.existsSync(keyPath)) fs.renameSync(keyPath, `${keyPath}.bak`);
      if (fs.existsSync(certPath)) fs.renameSync(certPath, `${certPath}.bak`);
    } catch {
      /* ignore */
    }
  }

  // Always clear leaves when (re)generating root — old leaves break the chain.
  clearHostCertCache(dir);
  invalidateMitmContextCache();

  try {
    generateCaFiles(dir, keyPath, certPath, opts);
  } catch (e) {
    restoreCaBackup(keyPath, certPath);
    throw e;
  }

  try {
    ensureCaCerFile(certPath);
  } catch {
    /* download path can rebuild .cer */
  }

  const fp = caFingerprintShort(certPath);
  if (fp) {
    console.log(`[mox] MITM CA fingerprint (sha256…): ${fp}…`);
  }
  if (exists && forceRegen) {
    console.warn(
      '[mox] CA rotated — delete old "mox Local MITM CA" on phone, re-download /mox/ca.cer, then verify /__mox_mitm_check',
    );
  }

  return {
    keyPath,
    certPath,
    dir,
    regenerated: Boolean(exists && forceRegen) || !exists,
  };
}

/** Compat: hostCert(hostname) or hostCert(_slug, hostname) */
function hostCert(a, b) {
  const hostname = b != null ? b : a;
  const { keyPath: caKey, certPath: caCert, dir } = ensureCa();
  const safe = hostname.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const leafDir = hostsDirForCa(dir, caCert);
  const hostKey = path.join(leafDir, `${safe}.key.pem`);
  const hostCsr = path.join(leafDir, `${safe}.csr.pem`);
  const hostCertPath = path.join(leafDir, `${safe}.cert.pem`);
  const extFile = path.join(leafDir, `${safe}.ext`);

  if (
    fs.existsSync(hostKey) &&
    fs.existsSync(hostCertPath) &&
    leafMatchesCa(hostCertPath, caCert)
  ) {
    return {
      key: fs.readFileSync(hostKey),
      cert: fs.readFileSync(hostCertPath),
      ca: fs.readFileSync(caCert),
    };
  }

  for (const p of [hostKey, hostCsr, hostCertPath, extFile]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
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
      'basicConstraints=critical,CA:FALSE',
      'subjectAltName=DNS:' + hostname,
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth,clientAuth',
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid,issuer',
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

/** Shared so ensureCa regen can drop in-memory SecureContexts. */
let _mitmContextCache = null;

function invalidateMitmContextCache() {
  if (_mitmContextCache) _mitmContextCache.clear();
}

/** Compat: createMitmCa() or createMitmCa(_ignoredSlug) */
function createMitmCa() {
  const tls = require('tls');
  ensureCa();
  const cache = new Map();
  _mitmContextCache = cache;

  return {
    caCertPath: rootCertPath(),
    getSecureContext(hostname) {
      if (cache.has(hostname)) return cache.get(hostname);
      const pems = hostCert(hostname);
      const ctx = tls.createSecureContext({
        key: pems.key,
        cert: Buffer.concat([pems.cert, pems.ca]),
        ca: pems.ca,
      });
      try {
        ctx.context.setALPNProtocols(['http/1.1']);
      } catch {
        /* older Node — ignore */
      }
      cache.set(hostname, ctx);
      return ctx;
    },
    clearCache() {
      cache.clear();
    },
  };
}

module.exports = {
  CA_COMMON_NAME,
  caHasKeyCertSign,
  caFingerprintShort,
  createMitmCa,
  defaultUserMitmDir,
  ensureCa,
  ensureCaCerFile,
  ensureMitmCaReady,
  ensureTrustedCa,
  formatDeviceCaHints,
  hostCert,
  installTrustedCa,
  invalidateMitmContextCache,
  isCaTrusted,
  isCaInTrustSettings,
  leafMatchesCa,
  logTrustedCaResult,
  loginKeychainPath,
  mitmDir,
  opensslAvailable,
  pemCertToDer,
  derHasKeyCertSign,
  readCaDownloadFiles,
  resolveOpensslBin,
  rootCertPath,
  rootKeyPath,
  systemKeychainPath,
  tryAddTrustedCaWithAdmin,
};
