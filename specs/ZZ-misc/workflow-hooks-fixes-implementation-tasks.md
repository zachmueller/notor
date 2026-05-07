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
- `src/types.ts` — `Workflow` interface, `ConversationMode`
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

- [ ] **1.1a** Add `TFolder` to the import from `"obsidian"` (line 7, currently only imports `normalizePath`)

- [ ] **1.1b** Rewrite the `ensureDirectory` function body:
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

- [x] **1.2a** ~~Add `TFolder` to the import from `"obsidian"`~~ — **SKIP**: `TFolder` is already imported at line 2 (`import type { MetadataCache, TFile, TFolder, Vault } from "obsidian";`)

- [ ] **1.2b** After the initial `vault.getAbstractFileByPath(workflowsRootPath)` call (line 78), add case-insensitive fallback:
  ```
  if workflowsRoot is null:
    parentPath = notorDir.replace(/\/$/, "")
    parent = vault.getAbstractFileByPath(parentPath)
    if parent instanceof TFolder:
      match = parent.children.find(c => c instanceof TFolder && c.name.toLowerCase() === "workflows")
      if match: workflowsRoot = match
  ```

- [ ] **1.2c** Ensure the rest of the function uses `workflowsRoot.path` (the actual discovered path) rather than `workflowsRootPath` (the constructed lowercase path) for relative path derivation in `parseWorkflowFile`. Currently line 366 uses `workflowsRootPath` for display name computation — this should use the actual root path from the resolved folder.

---

## Phase 2 — `notor-type: workflow` Migration

Migrate workflow identification from `notor-workflow: true` to the more general
`notor-type: workflow` field. Old style remains supported for backward compatibility.

---

### 2.1 Update workflow identification in discovery parser

**File:** `src/workflows/workflow-discovery.ts` — `parseWorkflowFile()` (lines 300–310)

- [ ] **2.1a** Change the workflow identification check (line 308):
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

- [ ] **2.2a** Update the `notor-workflow` validation block (lines 144–150) to accept either style:
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

- [ ] **2.3a** Change line 356 validation:
  ```typescript
  // Before:
  if (!fm?.["notor-workflow"]) { ... }

  // After:
  const isValidWorkflow = fm?.["notor-workflow"] === true || fm?.["notor-type"] === "workflow";
  if (!isValidWorkflow) { ... }
  ```

### 2.4 Update workflow skeleton for new files

**File:** `src/settings/sections/rules-and-workflows.ts` — `buildWorkflowSkeleton()` (lines 65–80)

- [ ] **2.4a** Replace `notor-workflow: true` with `notor-type: workflow` in the generated frontmatter:
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

- [ ] **3.1a** Add the field:
  ```typescript
  /** Per-workflow conversation mode override from `notor-conversation-mode` (null = inherit). */
  mode: ConversationMode | null;
  ```

### 3.2 Parse `notor-conversation-mode` in discovery

**File:** `src/workflows/workflow-discovery.ts` — `parseWorkflowFile()` (after line 334)

- [ ] **3.2a** Add parsing after `activeNotePrompt` parsing:
  ```typescript
  const rawMode = frontmatter["notor-conversation-mode"];
  const mode: ConversationMode | null =
      (rawMode === "plan" || rawMode === "act") ? rawMode : null;
  ```

- [ ] **3.2b** Add `mode` to the returned object (line 390–401), placed after `persona_name` and before `hooks`:
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

- [ ] **3.2c** Add `ConversationMode` to the import from `"../types"` (lines 25–28)

### 3.3 Use workflow mode in foreground execution

**File:** `src/chat/workflow-executor.ts` — `executeWorkflow()` (lines 206–208)

- [ ] **3.3a** Change mode determination:
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

- [ ] **3.4a** Change:
  ```typescript
  // Before:
  const mode = this.deps.getSettings().mode;

  // After:
  const mode = workflow.mode ?? this.deps.getSettings().mode;
  ```

