# Workflow Hooks Fixes & Features — Implementation Tasks

Addresses user-reported issues with custom Notor directory paths, hook triggering,
per-workflow mode/preset configuration, and the `notor-type` frontmatter migration.

**Related source areas:**
- `src/settings/sections/shared.ts` — `ensureDirectory` helper
- `src/workflows/workflow-discovery.ts` — workflow discovery + validation
- `src/hooks/vault-event-dispatcher.ts` — vault event hook dispatch + `executeRunWorkflowAction`
- `src/chat/workflow-executor.ts` — foreground + background workflow execution
- `src/settings/sections/rules-and-workflows.ts` — workflow skeleton + settings UI
- `src/settings/sections/vault-event-hook-subsection.ts` — hook configuration UI
- `src/hooks/vault-event-debounce.ts` — existing global debounce (complementary to per-hook delay)
- `src/hooks/hook-delay-manager.ts` — **NEW** per-hook debounce delay manager
- `src/types.ts` — `Workflow` interface, `VaultEventHook` interface, `ConversationMode`
- `src/main.ts` — plugin initialization, orchestrator creation, scheduler wiring

---

## Phase 1 — Case-Insensitive Directory Handling

Fix the root cause preventing workflows from being created/discovered when the
user's folder casing differs from the code's expected `workflows` (lowercase).

---

### 1.1 Harden `ensureDirectory` against case-insensitive FS collisions

**File:** `src/settings/sections/shared.ts` (lines 176–189)

The current implementation calls `getAbstractFileByPath(normalized)` (case-sensitive)
and then `createFolder(normalized)`. On macOS (case-insensitive by default), if a
folder exists with different casing (e.g., `Workflows` vs `workflows`), the lookup
returns null but `createFolder` throws "Folder already exists".

- [x] **1.1a** Add `TFolder` to the value import from `"obsidian"` (line 7: `import { normalizePath } from "obsidian"` → `import { normalizePath, TFolder } from "obsidian"`)

- [x] **1.1b** Rewrite the `ensureDirectory` function body:
  1. Keep the `parts.split("/")` iteration and `normalizePath()` call
  2. If `getAbstractFileByPath(normalized)` returns non-null:
     - If NOT `instanceof TFolder` → throw `Error("Cannot create directory \"${normalized}\": a file with that name already exists")`
     - If it IS a `TFolder` → `continue` (folder exists, exact match)
  3. If `getAbstractFileByPath` returns null:
     - Attempt `await ctx.app.vault.createFolder(normalized)` inside try-catch
     - In the catch block: scan parent's children for a case-insensitive match; if found → `continue`, otherwise re-throw
     ```typescript
     try {
         await ctx.app.vault.createFolder(normalized);
     } catch (e) {
         const parentPath = normalized.includes("/")
             ? normalized.substring(0, normalized.lastIndexOf("/")) : "";
         const folderName = normalized.substring(normalized.lastIndexOf("/") + 1);
         const parent = parentPath
             ? ctx.app.vault.getAbstractFileByPath(parentPath)
             : ctx.app.vault.getRoot();
         if (parent instanceof TFolder) {
             const match = parent.children.find(
                 c => c instanceof TFolder && c.name.toLowerCase() === folderName.toLowerCase()
             );
             if (match) continue;
         }
         throw e;
     }
     ```

---

### 1.2 Case-insensitive fallback in workflow discovery

**File:** `src/workflows/workflow-discovery.ts` (lines 72–90)

`discoverWorkflows()` calls `vault.getAbstractFileByPath(workflowsRootPath)` where
`workflowsRootPath` is `"<notorDir>/workflows"` (lowercase). If the user's folder is
`"Workflows"` (capital W), the lookup fails and returns an empty array.

- [x] **1.2a** Move `TFolder` from the type-only import to the value import (line 2 has `import type { MetadataCache, TFile, TFolder, Vault } from "obsidian";` — this is type-only and cannot be used with `instanceof`). Move it to line 3: `import { TAbstractFile, TFolder } from "obsidian";` and remove it from line 2.

- [x] **1.2b** After the initial `vault.getAbstractFileByPath(workflowsRootPath)` call (line 78), add case-insensitive fallback:
  ```
  if workflowsRoot is null:
    parentPath = notorDir.replace(/\/$/, "")
    parent = vault.getAbstractFileByPath(parentPath)
    if parent instanceof TFolder:
      match = parent.children.find(c => c instanceof TFolder && c.name.toLowerCase() === "workflows")
      if match: workflowsRoot = match
  ```

- [x] **1.2c** Ensure the rest of the function uses `workflowsRoot.path` (the actual discovered path) rather than `workflowsRootPath` (the constructed lowercase path) for relative path derivation in `parseWorkflowFile`. Currently line 366 uses `workflowsRootPath` for display name computation — this should use the actual root path from the resolved folder.

---

## Phase 2 — `notor-type: workflow` Migration

Migrate workflow identification from `notor-workflow: true` to the more general
`notor-type: workflow` field. Old style remains supported for backward compatibility.

---

### 2.1 Update workflow identification in discovery parser

**File:** `src/workflows/workflow-discovery.ts` — `parseWorkflowFile()` (lines 300–310)

- [x] **2.1a** Change the workflow identification check (line 308):
  ```typescript
  // Before:
  if (frontmatter["notor-workflow"] !== true) { return null; }

  // After:
  const isWorkflow = frontmatter["notor-workflow"] === true
      || frontmatter["notor-type"] === "workflow";
  if (!isWorkflow) { return null; }
  ```

