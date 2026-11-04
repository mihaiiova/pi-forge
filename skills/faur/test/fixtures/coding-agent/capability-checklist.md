# coding-agent fixture — capability checklist

The representative `system.yaml` beside this file must reproduce the existing
pi-config coding-agent setup. `faur validate` must accept it (spec 1); later
specs progressively assert that generation reproduces these capabilities.

- [ ] **Spec lifecycle workflows** — `spec-new`, `spec-start`, `spec-review`,
      `spec-close` declared as `workflows[]`, each orchestrating the primary
      session and the specialist subagents via the named skill.
- [ ] **GitHub issue/label integration** — the orchestrator/worker carry `gh`
      access via `GH_TOKEN` (secret) and the spec-lifecycle skills drive issues
      and lifecycle labels.
- [ ] **Existing skills** — `spec-start`, `spec-review`, `spec-close`, `tdd`,
      `code-review` declared as `skills[]` (provided by the pinned pi-config
      package dependency, referenced not copied).
- [ ] **scout/worker/reviewer subagents** — declared as `agents[]` with
      read-only (`scout`, `reviewer`) and single-writer (`worker`) tool
      allowlists; `oracle` as the high-tier reasoning subagent.
- [ ] **Model tiers + routing** — `models.tiers` high/medium/small with
      `parentTier` and `subagents` routing matching pi-config's
      `generate-settings.mjs` materialization.
- [ ] **Verification commands** — `spec-review` workflow's `verify` gates on the
      project's `spec.checks`; `faur validate` gates the model itself.
- [ ] **Session/cost accounting** — provided by the pinned pi-config package
      dependency (`project-state` extension); no new runtime in the model.
- [ ] **Project settings** — `.pi/settings.json` model fragment + `spec.*`
      block preserved and reconciled, not clobbered.
- [ ] **Extension dependencies** — pi-config's own extensions (pi-config,
      pi-sync, project-state, …) are declared as a pinned package dependency in
      the generated project's `packages`, plus the npm packages it needs.
