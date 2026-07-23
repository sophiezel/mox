# mox

从前端代码扫出接口、生成 mock，再用本地代理把请求拦下来。业务仓不用改，也不绑特定框架。桌面自测和真机 WebView 都能用。

需要 Node >= 18。装完之后命令是 `mox`。

## 安装

一键安装（clone → `npm link` → Agent Skill）：

```bash
curl -fsSL https://raw.githubusercontent.com/sophiezel/mox/main/scripts/bootstrap.sh | bash
```

默认装到 `~/mox`。自定义目录：`INSTALL_DIR=/path/to/mox` 再跑上面的命令，或：

```bash
git clone --depth 1 https://github.com/sophiezel/mox.git ~/mox && cd ~/mox && bash scripts/install.sh
```

已在仓库内时：

```bash
bash scripts/install.sh
```

也可以 `npm install && npm link`。若要给 Agent 发现，可再链一份：

```bash
ln -sfn "$(pwd)" ~/.agents/skills/mox
```

```bash
mox --help
mox help --all    # 含较少用的命令
```

一键脚本**不需要**为本次能力单独改流程：`bootstrap.sh` / `install.sh` 仍是 clone → `npm install` → `npm link` → skill 软链；装完即可用下方命令。

## 快速开始

```bash
cd /path/to/frontend-app
mox init --name=demo
mox start
# 默认 MITM；不自动弹 Chrome（需要：mox start --open 或 mox open）
# startUrl 默认 http://127.0.0.1:8000；首次可能弹一次系统密码以信任 CA
```

Catalog（真源）在 `.data/services/<upstreamId>/`；运维产物在全局 `.data/{classify,reports,audit,scenarios}/`；运行时状态在全局 `.data/session.json`。`captures` / access 日志 / chrome-profiles 等 ephemeral 数据受 `session.dataRetention` 约束（`mox start` 会 quiet GC，也可 `mox gc`）。`init` 会静默写出域草稿并尽量绑上 CRUD Store；`start` 默认清空 Store（保留用 `--keep-state`）。停掉：

```bash
mox stop
# 会打印 journal 一行摘要，例如：journal: 3 hit(s) (…)
```

多个前端可同时挂到同一个代理：

```bash
mox start --name=tower --name=other
# 省略 --name 则挂载全部已有 catalog
```

项目扫法不一样时，改 `.mox/infer.json` 或加 `--adapter=`。见 [`references/infer-from-usage.md`](./references/infer-from-usage.md)。

系统学习（前端 mock → 服务 Catalog → Store → 后端推导）按 L0→L6 跟做：[`references/learning-path.md`](./references/learning-path.md)。

## Hybrid 提测口径（推荐）

| 模式 | 含义 |
|------|------|
| `proxy.mode=mock-lab`（默认） | 日常自测 / E2E；空成功信封或 `TRACE_EMPTY` → **HTTP 503**（禁止假成功） |
| `proxy.mode=capture-open` | `mox start --capture-open`：加宽 MITM 明文落盘；**不等于**全透传 |

- **零溢出可提测** = `mox quality-gate` **exit 0**（不是字面 0 bug）。
- 逃生空 mock：`MOX_ALLOW_EMPTY_MOCK=1`，或改用 `--capture-open`。
- 纯全透传：`mox traffic all-passthrough`（已移除旧的 `mox record` / `--record`）。

```bash
mox start --name=demo
mox scenario e2e-happy
mox quality-gate
# Hybrid 可见性（H1）：App 须走系统 Wi‑Fi 代理
# mox quality-gate --require-mitm-check=https://<catalog-host>/__mox_mitm_check
# 需要代理 Chrome：mox start --open 或会话已起时 mox open
```

Playwright 样板：[`examples/playwright-mox/`](./examples/playwright-mox/)。

## 常用操作

**按 rule 只 mock 一部分**（共享 `rules/`，不绑 project；对齐 Whistle）：

```bash
# rules/*.json stub 包，或同名 *.txt Whistle-like map（单列 host/path 即可；同名优先 .json）
mox rules use csp-trade      # 写入 .data/rules-active（本地 sticky）
mox start                    # 之后无需每次 --rules=
mox start --name=tower --rules=csp-trade
mox start --rules=csp-trade,csp-tasks   # 逗号/空格多值 merge；找不到的名字跳过
mox start --name=tower --rules jian-h5 xrk
# 同时 --capture-open：仍以 rules 为准（selective）；未命中可落盘
mox start --name=tower --rules jian-h5 --capture-open
mox rules use jian-h5 xrk    # 运行中热切换 + 更新 sticky
mox rules list
mox rules save my-pack       # 从当前 session 导出 .json
mox rules clear              # 清 sticky；pack 门闸 → selective + 空 allowlist
# 任意路径的 map 文件也可一次性导入：
mox map import ./whistle-map.txt
```

**切场景**（成功 / 故障 / 慢）：

```bash
mox start --name=demo
mox scenario e2e-fault    # 或 e2e-happy / e2e-slow
mox set-case "GET svc-a/v1/items" biz_error
```

