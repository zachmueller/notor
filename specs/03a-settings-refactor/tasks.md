# Task Breakdown: Settings Refactor — Module Decomposition

**Created:** 2026-09-03
**Status:** Not Started

## Overview

Decompose the monolithic `src/settings.ts` (~1,500 lines) into a `src/settings/` module directory using **Option B: Section-based split**. The file currently bundles four distinct concerns:

1. **Type definitions** — `ModelPricing`, `Hook`, `HookEvent`, `HookConfig`, `NotorSettings` (~120 lines)
2. **Default constants** — `DEFAULT_SETTINGS` and sub-defaults (~100 lines)
3. **Static reference data** — `AWS_REGIONS`, `TOOL_DISPLAY_NAMES` (~70 lines)
4. **Pure helper functions** — `getProvider`, `updateProvider`, `validateCronExpressionBasic` (~80 lines)
5. **`NotorSettingTab` class** — ~1,100 lines with 20+ render methods

The `NotorSettingTab` class is further decomposed into per-section renderer functions, each in its own file under `src/settings/sections/`.

## Task Summary

**Total Tasks:** 7
**Phases:** 4 (Scaffold → Extract Data → Extract Sections → Migrate Consumers & Validate)
**Estimated Complexity:** Medium
**Risk:** Low — purely structural; no behavioral changes

## Dependency Graph

```
S-001 (Scaffold directory + barrel index + backward-compat shim)
  │
  ├──▶ S-002 (Extract types, defaults, constants, helpers)
  │       │
  │       └──▶ S-003 (Extract section renderers from NotorSettingTab)
  │               │
  │               └──▶ S-004 (Slim NotorSettingTab to thin orchestrator)
  │                       │
  │                       └──▶ S-005 (Migrate all 21 consumer imports)
  │                               │
  │                               └──▶ S-006 (Remove backward-compat shim)
  │                                       │
  │                                       └──▶ S-007 (Build verification & cleanup)
```

---

## Import Dependency Inventory

Before implementing, here is the complete map of what each consumer imports from `src/settings.ts`:

### Type-only imports (`NotorSettings`)

| Consumer File | Imports |
|---|---|
| `src/chat/dispatcher.ts` | `NotorSettings` |
| `src/chat/orchestrator.ts` | `NotorSettings`, `ModelPricing` |
| `src/context/auto-context.ts` | `NotorSettings` |
| `src/context/compaction.ts` | `NotorSettings` |
| `src/hooks/hook-engine.ts` | `Hook`, `NotorSettings` |
| `src/hooks/hook-events.ts` | `NotorSettings`, `Hook` |
| `src/hooks/vault-event-dispatcher.ts` | `NotorSettings` |
| `src/hooks/vault-event-handlers.ts` | `NotorSettings` |
| `src/hooks/vault-event-hook-engine.ts` | `NotorSettings` |
| `src/hooks/vault-event-listener-manager.ts` | `NotorSettings` |
| `src/personas/auto-approve-resolver.ts` | `NotorSettings` |
| `src/personas/persona-manager.ts` | `NotorSettings` |
| `src/providers/registry-factory.ts` | `NotorSettings` |
| `src/shell/shell-executor.ts` | `NotorSettings` |
| `src/shell/shell-resolver.ts` | `NotorSettings` |
| `src/tools/execute-command.ts` | `NotorSettings` |
| `src/tools/fetch-webpage.ts` | `NotorSettings` |

### Type imports (`Hook`, `HookEvent`, `HookConfig`)

| Consumer File | Imports |
|---|---|
| `src/hooks/hook-config.ts` | `Hook`, `HookEvent`, `HookConfig` (imports and **re-exports**) |
| `src/hooks/hook-engine.ts` | `Hook`, `NotorSettings` |
| `src/hooks/hook-events.ts` | `Hook`, `NotorSettings` |
| `src/hooks/workflow-hook-override.ts` | `Hook` |

### Value imports (`DEFAULT_SETTINGS`, `NotorSettingTab`)

| Consumer File | Imports |
|---|---|
| `src/main.ts` | `DEFAULT_SETTINGS`, `NotorSettings`, `NotorSettingTab` |

### E2E tests

E2E scripts (`e2e/scripts/*.ts`) do **not** import from `src/settings.ts`. They construct settings JSON objects inline. **No E2E changes required.**

---

## Phase 0: Scaffold

