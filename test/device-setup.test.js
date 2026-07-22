'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDeviceSetupUrls,
  buildPacScript,
  buildDeviceHubHtml,
  qrDataUrl,
} = require('../lib/device-setup');

test('buildDeviceSetupUrls uses real LAN and port', () => {
  const u = buildDeviceSetupUrls({ lanIp: '10.112.115.51', proxyPort: 18999 });
  assert.equal(u.wifiProxy, '10.112.115.51:18999');
  assert.equal(u.hub, 'http://10.112.115.51:18999/mox/');
  assert.equal(u.caCer, 'http://10.112.115.51:18999/mox/ca.cer');
  assert.equal(u.pac, 'http://10.112.115.51:18999/mox/proxy.pac');
});

test('buildDeviceSetupUrls null when no lanIp', () => {
  const u = buildDeviceSetupUrls({ lanIp: null, proxyPort: 18999 });
  assert.equal(u.hub, null);
  assert.equal(u.caCer, null);
});

test('buildPacScript proxies non-loopback', () => {
  const pac = buildPacScript({ host: '10.1.2.3', port: 18999 });
  assert.match(pac, /FindProxyForURL/);
  assert.match(pac, /PROXY 10\.1\.2\.3:18999/);
  assert.match(pac, /localhost/);
  assert.match(pac, /DIRECT/);
});

test('buildDeviceHubHtml embeds urls and optional QR', () => {
  const urls = buildDeviceSetupUrls({ lanIp: '192.168.1.8', proxyPort: 18999 });
  const html = buildDeviceHubHtml({
    urls,
    caQrDataUrl: 'data:image/png;base64,aaa',
    pacQrDataUrl: 'data:image/png;base64,bbb',
    caFingerprint: 'A552CE4B4C8294DC',
  });
  assert.match(html, /192\.168\.1\.8:18999/);
  assert.match(html, /mox\/ca\.cer/);
  assert.match(html, /mox\/proxy\.pac/);
  assert.match(html, /data:image\/png;base64,aaa/);
  assert.match(html, /A552CE4B4C8294DC/);
  assert.match(html, /__mox_mitm_check/);
  assert.match(html, /\.mox\/certs/);
});

test('buildDeviceHubHtml mentions App WebView mitm-check', () => {
  const urls = buildDeviceSetupUrls({ lanIp: '10.0.0.2', proxyPort: 18999 });
  const html = buildDeviceHubHtml({ urls, caFingerprint: 'DEADBEEF' });
  assert.match(html, /App WebView/i);
  assert.match(html, /__mox_mitm_check/);
});

test('qrDataUrl returns png data url', async () => {
  const d = await qrDataUrl('http://10.0.0.1:18999/mox/');
  assert.match(d, /^data:image\/png;base64,/);
});

test('writeHubQrPng writes square png file', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { writeHubQrPng } = require('../lib/device-setup');
  const out = path.join(os.tmpdir(), `mox-hub-qr-${Date.now()}.png`);
  try {
    const p = await writeHubQrPng('http://10.0.0.1:18999/mox/', out);
    assert.equal(p, out);
    assert.ok(fs.existsSync(out));
    assert.ok(fs.statSync(out).size > 80);
    // PNG magic
    const buf = fs.readFileSync(out);
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50);
  } finally {
    try {
      fs.unlinkSync(out);
    } catch {
      /* ignore */
    }
  }
});

test('writeInlineTerminalImage emits OSC 1337 payload', () => {
  const { writeInlineTerminalImage } = require('../lib/device-setup');
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (c) => {
    chunks.push(Buffer.isBuffer(c) ? c.toString('utf8') : String(c));
    return true;
  };
  try {
    const ok = writeInlineTerminalImage(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
      widthCells: 12,
    });
    assert.equal(ok, true);
    const out = chunks.join('');
    assert.match(out, /\x1b\]1337;File=inline=1/);
    assert.match(out, /width=12/);
  } finally {
    process.stdout.write = orig;
  }
});
