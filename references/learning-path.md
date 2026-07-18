# Learning path — L0→L6

系统学习地图。主路径使用者只需 **L0**；要理解「为什么 mock 像后端」再往下走。

每一层专章固定五段：**目标 → 前置 → 逐步操作 → 验收 → 边界与下一层**。按顺序跟做，不要跳层硬啃 Advanced 命令。

## 推荐顺序

| 层 | 专章 | 一句话 |
|----|------|--------|
| L0 | [guide-l0-getting-started.md](./guide-l0-getting-started.md) | `init → start → stop` 能跑起来 |
| L1 | [guide-l1-frontend-infer.md](./guide-l1-frontend-infer.md) | 前端扫描如何变成契约与 handler |
| L2 | [guide-l2-runtime.md](./guide-l2-runtime.md) | session、scenario、录制升阶、真机代理 |
| L3 | [guide-l3-service-catalog.md](./guide-l3-service-catalog.md) | 真源在 `services/<upstreamId>` |
| L4 | [guide-l4-virtual-service.md](./guide-l4-virtual-service.md) | Store 状态、自动 reset、journal |
| L5 | [guide-l5-backend-inference.md](./guide-l5-backend-inference.md) | 意图 → 资源簇 → 虚拟 bean / CRUD |
| L6 | [guide-l6-advanced.md](./guide-l6-advanced.md) | 按症状选高级命令排障 |

## 怎么用这份地图

1. **只用产品**：读完 L0，回到 [README](../README.md) 快速开始即可。
2. **修问题**：报错里的 `see: references/guide-lN-….md#锚点` 直接跳对应层。
3. **系统学**：L0→L6 逐层验收通过再进下一层；工具书（infer / session / scenarios…）作深挖附录，不替代专章。

## 主路径 vs 高级

| 日常 | 自动发生 | 不必手敲 |
|------|----------|----------|
| `init` | catalog + CRUD 绑 Store + domain-draft | `domain-draft` / `materialize-service` |
| `start` | `resetStore('*')` | `service reset`（除非 `--keep-state`） |
| `stop` | journal 一行摘要 | `service journal`（除非要看 JSON 明细） |

高级命令全集：`mox help --all`。
