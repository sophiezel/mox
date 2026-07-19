# Session 与内置代理

## 模型

- **一个**全局 session（`.data/session.json`）：端口、`trafficMode`、`mockAllowlist`、`cases`、`activeCatalogs`。
- Catalog **真源**在 `.data/services/<upstreamId>/`；运维产物在全局 `.data/{classify,reports,audit,scenarios}/`。`start --name=<upstreamId…>` 可同时挂多服务；省略 = 全部。
- 共享 rule 包在包根 `rules/`（见下）。

## 开关

- `proxy.enabled` / CLI `--proxy=0|1`
- `--mock-port` / `--proxy-port`（**代理入口端口**，与规则里的上游目标 port 正交）
- `--proxy-host`（默认 `127.0.0.1`；真机/E2E 用 `0.0.0.0`）
- `--name=a --name=b`（或 `--name=a,b`）挂载 catalog；省略 = 全部
- `--rules kw1 kw2` 启动时应用共享 rule（强制 `selective`）；可与 `--record` 同用（仍 selective，只录透传）
- `--scenario` 启动时初始场景（从第一个 catalog 的 scenarios/ 读）
- `--traffic=all-mock|all-passthrough|selective` 启动时流量模式（写入全局 session）

## 共享 rules

```bash
mox start --name=tower --name=other --rules jian-h5 xrk
mox start --rules jian-h5 --record   # rules 优先：命中 mock，其余透传并录制
mox rules use jian-h5 xrk
mox rules list
mox rules save my-pack
```

文件：`<pkg>/rules/<name>.json`（`--rules-dir=` / `MOX_RULES_DIR` 可改）：

```json
{
  "stubs": ["GET prefix-…/path"],
  "cases": { "default": "success", "active": {} }
}
```

多关键字 → stubs **并集**；写全局 session 后 ≤1s 热生效。改磁盘文件需再 `rules use`。

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
mox traffic all-passthrough          # 录制
mox traffic selective
mox traffic allow "GET svc-a/v1/items"
mox traffic list
mox traffic all-mock                 # 自测
```

热更新：写 `.data/session.json`；proxy ≤1s 经 `trafficLoader` 生效，无需重启。

### Port 匹配

规则 `hosts[]` 支持 `hostname` 或 `hostname:port`；可选 `ports: [443, 8443]`。  
请求 port 从 URL / Host 解析（缺省 http→80，https→443）。同 host 不同 port 互不误伤。

不做：Whistle 全文 DSL、二级企业 `proxy://` 链、Map Remote URL 改写。

## 浏览器（桌面）

独立 Chrome：

```bash
Chrome --user-data-dir=.data/chrome-profiles/<slug> --proxy-server=127.0.0.1:<proxyPort>
```

登录：专用 profile 持久化；SSO/鉴权 host 可配 `passthroughHosts`。

## 真机 WebView

```bash
mox session start --proxy-host=0.0.0.0
```

启动日志打印 `Wi-Fi 代理: <LAN_IP>:<proxyPort>`，在手机 Wi‑Fi 手动代理填写。详见 `e2e-and-device-proxy.md`。

## CORS

localhost / 127.0.0.1 Origin 默认放行；OPTIONS → 204；credentials 回显 Origin。Hybrid WebView 非 localhost Origin 走 `cors.extraOrigins`。

## soft 未命中 / 录制

- 真 miss（无 rule）且 `missPolicy=passthrough` → 透传 + `captures/`（`reason=miss`）
- `all-passthrough` / selective 未放行 → 透传 + 录制（`reason=traffic-passthrough|traffic-selective-miss`）
- 写接口默认禁止透传（`blockWritePassthrough`）

## 场景热更新

`set-scenario` / `set-case` / `traffic` 写 session；proxy/mock 每请求 ≤1s 缓存读，无需重启。
