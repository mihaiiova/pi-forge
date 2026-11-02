# Backlog review (2026-11-02)

Every open issue under epic #24, reviewed against [AGENTS.md](../AGENTS.md),
the [architecture audit](architecture-audit.md) and the
[generated-agent audit](generated-agent-audit.md). This is the review record;
the plan itself stays in [roadmap.md](roadmap.md) and the issues, where each
disposition is recorded as a dated amendment or closing comment.

Priority: **P0** first (wrong today, or a prerequisite for everything),
**P1** public alpha, **P2** soon after, **P3** when a reference agent needs
it, **—** closed or deferred.

## Decisions taken during the review (2026-11-02)

- **Faur is only the maker** (#59). Generated projects are ordinary Pi
  projects that run with `pi`, with Faur uninstalled and without
  `system.yaml`. Supersedes the 2026-10-29 single-pinned-package decision.
- **Native Pi files are authoritative for execution; `system.yaml` records the
  last agreed design.** Drift is reconciled only when Faur is invoked,
  previewed and approved.
- **Launch:** plain `pi` (not hermetic; conflicts reported) or an optional
  project-owned script that only sets an isolated Pi configuration directory.
- **#55–#58:** closed as deferred, not delivered. Requirements kept in #70.
  Trusted-run credentials give no same-user confidentiality.
- **#47** closed; **#48** rewritten technology-neutral and deferred.
- **#54** narrowed: explicit tool lists, no command classifier, at most a
  minimal guard documented as not a boundary.

## Review table

| # | Current proposal | Architectural concerns | Disposition | Priority |
|---|---|---|---|---|
| 24 | Epic and status | Status from v0.21; no architecture work; order predates v0.25–0.26 | Amended: decisions, status, order, new children | — |
| 29 | Discover installed and registry Pi packages | Two discovery implementations exist (audit I) | Keep; one shared search for both paths | P2 |
| 30 | Inspect a package version; opt-in trial load | Trial load executes package code and couples to SDK internals | Narrowed to static inspection; trial load out of scope until static inspection fails a reference agent | P3 |
| 31 | Package resource filters | Pi-native passthrough; hard block on #30 unnecessary | Keep; #30 soft dependency; filters must survive drift adoption (#64) | P3 |
| 35 | Runner writes `.forge/runs.jsonl` with many fields | No runner in projects under #59; copies data sessions already hold | Re-scoped: summaries derived from Pi sessions on read; no run-time writer | P2 |
| 37 | Schedule via `agents-cron` | Recipe assumed `./run` | Keep decision; scheduled runs use plain `pi -p` or the isolation script; after #62, #35, #31 | P3 |
| 38 | `scenarios[]` and a pure evaluator | Sizeable schema surface | Keep, defer; first check whether #43 + #35 cover the need | P3 |
| 39 | Scenario runner with a restricted-mode guard | Run-time enforcement; trusts server-declared `readOnlyHint` | Keep, defer; guard from the #63 package; annotations documented as trusted input | P3 |
| 40 | Run evidence in status and revisions | Fits #59 (builder-side, consented) | Keep; drop the #53 reference | P3 |
| 42 | First-run findings (umbrella) | All filed | **Closed** (completed); leftover is #69 | — |
| 43 | Declared workflow `result`, validated by the runner | Runner leaves projects | Keep goal (run ≠ task success); result produced natively, validated by the caller adapter and run summaries | P1 |
| 44 | Per-run folder; caller-authorized destinations (from #55) | Destination scope served the closed supervisor | Narrowed: caller-authorized destinations removed; folder chosen by the caller, passed as an absolute path; routing ≠ containment | P1 |
| 45 | `tool_call` handler strips subagent `cwd` | No Faur runtime under #59 | Keep; pi-subagents setting or upstream first, else the #63 package; advisory text meanwhile | P2 |
| 46 | `forge serve-mcp` in the Faur package | Run-time, caller-side; not Faur core, not the project | Re-scoped: optional caller-side adapter package; home of timeouts, cancellation, results, files; reads native files; #55 amendment superseded | P2 |
| 47 | Built-in `shell: true` recorded commands | Schema and core growth for one project; Revisor solved it in project code | **Closed** (not planned) | — |
| 48 | Faur-managed Gondolin VMs | VM lifecycle in Faur; Pi has sandbox examples; Revisor uses Bubblewrap | **Rewritten**: compose an existing sandbox, report what is enforced, fail closed; no VM lifecycle or new schema; deferred | — |
| 49 | Setup steps and secrets files | — | **Closed** (done in v0.26.0; each criterion checked) | — |
| 50 | First-run guidance | — | **Closed** (done in v0.26.0) | — |
| 51 | `/forge` edits project code (design open) | Faur would take ownership of authored code | **Decided 2026-11-02:** Faur writes a hand-off task for the developer's coding agent and never edits authored code; `SKILL.md` guidance only | P3 |
| 52 | Heuristic warnings for unsuitable skills | Code for a judgement the LLM makes from the preview | Reduced to `SKILL.md` guidance | P3 |
| 53 | `forge: { model }` for maintenance turns | Builder config in the design record; Faur runs in the developer's Pi | **Closed** (not planned) | — |
| 54 | Implied read tools; secret-path deny list; auto-approved read-only commands | Implicit capabilities; argv-parsing security; path rules ≠ isolation | Narrowed per user decision; regression test that the lead reads reports with no prompt and omitted tools stay omitted | P2 |
| 55 | Epic: protected per-run integrations (amended to trusted-run) | — | **Closed** (deferred, not delivered); successor #70 | — |
| 56 | Prove the protected boundary | Investigation complete | **Closed** (completed investigation; evidence kept) | — |
| 57 | Protected stdio launcher | Generic supervisor without demonstrated need | **Closed** (not planned); #70 | — |
| 58 | Protected lifecycle conformance | Depends on 57 | **Closed** (not planned); #70 | — |

## New issues

| # | Title | Source | Priority |
|---|---|---|---|
| 59 | Epic: Generated projects run as ordinary Pi projects (Faur is only the maker) | Decision 2026-11-02 | P1 |
| 60 | Verify the Pi behavior the maker migration depends on | Audit §5 "verify" rows | P1 |
| 61 | Native prompt loading and pay-per-use generated output | Audit D, R2–R3, R14–R15; generated audit §6 | P1 |
| 62 | Launch with plain pi, an optional isolation script, and native headless runs | R1, R4, R5, R16 | P1 |
| 63 | Approvals and declared commands without the Faur runtime | R10–R13, R17 | P1 |
| 64 | Faur as maker: no project pin, design record and drift reconcile | R6, R18, R19; decision on `system.yaml` | P1 |
| 65 | Generated security and capability text matches what is enforced | Audit H | P0 |
| 66 | One plan/apply path for generate, modify and change | Audit A, E, F | P0 |
| 67 | Rename Pi Forge to Faur | Open-source plan | P1 (with #64) |
| 68 | Public-alpha architecture acceptance tests | Deliverable F | P1 |
| 69 | Change the system's name and description through /faur | #42 leftover | P3 |
| 70 | (Deferred) Protected integrations for secret-consuming tools | Successor of #55–#58 | — |

## Implementation order

1. P0: #65, #66.
2. Migration #59: #60 → #61 → #62 → #63 → #64, then #67.
3. Reliability goals re-specified for plain Pi: #43 → #44 → #46; #45; #54.
4. #68: write the harness early; each criterion passes as its issue lands.
5. Composition and evidence: #29, #30, #31, #35, #40.
6. When a reference agent needs them: #37, #38, #39, #51, #52, #69.
7. Deferred: #48, #70.
