# Context

Ubiquitous language for mox Virtual Service and capture→merge→mock.

## Glossary

| Term | Definition |
|------|------------|
| **Observation** | One observable request/response pair (from usage inference, capture, or wiki/doc import). |
| **DocFetcher** | Pluggable fetch for `mox import-doc`: local `--file` or `MOX_DOC_FETCH_CMD` → Markdown snapshot under `.data/docs/`. |
| **ProtocolProfile** | Learned protocol for a stub (e.g. `paginated-list`): envelope field map + evidence-driven query operators. |
| **Store Seed** | Persisted row set under a Service Catalog (`seeds/<resource>.json`) used to hydrate the Virtual Service store. |
| **Virtual Service** | Deterministic Node handler + in-memory store that applies a ProtocolProfile (not a real backend). |
| **Snapshot** | Static `cases.success` (and related cases) used when the store seed is empty or as fault/smoke fixtures. |
| **Service Catalog** | `.data/services/<serviceId>/` — contracts, mocks, proxy-rules, captures, seeds, protocols. |

## Relationships

- Observations feed derive → ProtocolProfile + Store Seed + optional Virtual Service handler.
- Sources differ only at ingest (`usage` / `capture` / `wiki`); downstream derive/merge is shared.
- Wiki Observations carry `source=wiki` and `fidelity=doc`; capture-backed contracts win on conflict.
- Runtime prefers Virtual Service when seed is non-empty; otherwise Snapshot.
- `mox:manual` handlers are never overwritten by derive; Seed/Profile may still update.
