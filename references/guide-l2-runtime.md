# L2 — 运行与升阶（session / scenario / 录制 / 真机）

## 本层目标

会用全局 session 切流量与场景；知道录制是**升保真度**辅轨；能给真机配 Wi‑Fi 代理。

## 前置

[L1](./guide-l1-frontend-infer.md)；已能 `start` / `stop`。

## 逐步操作

### 1. 场景切换

```bash
mox start --name=demo
# 另开终端：
mox scenario e2e-fault --name=demo
mox smoke --ci --name=demo
mox stop
```

### 2. 按规则只 mock 一部分

```bash
mox start --name=demo --rules my-pack
mox start --rules=csp-trade,csp-tasks   # .json / Whistle .txt；缺失跳过
# 或运行中：
mox rules use my-pack                   # sticky → .data/rules-active；之后 plain start 即可
mox rules clear
mox map import ./whistle-map.txt
```

<a id="traffic-flags"></a>

### 3. 流量 flag 边界

- `--capture-open` 与 `--traffic=` **互斥**
- `--rules` 优先：与 `--capture-open` 同用时仍是 selective，只把未命中规则的透传记入 captures
- `--capture-open` ≠ 全透传；纯全透传用 `mox traffic all-passthrough`

```bash
# 错：
# mox start --capture-open --traffic=all-mock
# 对：
mox start --name=demo --capture-open
mox stop --auto-merge
```

### 4. 提测门禁

```bash
mox quality-gate
# Hybrid：mox quality-gate --require-mitm-check=https://<host>/__mox_mitm_check
```

exit 0 = 可提测（零溢出口径）。见 [e2e-and-device-proxy.md](./e2e-and-device-proxy.md)。

### 5. 真机代理

<a id="device-proxy"></a>

```bash
mox start --name=demo
# MITM 默认开；关：--mitm=0
# 仅本机：--proxy-host=127.0.0.1
# Hybrid（adb 设全局代理，随 stop 释放）：mox start --device
# 只装 CA（不设代理）：mox device prepare [--lan-ip=<LAN>]
```

按日志填手机 Wi‑Fi 手动代理（真实 IP:port），或 Hybrid 用 `--device`。勿在公共 Wi‑Fi 使用默认 LAN 绑定。`--detach` 时必须 `mox stop` 才会释放设备代理。

电脑与手机须信任**同一份** CA：首次 `mox start` 自动装系统钥匙串；手机打开日志中的 `http://<真实LAN>:<port>/mox/ca.cer`。见 [e2e-and-device-proxy.md](./e2e-and-device-proxy.md)。

## 如何验收

- [ ] `scenario e2e-fault` 后 smoke/请求能看到故障类 case
- [ ] 说清主轨 `all-mock` vs 辅轨 `--capture-open`（加宽落盘）vs `traffic all-passthrough`（全透传）
- [ ] `quality-gate` 能解释 exit 0 / 1
- [ ] 真机或桌面代理至少走通一种

## 边界与下一层

本层仍以 **按 stub 的静态/场景响应** 为主；跨请求可变状态见 L4。  
下一层：[L3 服务 Catalog](./guide-l3-service-catalog.md)。

### 工具书

- [session-and-proxy.md](./session-and-proxy.md)
- [scenarios.md](./scenarios.md)
- [e2e-and-device-proxy.md](./e2e-and-device-proxy.md)
