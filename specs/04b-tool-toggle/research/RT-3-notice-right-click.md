# RT-3 — Right-Click Navigation on Obsidian Notices

**Research task:** Understand how BRAT implements right-click-to-navigate on Obsidian Notices, before finalizing the validation warning UX in FR-82.

**Status:** Complete

---

## Finding: The mechanism

The `Notice` class in Obsidian's public API exposes a `noticeEl` property — the underlying `HTMLElement` that renders the toast. You can attach any standard DOM event listener to it, including `oncontextmenu` for right-click.

BRAT's full implementation lives in [`src/utils/notifications.ts`](https://github.com/TfTHacker/obsidian42-brat/blob/main/src/utils/notifications.ts):

```typescript
import { Notice, Platform } from "obsidian";

export function toastMessage(
    plugin: BratPlugin,
    msg: string,
    timeoutInSeconds = 10,
    contextMenuCallback?: () => void,
): void {
    if (!plugin.settings.notificationsEnabled) return;
    const additionalInfo = contextMenuCallback
        ? (Platform.isDesktop ? "(click=dismiss, right-click=Info)" : "(click=dismiss)")
        : "";
    const newNotice: Notice = new Notice(
        `BRAT\n${msg}\n${additionalInfo}`,
        timeoutInSeconds * 1000,
    );
    if (contextMenuCallback)
        newNotice.noticeEl.oncontextmenu = () => {
            contextMenuCallback();
        };
}
```

Key points:
- `noticeEl` is a standard DOM element — no private API, no monkey-patching.
- The callback is wired via the plain `oncontextmenu` property (not `addEventListener`).
- BRAT appends a `"(click=dismiss, right-click=Info)"` hint to the message text on desktop so users know the gesture exists. On mobile it shows `"(click=dismiss)"` only, since right-click has no equivalent.

In practice, BRAT's callbacks call `window.open(url)` to open GitHub release pages. For Notor the callback would instead navigate to a vault note.

---

## How to navigate to a vault note from the callback

Obsidian's workspace API provides two suitable approaches:

**Option A — `openLinkText` (preferred for vault-relative paths):**
```typescript
app.workspace.openLinkText(filePath, "", false);
```
Resolves the path relative to the vault root (same as clicking a wikilink), opens the file in an existing leaf or a new one.

**Option B — `getLeaf().openFile` (when you have the `TFile` object):**
```typescript
const file = app.vault.getAbstractFileByPath(filePath);
if (file instanceof TFile) {
    app.workspace.getLeaf(false).openFile(file);
}
```

Option A is simpler for Notor's case because `sourceFile` on `ParsedToolConfig` is already a vault-relative path string.

---

## Recommended implementation pattern for FR-82

```typescript
import { Notice, Platform } from "obsidian";
import type NotorPlugin from "../main";

/**
 * Shows a validation error Notice for a notor_tool_config parse failure.
 * On desktop, right-clicking jumps to the source note in the editor.
 */
function showToolConfigError(
    plugin: NotorPlugin,
    sourceFile: string,
    detail: string,
): void {
    const jumpHint = Platform.isDesktop ? " Right-click to jump to note." : "";
    const notice = new Notice(
        `[${sourceFile}] notor_tool_config: ${detail}.${jumpHint}`,
        10_000,
    );
    if (Platform.isDesktop) {
        notice.noticeEl.oncontextmenu = () => {
            plugin.app.workspace.openLinkText(sourceFile, "", false);
        };
    }
}
```

This satisfies all FR-82 acceptance criteria:
- Identifies the source file by name in the message.
- Includes "right-click to jump to note" text (desktop only — on mobile the gesture doesn't exist).
- Navigates to the note on right-click.

---

## Notes on mobile

`Platform.isDesktop` (from `obsidian`) is the correct guard — right-click has no equivalent on mobile/tablet. On those platforms the jump hint and `oncontextmenu` handler are simply omitted, and the Notice acts as a plain dismissible toast.

---

## Sources

- [`TfTHacker/obsidian42-brat` — `src/utils/notifications.ts`](https://github.com/TfTHacker/obsidian42-brat/blob/main/src/utils/notifications.ts)
- [`TfTHacker/obsidian42-brat` — `src/features/BetaPlugins.ts`](https://github.com/TfTHacker/obsidian42-brat/blob/main/src/features/BetaPlugins.ts) (callsites showing `window.open` callback pattern)
