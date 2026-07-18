# Repository map

Inventory of the mox tree (product + engineering). Status values:

| Status | Meaning |
|--------|---------|
| `keep` | Active; do not delete |
| `update` | Keep, but docs/wiring drift to fix |
| `manual` | Keep; not wired to CLI/CI |
| `delete` | Safe to remove (zero product refs) |
| `review` | Optional later cleanup (not this pass) |
| `runtime` | Local / gitignored; not product source |

Conflict priority for behavior: [`DECISIONS.md`](./DECISIONS.md) > this map > chat history.

## Top-level layout

```
bin/          CLI entry
lib/          Core libraries
runtime/      mock-server + proxy processes
scripts/      CLI implementations + gates
adapters/     Optional infer adapters
assets/       Built-in scenarios (templates/examples removed)
config/       Default infer / session JSON
rules/        Shared rule packs (git; not project-bound)
references/   L0–L6 guides + toolbooks
docs/         Architecture / decisions / backlog / this map
test/         Unit + integration tests
fixtures/     Synthetic frontend samples for tests/smoke
.data/        Runtime catalog (gitignored)
.github/      CI
```

| Path | Role | Status | Notes |
|------|------|--------|-------|
| `bin/mox.js` | CLI entry / help / command dispatch | keep | |
| `package.json` | npm bin, scripts, publish `files` | keep | |
| `README.md` | Install + quickstart | keep | Test matrix aligned with CI |
| `SKILL.md` | Agent orchestration card | keep | Primary cmds: `start` / `stop` |
| `CHANGELOG.md` | Release notes | keep | See Unreleased |
| `LICENSE` | MIT | keep | |
| `eslint.config.js` | Lint config | keep | |
| `.gitignore` | Ignores `.data/**`, logs, etc. | keep | |
| `.data/` | Service catalog + project index + session | runtime | Never commit; local wipe OK |
| `node_modules/` | Dependencies | runtime | |

## `lib/`

| Path | Role | Status | Notes |
|------|------|--------|-------|
| `lib/paths.js` | Data roots, stubId, service/project paths | keep | Legacy path helpers kept for compat |
| `lib/catalog-merge.js` | Catalog merge + contract/handler resolve | keep | **Truth API** for contracts/handlers |
| `lib/session-config.js` | Global session / runtime JSON | keep | |
| `lib/rules.js` | Shared rule packs | keep | |
| `lib/match-rule.js` | Proxy rule matching | keep | |
| `lib/traffic-mode.js` | all-mock / passthrough / selective | keep | |
| `lib/case-resolve.js` | Case → response plan | keep | |
| `lib/cors.js` | CORS | keep | |
| `lib/stateful.js` | Scenario times/transitions | keep | |
| `lib/service-store.js` | In-memory store + journal | keep | |
| `lib/materialize.js` | Shape → sample values | keep | |
| `lib/upstream.js` | upstreamId / host collapse | keep | |
| `lib/gap-taxonomy.js` | Gap types + fidelity ladder | keep | |
| `lib/init-report.js` | Init report | keep | |
| `lib/list-empty.js` | Low-fidelity stub listing | keep | Via catalog-merge |
| `lib/audit.js` | Changelog audit log | keep | |
| `lib/scenario.js` | Scenario load / builtin copy | keep | |
| `lib/sanitize-capture.js` | Capture redaction | keep | |
| `lib/mitm-ca.js` | MITM CA PEM | keep | `--mitm=1` only |
| `lib/vue-script.js` | Vue SFC script extract | keep | |
| `lib/infer/*` | Discover / usage-IO / binding graph | keep | |
| `lib/service-infer/*` | Intent → domain-draft → store handlers | keep | |

## `runtime/`

| Path | Role | Status | Notes |
|------|------|--------|-------|
| `runtime/mock-server/` | Express mock app + router | keep | Prefer service mocks root |
| `runtime/proxy/server.js` | HTTP proxy + traffic policy | keep | |

## `scripts/`

| Path | Role | Status | Notes |
|------|------|--------|-------|
| `scripts/init-project.js` | init pipeline | keep | CLI `init` |
| `scripts/infer-api-usage.js` | Frontend API scan | keep | |
| `scripts/infer-usage-io.js` | Usage-IO enrichment | keep | Internal to infer |
| `scripts/classify-requests.js` | Role classify | keep | CLI `classify` |
| `scripts/generate-mock.js` | Contracts / handlers / index | keep | CLI `generate` |
| `scripts/capture-merge.js` | Merge captures | keep | CLI `merge` |
| `scripts/start-session.js` | Start mock+proxy | keep | CLI `start`; SIGHUP ignore |
| `scripts/stop-session.js` | Stop + journal | keep | CLI `stop` |
| `scripts/set-traffic.js` | Hot traffic mode | keep | |
| `scripts/set-scenario.js` | Apply scenario | keep | |
| `scripts/set-case.js` | Per-stub case | keep | |
| `scripts/rules-cli.js` | Rule packs CLI | keep | |
| `scripts/smoke-cases.js` | HTTP smoke | keep | Via catalog-merge |
| `scripts/import-openapi.js` | OpenAPI import | keep | |
| `scripts/export-msw.js` | MSW export | keep | |
| `scripts/service-cli.js` | Store reset/journal | keep | Advanced |
| `scripts/domain-draft-cli.js` | Domain draft / materialize | keep | Advanced |
| `scripts/install.sh` / `uninstall.sh` | Local install | keep | |
| `scripts/run-fixture-smoke.js` | Fixture CI gate | keep | `npm run test:smoke` (isolated data root) |
| `lib/service-infer/store-handler.js` | CRUD store handler template | keep | Full case set + soft miss on detail/delete |
| `scripts/run-project-e2e.js` | External frontend full-chain E2E | manual | Needs `FRONTEND_DIR`; not in CI |

