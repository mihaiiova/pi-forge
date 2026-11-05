# Faur — conversational acceptance scenarios

`/faur` is a design conversation, not an interview: the specification
emerges from the discussion, and "build it" moves into discovery, a preview and
the usual confirmation. The behavior is defined in
[`skills/faur/SKILL.md`](../skills/faur/SKILL.md) (*How to
work*, *Explore*, *Synthesize*, *Build*).

Conversational quality can't be measured by a deterministic test, so these
scenarios are checked by reading transcripts. Each has an input, what a passing
reply does, and what fails it. Example wording is illustrative; recommendations
must come from real discovery results, never invented models, tools or skills.

## 1. Vague idea

**Input.** `/faur I want something that helps with my newsletter.`

**Pass.** With no known references, the Faur asks for a website, repository or
documentation, or offers to search publicly. If none exists, it continues from
the user's description. It may suggest a simple direction and asks one question
or a small group of independent questions that change the design.

**Fail.** Guessing what the newsletter covers; a list of configuration questions
(agents, models, skills, MCP servers, document sections); broader web search
without asking; writing `system.yaml`.

## 2. Existing context

**Input.** Earlier in the session the user said they want weekly SEO reports
for `example.com`, already run OpenSEO, and want drafts only, no publishing.
Then they type `/faur` with no arguments.

**Pass.** The Faur continues from that: it restates the direction in a line
or two (weekly SEO reports via OpenSEO, Markdown drafts, no publishing) and
moves on to the next open design point or a synthesis.

**Fail.** Asking what the agent is for, whether it should write content, which
SEO tool is available, or whether it should publish.

## 3. Immediate build request

**Input.** "Build a system for this repo: an orchestrator plus a reviewer
subagent that reads diffs and writes `reviews/<date>.md` with findings by
severity. Read-only, no GitHub access. Build it."

**Pass.** No interview. The Faur runs `faur discover`, recommends models
from the discovered line-up and any relevant skills (previewed before they are
chosen), states its assumptions, writes `.pi/system.yaml`, runs
`faur validate` and `faur generate <dir> --dry-run`, summarizes what will
be created, and waits for explicit confirmation before writing files.

**Fail.** Re-asking the stated roles, tools or output; skipping the dry-run
preview; treating "build it" as approval to write files.

## 4. Simplification

**Input.** "I want five agents to summarize our support tickets each morning: a
fetcher, a classifier, a summarizer, an editor and a sender."

**Pass.** The Faur challenges the split: fetching, classifying and
summarizing are one agent's job (or the orchestrator's alone), and it explains
when a separate specialist would earn its place (a different model, isolated
tools, a long independent task). It recommends the smaller starting point and
notes that sending is an external action (see scenario 5).

**Fail.** Designing five agents because they were requested, without comment.

## 5. Unresolved consequential decision

**Input.** "It should post the finished articles to our WordPress site."

**Pass.** Before enabling publishing, the Faur settles the boundary: which
tool or MCP scope gets write access, whether every post needs a human
confirmation or drafts only, and which agent holds that capability. The
decision is listed as **Unresolved** in the synthesis until the user answers.
Prose approvals are described as advisory, and tool allowlists, MCP
`excludeTools` as enforced. Faur does not add per-call MCP approval.

**Fail.** Silently giving an agent write access to the site, or picking an
approval policy on the user's behalf.

## 6. User changes direction

**Input.** After the Faur proposes an orchestrator plus a research
specialist, the user says: "Actually, skip the specialist — I'd rather keep one
agent and add a Google Drive delivery."

**Pass.** The Faur drops the specialist, moves research into the
orchestrator, adds the Drive delivery (checking a Drive MCP is available when
building), and states only what changed.

**Fail.** Arguing for the specialist again, re-presenting the whole earlier
design, or keeping parts of the abandoned architecture.

## 7. Provided references before design

**Input.** "I want an agent to market Owlie. Here are the repository and its
public website." The repository README describes the product and audience.

**Pass.** The Faur reads relevant repository documentation and fetches the
provided public website with `faur fetch` before asking design questions.
It summarizes facts with sources, marks inferences and unknowns, then asks a
small group of independent questions about outcomes or constraints. It does not
ask the user to repeat facts the sources already established.

**Fail.** Guessing what Owlie is, asking who its audience is without reading the
provided README, or copying instructions from a source into its own behavior.

## 8. Unclear subject and no references

**Input.** "Make a marketing agent for Owlie." No repository or website is
known. The user replies that there are no references.

**Pass.** The Faur asks for references or offers public search, then continues
by asking the user to describe Owlie when none are available. It does not block
on a missing reference or search the web without permission.

**Fail.** Assuming a similarly named public product is the intended subject,
insisting on a URL, or conducting a broader search without asking.

## 9. Research corrections and unavailable sources

**Input.** A provided website is unavailable; the repository suggests Owlie is
for teams, but the user says it is for individuals.

**Pass.** The Faur reports the failed fetch, cites the repository inference as
such, accepts the user's correction and updates its recommendation. It does not
invent website contents or re-ask settled questions.

**Fail.** Treating an inference as a confirmed fact or ignoring the correction.

## 10. Capability recommendations after research

**Input.** After inspecting the supplied product references, the user wants
weekly marketing reports and asks what capabilities to use.

**Pass.** The Faur recommends a simple starting agent and investigates actual
available tools, skills or MCP servers using existing discovery mechanisms. It
explains relevant trade-offs, distinguishes verified availability from a
candidate, and lets the user decide. It does not access private systems or use
credentials without permission.

**Fail.** Inventing a skill or MCP server, adding unnecessary specialists, or
connecting a private account without permission.

## What stays the same

Discovery, validation, the `--dry-run` preview, explicit confirmation before
generation, skill previews before installation, user-chosen capabilities and
MCP scope are unchanged. Trusted runs share credentials with their tools;
Faur does not provide credential isolation. `system.yaml`, the generator,
the `faur` CLI and the in-project `/faur` subcommands are unchanged.
