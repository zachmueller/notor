# Template Variable Resolution in Scaffolds — Design Spec

**Status:** Design phase
**Date:** 2026-04-19
**Consumers:** [Memory Integration Plan](../../private/knowledge-memory-integration-plan.md) (first consumer — memory sub-agent profiles embed `{notor_dir}` in system prompts and `<notor_tool_config>` blocks)

---

## 1. Motivation

Notor's extension system lets users author tools, automations, sub-agent profiles, personas, rules, and workflows as Markdown files in their vault. Today, the content of these scaffolds is treated as static text — whatever the user writes is what the LLM sees, what the tool-config parser parses, and what the path enforcer evaluates.

This breaks down when scaffold content needs to reference dynamic, environment-specific values. The immediate case is the memory feature: all four memory sub-agent profiles must embed the user's configured Notor directory path in both their system prompts (so the LLM knows where to search) and their `<notor_tool_config>` `allowed_paths` declarations (so the path enforcer restricts tools to the correct prefix). That directory is user-configurable (`Notor/` by default, overridable in settings), so it cannot be hardcoded.

The same need arises more broadly. A persona prompt might want to reference `{notor_dir}` to tell the LLM where to find rules. A workflow might reference `{vault_name}` in its instructions. A rule file might reference `{notor_dir}/templates/` as a path the LLM should read from. Without a resolution mechanism, each of these cases requires either hardcoding paths (fragile, non-portable) or inventing ad-hoc workarounds per feature.

---

## 2. Design

### 2.1 Core Concept

A **template variable** is a `{variable_name}` placeholder in scaffold Markdown content that is replaced with its runtime value before the content reaches any downstream consumer (LLM, tool-config parser, path enforcer, code-fence compiler).

Resolution is a single string substitution pass — not a template engine. No conditionals, no loops, no nested expressions. The syntax is intentionally simple: `{variable_name}` where `variable_name` is a known identifier from a fixed registry.

### 2.2 Variable Registry

A small registry maps variable names to resolver functions:

```typescript
interface TemplateVariableRegistry {
  /** Register a variable with its resolver. */
  register(name: string, resolver: () => string): void;
  /** Resolve all known variables in the input string. */
  resolve(input: string): string;
  /** List registered variable names (for documentation/validation). */
  list(): string[];
}
```

**Initial variables (ship with the feature):**

| Variable | Resolves to | Example |
|----------|-------------|---------|
| `{notor_dir}` | User's configured Notor directory, vault-relative | `notor` |
| `{vault_name}` | Obsidian vault name | `My Vault` |

The registry is extensible — future variables can be added without changing the resolution infrastructure. Each variable's resolver is a synchronous function that reads from settings or the Obsidian app context.

### 2.3 Resolution Pass — Where It Runs

Resolution must happen **after** file read and frontmatter stripping, but **before** any downstream parsing (tool-config extraction, code-fence compilation, system-prompt assembly, include-note resolution). The following table identifies the exact insertion points in the current codebase:

| Content Type | File | Function | Insertion Point |
|---|---|---|---|
| User tool/automation scaffolds | `src/extensions/discovery.ts` | `parseOneExtensionFile` | After `vault.cachedRead()` (~line 212), before `parseExtensionFile()` call |
| Built-in tool/automation scaffolds | `src/extensions/manager.ts` | `reload` | Wrap `scaffold.scaffoldContent` (~line 232) before `parseExtensionFile()` call |
| Sub-agent profiles (vault) | `src/sub-agents/discovery.ts` | `parseProfile` | After `stripFrontmatter()` (~line 182), before `extractToolConfigs()` |
| Sub-agent profiles (built-in) | `src/sub-agents/discovery.ts` | `buildProfileFromBuiltin` | After `stripFrontmatter()` (~line 237), before `extractToolConfigs()` |
| Personas | `src/personas/persona-discovery.ts` | `parsePersona` | After `stripFrontmatter()` (~line 165), before content is returned |
| Vault rules | `src/rules/vault-rules.ts` | `loadRuleFile` | After `parseFrontmatterAndBody()` (~line 301), before `content: parsed.body` is stored |
| Custom base prompt | `src/chat/system-prompt.ts` | `getBasePrompt` | After `stripFrontmatter()` (~line 344), before `resolveIncludeNotesIfAvailable()` |
| Workflow body | `src/workflows/workflow-executor.ts` | `readWorkflowBody` | After frontmatter slice (~line 69), before returning body |

At each point, the body content string is passed through `registry.resolve(content)` before any further processing.

### 2.4 Resolution Semantics

- **Unknown variables are left as-is.** `{unknown_var}` passes through untouched. This avoids breaking content that happens to contain brace-delimited text (e.g., TypeScript generics in code fences, JSON examples).
- **Resolution is idempotent.** Running the pass twice produces the same result — resolved values do not themselves contain `{...}` patterns that would trigger further substitution.
- **No escaping mechanism initially.** If a user wants a literal `{notor_dir}` in their output, they cannot prevent substitution in the initial implementation. This is acceptable because (a) the variable set is small and well-known, (b) the collision surface with natural prose is minimal (`{notor_dir}` is not a phrase anyone would type organically), and (c) an escape syntax (`\{notor_dir\}` or `{{notor_dir}}`) can be added later if needed without breaking existing content.
- **Resolution is synchronous.** All variable resolvers read from in-memory state (settings, app context). No async I/O during resolution.

### 2.5 Interaction with `<notor_tool_config>` Blocks

The tool-config extraction in `src/sub-agents/discovery.ts` calls `extractToolConfigs()` on the scaffold body to parse `<notor_tool_config>` YAML blocks and produce `ParsedToolConfig[]` entries with concrete `allowed_paths` / `blocked_paths` arrays. These arrays flow into the path enforcer at dispatch time.