### 2.2 Update workflow validation

**File:** `src/workflows/workflow-discovery.ts` — `validateWorkflow()` (lines 138–199)

- [x] **2.2a** Update the `notor-workflow` validation block (lines 144–150) to accept either style:
  ```typescript
  const workflowFlag = frontmatter["notor-workflow"];
  const notorType = frontmatter["notor-type"];
  if (workflowFlag !== true && notorType !== "workflow") {
      errors.push(
          `Workflow '${filePath}' must have 'notor-type: workflow' or 'notor-workflow: true'`
      );
  }
  ```

### 2.3 Update runtime validation in dispatcher

**File:** `src/hooks/vault-event-dispatcher.ts` — `executeRunWorkflowAction()` (lines 354–362)

- [x] **2.3a** Change line 356 validation:
  ```typescript
  // Before:
  if (!fm?.["notor-workflow"]) { ... }

  // After:
  const isValidWorkflow = fm?.["notor-workflow"] === true || fm?.["notor-type"] === "workflow";
  if (!isValidWorkflow) { ... }
  ```

### 2.4 Update workflow skeleton for new files

**File:** `src/settings/sections/rules-and-workflows.ts` — `buildWorkflowSkeleton()` (lines 65–80)

- [x] **2.4a** Replace `notor-workflow: true` with `notor-type: workflow` in the generated frontmatter:
  ```typescript
  function buildWorkflowSkeleton(trigger: string, schedule: string): string {
      const lines: string[] = ["---"];
      lines.push("notor-type: workflow");
      lines.push(`notor-trigger: ${trigger}`);
      lines.push("notor-conversation-mode: plan");
      if (trigger === "scheduled") {
          lines.push(`notor-schedule: "${schedule || "0 9 * * *"}"`);
      } else {
          lines.push('# notor-schedule: "0 9 * * *"');
      }
      lines.push("# notor-workflow-persona: researcher");
      lines.push("# notor-model-preset: default");
      lines.push("---");
      lines.push("");
      lines.push("<!-- Workflow instructions here. -->");
      lines.push("");
      return lines.join("\n");
  }
  ```

---

## Phase 3 — Per-Workflow Mode Override

Add `notor-conversation-mode` frontmatter property allowing workflows to override
the global Plan/Act mode setting.

---

### 3.1 Add `mode` field to `Workflow` interface

**File:** `src/types.ts` (line 532, after `persona_name` and before `hooks`)

- [x] **3.1a** Add the field:
  ```typescript
  /** Per-workflow conversation mode override from `notor-conversation-mode` (null = inherit). */
  mode: ConversationMode | null;
  ```

### 3.2 Parse `notor-conversation-mode` in discovery

**File:** `src/workflows/workflow-discovery.ts` — `parseWorkflowFile()` (after line 334)

- [x] **3.2a** Add parsing after `activeNotePrompt` parsing:
  ```typescript
  const rawMode = frontmatter["notor-conversation-mode"];
  const mode: ConversationMode | null =
      (rawMode === "plan" || rawMode === "act") ? rawMode : null;
  ```

- [x] **3.2b** Add `mode` to the returned object (line 390–401), placed after `persona_name` and before `hooks`:
  ```typescript
  return {
      file_path: file.path,
      file_name: file.name,
      display_name: displayName,
      aliases,
      trigger,
      schedule,
      persona_name: personaName,
      mode,
      hooks,
      active_note_prompt: activeNotePrompt,
      body_content: "",
  };
  ```

- [x] **3.2c** Add `ConversationMode` to the import from `"../types"` (lines 25–28)

### 3.3 Use workflow mode in foreground execution

**File:** `src/chat/workflow-executor.ts` — `executeWorkflow()` (lines 206–208)

- [x] **3.3a** Change mode determination:
  ```typescript
  // Before:
  const currentMode = conversationManager.hasActiveConversation()
      ? conversationManager.getMode()
      : this.deps.getSettings().mode;

  // After:
  const currentMode = workflow.mode
      ?? (conversationManager.hasActiveConversation()
          ? conversationManager.getMode()
          : this.deps.getSettings().mode);
  ```

### 3.4 Use workflow mode in background execution

**File:** `src/chat/workflow-executor.ts` — `executeBackgroundWorkflow()` (line 444)

- [x] **3.4a** Change:
  ```typescript
  // Before:
  const mode = this.deps.getSettings().mode;

  // After:
  const mode = workflow.mode ?? this.deps.getSettings().mode;
  ```

  NOTE: This change is subsumed by task 4.5a which replaces the same lines.
  Implement once in Phase 4 — listed here for logical completeness.

### 3.5 Include mode in dispatcher's minimal Workflow object

**File:** `src/hooks/vault-event-dispatcher.ts` — `executeRunWorkflowAction()` (lines 365–378)

- [x] **3.5a** Add `mode` to the constructed Workflow object:
  ```typescript
  mode: (fm["notor-conversation-mode"] === "plan" || fm["notor-conversation-mode"] === "act")
      ? fm["notor-conversation-mode"] as ConversationMode
      : null,
  ```

- [x] **3.5b** Add `ConversationMode` to the import from `"../types"` if not already present

---

## Phase 4 — Per-Workflow Model Preset

Add `notor-model-preset` frontmatter property allowing workflows to specify which
model preset to use for execution.

---