## `adapters/` / `config/` / `rules/` / `assets/`

| Path | Role | Status | Notes |
|------|------|--------|-------|
| `adapters/create-request.js` | `--adapter=create-request` | keep | |
| `config/default.infer.json` | Default infer profile | keep | |
| `config/default.session.json` | Default session shape | keep | |
| `rules/.gitkeep` | Shared rules dir placeholder | keep | |
| `assets/scenarios/*.json` | Builtin e2e scenarios | keep | Copied on init |
| `assets/templates/` | (removed) | delete | Was unused `handler.js.tmpl` |
| `assets/examples/` | (removed) | delete | Was unused sample contract |

## `references/`

| Path | Role | Status | Notes |
|------|------|--------|-------|
| `references/learning-path.md` | L0→L6 map | keep | |
| `references/guide-l0-*.md` … `guide-l6-*.md` | Layered guides | keep | Linked from SKILL + CLI hints |
| `references/infer-from-usage.md` | Infer deep dive | keep | |
| `references/session-and-proxy.md` | Session / proxy | keep | |
| `references/scenarios.md` | Cases / scenarios | keep | |
| `references/e2e-and-device-proxy.md` | Device / E2E | keep | |
| `references/classify-request.md` | Classify | keep | |
| `references/contract-schema.md` | Contract schema | keep | |
| `references/generate-mock.md` | Generate | keep | |
| `references/pitfalls.md` | Pitfalls | keep | |

## `docs/`

| Path | Role | Status | Notes |
|------|------|--------|-------|
| `docs/README.md` | Docs index | keep | |
| `docs/ARCHITECTURE.md` | Architecture | keep | |
| `docs/DECISIONS.md` | Locked decisions (SSOT) | keep | |
| `docs/BACKLOG.md` | Open work | keep | |
| `docs/REPO_MAP.md` | This inventory | keep | |
| `docs/archive/README.md` | Tombstone for deleted plans | keep | Point to DECISIONS |

## `test/`

| Path | Role | Status | Notes |
|------|------|--------|-------|
| `test/_isolate-data-root.cjs` | Temp `MOX_DATA_ROOT` preload | keep | Wired in npm test scripts |
| `test/phase0-*.test.js` … `phase4-*.test.js` | Feature gates from closed roadmap | review | Content valuable; rename-to-topic later |
| `test/catalog-resolve.test.js` | catalog-merge resolve | keep | |
| `test/ux-simplify.test.js` | Help / start reset / stop journal | keep | |
| `test/upstream-e2e.test.js` | Multi-host pipeline | keep | In CI as `test:upstream-e2e` |
| Other `test/*.test.js` | Unit/integration by theme | keep | |
| `test/import-openapi.test.js` vs `phase1-openapi-merge` | Overlap | review | Do not merge this pass |
| `test/generate-prune.test.js` vs `phase3-dead-export` | Overlap | review | Do not merge this pass |

## `fixtures/`

| Path | Role | Status | Notes |
|------|------|--------|-------|
| `fixtures/generic-web/` | CI smoke baseline | keep | `test:smoke` |
| `fixtures/multi-host-web/` | Multi-upstream E2E | keep | `upstream-e2e` |
| `fixtures/umi-request-web/` | umi-request infer | keep | |
| `fixtures/usage-destructure/` | Destructure shapes | keep | |
| `fixtures/usage-export-patterns/` | Export binding | keep | |
| `fixtures/declarative-grid-web/` | Declarative columns | keep | |
| `fixtures/declarative-custom-web/` | Custom field-source plugin | keep | |
| `fixtures/props-drill-web/` | Props-drill | keep | |

All eight fixtures have consumers — none are delete candidates.

## `.github/`

| Path | Role | Status | Notes |
|------|------|--------|-------|
| `.github/workflows/ci.yml` | Node 18/20: lint + unit + smoke + upstream-e2e | keep | Matches README test matrix |

## Deferred (not this pass)

- Rename `phase*.test.js` → topic names (churn).
- Fold overlapping OpenAPI / prune tests.
- Remove legacy write to `projects/*/mocks` in capture-merge (behavior change).
- Top-level directory reorg (`scripts/` → `commands/`, etc.).
