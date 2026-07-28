'use strict';

/**
 * Android Global http_proxy lease — bind proxy to mox session (--device).
 * Lease lives under ~/.mox (override MOX_HOME) so stop works across cwd.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const {
  ensureCa,
  ensureCaCerFile,
  caFingerprintShort,
} = require('./mitm-ca');

const CA_REMOTE = '/sdcard/Download/mox-rootCA.cer';
const CLEAR_FAILED = 'DEVICE_PROXY_CLEAR_FAILED';

function moxHomeDir() {
  if (process.env.MOX_HOME) return path.resolve(process.env.MOX_HOME);
  return path.join(os.homedir(), '.mox');
}

function leasePath() {
  return path.join(moxHomeDir(), 'device-proxy-lease.json');
}

function defaultRunAdb(args) {
  const r = spawnSync('adb', args, { encoding: 'utf8' });
  return {
    status: r.status == null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

/**
 * Normalize settings get / lease proxy values for comparison.
 * Empty, null, :0 → '' (cleared).
 */
function normalizeProxyValue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s === 'null' || s === ':0' || s === 'null:0') return '';
  return s.replace(/\s+/g, '');
}

function isProxyActive(normalized) {
  return Boolean(normalized && !normalized.startsWith(':'));
}

function readLease(opts = {}) {
  const file = opts.leasePath || leasePath();
  if (!fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object') return null;
    return j;
  } catch {
    return null;
  }
}

function writeLease(lease, opts = {}) {
  const file = opts.leasePath || leasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
}

