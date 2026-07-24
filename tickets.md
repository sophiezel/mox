# Tickets: Block-write safe policy + capture visibility

Safe write-block policy for mock-lab vs capture-open, quieter noise-host console, and capture success logs. Source: grilling Q1–Q4 + plan block-write safe policy. Does **not** auto-passthrough unmocked POST-as-read paths.

Work the **frontier**: any ticket whose blockers are all done. #1 and #2 may proceed in parallel; #3 last.

## Capture-open allows write passthrough

**What to build:** Under `mox start --capture-open`, unmocked POST/PUT/PATCH/DELETE can reach upstream so recording works (default `blockWritePassthrough=false`). Mock-lab keeps the default write block. Session may still force-enable blocking if explicitly set.

**Blocked by:** None — can start immediately.

- [x] capture-open session has write passthrough enabled by default
- [x] mock-lab (plain start) still blocks unmocked writes by default
- [x] Explicit session/config true can still force block under capture-open
- [x] Tests cover the mode → flag behaviour

## Console: capture success + quiet noise block-write

**What to build:** When a capture is actually saved with a usable body, summary console shows `[proxy] capture …`. Noise-host `block-write` (e.g. push SDKs) does not spam summary; business-host missing-stub `block-write` in mock-lab still shows as `fail`. Full detail remains in proxy-access jsonl / verbose.

**Blocked by:** None — can start immediately (parallel with Capture-open allows write passthrough).

- [x] Successful capture disk write emits access action classified as capture (signal); summary prints it
- [x] Empty/block-write shells without usable body do not emit capture success
- [x] Noise-host block-write is noise under summary; business-host block-write remains fail/signal in mock-lab
- [x] Unit tests for classify / shouldPrintConsole (and wire path as needed)

## Docs: requiredStubs as prereq gate (no POST-as-read passthrough)

**What to build:** Docs state the safe automation path: declare scenario `requiredStubs` and fail via set-scenario / quality-gate **before** E2E runs. Clarify block-write meaning, that POST-as-read still needs stubs (no path-guess passthrough), and mock-lab vs capture-open write-block / console behaviour.

**Blocked by:** Capture-open allows write passthrough; Console: capture success + quiet noise block-write

- [x] DECISIONS / session-and-proxy (and scenarios reference if missing) describe requiredStubs-first workflow
- [x] Explicitly reject path-heuristic auto-passthrough for unmocked POST
- [x] CHANGELOG notes capture-open write passthrough, capture console line, noise-host quieting