### 3.5 Include mode in dispatcher's minimal Workflow object

**File:** `src/hooks/vault-event-dispatcher.ts` — `executeRunWorkflowAction()` (lines 365–378)

- [ ] **3.5a** Add `mode` to the constructed Workflow object:
  ```typescript
  mode: (fm["notor-conversation-mode"] === "plan" || fm["notor-conversation-mode"] === "act")
      ? fm["notor-conversation-mode"] as ConversationMode
      : null,
  ```

- [ ] **3.5b** Add `ConversationMode` to the import from `"../types"` if not already present

---

## Phase 4 — Per-Workflow Model Preset

Add `notor-model-preset` frontmatter property allowing workflows to specify which
model preset to use for execution.

---

### 4.1 Add `model_preset` field to `Workflow` interface

**File:** `src/types.ts` (after the `mode` field added in 3.1, before `hooks`)

- [ ] **4.1a** Add:
  ```typescript
  /** Per-workflow model preset override from `notor-model-preset` (null = use active/default). */
  model_preset: string | null;
  ```

### 4.2 Parse `notor-model-preset` in discovery

**File:** `src/workflows/workflow-discovery.ts` — `parseWorkflowFile()` (after mode parsing)

- [ ] **4.2a** Add:
  ```typescript
  const modelPreset = parseStringOrNull(frontmatter["notor-model-preset"]);
  ```

- [ ] **4.2b** Include `model_preset: modelPreset` in the returned object

### 4.3 Include model_preset in dispatcher's minimal Workflow object

**File:** `src/hooks/vault-event-dispatcher.ts` — `executeRunWorkflowAction()` (lines 365–378)

- [ ] **4.3a** Add to the constructed Workflow object:
  ```typescript
  model_preset: (fm["notor-model-preset"] as string | null | undefined)?.trim() ?? null,
  ```

### 4.4 Resolve preset to provider/model in background execution

**File:** `src/chat/workflow-executor.ts` — `executeBackgroundWorkflow()` (lines 441–443)

- [ ] **4.4a** Replace the current provider/model resolution:
  ```typescript
  // Before:
  const providerId = this.deps.providerRegistry.getActiveId();
  const providerConfig = this.deps.providerRegistry.getConfig(providerId);
  const modelId = providerConfig?.model_id ?? "";

  // After:
  let providerId: string;
  let modelId: string;
  let useExtendedContext: boolean;

  if (workflow.model_preset) {
      const presets = this.deps.getSettings().model_presets;
      const preset = presets.find(p => p.name === workflow.model_preset);
      if (preset?.provider_id && preset?.model_id) {
          providerId = preset.provider_id;
          modelId = preset.model_id;
          useExtendedContext = preset.use_extended_context;
      } else {
          log.warn("Workflow model preset not found, using default", {
              preset: workflow.model_preset,
              workflowName: workflow.display_name,
          });
          const defaultPreset = presets.find(p => p.name === this.deps.getSettings().default_preset);
          providerId = defaultPreset?.provider_id ?? this.deps.providerRegistry.getActiveId();
          modelId = defaultPreset?.model_id ?? "";
          useExtendedContext = defaultPreset?.use_extended_context ?? false;
      }
  } else {
      providerId = this.deps.providerRegistry.getActiveId();
      const providerConfig = this.deps.providerRegistry.getConfig(providerId);
      modelId = providerConfig?.model_id ?? "";
      useExtendedContext = providerConfig?.use_extended_context ?? false;
  }
  ```