### 4.1 Add `model_preset` field to `Workflow` interface

**File:** `src/types.ts` (after the `mode` field added in 3.1, before `hooks`)

- [x] **4.1a** Add:
  ```typescript
  /** Per-workflow model preset override from `notor-model-preset` (null = use active/default). */
  model_preset: string | null;
  ```

### 4.2 Parse `notor-model-preset` in discovery

**File:** `src/workflows/workflow-discovery.ts` — `parseWorkflowFile()` (after mode parsing)

- [x] **4.2a** Add:
  ```typescript
  const modelPreset = parseStringOrNull(frontmatter["notor-model-preset"]);
  ```

- [x] **4.2b** Include `model_preset: modelPreset` in the returned object

### 4.3 Include model_preset in dispatcher's minimal Workflow object

**File:** `src/hooks/vault-event-dispatcher.ts` — `executeRunWorkflowAction()` (lines 365–378)

- [x] **4.3a** Add to the constructed Workflow object:
  ```typescript
  model_preset: (fm["notor-model-preset"] as string | null | undefined)?.trim() ?? null,
  ```

### 4.4 Extract shared preset resolution helper

**New helper** in `src/chat/workflow-executor.ts` (module-level or private method):

- [x] **4.4a** Create a `resolveWorkflowProviderConfig()` helper that delegates to the
  existing `resolvePreset()` from `src/presets/preset-resolver.ts`:
  ```typescript
  import { resolvePreset } from "../presets/preset-resolver";

  interface ResolvedProviderConfig {
      providerId: string;
      modelId: string;
      useExtendedContext: boolean;
  }

  /**
   * Resolve provider/model/context from a workflow's model_preset, falling back
   * to the supplied defaults when no preset is configured or found.
   */
  function resolveWorkflowProviderConfig(
      workflow: Workflow,
      settings: NotorSettings,
      fallbackProviderId: string,
      fallbackModelId: string,
      fallbackExtendedContext: boolean,
  ): ResolvedProviderConfig {
      if (workflow.model_preset) {
          const resolved = resolvePreset(workflow.model_preset, settings.model_presets);
          if (resolved) {
              return {
                  providerId: resolved.providerId,
                  modelId: resolved.modelId,
                  useExtendedContext: resolved.useExtendedContext,
              };
          }
          log.warn("Workflow model preset not found or unconfigured, using fallback", {
              preset: workflow.model_preset,
              workflowName: workflow.display_name,
          });
      }
      return {
          providerId: fallbackProviderId,
          modelId: fallbackModelId,
          useExtendedContext: fallbackExtendedContext,
      };
  }
  ```

### 4.5 Use helper in background execution

**File:** `src/chat/workflow-executor.ts` — `executeBackgroundWorkflow()` (lines 441–444)

- [x] **4.5a** Replace the current provider/model/mode resolution (lines 441–444):
  ```typescript
  // Before:
  const providerId = this.deps.providerRegistry.getActiveId();
  const providerConfig = this.deps.providerRegistry.getConfig(providerId);
  const modelId = providerConfig?.model_id ?? "";
  const mode = this.deps.getSettings().mode;

  // After:
  const mode = workflow.mode ?? this.deps.getSettings().mode;
  const registryProviderId = this.deps.providerRegistry.getActiveId();
  const registryConfig = this.deps.providerRegistry.getConfig(registryProviderId);
  const { providerId, modelId, useExtendedContext } = resolveWorkflowProviderConfig(
      workflow,
      this.deps.getSettings(),
      registryProviderId,
      registryConfig?.model_id ?? "",
      registryConfig?.use_extended_context ?? false,
  );
  ```

- [x] **4.5b** Thread resolved values to `_backgroundResponseLoop`:

  The loop currently re-reads `providerId`, `modelId`, `useExtendedContext`, and
  `pinnedPersona` from the provider registry at lines 596–600. When using a preset,
  the registry won't reflect the correct values.

  1. Pass to `createConversation()` metadata (line 475):
     ```typescript
     use_extended_context: useExtendedContext,  // was: providerConfig?.use_extended_context ?? false
     ```

  2. Add all four as parameters to `_backgroundResponseLoop()`:
     ```typescript
     private async _backgroundResponseLoop(
         bgConversationManager: ConversationManager,
         assemblyResult: WorkflowAssemblyResult,
         mode: ConversationMode,
         execution: WorkflowExecution,
         concurrencyManager: WorkflowConcurrencyManager,
         chain: ExecutionChain,
         providerId: string,            // NEW
         modelId: string,               // NEW
         useExtendedContext: boolean,    // NEW
         pinnedPersona: Persona | null,  // NEW — snapshotted at call site
     ): Promise<void>
     ```

  3. Inside `_backgroundResponseLoop`, DELETE the re-reads at lines 596–600:
     ```typescript
     // REMOVE these lines — use the parameters directly:
     const pinnedPersona = this.deps.getPersonaManager()?.getActivePersona() ?? null;
     const providerId = this.deps.providerRegistry.getActiveId();
     const providerConfig = this.deps.providerRegistry.getConfig(providerId);
     const modelId = providerConfig?.model_id ?? "";
     const useExtendedContext = providerConfig?.use_extended_context ?? false;
     ```

  4. Snapshot persona and pass all four at the call site (line ~512):
     ```typescript
     const pinnedPersona = this.deps.getPersonaManager()?.getActivePersona() ?? null;
     await this._backgroundResponseLoop(
         bgConversationManager, assemblyResult, mode,
         execution, concurrencyManager, chain,
         providerId, modelId, useExtendedContext, pinnedPersona,
     );
     ```

