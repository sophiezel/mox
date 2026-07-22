# L6 — 高级命令与排障

## 本层目标

按症状选择 Advanced 命令；每条命令知道完整示例与回链层。

## 前置

建议完成 [L3](./guide-l3-service-catalog.md)–[L5](./guide-l5-backend-inference.md)。日常自测仍用主路径。

<a id="commands"></a>

## 命令速查

```bash
mox help --all
```

| 命令 | 何时用 | 示例 |
|------|--------|------|
| `service reset` | 运行中清空 Store（start 已默认清空） | `mox service reset --upstream=api` |
| `service journal` | 要 JSON 明细而非一行摘要 | `mox service journal --limit=50` |
| `service status` | 看某 upstream KV/collection 规模 | `mox service status --upstream=api` |
| `domain-draft` | 刷新/确认域草稿 | `mox domain-draft --upstream=api --confirm` |
| `materialize-service` | 强制重绑 store handlers | `mox materialize-service --upstream=api --force` |
| `classify` / `generate` | 拆开重跑推导 | 见 [L1](./guide-l1-frontend-infer.md) |
| `traffic` / `list-empty` / `import-openapi` / `export-msw` / `audit` | 精细流量与保真度 | 见 [L2](./guide-l2-runtime.md) 工具书 |

<a id="repair"></a>

## 按症状选命令

| 症状 | 先试 | 指南 |
|------|------|------|
| 端口占用 | `stop` 或换 `--mock-port` / `--proxy-port` | [L0#port-in-use](./guide-l0-getting-started.md#port-in-use) |
| generate 报无 classify | `init` 或 `classify` | [L1#no-classify](./guide-l1-frontend-infer.md#no-classify) |
| `--capture-open` + `--traffic` 报错 | 二选一；或改用 `--rules` | [L2#traffic-flags](./guide-l2-runtime.md#traffic-flags) |
| 列表看不到刚创建的数据 | 确认 handler 已 materialize；勿在两次 start 间指望无 `--keep-state` 的内存 | [L4](./guide-l4-virtual-service.md) |
| 想重绑 CRUD store | `materialize-service --force` | [L5](./guide-l5-backend-inference.md) |
| 真机 HTTPS CERT 无效 | 手机装 `/mox/ca.cer` + 完全信任；电脑 `mox trust-ca` / 首次 start | [L2#device-proxy](./guide-l2-runtime.md#device-proxy) |
| 未知命令 | `help --all` + 本页 | 上文 Commands |

## 逐步操作（一次完整排障剧本）

1. 复现并复制完整报错（含 `see: references/…`）。
2. 打开对应 guide 锚点，按验收清单排除。
3. 仅当主路径不足时再用本表 Advanced 命令。
4. 修完后回到 `init`/`start`/`stop` 验证，不要把 Advanced 留在日常脚本里。

## 如何验收

- [ ] 能不看 README 凭症状选出正确 Advanced 命令
- [ ] 日常脚本仍只有 `init/start/stop`（+ 必要 scenario/smoke）

## 边界与下一层

L6 是终点层：之后读工具书与 [DECISIONS](../docs/DECISIONS.md) / [ARCHITECTURE](../docs/ARCHITECTURE.md) 即可。  
回到地图：[learning-path.md](./learning-path.md)。
