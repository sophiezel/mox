# 场景引擎（对齐 WireMock 语义子集）

## 标准 case

每个 API 生成时自动写入下列 case；运行时按 `x-mock-case` / `cases.active` / scenario 选择。

| caseId | HTTP | 行为 | 典型用途 |
|--------|------|------|----------|
| `success` | 200 | envelope 成功 `code:0` + data | 主路径 E2E |
| `empty` | 200 | 空 data（`[]` / `{}`） | 空态 UI |
| `biz_error` | 200 | 业务码失败（`code:50000`） | 表单校验/提示 |
| `http_401` | 401 | 未授权 | 登录态边界 |
| `http_403` | 403 | 无权限 | 权限边界 |
| `http_404` | 404 | 不存在 | 错误页 |
| `http_500` | 500 | 服务错误 | 错误页/重试 |
| `http_502` | 502 | 网关/依赖 | 错误页/重试 |
| `dep_fail` | 502 | `http_502` 别名 | 下游依赖挂了 |
| `slow` | 200 | `meta.delayMs` 后成功（默认 3000） | loading/防抖/竞态 |
| `timeout` | — | `fault: hang` + 长 delay（默认 60000） | 超时提示 |
| `offline` | — | `fault: reset`（`res.destroy()`） | 断网文案 |

## Contract 扩展

case 形状（向后兼容）：

```json
{
  "id": "slow",
  "when": { "header": { "x-mock-case": "slow" } },
  "response": { "code": 0, "data": {}, "message": "" },
  "httpStatus": 200,
  "meta": { "delayMs": 3000 }
}
```

- `httpStatus`：缺省 200
- `meta.delayMs`：延迟毫秒
- `meta.fault`：`hang`（挂起）/ `reset`（断连）

应用顺序：`delayMs` → `fault` → `httpStatus` + body。

## Scenario 批量切换

文件 `.data/scenarios/<name>.json`：

```json
{
  "default": "success",
  "requiredStubs": [
    "POST jian-j/csp-task/external/trade/appoint/getTradeAppointList"
  ],
  "apis": {
    "POST jian-j/csp-task/external/trade/appoint/getTradeAppointList": "success",
    "GET api.example.com/v1/detail": "success"
  }
}
```

### requiredStubs（自动化前置门禁）

E2E / CI **开跑前**应声明本场景依赖的 stubId。`mox set-scenario` / `mox quality-gate` 在 stub **缺失或无 handler** 时直接失败——避免跑到一半才被 `block-write` 403 打断。

- **POST 当读**（如 `getXxxList`）仍须有 stub；**不会**按路径名自动透传未 mock 的 POST。
- 缺 stub 时：先 `capture-open` + `merge` 或 init/手补，再写入 `requiredStubs`。

CLI：

```bash
mox set-scenario e2e-fault
mox set-case <apiId> <caseId>
mox quality-gate
```

内置模板（`init` 时拷贝到项目 scenarios/）：`e2e-happy` / `e2e-fault` / `e2e-slow`。

## 热更新

`set-scenario` / `set-case` 写 `session.json` 的 `cases.active` + `cases.default`；proxy/mock **每请求 ≤1s 缓存**读 session，无需重启进程。

## E2E 隔离约定

并行 E2E：一 worker 一 session；或用例 `beforeEach`/`afterEach` 调 `set-scenario` 复位。不建分布式锁。
