# Memory Approval UX — Design

## Context

Every memory note Notor captures or updates is written immediately and silently by default. This document describes the optional approval gate that lets users review proposed memory writes before they land — both in bulk (via a standalone panel) and inline within the conversation thread. The feature defaults to off (`Auto-approve`).

---

## New Setting: `memory_approval_mode`

**File:** `src/settings/types.ts` — added to the Knowledge Memory block:
```typescript
memory_approval_mode: "auto" | "bulk" | "bulk_and_inline";
```

**File:** `src/settings/defaults.ts` — default `"auto"`.

**File:** `src/settings/sections/memory.ts` — dropdown setting rendered after the Memory Folder field (only when `memory_enabled === true`):
- Label: `"Memory approval"`
- Desc: `"Auto-approve writes notes immediately. Bulk approval queues proposed memories for review in the approval panel. Bulk and in-conversation approval also shows approve/reject controls inline after each turn."`
- Options: `"auto"` → `"Auto-approve"`, `"bulk"` → `"Bulk approval only"`, `"bulk_and_inline"` → `"Bulk and in-conversation"`

---

## Pending Memory Storage

**Directory:** `{notor_dir}/pending-memories/` — auto-created when mode ≠ `"auto"`.

**Additional frontmatter fields** on top of existing `MemoryNote` fields:
```yaml
notor-type: pending-memory
notor-approval-state: pending
notor-original-action: create   # or "update"
notor-target-path: "[[notor/memory/slug]]"  # updates only — full vault-relative path without .md
```

`notor-target-path` is stored as an Obsidian wikilink using the full vault-relative path (e.g. `[[notor/memory/slug]]`, not `[[memory/slug]]`) so vault renames propagate automatically via Obsidian's link-update machinery.

**File: `src/memory/note-format.ts`** — added:
```typescript
export interface PendingMemoryNote extends MemoryNote {
  approvalState: "pending";
  originalAction: "create" | "update";
  targetPath?: string;   // vault-relative path of the live note being updated
}

export function serializePendingNote(note: PendingMemoryNote): string
export function parsePendingNote(markdown: string): PendingMemoryNote
export function assertPendingMemoryPath(path: string, pendingDir: string): void
```

---

## Modified `resolveConcept()`

**File: `src/memory/concept-resolver.ts`**

Added to `ResolveConceptArgs`:
```typescript
pendingMode?: boolean;
pendingMemoryDir?: string;  // required when pendingMode = true
```

Behavior when `pendingMode = true`:

