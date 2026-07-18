# L2 — 运行与升阶（session / scenario / 录制 / 真机）

## 本层目标

会用全局 session 切流量与场景；知道录制是**升保真度**辅轨；能给真机配 Wi‑Fi 代理。

## 前置

[L1](./guide-l1-frontend-infer.md)；已能 `start` / `stop`。

## 逐步操作

### 1. 场景切换

```bash
mox start --name=demo --no-auto-launch
# 另开终端：
mox scenario e2e-fault --name=demo
mox smoke --ci --name=demo
mox stop
```

### 2. 按规则只 mock 一部分

```bash
mox start --name=demo --rules my-pack
# 或运行中：
mox rules use my-pack
```

<a id="traffic-flags"></a>

### 3. 流量 flag 边界

- `--record` 与 `--traffic=` **互斥**
- `--rules` 优先：与 `--record` 同用时仍是 selective，只把未命中规则的透传记入 captures

```bash
# 错：
# mox start --record --traffic=all-mock
# 对：
mox start --name=demo --record
mox stop --auto-merge
```

### 4. 真机代理

<a id="device-proxy"></a>

```bash
mox start --name=demo --proxy-host=0.0.0.0 --allow-open-proxy
# HTTPS 改写另加：--mitm=1（需信任打印的 CA）
```

按日志填手机 Wi‑Fi 手动代理。勿在公共 Wi‑Fi 开 `0.0.0.0`。

## 如何验收

- [ ] `scenario e2e-fault` 后 smoke/请求能看到故障类 case
- [ ] 说清主轨 `all-mock` vs 辅轨 `--record`
- [ ] 真机或桌面代理至少走通一种

## 边界与下一层

本层仍以 **按 stub 的静态/场景响应** 为主；跨请求可变状态见 L4。  
下一层：[L3 服务 Catalog](./guide-l3-service-catalog.md)。

### 工具书

- [session-and-proxy.md](./session-and-proxy.md)
- [scenarios.md](./scenarios.md)
- [e2e-and-device-proxy.md](./e2e-and-device-proxy.md)
