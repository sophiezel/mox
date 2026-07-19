# mox 名词表（GLOSSARY）

决策冲突以 [`DECISIONS.md`](./DECISIONS.md) 为准。本文件只解释名词。

## 身份与真源

### service id

- **是什么：** `.data/services/<id>/` 的目录名；CLI `--name=<id>` 挂载的对象。
- **作用：** Catalog 唯一命名空间；stub、Store、captures 都挂在这个 id 下。
- **怎么来：** 只通过 [`lib/upstream.js`](../lib/upstream.js) 的 `resolveUpstreamId` / `resolveUpstreamIdFromRole` 推导：**host 族共识**（`consensusHostLabel`：同族或「较短 label 为其余 label 的 hyphen 前缀」）→ `prefixKey` → 无信号才 `_default`。**`hostVar`（FE 变量名）永不进 id。** 同 ORIGIN 多环境域名合并为一个 catalog，全量进 `hosts[]`。**不再**给 id 加 `prefix-` 元前缀。

### upstreamId

- **是什么：** 契约 / proxy-rule / 代码字段名；**值 = service id**。
- **作用：** 持久化身份；下游（router、store、capture-merge）只**读**已写入的值，不再用残缺上下文重算。

### stub / stubId

- **是什么：** 一条逻辑 API；`stubId = METHOD + serviceId + path`（如 `GET svc-a/v1/items`）。
- **作用：** 全链路统一钥匙（infer → generate → proxy → set-case → capture → smoke）。
- **文件名：** `contracts/` 下文件名是 stubId 的磁盘编码（会含 service id 段）；`mocks/<METHOD>/<path>/` 已在 service 目录下，路径不再重复 service id。

### hosts[] / canonicalHost

- **是什么：** 该 service 可匹配的环境域名列表；canonical 用于展示/smoke。
- **作用：** 环境端点，**不是**身份；同逻辑上游的 preview/stage/prod 域名挂在同一 `hosts[]`。同 id 但 hosts **不相交**时 generate **硬失败**。

### hostVar

- **是什么：** 前端代码里的 host 变量名（推断线索）。
- **作用：** 仅辅助 collapse 归组；**禁止**作为 service id / 目录名。

### prefixKey

- **是什么：** 推断输入（网关 path-prefix 键），不是目录前缀。
- **作用：** 无真实 host 或 host 共识失败时可作为 service id；有可共识的 hosts 时 **host 族优先**。历史上曾错误写成 `prefix-*` id，**已废除**。

### Service Catalog（Catalog）

- **是什么：** `.data/services/<serviceId>/` 下 mocks / contracts / captures / proxy-rules / upstreams 的集合。
- **作用：** 唯一 mock 真源；`mox start` 挂载后由 trafficMode / rules 决定是否拦截。

## 契约与生成

| 词 | 一句话 |
|----|--------|
| **contract** | 某 stub 的 JSON 契约（cases、shape、coverage） |
| **handler / mocks** | `mocks/<METHOD>/<path>/index.js` 运行时响应实现 |
| **shape** | 响应结构描述；禁止发明字段 |
| **envelope** | 常见 `{ code, data, message }` 包装 |
| **fidelity L0–L3** | 空 → usage/OpenAPI → capture 真值 → Store/scenario |
| **adapter** | 可选推断插件（如 `create-request`） |
| **classify role** | new / modify / dependency / unrelated |
| **coverage.gaps** | 证据缺口（如 TRACE_EMPTY） |

## 运行时

| 词 | 一句话 |
|----|--------|
| **session / runtime** | 全局 `.data/session.json` / `runtime.json` |
| **trafficMode** | all-mock / all-passthrough / selective |
| **rules / mockAllowlist** | stub 级标签与选择性 mock |
| **case / caseId** | success、http_500、slow… |
| **scenario** | `.data/scenarios/<name>.json` 批量切 case |
| **proxy / mock** | 正向代理 + mock 服务（零侵入） |
| **capture / capture-merge** | 录制 body → 合并进 contract |

## 虚拟后端

| 词 | 一句话 |
|----|--------|
| **Virtual Service** | 可 mock 响应与同 service 副作用的层 |
| **Store** | 按 service id 作用域的内存状态 |
| **journal** | Virtual Service 命中日志 |
| **domain-draft / models** | 域模型草稿（不连真库） |
| **materialize** | 把草稿/ CRUD 簇绑成 store handler |

## 运维

| 词 | 一句话 |
|----|--------|
| **`--task`** | 仅审计/溯源，不拆目录 |
| **audit** | `.data/audit/changelog.jsonl` |
| **activeCatalogs** | 当前 session 挂载的 service id 列表 |
| **`--name`** | = service id（可多选）；省略 = 全部 services |

## 残留限制

两边都**没有**可解析 host、只靠**相同** `prefixKey` 时，会得到同一 service id，系统**不会**瞎猜拆成两个目录。要隔离请提供 hostVar 或真实 host。

## 深挖

- 架构：[ARCHITECTURE.md](./ARCHITECTURE.md)
- 定稿：[DECISIONS.md](./DECISIONS.md)
- L0 / L3：[guide-l0](../references/guide-l0-getting-started.md) / [guide-l3](../references/guide-l3-service-catalog.md)
