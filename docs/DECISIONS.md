# mox 定稿决策

最后同步：2026-07-19。与 archive 中历史计划不一致时，以本文 + 代码为准。

## 产品定位

| 项 | 定稿 |
|----|------|
| 定位 | **通用 Mock CLI + 可选 Agent Skill 编排层**：前端 Mock 后端 HTTP(S) 接口，后端未通时不阻塞自测与 E2E |
| 主目标 | **前端与后端 0 依赖**：默认全 mock 挡住阻断性请求；E2E/CI 全程 mock + scenario，不依赖真上游 |
| 双轨 | **主轨** `init` / `start` / `scenario` / `smoke`（`all-mock`）；**辅轨** `start --record` / `record` / `merge`（可选升 L2，显式依赖上游） |
| 否决 | **否决**「L0/L1 默认透传真上游」——破坏解耦；录制不得成为日常/E2E 默认路径 |
| 角色一句话 | **CLI 负责确定性能力；LLM 负责有歧义的语义决策与流程编排；Skill 把边界钉死。** |
| 仓库 | 本仓（git）；`scripts/install.sh` 一键 `npm link` + 可选 skill symlink |
| Agent 发现 | 可选 symlink `~/.agents/skills/mox` → 本仓（教 Agent 调用 CLI，非产品本体） |
| CLI | 全局 `mox`（`npm link` / `scripts/install.sh`）— **主产品** |
| 运行时 | **路线 A**：编排 + 正向代理 + Mock **全在本仓 Node**；借鉴 WireMock **语义**（delay/fault/HTTP/scenario），**不**引入 WireMock/Java/Docker 运行时 |
| 业务仓 | 默认零侵入；不改 `baseURL`、不植入 MSW |
| 耦合边界 | **不**绑定本机绝对路径、公司域名/鉴权头、前端框架、特定请求封装 |

## 数据与 `--task`

| 项 | 定稿 |
|----|------|
| 运行时 | **全局** `.data/session.json` + `.data/runtime.json`（单 mock 服务） |
| **Service Catalog（真源）** | `.data/services/<serviceId>/`（mocks / contracts / proxy-rules / upstreams / models / **captures**）；字段名仍为 `upstreamId`，值 = service id；由 `resolveUpstreamId`（host 族共识 → prefixKey；**忽略 hostVar**）唯一推导，**不加** `prefix-` |
| **全局运维产物** | `.data/classify/`、`.data/reports/`、`.data/audit/`、`.data/scenarios/`、`.data/exports/`（**不**按前端包名建树） |
| 否决 | **废除** `.data/projects/<slug>/` 作为数据轴；前端目录只是 `init` 的扫描输入 |
| Rules | 包根 `rules/*.json`（或 `--rules-dir` / `MOX_RULES_DIR`）；stub 级「标签」用 `--rules`，不是 projects/ |
| 多 catalog | `start --name=<serviceId…>` 挂载指定 services；省略 `--name` = 全部有 proxy-rules 的 **services** |
| service id 冲突 | 同 id 且 `hosts` 不相交 → generate **硬失败**（同 path 不同域名不得静默合并）；无 host、仅相同 prefixKey 时无法自动拆分（见 GLOSSARY 残留限制） |
| 否决 | 默认「每 frontend 一份运行时 session / 各起一个代理」；否决「mocks 真源挂在 frontend 名下」 |
| 无 `_project/`、无按 task 拆分的 mock 层 | 已否决 |
| `--task` | 仅审计/溯源（`lastTaskId`、`audit/changelog.jsonl`、契约 history），不分区存储 |
| Chrome profile | `.data/chrome-profiles/<label>/`（**仅 autoLaunch Chrome 时创建**） |
| `.data` | gitignore；**单测经 `test/_isolate-data-root.cjs` 写入临时目录**，不污染仓库 `.data/services` |

## Virtual Backend（Stub Catalog → 服务层）

