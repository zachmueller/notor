# Research: GUIDE-012 — Replace `confirm()` with Obsidian Modal

**Created:** 2026-03-15
**Task:** GUIDE-012 in `specs/ZZ-guidelines-cleanup/plan-review-bot-feedback.md`

---

## Site 1: `src/settings/sections/mcp-servers.ts:L297`

### What is being confirmed?

Deletion of an MCP server configuration. The dialog text is:

```
Remove MCP server "${serverName}"? This cannot be undone.
```

### Surrounding code

```typescript
.onClick(async () => {
    const confirmed = confirm(`Remove MCP server "${serverName}"? This cannot be undone.`);
    if (!confirmed) return;

    // Disconnect first
    await mcpHub?.disconnectServer(serverName).catch(() => {});

    // Clean up secrets for env vars and headers
    const secrets = makeSecretStorage(ctx);
    for (const envVar of config.env ?? []) {
        if (envVar.sensitive) {
            await secrets.delete(mcpEnvSecretKey(serverName, envVar.key));
        }
    }
    for (const header of config.headers ?? []) {
        if (header.sensitive) {
            await secrets.delete(mcpHeaderSecretKey(serverName, header.key));
        }
    }

    delete ctx.settings.mcp_servers[serverName];
    await ctx.saveSettings();
    refresh();
})
```

### Analysis

| Question | Answer |
|---|---|
| Surrounding function async? | Yes — `.onClick(async () => {...})` |
| `app` available? | Yes — `ctx.app` is accessible from the enclosing `renderServerDetailSection` parameters |
| What runs in the confirmed branch? | Disconnect server → delete secrets for env vars → delete secrets for HTTP headers → delete from settings map → save settings → call `refresh()` |
| What runs on cancel? | Nothing — early `return` |
| Re-render required after confirm? | Yes — `refresh()` is called at the end of the branch to re-draw the section |

### Control-flow impact of switching to Modal

The confirm branch is entirely guarded by `if (!confirmed) return;`. Switching to Modal is straightforward:

- Move everything after `if (!confirmed) return;` into the Modal's `onConfirm` callback
- The `onConfirm` callback must be `async` (it awaits `disconnectServer`, `secrets.delete`, and `saveSettings`)
- The `.onClick` handler can remain `async` (or become sync) — it just opens the modal and returns; the modal fires the callback asynchronously later
- No code currently after the `confirm()` guard runs unconditionally; no risk of accidentally executing the destructive path

### Recommended button styling

This is a destructive action. The existing button already uses `.setWarning()` on the trigger button. The confirm modal's confirm button should also use `.setWarning()` (via `ButtonComponent`) to be consistent with the destructive nature of the action.

---

## Site 2: `src/ui/attachment-picker.ts:L425`

### What is being confirmed?

A large-file warning when the user selects an external file exceeding the `thresholdMb` threshold. The dialog text is:

```
The file "${file.name}" is ${sizeMb.toFixed(1)} MB, which exceeds the ${thresholdMb} MB threshold.

Attach anyway?
```

### Surrounding code

```typescript
export function openExternalFileDialog(
    onAttachmentAdded: OnAttachmentAdded,
    existingAttachments: () => Attachment[],
    thresholdMb: number
): void {
    // ...
    input.addEventListener("change", () => {   // synchronous event handler
        const files = Array.from(input.files ?? []);
        const existing = existingAttachments();

        for (const file of files) {
            // ... duplicate check, readExternalFile ...

            if (result.needsConfirmation) {
                const sizeMb = (result.fileSizeBytes ?? 0) / (1024 * 1024);
                const proceed = confirm(...);
                if (!proceed) {
                    continue;   // skip this file only
                }
            }

            // Attach if reached here
            const attachment = createExternalFileAttachment(...);
            onAttachmentAdded(attachment);
        }

        input.remove();
    });

    input.click();
}
```

### Analysis

| Question | Answer |
|---|---|
| Surrounding function async? | No — `input.addEventListener("change", () => {...})` is a synchronous event handler; cannot be converted to `async` and have `confirm` simply awaited |
| `app` available in function scope? | Not currently — `openExternalFileDialog` does not accept `app`. However, the caller `createAttachmentButton` already receives `app: App` as a parameter (L475), so passing it through is a one-line signature change at both definition and call site |
| What runs when confirmed? | Attaches the file immediately via `onAttachmentAdded(attachment)` and continues the loop |
| What runs on cancel? | `continue` — the current file is skipped; remaining files in the loop continue to process normally |
| Multiple files at once? | Yes — the user can select multiple files in a single OS picker dialog; any subset could be oversized and each would currently show its own `confirm()` |

