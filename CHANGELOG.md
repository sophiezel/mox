# Changelog

## Unreleased

### Added
- `mox device prepare`：ADB 设 `http_proxy`、push CA、打印 App WebView `__mox_mitm_check`（不输 PIN；H1）。
- `quality-gate --require-mitm-check=<url>`：Hybrid 可见性探针。
- Scenario `requiredStubs`：缺失/空 stub 时 `set-scenario` / `quality-gate` 失败。
- `mox quality-gate`：提测门禁（空/TRACE_EMPTY → exit 1；写 `.data/reports/quality-gate-*.json`）。零溢出口径 = gate exit 0。
- `proxy.captureMitmHosts`：`capture-open` 下对名单 host 做 MITM（无需 path rule）；`map import` 自动并入。
- `serveCaptureIfEmpty`（默认关）：空 stub 可只读回放合格 capture，不写合同 / 不 `captureMerge`。
- `mox map import <file>`：Whistle 两列 Map → `trafficMode=selective` + allowlist + 增量 `proxy-rules`；`127.0.0.1` 表示走本地 mock。
- `--rules` 同样接受 `rules/<name>.txt` Whistle map（与 `.json` stub 包并列；同名优先 `.json`），启动即可，不必先 `map import`。
- `--rules=a,b`（或空格多值）merge 多个 rule；找不到的 keyword 跳过，不中断启动。
- Upstream failure journal：MITM 透传连接失败与 HTTP≥400 追加 `.data/reports/upstream-failures.jsonl`（不 merge 合同）。
- Playwright 样板：`examples/playwright-mox/`。

### Breaking
- **命名统一**：`proxy.mode=capture-open`（原 `record-first`）；CLI `mox start --capture-open`（原 `--record`）；`proxy.captureMitmHosts`（原 `recordMitmHosts`）。已移除 `mox record` 短命令，纯全透传只用 `mox traffic all-passthrough`。
- **mock-lab 空 mock 门禁**：`proxy.mode=mock-lab` 下成功信封 `data:{}`/`null` 或 `gap:TRACE_EMPTY` 返回 **HTTP 503**（附 `gap`），禁止假成功。逃生：`MOX_ALLOW_EMPTY_MOCK=1` 或 `proxy.mode=capture-open`。
- **`--capture-open` ≠ 全透传**：只打开/加宽 MITM 落盘（默认仍 mock 门闸）。纯全透传请用 `mox traffic all-passthrough` 或 `--traffic=all-passthrough`。

### Changed
- Session 增加 `proxy.mode`：`mock-lab`（默认）| `capture-open`；`capture-open` + MITM 明文时 `shouldWriteCapture` 可越过 `captureScope=catalog`（噪声 denylist 仍生效）。

### Changed
- **MITM 根证书迁至 `~/.mox/certs/root.{key,crt}`**（Whistle 同款用户级持久化）；有效则不重签；可从项目 `.data/mitm` **复制迁移**（不换指纹）。测例仅用 `MOX_MITM_DIR`。
- CA 下载对齐 Whistle：`/mox/ca.cer` → `application/pkix-cert` + `mox-rootCA.cer`；`/mox/ca.crt` → `application/x-x509-ca-cert`。
- 叶子证书按根指纹分桶 `hosts/<fp>/`；根轮换清叶子与 SecureContext 缓存。
- CONNECT：UA 含 `Cronet` 时强制 tunnel（不 MITM），日志 `connect-tunnel-cronet`。
- 真机自证：MITM 桥 `GET /__mox_mitm_check`（或 `/mox/mitm-check`）返回 `ok`+指纹；hub/启动提示以它为准，不以业务页绿盾为准。