| 项 | 定稿 |
|----|------|
| 定位 | 在现有 discover + proxy 之上增加 **Virtual Service**：可 mock 响应，也可 mock 同 upstream 的状态与副作用 |
| 热路径 | proxy → Virtual Service **禁止 LLM**（确定性） |
| Store | 按 `upstreamId` 作用域的内存 KV / collection；**`start` 默认 `resetStore('*')`**（高级 `--keep-state`）；运行中可用 `service reset` |
| CRUD | 仅对确定性识别的 resource cluster 在 `init`/`generate` **自动**绑 Store；非 CRUD 保持 static cases 或 scenario FSM |
| 域模型草稿 | `init`/`generate` **静默**写 `models.json` / `domain-draft.md`；高级 `domain-draft` / `materialize-service` 仅用于重绑与排障；表结构 = 虚拟实体 schema，不连真库 |
| Journal | 命中 Virtual Service 时记入内存并落盘 `.data/service-journal.json`；**`stop` / Ctrl+C 打印一行摘要**；明细用 `service journal` |
| Catalog 解析真源 | **统一**走 `lib/catalog-merge`：`loadContractsForCatalog` / `loadContractsAcross` / `handlerExistsForContract` / `listMockKeysForCatalog` / `mocksRootFor`；smoke、list-empty、export-msw、classify/generate 只认 `services/*` |
| `start --detach` | 父进程 spawn 独立子进程（`detached`），写 `runtime.json` pid；父进程退出后 session 仍存活；结束用 `mox stop` |
| 全链 E2E | 通用 `scripts/run-project-e2e.js`（`FRONTEND_DIR`）；产品码禁止公司路径/域名硬编码 |
| 保真度 L3 | store 或 scenario 生效且可 reset |

## Classify

| role | 行为摘要 |
|------|----------|
| `new` | 无文档/约束时 **BLOCK** 臆造 IO |
| `modify` | 合并前后契约；冲突进 `reports/contract-conflicts.md`，未决议不覆盖 |
| `dependency` / `unrelated` | 优先复用已有 mock，否则用法倒推 |

Classify 是否需要 LLM/人：仅当有 `--task` / `--related-from` / 明确需求语义时；**无任务全量 init** 用启发式（多为 dependency/unrelated），不强行 LLM。

## IO 反推

| 项 | 定稿 |
|----|------|
| 默认 adapter | 通用 `fetch` / `axios` / 字符串 URL + method 启发式 |
| 可选 adapter | `adapters/*.js`（如 `create-request`）；`--adapter=<name>` 启用；不安装也能扫常见 API |
| 主路径 | ts-morph：引用、实参、属性链、`===`/`switch` 枚举 |
| `src/mock` | **不**作为契约来源 |
| 完整性 | **不承诺 100% 零遗漏**；缺口写入 `coverage.gaps` / `coverage-summary.json` |
| Host 过滤 | `config/default.infer.json`：`denyHostSuffixes`（cdn、静态站启发式）；**无公司 allowlist 写死** |
| 样例字段 | **禁止创造响应字段**；键只来自接口侧解构/`res.data.x` 或 capture 真实 body；**不**扫 UI state 改名 |
| 样例值 | init 用 `@faker-js/faker`（固定 seed）仅给已有键填占位；`capture-merge` 用真实值覆盖并可并入真实 body 新键 |
| 运行时补洞 | soft proxy → `captures/` → `capture-merge`（只增不盲删） |

## 场景引擎（对齐 WireMock 语义子集）

每个 API 生成时自动写入标准 case；运行时可单切或批量切。

| caseId | HTTP | 行为 |
|--------|------|------|
| `success` | 200 | envelope 成功 |
| `empty` | 200 | 空 data |
| `biz_error` | 200 | 业务码失败 |
| `http_401` / `http_403` / `http_404` / `http_500` / `http_502` | 同名 | HTTP 层故障（`dep_fail` → `http_502` 别名） |
| `slow` | 200 | `meta.delayMs`（默认 3000） |
| `timeout` | — | `fault: hang` + 长 delay |
| `offline` | — | `fault: reset`（`res.destroy()`） |

Contract 扩展：`httpStatus` + `meta.{delayMs,fault}`。Router 去掉写死延迟；handler 返回描述符或纯 JSON（兼容）。

Scenario 文件 `.data/scenarios/<name>.json`：`{ default, apis }`；`set-scenario` 批量切；proxy **每请求 ≤1s 缓存**读 session active map。

内置模板：`assets/scenarios/e2e-happy|e2e-fault|e2e-slow.json`。

## Session / 代理 / CORS / 真机