### 4.6 Use helper in foreground execution

**File:** `src/chat/workflow-executor.ts` — `executeWorkflow()` (lines 202–205)

- [x] **4.6a** Apply the same preset resolution for the foreground path:
  ```typescript
  // Before:
  const providerId = this.deps.getActiveProviderId();
  const providerConfig = this.deps.providerRegistry.getConfig(providerId);
  const modelId = this.deps.getActiveModelId();

  // After (foreground uses per-orchestrator accessors as fallback):
  const fallbackProviderId = this.deps.getActiveProviderId();
  const fallbackConfig = this.deps.providerRegistry.getConfig(fallbackProviderId);
  const { providerId, modelId, useExtendedContext } = resolveWorkflowProviderConfig(
      workflow,
      this.deps.getSettings(),
      fallbackProviderId,
      this.deps.getActiveModelId(),
      fallbackConfig?.use_extended_context ?? false,
  );
  ```

- [x] **4.6b** Use the resolved `useExtendedContext` at both downstream sites:
  - Line 223: `use_extended_context: useExtendedContext,` (in `createConversation` metadata)
  - Line 284: use the resolved variable instead of `providerConfig?.use_extended_context ?? false`

---

## Phase 5 — Per-Hook Execution Delay (Debounce)

Add a configurable delay (in milliseconds) between when a vault event fires and when
the hook's automation actually executes. Operates as a debounce: rapid-fire events
reset the timer so only the last event in a burst triggers execution. Combined with
the existing `WorkflowConcurrencyManager` single-instance guard for deduplication.

Delay is configurable at two levels:
- **Per-workflow frontmatter** (`notor-hook-delay`): default delay for any trigger of this workflow
- **Per-hook settings UI** (`delay_ms` field on `VaultEventHook`): overrides the workflow-level value

Applies to all vault event hook types (on_note_open, on_note_create, on_save,
on_manual_save, on_tag_change). Does NOT apply to on_schedule (cron timing is
sufficient). Default value is `0` (no delay, immediate execution — preserves
existing behavior).

---

### 5.1 Add `delay_ms` field to `VaultEventHook` interface

**File:** `src/types.ts` (inside the `VaultEventHook` interface, after `schedule`)

- [x] **5.1a** Add the field:
  ```typescript
  /** Delay in ms before executing this hook after the event fires (null = inherit from workflow, 0 = immediate, >0 = override). Acts as debounce. */
  delay_ms: number | null;
  ```

### 5.2 Add `hook_delay` field to `Workflow` interface

**File:** `src/types.ts` (inside the `Workflow` interface, after `model_preset` added in 4.1)

- [x] **5.2a** Add the field:
  ```typescript
  /** Per-workflow hook delay from `notor-hook-delay` in ms (null = no delay preference). */
  hook_delay: number | null;
  ```

### 5.3 Parse `notor-hook-delay` in workflow discovery

**File:** `src/workflows/workflow-discovery.ts` — `parseWorkflowFile()` (after model preset parsing)

- [x] **5.3a** Add parsing:
  ```typescript
  const rawHookDelay = frontmatter["notor-hook-delay"];
  const hookDelay: number | null =
      (typeof rawHookDelay === "number" && rawHookDelay >= 0) ? rawHookDelay : null;
  ```

- [x] **5.3b** Include `hook_delay: hookDelay` in the returned object

### 5.4 Include `hook_delay` in dispatcher's minimal Workflow object

**File:** `src/hooks/vault-event-dispatcher.ts` — `executeRunWorkflowAction()` (lines 365–378)

- [x] **5.4a** Add to the constructed Workflow object:
  ```typescript
  hook_delay: (() => {
      const raw = fm["notor-hook-delay"];
      return (typeof raw === "number" && raw >= 0) ? raw : null;
  })(),
  ```

### 5.5 Add delay_ms to hook configuration UI

**File:** `src/settings/sections/vault-event-hook-subsection.ts`

- [x] **5.5a** In the "Add hook" form (after the label input, ~line 195), add a delay input field:
  ```typescript
  let newDelayMs: number | null = null;
  new Setting(addContainer)
      .setName("Delay (ms)")
      .setDesc("Debounce delay before execution. Empty = inherit from workflow, 0 = immediate.")
      .addText((text) =>
          text.setPlaceholder("inherit").onChange((value) => {
              if (value.trim() === "") {
                  newDelayMs = null;
              } else {
                  const parsed = parseInt(value, 10);
                  newDelayMs = (!isNaN(parsed) && parsed >= 0) ? parsed : null;
              }
          })
      );
  ```

- [x] **5.5b** In the Add button handler, pass `delay_ms: newDelayMs` to `addVaultEventHook()`

- [x] **5.5c** In the existing hook list rendering (per-hook row), display the delay value
  if non-zero/non-null (e.g., as a subtle `⏱ 2000ms` badge or tooltip). Show nothing for `null` (inherit).

### 5.6 Update `addVaultEventHook` to accept `delay_ms`

**File:** `src/hooks/vault-event-hook-config.ts` — `addVaultEventHook()`

- [x] **5.6a** Add `delay_ms` parameter (defaulting to `null`) and include it in the constructed
  `VaultEventHook` object

### 5.7 Create `HookDelayManager` class