### Changed
- **默认开启 MITM**；日常 `mox start`（默认打开 `http://127.0.0.1:8000`）；`--mitm=0` 关闭。
- 去掉一切 Chromium `ignore-certificate*` / `spki-list`；依赖 macOS trust settings（login / System / Keychain Always Trust）。
- 首次 `mox start` 未信任时自动安装 CA（login.keychain → admin System.keychain → 钥匙串「始终信任」）；已信任则零钥匙串写入。Cursor/无 GUI 终端若失败，改在 Terminal.app 跑 `mox trust-ca`。
- 真机 CA 下载：`GET /mox/ca.cer` / `ca.pem`（`/__mox__/` 仍为别名）。
- **真机扫码接入**：`GET /mox/` 落地页（CA QR + PAC QR + `IP:port`）；`GET /mox/proxy.pac`；`mox start` 经 iTerm2 协议在终端内联正方形 PNG（并落盘 `.data/device-hub-qr.png`）。Cursor/VS Code 需 `terminal.integrated.enableImages`。诚实标注：系统无法跨端「扫一码写死手动代理」。
- **Whistle-like 默认**：`proxy.host=0.0.0.0` + `allowOpenProxy=true`；收紧用 `--proxy-host=127.0.0.1` / `--no-open-proxy`。
- **Capture 噪声门闸**：默认 `captureScope=catalog`（只录规则已覆盖 host）+ 浏览器/CDN 噪声后缀永不落盘；全量摸底用 `captureScope=all`。
- **Start 门禁**：端口占用识别本机 mox session 并提示 `mox stop`；启动 Chrome 前清理 profile session 恢复文件。不探测、不代替启动前端。

### Fixed
- HTTPS CONNECT：按 catalog `hosts[]` 覆盖做 MITM；本机绑定下未覆盖 host 自动隧道透传。
- CONNECT：IPv6 权威名（`[addr]:port`）用 `parseAuthority` 解析，避免 `split(':')` 得到 NaN port 把进程打崩。
- Chromium bypass 为显式 `127.0.0.1;localhost;::1`；CONNECT loopback 拒绝。
- MITM CORS：OPTIONS 预检在 MITM 桥接处理；**默认 `reflectOrigin` 回显任意 Origin**（远程 H5 不再因白名单丢 ACAO）；`reflectOrigin: false` 退回 localhost/`extraOrigins`。
- MITM CA：生成时补齐 `keyUsage=keyCertSign`（对齐 Whistle/mitmproxy）；缺扩展的旧 CA 会自动重签。Android「用户」凭据下此前会拒链（不是用户 CA 不能用）。MITM TLS 强制 ALPN `http/1.1`。
- MITM CA：`openssl` 解析走 PATH + Homebrew/系统绝对路径；重签失败回滚 `*.bak`；**CA 重签后 `mox start` 自动再跑 trust（不再因同名 CN 误判已信任）**。
- `/mox/ca.cer`：PEM→DER 用 Node `crypto`（不依赖 openssl）；openssl 不可用时保留已有 CA，避免误删后下载 503。
- **修复** `ensureCaCerFile` 在 `root.crt` 布局下误把根证写成 DER（Keychain `.cer` 现写为同目录 `root.cer`）；启动时若发现 DER 会规范回 PEM（指纹不变）。
- 真机 hub / 启动提示展示 CA 指纹；重签后需删旧「mox Local MITM CA」再装当前证书（否则页面能开、接口 Network Error）。
- **CA 默认不再因 weak 检测自动重签**（防指纹漂移）；显式 `MOX_FORCE_REGEN_CA=1` 才轮换。`/mox/ca.cer` 用 `application/x-x509-ca-cert` 内联，方便 Android 证书安装器；`/mox/ca-info` 返回指纹。
- 单测 `forceRegen` 改走 `MOX_MITM_DIR` 临时目录，**禁止再改写 `~/.mox/certs`（及旧 `.data/mitm`）生产根**。
- `Ctrl+C` 快速退出（`closeAllConnections` + 超时）。

