# Changelog

## Unreleased

### Breaking
- Service id 不再带 `prefix-` 元前缀；由 `resolveUpstreamId` / `consensusHostLabel` 推导（**host 族共识 → prefixKey**；**hostVar 永不进 id**）。同 ORIGIN 多环境合并为一个 catalog。本地请 `rm -rf .data/services && mox init --force`。
- 同 service id 且 `hosts` 不相交时 generate 硬失败（禁止静默合并不同域名后端）。

### Changed
- Product rename to **mox**: CLI / npm package / Agent Skill / env `MOX_*` / project config `.mox/` / handler markers `mox:manual` | `mox:store` (hard cut, no legacy aliases).
- Docs: `docs/GLOSSARY.md`；用户可见主称 **service id**（字段仍名 `upstreamId`）。

### Added
- Unified catalog resolve APIs in `lib/catalog-merge` (`loadContractsForCatalog`, `handlerExistsForContract`, `listMockKeysForCatalog`, `mocksRootFor`); smoke / list-empty / export-msw / generate read service truth, not project-only mocks
- `mox start --detach` for background sessions (survives shell exit; stop via `mox stop`)
- `scripts/run-project-e2e.js` manual full-chain E2E (`FRONTEND_DIR` + `MOCK_NAME`)
- Silent main path UX: `start` default `resetStore`, `stop` journal one-liner, layered L0–L6 guides
- `docs/REPO_MAP.md` repository inventory (KEEP / UPDATE / DELETE / MANUAL)
- Store-backed handlers expose full standard cases (`http_401`…`dep_fail`/`slow`); detail/delete soft-fill when store miss so smoke/CI stay green
- `test:smoke` isolates via `MOX_DATA_ROOT` (same as unit tests)

### Fixed
- `start` no longer creates empty `.data/services/<projectSlug>/` shells; `ensureServiceDirs` only runs for real upstreamIds from the project index
- `mocksRootFor` / `capturesDirFor` ignore leftover `services/<projectSlug>` empties when a project index exists
- `resolveProjectSlug` accepts multi `--name` array from parseArgs (first element)
- Session foreground ignores SIGHUP; use `stop` / SIGTERM to end

### Removed
- Unused `assets/templates/handler.js.tmpl` and `assets/examples/confirmRecycle.contract.json`

## 1.1.0 — 2026-07-17

### Security
- Mock router path jail: reject `..` / outside-`mocksRoot` resolution (RCE fix)
- LAN bind (`0.0.0.0`) forces `missPolicy=reject` unless `--allow-open-proxy`
- CONNECT tunneling denied by default (except `passthroughHosts` / allow-open-proxy)
- Proxy request body limit (10mb) + upstream timeout; TLS `rejectUnauthorized` defaults true

### Fixed
- Fixture smoke gate was failing (72×) and scenario verify could false-green on empty rules
- Legacy fetch/axios wrappers now bind `exportHint` by function body line range
- `session stop` now SIGTERM/SIGKILL session + Chrome PIDs
- Dead dependency `http-proxy` removed (proxy is self-implemented)

### Added
- Optional HTTPS MITM (`--mitm=1`, local CA via openssl, matched hosts only)
- `import-openapi` / `export-msw` CLI commands
- Query/header `when` matching on proxy rules; light stateful `times` / `transitions` in scenarios
- Infer mtime cache; handler mtime require cache
- GitHub Actions CI (Node 18/20); `c8` coverage script; eslint
- capture-merge skip report when responseBody empty

### Docs
- Honest HTTPS status: rewrite requires `--mitm=1` or external MITM; CONNECT-only otherwise
- Contract schema / generate-mock references aligned with full case set; `when` on cases noted as proxy-header driven today
