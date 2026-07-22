'use strict';

/**
 * mox device prepare — ADB helper for Hybrid (H1).
 * Sets http_proxy, pushes CA, prints mitm-check URL.
 * Does NOT enter PIN / bypass pinning / Cronet.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const { ensureCa, ensureCaCerFile, caFingerprintShort } = require('../lib/mitm-ca');
const { buildDeviceSetupUrls } = require('../lib/device-setup');

function defaultRunAdb(args) {
  const r = spawnSync('adb', args, { encoding: 'utf8' });
  return {
    status: r.status == null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

function listDevices(runAdb) {
  const r = runAdb(['devices']);
  if (r.status !== 0) {
    throw new Error(`adb devices failed: ${r.stderr || r.stdout}`);
  }
  const lines = String(r.stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^List of devices/i.test(l));
  const devices = lines
    .map((l) => l.split(/\s+/))
    .filter((parts) => parts[1] === 'device')
    .map((parts) => parts[0]);
  return devices;
}

/**
 * @param {object} opts
 * @param {string} opts.lanIp
 * @param {number} [opts.proxyPort]
 * @param {string} [opts.catalogHost] host for mitm-check hint
 * @param {(args: string[]) => {status:number,stdout:string,stderr:string}} [opts.runAdb]
 */
function devicePrepare(opts = {}) {
  const runAdb = typeof opts.runAdb === 'function' ? opts.runAdb : defaultRunAdb;
  const lanIp = String(opts.lanIp || '').trim();
  const proxyPort = Number(opts.proxyPort || 18999);
  if (!lanIp) {
    throw new Error('device prepare: need --lan-ip= (or pass lanIp)');
  }
  const devices = listDevices(runAdb);
  if (!devices.length) {
    throw new Error('no device: adb devices empty (plug phone / start emulator)');
  }

  const ca = ensureCa({});
  const certPath = ca.certPath || ca.caCertPath;
  const cer = ensureCaCerFile(certPath);
  if (!cer || !fs.existsSync(cer)) {
    throw new Error('device prepare: CA .cer missing');
  }

  const proxyValue = `${lanIp}:${proxyPort}`;
  const put = runAdb([
    'shell',
    'settings',
    'put',
    'global',
    'http_proxy',
    proxyValue,
  ]);
  if (put.status !== 0) {
    throw new Error(`adb settings put http_proxy failed: ${put.stderr || put.stdout}`);
  }

  const remote = '/sdcard/Download/mox-rootCA.cer';
  const push = runAdb(['push', cer, remote]);
  if (push.status !== 0) {
    throw new Error(`adb push CA failed: ${push.stderr || push.stdout}`);
  }

  const urls = buildDeviceSetupUrls({ lanIp, proxyPort });
  const fp = caFingerprintShort(certPath);
  const catalogHost = opts.catalogHost || '<catalog-https-host>';
  const mitmCheckHint = `https://${catalogHost}/__mox_mitm_check`;

  console.log(`[mox] device prepare ok devices=${devices.join(',')}`);
  console.log(`[mox] http_proxy=${proxyValue}`);
  console.log(`[mox] CA pushed → ${remote} (install as user CA in Settings)`);
  console.log(`[mox] hub ${urls.hub}`);
  console.log(`[mox] App WebView mitm-check: ${mitmCheckHint}`);
  if (fp) console.log(`[mox] CA fingerprint ${fp}…`);
  console.log(
    '[mox] note: does not enter PIN; Cronet/pinning apps that ignore system proxy are out of scope (H1)',
  );

  return {
    ok: true,
    devices,
    proxyValue,
    caRemote: remote,
    mitmCheckHint,
    hub: urls.hub,
    fingerprint: fp,
  };
}

module.exports = { devicePrepare, listDevices };

if (require.main === module) {
  try {
    devicePrepare({
      lanIp: process.env.MOX_LAN_IP || process.argv[2],
      proxyPort: Number(process.env.MOX_PROXY_PORT || process.argv[3] || 18999),
      catalogHost: process.env.MOX_CATALOG_HOST || undefined,
    });
  } catch (e) {
    console.error(`[mox] ${e.message}`);
    process.exit(1);
  }
}