- [ ] **4.4b** Thread resolved provider/model/context to `_backgroundResponseLoop`:

  The loop currently re-reads `providerId`, `modelId`, and `useExtendedContext` from
  the provider registry at lines 597–600. When using a preset, the registry won't
  reflect the correct values. Thread all three as explicit parameters.

  1. Pass to `createConversation()` metadata (line 475):
     ```typescript
     use_extended_context: useExtendedContext,  // was: providerConfig?.use_extended_context ?? false
     ```

  2. Add all three as parameters to `_backgroundResponseLoop()`:
     ```typescript
     // Add to method signature:
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
     ): Promise<void>
     ```

  3. Inside `_backgroundResponseLoop`, DELETE the re-reads at lines 597–600:
     ```typescript
     // REMOVE these lines — use the parameters directly:
     const providerId = this.deps.providerRegistry.getActiveId();
     const providerConfig = this.deps.providerRegistry.getConfig(providerId);
     const modelId = providerConfig?.model_id ?? "";
     const useExtendedContext = providerConfig?.use_extended_context ?? false;
     ```

  4. Pass all three at the call site (line ~512):
     ```typescript
     await this._backgroundResponseLoop(
         bgConversationManager, assemblyResult, mode,
         execution, concurrencyManager, chain,
         providerId, modelId, useExtendedContext,
     );
     ```

### 4.5 Same resolution in foreground execution

**File:** `src/chat/workflow-executor.ts` — `executeWorkflow()` (lines 202–205)

- [ ] **4.5a** Apply the same preset resolution pattern as 4.4a for the foreground path. Currently:
  ```typescript
  const providerId = this.deps.getActiveProviderId();
  const providerConfig = this.deps.providerRegistry.getConfig(providerId);
  const modelId = this.deps.getActiveModelId();
  ```
  Should resolve from `workflow.model_preset` first, falling back to the active provider.

- [ ] **4.5b** Use the resolved `useExtendedContext` at both downstream sites:
  - Line 223: `use_extended_context: useExtendedContext,` (in `createConversation` metadata)
  - Line 284: use the resolved variable instead of `providerConfig?.use_extended_context ?? false`

---

## Phase 5 — Remove Orchestrator Dependency for Background Workflows

Currently, background workflows (hook-triggered + scheduled) silently fail if no
Notor chat panel is open (`getActiveOrchestrator()` returns null). Refactor to spawn
a per-execution headless orchestrator.

---

### 5.1 Create headless orchestrator factory method

**File:** `src/main.ts` — plugin class

- [ ] **5.1a** Add a public method to the plugin class:
  ```typescript
  /**
   * Create a headless orchestrator for background workflow execution.
   * Does not require any open chat panel. Provides full parity with
   * panel-based orchestrators (minus the view).
   */
  createHeadlessOrchestrator(): ChatOrchestrator {
      // VaultRuleManager is a constructor param (no setter exists)
      const orchestrator = new ChatOrchestrator(
          this.app,
          this.getProviderRegistry(),
          this.getSystemPromptBuilder(),
          this.getToolDispatcher(),
          this.getHistoryManager(),
          this.settings,
          this._sessionGuard,
          undefined, // no view — headless
          this.getVaultRuleManager(),
          this.getTemplateRegistry(),
      );

      // Full parity with createOrchestrator() post-construction wiring
      orchestrator.setGetToolDefinitions(
          (config) => this.getToolDispatcher().getToolDefinitions(config)
      );
      orchestrator.setPersonaManager(this.getPersonaManager());
      orchestrator.setWorkflowHookOverrideManager(this.getWorkflowHookOverrideManager());
      orchestrator.setChatBlockRegistry(this.getChatBlockRegistry());
      orchestrator.setExtensionAccessors({
          lifecycle: this.getExtensionLifecycleManager(),
          toolEvent: this.getExtensionToolEventManager(),
      });
      orchestrator.setCheckpointManager(new CheckpointManager(this.app));
      orchestrator.setSharedCheckpointManager(() => this._sharedCheckpointManager);

      return orchestrator;
  }
  ```

  NOTE: This mirrors `createOrchestrator()` (main.ts line 2159) with full post-construction
  wiring. The only difference is `view` is `undefined`. Background workflows bypass
  SessionGuard (they use WorkflowConcurrencyManager instead), so no lifecycle cleanup
  is needed — the orchestrator is GC'd after the execution completes.

