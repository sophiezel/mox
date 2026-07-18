---
name: mox
description: >-
  Orchestrate the mox CLI for zero-coupling frontend API mock (self-test
  + E2E, desktop and on-device WebView). Prefer invoking mox over writing
  scripts. Discovers APIs, classifies new/modify/dependency/unrelated, generates
  contracts/handlers with WireMock-aligned scenarios, runs mock+proxy sessions.
  Use when the user mentions mox, init mock, API mock, 自测 mock,
  倒推接口, backend not ready, E2E mock, 弱网, 超时, 依赖故障, or boundary case.
disable-model-invocation: true
---

# mox

> **CLI 负责确定性能力；LLM 负责有歧义的语义决策与流程编排；Skill 把边界钉死。**

本文件是裁决卡，不是 CLI 手册。安装、端口、真机代理、命令全表 → 仓库根 [`README.md`](./README.md)。LLM 边界真源 → [`docs/DECISIONS.md`](./docs/DECISIONS.md)。

**硬规则**：优先调用 `mox`，勿自写 mock/proxy 脚本。

## 五步（编排）

1. **discover** — CLI 扫描 host+path
2. **classify** — 有任务时 LLM/人判定 role；无任务用启发式 `dependency`
3. **contract** — `new` 无 docs 则 BLOCK；modify 冲突未决议不覆盖
4. **generate** — CLI 写 contracts + handlers + 标准 cases
5. **session** — CLI 起 mock±proxy；E2E 前显式 `set-scenario`

## 阶段 → reference

| 你正在做 | 先读 |
|----------|------|
| 系统学习 L0→L6 | `references/learning-path.md` |
| 入门 init/start/stop | `references/guide-l0-getting-started.md` |
| init / 发现 | `references/guide-l1-frontend-infer.md` → `references/infer-from-usage.md` |
| 分类 / 冲突 | `references/classify-request.md` |
| 契约 / cases | `references/contract-schema.md` + `references/scenarios.md` |
| 生成 handler | `references/generate-mock.md` |
| session / 真机 | `references/guide-l2-runtime.md` → `references/session-and-proxy.md` |
| Service Catalog | `references/guide-l3-service-catalog.md` |
| Virtual Service | `references/guide-l4-virtual-service.md` |
| 后端推导 / domain-draft | `references/guide-l5-backend-inference.md` |
| 排错 | `references/guide-l6-advanced.md` → `references/pitfalls.md` |

## Agent checklist

- [ ] 优先 CLI：`mox init` / `start` / `stop` / `scenario`（旧名 `session start` / `set-scenario` 仍可用）
- [ ] 需求自测提醒 `--task=<需求ID>`（changelog 溯源）
- [ ] **禁止臆造** `new` 的 IO：无 docs/OpenAPI/用户定义时 BLOCK generate
- [ ] modify 冲突：展示 `reports/contract-conflicts.md`，未决议不覆盖
- [ ] 不改业务仓（除非用户明确 `--write-project-config`）
- [ ] 不依赖 Whistle/Charles；真机 Wi‑Fi 代理 → `proxyPort`
- [ ] CORS 默认 localhost；Hybrid 非 localhost Origin → `cors.extraOrigins`
- [ ] soft miss：透传 + capture，不因单接口拖垮 session
- [ ] **E2E 前显式 `scenario` / `set-scenario`**；勿只生成 success 就宣称可测异常路径
- [ ] `coverage.gaps` 非空时**不宣称 IO 完备**（含 `TRACE_EMPTY`）；需要真实值时显式 `merge` / `capture-merge`（以 capture 为准，非补洞）
- [ ] 普通 `init`/`generate --force` **不得**静默覆盖 `usage+capture`；覆盖须 `--overwrite-capture`
- [ ] **禁止创造响应字段**：键只来自用法或 capture；faker 只填值不增键
- [ ] 后台保活用 `start --detach`；结束用 `stop`（勿依赖关终端）

## 场景决策树

| 要测 | 用 case / scenario |
|------|---------------------|
| 主路径成功 | `success` / `e2e-happy` |
| 空态 UI | `empty` |
| 表单校验/业务失败 | `biz_error` |
| 登录态/权限边界 | `http_401` / `http_403` |
| 错误页/重试 | `http_404` / `http_500` / `http_502` |
| 下游依赖挂了 | `dep_fail`（= `http_502`） |
| loading/防抖/竞态 | `slow` |
| 超时提示 | `timeout` |
| 断网文案 | `offline` |
| 多接口组合 | `set-scenario <name>` |

## 最短命令

```bash
bash scripts/install.sh
cd <frontend> && mox init [--task=ID] [--related-from=doc]
mox start --name=<slug> [--task=ID] [--start-url=http://localhost:8080]
# 后台: mox start --name=<slug> --detach
mox scenario e2e-fault && mox merge
mox stop
# HTTPS 改写（可选）: start --mitm=1 （须信任打印的 CA）
# LAN 开放代理须显式: --allow-open-proxy
# OpenAPI: mox import-openapi --from=./openapi.json
```

详情与真机/`--proxy-host` → [`README.md`](./README.md)。**HTTPS 默认不改写**（CONNECT 隧道）；真机 HTTPS mock 用 `--mitm=1`。