### S-001: Create `src/settings/` directory structure and backward-compat shim

**Description:** Create the `src/settings/` directory with the target file structure and a barrel `index.ts` that re-exports everything. Convert the original `src/settings.ts` into a thin re-export shim that points to the new module. This ensures all 21 existing consumer imports continue to work unchanged throughout the migration.

**Files:**
- `src/settings/index.ts` — New barrel file; initially empty, will re-export from sub-modules as they are created
- `src/settings.ts` — Convert to re-export shim: `export * from "./settings/index";`

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `src/settings/` directory exists with `index.ts`
- [ ] `src/settings.ts` (root-level) is converted to a single-line re-export shim: `export * from "./settings/index";`
- [ ] `src/settings/index.ts` initially re-exports everything that was previously in `src/settings.ts` (copy content temporarily, or import from a monolithic `src/settings/_legacy.ts` intermediate file)
- [ ] `npm run build` succeeds — all 21 consumers resolve their imports through the shim with zero changes
- [ ] `npx tsc --noEmit` passes with no new errors
- [ ] No runtime behavior changes — the plugin loads and functions identically

**Implementation Notes:**
- The simplest approach: rename `src/settings.ts` → `src/settings/_legacy.ts`, then create `src/settings/index.ts` that re-exports everything from `./_legacy`, and create `src/settings.ts` as `export * from "./settings/index"`. This gives a guaranteed-working intermediate state.

---

## Phase 1: Extract Data Modules

### S-002: Extract types, defaults, constants, and helper functions

**Description:** Split the non-UI content out of the legacy settings file into focused modules within `src/settings/`. Each module has a single responsibility. The barrel `index.ts` is updated to re-export from the new sub-modules.

**Files created:**
- `src/settings/types.ts` — `ModelPricing`, `Hook`, `HookEvent`, `HookConfig`, `NotorSettings` interfaces/types
- `src/settings/defaults.ts` — `DEFAULT_SETTINGS`, `DEFAULT_PROVIDERS`, `DEFAULT_AUTO_APPROVE`, `DEFAULT_HOOKS`, `DEFAULT_VAULT_EVENT_HOOKS`
- `src/settings/constants.ts` — `AWS_REGIONS`, `TOOL_DISPLAY_NAMES`
- `src/settings/helpers.ts` — `getProvider()`, `updateProvider()`, `validateCronExpressionBasic()`

**Files modified:**
- `src/settings/index.ts` — Update re-exports to source from new sub-modules
- `src/settings/_legacy.ts` — Remove the extracted content (leaving only the `NotorSettingTab` class and its imports)

**Dependencies:** S-001

**Acceptance Criteria:**
- [ ] `src/settings/types.ts` exports: `ModelPricing`, `Hook`, `HookEvent`, `HookConfig`, `NotorSettings`
- [ ] `src/settings/defaults.ts` exports: `DEFAULT_SETTINGS` (and the sub-defaults it depends on: `DEFAULT_PROVIDERS`, `DEFAULT_AUTO_APPROVE`, `DEFAULT_HOOKS`, `DEFAULT_VAULT_EVENT_HOOKS`)
- [ ] `src/settings/constants.ts` exports: `AWS_REGIONS` (array of `{ value, label }`), `TOOL_DISPLAY_NAMES` (record of tool metadata)
- [ ] `src/settings/helpers.ts` exports: `getProvider()`, `updateProvider()`, `validateCronExpressionBasic()`
- [ ] `src/settings/index.ts` re-exports all public symbols from the new sub-modules — the public API surface is unchanged
- [ ] Import paths within the extracted modules reference each other correctly (e.g., `defaults.ts` imports `NotorSettings` from `./types`, `helpers.ts` imports `NotorSettings` from `./types`)
- [ ] `defaults.ts` imports `LLMProviderConfig` from `../types` (the root `src/types.ts`) and `VaultEventHookConfig` from `../types`
- [ ] `npm run build` succeeds with zero consumer changes
- [ ] `npx tsc --noEmit` passes
- [ ] No runtime behavior changes

**Notes on type dependencies:**
- `NotorSettings` references types from `src/types.ts` (`ConversationMode`, `LLMProviderConfig`, `VaultEventHookConfig`). These remain imported from `../types` in `src/settings/types.ts`.
- `Hook` references `HookEvent` which is defined in the same file — both move together to `src/settings/types.ts`.
- `DEFAULT_SETTINGS` references `DEFAULT_PROVIDERS` etc. which are private constants — all move together to `src/settings/defaults.ts`.

