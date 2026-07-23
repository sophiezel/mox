# Session 与内置代理

## 模型

- **一个**全局 session（`.data/session.json`）：端口、`trafficMode`、`mockAllowlist`、`cases`、`activeCatalogs`、派生 `activeRules`（展示用）。
- Catalog **真源**在 `.data/services/<upstreamId>/`；运维产物在全局 `.data/{classify,reports,audit,scenarios}/`。`start --name=<upstreamId…>` 可同时挂多服务；省略 = 全部。
- 共享 rule 包在包根 `rules/`（可 git）。
- **启用偏好**在本地 `.data/rules-active`（一行一包名；`#` 整行注释；不进 git）。与 session 分离：意图 vs 运行快照。

## 开关

- `proxy.enabled` / CLI `--proxy=0|1`
- `--mock-port` / `--proxy-port`（**代理入口端口**，与规则里的上游目标 port 正交）
- `--proxy-host`（默认 `0.0.0.0`；仅本机用 `127.0.0.1`）
- `--name=a --name=b`（或 `--name=a,b`）挂载 catalog；省略 = 全部
- `--rules a,b` / `--rules kw1 kw2` 启动时应用共享 rule（强制 `selective`），并写入 `.data/rules-active`：`rules/<name>.json` stub 包，或 Whistle-like `rules/<name>.txt` map；多值 merge，找不到的名字直接跳过；可与 `--capture-open` 同用（仍 selective + `proxy.mode=capture-open`）
- 无 `--rules` 时若 `.data/rules-active` 非空 → plain `mox start` **重 apply**（覆盖上次 `mox traffic` 对手工 allowlist 的改动）
- `--scenario` 启动时初始场景（从第一个 catalog 的 scenarios/ 读）
- `--traffic=all-mock|all-passthrough|selective` 启动时流量模式（写入全局 session）
- `--capture-open` → `proxy.mode=capture-open`（加宽 MITM 明文落盘；map/allowlist 仍可强制 mock）。**不等于**全透传；纯全透传请用 `mox traffic all-passthrough` 或 `--traffic=all-passthrough`
- `--scan-dir=DIR`（覆盖 session 中的 `scanDir`）：启用 **miss 时按页面源码即时 mock**

## proxy.mode（mock-lab | capture-open）

| `proxy.mode` | 行为 |
|--------------|------|
| `mock-lab`（默认） | `captureScope=catalog`：只录规则已覆盖 host（噪声 denylist 仍生效） |
| `capture-open` | 已 MITM 解密的明文可落盘（噪声 denylist 仍生效）；allowlist/rules 命中仍 mock |

```bash
mox start --capture-open                   # capture-open；默认仍 all-mock 门闸
mox start --rules jian-h5 --capture-open   # selective mock + capture-open
mox traffic all-passthrough          # 纯全透传（不再由 --capture-open 表达）
```

## On-demand page mock（miss → 源码）

前提：`mox init <frontend>` 会把 `scanDir` 写入 `.data/session.json`；或启动时 `--scan-dir=`。

当请求无 rule 命中时：

1. 用 `Referer` 收敛到前端页面文件，再有界跟 import 做模块图
2. 倒推该页 API（调用链 + 响应解构）；**页面前置**（`onMounted` / `setup` / `useEffect([])` 等）**阻塞生成**并立刻返回 materialize mock
3. **非前置**（点击等事件回调）静默落盘，本次仍走 `missPolicy`
4. 扫不到字段（`TRACE_EMPTY` / empty shape）**不臆造**：前置返回 **503** + `gap`

无 `scanDir` 或页映射失败 → 行为与原来一致（passthrough / reject）。

## 共享 rules

```bash
mox rules use csp-trade              # apply + 写入 .data/rules-active
mox start                            # 无 --rules 时自动套 sticky packs
mox start --name=tower --rules jian-h5 xrk
mox start --rules jian-h5 --capture-open   # selective mock + capture-open
mox rules list
mox rules save my-pack
mox rules clear                      # 清 sticky + session 回 all-mock
```

文件：`<pkg>/rules/<name>.json` stub 包，或同名 `.txt` Whistle map（`--rules-dir=` / `MOX_RULES_DIR` 可改；同名时优先 `.json`）：

```json
{
  "stubs": ["GET prefix-…/path"],
  "cases": { "default": "success", "active": {} }
}
```

Sticky 偏好（本地，不进 git）：

```text
# .data/rules-active
csp-trade
```

多关键字 → stubs **并集**；写全局 session 后 ≤1s 热生效。改 `rules/*` 磁盘文件后 plain `start` / 再 `rules use` 会重 apply。`mox traffic allow/deny` 只改 session；有 sticky 时下次 start 会按 packs 覆盖。

## 流量模式（WireMock proxy/intercept）

