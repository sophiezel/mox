# Generate mock

`mox generate` (also run by `init`) materializes:

1. `contracts/<apiKey>.json` — schema + full standard cases
2. `mocks/<host>/<path>/index.js` — handler (skipped when empty+weak coverage)
3. `proxy-rules.json` — host+pathPrefix+method rules for the forward proxy

## Standard cases

Every generated contract includes:

| caseId | HTTP | Notes |
|--------|------|-------|
| `success` | 200 | envelope with materialized `data` |
| `empty` | 200 | empty object/array data |
| `biz_error` | 200 | business code failure |
| `http_401` / `http_403` / `http_404` / `http_500` / `http_502` | same | HTTP faults |
| `dep_fail` | 502 | alias of http_502 |
| `slow` | 200 | `meta.delayMs` (default 3000) |
| `timeout` | — | `fault: hang` |
| `offline` | — | `fault: reset` |

Enum-backed extra cases may be appended (capped).

## Hard rules

- **Do not invent response fields** — keys only from usage-io / OpenAPI / capture-merge
- Faker fills values for existing keys only (fixed seed)
- Files containing `mox:manual` are never overwritten
- `force` regenerates and may prune handlers not in the whitelist

## Switching cases

```bash
mox set-case "GET api.example.com/v1/users" http_500
mox set-scenario e2e-fault
```

Scenario JSON may also include light stateful config:

```json
{
  "default": "success",
  "apis": {},
  "times": {
    "GET api.example.com/v1/users": [
      { "case": "http_500", "times": 2 },
      { "case": "success", "times": -1 }
    ]
  }
}
```
