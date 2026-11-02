# Pi Forge — conversational acceptance scenarios

`/faur` is a design conversation, not an interview: the specification
emerges from the discussion, and "build it" moves into discovery, a preview and
the usual confirmation. The behavior is defined in
[`skills/forge/SKILL.md`](../skills/forge/SKILL.md) (*How to
work*, *Explore*, *Synthesize*, *Build*).

Conversational quality can't be measured by a deterministic test, so these
scenarios are checked by reading transcripts. Each has an input, what a passing
reply does, and what fails it. Example wording is illustrative; recommendations
must come from real discovery results, never invented models, tools or skills.

## 1. Vague idea

**Input.** `/faur I want something that helps with my newsletter.`

**Pass.** The Forge talks about the outcome — drafting issues, curating links,
growing subscribers — sketches the simplest approach that would help (for
example one agent that drafts from a list of links), recommends it, and asks at
most one question that changes the design ("Is the bottleneck finding material
or writing it?").

**Fail.** A list of configuration questions (agents, models, skills, MCP
servers, document sections); running `forge discover` or searching skills
before there is a design; writing `system.yaml`.

## 2. Existing context

**Input.** Earlier in the session the user said they want weekly SEO reports
for `example.com`, already run OpenSEO, and want drafts only, no publishing.
Then they type `/faur` with no arguments.

**Pass.** The Forge continues from that: it restates the direction in a line
or two (weekly SEO reports via OpenSEO, Markdown drafts, no publishing) and
moves on to the next open design point or a synthesis.

**Fail.** Asking what the agent is for, whether it should write content, which
SEO tool is available, or whether it should publish.

## 3. Immediate build request

**Input.** "Build a system for this repo: an orchestrator plus a reviewer
subagent that reads diffs and writes `reviews/<date>.md` with findings by
severity. Read-only, no GitHub access. Build it."

**Pass.** No interview. The Forge runs `forge discover`, recommends models
from the discovered line-up and any relevant skills (previewed before they are
chosen), states its assumptions, writes `.pi/system.yaml`, runs
`forge validate` and `forge generate <dir> --dry-run`, summarizes what will
be created, and waits for explicit confirmation before writing files.

**Fail.** Re-asking the stated roles, tools or output; skipping the dry-run
preview; treating "build it" as approval to write files.

## 4. Simplification

**Input.** "I want five agents to summarize our support tickets each morning: a
fetcher, a classifier, a summarizer, an editor and a sender."

**Pass.** The Forge challenges the split: fetching, classifying and
summarizing are one agent's job (or the orchestrator's alone), and it explains
when a separate specialist would earn its place (a different model, isolated
tools, a long independent task). It recommends the smaller starting point and
notes that sending is an external action (see scenario 5).

**Fail.** Designing five agents because they were requested, without comment.

## 5. Unresolved consequential decision

**Input.** "It should post the finished articles to our WordPress site."

**Pass.** Before enabling publishing, the Forge settles the boundary: which
tool or MCP scope gets write access, whether every post needs a human
confirmation or drafts only, and which agent holds that capability. The
decision is listed as **Unresolved** in the synthesis until the user answers.
Prose approvals are described as advisory, and tool allowlists, MCP
`excludeTools` and `approveTools` as enforced.

**Fail.** Silently giving an agent write access to the site, or picking an
approval policy on the user's behalf.

## 6. User changes direction

**Input.** After the Forge proposes an orchestrator plus a research
specialist, the user says: "Actually, skip the specialist — I'd rather keep one
agent and add a Google Drive delivery."

**Pass.** The Forge drops the specialist, moves research into the
orchestrator, adds the Drive delivery (checking a Drive MCP is available when
building), and states only what changed.

**Fail.** Arguing for the specialist again, re-presenting the whole earlier
design, or keeping parts of the abandoned architecture.

## What stays the same

Discovery, validation, the `--dry-run` preview, explicit confirmation before
generation, skill previews before installation, user-chosen capabilities and
MCP scope, and credential isolation are unchanged. `system.yaml`, the generator,
the `forge` CLI and the in-project `/faur` subcommands are unchanged.