**New file:** `src/hooks/hook-delay-manager.ts`

- [x] **5.7a** Create the debounce manager:
  ```typescript
  /**
   * Manages per-hook execution delays with debounce semantics.
   * Each new event for the same hook+note pair resets the timer.
   */
  export class HookDelayManager {
      /** Map key: `${hookId}::${notePath}` → pending timeout handle */
      private pending = new Map<string, ReturnType<typeof setTimeout>>();

      /**
       * Schedule a hook execution with debounce.
       * If called again for the same key before the delay elapses,
       * the previous timer is cancelled and a new one starts.
       */
      schedule(
          hookId: string,
          notePath: string,
          delayMs: number,
          execute: () => void | Promise<void>,
      ): void {
          const key = `${hookId}::${notePath}`;

          const existing = this.pending.get(key);
          if (existing !== undefined) {
              clearTimeout(existing);
          }

          const handle = setTimeout(() => {
              this.pending.delete(key);
              void execute();
          }, delayMs);

          this.pending.set(key, handle);
      }

      /** Cancel all pending delays (plugin unload). */
      destroy(): void {
          for (const handle of this.pending.values()) {
              clearTimeout(handle);
          }
          this.pending.clear();
      }

      /** Number of pending delayed executions (for testing/debugging). */
      get size(): number {
          return this.pending.size;
      }
  }
  ```

  **Key design notes:**
  - Key includes both `hookId` (or workflow path for trigger-based workflows) and `notePath`
    so the same hook can have independent debounces for different notes
  - For discovered workflows (no `id` field), use `workflow.file_path` as the hook identifier
  - The existing `WorkflowConcurrencyManager.isWorkflowRunning()` check (deduplication)
    is applied inside the `execute` callback, not in the delay manager — the concurrency
    check must happen at execution time, not at schedule time

### 5.8 Integrate `HookDelayManager` into dispatcher

**File:** `src/hooks/vault-event-dispatcher.ts`

- [x] **5.8a** Add `hookDelayManager` to `DispatcherDeps` interface:
  ```typescript
  hookDelayManager: HookDelayManager;
  ```

- [x] **5.8b** Restructure `executeRunWorkflowAction()` into resolution + execution phases.
  The delay wraps only the execution phase — shell commands (`execute_command`) are never delayed.

  **Updated function signature** — add optional delay params:
  ```typescript
  export async function executeRunWorkflowAction(
      workflowPath: string,
      context: VaultEventHookContext,
      chain: ExecutionChain | null,
      deps: DispatcherDeps,
      hookDelayMs?: number | null,
      hookId?: string,
  ): Promise<void>
  ```

  **Extract inner function** `_executeWorkflowSubmission` containing current lines 380–498
  (TriggerContext build through concurrency submission + headless destroy):
  ```typescript
  async function _executeWorkflowSubmission(
      workflow: Workflow,
      workflowFile: TFile,
      context: VaultEventHookContext,
      chain: ExecutionChain | null,
      deps: DispatcherDeps,
  ): Promise<void> {
      // Lines 380-498: TriggerContext build, prompt assembly, persona switching,
      // chain extension, execution record, orchestrator guard, concurrency submit
  }
  ```

  **Insert delay check** after workflow object construction (line 378), before calling
  the extracted inner function:
  ```typescript
  // After workflow object is built (line 378):
  const effectiveDelay = (context.hookEvent === "on_schedule")
      ? 0
      : (hookDelayMs ?? workflow.hook_delay ?? 0);

  if (effectiveDelay > 0) {
      deps.hookDelayManager.schedule(
          hookId ?? workflow.file_path,
          context.notePath ?? "",
          effectiveDelay,
          async () => {
              // Re-check concurrency at execution time (not schedule time)
              if (deps.concurrencyManager.isWorkflowRunning(workflow.file_path)) {
                  log.warn("Workflow already running after delay; skipping", {
                      workflowName: workflow.display_name,
                  });
                  return;
              }
              await _executeWorkflowSubmission(workflow, workflowFile, context, chain, deps);
          },
      );
      return;
  }

  // effectiveDelay === 0 → immediate execution
  await _executeWorkflowSubmission(workflow, workflowFile, context, chain, deps);
  ```

  **Call sites in `_executeOneHook()`:**

  For the **workflow trigger path** (line 222-240), replace the existing concurrency
  check + call with a single call passing `null` for hookDelayMs (uses workflow's own
  `hook_delay` directly):
  ```typescript
  // Replace lines 226-240:
  await executeRunWorkflowAction(
      workflow.file_path, context, chain, deps,
      null,               // hookDelayMs — inherit from workflow.hook_delay
      workflow.file_path, // hookId — use file path as debounce key
  );
  ```

  For the **VaultEventHook `run_workflow` path** (line 271-289), replace the existing
  concurrency check + call, passing the hook's delay_ms:
  ```typescript
  // Replace lines 282-289:
  await executeRunWorkflowAction(
      workflowPath, context, chain, deps,
      vaultHook.delay_ms, // hookDelayMs — null=inherit, 0=immediate, >0=override
      vaultHook.id,       // hookId — use hook ID as debounce key
  );
  ```

  Effective delay resolution: `hookDelayMs ?? workflow.hook_delay ?? 0`
  - Workflow trigger: `null ?? workflow.hook_delay ?? 0` → uses workflow's delay
  - VaultEventHook (null): `null ?? workflow.hook_delay ?? 0` → inherits workflow's delay
  - VaultEventHook (0): `0` → explicitly immediate
  - VaultEventHook (2000): `2000` → explicit override