---

## Phase 2: Extract Section Renderers

### S-003: Extract `NotorSettingTab` section renderers into standalone functions

**Description:** Extract each `render*` method from `NotorSettingTab` into a standalone function in its own file under `src/settings/sections/`. Each function receives a `SettingsContext` object containing the shared dependencies, eliminating the need for `this.plugin` access.

**Shared context interface:**
```ts
/** Shared dependencies passed to each settings section renderer. */
export interface SettingsContext {
	app: App;
	plugin: NotorPlugin;
	settings: NotorSettings;
	saveSettings: () => Promise<void>;
	redisplay: () => void;
}
```

**Files created:**

| File | Functions extracted | Approx. lines |
|---|---|---|
| `src/settings/sections/context.ts` | `SettingsContext` interface definition | ~15 |
| `src/settings/sections/active-provider.ts` | `renderActiveProviderSection()` | ~25 |
| `src/settings/sections/provider-local.ts` | `renderLocalProviderSection()` | ~40 |
| `src/settings/sections/provider-anthropic.ts` | `renderAnthropicProviderSection()` | ~25 |
| `src/settings/sections/provider-openai.ts` | `renderOpenAIProviderSection()` | ~40 |
| `src/settings/sections/provider-bedrock.ts` | `renderBedrockProviderSection()` | ~80 |
| `src/settings/sections/connection-test.ts` | `renderConnectionTestButton()` | ~55 |
| `src/settings/sections/auto-context.ts` | `renderAutoContextSection()` | ~45 |
| `src/settings/sections/fetch-webpage.ts` | `renderFetchWebpageSection()` | ~95 |
| `src/settings/sections/execute-command.ts` | `renderExecuteCommandSection()` | ~100 |
| `src/settings/sections/hooks.ts` | `renderHooksSection()` | ~120 |
| `src/settings/sections/vault-event-hooks.ts` | `renderVaultEventHooksSection()`, `renderVaultEventHookSubsection()` | ~250 |
| `src/settings/sections/file-attachments.ts` | `renderFileAttachmentsSection()` | ~25 |
| `src/settings/sections/compaction.ts` | `renderCompactionSection()` | ~40 |
| `src/settings/sections/provider-reference.ts` | `renderProviderModelReferenceSection()` | ~75 |
| `src/settings/sections/general.ts` | `renderGeneralSection()` | ~30 |
| `src/settings/sections/auto-approve.ts` | `renderAutoApproveSection()` | ~50 |
| `src/settings/sections/persona-auto-approve.ts` | `renderPersonaAutoApproveSection()`, `triggerPersonaRescan()` | ~170 |
| `src/settings/sections/history.ts` | `renderHistorySection()` | ~50 |
| `src/settings/sections/checkpoints.ts` | `renderCheckpointSection()` | ~50 |
| `src/settings/sections/model-pricing.ts` | `renderModelPricingSection()`, `renderModelPricingRow()` | ~70 |

**Dependencies:** S-002

**Acceptance Criteria:**
- [ ] Each section renderer is a standalone exported function with signature: `(containerEl: HTMLElement, ctx: SettingsContext) => void` (sync) or `=> Promise<void>` (async where needed)
- [ ] The `SettingsContext` interface is defined in `src/settings/sections/context.ts` and imported by all section files
- [ ] Provider section renderers (`provider-local.ts`, etc.) import `getProvider()` and `updateProvider()` from `../helpers`
- [ ] `connection-test.ts` uses a dynamic `import()` for `registry-factory` to avoid circular deps (same pattern as the current code)
- [ ] `hooks.ts` imports `Hook`, `HookConfig` from `../types`
- [ ] `vault-event-hooks.ts` imports vault event hook CRUD functions from `../../hooks/vault-event-hook-config` (unchanged)
- [ ] `persona-auto-approve.ts` handles its own async state: `cachedPersonas` is managed as a closure variable within the `renderPersonaAutoApproveSection()` function, with a `triggerPersonaRescan()` helper that re-renders the section container when discovery completes
- [ ] `auto-approve.ts` imports `TOOL_DISPLAY_NAMES` from `../constants`
- [ ] All Obsidian UI imports (`Setting`, `Notice`, `SecretComponent`, `TextComponent`) are imported directly in each section file that uses them — no central re-export
- [ ] `npm run build` succeeds
- [ ] `npx tsc --noEmit` passes

