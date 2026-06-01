---
name: audit-personas-docs
description: Audit the built-in personas (notor-help, tool-creator) and the repo docs against the real code, find drift (renamed/removed tools, dead settings deep-links, stale utils/libs API, missing tools in tables), report it as a findings table, then propose diffs and apply them ONLY after the user approves. Use when personas or docs feel out of date, after adding/renaming/removing a built-in tool, setting, settings-section, sub-agent, or extension API, before a release, or when asked to "update notor-help / tool-creator" or "bring the docs up to date".
---

# Audit Built-in Personas & Repo Docs for Drift

Notor's built-in personas (`src/personas/builtin-personas.ts`) and its docs make many
**concrete factual claims** about the plugin — tool names, settings-section names, the
extension `utils`/`libs` API surface, frontmatter fields, param/setting types. None of
these are type-checked against the code, so they **drift silently** as the code evolves:
a renamed settings group leaves a dead `notor-settings://` deep-link, a new built-in tool
never makes it into the tool table, a refactored `libs` export leaves the `tool-creator`
persona teaching an API that no longer exists.

This skill is the safety net. It derives ground truth from the **actual code**, diffs the
personas and docs against it, and reports drift — flagging breakage (dead deep-links,
nonexistent tools) above cosmetic gaps.

> **This skill proposes before it edits.** It enumerates, diffs, and reports first. It
> presents concrete diffs and makes **no edits until the user approves** — matching
> Notor's safety-by-default ethos. On approval it applies the edits and commits via the
> Git MCP tools (see [.claude/rules/git.md](../../rules/git.md)).

**The anti-drift rule (read this first):** never hand-copy a list of tools / sections /
APIs into this skill and diff against the copy — the copy is just another thing that
drifts. Always derive ground truth fresh each run: run `inventory.ts` for the importable
registries, and **read the source files** in the map below for everything else.

**Prerequisites:** Node with `npx tsx` on PATH (already used by the repo, e.g. the
`audit-bedrock-thinking` skill). No credentials or network needed — this is a local
code-vs-prose audit.

---

## Step 0: Orient — read the personas and decide scope

1. Read the personas you're auditing **fresh each run** (they change):
   `src/personas/builtin-personas.ts` — the `notor-help` and `tool-creator`
   `systemPromptContent` strings, including their `<notor_tool_config>` blocks and the
   `tool-creator` `utils`/`libs`/frontmatter prose.
2. Decide scope. **Default to a full cross-check** — drift may predate the current branch
   point, so a thorough sweep is the right default (this is what the skill is for). As an
   *accelerator only*, you may list recently-changed source areas to prioritize:
   ```bash
   git diff --stat $(git merge-base HEAD main) HEAD -- src/
   ```
   Use that to decide what to look at **first**, not to limit the audit. If you do scope
   down for speed, **say so explicitly in the report** — never let a partial pass read as
   "everything is in sync."

---

## Step 1: Build ground truth

### 1a. Importable registries → `inventory.ts`

