# Playwright + mox（可复制样板）

无业务仓硬编码：先起 mox，再让 Playwright 走同一 proxy。

## 1. 启动 mock 代理

```bash
mox start --no-auto-launch
# 默认 proxy http://127.0.0.1:18999
mox set-scenario e2e-happy
mox quality-gate   # exit 0 才提测（零溢出口径）
```

## 2. Playwright 配置

见同目录 `playwright.config.mjs`：`use.proxy.server` 指向 mox；`bypass` 本地前端。

## 3. 用例里切场景

见 `example.spec.mjs`：`beforeAll` / `afterAll` 调 `mox set-scenario`。

## 4. Hybrid

真机走系统 Wi‑Fi HTTP 代理 + 用户 CA；提测建议：

```bash
mox quality-gate --require-mitm-check=https://<catalog-host>/__mox_mitm_check
```

详见 `references/e2e-and-device-proxy.md`。