### 5.2 Add `createHeadlessOrchestrator` to `DispatcherDeps`

**File:** `src/hooks/vault-event-dispatcher.ts` — `DispatcherDeps` interface (near line 60)

- [ ] **5.2a** Add to the interface:
  ```typescript
  /** Factory to create a headless orchestrator for background workflow execution. */
  createHeadlessOrchestrator?: () => ChatOrchestrator;
  ```

### 5.3 Use headless orchestrator in dispatcher

**File:** `src/hooks/vault-event-dispatcher.ts` — `executeRunWorkflowAction()` (lines 463–470)

- [ ] **5.3a** Replace the null guard:
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

### 5.4 Wire factory in main.ts

**File:** `src/main.ts` — `getDispatcherDeps()` function (line ~1427)

- [ ] **5.4a** Add to the returned deps object:
  ```typescript
  createHeadlessOrchestrator: () => this.createHeadlessOrchestrator(),
  ```

### 5.5 Lifecycle considerations

Each headless orchestrator is spawned per-execution and is self-contained. After
`executeBackgroundWorkflow` completes (inside `WorkflowConcurrencyManager.submit`'s
async run function), the orchestrator and its internal managers go out of scope and
are garbage collected. No explicit destroy/cleanup is needed beyond what the
concurrency manager already handles.

The `WorkflowConcurrencyManager` has a default limit of 3 concurrent executions
(line 74 of `src/workflows/workflow-concurrency.ts`), which bounds the number of
simultaneous headless orchestrators. Queued items wait until a slot opens.

**SessionGuard safety:** The shared `_sessionGuard` instance (a `Set<string>` of
active conversation IDs) is safe to pass to headless orchestrators. Background
workflows always create unique new conversation IDs, so no collision with panel
conversations is possible. JS is single-threaded, so `Set` operations are atomic.

---

## Phase 6 — Auto-Inject Workflow Frontmatter

Automatically inject required frontmatter into workflow files when:
(a) configured as a hook target in settings UI, or
(b) at execution time when validation fails (fallback repair).

---

### 6.1 Create frontmatter injection utility

**New file:** `src/workflows/workflow-frontmatter.ts`

- [ ] **6.1a** Create the file with the following exports:

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

### 6.2 Reuse existing event-to-trigger mapping

**File:** `src/hooks/vault-event-listener-manager.ts` (lines 403–423)

The function `vaultEventTypeToWorkflowTrigger()` already provides this mapping.
It returns `null` for `"on_schedule"` (handled by a separate scheduler).

- [ ] **6.2a** Add `export` keyword to `vaultEventTypeToWorkflowTrigger` in `vault-event-listener-manager.ts`
  (line 403 — currently a module-private function, not exported).

- [ ] **6.2b** At usage sites, apply the fallback for `on_schedule`:
  ```typescript
  import { vaultEventTypeToWorkflowTrigger } from "../hooks/vault-event-listener-manager";

  const trigger = vaultEventTypeToWorkflowTrigger(event) ?? (event === "on_schedule" ? "scheduled" : "manual");
  ```

### 6.3 Auto-inject at hook configuration time (settings UI)

**File:** `src/settings/sections/vault-event-hook-subsection.ts` (lines 236–271, the "Add" button click handler)

- [ ] **6.3a** Import `TFile` from `"obsidian"`, `injectWorkflowFrontmatter` from `"../../workflows/workflow-frontmatter"`, and `vaultEventTypeToWorkflowTrigger` from `"../../hooks/vault-event-listener-manager"`

- [ ] **6.3b** After the validation checks (line 238 `if (!newCommandOrPath)...`) and before `addVaultEventHook()` call (line 259), add:
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

### 6.4 Auto-repair at execution time (fallback)

**File:** `src/hooks/vault-event-dispatcher.ts` — `executeRunWorkflowAction()` (lines 354–362)

