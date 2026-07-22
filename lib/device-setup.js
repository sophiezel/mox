'use strict';

/**
 * Device onboarding: PAC + QR + hub HTML for phone Wi‑Fi / CA install.
 * Does not claim zero-click system proxy write (OS limitation).
 */

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { getDataRoot } = require('./paths');

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
 * @param {{ urls: object, caQrDataUrl?: string|null, pacQrDataUrl?: string|null, caFingerprint?: string|null }} opts
 */
function buildDeviceHubHtml({
  urls,
  caQrDataUrl = null,
  pacQrDataUrl = null,
  caFingerprint = null,
} = {}) {
  const wifi = escapeHtml(urls.wifiProxy || '');
  const ca = escapeHtml(urls.caCer || '');
  const pac = escapeHtml(urls.pac || '');
  const fp = escapeHtml(caFingerprint || '');
  const caImg = caQrDataUrl
    ? `<img alt="CA QR" src="${caQrDataUrl}" width="120" height="120" />`
    : '<p class="muted">QR unavailable</p>';
  const pacImg = pacQrDataUrl
    ? `<img alt="PAC QR" src="${pacQrDataUrl}" width="120" height="120" />`
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
    .warn { background: #fff8e6; border-color: #e6c200; }
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
      ${fp ? `<div class="mono" style="margin-top:8px">指纹 ${fp}…</div>` : ''}
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

  <div class="box warn">
    <strong>如何确认 CA 真正生效</strong>
    <p class="muted" style="margin:8px 0 0"><b>必须在 App WebView 内</b>打开 catalog HTTPS 域名下的 <code>/__mox_mitm_check</code>（系统浏览器绿盾不够）。应返回 <code>{"ok":true,"fingerprintShort":"${fp || '…'}"}</code>。业务页（如 ping-fe）可能透传真实证书，绿盾不代表 MITM CA 生效。</p>
    <p class="muted" style="margin:8px 0 0">根证书在本机 <code>~/.mox/certs</code>，一般不会随 <code>mox start</code> 轮换。只有显式 <code>MOX_FORCE_REGEN_CA=1</code> 后才需删旧证重装。</p>
  </div>

  <div class="box">
    <strong>推荐顺序</strong>
    <ol>
      <li>用手机浏览器打开本页（或扫电脑上的正方形 PNG 二维码）</li>
      <li>下载 CA → 设置 → 安全 → 从存储设备安装 → CA 证书（不要指望浏览器直接「安装」）</li>
      <li>设置 Wi‑Fi 代理（手动 ${wifi || 'IP:port'}，或自动 PAC）</li>
      <li>在 <b>App WebView</b> 打开 <code>/__mox_mitm_check</code> 自证，再打开业务 H5</li>
    </ol>
  </div>
</body>
</html>
`;
}

async function qrDataUrl(text) {
  if (!text) return null;
  return QRCode.toDataURL(String(text), {
    errorCorrectionLevel: 'L',
    margin: 1,
    width: 120,
  });
}

/** Absolute path for the square hub QR PNG under .data/ */
function hubQrPngPath() {
  return path.join(getDataRoot(), 'device-hub-qr.png');
}

/**
 * Write a real square PNG (terminal glyph QR cannot be square: cell height > width).
 * @returns {Promise<string|null>} png path
 */
async function writeHubQrPng(hubUrl, outPath = hubQrPngPath()) {
  if (!hubUrl) return null;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await QRCode.toFile(outPath, String(hubUrl), {
    type: 'png',
    errorCorrectionLevel: 'L',
    margin: 1,
    width: 160,
  });
  return outPath;
}

/**
 * Detect terminals that can render inline images (iTerm2 protocol).
 * VS Code / Cursor need terminal.integrated.enableImages=true.
 */
function supportsInlineTerminalImage() {
  if (process.env.MOX_INLINE_QR === '0') return false;
  if (process.env.MOX_INLINE_QR === '1') return true;
  if (!process.stdout.isTTY) return false;
  const prog = String(process.env.TERM_PROGRAM || '').toLowerCase();
  const term = String(process.env.TERM || '').toLowerCase();
  if (
    prog === 'iterm.app' ||
    prog === 'vscode' || // Cursor / VS Code
    prog === 'wezterm' ||
    prog === 'ghostty' ||
    prog === 'warpterminal' ||
    process.env.WT_SESSION ||
    process.env.KITTY_WINDOW_ID
  ) {
    return true;
  }
  // Conservative: still try on real TTY (many modern terminals accept OSC 1337)
  return Boolean(term && term !== 'dumb');
}

/**
 * Emit iTerm2 inline image (OSC 1337) — real bitmap, stays square.
 * @param {Buffer} pngBuf
 * @param {{ widthCells?: number }} [opts]
 * @returns {boolean}
 */
function writeInlineTerminalImage(pngBuf, opts = {}) {
  if (!Buffer.isBuffer(pngBuf) || !pngBuf.length) return false;
  const widthCells = Math.max(8, Number(opts.widthCells) || 18);
  const b64 = pngBuf.toString('base64');
  // iTerm2 / VS Code / Cursor: File=inline=1
  const seq =
    `\x1b]1337;File=inline=1;size=${pngBuf.length};` +
    `width=${widthCells};height=auto;preserveAspectRatio=1:${b64}\x07`;
  process.stdout.write(seq);
  if (!seq.endsWith('\n')) process.stdout.write('\n');
  return true;
}

/**
 * Print hub QR for phone scan: inline square PNG in terminal when supported,
 * always also write `.data/device-hub-qr.png`.
 */
async function printHubQrToTerminal(hubUrl) {
  if (!hubUrl) {
    console.log('[mox] (no LAN IP — skip hub QR)');
    return null;
  }
  const pngPath = await writeHubQrPng(hubUrl);
  const pngBuf = fs.readFileSync(pngPath);

  let inlined = false;
  if (supportsInlineTerminalImage()) {
    try {
      inlined = writeInlineTerminalImage(pngBuf, { widthCells: 18 });
    } catch {
      inlined = false;
    }
  }

  console.log(`  ${pngPath}`);
  if (!inlined) {
    console.log(
      '  （若终端未显示图片：Cursor/VS Code 开启 terminal.integrated.enableImages）',
    );
  }
  return pngPath;
}

module.exports = {
  buildDeviceSetupUrls,
  buildPacScript,
  buildDeviceHubHtml,
  qrDataUrl,
  hubQrPngPath,
  writeHubQrPng,
  supportsInlineTerminalImage,
  writeInlineTerminalImage,
  printHubQrToTerminal,
};
