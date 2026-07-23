# L0 — 上手（init → start → stop）

## 本层目标

学完后能在任意前端仓：安装 CLI、生成 catalog、起 mock+proxy、停掉，并知道成功长什么样。

名词：见 [docs/GLOSSARY.md](../docs/GLOSSARY.md)（service id / Catalog）。

## 前置

- Node ≥ 18
- 本仓已 `bash scripts/install.sh` 或 `npm link`，终端能跑 `mox --help`

## 逐步操作

### 1. 确认帮助是「主路径」

```bash
mox help
```

应看到 Primary：`init` / `start` / `stop` / `rules` / `scenario` / `smoke`。  
**不应**在 Primary 里看到 `service` / `domain-draft` / `materialize-service`（它们在 `help --all`）。

### 2. 初始化

```bash
cd /path/to/frontend-app
mox init
```

预期：终端打印 generate 摘要；磁盘出现：

- `.data/services/<upstreamId>/`（契约 / mocks / proxy-rules / captures；可能多个 upstream）
- `.data/classify/request-roles.json`、`.data/reports/`、`.data/scenarios/`（全局运维产物）
- **不应**出现 `.data/projects/`
- 若识别到 CRUD 簇：对应 handler 可能带 `mox:store`；并有 `domain-draft.md`（静默产物）

### 3. 启动

```bash
mox start
# 默认：MITM 开；不自动弹 Chrome（需要：mox start --open 或 mox open）
# startUrl 默认 http://127.0.0.1:8000；换页：--start-url=
# 关闭 MITM：mox start --mitm=0
# 清理 ephemeral .data：mox gc [--dry-run]
```

预期日志含：

- `[mox] store reset (use --keep-state to retain)`
- `mock …` 与 `proxy …`
- `HTTPS MITM enabled` / `MITM CA already trusted`（或首次 install）
- `session running — Ctrl+C to stop`

端口已被本机 mox 占用时，错误会提示 `mox stop`（而非只报 port in use）。
前端需自行启动；mox 不探测、不代替起 FE。

自启 Chromium 带 `--proxy-bypass-list=127.0.0.1;localhost;::1`，**不含**任何 `ignore-certificate*` 旗标。  
真机：按 `mox start` 日志中的真实 `http://<LAN>:<proxyPort>/mox/ca.cer` 安装同一 CA（见 [`e2e-and-device-proxy.md`](./e2e-and-device-proxy.md)）。

### 4. 停止

另开终端：

```bash
mox stop
```

或在 start 窗口 Ctrl+C。预期含一行：

```text
[mox] journal: N hit(s) …
```

## 如何验收

- [ ] `mox help` Primary 无 service / domain-draft
- [ ] `init` 后无 `.data/projects/`；至少一个 `.data/services/*/proxy-rules.json` 存在
- [ ] `start` 打印 store reset；端口可访问
- [ ] `stop` 打印 journal 一行（可为 0 hits）

## 边界与下一层

本层**不要求**理解 Store、upstream、录制。  
常见失败见下方锚点。下一层：[L1 前端推导](./guide-l1-frontend-infer.md)。

<a id="port-in-use"></a>

### 常见失败：port in use

换端口或先 `mox stop`：

```bash
mox stop
# 或在 session.local.json / 启动参数改 mock.port / proxy.port
```
