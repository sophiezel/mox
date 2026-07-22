# E2E 与真机代理

适用：桌面 Playwright E2E + Hybrid 真机 WebView E2E。业务代码零改。

## 桌面 Playwright

```bash
mox start
# 默认打开 http://127.0.0.1:8000；换页用 --start-url=
```

Playwright 配置指向本 CLI proxy：

```js
// playwright.config.js
export default {
  use: {
    proxy: {
      server: 'http://127.0.0.1:18999',
      bypass: 'localhost,127.0.0.1,::1',
    },
  },
};
```

本地页直连、远端 API 走代理。勿对 `127.0.0.1:<devPort>` 做 HTTPS CONNECT（代理会 `connect-deny-loopback`）。

## 桌面浏览器旁路（非 Chromium 自启）

`mox start` 自动拉起的 Chrome/Edge 已带 `--proxy-bypass-list=127.0.0.1;localhost;::1`，且**不含** `ignore-certificate*`（依赖系统信任 CA）。若手填系统代理或用其他浏览器：

| 浏览器 / 方式 | 配置 |
|---------------|------|
| Firefox | `network.proxy.no_proxies_on` = `localhost, 127.0.0.1, ::1`；或系统代理「忽略主机」 |
| Safari | 系统设置 → 网络 → 详细信息 → 代理 → Bypass |
| 系统代理 | 忽略列表含 `localhost,127.0.0.1,::1` |
| `--no-auto-launch` | 启动日志有同一 tip；自行按上表配置 |

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
5. **CA 信任**（MITM 默认开启，电脑与手机同一份 CA）：
   - **iOS**：安装描述文件 → **设置 → 通用 → 关于本机 → 证书信任设置** → 对 `mox Local MITM CA` 打开完全信任
   - **Android**：设置 → 安全 → 安装证书 → CA；注意许多 App/WebView **不信任用户 CA**
6. 手机 WebView 打开 H5，请求经 mox → mock / 透传

已开代理时仍可用绝对 URL 下 CA（pathname 解析兼容）。电脑首次 `mox start` 会自动把 CA 写入 System.keychain（一次管理员密码）；重试用 `mox trust-ca`。

### 安全提示

- **仅信任局域网，勿在公共 Wi‑Fi 使用默认 LAN 绑定**
- `--no-open-proxy`：`missPolicy` 强制 `reject`，CONNECT 默认拒绝（防开放代理 / SSRF）
- 桌面-only：`--proxy-host=127.0.0.1`

## HTTPS 边界

| 模式 | 行为 |
|------|------|
| 默认 MITM | catalog `hosts[]` → `connect-mitm`；电脑系统信任 CA；真机装 `/mox/ca.cer` |
| `--mitm=0` | 本机绑定下未覆盖 host CONNECT 隧道；catalog 不改写 |
| CONNECT 目标为 loopback | **一律拒绝**（`connect-deny-loopback`） |
| LAN + `--no-open-proxy` | CONNECT 默认拒绝（仅 `passthroughHosts`；loopback 目标仍拒绝） |

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
