# L4 — 虚拟服务与状态（Store / reset / journal）

## 本层目标

理解同一 `upstreamId` 下内存 Store 如何让「创建 → 再列表」看到变化；主路径如何自动 reset / 摘要 journal。

## 前置

[L3](./guide-l3-service-catalog.md)；init 后存在带 `mox:store` 的 handler（CRUD 簇）。

## 逐步操作

### 1. 默认每次 start 清空状态

```bash
mox start --name=demo
# 日志：store reset (use --keep-state to retain)
```

自测可重复：不必手敲 `service reset`。

### 2. 需要跨 start 保留状态时

```bash
mox start --name=demo --keep-state
```

### 3. 看 journal 一行（主路径）

操作若干会命中 store handler 的接口后：

```bash
mox stop
# journal: N hit(s) (upstreamA=…, …)
```

### 4. 需要 JSON 明细时（高级）

```bash
mox help --all   # 找到 service 子命令
mox service journal --limit=20
mox service status --upstream=<upstreamId>
```

运行中清空（高级）：`mox service reset --upstream=<id>` 或省略 upstream 清空全部。

## 如何验收

- [ ] 无 `--keep-state` 时两次 start 之间 Store 不残留
- [ ] stop / Ctrl+C 总能看到 journal 一行
- [ ] 能区分「主路径自动」与 `service *` 高级命令

## 边界与下一层

Store 是**进程内**状态（journal 会落盘摘要）；不连真库。  
「资源簇 / 虚拟 bean / 草稿从哪来」见下一层。  
下一层：[L5 后端推导](./guide-l5-backend-inference.md)。
