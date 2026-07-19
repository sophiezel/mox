# L3 — 服务 Catalog（真源在 services）

## 本层目标

说清「mock 按**后端服务（service id）**组织，不是按前端仓」；多前端如何共享同一服务 catalog。

名词：见 [docs/GLOSSARY.md](../docs/GLOSSARY.md)。

## 前置

[L2](./guide-l2-runtime.md)；至少完成过一次 `init`。

## 逐步操作

### 1. 对照布局

```text
.data/
  services/<upstreamId>/     ← 唯一真源：mocks / contracts / captures / proxy-rules / models
  classify/ reports/ audit/ scenarios/   ← 全局运维（非前端名）
```

前端目录只是 `init` 的扫描输入，**不**成为 `.data` 一级命名空间。

### 2. 读 stubId 如何挂到 service

打开任意 `services/<upstreamId>/contracts/*.json`，看 `stubId`（形如 `GET <upstreamId>/<path…>`）。  
同一 `upstreamId` 被第二个前端目录 `init` 时，应写入**同一** `services/<upstreamId>/`。

### 3. 多 catalog 挂载

```bash
mox start --name=svc-a --name=svc-b
# 省略 --name = 挂载全部 services
# stub 级标签（不是前端包名）：mox start --rules tower
```

代理只有**一个**进程；规则按 stub 合并。

## 如何验收

- [ ] 能指出某个 stub 的 handler 物理路径在 `services/…/mocks/…`
- [ ] 理解无 `projects/`；溯源若需要将来落在契约元数据 / 报告，不是目录轴
- [ ] 两个 `--name`（upstreamId）启动时只有一套 mock/proxy 端口

## 边界与下一层

Catalog 解决「文件放哪、谁共享」；**运行时可变状态**见下一层。  
下一层：[L4 虚拟服务与状态](./guide-l4-virtual-service.md)。

### 架构真源

- [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- [docs/DECISIONS.md](../docs/DECISIONS.md)
