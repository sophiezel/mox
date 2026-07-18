# E2E 与真机代理

适用：桌面 Playwright E2E + Hybrid 真机 WebView E2E。业务代码零改。

## 桌面 Playwright

```bash
mox session start --start-url=http://localhost:8080
```

Playwright 配置指向本 CLI proxy：

```js
// playwright.config.js
export default {
  use: {
    proxy: { server: 'http://127.0.0.1:18999' },
  },
};
```

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

## 真机 WebView（Wi‑Fi 手动代理）

1. 电脑与真机同一局域网
2. 启动时 bind 到 LAN：

```bash
mox session start --proxy-host=0.0.0.0 --start-url=http://localhost:8080
# 需要透传未 mock 的上游时：
mox session start --proxy-host=0.0.0.0 --allow-open-proxy
# HTTPS 改写（命中 proxy-rules 的 host）：
mox session start --proxy-host=0.0.0.0 --mitm=1
```

3. 启动日志会打印 `Wi-Fi 代理: <LAN_IP>:<proxyPort>`，在手机 Wi‑Fi → 手动代理 填写该 host/port
4. 手机 WebView 打开 H5，请求自动经本 CLI proxy → mock / 透传

### 安全提示

- **仅信任局域网，勿在公共 Wi‑Fi 开 0.0.0.0**
- 未传 `--allow-open-proxy` 时：`missPolicy` 强制 `reject`，CONNECT 默认拒绝（防开放代理 / SSRF）
- 桌面-only 仍可用 `127.0.0.1`（默认）

## HTTPS 边界

| 模式 | 行为 |
|------|------|
| 默认 | CONNECT **隧道透传**，**不改写** HTTPS 响应 |
| `--mitm=1` | 本地 CA（openssl）对 **proxy-rules 命中 host** 做 MITM；须在桌面/真机信任打印的 CA 路径 |
| 外挂 | Whistle 等做 MITM 后再链到本 CLI |

生产 H5 几乎全是 HTTPS——真机要 mock 响应请用 `--mitm=1` 或 HTTP 调试域。

## CORS / Hybrid WebView

WebView `Origin` 常非 localhost（`null`、自定义 scheme、`https://localhost` 壳）。默认仅放行 localhost。

非 localhost Origin 在 `session.json` 配置：

```json
{
  "cors": {
    "allowLocalhost": true,
    "extraOrigins": ["https://your-h5-host", "*.your-app-scheme"]
  }
}
```

不实现「万能 Origin」；按需显式加。

## Appium 真机 E2E

Appium 驱动 WebView；网络层仍靠手机 Wi‑Fi 代理 → 本 CLI `proxyPort`。`beforeAll` 调 `set-scenario`，与桌面同。