- **Create directive:** writes to `{pendingMemoryDir}/{slug}.md` with `notor-original-action: create`. Returns `{ action: "created", path: pendingPath }`.
- **Update directive:** before writing, scans `pendingMemoryDir` for any existing pending note whose `notor-target-path` wikilink resolves to the same target (stacking prevention — overwrites in place rather than creating a second pending note). Writes with `notor-original-action: update` and `notor-target-path: [[notor/memory/slug]]`.
- The `pendingMemoryDir` path is passed to the memory-resolver sub-agent task prompt so it can also search there (prevents duplicating a note that's already pending).

---

## `PendingMemoryManager` class

**File: `src/memory/pending-memory-manager.ts`**

```typescript
export class PendingMemoryManager {
  constructor(
    private app: App,
    private vault: Vault,
    private pendingDir: string,
    private memoryDir: string,
  ) {}

  async ensurePendingDir(): Promise<void>
  async listPending(limit = 50): Promise<Array<PendingMemoryNote & { filePath: string }>>
  async getLiveNoteContent(targetPath: string): Promise<string | null>
  async approveSingle(pendingPath: string): Promise<void>
  async rejectSingle(pendingPath: string): Promise<void>
  async approveAll(pendingPaths: string[]): Promise<void>
  async rejectAll(pendingPaths: string[]): Promise<void>
}
```

`approveSingle` logic:
- Read and parse the pending note
- If `originalAction === "create"`: write to live `memoryDir` using the pending filename, setting `notor-type: memory`
- If `originalAction === "update"`: read live note, apply `merged_body`, update `updatedAt`, call `vault.modify()`
- Delete the pending note from `pendingDir`

Exposed via `src/extensions/runtime-context.ts`:
```typescript
utils.memory.pendingMemoryManager: PendingMemoryManager | null;
utils.memoryApprovalMode: string | null;
```

---

## Memory-Capture Automation and Tool Scaffolds

Both the `memory-capture` automation scaffold (`src/extensions/builtin-automation-scaffolds.ts`) and the `capture_memory` tool scaffold (`src/extensions/builtin-tool-scaffolds.ts`) read `utils.memoryApprovalMode` and route accordingly:

```typescript
const approvalMode = utils.memoryApprovalMode ?? "auto";
const pendingMode = approvalMode === "bulk" || approvalMode === "bulk_and_inline";
const pendingMemoryDir = pendingMode ? utils.resolveNotorPath("pending-memories") : "";

if (pendingMode) {
  await utils.memory.pendingMemoryManager.ensurePendingDir();
}

const result = await utils.memory.resolveConcept({
  insight: content,
  memoryDir,
  resolverProfile,
  pendingMode,
  pendingMemoryDir: pendingMode ? pendingMemoryDir : undefined,
});
```

When `bulk_and_inline`, the automation also emits one `memory_pending_approval` block per pending result after the `memory_captured` block.

The `memory-search` automation scaffold passes `pendingMemoryDir` in the task prompt context so recalled memories include content from pending notes.

---

## `memory_pending_approval` Block Scaffold

**File: `src/extensions/builtin-block-scaffolds.ts`**

```
kind: "memory_pending_approval"
displayName: "Memory Pending Approval"
icon: "🔖"
excludeFromCompaction: true
featureGroup: "memory"
```

Block data: `{ pendingPath, title, action, targetPath?, proposedBody, currentBody? }`

Rendering:
- Header: title + badge `NEW` (create) or `UPDATE` (update)
- "Open note" link — opens live note for updates, pending note for creates
- Body: for create → proposed body preview; for update → diff between `currentBody` and `proposedBody`
- Approve / Reject buttons → call `ctx.pendingMemoryManager.approveSingle/rejectSingle(pendingPath)`, then update UI to "✓ Approved" / "✗ Rejected" state
- Content wrapped in `.notor-extension-block-text` for Find in Messages compatibility
- `toLLMText` returns `null` (zero LLM tokens during compaction)

---

## Bulk Approval Modal

**File: `src/ui/memory-approval-modal.ts`** — `MemoryApprovalModal extends Modal`

Rendered content:
1. Header with pending count + "Approve All" / "Reject All" buttons
2. Card list — each card has:
   - Title + NEW/UPDATE badge + "Open note" button
   - For updates: async diff rendered via `computeDiff` from `src/ui/diff-engine.ts`
   - For creates: `<pre>` body preview
   - Individual Approve / Reject buttons
3. After approve/reject: card marked done, count updates
4. If all cards actioned: re-renders to show "No pending memory notes."

CSS classes: `.notor-memory-approval-modal`, `.notor-memory-approval-card`, `.notor-memory-badge--created`, `.notor-memory-badge--updated`, `.notor-approve-btn`, `.notor-reject-btn`

---

## Command Registration

**File: `src/main.ts`**

```typescript
this.addCommand({
  id: "open-memory-approval",
  name: "Open memory approval panel",
  checkCallback: (checking: boolean) => {
    if (!this.settings.memory_enabled) return false;
    if (this.settings.memory_approval_mode === "auto") return false;
    if (checking) return true;
    const manager = this.getPendingMemoryManager();
    if (!manager) return false;
    new MemoryApprovalModal(this.app, manager).open();
    return true;
  },
});
```

`getPendingMemoryManager()` lazily constructs `PendingMemoryManager` with `pendingDir = {notor_dir}/pending-memories` and `memoryDir = {notor_dir}/{memory_folder}`.

---

## Files Changed

| File | Change |
|------|--------|
| `src/settings/types.ts` | Added `memory_approval_mode` field |
| `src/settings/defaults.ts` | Default `"auto"` |
| `src/settings/sections/memory.ts` | Conditional dropdown |
| `src/settings/sections/__tests__/memory.test.ts` | Added `addDropdown` to Setting mock |
| `src/memory/note-format.ts` | `PendingMemoryNote`, `serializePendingNote`, `parsePendingNote`, `assertPendingMemoryPath` |
| `src/memory/concept-resolver.ts` | `pendingMode` + `pendingMemoryDir` args, stacking prevention |
| `src/extensions/runtime-context.ts` | `utils.memoryApprovalMode`, `utils.memory.pendingMemoryManager` |
| `src/extensions/builtin-automation-scaffolds.ts` | Approval mode routing in `memory-capture`; pending dir hint in `memory-search` |
| `src/extensions/builtin-tool-scaffolds.ts` | Approval mode routing in `capture_memory` |
| `src/extensions/builtin-block-scaffolds.ts` | `memory_pending_approval` scaffold |
| `src/ui/chat-blocks/registry.ts` | `pendingMemoryManager` field on `ChatBlockRenderContext` |
| `src/ui/chat-view.ts` | Wires `pendingMemoryManager` into block render context |
| `src/main.ts` | Command registration, `getPendingMemoryManager()` helper |
| `styles.css` | All new approval UI classes |

**New files:**

| File | Purpose |
|------|---------|
| `src/memory/pending-memory-manager.ts` | Approve/reject operations on pending notes |
| `src/ui/memory-approval-modal.ts` | Bulk approval modal |

---

## Verification Scenarios

1. **Auto mode (default):** Memory notes land directly in `memory/`. Command absent from palette.
2. **Bulk mode:** Notes land in `pending-memories/`, `memory/` unchanged. `memory_captured` block shows queued state. "Open memory approval panel" command opens modal. Approve one → note moves to `memory/`. Reject one → note deleted from `pending-memories/`. Approve All / Reject All work. Modal shows diff for UPDATE, preview for CREATE.
3. **Bulk and inline:** Same as bulk, plus `memory_pending_approval` blocks appear in conversation thread. Approve inline → note moves to `memory/`, block updates to approved state. Find in Messages finds text inside pending approval blocks.
4. **Stacking:** Two insights proposing to update the same live note → only one pending note in `pending-memories/` (second overwrites first).
5. **Rename tracking:** Rename a live memory note → the `notor-target-path` wikilink in its pending note updates automatically via Obsidian's link-update machinery.
6. **Search includes pending:** Recalled memories in new conversations include content from pending notes.
7. **`capture_memory` tool:** Explicit LLM calls to `capture_memory` also respect approval mode (routes to pending when mode ≠ auto).
