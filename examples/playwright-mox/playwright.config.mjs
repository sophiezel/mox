/** @type {import('@playwright/test').PlaywrightTestConfig} */
export default {
  testDir: '.',
  timeout: 60_000,
  use: {
    // Point at mox proxy (mox start). Local frontend stays on bypass.
    proxy: {
      server: process.env.MOX_PROXY_URL || 'http://127.0.0.1:18999',
      bypass: 'localhost,127.0.0.1,::1',
    },
    // Do NOT ignore HTTPS errors for MITM — trust mox CA in the OS/keychain instead.
    ignoreHTTPSErrors: false,
  },
};