- [x] **5.8c** _(removed — merged into 5.8b above)_

- [x] **5.8d** `on_schedule` events skip delay entirely (handled by setting `effectiveDelay = 0`
  when `context.hookEvent === "on_schedule"` in both paths above).

### 5.9 Wire `HookDelayManager` in main.ts

**File:** `src/main.ts`

- [x] **5.9a** Create and store a `HookDelayManager` instance during plugin load:
  ```typescript
  private _hookDelayManager: HookDelayManager;
  // In onload():
  this._hookDelayManager = new HookDelayManager();
  ```

- [x] **5.9b** Call `this._hookDelayManager.destroy()` in plugin `onunload()`

- [x] **5.9c** Pass instance to dispatcher deps in `getDispatcherDeps()`:
  ```typescript
  hookDelayManager: this._hookDelayManager,
  ```

### 5.10 Interaction with existing debounce system

The existing `VaultEventDebounce` class (`src/hooks/vault-event-debounce.ts`) operates at
the **event handler level** — it suppresses repeated events for the same (eventType, notePath)
pair within a global cooldown window. This prevents the handler from even collecting hooks.

The new `HookDelayManager` operates at the **per-hook dispatch level** — after an event passes
the global debounce and reaches dispatch. These two systems are complementary:

1. Global debounce (`vault_event_debounce_seconds`) → coarse filter, prevents event flooding
2. Per-hook delay (`delay_ms` / `notor-hook-delay`) → fine-grained per-hook debounce with
   reset-on-repeat semantics

They do NOT conflict. The global debounce fires first; events that pass it are then subject
to per-hook delay if configured.

---

## Phase 6 — Remove Orchestrator Dependency for Background Workflows

Currently, background workflows (hook-triggered + scheduled) silently fail if no
Notor chat panel is open (`getActiveOrchestrator()` returns null). Refactor to spawn
a per-execution headless orchestrator.

---

### 6.1 Expose headless orchestrator factory

**File:** `src/main.ts` — plugin class

- [x] **6.1a** Add a thin wrapper method that reuses the existing `createOrchestrator()`:
  ```typescript
  /**
   * Create a headless orchestrator for background workflow execution.
   * Reuses createOrchestrator() (line 2159) which already passes undefined
   * for view — the view is only wired later via wireView(). Skipping
   * wireView() gives a fully functional headless orchestrator.
   */
  createHeadlessOrchestrator(): ChatOrchestrator {
      return this.createOrchestrator();
  }
  ```

  `createOrchestrator()` already has full post-construction wiring (tool definitions,
  persona manager, extension accessors, checkpoint manager, etc.). No duplication needed.

  Background workflows bypass SessionGuard (they use WorkflowConcurrencyManager instead),
  so no lifecycle cleanup is needed — the orchestrator is GC'd after the execution completes.

### 6.2 Add `createHeadlessOrchestrator` to `DispatcherDeps`

**File:** `src/hooks/vault-event-dispatcher.ts` — `DispatcherDeps` interface (near line 60)

- [x] **6.2a** Add to the interface:
  ```typescript
  /** Factory to create a headless orchestrator for background workflow execution. */
  createHeadlessOrchestrator?: () => ChatOrchestrator;
  ```

### 6.3 Use headless orchestrator in dispatcher

**File:** `src/hooks/vault-event-dispatcher.ts` — `executeRunWorkflowAction()` (lines 463–470)

- [x] **6.3a** Replace the null guard:
  ```typescript
  // Before:
  if (!deps.orchestrator) {
      log.warn("Skipping background workflow — no active orchestrator", { ... });
      return;
  }
  const orchestrator = deps.orchestrator;

  // After:
  let orchestrator = deps.orchestrator;
  if (!orchestrator) {
      if (!deps.createHeadlessOrchestrator) {
          log.warn("Skipping background workflow — no orchestrator available", {
              workflowName: workflow.display_name,
          });
          new Notice(`Workflow '${workflow.display_name}' skipped: unable to create execution context.`);
          return;
      }
      orchestrator = deps.createHeadlessOrchestrator();
      log.info("Created headless orchestrator for background workflow", {
          workflowName: workflow.display_name,
      });
  }
  ```

### 6.4 Wire factory in main.ts

**File:** `src/main.ts` — `getDispatcherDeps()` closure (line 1427)

- [x] **6.4a** Add to the returned deps object:
  ```typescript
  createHeadlessOrchestrator: () => this.createHeadlessOrchestrator(),
  ```

  NOTE: `getDispatcherDeps` is a closure (`const getDispatcherDeps = (): DispatcherDeps => { ... }`)
  defined inside the plugin initialization flow, with `this` bound to the plugin instance.

### 6.5 Lifecycle considerations

Each headless orchestrator is spawned per-execution and is self-contained. After
`executeBackgroundWorkflow` completes (inside `WorkflowConcurrencyManager.submit`'s
async run function), the headless orchestrator must be explicitly destroyed to abort
any lingering session state and flush JSONL writes.

- [x] **6.5a** In `executeRunWorkflowAction()`, wrap the `concurrencyManager.submit()` callback
  with a `finally` block that destroys headless orchestrators:
  ```typescript
  deps.concurrencyManager.submit(execution, async () => {
      try {
          await orchestrator.executeBackgroundWorkflow(...);
      } catch (e) {
          // ... existing error handling ...
      } finally {
          // Only destroy orchestrators we created (headless), not the shared panel one
          if (!deps.orchestrator) {
              await orchestrator.destroy();
          }
      }
  });
  ```

