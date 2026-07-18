# L1 — 前端推导（扫描 → 契约 → handler）

## 本层目标

理解 mock 从哪来：代码用法反推 shape → classify role → contract + handler；知道 `coverage.gaps` 表示「还缺证据」，**禁止发明字段**。

## 前置

[L0](./guide-l0-getting-started.md) 验收通过；手上有一次 `init --name=demo` 的产物。

## 逐步操作

### 1. 看项目索引

```bash
# 仓库根或任意目录（数据在 MOX_DATA_ROOT / 本仓 .data）
ls .data/projects/demo/
cat .data/projects/demo/classify/request-roles.json | head
```

关注每条 role：`host` / `path` / `method`、`coverage.gaps`。

### 2. 对照 Service 真源

```bash
ls .data/services/
# 任选一个 upstream
ls .data/services/<upstreamId>/contracts | head
ls .data/services/<upstreamId>/mocks | head
```

契约与 handler 的**真源**在 services；project 下是索引与 classify / captures。

### 3. 理解「不发明字段」

打开任一 contract 的 `success` body：键应来自用法解构或后续 capture，而不是 UI 文案臆造。

### 4.（可选）单独重跑推导链

主路径已由 `init` 串好。排障时：

```bash
mox classify --name=demo
mox generate --name=demo
```

<a id="no-classify"></a>

若报 `no classify result`：先 `init` 或 `classify`，再 `generate`。

## 如何验收

- [ ] 能指出至少 1 个 stub 的 contract 路径与 handler 路径
- [ ] 能在 `request-roles.json` 或 coverage 报告里找到 gaps（或明确「无 gap」）
- [ ] 口头说清：空 data / 缺字段应靠 capture-merge 或 OpenAPI，不手编字段名

## 边界与下一层

本层推的是 **HTTP 响应形状**，不是后端库表或跨接口状态。  
下一层：[L2 运行与升阶](./guide-l2-runtime.md)。

### 工具书（深挖）

- [infer-from-usage.md](./infer-from-usage.md)
- [classify-request.md](./classify-request.md)
- [generate-mock.md](./generate-mock.md)
- [contract-schema.md](./contract-schema.md)
