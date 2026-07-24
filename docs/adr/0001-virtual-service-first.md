# ADR 0001: Virtual Service first for parameterized APIs

## Status

Accepted

## Context

Capture→merge previously folded every Observation into a single Snapshot `success` case. List pagination therefore lost pages (last page won / arrays collapsed). Runtime mock ignored request `page` and could not support filter/sort without hand-written `mox:manual` handlers.

mox already had L5 CRUD `mox:store` materialize on init, but capture-merge never called it, and list handlers returned full arrays without envelopes.

## Decision

1. Runtime prefers **Virtual Service** (protocol handler + store) when Store Seed is non-empty; otherwise Snapshot.
2. **`deriveAndMaterializeVirtualService`** is shared by init/generate and capture-merge.
3. First protocol: **`paginated-list`** (protocol-first; CRUD clusters remain as enhancement).
4. Row data persists as **Store Seed**; start hydrates after store reset.
5. Query operators beyond pagination are **evidence-driven** from multi-Observation differentials only.
6. **`mox:manual` is never overwritten**; Seed/Profile may still update (`handler_manual_skipped`).

## Consequences

- Merge reports must track unique stubs / VS derive / manual skips, not inflate upgraded counts.
- Fidelity **L3** means Virtual Service protocol present on the contract.
- New catalogs gain `seeds/` and `protocols/` artifacts.
- Further protocols (keyed-detail, etc.) plug into the same derive entry without changing the Snapshot fallback contract.
- A third Observation ingest (`mox import-doc`) reuses the same derive path; wiki Observations are `source=wiki` / `fidelity=doc` and lose to capture on conflict (see [`references/import-doc.md`](../../references/import-doc.md)).