Because template variable resolution runs *before* `extractToolConfigs()`, the YAML parser sees concrete paths (e.g., `allowed_paths: ["notor/memory"]`) rather than raw placeholders. No changes to the tool-config parser or path enforcer are needed.

### 2.6 Interaction with `<include_note>` Resolution

Some content types (`vault-rules.ts`, `system-prompt.ts`, `workflow-executor.ts`) run an `<include_note>` resolution pass after loading. Template variable resolution runs *before* `<include_note>` resolution, so included notes' paths can themselves be template variables (e.g., `<include_note>{notor_dir}/templates/base.md</include_note>`). Content pulled in via `<include_note>` is **not** re-resolved for template variables — only the outer scaffold content is resolved. This avoids surprising behavior where editing a general-purpose note suddenly changes meaning because it was included into a scaffold context.

---

## 3. Implementation

### 3.1 New Files

| File | Purpose |
|------|---------|
| `src/template-vars/registry.ts` | `TemplateVariableRegistry` class — register, resolve, list |
| `src/template-vars/builtin-vars.ts` | Registers `{notor_dir}`, `{vault_name}` |

### 3.2 Modified Files

| File | Change |
|------|--------|
| `src/extensions/discovery.ts` | Call `registry.resolve()` on raw content before `parseExtensionFile()` |
| `src/extensions/manager.ts` | Call `registry.resolve()` on `scaffold.scaffoldContent` for built-in scaffolds; pass registry to sub-agent and persona managers |
| `src/sub-agents/discovery.ts` | Call `registry.resolve()` on body content after `stripFrontmatter()`, before `extractToolConfigs()` (both vault and built-in paths) |
| `src/personas/persona-discovery.ts` | Call `registry.resolve()` on body content after `stripFrontmatter()` |
| `src/rules/vault-rules.ts` | Call `registry.resolve()` on `parsed.body` after `parseFrontmatterAndBody()` |
| `src/chat/system-prompt.ts` | Call `registry.resolve()` on stripped content after `stripFrontmatter()`, before `resolveIncludeNotesIfAvailable()` |
| `src/workflows/workflow-executor.ts` | Call `registry.resolve()` on body after frontmatter slice, before returning |
| `src/main.ts` | Instantiate `TemplateVariableRegistry`, register built-in variables, wire into discovery/manager pipelines |

### 3.3 Registry Lifecycle

1. **Plugin load** (`main.ts`): instantiate `TemplateVariableRegistry`, call `registerBuiltinVars(registry, settings, app)`.
2. **Settings change**: when `notor_dir` changes in settings, the registry's resolver for `{notor_dir}` automatically picks up the new value on next `resolve()` call (resolvers read from the live settings object, not a snapshot).
3. **Plugin unload**: no cleanup needed — the registry is garbage-collected with the plugin.

---

## 4. Verification Plan

| Area | Test |
|------|------|
| Registry | Unit: `resolve("{notor_dir}/memory")` returns `"notor/memory"` with default settings |
| Registry | Unit: unknown variables pass through unchanged — `resolve("{unknown}/foo")` returns `"{unknown}/foo"` |
| Registry | Unit: idempotency — `resolve(resolve(input))` === `resolve(input)` |
| Registry | Unit: multiple variables in one string — `resolve("{notor_dir}/{vault_name}")` resolves both |
| Tool-config integration | Unit: scaffold with `allowed_paths: ["{notor_dir}/memory"]` produces `ParsedToolConfig` with `allowed_paths: ["notor/memory"]` after resolution + extraction |
| Sub-agent profile | E2E: load a built-in sub-agent profile containing `{notor_dir}` in its system prompt; verify the assembled system prompt sent to the LLM contains the concrete path |
| Persona | E2E: create a persona with `{notor_dir}` in its prompt content; verify the system prompt builder sees the resolved value |
| Settings change | E2E: change `notor_dir` in settings; reload extensions; verify newly loaded scaffolds resolve to the updated path |
| Code fence safety | Unit: TypeScript code containing `const x = {notor_dir}` (as a JS object destructure, not a template variable) is not corrupted — the variable name matches and is substituted, but this is the correct behavior since it's inside scaffold code that references the path |

---

## 5. Design Questions

1. **Should `<include_note>` content be re-resolved?** Current answer: no — only the outer scaffold is resolved. This prevents action-at-a-distance where a general note changes behavior when included into a scaffold. If this proves too restrictive (e.g., a user wants a shared template fragment with variables), it can be revisited.

2. **Should frontmatter values be resolved?** Current answer: no. The resolution pass runs on body content after frontmatter is stripped. Frontmatter values are parsed separately — from Obsidian's metadata cache for user files, or via `extractFrontmatterField()` regex for built-ins — before the resolution point. This is acceptable because path-bearing values (`allowed_paths`, etc.) live in `<notor_tool_config>` blocks within the body content, which is resolved. If a future need arises to resolve template variables in frontmatter fields, individual field values can be resolved explicitly at their extraction site.

3. **Should we warn on unresolved variables?** Not initially. Since unknown variables pass through silently, a typo like `{noter_dir}` would silently produce a broken path. A future lint/validation pass could flag `{...}` patterns in `allowed_paths` that don't match any registered variable, but this is not needed for the initial implementation.

---

## 6. Sequencing

This feature is a prerequisite for the memory integration plan but is independently useful. Implement in this order:

1. `src/template-vars/registry.ts` + `builtin-vars.ts` — the registry and initial variables.
2. Wire into `src/main.ts` — instantiate and register built-ins.
3. Add `registry.resolve()` calls at each insertion point (§2.3 table) — one file at a time, testable independently.
4. Unit + E2E tests per §4.
5. Memory plan can begin building scaffolds that depend on `{notor_dir}` resolution.