- [ ] **6.4a** Import `injectWorkflowFrontmatter` from `"../workflows/workflow-frontmatter"` and
  `vaultEventTypeToWorkflowTrigger` from `"./vault-event-listener-manager"`

- [ ] **6.4b** Replace the current validation failure handling:
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
      // Wait for metadataCache to process the file change (event-based with timeout fallback)
      await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => { off(); resolve(); }, 2000);
          const off = deps.metadataCache.on("changed", (changedFile) => {
              if (changedFile.path === workflowFile.path) {
                  clearTimeout(timeout);
                  off();
                  resolve();
              }
          });
      });
      // Re-read frontmatter
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

## Phase 7 — Integration & Testing

---

### 7.1 TypeScript compilation

- [ ] **7.1a** Run `npx tsc --noEmit` to verify all type changes compile cleanly. Key things to check:
  - `Workflow` interface now has `mode` and `model_preset` fields — every place that constructs a `Workflow` object must include them
  - Places that construct `Workflow` objects:
    - `src/workflows/workflow-discovery.ts` — `parseWorkflowFile()` return (line 390)
    - `src/hooks/vault-event-dispatcher.ts` — `executeRunWorkflowAction()` minimal object (line 365)
    - Any test mocks or fixtures that create `Workflow` objects

### 7.2 Manual testing checklist

- [ ] **7.2a** Custom notor_dir with capital-W `Workflows/` folder:
  - Set `notor_dir` to `"Agent Files/Notor/"` in General settings
  - Ensure `Agent Files/Notor/Workflows/` exists in the vault
  - Click "Create new workflow" → should succeed without error
  - Existing workflows in the folder should appear in the list

- [ ] **7.2b** Workflow frontmatter auto-injection:
  - Create a plain `.md` file (no frontmatter) in the vault
  - Go to Automation settings, add a `run_workflow` hook pointing to that file
  - Verify the file now has `notor-type: workflow`, `notor-trigger`, and `notor-conversation-mode` in its frontmatter

- [ ] **7.2c** Per-workflow mode:
  - Add `notor-conversation-mode: act` to a workflow's frontmatter
  - Set global mode to "Plan"
  - Trigger the workflow → should execute in Act mode
  - Check conversation history file header for `mode: "act"`

- [ ] **7.2d** Per-workflow model preset:
  - Create a model preset named "fast" in settings
  - Add `notor-model-preset: fast` to a workflow's frontmatter
  - Trigger the workflow → should use the "fast" preset's provider/model

- [ ] **7.2e** Headless execution (no panel):
  - Close all Notor chat panels
  - Trigger a hook (e.g., Cmd+S with an `on_manual_save` hook)
  - Verify workflow executes successfully (check chat history folder for new conversation file)

- [ ] **7.2f** `notor-type` backward compatibility:
  - Existing workflows with `notor-workflow: true` should still be discovered and executable
  - New workflows created via UI should have `notor-type: workflow` (not `notor-workflow: true`)

- [ ] **7.2g** Scheduled execution:
  - Configure an `on_schedule` hook with `0 * * * *` (every hour on the minute)
  - OR a workflow with `notor-trigger: scheduled` and `notor-schedule: "* * * * *"` (every minute for testing)
  - Close all panels, wait for fire → should execute via headless orchestrator
  - Check logs for `"Created headless orchestrator for background workflow"`

---

## Implementation Order

1. Phase 1 (case-insensitive handling) — unblocks workflow discovery
2. Phase 2 (`notor-type` migration) — foundational for Phase 6's injection
3. Phase 3 (per-workflow mode) — adds `mode` field to `Workflow` type
4. Phase 4 (per-workflow model preset) — adds `model_preset` field
5. Phase 5 (headless orchestrator) — removes panel dependency
6. Phase 6 (auto-inject frontmatter) — uses all new fields
7. Phase 7 (integration testing)
