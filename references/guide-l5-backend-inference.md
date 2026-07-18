# L5 — 后端推导（意图 → 簇 → 虚拟 bean / CRUD）

## 本层目标

理解系统如何从 stub 列表推断操作意图与资源簇，自动绑定 Store handler，并写出可审阅的 domain draft（**不发明业务字段**）。

## 前置

[L4](./guide-l4-virtual-service.md)；至少一个 upstream 有 ≥2 个相关 CRUD-ish stubs。

## 逐步操作

### 1. 看静默草稿（init/generate 已写）

```bash
ls .data/services/<upstreamId>/domain-draft.md
cat .data/services/<upstreamId>/models.json | head
```

草稿列出 resources / ops；`fields: []` 表示字段等 shape/capture，不在此臆造。

### 2. 对照自动 materialize

打开疑似 list/create 的 handler，应含 `mox:store` 注释（确定性 CRUD 簇才会改写；非 CRUD 保持静态 cases）。

### 3. 理解自动 vs 高级重绑

| 时机 | 行为 |
|------|------|
| `init` / `generate` | 静默 `writeDomainDraft(confirm)` + `materializeStoreHandlers(force:false)` |
| 手工修复 | `domain-draft --upstream=… --confirm` + `materialize-service --upstream=… [--force]` |

主路径用户**不必**跑后两者。

## 如何验收

- [ ] 能打开 `domain-draft.md` 并指出至少一个 resource + ops
- [ ] 能说明为何 `fields` 为空却仍然合法
- [ ] 知道 `--force` materialize 会覆盖已有 store handler

## 边界与下一层

推的是**虚拟**实体与内存 CRUD，不是真实 DDL / ORM。热路径禁止 LLM。  
排障命令全集：[L6 高级与排障](./guide-l6-advanced.md)。