**Design decisions:**

1. **Stateful persona section:** The `renderPersonaAutoApproveSection()` function is the one exception that needs local state (`cachedPersonas`, `personaAutoApproveSectionEl`). This is handled by having the function accept a `containerEl` that it owns and an optional initial `cachedPersonas` array. The `triggerPersonaRescan()` function returns a `Promise<Persona[]>` and the caller can re-invoke `renderPersonaAutoApproveSection()` on the same container when results arrive.

2. **`redisplay` callback:** Section renderers that need to re-render the full settings tab (e.g., domain denylist add/remove, allowed paths add/remove, hook add/remove) call `ctx.redisplay()`, which triggers `NotorSettingTab.display()`. This replaces the current `this.display()` calls.

3. **Provider sections share `connection-test.ts`:** The `renderConnectionTestButton()` function is shared by all four provider sections. Each provider section calls it at the end of its rendering.

---

### S-004: Slim `NotorSettingTab` to thin orchestrator

**Description:** Replace the 20+ inline render methods in `NotorSettingTab` with calls to the extracted section functions from S-003. The `display()` method becomes a ~60-line orchestrator that creates the `SettingsContext` and calls each section renderer in order. The class retains only `display()`, the constructor, and the persona state fields.

**Files modified:**
- `src/settings/_legacy.ts` (or renamed to `src/settings/settings-tab.ts`) — Gut the class body; import and call section renderers

**Dependencies:** S-003

**Acceptance Criteria:**
- [ ] `NotorSettingTab` class is in `src/settings/settings-tab.ts` (renamed from `_legacy.ts`)
- [ ] Class body contains only: constructor, `display()` method, and the `cachedPersonas` / `personaAutoApproveSectionEl` state for the persona section
- [ ] `display()` creates a `SettingsContext` object and passes it to each section renderer function
- [ ] Each section call in `display()` is a one-liner like: `renderAutoContextSection(containerEl, ctx);`
- [ ] The persona auto-approve section still handles async rescan correctly: `display()` creates the container div, calls the initial render, then calls `triggerPersonaRescan()` which updates the container on completion
- [ ] `src/settings/index.ts` re-exports `NotorSettingTab` from `./settings-tab`
- [ ] `src/settings/settings-tab.ts` is under ~100 lines total (class definition + imports + display orchestration)
- [ ] `npm run build` succeeds
- [ ] `npx tsc --noEmit` passes
- [ ] No runtime behavior changes — every settings section renders and functions identically

---

## Phase 3: Migrate Consumers & Validate

### S-005: Migrate all consumer imports to `src/settings/` module path

**Description:** Update all 21 consumer files to import from `"../settings"` (which resolves to `src/settings/index.ts`) instead of the root-level shim. For consumers that only need types, use `import type` to ensure tree-shakability. Also update `src/hooks/hook-config.ts` which re-exports `Hook`, `HookEvent`, `HookConfig`.

**Files modified:**
- All 21 consumer files listed in the Import Dependency Inventory above
- `src/hooks/hook-config.ts` — Update re-export source

**Dependencies:** S-004

**Acceptance Criteria:**
- [ ] All 17 type-only consumers use `import type { NotorSettings } from "../settings"` — import paths unchanged (the barrel index resolves)
- [ ] `src/main.ts` uses `import { DEFAULT_SETTINGS, NotorSettingTab } from "./settings"` and `import type { NotorSettings } from "./settings"` — path unchanged
- [ ] `src/hooks/hook-config.ts` imports from `"../settings"` (unchanged path, now resolves through barrel)
- [ ] All import paths that currently reference `"../settings"` or `"./settings"` continue to work — the directory module with `index.ts` is resolved by TypeScript and esbuild automatically
- [ ] Verify no file imports from `"../settings/_legacy"`, `"../settings/types"`, or other internal module paths — all external consumers go through the barrel `index.ts`
- [ ] `npm run build` succeeds
- [ ] `npx tsc --noEmit` passes

**Implementation note:** Because TypeScript and esbuild both resolve `"./settings"` to `./settings/index.ts` when a directory module exists, most consumer import paths may not need any changes at all. The key verification is that the build succeeds and all symbols resolve correctly. The main action items are:
1. Verify each consumer compiles (automated by `npm run build`)
2. Confirm `hook-config.ts` re-exports still work
3. Confirm `main.ts` value imports (`DEFAULT_SETTINGS`, `NotorSettingTab`) resolve through the barrel

