# Spec: Service Catalog dual-open / single-identity

Status: implemented (see tickets.md); GitHub Issue pending `gh auth`

Triage label target: `ready-for-agent`

Test seams (confirmed):

1. Primary: `captureMerge` — formal catalog open / promote / upgrade / skip
2. Secondary: capture placement — no-stubId captures land under `services/<derivedId>/captures/`

---

## Problem Statement

The user sees odd directories under `.data/services/` (for example `promo-*`) that do not look like real backend services, and realizes the current flow strongly depends on `mox init` before a Service Catalog can exist. Ideally, after `--capture-open` records a usable API, mox should be able to form a mockable catalog even without a prior `init`, using the same identity rules as the main track — without letting tests pollute the repo `.data`.

## Solution

Adopt **dual openers, single identity**: both optional `init` and the aux track `capture → merge` may create a Service Catalog, but the **service id is always derived only via `resolveUpstreamId`** (host-family consensus → prefixKey). During capture, files are staged only under `services/<derivedId>/captures/`. **Formal open** (upstreams + contract + handler + proxy-rules) happens at **`mox merge`** so final artifacts stay high quality. Noise / unresolvable hosts never open a catalog. Tests must isolate the data root.

## User Stories

1. As a frontend engineer, I want to run `start --capture-open` without a prior `init`, so that I am not blocked on scanning the frontend just to record traffic.
2. As a frontend engineer, I want `mox merge` to create a Service Catalog for a resolvable capture host, so that real responses become mockable stubs.
3. As a frontend engineer, I want the auto-created service id to match what `init` would derive for the same host, so that I do not get duplicate or random catalog names.
4. As a frontend engineer, I want captures without a stubId to land under `services/<derivedId>/captures/`, so that merge can find them in the right place.
5. As a frontend engineer, I want formal catalog artifacts (proxy-rules, contracts, handlers) created only at merge time, so that half-baked traffic does not create empty shells.
6. As a frontend engineer, I want existing stubs to still upgrade to L2 on merge, so that capture-open remains useful after init.
7. As a frontend engineer, I want missing stubs on a known host to be promoted into contract+handler+rules, so that init gaps do not strand good captures.
8. As a frontend engineer, I want optional `init` to still pre-generate L1 stubs and upstreams, so that I can warm a catalog when I have a frontend tree.
9. As a frontend engineer, I want `start` without catalogs to remain understandable (hint to capture+merge or init), so that I know how to bootstrap.
10. As a frontend engineer, I want noise hosts (CDN/analytics) never to create service directories, so that `.data/services` stays readable.
11. As a frontend engineer, I want non-JSON or unusable bodies to skip without creating catalogs, so that garbage does not become “services”.
12. As a frontend engineer, I want unresolved hosts to skip with an explicit reason, so that I can fix mapping instead of guessing.
13. As a frontend engineer, I want not to see `promo-*` / timestamp-like service ids in business `.data`, so that catalogs stay explainable.
14. As a QA engineer, I want merge summary to report `created` / `upgraded` / skips, so that I can trust what changed.
15. As a QA engineer, I want after merge a catalog with proxy-rules to be mountable by `start --name=<id>`, so that I can mock immediately.
16. As a CI maintainer, I want unit tests never to write into the repo `.data`, so that local catalogs are not polluted.
17. As a CI maintainer, I want promote tests to use an isolated data root even when run as a single file, so that skipping the npm test preload cannot leak.
18. As a platform engineer, I want one identity function for init and capture/merge, so that naming cannot diverge by code path.
19. As a platform engineer, I want `listServiceIds` / mount to still require proxy-rules, so that captures-only trees are not treated as ready catalogs.
20. As a platform engineer, I want host→existing upstreams mapping to win before re-deriving an id, so that learned hosts stay stable.
21. As a documentation reader, I want DECISIONS/GLOSSARY/README to say init is optional and merge can open catalogs, so that the mental model matches the product.
22. As a returning user with existing `jian-j` catalogs, I want day-to-day capture/merge behavior unchanged when hosts already map, so that the redesign does not break my workflow.
23. As a user cleaning a dirty workspace, I want clear guidance that test leftover dirs like `promo-*` are safe to delete, so that I can reclaim a sane `.data`.
24. As an agent automating mox, I want deterministic skip reasons (`unresolved_upstream`, `noise_host`, `body_not_json`, …), so that automation can branch.
25. As a security-conscious user, I want capture sanitize behavior preserved on promote, so that secrets are not written into new handlers casually.
26. As a multi-catalog user, I want two different resolvable host families to open two catalogs, so that services stay partitioned.
27. As a multi-env user, I want preview/stage hosts of the same family to join one catalog’s `hosts[]`, so that identity stays logical not environmental.
28. As a developer debugging merge, I want promote of a new catalog to write upstreams for that host, so that later captures resolve without re-deriving blindly.
29. As a developer, I want capture to create only the captures subtree before merge, so that I can tell staging from a formal catalog on disk.
30. As a team lead, I want this behavior treated as design norm (single identity, dual openers), so that future features do not invent a third naming scheme.

