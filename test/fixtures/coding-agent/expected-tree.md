# coding-agent fixture — expected generated tree (reference)

Generation is **out of scope for spec 1** (it lands in spec 2+). This file is
the reference contract for what the `system.yaml` beside it should eventually
materialize into. Later specs assert progressively more of it.

```text
coding-agent-project/
├── .pi/
│   ├── system.yaml            # this declarative model (faur-owned)
│   ├── settings.json          # model/routing + spec block (faur-owned fragment)
│   ├── mcp.json               # cloudflare server (faur-owned)
│   ├── agents/                # specialist subagents (authored; scaffold + edits)
│   │   ├── scout.md
│   │   ├── worker.md
│   │   ├── reviewer.md
│   │   └── oracle.md
│   ├── skills/                # developer-owned skills
│   │   ├── spec-start/SKILL.md
│   │   ├── spec-review/SKILL.md
│   │   ├── spec-close/SKILL.md
│   │   ├── tdd/SKILL.md
│   │   └── code-review/SKILL.md
│   └── APPEND_SYSTEM.md       # orchestrator instructions (authored)
├── data/                      # mutable outputs + shared knowledge (gitignored)
│   └── knowledge/
├── .gitignore                 # data/, .env, .pi/state.json, .pi/sessions/
├── .env.example               # GH_TOKEN (secret) template
└── README.md                  # how to run, workflows, approvals
```

**Derived (faur-owned):** `.pi/settings.json` model fragment, `.pi/mcp.json`.
**Authored (user-owned):** `.pi/agents/*.md`, `.pi/skills/**`,
`.pi/APPEND_SYSTEM.md`, `README.md`, `.gitignore`, `.env.example`.
**Mutable (gitignored):** `data/**`, `.env`, `.pi/state.json`, `.pi/sessions/`.