The `WorkflowConcurrencyManager` has a default limit of 3 concurrent executions
(line 74 of `src/workflows/workflow-concurrency.ts`), which bounds the number of
simultaneous headless orchestrators. Queued items wait until a slot opens.

**SessionGuard safety:** The shared `_sessionGuard` instance (a `Set<string>` of
active conversation IDs) is safe to pass to headless orchestrators. Background
workflows always create unique new conversation IDs, so no collision with panel
conversations is possible. JS is single-threaded, so `Set` operations are atomic.

---

## Phase 7 — Auto-Inject Workflow Frontmatter

Automatically inject required frontmatter into workflow files when:
(a) configured as a hook target in settings UI, or
(b) at execution time when validation fails (fallback repair).

---

### 7.1 Create frontmatter injection utility

**New file:** `src/workflows/workflow-frontmatter.ts`

- [x] **7.1a** Create the file with the following exports:

  ```typescript
  import { TFile, type App } from "obsidian";

  export interface FrontmatterInjectionResult {
      injected: boolean;
      fieldsAdded: string[];
  }

  /**
   * Inject required workflow frontmatter fields into a file.
   * Uses `app.fileManager.processFrontMatter()` (same pattern as personas.ts:261).
   * Adds missing fields only — does not overwrite existing values.
   */
  export async function injectWorkflowFrontmatter(
      app: App,
      file: TFile,
      trigger: string,
      mode: string = "plan"
  ): Promise<FrontmatterInjectionResult> {
      const fieldsAdded: string[] = [];

      await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          if (!fm["notor-type"] && fm["notor-workflow"] !== true) {
              fm["notor-type"] = "workflow";
              fieldsAdded.push("notor-type");
          }
          if (!fm["notor-trigger"]) {
              fm["notor-trigger"] = trigger;
              fieldsAdded.push("notor-trigger");
          }
          if (!fm["notor-conversation-mode"]) {
              fm["notor-conversation-mode"] = mode;
              fieldsAdded.push("notor-conversation-mode");
          }
      });

      return { injected: fieldsAdded.length > 0, fieldsAdded };
  }
  ```

  This uses Obsidian's built-in `processFrontMatter` which safely handles both
  existing and missing frontmatter blocks, preserves formatting, and triggers
  metadataCache updates automatically.

### 7.2 Reuse existing event-to-trigger mapping

**File:** `src/hooks/vault-event-listener-manager.ts` (lines 403–423)

The function `vaultEventTypeToWorkflowTrigger()` already provides this mapping.
It returns `null` for `"on_schedule"` (handled by a separate scheduler).

- [x] **7.2a** Add `export` keyword to `vaultEventTypeToWorkflowTrigger` in `vault-event-listener-manager.ts`
  (line 403 — currently a module-private function, not exported).

- [x] **7.2b** At usage sites, apply the fallback for `on_schedule`:
  ```typescript
  import { vaultEventTypeToWorkflowTrigger } from "../hooks/vault-event-listener-manager";

  const trigger = vaultEventTypeToWorkflowTrigger(event) ?? (event === "on_schedule" ? "scheduled" : "manual");
  ```

### 7.3 Auto-inject at hook configuration time (settings UI)

**File:** `src/settings/sections/vault-event-hook-subsection.ts` (lines 236–271, the "Add" button click handler)

- [x] **7.3a** Import `TFile` from `"obsidian"`, `injectWorkflowFrontmatter` from `"../../workflows/workflow-frontmatter"`, and `vaultEventTypeToWorkflowTrigger` from `"../../hooks/vault-event-listener-manager"`

- [x] **7.3b** After the validation checks (line 238 `if (!newCommandOrPath)...`) and before `addVaultEventHook()` call (line 259), add:
  ```typescript
  if (newActionType === "run_workflow") {
      const abstractFile = ctx.app.vault.getAbstractFileByPath(newCommandOrPath);
      if (abstractFile instanceof TFile) {
          const cache = ctx.app.metadataCache.getFileCache(abstractFile);
          const fm = cache?.frontmatter;
          const isValid = fm?.["notor-workflow"] === true || fm?.["notor-type"] === "workflow";
          if (!isValid) {
              const trigger = vaultEventTypeToWorkflowTrigger(event)
                  ?? (event === "on_schedule" ? "scheduled" : "manual");
              const result = await injectWorkflowFrontmatter(ctx.app, abstractFile, trigger, "plan");
              if (result.injected) {
                  new Notice(`Added workflow headers to "${abstractFile.name}" (${result.fieldsAdded.join(", ")})`);
              }
          }
      }
      // If file doesn't exist yet, validation happens at execution time (6.4)
  }
  ```

### 7.4 Auto-repair at execution time (fallback)

**File:** `src/hooks/vault-event-dispatcher.ts` — `executeRunWorkflowAction()` (lines 354–362)

- [x] **7.4a** Import `injectWorkflowFrontmatter` from `"../workflows/workflow-frontmatter"` and
  `vaultEventTypeToWorkflowTrigger` from `"./vault-event-listener-manager"`

