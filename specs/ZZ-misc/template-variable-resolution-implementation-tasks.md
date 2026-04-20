# Template Variable Resolution in Scaffolds — Implementation Tasks

Companion to: [template-variable-resolution-design.md](template-variable-resolution-design.md)
First downstream consumer: [knowledge-memory-design.md](knowledge-memory-design.md) (memory sub-agent profiles embed `{notor_dir}` in system prompts and `<notor_tool_config>` blocks)

---

## Phase 1 — Registry Core (`src/template-vars/`)

The registry class and built-in variable resolvers. No wiring into content pipelines yet — pure TypeScript with unit tests.

- [x] **1.1 — Create `src/template-vars/registry.ts`**
  - Implement `TemplateVariableRegistry` class with three methods:
    - `register(name: string, resolver: () => string): void` — stores name → resolver in an internal `Map<string, () => string>`
    - `resolve(input: string): string` — single-pass substitution: for each registered variable, replace all occurrences of `{name}` with `resolver()` in the input string. Unknown `{...}` patterns pass through untouched
    - `list(): string[]` — returns registered variable names (for documentation/validation)
  - Resolution semantics (from design spec §2.4):
    - Unknown variables left as-is (no error, no removal)
    - Idempotent: `resolve(resolve(x))` === `resolve(x)` — resolved values must not themselves contain `{registeredName}` patterns
    - Synchronous: all resolvers read from in-memory state
    - No escaping mechanism in v1
  - Export the class as the default export

- [x] **1.2 — Create `src/template-vars/builtin-vars.ts`**
  - Implement `registerBuiltinVars(registry: TemplateVariableRegistry, getSettings: () => NotorSettings, getVaultName: () => string): void`
  - Register two variables:
    - `notor_dir` — resolver calls `getSettings().notor_dir` and strips any trailing slash (so `"notor/"` → `"notor"`, consistent with how paths are joined downstream)
    - `vault_name` — resolver calls `getVaultName()` (maps to `app.vault.getName()` at the call site)
  - Resolvers read from live objects (not snapshots) — when `notor_dir` changes in settings, the next `resolve()` call picks up the new value automatically
  - Export the registration function

- [x] **1.3 — Create `src/template-vars/index.ts`**
  - Re-export `TemplateVariableRegistry` from `registry.ts` and `registerBuiltinVars` from `builtin-vars.ts`
  - Single import point for consumers: `import { TemplateVariableRegistry, registerBuiltinVars } from "@/template-vars"`

---

## Phase 2 — Plugin Wiring

Instantiate the registry in the plugin and make it accessible to all content-processing code paths.

- [x] **2.1 — Instantiate registry in `src/main.ts`**
  - Add a private `_templateRegistry?: TemplateVariableRegistry` field to the plugin class
  - Add a lazy `getTemplateRegistry(): TemplateVariableRegistry` accessor (following the existing pattern for `getExtensionManager()` at ~line 1927, `getVaultRuleManager()` at ~line 1883, etc.):
    1. If `_templateRegistry` exists, return it
    2. Otherwise: create a new `TemplateVariableRegistry`, call `registerBuiltinVars(registry, () => this.settings, () => this.app.vault.getName())`, cache and return
  - No explicit teardown needed — the registry is garbage-collected with the plugin