Catalog / `proxy-rules.json` 可全量存在；**运行时是否 mock 由 `trafficMode` 决定**（对齐 WireMock「默认透传 + 高优 stub 覆盖」、Charles/Whistle「未 Map 走真站」）：

| `trafficMode` | 行为 |
|---------------|------|
| `all-mock`（默认） | 命中 rule → mock（自测兼容） |
| `all-passthrough` | 忽略 mock 门闸，全部透传真上游 + `captures/` 录制 |
| `selective` | 仅 `mockAllowlist` 内 stubId 走 mock；其余透传 + 录制 |

优先级：

1. `passthroughHosts`（支持 `host` / `host:port` / `*.suffix`）→ 永远透传
2. `trafficMode` 门闸
3. 无 rule → `missPolicy`（passthrough | reject）

```bash
mox traffic all-passthrough          # 纯全透传录制（非 --capture-open）
mox traffic selective
mox start --rules=csp-trade           # rules/csp-trade.txt map pattern → selective
mox start --rules=csp-trade,csp-tasks # multi merge；不存在的名字忽略
mox map import ./whistle-map.txt     # 等价一次性导入（可 --save-as 落成 .json）
# map .txt 例：jian-j.example.com/csp-task   或  https://host/path /path
# 拒绝纯 path（无 host）；path 前缀按 Whistle `/` 边界匹配
mox traffic allow "GET svc-a/v1/items"
mox traffic list
mox traffic all-mock                 # 自测
```

热更新：写 `.data/session.json`；proxy ≤1s 经 `trafficLoader` 生效，无需重启。

### Port 匹配

规则 `hosts[]` 支持 `hostname` 或 `hostname:port`；可选 `ports: [443, 8443]`。  
请求 port 从 URL / Host 解析（缺省 http→80，https→443）。同 host 不同 port 互不误伤。

不做：Whistle 全文 DSL（`$`/`^`/`/regex/`/filters）、二级企业 `proxy://` 链、Map Remote URL 改写；协议维不进入运行时匹配。
pathPrefix 匹配对齐 Whistle：`/v1` 匹配 `/v1`、`/v1/x`，不匹配 `/v1xxx`。

## 浏览器（桌面）

独立 Chromium（Chrome / Edge）：

```bash
Chrome --user-data-dir=.data/chrome-profiles/<slug> \
  --proxy-server=127.0.0.1:<proxyPort> \
  --proxy-bypass-list=127.0.0.1;localhost;::1
```

`mox start` 自动拉起时已带 bypass：本地 HTTP 页直连，远端 API 走代理。

| 客户端 | 旁路 loopback |
|--------|----------------|
| Chromium 自启 | `--proxy-bypass-list=127.0.0.1;localhost;::1`；**零** `ignore-certificate*` 旗标（依赖系统信任的 mox CA） |

HTTPS MITM（**默认开启**；`--mitm=0` 关闭）：

- 首次 `mox start`：若尚未信任，自动 `installTrustedCa`（一次管理员密码 → System.keychain）
- 之后 `mox start`：只检查信任，不改钥匙串
- 真机：打开启动日志中的 `http://<真实LAN>:<proxyPort>/mox/ca.cer` 安装同一 CA；用 catalog host 的 `/__mox_mitm_check` 自证（不以业务页绿盾为准）
- 修复入口：`mox trust-ca`
- 代理侧对 **CONNECT 目标为 loopback** 一律拒绝

登录：专用 profile 持久化；SSO/鉴权 host 可配 `passthroughHosts`。

## 真机 WebView

```bash
mox start
# 日志打印 Wi-Fi 代理: <LAN_IP>:<proxyPort> 与 CA URL
```

启动日志打印 `Wi-Fi 代理: <LAN_IP>:<proxyPort>`，在手机 Wi‑Fi 手动代理填写。详见 `e2e-and-device-proxy.md`。

## CORS

默认 **`reflectOrigin: true`**：有 `Origin` 则回显 `Access-Control-Allow-Origin`（任意域名，本地 mock DX）。OPTIONS → 204；credentials 同步开启。

`reflectOrigin: false` 时退回 localhost + `cors.extraOrigins` 白名单。

## soft 未命中 / 录制

- 真 miss（无 rule）且 `missPolicy=passthrough` → 透传；**默认只写入 catalog 已覆盖 host** 的 `captures/`（`proxy.captureScope=catalog`）
- 浏览器/CDN 噪声（`*.google.com` 等）**永不落盘**（内置 denylist，与 scope 无关）
- 全量摸底：`proxy.captureScope=all`（仍过滤噪声）；可加 `captureNoiseSuffixes`
- `all-passthrough` / selective 未放行 → 透传 + 同上门闸录制（`reason=traffic-passthrough|traffic-selective-miss`）
- 写接口默认禁止透传（`blockWritePassthrough`）

## 场景热更新

`set-scenario` / `set-case` / `traffic` 写 session；proxy/mock 每请求 ≤1s 缓存读，无需重启。
