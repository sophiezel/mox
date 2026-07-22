# Pitfalls

1. **用错浏览器** — 日常 Chrome 不走 proxy；看流量门禁/access log
2. **CORS** — 默认 `reflectOrigin` 回显任意 Origin；若设 `reflectOrigin: false` 又未配 `extraOrigins`，远程 H5 会被浏览器拦跨域
3. **HTTPS MITM** — v1 对 HTTPS 仅 CONNECT tunnel，不改写响应；mock 规则优先进 HTTP/可拦路径
4. **new 无文档** — 禁止臆造；task 模式下 BLOCK
5. **端口占用** — start 前探测，失败即报错
6. **误提交 .data** — 已 gitignore
7. **env 基址 ≠ 接口** — `KEY: 'https://host/prefix'` 是网关前缀，不会再生成根 mock；完整 path=`prefix+/external/...`
8. **空 data** — 看 `coverage.gaps`（`TRACE_EMPTY` / `no_callsite` / `no_property_access`）；需要真实值时显式跑 `capture-merge`（以 capture 为准，不是补洞）
8b. **字段双写（cityId/city_id）** — UI state 与接口字段同名冲突时只保留接口侧键；勿把 `setData({ cityId })` 扫进 shape；faker 不增键
8c. **init 盖掉 capture** — 普通 init 应保留 `usage+capture`；若要 usage 覆盖真值须显式 `--overwrite-capture`
9. **静态非完备** — `gapApis` 非空时勿宣称 IO 完备
10. **真机打不到代理** — 默认已绑 `0.0.0.0`；确认电脑手机同局域网且按日志填 IP:port；勿在公共 Wi‑Fi 使用；仅本机调试用 `--proxy-host=127.0.0.1`
11. **E2E scenario 串台** — 并行 worker 共用 session 会互相覆盖 case；一 worker 一 session 或 `beforeEach`/`afterEach` 复位
12. **只生成 success** — 未生成/未切故障 case 就跑异常路径 E2E，实际没测到；E2E 前显式 `set-scenario`
