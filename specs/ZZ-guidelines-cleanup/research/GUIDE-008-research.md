# GUIDE-008 Research: Fix `document.body.appendChild()` in Workflow Activity Dropdown

**Date:** 2026-03-14
**File under review:** `src/ui/workflow-activity-dropdown.ts`

---

## Summary

This fix is grounded in the official Obsidian guide: [Support pop-out windows](https://docs.obsidian.md/Plugins/Guides/Support+pop-out+windows). That guide states each pop-out window has its own `Window` and `Document` object, and recommends using the `activeDocument`/`activeWindow` API exports instead of bare globals. This is *not* covered by the Plugin Guidelines page — it lives in the Guides section.

The task spec is accurate but incomplete. The file has five distinct `document`/`window` references that all need updating, not just the one `document.body.appendChild` call mentioned. There is also a `window.innerWidth` / `window.innerHeight` pair that needs `activeWindow` equivalents. The `Menu` API is not a viable replacement for this component.

---

## All `document` / `window` references in the file

| Line | Current | Required replacement | Reason |
|------|---------|---------------------|--------|
| 114 | `document.body.appendChild(this.dropdownEl)` | `activeDocument.body.appendChild(this.dropdownEl)` | Popout window has a different `document`; appending to the wrong body causes the element to be invisible or mis-positioned |
| 143 | `document.addEventListener("click", this.outsideClickHandler!)` | `activeDocument.addEventListener("click", ...)` | Listener attached to wrong document in popout window; outside-click dismiss never fires |
| 144 | `document.addEventListener("keydown", this.escapeHandler!)` | `activeDocument.addEventListener("keydown", ...)` | Same issue — Escape key not caught in popout window |
| 160 | `document.removeEventListener("click", this.outsideClickHandler)` | `activeDocument.removeEventListener("click", ...)` | Must remove from same document the listener was registered on |
| 165 | `document.removeEventListener("keydown", this.escapeHandler)` | `activeDocument.removeEventListener("keydown", ...)` | Same symmetry requirement |
| 375 | `window.innerWidth` | `activeWindow.innerWidth` | Viewport dimensions belong to the active window, not the main window |
| 381 | `window.innerHeight` | `activeWindow.innerHeight` | Same |

The `getBoundingClientRect()` call on line 364 does not need changing — it returns coordinates relative to the element's own viewport, which is correct when using `position: fixed` within that same document.

---

## Import change required

The current import:
```typescript
import { setIcon } from "obsidian";
```

Must become:
```typescript
import { setIcon, activeDocument, activeWindow } from "obsidian";
```

Both `activeDocument` and `activeWindow` are exported from the `obsidian` module. `activeDocument` is the `document` of the currently focused Obsidian window; `activeWindow` is the corresponding `Window` object.

---

## Why the `Menu` API is not a viable replacement

The task spec asks us to "consider whether Obsidian's `Menu` API could replace the custom dropdown entirely." The answer is no, for these reasons:

1. **Rich per-entry content.** Each entry renders two rows: a top row with workflow name + status badge (icon + label), and a bottom row with trigger source + timestamp. `Menu.addItem()` only supports `setTitle()` + `setIcon()` + `onClick()` — no structured sub-rows or badge elements.

2. **Live updates while open.** The dropdown registers an `onChange` callback on the tracker and calls `renderEntries()` reactively while open. The `Menu` API has no mechanism for live content updates after rendering.

3. **Status badge styling.** Status badges use per-status CSS classes (`status-running`, `status-completed`, etc.) with distinct colors. The `Menu` API does not expose per-item class control at this level.

The custom `<div>` approach should be kept. The only change needed is swapping `document`/`window` globals for `activeDocument`/`activeWindow`.

---

## Scope of change: single file

`document.body.appendChild` appears only in `workflow-activity-dropdown.ts` across the entire `src/` tree. No other files need changes for GUIDE-008.

Note: `mcp-status-indicator.ts` also uses bare `document.addEventListener` for its outside-click handler (lines 213–214), but its popover element is appended as a child of `this.containerEl` (within the Obsidian workspace), not to `document.body`. That file is out of scope for GUIDE-008 but could warrant a follow-up.

---

## Corrected acceptance criteria

The current acceptance criteria in `tasks.md` do not mention the `window` → `activeWindow` fix. The full set of changes needed:

- [ ] `activeDocument` and `activeWindow` imported from `obsidian`
- [ ] `document.body.appendChild` → `activeDocument.body.appendChild` (line 114)
- [ ] `document.addEventListener("click", ...)` → `activeDocument.addEventListener(...)` (line 143)
- [ ] `document.addEventListener("keydown", ...)` → `activeDocument.addEventListener(...)` (line 144)
- [ ] `document.removeEventListener("click", ...)` → `activeDocument.removeEventListener(...)` (line 160)
- [ ] `document.removeEventListener("keydown", ...)` → `activeDocument.removeEventListener(...)` (line 165)
- [ ] `window.innerWidth` → `activeWindow.innerWidth` (line 375)
- [ ] `window.innerHeight` → `activeWindow.innerHeight` (line 381)
- [ ] Dropdown renders and positions correctly in the main window
- [ ] No regressions to open/close and live-update behavior
