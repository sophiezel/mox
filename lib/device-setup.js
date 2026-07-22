'use strict';

/**
 * Device onboarding: PAC + QR + hub HTML for phone Wi‑Fi / CA install.
 * Does not claim zero-click system proxy write (OS limitation).
 */

const QRCode = require('qrcode');

function buildDeviceSetupUrls({ lanIp, proxyPort }) {
  const host = String(lanIp || '').trim();
  const port = Number(proxyPort) || 18999;
  if (!host) {
    return {
      hub: null,
      caCer: null,
      pac: null,
      wifiProxy: null,
      lanIp: null,
      proxyPort: port,
    };
  }
  const base = `http://${host}:${port}`;
  return {
    hub: `${base}/mox/`,
    caCer: `${base}/mox/ca.cer`,
    pac: `${base}/mox/proxy.pac`,
    wifiProxy: `${host}:${port}`,
    lanIp: host,
    proxyPort: port,
  };
}

/**
 * PAC: loopback DIRECT (local FE); everything else via mox proxy.
 */
function buildPacScript({ host, port }) {
  const h = String(host || '127.0.0.1');
  const p = Number(port) || 18999;
  return `function FindProxyForURL(url, host) {
  if (isPlainHostName(host)) return "DIRECT";
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return "DIRECT";
  return "PROXY ${h}:${p}; DIRECT";
}
`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {{ urls: object, caQrDataUrl?: string|null, pacQrDataUrl?: string|null }} opts
 */
function buildDeviceHubHtml({ urls, caQrDataUrl = null, pacQrDataUrl = null }) {
  const wifi = escapeHtml(urls.wifiProxy || '');
  const ca = escapeHtml(urls.caCer || '');
  const pac = escapeHtml(urls.pac || '');
  const caImg = caQrDataUrl
    ? `<img alt="CA QR" src="${caQrDataUrl}" width="200" height="200" />`
    : '<p class="muted">QR unavailable</p>';
  const pacImg = pacQrDataUrl
    ? `<img alt="PAC QR" src="${pacQrDataUrl}" width="200" height="200" />`
    : '<p class="muted">QR unavailable</p>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>mox 真机接入</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #111; line-height: 1.45; }
    h1 { font-size: 1.35rem; margin: 0 0 8px; }
    .box { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin: 16px 0; }
    .row { display: flex; flex-wrap: wrap; gap: 24px; }
    .col { flex: 1 1 220px; text-align: center; }
    code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
    .muted { color: #666; font-size: 0.9rem; }
    a.btn { display: inline-block; margin-top: 8px; padding: 8px 12px; background: #111; color: #fff; text-decoration: none; border-radius: 6px; }
    ol { padding-left: 1.2rem; }
  </style>
</head>
<body>
  <h1>mox 真机接入</h1>
  <p class="muted">先装 CA，再设代理。系统无法「扫一码写死手动 HTTP 代理」；可用手动 IP:port 或自动 PAC。</p>

  <div class="box">
    <strong>Wi‑Fi 代理（手动）</strong>
    <div class="mono" style="font-size:1.1rem;margin-top:8px">${wifi || '（无局域网 IP）'}</div>
  </div>

  <div class="box row">
    <div class="col">
      <strong>1. 安装 CA</strong>
      <div style="margin:12px 0">${caImg}</div>
      <div class="mono muted">${ca}</div>
      ${ca ? `<a class="btn" href="${ca}">下载 ca.cer</a>` : ''}
      <p class="muted">iOS：安装后 → 设置 → 通用 → 关于本机 → 证书信任设置 → 打开完全信任<br/>Android：设置 → 安全 → 安装证书 → CA</p>
    </div>
    <div class="col">
      <strong>2. 代理（少手输）</strong>
      <div style="margin:12px 0">${pacImg}</div>
      <div class="mono muted">${pac}</div>
      ${pac ? `<a class="btn" href="${pac}">打开 PAC</a>` : ''}
      <p class="muted">Wi‑Fi → 代理 → <b>自动</b>，填入上方 PAC URL；或选手动填 IP:port</p>
    </div>
  </div>

  <div class="box">
    <strong>推荐顺序</strong>
    <ol>
      <li>用手机浏览器打开本页（或扫电脑终端二维码）</li>
      <li>下载并安装 CA，完成系统信任</li>
      <li>设置 Wi‑Fi 代理（手动 ${wifi || 'IP:port'}，或自动 PAC）</li>
      <li>打开业务 H5 / App WebView 联调</li>
    </ol>
  </div>
</body>
</html>
`;
}

async function qrDataUrl(text) {
  if (!text) return null;
  return QRCode.toDataURL(String(text), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 200,
  });
}

async function printHubQrToTerminal(hubUrl) {
  if (!hubUrl) {
    console.log('[mox] (no LAN IP — skip terminal QR)');
    return;
  }
  const ascii = await QRCode.toString(String(hubUrl), {
    type: 'terminal',
    small: true,
    errorCorrectionLevel: 'M',
  });
  console.log(ascii);
}

module.exports = {
  buildDeviceSetupUrls,
  buildPacScript,
  buildDeviceHubHtml,
  qrDataUrl,
  printHubQrToTerminal,
};
