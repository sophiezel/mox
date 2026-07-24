# Tickets: Virtual Service full-chain

Capture → merge → mock with Virtual Service first (`paginated-list` vertical slice). Source: plan Virtual Service full-chain + grill Q1–Q8.

Work the **frontier**: any ticket whose blockers are all done.

## Persist Store Seed and hydrate on start

**What to build:** Seed rows live under the Service Catalog; `mox start` hydrates them into the Virtual Service store after reset so restarts are reproducible.

**Blocked by:** None — can start immediately.

- [x] Seed upsert by id persists under `services/<id>/seeds/`
- [x] `start` hydrates active catalog seeds after store reset
- [x] Unit tests for seed IO + hydrate

## Paginated-list Virtual Service (page + Snapshot fallback)

**What to build:** Detect `paginated-list`, render VS handler that pages Seed; empty Seed returns Snapshot `success`.

**Blocked by:** Persist Store Seed and hydrate on start

- [x] Protocol detect + envelope learning
- [x] Handler serves different pages from store
- [x] Empty store falls back to Snapshot

## Capture-merge derives paginated Virtual Service

**What to build:** `mox merge` unions multi-page captures into Seed and calls shared derive; `mox:manual` not overwritten.

**Blocked by:** Paginated-list Virtual Service (page + Snapshot fallback)

- [x] Merge accumulates Observations per stub and runs derive
- [x] Manual handlers skipped with `handler_manual_skipped`
- [x] Missing handlers created on upgrade path

## Init shares paginated-list derive

**What to build:** `init`/`generate` uses the same derive entry for list-shaped contracts.

**Blocked by:** Paginated-list Virtual Service (page + Snapshot fallback)

- [x] generate-mock calls derive after CRUD materialize

## Evidence-driven list query operators

**What to build:** Multi-Observation differentials yield eq/sort operators; unchanged request fields do not filter.

**Blocked by:** Capture-merge derives paginated Virtual Service

- [x] `inferOperatorsFromObservations` + wired into paginated handler

## Capture content fingerprint

**What to build:** Identical capture bodies are not rewritten to disk; different pages still capture.

**Blocked by:** None — can start immediately.

- [x] Fingerprint gate in `recordCapture`

## Merge report honesty

**What to build:** Console/report expose unique stubs, vs_derived, hosts_learned, contract_only.

**Blocked by:** Capture-merge derives paginated Virtual Service

- [x] Report payload + console summary fields

## Docs: glossary, decisions, ADR

**What to build:** CONTEXT, DECISIONS, ADR, CHANGELOG aligned with Virtual Service first.

**Blocked by:** Capture-merge derives paginated Virtual Service; Init shares paginated-list derive

- [x] CONTEXT.md glossary
- [x] ADR 0001 + DECISIONS + CHANGELOG