### S-006: Remove backward-compat shim

**Description:** Delete the root-level `src/settings.ts` re-export shim now that all consumers resolve through the `src/settings/` directory module. Also delete `src/settings/_legacy.ts` if it still exists (should have been renamed to `settings-tab.ts` in S-004).

**Files deleted:**
- `src/settings.ts` — The root-level shim file

**Dependencies:** S-005

**Acceptance Criteria:**
- [ ] `src/settings.ts` (root-level file) is deleted
- [ ] No file named `_legacy.ts` exists in `src/settings/`
- [ ] All imports resolve via `src/settings/index.ts` barrel
- [ ] `npm run build` succeeds
- [ ] `npx tsc --noEmit` passes
- [ ] No runtime behavior changes

### S-007: Build verification, cleanup, and final validation

**Description:** Final verification pass: build, type-check, and manually verify the settings tab renders correctly in Obsidian. Clean up any dead code, unused imports, or stale comments. Verify e2e test suite is unaffected.

**Files:** All files in `src/settings/` — review pass

**Dependencies:** S-006

**Acceptance Criteria:**
- [ ] `npm run build` produces clean `main.js` with no warnings
- [ ] `npx tsc --noEmit` passes with no errors
- [ ] No circular dependency warnings in build output
- [ ] Each file in `src/settings/` is under 300 lines (per AGENTS.md guidance)
- [ ] `src/settings/settings-tab.ts` (the `NotorSettingTab` class) is under 100 lines
- [ ] Module boundary is clean: no section file imports from another section file (each only imports from `./context`, `../types`, `../defaults`, `../constants`, `../helpers`, or external modules)
- [ ] All JSDoc comments and file-level documentation are updated to reflect the new module structure
- [ ] The `src/settings/index.ts` barrel exports exactly the same public API as the original `src/settings.ts`: `ModelPricing`, `Hook`, `HookEvent`, `HookConfig`, `NotorSettings`, `DEFAULT_SETTINGS`, `NotorSettingTab`
- [ ] E2E tests are unaffected (they don't import from src/settings)

---

## Target File Structure

```
src/settings/
├── index.ts                          # Barrel re-exports (public API)
├── types.ts                          # ModelPricing, Hook, HookEvent, HookConfig, NotorSettings
├── defaults.ts                       # DEFAULT_SETTINGS and sub-defaults
├── constants.ts                      # AWS_REGIONS, TOOL_DISPLAY_NAMES
├── helpers.ts                        # getProvider, updateProvider, validateCronExpressionBasic
├── settings-tab.ts                   # NotorSettingTab class (thin orchestrator)
└── sections/
    ├── context.ts                    # SettingsContext interface
    ├── active-provider.ts            # renderActiveProviderSection()
    ├── provider-local.ts             # renderLocalProviderSection()
    ├── provider-anthropic.ts         # renderAnthropicProviderSection()
    ├── provider-openai.ts            # renderOpenAIProviderSection()
    ├── provider-bedrock.ts           # renderBedrockProviderSection()
    ├── connection-test.ts            # renderConnectionTestButton()
    ├── auto-context.ts               # renderAutoContextSection()
    ├── fetch-webpage.ts              # renderFetchWebpageSection()
    ├── execute-command.ts            # renderExecuteCommandSection()
    ├── hooks.ts                      # renderHooksSection()
    ├── vault-event-hooks.ts          # renderVaultEventHooksSection(), renderVaultEventHookSubsection()
    ├── file-attachments.ts           # renderFileAttachmentsSection()
    ├── compaction.ts                 # renderCompactionSection()
    ├── provider-reference.ts         # renderProviderModelReferenceSection()
    ├── general.ts                    # renderGeneralSection()
    ├── auto-approve.ts               # renderAutoApproveSection()
    ├── persona-auto-approve.ts       # renderPersonaAutoApproveSection(), triggerPersonaRescan()
    ├── history.ts                    # renderHistorySection()
    ├── checkpoints.ts                # renderCheckpointSection()
    └── model-pricing.ts              # renderModelPricingSection(), renderModelPricingRow()
```

---

## Cross-Reference: Consumer Impact

### Files with ZERO import path changes needed

All 21 consumer files currently use `from "../settings"` or `from "./settings"`. TypeScript and esbuild both resolve a bare module path to `<dir>/index.ts` when a directory exists. Therefore, **most consumers need no import path changes** — the barrel `index.ts` re-exports the same symbols.

### Files requiring verification only

| File | Current Import | Notes |
|---|---|---|
| `src/main.ts` | `from "./settings"` | Value imports (`DEFAULT_SETTINGS`, `NotorSettingTab`) — must resolve through barrel |
| `src/hooks/hook-config.ts` | `from "../settings"` | Re-exports `Hook`, `HookEvent`, `HookConfig` — verify re-export chain works |
| `src/chat/orchestrator.ts` | `from "../settings"` | Imports both `NotorSettings` and `ModelPricing` — verify both re-exported |

### Files with no changes needed

The remaining 18 consumer files import only `NotorSettings` (type-only) and their `from "../settings"` path resolves identically.

---

## Parallel Execution Opportunities

Tasks are strictly sequential due to the incremental migration strategy:

1. **S-001** must complete first (scaffold)
2. **S-002** depends on S-001 (data extraction)
3. **S-003** depends on S-002 (section extraction) — however, individual section files within S-003 are independent and can be created in parallel
4. **S-004** depends on S-003 (orchestrator slimming)
5. **S-005 + S-006** depend on S-004 (consumer migration + shim removal)
6. **S-007** is the final validation gate

Within S-003, all 21 section files are independent of each other and can theoretically be created in any order or in parallel.

## Critical Path

```
S-001 → S-002 → S-003 → S-004 → S-005 → S-006 → S-007
```

The critical path is linear. The longest phase is S-003 (extracting ~21 section renderer files), but individual sections are independent and straightforward copy-paste-and-adapt operations.

---

## Risk Mitigation

1. **Build breakage:** Every task has an acceptance criterion requiring `npm run build` and `npx tsc --noEmit` to pass. The backward-compat shim (S-001) ensures all consumers work at every intermediate step.
2. **Circular dependencies:** Section renderers import from `../helpers` and `../constants` (which import from `../types`), but never import from each other. The `connection-test.ts` renderer uses dynamic `import()` for the provider registry (existing pattern). No new circular dependency paths are introduced.
3. **esbuild resolution:** esbuild resolves `"./settings"` to `./settings/index.ts` when the directory exists. This is verified in S-001 and is a standard Node.js/TypeScript module resolution behavior.
4. **Re-export chain depth:** `src/main.ts` → `src/settings/index.ts` → `src/settings/defaults.ts` (for `DEFAULT_SETTINGS`). esbuild tree-shakes and inlines re-exports, so the extra indirection has zero runtime cost.

---

## Design Decisions

1. **Barrel re-export strategy:** A single `index.ts` barrel file re-exports the complete public API. Internal module paths (`settings/types`, `settings/defaults`, etc.) are considered private — external consumers always import through the barrel. This keeps the API surface stable and allows internal restructuring without consumer impact.

2. **`SettingsContext` over individual parameters:** Section renderers receive a `SettingsContext` object rather than individual `(settings, saveSettings, redisplay)` parameters. This provides a clean, extensible interface — adding a new dependency (e.g., `app` for `SecretComponent`) doesn't require changing every function signature.

3. **Functions over classes for sections:** Section renderers are plain functions, not classes. Most sections are stateless render operations. The one exception (persona auto-approve with its async rescan) uses a closure-based approach rather than a class, keeping the pattern consistent.

4. **Intermediate `_legacy.ts` file:** During migration, the original monolithic content lives in `_legacy.ts` and is progressively emptied as content moves to sub-modules. This avoids a "big bang" rewrite and ensures the build stays green at every step.

5. **No consumer path changes:** By using a directory module with `index.ts`, all existing `from "../settings"` / `from "./settings"` import paths continue to resolve correctly. This is the lowest-risk migration path — consumers are unaware of the internal restructuring.

---

## Readiness for Implementation

- [x] Complete import dependency inventory (21 files cataloged with exact imports)
- [x] Target file structure defined with per-file content assignments
- [x] Consumer impact assessed — zero import path changes expected
- [x] Build/type-check verification gates at every task
- [x] Backward-compat shim strategy for safe incremental migration
- [x] Stateful section (persona auto-approve) handling designed
- [x] Risk mitigation documented for build breakage, circular deps, and esbuild resolution
- [x] E2E test impact assessed — no changes needed