function deleteLease(opts = {}) {
  const file = opts.leasePath || leasePath();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/**
 * List online adb serials (state === device).
 * Honors ANDROID_SERIAL when set — must be online or throws.
 */
function listTargetSerials(runAdb = defaultRunAdb) {
  const r = runAdb(['devices']);
  if (r.status !== 0) {
    throw new Error(`adb devices failed: ${r.stderr || r.stdout}`);
  }
  const lines = String(r.stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^List of devices/i.test(l));
  const rows = lines.map((l) => {
    const parts = l.split(/\s+/);
    return { serial: parts[0], state: parts[1] || '' };
  });

  const want = String(process.env.ANDROID_SERIAL || '').trim();
  if (want) {
    const row = rows.find((x) => x.serial === want);
    if (!row) {
      throw new Error(
        `ANDROID_SERIAL=${want} not in adb devices (plug phone / enable USB debugging)`,
      );
    }
    if (row.state !== 'device') {
      throw new Error(
        `ANDROID_SERIAL=${want} state=${row.state} (need device; fix unauthorized/offline)`,
      );
    }
    return [want];
  }

  const offline = rows.filter((x) => x.state && x.state !== 'device');
  const online = rows.filter((x) => x.state === 'device').map((x) => x.serial);
  if (!online.length) {
    const hint = offline.length
      ? ` found non-device: ${offline.map((x) => `${x.serial}:${x.state}`).join(', ')}`
      : '';
    throw new Error(
      `no device: adb devices empty${hint} (plug phone + enable USB debugging; adb devices)`,
    );
  }
  return online;
}

function adbForSerial(runAdb, serial, shellArgs) {
  return runAdb(['-s', serial, ...shellArgs]);
}

function getHttpProxyOnDevice(runAdb, serial) {
  const r = adbForSerial(runAdb, serial, [
    'shell',
    'settings',
    'get',
    'global',
    'http_proxy',
  ]);
  if (r.status !== 0) {
    return { ok: false, value: '', raw: r.stderr || r.stdout };
  }
  return {
    ok: true,
    value: normalizeProxyValue(r.stdout),
    raw: String(r.stdout || '').trim(),
  };
}

function putHttpProxyOnDevice(runAdb, serial, value) {
  const r = adbForSerial(runAdb, serial, [
    'shell',
    'settings',
    'put',
    'global',
    'http_proxy',
    value,
  ]);
  return r;
}

function deleteHttpProxyOnDevice(runAdb, serial) {
  return adbForSerial(runAdb, serial, [
    'shell',
    'settings',
    'delete',
    'global',
    'http_proxy',
  ]);
}

/**
 * Clear proxy to inactive; verify with get; fall back to delete.
 */
function clearProxyOnDevice(runAdb, serial) {
  putHttpProxyOnDevice(runAdb, serial, ':0');
  let cur = getHttpProxyOnDevice(runAdb, serial);
  if (cur.ok && !isProxyActive(cur.value)) {
    return { ok: true, serial };
  }
  deleteHttpProxyOnDevice(runAdb, serial);
  cur = getHttpProxyOnDevice(runAdb, serial);
  if (cur.ok && !isProxyActive(cur.value)) {
    return { ok: true, serial };
  }
  return {
    ok: false,
    serial,
    remaining: cur.value || cur.raw,
  };
}

function setProxyOnDevice(runAdb, serial, proxyValue) {
  const put = putHttpProxyOnDevice(runAdb, serial, proxyValue);
  if (put.status !== 0) {
    throw new Error(
      `adb settings put http_proxy failed (${serial}): ${put.stderr || put.stdout}`,
    );
  }
  const cur = getHttpProxyOnDevice(runAdb, serial);
  if (!cur.ok || normalizeProxyValue(cur.value) !== normalizeProxyValue(proxyValue)) {
    throw new Error(
      `http_proxy verify failed (${serial}): want ${proxyValue} got ${cur.raw || cur.value}`,
    );
  }
}

function pushCaIfNeeded(runAdb, serials, opts = {}) {
  const ca = ensureCa({});
  const certPath = ca.certPath || ca.caCertPath;
  const cer = ensureCaCerFile(certPath);
  if (!cer || !fs.existsSync(cer)) {
    throw new Error('device proxy: CA .cer missing');
  }
  const fp = caFingerprintShort(certPath) || null;
  const lease = readLease(opts);
  const skipPush =
    opts.forcePushCa !== true &&
    lease &&
    lease.caFingerprint &&
    fp &&
    lease.caFingerprint === fp &&
    Array.isArray(lease.serials) &&
    serials.every((s) => lease.serials.includes(s));

  const pushed = [];
  if (!skipPush) {
    for (const serial of serials) {
      const push = runAdb(['-s', serial, 'push', cer, CA_REMOTE]);
      if (push.status !== 0) {
        throw new Error(
          `adb push CA failed (${serial}): ${push.stderr || push.stdout}`,
        );
      }
      pushed.push(serial);
    }
  }
  return { fingerprint: fp, pushed, skipped: Boolean(skipPush), remote: CA_REMOTE };
}

/**
 * Attach devices for a hybrid session: set Global http_proxy + lease.
 * @throws on no device / no lanIp / adb failures
 */
function attachDeviceForSession(opts = {}) {
  const runAdb = typeof opts.runAdb === 'function' ? opts.runAdb : defaultRunAdb;
  const lanIp = String(opts.lanIp || '').trim();
  const proxyPort = Number(opts.proxyPort) || 18999;
  if (!lanIp) {
    throw new Error(
      'device proxy: no LAN IP (check network / VPN); cannot set http_proxy',
    );
  }
  const serials = listTargetSerials(runAdb);
  const proxyValue = `${lanIp}:${proxyPort}`;
  const leaseOpts = { leasePath: opts.leasePath };

  const existing = readLease(leaseOpts);
  const dirtyWarns = [];
  for (const serial of serials) {
    const cur = getHttpProxyOnDevice(runAdb, serial);
    if (cur.ok && isProxyActive(cur.value)) {
      const leaseNorm = existing ? normalizeProxyValue(existing.value) : '';
      if (!leaseNorm || leaseNorm !== cur.value) {
        dirtyWarns.push({ serial, current: cur.value });
      }
    }
  }
  for (const w of dirtyWarns) {
    console.warn(
      `[mox] warn: device ${w.serial} has http_proxy=${w.current} without matching mox lease — run: mox device clear`,
    );
  }

  for (const serial of serials) {
    setProxyOnDevice(runAdb, serial, proxyValue);
  }

  const caInfo = pushCaIfNeeded(runAdb, serials, {
    ...leaseOpts,
    forcePushCa: opts.forcePushCa,
  });

  const lease = {
    value: proxyValue,
    setAt: new Date().toISOString(),
    source: opts.source || 'start --device',
    serials,
    caFingerprint: caInfo.fingerprint,
  };
  writeLease(lease, leaseOpts);

  const catalogHost = opts.catalogHost || '<catalog-https-host>';
  const mitmCheckHint = `https://${catalogHost}/__mox_mitm_check`;

  console.log(
    `[mox] device http_proxy=${proxyValue} devices=${serials.join(',')}`,
  );
  if (caInfo.pushed.length) {
    console.log(
      `[mox] CA pushed → ${caInfo.remote} (install as user CA in Settings → Security)`,
    );
  } else {
    console.log(
      `[mox] CA already on device (fingerprint match); still ensure user CA trusted in Settings`,
    );
  }
  console.log(
    `[mox] MITM self-check: ${mitmCheckHint} (JSON ok:true) — page green lock alone is not enough`,
  );
  console.log(
    '[mox] note: Cronet / certificate-pinning apps that ignore system proxy are out of scope (H1)',
  );
  console.log(
    '[mox] security: only use on trusted LAN — device traffic goes through this machine',
  );

  return {
    ok: true,
    proxyValue,
    serials,
    lease,
    mitmCheckHint,
    caRemote: caInfo.remote,
    fingerprint: caInfo.fingerprint,
    dirtyWarns,
  };
}

/**
 * Clear Global http_proxy when it still matches the lease (or force).
 */
function clearDeviceHttpProxyIfLease(opts = {}) {
  const runAdb = typeof opts.runAdb === 'function' ? opts.runAdb : defaultRunAdb;
  const force = Boolean(opts.force);
  const leaseOpts = { leasePath: opts.leasePath };
  const lease = readLease(leaseOpts);

  if (!force && !lease) {
    return { ok: true, skipped: 'no-lease', cleared: false };
  }

  let serials;
  try {
    serials = listTargetSerials(runAdb);
  } catch (e) {
    if (force) {
      console.error(`[mox] ${CLEAR_FAILED}: ${e.message}`);
      console.error('[mox] tip: plug device then: mox device clear');
      return { ok: false, error: e.message, code: CLEAR_FAILED };
    }
    console.warn(`[mox] device proxy clear skipped: ${e.message}`);
    console.warn('[mox] tip: when device is back, run: mox device clear');
    return { ok: false, skipped: 'no-device', error: e.message, code: CLEAR_FAILED };
  }

  const leaseNorm = lease ? normalizeProxyValue(lease.value) : '';
  const results = [];
  let anyCleared = false;
  let anyFailed = false;

  for (const serial of serials) {
    const cur = getHttpProxyOnDevice(runAdb, serial);
    const curNorm = cur.ok ? cur.value : '';
    if (!force) {
      if (!leaseNorm || curNorm !== leaseNorm) {
        results.push({
          serial,
          action: 'skip-mismatch',
          current: curNorm || cur.raw,
        });
        continue;
      }
    }
    const cleared = clearProxyOnDevice(runAdb, serial);
    if (cleared.ok) {
      anyCleared = true;
      results.push({ serial, action: 'cleared' });
    } else {
      anyFailed = true;
      results.push({
        serial,
        action: 'failed',
        remaining: cleared.remaining,
      });
    }
  }

  deleteLease(leaseOpts);

  if (anyFailed) {
    console.error(`[mox] ${CLEAR_FAILED}: could not clear http_proxy on some devices`);
    console.error('[mox] tip: mox device clear');
    for (const r of results.filter((x) => x.action === 'failed')) {
      console.error(`  - ${r.serial} remaining=${r.remaining}`);
    }
    return {
      ok: false,
      cleared: anyCleared,
      results,
      code: CLEAR_FAILED,
    };
  }

  if (anyCleared || force) {
    console.log('[mox] device http_proxy cleared');
    console.log(
      '[mox] tip: if Wi-Fi still has a manual proxy, change it in system Settings',
    );
  } else if (lease && !force) {
    console.log(
      '[mox] device proxy lease removed (current http_proxy no longer matched mox; left as-is)',
    );
  }

  return { ok: true, cleared: anyCleared, results, force };
}

function forceClearDeviceHttpProxy(opts = {}) {
  return clearDeviceHttpProxyIfLease({ ...opts, force: true });
}

module.exports = {
  CLEAR_FAILED,
  CA_REMOTE,
  moxHomeDir,
  leasePath,
  normalizeProxyValue,
  isProxyActive,
  readLease,
  writeLease,
  deleteLease,
  listTargetSerials,
  getHttpProxyOnDevice,
  attachDeviceForSession,
  clearDeviceHttpProxyIfLease,
  forceClearDeviceHttpProxy,
  defaultRunAdb,
  pushCaIfNeeded,
};
