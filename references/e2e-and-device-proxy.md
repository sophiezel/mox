# E2E 与真机代理

适用：桌面 Playwright E2E + Hybrid 真机 WebView E2E。业务代码零改。

## 桌面 Playwright

可复制样板：[`examples/playwright-mox/`](../examples/playwright-mox/)（config + `set-scenario` + `quality-gate`）。

```bash
mox start
mox set-scenario e2e-happy
mox quality-gate
# 默认不弹 Chrome；需要时：mox start --open 或 mox open
# 换页用 --start-url=
```

Playwright 配置指向本 CLI proxy：

```js
// playwright.config.js — 或复制 examples/playwright-mox/playwright.config.mjs
export default {
  use: {
    proxy: {
      server: 'http://127.0.0.1:18999',
      bypass: 'localhost,127.0.0.1,::1',
    },
  },
};
```

提测口径（Z1）：`mox quality-gate` **exit 0** 才允许宣称可提测；不是字面「0 bug」。

Hybrid 提测建议带可见性旗标（H1）：

```bash
mox quality-gate --require-mitm-check=https://<catalog-host>/__mox_mitm_check
```

探针非 ok → exit 1。桌面可不传。前提：App 走系统 Wi‑Fi HTTP 代理且信任用户 CA；Cronet/钉扎非目标。

本地页直连、远端 API 走代理。勿对 `127.0.0.1:<devPort>` 做 HTTPS CONNECT（代理会 `connect-deny-loopback`）。

## 桌面浏览器旁路（非 Chromium 自启）

`mox start` 自动拉起的 Chrome/Edge 已带 `--proxy-bypass-list=127.0.0.1;localhost;::1`，且**不含** `ignore-certificate*`（依赖系统信任 CA）。若手填系统代理或用其他浏览器：

| 浏览器 / 方式 | 配置 |
|---------------|------|
| Firefox | `network.proxy.no_proxies_on` = `localhost, 127.0.0.1, ::1`；或系统代理「忽略主机」 |
| Safari | 系统设置 → 网络 → 详细信息 → 代理 → Bypass |
| 系统代理 | 忽略列表含 `localhost,127.0.0.1,::1` |
| 默认不弹窗 / `mox open` | 启动日志有同一 tip；自行按上表配置；需要专用 Chrome：`mox start --open` 或 `mox open` |

原则：本地开发服 **直连**；远端 API **走 mox proxy**。

用例切场景：

```js
import { execSync } from 'node:child_process';

test.beforeAll(() => {
  execSync('mox set-scenario e2e-fault');
});
test.afterAll(() => {
  execSync('mox set-scenario e2e-happy');
});
```

## 真机 WebView（扫码接入：CA + 代理）

**现实约束**：系统 Wi‑Fi「手动 HTTP 代理」没有跨厂商「扫一码写死 host:port」的标准能力。本工具做到：扫码装 CA + PAC URL 少手输；不承诺零点击写入手动代理。

1. 电脑与真机同一局域网
2. 日常直接启动（默认 `0.0.0.0` + 开放 CONNECT，同 Whistle）：

```bash
mox start
# 仅本机：--proxy-host=127.0.0.1
# 收紧 LAN CONNECT：--no-open-proxy
```

3. 启动日志打印 `Wi-Fi 代理`、`接入页`、`CA`、`PAC`，并 **在终端内联显示正方形 PNG 扫码图**（iTerm2 协议；Cursor/VS Code 需 `terminal.integrated.enableImages: true`），同时落盘 `.data/device-hub-qr.png`
4. 手机打开接入页 `http://<LAN>:<port>/mox/`（或扫终端内联图 / PNG 文件）：
   - **先装 CA**：页内 QR / 按钮 → `/mox/ca.cer`
   - **再设代理**：选手动填 `IP:port`，或 Wi‑Fi「自动/PAC」扫码/粘贴 `/mox/proxy.pac`（比手敲 IP:port 稳）
5. **CA 信任**（MITM 默认开启；根证书在本机 `~/.mox/certs`，跨项目稳定，一般不随 `mox start` 轮换）：
   - **iOS**：安装描述文件 → **设置 → 通用 → 关于本机 → 证书信任设置** → 对 `mox Local MITM CA` 打开完全信任
   - **Android**：设置 → 安全 → **从存储设备安装** → CA 证书（不要指望浏览器内「直接安装」）
   - **自证（以它为准，不以业务页绿盾为准）**：设好代理后，用手机打开任一 **catalog HTTPS 域名** 的 `https://<host>/__mox_mitm_check`，应返回 `{"ok":true,"fingerprintShort":"…"}`。业务页（如未进 catalog 的 ping-fe）可能透传真实证书，绿盾 ≠ MITM CA 已生效。
   - 仅当显式 `MOX_FORCE_REGEN_CA=1` / `mox ca rotate` 后才需删旧证重装；日常指纹不变。
6. 手机 WebView 打开 H5，请求经 mox → mock / 透传

已开代理时仍可用绝对 URL 下 CA（pathname 解析兼容）。电脑首次 `mox start` 会自动把 CA 写入 System.keychain（一次管理员密码）；重试用 `mox trust-ca`。单测用 `MOX_MITM_DIR` 临时目录，不会改写 `~/.mox/certs`。

### 安全提示

- **仅信任局域网，勿在公共 Wi‑Fi 使用默认 LAN 绑定**
- `--no-open-proxy`：`missPolicy` 强制 `reject`，CONNECT 默认拒绝（防开放代理 / SSRF）；**Cronet UA** 对 catalog host 仍强制 tunnel（对齐 Whistle，不 MITM）
- 桌面-only：`--proxy-host=127.0.0.1`

## HTTPS 边界

| 模式 | 行为 |
|------|------|
| 默认 MITM | catalog `hosts[]` → `connect-mitm`；根 CA `~/.mox/certs/root.{key,crt}`；真机装 `/mox/ca.cer`（`mox-rootCA.cer`） |
| 自证 | MITM 桥 `GET /__mox_mitm_check`（或 `/mox/mitm-check`）→ `ok` + 指纹 |
| Cronet | UA 含 `Cronet` → 不 MITM，强制 tunnel |
| `--mitm=0` | 本机绑定下未覆盖 host CONNECT 隧道；catalog 不改写 |
| CONNECT 目标为 loopback | **一律拒绝**（`connect-deny-loopback`） |
| LAN + `--no-open-proxy` | CONNECT 默认拒绝（仅 `passthroughHosts`；Cronet catalog 仍 tunnel；loopback 目标仍拒绝） |

生产 H5 几乎全是 HTTPS——真机要 mock 须安装 CA（或 HTTP 调试域）。
## CORS / Hybrid WebView

默认 **`cors.reflectOrigin: true`**：本地 proxy/mock 回显请求 `Origin`（任意 H5 域，不硬编码业务域名），远程页跨域 mock 可直接用。

需要旧白名单时：

```json
{
  "cors": {
    "reflectOrigin": false,
    "allowLocalhost": true,
    "extraOrigins": ["https://your-h5-host", "*.your-app-scheme"]
  }
}
```

不使用 `Access-Control-Allow-Origin: *`（credentials 需回显具体 Origin）。

## Appium 真机 E2E

Appium 驱动 WebView；网络层仍靠手机 Wi‑Fi 代理 → 本 CLI `proxyPort`。`beforeAll` 调 `set-scenario`，与桌面同。
