# Tickets: Service Catalog dual-open / single-identity

Tracer-bullet slices for dual catalog openers with a single identity rule. Source: [docs/specs/services-catalog-dual-open.md](docs/specs/services-catalog-dual-open.md).

Work the **frontier**: any ticket whose blockers are all done. For this graph, start with the first ticket; #2 and #3 may proceed in parallel after #1; #4 last.

## Shared host→service-id resolve (prefactor)

**What to build:** Callers can resolve a capture/API host to a stable service id the same way everywhere: prefer an existing upstreams mapping, otherwise derive via `resolveUpstreamId` (host-family → prefixKey); noise or unresolvable hosts yield null (no catalog name). Verifiable with focused tests on that behaviour alone — product capture/merge behaviour does not need to change yet.

**Blocked by:** None — can start immediately.

- [x] Existing upstreams host map wins over re-derive
- [x] Unknown but resolvable host yields the same id `resolveUpstreamId` would
- [x] Noise / unresolvable host yields null
- [x] No random or test-style ids are produced by this path

## Merge: zero-init formal catalog open

**What to build:** A user with no prior `init` and no existing Service Catalog can `merge` a usable capture for a resolvable host and get a formal catalog (upstreams + contract + handler + proxy-rules) whose service id matches the shared resolver; noise/bad body/unresolved hosts skip explicitly without opening a catalog; existing stubs still upgrade to L2. Accepted at the `captureMerge` seam.

**Blocked by:** Shared host→service-id resolve (prefactor)

- [x] Zero-init merge of a good capture creates a mountable catalog (proxy-rules present) under the derived service id
- [x] Created id equals shared-resolver / `resolveUpstreamId` for that host
- [x] Existing stub path still upgrades (L2); counters distinguish created vs upgraded
- [x] Noise, unresolved, and unusable body cases skip with explicit reasons and create no formal catalog
- [x] Tests use an isolated data root (no repo `.data` pollution)

## Capture: stage under derived service id

**What to build:** Under `--capture-open` (or equivalent recording), a capture without stubId is written under `services/<derivedId>/captures/` using the shared resolver; only the captures subtree is ensured before merge; noise hosts create no directory; captures are not dumped into an unrelated primary catalog when a host id can be derived. Accepted at the capture-placement seam.

**Blocked by:** Shared host→service-id resolve (prefactor)

- [x] No-stubId capture for a resolvable host lands in that service’s captures dir
- [x] Captures-only tree does not by itself count as a mountable catalog (no premature proxy-rules requirement change)
- [x] Noise host does not create a service directory
- [x] Tests use an isolated data root

## Docs + test hygiene for dual-open

**What to build:** Product docs state dual openers / single identity and that `init` is optional; readers know `promo-*`-style leftovers are test pollution and safe to remove; merge/capture-related tests remain safe even when run as a single file without the npm test preload.

**Blocked by:** Merge: zero-init formal catalog open; Capture: stage under derived service id

- [x] DECISIONS / GLOSSARY / README (and CHANGELOG as needed) describe dual-open, single identity, init optional, formal open at merge, capture staging by derived id
- [x] Promote/capture tests harden isolation so a direct single-file run cannot write `promo-*` into repo `.data`
- [x] Brief guidance that existing test-leak directories may be deleted manually
