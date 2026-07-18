# L3 — 服务 Catalog（真源在 services）

## 本层目标

说清「mock 按**后端服务（upstreamId）**组织，不是按前端仓」；多前端如何共享同一服务 catalog。

## 前置

[L2](./guide-l2-runtime.md)；至少完成过一次 `init`。

## 逐步操作

### 1. 对照两棵树

```text
.data/
  services/<upstreamId>/     ← 真源：mocks / contracts / proxy-rules / models
  projects/<slug>/
    index.json               ← 本前端发现到的 stub 列表
    classify / captures / …
```

### 2. 读 index 如何挂到 service

打开 `.data/projects/<slug>/index.json`，看 stubId（形如 `GET <upstreamId>/<path…>`）。  
同一 `upstreamId` 被第二个前端 `init` 时，应写入**同一** `services/<upstreamId>/`，而不是复制一份到 project 下。

### 3. 多 catalog 挂载

```bash
mox start --name=tower --name=other
# 省略 --name = 挂载全部可解析 catalog
```

代理只有**一个**进程；规则按 stub 合并。

## 如何验收

- [ ] 能指出某个 stub 的 handler 物理路径在 `services/…/mocks/…`
- [ ] 理解 project `index.json` ≠ mocks 真源
- [ ] 两个 `--name` 启动时只有一套 mock/proxy 端口

## 边界与下一层

Catalog 解决「文件放哪、谁共享」；**运行时可变状态**见下一层。  
下一层：[L4 虚拟服务与状态](./guide-l4-virtual-service.md)。

### 架构真源

- [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- [docs/DECISIONS.md](../docs/DECISIONS.md) § 数据与 Service Catalog
