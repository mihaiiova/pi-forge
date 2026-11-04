# Protected integration boundary: investigation (#56, closed)

**Status (2026-11-02):** investigation complete and closed; no protected
backend was accepted or implemented. Faur uses **trusted-run credentials**:
Pi, every agent, every tool and their subprocesses can access the run's
credentials, so there is **no same-user confidentiality**. See the product
direction §7 and `README.md` for the current limits. #55, #57 and #58 were
closed as deferred, not as delivered guarantees. Their requirements are kept
in one deferred successor issue, activated only when a reference agent needs
a protected boundary; it must start from this evidence and prove an existing
isolation mechanism adversarially before any implementation. Nothing below
proves secrecy from same-user processes.

## Principals and trust boundaries

| Principal | Role and initial assumption |
| --- | --- |
| Wrapper and credential source | Holds real credentials outside Pi; must be protected from Pi and other unauthorized same-user processes. How it obtains and stores credentials remains undecided. |
| Supervisor | Trusted to configure, deliver to, and terminate a protected run. Its own privilege and isolation are not yet established. |
| Pi and extensions | Orchestrate calls but must not retrieve integration secrets from environment, files, descriptors, process inspection or the delivery channel. |
| Specialists and CLI tools | May be arbitrary descendants and must not gain credentials merely by being in the run. Tool exposure is not an OS boundary. |
| Authorized MCP server | Receives only its selected values; it and any necessary browser descendants are trusted with those values. Server/tool granularity remains to be established. |
| Browser descendants | May require credentials for login, not just HTTP headers; their ownership and termination need proof. |
| Target site | Receives credentials as part of an authorized interaction; external service behavior is outside local containment. |
| Other same-user processes and concurrent runs | Unauthorized observers; isolation must prevent cross-run access, not merely avoid printing secrets. |

Channels to investigate include inherited environment and file descriptors,
source files and symlinks, `/proc`, sockets and peer identity, reconnection,
shared project state, logs, generated files, and descendants that detach or
resist termination. Hiding a value from the model is not sufficient.

## Baseline matrix

| Candidate | Evidence so far | Decision |
| --- | --- | --- |
| Existing isolated Pi configuration, same OS user | Negative control below reads a mode-0600 source, a symlink to it, and another process's environment on this host. | Not a confidentiality boundary. |
| Outside-Pi supervisor with private transport alone | No proof of source protection, peer authentication, descriptor isolation, or cross-run denial. | Unproven; transport alone is not containment. |
| Gondolin / enforced sandbox | Selected direction for recorded commands in roadmap #48; applicability to protected MCP server, browser, and host credential source remains untested. | Investigate; do not assume a viable backend. |
| Separate OS identity / platform isolation | No platform or privilege requirements established. | Investigate; no portability claim. |

## Reproduction and observed results

```sh
node skills/faur/test/probes/same-user-boundary.mjs
node skills/faur/test/probes/same-user-socket.mjs
node --test skills/faur/test/mcp-runtime.test.mjs
FAUR_TEST_SCOPE=1 node --test skills/faur/test/workflow-launcher.test.mjs
```

On Linux 6.12.96+deb13-amd64 x86_64, UID 1000, Node and Pi 1.4.0,
the negative control started two live same-user processes with independent
random sentinels. A separate same-user observer read both mode-0600 source
files, both symlink targets, and both `/proc/<pid>/environ` files. It prints
only classifications, not sentinel values. On non-Linux systems the `/proc`
check explicitly skips; permission errors are reported rather than counted as
proof of protection. This intentionally insecure test passes sentinels in the
victims' environments to demonstrate the existing failure mode; it is not a
proposed delivery mechanism. The source directory and processes are removed on
normal completion.

A second negative control starts a Unix-domain socket with mode 0600 in a
mode-0700 temporary directory. A separate same-UID process connected and
received its sentinel on this host. This shows that filesystem permissions
alone do not authenticate same-user broker clients; the intentionally
unauthenticated fixture is not an evaluation of any proposed peer
verification mechanism.

The built-in Pi MCP fixture's six tests passed on this host. A new SDK test
registers the generated, secret-free connection using `pi.registerMcpServer`
for the session, with no project `.pi/mcp.json` present. The real built-in MCP
server exposes the same named tools, hides the excluded tool, and Faur's
headless approval gate blocks the protected tool. The other tests cover
specialist selection/registration. These tests do **not** prove a specialist
actually called the server, a protected connection, reconnect behavior, or a
production launch interface. Pi's version here is a local observation, not
proof of the version on every pinned runtime. The repository pins
`pi-subagents@0.83.1`.

