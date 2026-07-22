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
  });
  assert.match(html, /192\.168\.1\.8:18999/);
  assert.match(html, /mox\/ca\.cer/);
  assert.match(html, /mox\/proxy\.pac/);
  assert.match(html, /data:image\/png;base64,aaa/);
});

test('qrDataUrl returns png data url', async () => {
  const d = await qrDataUrl('http://10.0.0.1:18999/mox/');
  assert.match(d, /^data:image\/png;base64,/);
});
