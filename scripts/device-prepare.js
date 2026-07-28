'use strict';

/**
 * mox device prepare — push CA + print install / mitm hints only.
 * Does NOT set Global http_proxy (use: mox start --device).
 */

const fs = require('fs');
const { ensureCa, ensureCaCerFile, caFingerprintShort } = require('../lib/mitm-ca');
const { buildDeviceSetupUrls } = require('../lib/device-setup');
const {
  defaultRunAdb,
  listTargetSerials,
  CA_REMOTE,
} = require('../lib/device-proxy');

/**
 * @param {object} opts
 * @param {string} [opts.lanIp] for hub / CA URL hints only
 * @param {number} [opts.proxyPort]
 * @param {string} [opts.catalogHost]
 * @param {(args: string[]) => {status:number,stdout:string,stderr:string}} [opts.runAdb]
 */
function devicePrepare(opts = {}) {
  console.log(
    '[mox] BANNER: device prepare does NOT set http_proxy — use: mox start --device',
  );

  const runAdb = typeof opts.runAdb === 'function' ? opts.runAdb : defaultRunAdb;
  const lanIp = String(opts.lanIp || '').trim();
  const proxyPort = Number(opts.proxyPort || 18999);

  const serials = listTargetSerials(runAdb);

  const ca = ensureCa({});
  const certPath = ca.certPath || ca.caCertPath;
  const cer = ensureCaCerFile(certPath);
  if (!cer || !fs.existsSync(cer)) {
    throw new Error('device prepare: CA .cer missing');
  }

  for (const serial of serials) {
    const push = runAdb(['-s', serial, 'push', cer, CA_REMOTE]);
    if (push.status !== 0) {
      throw new Error(
        `adb push CA failed (${serial}): ${push.stderr || push.stdout}`,
      );
    }
  }

  const urls = buildDeviceSetupUrls({
    lanIp: lanIp || null,
    proxyPort,
  });
  const fp = caFingerprintShort(certPath);
  const catalogHost = opts.catalogHost || '<catalog-https-host>';
  const mitmCheckHint = `https://${catalogHost}/__mox_mitm_check`;

  console.log(`[mox] device prepare ok devices=${serials.join(',')} (CA only)`);
  console.log(`[mox] CA pushed → ${CA_REMOTE} (install as user CA in Settings)`);
  if (urls.hub) console.log(`[mox] hub ${urls.hub}`);
  else if (!lanIp) {
    console.log(
      '[mox] tip: pass --lan-ip=<LAN> to print hub / CA URL; proxy still via mox start --device',
    );
  }
  console.log(`[mox] App WebView mitm-check (after start --device): ${mitmCheckHint}`);
  if (fp) console.log(`[mox] CA fingerprint ${fp}…`);
  console.log(
    '[mox] note: does not enter PIN; Cronet/pinning apps that ignore system proxy are out of scope (H1)',
  );

  return {
    ok: true,
    devices: serials,
    caRemote: CA_REMOTE,
    mitmCheckHint,
    hub: urls.hub,
    fingerprint: fp,
    httpProxySet: false,
  };
}

module.exports = { devicePrepare, listDevices: listTargetSerials };

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
