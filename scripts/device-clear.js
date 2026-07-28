'use strict';

/**
 * mox device clear — force-clear Android Global http_proxy + delete mox lease.
 * WARNING: clears whatever global proxy is set (including Whistle), not only mox's.
 */

const {
  forceClearDeviceHttpProxy,
  CLEAR_FAILED,
} = require('../lib/device-proxy');

function deviceClear(opts = {}) {
  console.log(
    '[mox] WARN: device clear empties global http_proxy on the phone (not only mox) — re-set Whistle/Wi-Fi after if needed',
  );
  const out = forceClearDeviceHttpProxy(opts);
  if (!out.ok) {
    const err = new Error(out.error || CLEAR_FAILED);
    err.code = out.code || CLEAR_FAILED;
    err.result = out;
    throw err;
  }
  return out;
}

module.exports = { deviceClear };

if (require.main === module) {
  try {
    deviceClear({});
  } catch (e) {
    console.error(`[mox] ${e.message}`);
    process.exit(1);
  }
}