### Added
- `mox trust-ca [--open]` 重试/真机说明入口。
- **On-demand page mock**：`mox init` 持久化 `scanDir`；`mox start --scan-dir=` 可覆盖。proxy miss 时按 Referer 扫页面模块图，页面前置依赖阻塞生成并立刻 mock；非前置静默落盘；`TRACE_EMPTY`/空 shape 返回 503（不臆造字段）。

### Breaking
- Service id 不再带 `prefix-` 元前缀；由 `resolveUpstreamId` / `consensusHostLabel` 推导（**host 族共识 → prefixKey**；**hostVar 永不进 id**）。同 ORIGIN 多环境合并为一个 catalog。本地请 `rm -rf .data/services && mox init --force`。
- 同 service id 且 `hosts` 不相交时 generate 硬失败（禁止静默合并不同域名后端）。

### Changed
- Product rename to **mox**: CLI / npm package / Agent Skill / env `MOX_*` / project config `.mox/` / handler markers `mox:manual` | `mox:store` (hard cut, no legacy aliases).
- Docs: `docs/GLOSSARY.md`；用户可见主称 **service id**（字段仍名 `upstreamId`）。

### Added
- Unified catalog resolve APIs in `lib/catalog-merge` (`loadContractsForCatalog`, `handlerExistsForContract`, `listMockKeysForCatalog`, `mocksRootFor`); smoke / list-empty / export-msw / generate read service truth, not project-only mocks
- `mox start --detach` for background sessions (survives shell exit; stop via `mox stop`)
- `scripts/run-project-e2e.js` manual full-chain E2E (`FRONTEND_DIR` + `MOCK_NAME`)
- Silent main path UX: `start` default `resetStore`, `stop` journal one-liner, layered L0–L6 guides
- `docs/REPO_MAP.md` repository inventory (KEEP / UPDATE / DELETE / MANUAL)
- Store-backed handlers expose full standard cases (`http_401`…`dep_fail`/`slow`); detail/delete soft-fill when store miss so smoke/CI stay green
- `test:smoke` isolates via `MOX_DATA_ROOT` (same as unit tests)

### Fixed
- `start` no longer creates empty `.data/services/<projectSlug>/` shells; `ensureServiceDirs` only runs for real upstreamIds from the project index
- `mocksRootFor` / `capturesDirFor` ignore leftover `services/<projectSlug>` empties when a project index exists
- `resolveProjectSlug` accepts multi `--name` array from parseArgs (first element)
- Session foreground ignores SIGHUP; use `stop` / SIGTERM to end

### Removed
- Unused `assets/templates/handler.js.tmpl` and `assets/examples/confirmRecycle.contract.json`

## 1.1.0 — 2026-07-17

### Security
- Mock router path jail: reject `..` / outside-`mocksRoot` resolution (RCE fix)
- LAN bind (`0.0.0.0`) forces `missPolicy=reject` unless `--allow-open-proxy`
- CONNECT tunneling denied by default (except `passthroughHosts` / allow-open-proxy)
- Proxy request body limit (10mb) + upstream timeout; TLS `rejectUnauthorized` defaults true

### Fixed
- Fixture smoke gate was failing (72×) and scenario verify could false-green on empty rules
- Legacy fetch/axios wrappers now bind `exportHint` by function body line range
- `session stop` now SIGTERM/SIGKILL session + Chrome PIDs
- Dead dependency `http-proxy` removed (proxy is self-implemented)

### Added
- Optional HTTPS MITM (`--mitm=1`, local CA via openssl, matched hosts only)
- `import-openapi` / `export-msw` CLI commands
- Query/header `when` matching on proxy rules; light stateful `times` / `transitions` in scenarios
- Infer mtime cache; handler mtime require cache
- GitHub Actions CI (Node 18/20); `c8` coverage script; eslint
- capture-merge skip report when responseBody empty

### Docs
- Honest HTTPS status: rewrite requires `--mitm=1` or external MITM; CONNECT-only otherwise
- Contract schema / generate-mock references aligned with full case set; `when` on cases noted as proxy-header driven today