## Implementation Decisions

- **Architecture**: Dual openers (init optional; merge formal), single identity (`resolveUpstreamId` / host-family consensus → prefixKey). Random or test-only ids are invalid in business data roots.
- **Capture path**: When recording, resolve service id from host (existing upstreams map first, else same derive rules). Write under that catalog’s captures directory; ensure captures dir only; do not formalize proxy-rules/contracts/handlers at write time. No stubId must not dump into an unrelated primary catalog when a host id can be derived. Noise → no directory.
- **Merge path**: If no contract and no upstream map, derive id from host; if derived, ensure full service dirs, persist/merge upstreams, then existing promote (contract + handler + proxy-rules). Upgrade path unchanged when stub exists. Unusable captures → explicit skip, no open.
- **Mount semantics**: A captures-only tree is not a mountable catalog until proxy-rules exist (preserve current “has proxy-rules” listing rule).
- **Init**: Remains the fast path for L1 stubs and pre-seeded upstreams; not a prerequisite for capture→merge bootstrap.
- **Tests / hygiene**: Isolated `MOX_DATA_ROOT` for merge/capture tests; no acceptance of `promo-*` as production naming; document cleanup of leaked test shells.
- **Docs**: Update product decisions and glossary for dual-open / single-identity; README flow shows zero-init capture→merge bootstrap.

## Testing Decisions

- Good tests assert **external behavior** (directories that constitute a formal catalog, stub mockability signals, counters/skip reasons, id equality with `resolveUpstreamId`), not private helpers or call graphs.
- **Primary seam**: `captureMerge` — zero-init open+promote; upgrade; noise/unresolved/bad body skips; id stability vs derive rules; data-root isolation.
- **Secondary seam**: capture recording resolution — no-stubId capture lands in `services/<derivedId>/captures/`; noise creates nothing.
- Prefer extending existing capture-merge and capture-filter / proxy capture tests over new low-level suites.
- Do not treat a second full matrix of `resolveUpstreamId` as the product acceptance suite; only assert consistency with it at the seams above.

## Out of Scope

- Expanding `mox gc` to delete “bad” or test-named catalogs by heuristic.
- Changing fidelity taxonomy, MITM/CA, rules sticky behavior, or Store semantics.
- Auto-opening catalogs at capture write time (formal open stays at merge).
- Putting all unknown traffic into `_default` as the naming strategy.
- GraphQL/WebSocket, Admin UI, or new CLI commands beyond adjusting existing start/capture/merge/docs.
- Mandating users delete existing `promo-*` as part of the code change (docs/guidance only).

## Further Notes

- Grilling outcomes: Q1 stable ids; Q4 same derive rules; Q5 open at merge; Q6 capture-by-derived-id staging; Q7 init optional. Earlier “promote never creates catalogs / init-only open” is superseded.
- `promo-mrxhrpwy` / `promo-mrxhrtql` are test leaks (`promo-${Date.now().toString(36)}`), not a product naming scheme.
- Related plan: services catalog strategy (dual-open / single-identity).