Run the bundled helper (it imports the same registries the plugin ships, so the audit
can't drift from a hand-copied list):

```bash
npx tsx .claude/skills/audit-personas-docs/inventory.ts
```

It prints JSON:
```
{ tools: [{ name, mode }], toolCount, personas: [name], subAgentProfiles: [name] }
```

`tools` is the **complete invocable set** = the 31 scaffolds in `BUILTIN_TOOL_SCAFFOLDS`
**plus** `use_subagent` (which is registered separately in `src/sub-agents/constants.ts`,
NOT in the scaffold map). Trust this list for "does tool X exist / what mode is it" — do
**not** re-derive tool names by grepping, and do **not** flag `use_subagent` as missing.

### 1b. Obsidian-coupled truth → read the source

These truth surfaces live in modules that import `obsidian` *values* and therefore can't
be imported under `tsx`. **Read them from source** each run (paths in the map below):
settings group/subsection names, the `utils` API surface, the bundled `libs`, the injected
variable names, frontmatter/param/setting schemas, the web-search provider list, and the
hidden `log_level` default.

---

## Source-of-truth map

Every claim a persona or doc makes maps to exactly one authoritative definition. Diff
against these — never against memory or a hand-copied list.

| Claim surface | Authoritative source | How to read it |
|---|---|---|
| Built-in tool names + read/write mode | `BUILTIN_TOOL_SCAFFOLDS` (`src/extensions/builtin-tool-scaffolds/index.ts`) + `USE_SUBAGENT_TOOL_NAME` (`src/sub-agents/constants.ts`) | `inventory.ts` (`tools`) |
| Built-in persona names | `BUILTIN_PERSONA_PROFILES` (`src/personas/builtin-personas.ts`) | `inventory.ts` (`personas`) |
| Built-in sub-agent profile names | `BUILTIN_SUBAGENT_PROFILES` (`src/sub-agents/builtin-profiles.ts`) | `inventory.ts` (`subAgentProfiles`) |
| Settings group names (deep-link targets) | `createSettingsGroup(containerEl, "<Name>", …)` calls in `src/settings/settings-tab.ts` `display()` | read source (group names are the 2nd arg) |
| Settings subsection names (deep-link targets) | `markSubsection(setting, "<Name>")` calls across `src/settings/sections/*.ts` (helper: `src/settings/helpers.ts`) | grep `markSubsection(` under `src/settings/` |
| Extension `utils` API surface | `ExtensionUtils` interface (`src/extensions/runtime-context/types.ts`) + `buildUtils` (`src/extensions/runtime-context/index.ts`) | read source |
| Bundled `libs` | `buildLibs` + `ExtensionLibs` (`src/extensions/runtime-context/index.ts`) | read source |
| Injected variable names (tool / automation) | `TOOL_ARG_NAMES` / `AUTOMATION_ARG_NAMES` (`src/extensions/compiler.ts`) | read source |
| Extension frontmatter fields + `notor-mode` / trigger values | `src/extensions/parser.ts` (`VALID_TRIGGERS` near top; tool/automation field validation) | read source |
| Param + setting types | `ParamSchema` / `SettingsFieldSchema` (`src/extensions/types.ts`); `VALID_SETTING_TYPES` (`src/extensions/settings-schema.ts`); param conversion (`src/extensions/param-schema.ts`) | read source |
| `web_search` provider list | `src/web-search/providers/` (one file per provider; wired via `provider.ts`) | `ls src/web-search/providers/` |
| Hidden `log_level` default | `src/settings/types.ts` (`log_level`) + `src/settings/defaults.ts` | read source |

If you add a new claim surface to a persona or doc, add a row here so the next audit
covers it.

---

## Step 2: Diff claims vs. truth

### Personas (`src/personas/builtin-personas.ts`)

- **Tool configs.** Every tool name in each persona's `<notor_tool_config>` block must
  exist in `inventory.ts.tools`, and the persona's intent must match the tool's `mode`
  (e.g. a tool the persona auto-approves as read-only should actually be `mode: "read"`).
  Flag any tool name that no longer exists, and any tool the persona *should* offer for
  its job but doesn't enable.
- **Settings deep-links (`notor-help`).** Every `notor-settings://<Section>` and
  `…/<Subsection>` reference — including the prose list of group names and the worked
  example — must match a real `createSettingsGroup`/`markSubsection` name **exactly**
  (case- and word-sensitive; the handler matches on the literal string). A renamed or
  removed group = a **dead link = high severity**. Also flag real groups that exist in
  code but are missing from the persona's enumerated list.
- **`tool-creator` API prose.** Diff the documented `utils.*` methods, the `libs` members,
  the injected variable list, the frontmatter fields (`notor-type`, `notor-tool-name`,
  `notor-description`, `notor-mode` values), and the param/setting type lists against
  their sources in the map. Flag removed/renamed APIs (teaching a nonexistent API is
  high severity) and undocumented additions (lower severity).
- **Hidden `log_level` (`notor-help`).** Confirm the setting still exists and the claimed
  default (`"error"`) still matches `src/settings/defaults.ts`.

### Docs (in scope — see Scope section)

- **`docs/vault-tools.md` tool table.** The table must list **exactly** the tools in
  `inventory.ts.tools` (minus none, plus none) with matching Plan/Act vs read/write modes.
  Flag tools present in code but missing from the table, and rows for tools that no longer
  exist. (`use_subagent` belongs in the table — it's a real tool.)
- **`web_search` row.** The provider list in the description must match
  `src/web-search/providers/`.
- **Section / feature references.** Any doc that names a settings section, a tool, a
  persona, a sub-agent, an extension API, or a frontmatter field must resolve against the
  same sources above. Cross-check `docs/extensions.md` against the `tool-creator` sources,
  `docs/personas.md` against `inventory.ts.personas`, `docs/sub-agents.md` against
  `subAgentProfiles`, etc.
- **`README.md` / `AGENTS.md` / `examples/`.** Check the README feature list and any tool
  counts ("N built-in tools") against reality; check `AGENTS.md` paths/commands resolve;
  spot-check `examples/` extension templates against the current extension format.

---

## Step 3: Report

Emit a Markdown findings table — one row per drift item:

| surface | claim | reality | file:line | severity | proposed fix |
|---------|-------|---------|-----------|----------|--------------|

- **surface** — e.g. `notor-help persona`, `docs/vault-tools.md`, `tool-creator persona`.
- **severity** — `high` = user-visible breakage (dead deep-link, documented tool/API that
  doesn't exist); `medium` = real but non-breaking (missing tool row, stale provider list);
  `low` = cosmetic (wording, ordering, undocumented-but-harmless addition).
- **proposed fix** — the concrete edit you would make (the exact new string / new table
  row), not a vague "update this".

Below the table, note: the scope audited (full vs. accelerated), counts (tools/personas/
sub-agents checked), and an explicit list of anything intentionally **not** checked. If
there is **no drift**, say so plainly.

---

## Step 4: Propose → apply on approval

1. Present the findings table and, for each fix, the concrete diff (old → new).
2. **Make no edits until the user approves.** Let them accept all, a subset, or none.
3. On approval, apply only the approved edits with `Edit`/`Write`, then commit via the Git
   MCP tools per [.claude/rules/git.md](../../rules/git.md) — `mcp__git__status` then
   `mcp__git__commit` with only the files you changed. One logical commit (e.g. "Sync
   built-in personas and docs with current tool/settings registry").
4. If nothing is approved, make no edits and say so.

---

## DO / DO NOT

### DO
- Derive ground truth fresh each run — `inventory.ts` for registries, **read the source**
  files in the map for everything else.
- Treat `inventory.ts.tools` as the complete invocable set (31 scaffolds + `use_subagent`).
- Rank findings by severity; lead with breakage (dead deep-links, nonexistent APIs).
- Give concrete proposed edits (exact strings), and apply them **only after approval**.
- State the scope audited and anything skipped — never let a partial pass look complete.
- Add a row to the source-of-truth map when a new claim surface appears.

### DO NOT
- **Never edit personas or docs before the user approves the proposed diffs.**
- Never hand-copy a list of tools / sections / APIs into this skill and diff against the
  copy — always read the live source.
- Never flag `use_subagent` as "documented but nonexistent" — it's a real tool registered
  outside the scaffold map.
- Never flag `design/` or `design/research/` files — they are intentionally-stable
  vision/architecture docs, out of scope (see below).
- Never match settings deep-link names loosely — the handler matches the literal string,
  so "Providers" ≠ "Provider setup".
- Never commit with raw `git` — use the `mcp__git__*` tools per the repo rule.

---

## Scope

- **In scope (sync targets):** built-in personas (`src/personas/builtin-personas.ts`),
  `docs/*.md`, `README.md`, `AGENTS.md`, `examples/`.
- **Out of scope:** `design/` and `design/research/` — vision/architecture docs that
  record intent, not the line-by-line current state of the code. Note them as out of
  scope rather than flagging them as drift.