### Control-flow complication: the for loop

`confirm()` is synchronous, so in a multi-file selection the loop naturally blocks per file and processes them in sequence. A Modal is non-blocking — `modal.open()` returns immediately, breaking the sequential flow.

**Options:**

**Option A — Split into two passes (recommended)**

Process all files in one pass:
1. Files that do not need confirmation → attach immediately
2. Files that need confirmation → collect into a `pendingOversized` array

After the loop, chain modals for each oversized file: show a modal for `pendingOversized[0]`; in its `onConfirm`, attach the file then show the modal for `pendingOversized[1]`; and so on. In its `onClose`/cancel path, skip to the next file.

This preserves the "attach each confirmed file individually" semantics and keeps the non-oversized files unblocked.

**Option B — Serialize all files with a recursive helper**

Refactor the loop body into a recursive function `processNextFile(index)` that shows a modal for oversized files and recursively calls itself in both confirm and cancel paths. More elegant but more complex to read.

**Option C — Change the threshold to block at the function boundary**

Before opening the file picker, if `thresholdMb` is the only reason for confirmation, pre-screen files differently. Not viable here because file sizes are only known after reading them inside the handler.

**Recommendation:** Option A. It's the simplest to implement and understand. The key steps:
1. Add `app: App` parameter to `openExternalFileDialog`; update the call site in `createAttachmentButton` to pass `app`
2. In the `change` handler, split files into `readyToAttach` and `pendingConfirmation` arrays
3. Attach `readyToAttach` files immediately
4. Use a small `showNextConfirmation(index)` helper (defined locally inside the handler) to chain modals for `pendingConfirmation` files

### `input.remove()` timing

Currently `input.remove()` runs synchronously at the end of the `change` handler — after all `confirm()` calls have completed. With chained modals, the DOM cleanup must be deferred to after the last modal closes. In Option A, `input.remove()` should be called at the end of `showNextConfirmation` once `index >= pendingConfirmation.length`, covering both the "all confirmed" and "all exhausted" cases.

---

## Shared `ConfirmModal` design

A single `ConfirmModal extends Modal` class can serve both sites. The interface is:

```typescript
// src/ui/confirm-modal.ts
export class ConfirmModal extends Modal {
    constructor(
        app: App,
        private readonly title: string,
        private readonly message: string,
        private readonly onConfirm: () => void | Promise<void>,
        private readonly confirmLabel: string = "Confirm",
        private readonly destructive: boolean = false,
    ) {
        super(app);
    }
    // ...
}
```

Usage differences between the two sites:

| | Site 1 (MCP server removal) | Site 2 (large file) |
|---|---|---|
| Title | `"Remove server"` | `"Large file"` |
| Message | `Remove MCP server "${serverName}"? This cannot be undone.` | `The file "${name}" is X MB, which exceeds the Y MB threshold. Attach anyway?` |
| Confirm label | `"Remove"` | `"Attach anyway"` |
| Destructive styling | Yes | No |
| `onConfirm` async? | Yes — awaits disconnect + secrets delete + saveSettings | No — synchronous attachment via callback |

Both sites only use `onConfirm`; neither needs a separate `onCancel` callback because cancel is always a no-op (return/skip).

---

## Risk assessment

| Site | Risk | Reason |
|---|---|---|
| `mcp-servers.ts:L297` | Low | Async onClick handler, `app` already available, single branch of logic, no loop complexity |
| `attachment-picker.ts:L425` | Medium | Synchronous event handler with a for loop; requires structural refactor (split + chain); `app` must be threaded through; DOM cleanup timing must be adjusted |

---

## Pre-implementation checklist

- [x] What action is being confirmed at each site
- [x] Whether surrounding function is already async
- [x] Whether `app` is available (or can be made available) at each site
- [x] Whether any code after `confirm()` would accidentally run if not guarded properly
- [x] Control-flow changes needed for each site
- [x] `ConfirmModal` interface design
- [x] Button styling / destructive pattern
- [x] `input.remove()` timing for Site 2
- [x] Risk level per site
