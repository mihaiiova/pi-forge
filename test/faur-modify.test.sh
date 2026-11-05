#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
faur="$root/src/faur.mjs"
fixtures="$root/test/fixtures"

pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; exit 1; }

edit_yaml() {
  # edit_yaml <file> <js-expression> — load YAML, mutate `doc`, write back.
  local file="$1" expr="$2"
  node --input-type=module -e "
    import { loadYaml } from '$root/src/yaml-loader.mjs';
    import { readFileSync, writeFileSync } from 'node:fs';
    const YAML = loadYaml();
    const [file, expr] = process.argv.slice(1);
    const doc = YAML.parse(readFileSync(file, 'utf-8'));
    eval(expr);
    writeFileSync(file, YAML.stringify(doc));
  " "$file" "$expr"
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ── modify --dry-run exits 0 and writes nothing ──────────────────
mkdir -p "$work/.pi"
cp "$fixtures/generate/multi-agent/.pi/system.yaml" "$work/.pi/system.yaml"
node "$faur" generate "$work" >/dev/null
edit_yaml "$work/.pi/system.yaml" 'doc.agents.push({ name: "editor", tools: ["write"], model: "provider-a/model-medium", prompt: "Draft.\n" })'

if ! node "$faur" modify "$work" --dry-run >/dev/null 2>&1; then
  fail "modify --dry-run should exit 0"
fi
[[ ! -f "$work/.pi/agents/editor.md" ]] || fail "modify --dry-run wrote a file"
pass "faur modify --dry-run exits 0 and writes nothing"

# ── modify --yes applies non-conflict changes ────────────────────
node "$faur" modify "$work" --yes >/dev/null
[[ -f "$work/.pi/agents/editor.md" ]] || fail "modify --yes did not create the new agent"
pass "faur modify --yes applies non-conflict changes"

# ── modify --yes reports conflicts and never overwrites ─────────
printf '\n(hand-edited orchestrator note)\n' >> "$work/.pi/APPEND_SYSTEM.md"
edit_yaml "$work/.pi/system.yaml" 'doc.orchestrator.prompt = "A brand new orchestrator prompt.\n"'
edit_yaml "$work/.pi/system.yaml" 'doc.agents.push({ name: "blocked-agent", tools: ["read"], model: "provider-a/model-medium", prompt: "Inspect.\n" })'
if out="$(node "$faur" modify "$work" --yes 2>&1)"; then
  fail "modify should reject a plan with conflicts"
fi
grep -q "conflict" <<<"$out" || fail "modify --yes did not report the conflict"
[[ ! -f "$work/.pi/agents/blocked-agent.md" ]] || fail "modify applied part of a conflicting plan"
grep -q "hand-edited orchestrator note" "$work/.pi/APPEND_SYSTEM.md" || fail "modify overwrote a hand-edited authored file"
pass "faur modify --yes reports conflicts without overwriting"

# ── generate removes intact removed scaffolds but preserves edited ones ──
remove_work="$(mktemp -d)"
cp -r "$fixtures/generate/multi-agent/.pi" "$remove_work/"
node "$faur" generate "$remove_work" >/dev/null 2>&1
edit_yaml "$remove_work/.pi/system.yaml" 'doc.agents = doc.agents.filter(a => a.name !== "researcher"); doc.workflows = []'
if node "$faur" generate "$remove_work" </dev/null >/dev/null 2>&1; then fail "existing generate did not require approval"; fi
[[ -e "$remove_work/.pi/agents/researcher.md" ]] || fail "unapproved generate deleted scaffold"
node "$faur" generate "$remove_work" --yes >/dev/null 2>&1 || fail "generate could not remove an intact scaffold"
[[ ! -e "$remove_work/.pi/agents/researcher.md" ]] || fail "removed agent scaffold still exists"
printf '\nDeveloper edit\n' >> "$remove_work/.pi/agents/article-writer.md"
edit_yaml "$remove_work/.pi/system.yaml" 'doc.agents = doc.agents.filter(a => a.name !== "article-writer")'
if node "$faur" generate "$remove_work" >/dev/null 2>&1; then fail "generate accepted an edited removal"; fi
grep -q 'Developer edit' "$remove_work/.pi/agents/article-writer.md" || fail "generate destroyed edited agent"
rm -rf "$remove_work"
pass "generate removes intact removed scaffolds and refuses edited ones"

# ── invalid model exits 1 ────────────────────────────────────────
bad="$(mktemp -d)"
cp -r "$fixtures/invalid-unknown-key/.pi" "$bad/"
if node "$faur" modify "$bad" --yes >/dev/null 2>&1; then
  rm -rf "$bad"
  fail "modify should reject an invalid system.yaml"
fi
rm -rf "$bad"
pass "faur modify rejects an invalid model"

echo
echo "All faur-modify tests passed."
