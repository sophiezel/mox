'use strict';

/**
 * Trust mox MITM CA (desktop) and print phone Hybrid install hints.
 * Usage: mox trust-ca [--open]
 * Also auto-run on first mox start when CA is not yet trusted.
 */

const { spawnSync } = require('child_process');
const {
  ensureCa,
  installTrustedCa,
  formatDeviceCaHints,
  logTrustedCaResult,
} = require('../lib/mitm-ca');
const { lanIp } = require('./start-session');
const { loadDefault } = require('../lib/session-config');

function trustCa(opts = {}) {
  const { certPath } = ensureCa();
  const result = installTrustedCa({
    allowAdminPrompt: opts.allowAdminPrompt !== false,
  });
  logTrustedCaResult(result);

  const defaults = loadDefault();
  const proxyPort = defaults.proxy?.port || 18999;
  const ip = lanIp();
  const proxyDownloadBase = ip
    ? `http://${ip}:${proxyPort}`
    : null;

  console.log('');
  console.log('===【真机】安装同一 CA===');
  for (const line of formatDeviceCaHints(certPath, { proxyDownloadBase })) {
    console.log(`  ${line}`);
  }
  if (!proxyDownloadBase) {
    console.log(
      `  Phone browser: http://<电脑局域网IP>:${proxyPort}/mox/ca.cer（未检测到 LAN IP）`,
    );
  }
  console.log('  Then fully quit Chrome and run: mox start');

  if (opts.open && process.platform === 'darwin') {
    spawnSync('open', ['-R', certPath], { stdio: 'ignore' });
    console.log(`[mox] revealed in Finder: ${certPath}`);
  }

  if (!result.ok && !result.skipped) {
    process.exitCode = 1;
  }
  return result;
}

module.exports = { trustCa };

if (require.main === module) {
  const open = process.argv.includes('--open');
  trustCa({ open });
}
