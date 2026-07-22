'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  ensureCa,
  isCaTrusted,
  installTrustedCa,
  ensureMitmCaReady,
  formatDeviceCaHints,
  readCaDownloadFiles,
  CA_COMMON_NAME,
  caHasKeyCertSign,
} = require('../lib/mitm-ca');

test('ensureCa writes CA pem', () => {
  const { certPath, keyPath } = ensureCa();
  assert.ok(fs.existsSync(certPath));
  assert.ok(fs.existsSync(keyPath));
  assert.match(fs.readFileSync(certPath, 'utf8'), /BEGIN CERTIFICATE/);
});

test('ensureCa CA includes keyCertSign (Android / Whistle-compatible)', () => {
  const { caHasKeyCertSign, ensureCa: ensure } = require('../lib/mitm-ca');
  const { certPath } = ensure({ forceRegen: true });
  assert.equal(caHasKeyCertSign(certPath), true);
  const text = require('child_process')
    .spawnSync('openssl', ['x509', '-in', certPath, '-noout', '-text'], {
      encoding: 'utf8',
    })
    .stdout;
  assert.match(text, /CA:TRUE/);
  assert.match(text, /Cert(?:ificate)? Sign/i);
});

test('isCaTrusted is read-only (no security writes)', () => {
  const calls = [];
  const trusted = isCaTrusted({
    platform: 'darwin',
    runSecurity: (args) => {
      calls.push(args[0]);
      return {
        status: 0,
        stdout: `Cert 0: ${CA_COMMON_NAME}\n`,
        stderr: '',
      };
    },
  });
  assert.equal(trusted, true);
  assert.ok(calls.every((c) => c === 'dump-trust-settings'));
  assert.ok(!calls.includes('add-trusted-cert'));
  assert.ok(!calls.includes('delete-certificate'));
});

test('isCaTrusted false when not listed', () => {
  assert.equal(
    isCaTrusted({
      platform: 'darwin',
      runSecurity: () => ({ status: 0, stdout: 'Cert 0: other\n', stderr: '' }),
    }),
    false,
  );
});

test('ensureMitmCaReady returns already when trusted (no install)', () => {
  let admin = 0;
  const result = ensureMitmCaReady({
    platform: 'darwin',
    runSecurity: (args) => {
      if (args[0] === 'dump-trust-settings') {
        return { status: 0, stdout: `Cert 0: ${CA_COMMON_NAME}\n`, stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected write' };
    },
    runOsascript: () => {
      admin += 1;
      return { status: 1, stdout: '', stderr: 'no' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.already, true);
  assert.equal(admin, 0);
});

test('ensureMitmCaReady installs via login keychain', () => {
  let trusted = false;
  const result = ensureMitmCaReady({
    platform: 'darwin',
    allowAdminPrompt: false,
    allowGuidedUi: false,
    runSecurity: (args) => {
      if (args[0] === 'dump-trust-settings') {
        return trusted
          ? { status: 0, stdout: `Cert 0: ${CA_COMMON_NAME}\n`, stderr: '' }
          : { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'delete-certificate') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'add-trusted-cert') {
        trusted = true;
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.already, false);
  assert.equal(result.via, 'login');
});

test('ensureMitmCaReady installs via admin when login fails', () => {
  let trusted = false;
  const result = ensureMitmCaReady({
    platform: 'darwin',
    allowGuidedUi: false,
    runSecurity: (args) => {
      if (args[0] === 'dump-trust-settings') {
        return trusted
          ? { status: 0, stdout: `Cert 0: ${CA_COMMON_NAME}\n`, stderr: '' }
          : { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'delete-certificate') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'add-trusted-cert') {
        return { status: 1, stdout: '', stderr: 'auth denied' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    },
    runOsascript: () => {
      trusted = true;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.already, false);
  assert.equal(result.viaAdmin, true);
  assert.equal(result.via, 'system');
});

test('installTrustedCa fails cleanly when no path sticks', () => {
  const result = installTrustedCa({
    platform: 'darwin',
    allowGuidedUi: false,
    runSecurity: () => ({ status: 0, stdout: 'Cert 0: whistle\n', stderr: '' }),
    runOsascript: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /trust settings|Always Trust|guided/i);
});

test('installTrustedCa guided Keychain UI succeeds after Enter', () => {
  let trusted = false;
  let opened = null;
  let waited = false;
  const result = installTrustedCa({
    platform: 'darwin',
    allowAdminPrompt: false,
    forceGuidedPrompt: true,
    runSecurity: (args) => {
      if (args[0] === 'dump-trust-settings') {
        return trusted
          ? { status: 0, stdout: `Cert 0: ${CA_COMMON_NAME}\n`, stderr: '' }
          : { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'delete-certificate') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'add-trusted-cert') {
        return { status: 1, stdout: '', stderr: 'auth denied' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    },
    runOpen: (args) => {
      opened = args[0];
      return { status: 0 };
    },
    waitForEnter: () => {
      waited = true;
      trusted = true;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'keychain-ui');
  assert.ok(opened && String(opened).endsWith('.cer'));
  assert.equal(waited, true);
});

test('readCaDownloadFiles returns pem and der', () => {
  const { pem, der, certPath } = readCaDownloadFiles();
  assert.ok(fs.existsSync(certPath));
  assert.match(pem.toString('utf8'), /BEGIN CERTIFICATE/);
  assert.ok(Buffer.isBuffer(der));
  assert.ok(der.length > 100);
});

test('formatDeviceCaHints includes download URL when provided', () => {
  const text = formatDeviceCaHints('/tmp/ca.pem', {
    proxyDownloadBase: 'http://192.168.1.2:18999',
  }).join('\n');
  assert.match(text, /mox\/ca\.cer/);
  assert.match(text, /iOS/);
  assert.match(text, /mox trust-ca/);
});