Scenario 可声明 `requiredStubs`：缺失/空 stub 时 `set-scenario` / `quality-gate` 失败。详见 [`references/scenarios.md`](./references/scenarios.md)。

**CI 冒烟**：

```bash
mox start --name=demo
mox scenario e2e-happy
mox smoke --ci
mox quality-gate
mox stop --name=demo
```

**录真实响应写回 mock**（要能打到上游）：

```bash
mox start --name=demo --capture-open
# 浏览器走一遍主流程…
mox stop --name=demo --auto-merge
```

同一 session 里热切换：`mox traffic all-passthrough` → 操作 → `mox merge` → `mox mock`。

**真机代理**（默认已对局域网开放，同 Whistle）：

```bash
mox start --name=demo
# 按日志抄 Wi‑Fi 代理 IP:port；手机装日志里的 http://<真实LAN>:<port>/mox/ca.cer
# 仅本机：--proxy-host=127.0.0.1   收紧 CONNECT：--no-open-proxy
# Android（可选 ADB 助手，不输 PIN）：
mox device prepare --lan-ip=<LAN>
```

见 [`references/e2e-and-device-proxy.md`](./references/e2e-and-device-proxy.md)。

**补空数据 / 导入 OpenAPI**：

```bash
mox list-empty --name=demo
mox import-openapi --from=./openapi.json --name=demo
```

**部分接口 mock、其余透传**：

```bash
mox traffic selective --name=demo
mox traffic allow "GET svc-a/v1/items" --name=demo
mox start --name=demo --traffic=selective
```

**导出 MSW**：

```bash
mox export-msw --out=./msw-handlers.js --name=demo
```

## 命令

| 命令 | 干什么 |
|------|--------|
| `init` | 扫描项目，生成 catalog（静默 domain-draft + CRUD Store 绑定） |
| `start` / `stop` | 起停全局 mock+proxy；start 默认不弹浏览器、quiet GC、reset Store；stop 打印 journal 摘要 |
| `open` | 已有 session 时再开代理 Chrome（等同 `start --open` 的浏览器部分） |
| `gc [--dry-run]` | 按 `dataRetention` 清理 captures / append 日志 / reports / chrome-profiles / 空 service 壳 |
| `rules list\|use\|save\|clear` | 共享 rule：`.json` stub / `.txt` Whistle map；sticky `.data/rules-active`；多值 merge |
| `map import <file>` | Whistle-like map pattern → selective + allowlist + 增量 proxy-rules |
| `scenario` / `set-case` | 切场景或单个接口响应 |
| `quality-gate` | 提测门禁（空/TRACE_EMPTY → exit 1；可选 `--require-mitm-check=`） |
| `device prepare` | ADB：设 `http_proxy`、push CA、打印 WebView mitm-check |
| `smoke [--ci]` | 冒烟 |
| `start --capture-open` / `traffic all-passthrough` / `mock` / `merge` | 加宽落盘、全透传、切回 mock、写回 |
| `help --all` | 高级：`service` / `domain-draft` / `materialize-service` / `traffic` / … |

旧名仍可用：`session start|stop`、`set-scenario`、`capture-merge` 等。

`init` / `generate` 常用 flag：`--force` 清孤儿文件（默认不擦已录数据）；`--overwrite-capture` 才允许用法推断盖掉已录真值；`--strict-usage` 在追踪结果为空时失败。  
`start` 常用 flag：`--open`、`--rules=a,b`、`--capture-open`、`--proxy-log=summary|verbose|silent`、`--keep-state`、`--mitm=0`、`--proxy-host=127.0.0.1`、`--no-open-proxy`。

## 文档

| 文档 | 内容 |
|------|------|
| [`references/learning-path.md`](./references/learning-path.md) | L0→L6 分层引导（推荐系统学习） |
| [`references/session-and-proxy.md`](./references/session-and-proxy.md) | traffic / `--rules` / Whistle map / `proxy.mode` / `--open` / `dataRetention` |
| [`references/e2e-and-device-proxy.md`](./references/e2e-and-device-proxy.md) | Playwright、真机、quality-gate、device prepare |
| [`docs/DECISIONS.md`](./docs/DECISIONS.md) | 已锁定决策（真源） |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 架构摘要 |
| [`docs/BACKLOG.md`](./docs/BACKLOG.md) | 未做事项 |
| [`docs/REPO_MAP.md`](./docs/REPO_MAP.md) | 目录清单（KEEP / UPDATE / DELETE） |
| [`references/`](./references/) | 操作工具书 |
| [`SKILL.md`](./SKILL.md) | Agent 编排（可选） |
| [`docs/README.md`](./docs/README.md) | docs 索引 |
| [`CHANGELOG.md`](./CHANGELOG.md) | 变更明细 |

## 测试

CI（Node 18/20）= `lint` + unit + smoke + upstream-e2e。

```bash
npm run lint              # eslint
npm test                  # 单测
npm run test:smoke        # fixture smoke
npm run test:upstream-e2e # multi-host
npm run test:all          # unit + smoke + upstream-e2e
```