- [x] **2.2 — Pass registry to `ExtensionManager`**
  - `ExtensionManager` already receives the full plugin instance (constructor at [`manager.ts:198-201`](../../src/extensions/manager.ts#L198-L201): `private readonly plugin: NotorPlugin`)
  - Access via `this.plugin.getTemplateRegistry()` — no constructor change needed
  - Verify by reading the `reload()` method (~line 215) to confirm plugin access is available at the call sites

- [x] **2.3 — Pass registry to managers that don't hold a plugin reference**
  - **`SubAgentManager`** ([`sub-agents/manager.ts:29-35`](../../src/sub-agents/manager.ts#L29-L35)): receives `vault`, `metadataCache`, `settings`, `saveData`, `parseYAML` — add `templateRegistry?: TemplateVariableRegistry` parameter. Update instantiation in `main.ts` (~lines 1914-1920)
  - **`PersonaManager`** ([`personas/persona-manager.ts:54-60`](../../src/personas/persona-manager.ts#L54-L60)): receives `vault`, `metadataCache`, `settings`, `providerRegistry`, `saveData` — add `templateRegistry?: TemplateVariableRegistry` parameter. Update instantiation in `main.ts` (~lines 1900-1907)
  - **`SystemPromptBuilder`** ([`chat/system-prompt.ts:59-63`](../../src/chat/system-prompt.ts#L59-L63)): receives `vault`, `notorDir`, `metadataCache` — add `templateRegistry?: TemplateVariableRegistry` parameter. Update instantiation in `main.ts` (~lines 1873-1877)
  - **`VaultRuleManager`** ([`rules/vault-rules.ts:50-53`](../../src/rules/vault-rules.ts#L50-L53)): receives `app`, `notorDir` — add `templateRegistry?: TemplateVariableRegistry` parameter. Update instantiation in `main.ts` (~lines 1885-1887)
  - Store each as a private field for use in content-loading methods

---

## Phase 3 — Integration into Content Pipelines

Insert `registry.resolve()` calls at each content-loading site identified in design spec §2.3. Each insertion follows the same pattern: after file read (and after frontmatter stripping where applicable), before any downstream parsing (`parseExtensionFile`, `extractToolConfigs`, `resolveIncludeNotes`, code-fence compilation).

- [x] **3.1 — User tool/automation scaffolds: `src/extensions/discovery.ts`**
  - In `parseOneExtensionFile` (~line 227-253):
  - After `const content = await vault.cachedRead(file);` (~line 233)
  - Before `return parseExtensionFile(content, ...)` (~line 252)
  - Apply: `const resolved = registry.resolve(content);` and pass `resolved` to `parseExtensionFile`
  - The function currently receives `vault`, `metadataCache`, `file`, `parseYAML` — add `registry: TemplateVariableRegistry` parameter
  - Update the call site in `ExtensionManager.reload()` to pass the registry

- [x] **3.2 — Built-in tool scaffolds: `src/extensions/manager.ts`**
  - In `reload()`, tool scaffold processing (~lines 228-255):
  - Before `parseExtensionFile(scaffold.scaffoldContent, ...)` (~line 240)
  - Apply: `const resolvedContent = this.plugin.getTemplateRegistry().resolve(scaffold.scaffoldContent);` and pass `resolvedContent`

- [x] **3.3 — Built-in automation scaffolds: `src/extensions/manager.ts`**
  - In `reload()`, automation scaffold processing (~lines 278-311):
  - Before `parseExtensionFile(scaffold.scaffoldContent, ...)` (~line 292)
  - Same pattern as 3.2: resolve before parsing

- [x] **3.4 — Sub-agent profiles (vault): `src/sub-agents/discovery.ts`**
  - In `parseProfile` (~lines 131-215):
  - After `const contentAfterFrontmatter = stripFrontmatter(rawContent);` (~line 182)
  - Before `extractToolConfigs()` (~line 185)
  - Apply: `const resolved = registry.resolve(contentAfterFrontmatter);` and use `resolved` in downstream calls
  - This is critical for memory sub-agent profiles: `{notor_dir}` in `<notor_tool_config>` `allowed_paths` must resolve before the tool-config parser sees the YAML

- [x] **3.5 — Sub-agent profiles (built-in): `src/sub-agents/discovery.ts`**
  - In `buildProfileFromBuiltin` (~lines 227-261):
  - After `const contentAfterFrontmatter = stripFrontmatter(systemPromptContent);` (~line 237)
  - Before `extractToolConfigs()` (~line 239)
  - Same pattern as 3.4

- [x] **3.6 — Personas: `src/personas/persona-discovery.ts`**
  - In `parsePersona` (~lines 120-179):
  - After `const promptContent = stripFrontmatter(rawContent);` (~line 165)
  - Before `promptContent` is stored in the returned `Persona` object (~line 167)
  - Apply: resolve `promptContent` before it's returned

- [x] **3.7 — Vault rules: `src/rules/vault-rules.ts`**
  - In `loadRuleFile` (~lines 298-335):
  - After `const parsed = this.parseFrontmatterAndBody(raw);` (~line 301)
  - Before `content: parsed.body` is stored in the `VaultRule` object (~line 305)
  - Apply: `const resolvedBody = this.templateRegistry.resolve(parsed.body);` and use `resolvedBody` as the rule content
  - Note: `resolveIncludeNotes()` runs later in `getActiveRuleContent()` (~line 222) — template vars resolve first (at load time), include_notes resolve at assembly time

- [x] **3.8 — Custom base prompt: `src/chat/system-prompt.ts`**
  - In `getBasePrompt` (~lines 337-365):
  - After `const stripped = this.stripFrontmatter(content);` (~line 344)
  - Before `resolveIncludeNotesIfAvailable()` (~line 349)
  - Apply: resolve `stripped` before passing to include_note resolution
  - This enables `<include_note>{notor_dir}/templates/base.md</include_note>` in custom base prompts (design spec §2.6)

- [x] **3.9 — Workflow body: `src/workflows/workflow-executor.ts`**
  - In `readWorkflowBody` (~lines 58-70):
  - After `rawContent.slice(fmInfo.contentStart)` (~line 69)
  - Before returning the body
  - Apply: resolve the body before returning
  - The function currently receives `file` and `vault` — add `registry: TemplateVariableRegistry` parameter, or access it via a closure/module-level reference
  - Note: `resolveIncludeNotes()` runs later in the workflow assembly pipeline (~lines 95-101) — template vars resolve first

---

## Phase 4 — Unit Tests

- [x] **4.1 — Create `src/template-vars/registry.test.ts`**
  - **Basic resolution:** `resolve("{notor_dir}/memory")` returns `"notor/memory"` when `notor_dir` resolver returns `"notor"`
  - **Multiple variables in one string:** `resolve("{notor_dir}/{vault_name}")` resolves both
  - **Unknown variables pass through:** `resolve("{unknown}/foo")` returns `"{unknown}/foo"` unchanged
  - **Idempotency:** `resolve(resolve(input))` === `resolve(input)` for all test inputs
  - **Empty input:** `resolve("")` returns `""`
  - **No variables present:** `resolve("plain text")` returns `"plain text"`
  - **Adjacent variables:** `resolve("{notor_dir}{vault_name}")` resolves both without delimiter issues
  - **Variable in braces context:** `resolve("const x = {notor_dir}")` resolves (correct per design spec §4, verification plan)
  - **`list()`** returns registered variable names
  - **Registration:** registering the same name twice overwrites the previous resolver

- [x] **4.2 — Create `src/template-vars/builtin-vars.test.ts`**
  - **`notor_dir` resolver:** strips trailing slash from settings value (`"notor/"` → `"notor"`)
  - **`notor_dir` resolver with no trailing slash:** passes through unchanged (`"notor"` → `"notor"`)
  - **`vault_name` resolver:** returns vault name from callback
  - **Live settings:** changing the settings object between `resolve()` calls produces updated values (not stale cached values)
  - **Both variables registered:** after `registerBuiltinVars()`, `registry.list()` contains both `"notor_dir"` and `"vault_name"`

- [x] **4.3 — Integration test: tool-config resolution**
  - Scaffold content containing `allowed_paths: ["{notor_dir}/memory"]` in a `<notor_tool_config>` block
  - After `registry.resolve()` + `extractToolConfigs()`, the resulting `ParsedToolConfig` has `allowed_paths: ["notor/memory"]`
  - Verifies the end-to-end pipeline from design spec §2.5: template vars resolve before tool-config extraction, so the YAML parser sees concrete paths
  - Implemented as E2E test: `e2e/scripts/template-var-resolution-test.ts` — also covers persona prompt resolution, vault_name resolution, unknown variable passthrough, and live settings propagation

---

## Phase 5 — Verification & Polish

- [ ] **5.1 — Verify memory sub-agent profiles work end-to-end**
  - Load a built-in sub-agent profile containing `{notor_dir}` in its system prompt and `<notor_tool_config>` `allowed_paths`
  - Verify the assembled system prompt sent to the LLM contains the concrete path (e.g., `notor/memory` not `{notor_dir}/memory`)
  - Verify the path enforcer receives concrete paths in `allowed_paths` (not raw placeholders)
  - This is the critical verification for the memory integration plan prerequisite

- [ ] **5.2 — Verify persona resolution**
  - Create a persona with `{notor_dir}` in its prompt content
  - Verify the system prompt builder sees the resolved value

- [ ] **5.3 — Verify settings change propagation**
  - Change `notor_dir` in settings → reload extensions → verify newly loaded scaffolds resolve to the updated path
  - Because resolvers read from the live settings object, no re-registration is needed — just verify a new `resolve()` call after settings change picks up the new value

- [ ] **5.4 — Verify `<include_note>` interaction**
  - Create a rule or base prompt with `<include_note>{notor_dir}/templates/base.md</include_note>`
  - Verify template vars resolve first, producing `<include_note>notor/templates/base.md</include_note>`
  - Verify include_note resolution then resolves the concrete path
  - Verify content pulled in via `<include_note>` is NOT re-resolved for template variables (design spec §2.6)

- [ ] **5.5 — TypeScript compilation**
  - `tsc --noEmit` passes with no errors after all changes
  - No type regressions in existing code

- [ ] **5.6 — Move design doc to `done/`**
  - After full verification: `mv specs/ZZ-misc/template-variable-resolution-design.md specs/ZZ-misc/done/`
