# L0 — 上手（init → start → stop）

## 本层目标

学完后能在任意前端仓：安装 CLI、生成 catalog、起 mock+proxy、停掉，并知道成功长什么样。

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
mox init --name=demo
```

预期：终端打印 generate 摘要；磁盘出现：

- `.data/projects/demo/index.json`（项目索引）
- `.data/services/<upstreamId>/`（契约 / mocks / proxy-rules；可能多个 upstream）
- 若识别到 CRUD 簇：对应 handler 可能带 `mox:store`；并有 `domain-draft.md`（静默产物）

### 3. 启动

```bash
mox start --name=demo
# 需要打开页：
# mox start --name=demo --start-url=http://localhost:8080
```

预期日志含：

- `[mox] store reset (use --keep-state to retain)`
- `mock …` 与 `proxy …`
- `session running — Ctrl+C to stop`

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
- [ ] `init` 后 `.data/projects/demo/` 与至少一个 `.data/services/*/proxy-rules.json` 存在
- [ ] `start` 打印 store reset；端口可访问
- [ ] `stop` 打印 journal 一行（可为 0 hits）

## 边界与下一层

本层**不要求**理解 Store、upstream、录制。  
常见失败见下方锚点。下一层：[L1 前端推导](./guide-l1-frontend-infer.md)。

<a id="port-in-use"></a>

### 常见失败：port in use

换端口或先 `mox stop`：

```bash
mox start --name=demo --mock-port=3910 --proxy-port=19000
```

深入：工具书 [session-and-proxy.md](./session-and-proxy.md)。
