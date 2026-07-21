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

## 快速开始

```bash
cd /path/to/frontend-app
mox init --name=demo
mox start
# 默认 MITM + 打开 http://127.0.0.1:8000；首次可能弹一次系统密码以信任 CA
```

Catalog（真源）在 `.data/services/<upstreamId>/`；运维产物在全局 `.data/{classify,reports,audit,scenarios}/`；运行时状态在全局 `.data/session.json`。`init` 会静默写出域草稿并尽量绑上 CRUD Store；`start` 默认清空 Store（保留用 `--keep-state`）。停掉：

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

## 常用操作

**按 rule 文件只 mock 一部分**（共享 `rules/`，不绑 project）：

```bash
# rules/jian-h5.json、rules/xrk.json — stubs 并集走 mock，其余透传
mox start --name=tower --name=other --rules jian-h5 xrk
# 同时 --record：仍以 rules 为准（selective）；其余透传会写入 captures/
mox start --name=tower --rules jian-h5 --record
mox rules use jian-h5 xrk    # 运行中热切换
mox rules list
mox rules save my-pack       # 从当前 session 导出
```

**切场景**（成功 / 故障 / 慢）：

```bash
mox start --name=demo
mox scenario e2e-fault    # 或 e2e-happy / e2e-slow
mox set-case "GET svc-a/v1/items" biz_error
```

详见 [`references/scenarios.md`](./references/scenarios.md)。

**CI 冒烟**：

```bash
mox start --name=demo --no-auto-launch
mox scenario e2e-happy
mox smoke --ci
mox stop --name=demo
```

**录真实响应写回 mock**（要能打到上游）：

```bash
mox start --name=demo --record
# 浏览器走一遍主流程…
mox stop --name=demo --auto-merge
```

同一 session 里热切换：`mox record` → 操作 → `mox merge` → `mox mock`。

**真机代理**（默认已对局域网开放，同 Whistle）：

```bash
mox start --name=demo
# 按日志抄 Wi‑Fi 代理 IP:port；手机装日志里的 http://<真实LAN>:<port>/mox/ca.cer
# 仅本机：--proxy-host=127.0.0.1   收紧 CONNECT：--no-open-proxy
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
| `start` / `stop` | 起停全局 mock+proxy；start 默认 reset Store；stop 打印 journal 摘要 |
| `rules list\|use\|save` | 共享 rule 文件：列出 / 应用 / 导出 |
| `scenario` / `set-case` | 切场景或单个接口响应 |
| `smoke [--ci]` | 冒烟 |
| `start --record` / `record` / `mock` / `merge` | 录真实响应、写回、切回 mock |
| `help --all` | 高级：`service` / `domain-draft` / `materialize-service` / `traffic` / … |

旧名仍可用：`session start|stop`、`set-scenario`、`capture-merge` 等。

`init` / `generate` 常用 flag：`--force` 清孤儿文件（默认不擦已录数据）；`--overwrite-capture` 才允许用法推断盖掉已录真值；`--strict-usage` 在追踪结果为空时失败。
`start` 高级 flag：`--keep-state` 保留 Virtual Service 内存状态。

## 文档

| 文档 | 内容 |
|------|------|
| [`references/learning-path.md`](./references/learning-path.md) | L0→L6 分层引导（推荐系统学习） |
| [`docs/DECISIONS.md`](./docs/DECISIONS.md) | 已锁定决策（真源） |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 架构摘要 |
| [`docs/BACKLOG.md`](./docs/BACKLOG.md) | 未做事项 |
| [`docs/REPO_MAP.md`](./docs/REPO_MAP.md) | 目录清单（KEEP / UPDATE / DELETE） |
| [`references/`](./references/) | 操作工具书 |
| [`SKILL.md`](./SKILL.md) | Agent 编排（可选） |
| [`docs/README.md`](./docs/README.md) | docs 索引 |

## 测试

CI（Node 18/20）= `lint` + unit + smoke + upstream-e2e。

```bash
npm run lint              # eslint
npm test                  # 单测
npm run test:smoke        # fixture smoke
npm run test:upstream-e2e # multi-host
npm run test:all          # unit + smoke + upstream-e2e
```
