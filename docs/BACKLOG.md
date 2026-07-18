# Backlog

已交付项见 git 与 [`DECISIONS.md`](./DECISIONS.md)；此处只登记**未做**事项。

## P1

| 项 | 说明 | 触发条件 |
|----|------|----------|
| MITM 证书一键信任 | 桌面 keychain / 真机引导脚本 | 团队真机 HTTPS 日用 |
| infer 进一步拆分 | `lib/infer/{discover,usage-io}` 彻底下沉 | 维护成本上升 |
| capture 命中采样默认开 | 现需 `--record-mock-hits` | 补洞流程成为主路径 |
| Store 持久化 / TTL | 默认纯内存；可选落盘 | 长会话调试需要 |

## P2

| 项 | 说明 | 触发条件 |
|----|------|----------|
| GraphQL / WebSocket | 非目标直至明确需求 | 客户点名 |
| Admin HTTP API / UI | 保持 CLI-first；已有 journal/reset CLI | — |

## 已关闭（勿再开需求）

- Service Catalog + Virtual Store + 静默 domain-draft / CRUD materialize
- 主路径 UX：`start` reset、`stop` journal、`help` 分层、L0–L6 guides
- OpenAPI import（含 YAML）、when 匹配、export-msw、最小 HTTPS MITM
- 单测 `MOX_DATA_ROOT` 隔离（不污染仓库 `.data`）