Pi's installed `docs/mcp.md` says file-configured servers with the same name
override session registrations. Therefore merely registering a per-run server
is not enough in an existing project that already has that name in its shared
configuration: precedence must be addressed without mutating shared state.
The registration is visible to Pi and is suitable only for a secret-free
connection descriptor; it is not a secret-delivery channel.

The existing workflow launcher suite with `FAUR_TEST_SCOPE=1` passed 19 tests
on this host, including timeout cleanup of a detached descendant, scope cleanup
on successful completion, and reporting incomplete cleanup in another fixture.
Two tests were skipped: they require `FAUR_VALIDATOR_PACKAGE` and
`FAUR_SUBAGENTS_PACKAGE` respectively. These are existing workflow tests, not
protected-integration conformance: they do not establish secret isolation,
supervisor-crash recovery, or cleanup of every hostile descendant.

After installing QEMU on this host, a Gondolin CLI guest booted successfully:

```sh
npx --yes @earendil-works/gondolin exec -- sh -c 'echo gondolin-ok; uname -m'
```

It printed `gondolin-ok` and `x86_64`. QEMU's x86 and AArch64 binaries are
available, but `/dev/kvm` remains absent; this observation is not a KVM test.
A separate guest without explicit mounts reported a newly created host `/tmp`
sentinel path and `/home/ops/.ssh` absent. This only checks those paths from
that guest, not source confidentiality against same-user host processes, host
Pi, endpoints, concurrent runs, or any other access path. The npm registry
reported Gondolin 0.14.0 at the time; the `npx` command is unpinned and is not
a reproducible release evidence or an accepted backend. Other platforms and
configurations have not been tested.

## Playwright 0.0.83 source inspection

Revisor's checked-in `agent/.pi/mcp.json` invokes `@playwright/mcp@0.0.83`
with `--secrets .faur/test-secrets.env`. The locally cached 0.0.83 package's
`playwright-core/lib/coreBundle.js` implements `--secrets` with a synchronous
`readFileSync` and dotenv parsing; the server holds the resulting values in
its configuration. `browser_type` and textbox/slider `browser_fill_form` look
up the supplied name and pass the raw value to Playwright's `fill` or
`pressSequentially`. The server redacts matching text in some responses, but
that is not an OS boundary or a guarantee that page content, screenshots,
receipts, or arbitrary outputs cannot disclose values.

A disposable local smoke test uses the cached exact `@playwright/mcp@0.0.83`
package and an already-installed Chromium browser:

```sh
node skills/faur/test/probes/playwright-secret-smoke.mjs /path/to/@playwright/mcp/cli.js
```

On this host the local HTTP form received its random sentinel when the MCP
client called `browser_type` with the name `LOGIN_VALUE`; the sentinel was not
observed in the MCP stdout for this particular interaction. This is a narrow
feasibility observation, not a redaction guarantee. The test deliberately uses
a same-user readable temporary dotenv file and does not establish isolation,
selected-only delivery, cleanup confirmation, or a protected Revisor run. It
does not download Playwright, send credentials to an external site, or use real
credentials.

Consequently, Gondolin's header-only substitution as described in #48 does not
itself satisfy this form-filling mechanism: the authorized Playwright process
needs access to raw values. A solution must place that process, its browser,
and any temporary secret source inside an actually enforced protected boundary
and deliver only selected values, or establish a different mechanism with
matching evidence. Revisor would need to replace its static shared secrets
binding with the approved per-run contract and route receipts appropriately;
no Revisor changes are made in this investigation.

## Remaining investigation

- Exercise a candidate with a sentinel-only MCP server and real Pi and
  specialist calls, preserving named tools, approval and exposure, without
  mutating shared `.pi/mcp.json`. Prove both authorized delivery and denial to
  same-user observers, Pi, CLI tools, and a concurrent run, including reconnects.
- Probe inherited descriptors, sockets, source and symlink traversal, and
  `/proc`; record actual platform prerequisites and explicit skips.
- Verify normal exit and cancellation with detached, signal-resistant browser
  descendants, including confirmation and recovery when cleanup is uncertain.
- Evaluate Revisor's pinned Playwright secrets mechanism without real
  credentials and document necessary changes; do not edit Revisor here.
- Check preserved headless statuses/exit codes, progress, concurrency override,
  cancellation, pinned runtime, provider login, and unprotected integrations.
- Record an accepted decision and exact interfaces on dependent issues only
  after evidence and any product/platform tradeoffs are approved; otherwise
  record a blocked finding and required upstream changes.
