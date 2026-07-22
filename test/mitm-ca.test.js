'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

/** forceRegen must never touch ~/.mox/certs (phone trust fingerprint). */
function withTempMitmDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mox-mitm-'));
  const prev = process.env.MOX_MITM_DIR;
  process.env.MOX_MITM_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.MOX_MITM_DIR;
    else process.env.MOX_MITM_DIR = prev;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

test('ensureCaCerFile writes sibling .cer without clobbering root.crt', () => {
  withTempMitmDir(() => {
    const { ensureCa, ensureCaCerFile } = require('../lib/mitm-ca');
    const { certPath } = ensureCa({ forceRegen: true });
    assert.match(fs.readFileSync(certPath, 'utf8'), /BEGIN CERTIFICATE/);
    const cer = ensureCaCerFile(certPath);
    assert.ok(cer.endsWith('.cer'));
    assert.notEqual(cer, certPath);
    assert.match(fs.readFileSync(certPath, 'utf8'), /BEGIN CERTIFICATE/);
    assert.doesNotMatch(fs.readFileSync(cer).toString('utf8'), /BEGIN CERTIFICATE/);
  });
});

test('ensureCa writes CA pem', () => {
  withTempMitmDir(() => {
    const { certPath, keyPath } = ensureCa();
    assert.ok(fs.existsSync(certPath));
    assert.ok(fs.existsSync(keyPath));
    assert.match(fs.readFileSync(certPath, 'utf8'), /BEGIN CERTIFICATE/);
  });
});

test('ensureCa CA includes keyCertSign (Android / Whistle-compatible)', () => {
  withTempMitmDir(() => {
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

test('ensureMitmCaReady re-installs when CA was regenerated', () => {
  withTempMitmDir(() => {
    let installCalls = 0;
    const result = ensureMitmCaReady({
      platform: 'darwin',
      forceRegen: true,
      allowAdminPrompt: false,
      allowGuidedUi: false,
      runSecurity: (args) => {
        if (args[0] === 'dump-trust-settings') {
          // Old CN still listed — must NOT skip install after regen
          return { status: 0, stdout: `Cert 0: ${CA_COMMON_NAME}\n`, stderr: '' };
        }
        if (args[0] === 'delete-certificate') {
          return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'add-trusted-cert') {
          installCalls += 1;
          return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'no' };
      },
    });
    assert.equal(result.regenerated, true);
    assert.equal(result.ok, true);
    assert.ok(installCalls >= 1);
  });
});

test('resolveOpensslBin finds a working openssl', () => {
  const { resolveOpensslBin } = require('../lib/mitm-ca');
  const bin = resolveOpensslBin();
  assert.ok(bin);
  assert.equal(
    require('child_process').spawnSync(bin, ['version'], { encoding: 'utf8' })
      .status,
    0,
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
  withTempMitmDir(() => {
    const { pem, der, certPath } = readCaDownloadFiles();
    assert.ok(fs.existsSync(certPath));
    assert.match(pem.toString('utf8'), /BEGIN CERTIFICATE/);
    assert.ok(Buffer.isBuffer(der));
    assert.ok(der.length > 100);
  });
});

test('ca download DER does not need openssl (Node crypto)', () => {
  withTempMitmDir(() => {
    const { pemCertToDer, derHasKeyCertSign, ensureCa } = require('../lib/mitm-ca');
    const { X509Certificate } = require('crypto');
    const { certPath } = ensureCa();
    const der = pemCertToDer(certPath);
    assert.equal(
      Buffer.compare(der, new X509Certificate(fs.readFileSync(certPath)).raw),
      0,
    );
    assert.equal(derHasKeyCertSign(der), true);
  });
});

test('ensureCa keeps existing CA when openssl unavailable', () => {
  withTempMitmDir(() => {
    const { certPath } = ensureCa();
    const before = fs.readFileSync(certPath);
    const result = ensureCa({
      forceRegen: true,
      resolveOpensslBin: () => null,
    });
    assert.equal(result.regenerated, false);
    assert.equal(Buffer.compare(before, fs.readFileSync(certPath)), 0);
  });
});

test('formatDeviceCaHints includes download URL when provided', () => {
  const text = formatDeviceCaHints('/tmp/ca.pem', {
    proxyDownloadBase: 'http://192.168.1.2:18999',
  }).join('\n');
  assert.match(text, /mox\/ca\.cer/);
  assert.match(text, /iOS/);
  assert.match(text, /mox trust-ca/);
});

test('ensureCa second call does not regenerate (Whistle-like persist)', () => {
  withTempMitmDir(() => {
    const {
      ensureCa: ensure,
      caFingerprintShort,
      rootCertPath,
    } = require('../lib/mitm-ca');
    const first = ensure({ forceRegen: true });
    assert.equal(first.regenerated, true);
    const fp1 = caFingerprintShort(first.certPath);
    const second = ensure();
    assert.equal(second.regenerated, false);
    assert.equal(caFingerprintShort(second.certPath), fp1);
    assert.equal(path.basename(rootCertPath()), 'root.crt');
    assert.ok(String(rootCertPath()).includes(process.env.MOX_MITM_DIR));
  });
});

test('hostCert leaves live under hosts/<fp>/; regen clears leaf cache', () => {
  withTempMitmDir((dir) => {
    const {
      ensureCa: ensure,
      hostCert,
      caFingerprintShort,
      leafMatchesCa,
    } = require('../lib/mitm-ca');
    const { certPath } = ensure({ forceRegen: true });
    const fp1 = caFingerprintShort(certPath);
    assert.ok(fp1);
    hostCert('api.example.test');
    const hostsRoot = path.join(dir, 'hosts');
    assert.ok(fs.existsSync(hostsRoot));
    const buckets = fs.readdirSync(hostsRoot);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0], fp1);
    const leafPath = path.join(hostsRoot, buckets[0], 'api.example.test.cert.pem');
    assert.ok(fs.existsSync(leafPath));
    assert.equal(leafMatchesCa(leafPath, certPath), true);

    const after = ensure({ forceRegen: true });
    assert.equal(after.regenerated, true);
    assert.notEqual(caFingerprintShort(after.certPath), fp1);
    assert.equal(fs.existsSync(leafPath), false);
    hostCert('api.example.test');
    const buckets2 = fs.readdirSync(hostsRoot);
    assert.equal(buckets2.length, 1);
    assert.equal(buckets2[0], caFingerprintShort(after.certPath));
    assert.equal(
      leafMatchesCa(
        path.join(hostsRoot, buckets2[0], 'api.example.test.cert.pem'),
        after.certPath,
      ),
      true,
    );
  });
});

test('defaultUserMitmDir is ~/.mox/certs', () => {
  const { defaultUserMitmDir } = require('../lib/mitm-ca');
  assert.equal(
    defaultUserMitmDir(),
    path.join(os.homedir(), '.mox', 'certs'),
  );
});