- [x] **7.4b** Replace the current validation failure handling:
  ```typescript
  // After the updated validation from 2.3a:
  const isValidWorkflow = fm?.["notor-workflow"] === true || fm?.["notor-type"] === "workflow";
  if (!isValidWorkflow) {
      log.warn("Workflow missing identification, attempting auto-repair", { workflowPath });
      const trigger = vaultEventTypeToWorkflowTrigger(context.hookEvent as VaultEventHookType)
          ?? (context.hookEvent === "on_schedule" ? "scheduled" : "manual");
      const result = await injectWorkflowFrontmatter(deps.app, workflowFile, trigger);
      if (!result.injected) {
          log.warn("Auto-repair failed", { workflowPath });
          new Notice(`'${workflowPath}' is not a valid workflow and auto-repair failed.`);
          return;
      }
      new Notice(`Auto-repaired workflow headers in '${workflowFile.name}'.`);
      // processFrontMatter updates metadataCache synchronously before resolving
      // (same pattern as personas.ts:261, builtin-tool-scaffolds.ts:807/889/1012)
      const newCache = deps.metadataCache.getFileCache(workflowFile);
      fm = newCache?.frontmatter;
      if (!fm) {
          new Notice(`'${workflowPath}' metadata unavailable after repair.`);
          return;
      }
  }
  ```

  NOTE: The `fm` variable needs to be declared with `let` instead of `const` earlier
  in the function (line 353) to allow reassignment after repair.

---

## Phase 8 — Integration & Testing

---

### 8.1 TypeScript compilation

- [ ] **8.1a** Run `npx tsc --noEmit` to verify all type changes compile cleanly. Key things to check:
  - `Workflow` interface now has `mode`, `model_preset`, and `hook_delay` fields — every place that constructs a `Workflow` object must include them
  - `VaultEventHook` interface now has `delay_ms` field — every place that constructs a `VaultEventHook` must include it (check `addVaultEventHook` and any test fixtures)
  - Places that construct `Workflow` objects:
    - `src/workflows/workflow-discovery.ts` — `parseWorkflowFile()` return (line 390)
    - `src/hooks/vault-event-dispatcher.ts` — `executeRunWorkflowAction()` minimal object (line 365)
    - Any test mocks or fixtures that create `Workflow` objects

### 8.2 Manual testing checklist

- [ ] **8.2a** Custom notor_dir with capital-W `Workflows/` folder:
  - Set `notor_dir` to `"Agent Files/Notor/"` in General settings
  - Ensure `Agent Files/Notor/Workflows/` exists in the vault
  - Click "Create new workflow" → should succeed without error
  - Existing workflows in the folder should appear in the list

- [ ] **8.2b** Workflow frontmatter auto-injection:
  - Create a plain `.md` file (no frontmatter) in the vault
  - Go to Automation settings, add a `run_workflow` hook pointing to that file
  - Verify the file now has `notor-type: workflow`, `notor-trigger`, and `notor-conversation-mode` in its frontmatter

- [ ] **8.2c** Per-workflow mode:
  - Add `notor-conversation-mode: act` to a workflow's frontmatter
  - Set global mode to "Plan"
  - Trigger the workflow → should execute in Act mode
  - Check conversation history file header for `mode: "act"`

- [ ] **8.2d** Per-workflow model preset:
  - Create a model preset named "fast" in settings
  - Add `notor-model-preset: fast` to a workflow's frontmatter
  - Trigger the workflow → should use the "fast" preset's provider/model

- [ ] **8.2e** Per-hook delay (debounce):
  - Add `notor-hook-delay: 3000` to a workflow's frontmatter
  - Trigger the hook (e.g., save the note) → should NOT execute immediately
  - Save rapidly 3 times within 3 seconds → should execute exactly once, ~3s after the last save
  - Remove the frontmatter field → verify hook fires immediately again (0 = no delay)
  - Add a hook in settings UI with delay_ms = 2000 pointing to a workflow that has `notor-hook-delay: 5000`
    → verify the 2000ms hook-level setting takes precedence over the 5000ms workflow-level default
  - Verify `on_schedule` hooks ignore delay entirely (always fire immediately)

- [ ] **8.2f** Headless execution (no panel):
  - Close all Notor chat panels
  - Trigger a hook (e.g., Cmd+S with an `on_manual_save` hook)
  - Verify workflow executes successfully (check chat history folder for new conversation file)

- [ ] **8.2g** `notor-type` backward compatibility:
  - Existing workflows with `notor-workflow: true` should still be discovered and executable
  - New workflows created via UI should have `notor-type: workflow` (not `notor-workflow: true`)

- [ ] **8.2h** Scheduled execution:
  - Configure an `on_schedule` hook with `0 * * * *` (every hour on the minute)
  - OR a workflow with `notor-trigger: scheduled` and `notor-schedule: "* * * * *"` (every minute for testing)
  - Close all panels, wait for fire → should execute via headless orchestrator
  - Check logs for `"Created headless orchestrator for background workflow"`

---

## Implementation Order

1. Phase 1 (case-insensitive handling) — unblocks workflow discovery
2. Phase 2 (`notor-type` migration) — foundational for Phase 7's injection
3. Phase 3 (per-workflow mode) — adds `mode` field to `Workflow` type
4. Phase 4 (per-workflow model preset) — adds `model_preset` field + shared resolver helper
5. Phase 5+6 (per-hook delay + headless orchestrator) — combined since both modify `DispatcherDeps` and dispatcher execution flow
6. Phase 7 (auto-inject frontmatter) — uses all new fields
7. Phase 8 (integration testing)