| 项 | 定稿 |
|----|------|
| 浏览器（桌面） | 独立 Chrome：`--proxy-server` + 专用 `--user-data-dir` |
| 真机 | 设备 Wi‑Fi 手动代理 → `proxyPort`（同 Whistle）；业务代码零改 |
| proxy 绑定 | **默认 `0.0.0.0`**（Whistle-like）；桌面 Chrome 仍走 `127.0.0.1` proxy arg；仅本机用 `--proxy-host=127.0.0.1`；启动日志打印真实 **LAN IP:port** |
| LAN 安全 | 默认 `allowOpenProxy=true`；公共 Wi‑Fi 勿用；收紧用 `--no-open-proxy` |
| mock 命中 | `.data/services/<upstreamId>/mocks/<METHOD>/<path>/index.js` |
| miss | soft：透传 + capture 写入 `services/<up>/captures/`，不因单接口拖垮 session |
| CORS | **默认 `reflectOrigin: true`**：本地 proxy/mock 回显请求 Origin（任意 H5 域，不硬编码业务域名）；`reflectOrigin: false` 退回 localhost + `extraOrigins` 白名单。OPTIONS → 204。不使用 `*`（credentials 需具体 Origin） |
| HTTPS | 默认 MITM（catalog hosts）；根 CA 在 `~/.mox/certs/`（可从项目 `.data/mitm` 迁移复制）；叶子按根指纹分桶；首次 `mox start` 写入 System.keychain；真机 `/mox/ca.cer` + `/__mox_mitm_check` 自证；Cronet UA 跳过 MITM；`--mitm=0` 关闭；Chrome 无 ignore-certificate 旗标 |
| E2E scenario 隔离 | 一 worker 一 session，或用例 `beforeEach`/`afterEach` `set-scenario` 复位；不建分布式锁 |

## LLM 介入边界

> 本节为 LLM/人 vs CLI 边界的**唯一真源**。README「架构与角色」为摘要；与本节冲突时以本节为准。

| 时机 | LLM？ |
|------|-------|
| Agent checklist / 读 references | 是（编排） |
| Discover `infer` | 否（静态扫描；漏扫时可选建议补 adapter） |
| Classify（有任务/需求语义） | 是（或人） |
| Classify（无任务全量 init） | 否（启发式） |
| `new` 无文档 IO | 是（或人）+ 工具 BLOCK；LLM 起草须人确认后再生 |
| `modify` 冲突决议 | 是（或人） |
| Generate / session / set-case\|scenario 执行 | 否 |
| Proxy 命中 / delay / fault / HTTP case | **否**（热路径禁止模型） |
| capture-merge 核心 | 否（算法；diff 解释可选 LLM） |
| smoke --ci / unit / integration | 否 |

## CLI 面

**主轨意图别名（默认 help）**：`init` · `start` · `stop` · `rules` · `scenario` · `smoke`  
**辅轨**：`start --record` · `record` · `mock` · `merge`（`stop --auto-merge`）  
**Advanced / 旧名（`help --all`）**：`service` · `domain-draft` · `materialize-service` · `classify` · `generate` · `session start\|stop` · `set-case` · `set-scenario` · `traffic …` · `capture-merge` · `list-empty` · `import-openapi` · `export-msw` · `audit` · install/uninstall  

`--record` 与 `--traffic=` 互斥；默认 `help` 分层，不把辅轨/Advanced 冲淡主轨。  
出错时打印 `see: references/guide-lN-….md#锚点`；系统学习见 [`references/learning-path.md`](../references/learning-path.md)。  
`start --keep-state`：保留 Virtual Service 内存与 journal（默认每次 start 清空）。

## 验证基线

- 仓库内 `fixtures/generic-web/`（axios+fetch 样本）为默认 CI 基线
- `npm test && npm run test:smoke` 必绿
- 任意机器相对路径安装；文档/代码默认路径无本机绝对路径、无公司 Origin 写死

## 非目标（明确不做）

- 不把公司域名/鉴权/封装写入默认核心路径
- 不默认改业务仓 baseURL / 植入 MSW
- 不引入 WireMock/Java 作为运行时依赖
- 不把 Advanced CLI（`service` / `domain-draft` / …）塞进默认主路径
- 不做完整状态机平台 / Admin HTTP UI / Appium 插件（见 BACKLOG P2）

## 后续

未交付项只登记在 [`BACKLOG.md`](./BACKLOG.md)。