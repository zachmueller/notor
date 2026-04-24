/**
 * Built-in block-kind scaffolds — pre-packaged chat block renderers that ship
 * with the plugin and can be overridden by user-defined block files in the vault.
 *
 * Follows the same pattern as `builtin-tool-scaffolds.ts` and
 * `builtin-automation-scaffolds.ts`:
 * - Scaffold content is a complete `.md` file (frontmatter + prose + code fence)
 * - If no vault file exists for a scaffold, the in-memory scaffold is injected
 * - Users can create a vault file, edit the code, and customize rendering
 * - The vault file overrides the scaffold on next extension reload
 *
 * @see specs/ZZ-misc/knowledge-memory-design.md — Section 7e-f
 */

/** Definition of a built-in block-kind scaffold (code-side constant). */
export interface BuiltinBlockScaffold {
	/** Block kind identifier (matches `notor-block-kind` in frontmatter). */
	kind: string;
	/** Human-readable display name. */
	displayName: string;
	/** Emoji or Lucide icon name. */
	icon?: string;
	/** Whether to exclude blocks of this kind from compaction. */
	excludeFromCompaction?: boolean;
	/** Feature group for gating (e.g. `"memory"` → gated by `memory_enabled`). */
	featureGroup?: string;
	/** Named export in scaffoldContent code fence that provides the render function. */
	rendererExport: string;
	/** Named export that provides the toLLMText function (optional). */
	toLLMTextExport?: string;
	/** Named export that provides the renderLoading function (optional). */
	renderLoadingExport?: string;
	/**
	 * Full content of the `.md` scaffold file including frontmatter
	 * and code fence — identical to what gets written to the vault.
	 */
	scaffoldContent: string;
}

// ---------------------------------------------------------------------------
// memory_recalled
// ---------------------------------------------------------------------------

const MEMORY_RECALLED: BuiltinBlockScaffold = {
	kind: "memory_recalled",
	displayName: "Memories Recalled",
	icon: "🧠",
	featureGroup: "memory",
	rendererExport: "render",
	toLLMTextExport: "toLLMText",
	renderLoadingExport: "renderLoading",
	scaffoldContent:
`---
notor-type: block
notor-block-kind: memory_recalled
notor-display-name: Memories Recalled
notor-icon: "🧠"
notor-renderer-export: render
notor-to-llm-text-export: toLLMText
notor-render-loading-export: renderLoading
notor-feature-group: memory
---

Renders recalled memory notes at conversation start. Shows clickable note links
with reason text in the UI; sends full note bodies to the LLM via
\`<notor-memory>\` tags. Edit to customize the rendering or wire format.

\`\`\`ts
export function renderLoading(container: HTMLElement, ctx: any): void {
  const el = container.createDiv({ cls: "notor-memory-recalled-loading" });
  el.textContent = "🧠 Searching memories…";
}

export function render(container: HTMLElement, data: any, ctx: any): void {
  const matches: Array<{ path: string; title: string; reason: string; payload?: string }> =
    data?.matches ?? [];

  if (matches.length === 0) {
    const el = container.createDiv({ cls: "notor-memory-recalled-empty" });
    el.textContent = "No memories recalled";
    return;
  }

  const card = ctx.collapsibleCard(container, {
    headerText: \`Memories Recalled (\${matches.length})\`,
    icon: "🧠",
    defaultExpanded: false,
    rootClass: "notor-memory-recalled",
  });

  for (const m of matches) {
    const row = card.body.createDiv({ cls: "notor-memory-match" });
    const link = row.createEl("a", { cls: "notor-memory-link", text: m.title });
    link.addEventListener("click", (e: MouseEvent) => {
      e.preventDefault();
      ctx.openInternalLink(m.path);
    });
    if (m.reason) {
      row.createSpan({ cls: "notor-memory-reason", text: " — " + m.reason });
    }
  }
}

export function toLLMText(data: any): string | null {
  const matches: Array<{ path: string; title: string; reason: string; payload?: string }> =
    data?.matches ?? [];

  if (matches.length === 0) return null;

  const parts: string[] = [];
  for (const m of matches) {
    parts.push(\`## \${m.title}\\n\${m.payload ?? ""}\`.trim());
  }
  return "<notor-memory>\\n" + parts.join("\\n\\n") + "\\n</notor-memory>";
}
\`\`\`
`,
};

// ---------------------------------------------------------------------------
// memory_captured
// ---------------------------------------------------------------------------

const MEMORY_CAPTURED: BuiltinBlockScaffold = {
	kind: "memory_captured",
	displayName: "Memories Captured",
	icon: "💾",
	excludeFromCompaction: true,
	featureGroup: "memory",
	rendererExport: "render",
	toLLMTextExport: "toLLMText",
	scaffoldContent:
`---
notor-type: block
notor-block-kind: memory_captured
notor-display-name: Memories Captured
notor-icon: "💾"
notor-exclude-from-compaction: true
notor-renderer-export: render
notor-to-llm-text-export: toLLMText
notor-feature-group: memory
---

Renders memory capture results after each turn. Shows clickable note links with
action badges ("created" / "updated"). Returns null from toLLMText — purely
informational, zero LLM tokens. Edit to customize the rendering.

\`\`\`ts
export function render(container: HTMLElement, data: any, ctx: any): void {
  const results: Array<{ path: string; title: string; action: string }> =
    data?.results ?? [];

  if (results.length === 0) return;

  const card = ctx.collapsibleCard(container, {
    headerText: \`Memories Captured (\${results.length})\`,
    icon: "💾",
    defaultExpanded: false,
    rootClass: "notor-memory-captured",
  });

  for (const r of results) {
    const row = card.body.createDiv({ cls: "notor-memory-capture-result" });
    const link = row.createEl("a", { cls: "notor-memory-link", text: r.title });
    link.addEventListener("click", (e: MouseEvent) => {
      e.preventDefault();
      ctx.openInternalLink(r.path);
    });
    const badge = r.action === "created" ? "created" : "updated";
    row.createSpan({ cls: "notor-memory-badge notor-memory-badge--" + badge, text: badge });
  }
}

export function toLLMText(data: any): string | null {
  return null;
}
\`\`\`
`,
};

// ---------------------------------------------------------------------------
// memory_pending_approval
// ---------------------------------------------------------------------------

const MEMORY_PENDING_APPROVAL: BuiltinBlockScaffold = {
	kind: "memory_pending_approval",
	displayName: "Memory Pending Approval",
	icon: "🔖",
	excludeFromCompaction: true,
	featureGroup: "memory",
	rendererExport: "render",
	toLLMTextExport: "toLLMText",
	scaffoldContent:
`---
notor-type: block
notor-block-kind: memory_pending_approval
notor-display-name: Memory Pending Approval
notor-icon: "🔖"
notor-exclude-from-compaction: true
notor-renderer-export: render
notor-to-llm-text-export: toLLMText
notor-feature-group: memory
---

Renders a pending memory note inline within the conversation thread, showing
the proposed content and approve/reject controls. For updates, shows before/after
bodies side-by-side. Emitted in \`bulk_and_inline\` approval mode only.

\`\`\`ts
export function render(container: HTMLElement, data: any, ctx: any): void {
  const pendingPath: string = data?.pendingPath ?? "";
  const title: string = data?.title ?? "(untitled)";
  const action: string = data?.action ?? "created";
  const targetPath: string | undefined = data?.targetPath;
  const proposedBody: string = data?.proposedBody ?? "";
  const currentBody: string | undefined = data?.currentBody;

  if (!pendingPath) return;

  const isUpdate = action === "updated" && currentBody !== undefined;
  const badge = isUpdate ? "UPDATE" : "NEW";
  const badgeCls = isUpdate ? "notor-memory-badge--updated" : "notor-memory-badge--created";

  const wrap = container.createDiv({ cls: "notor-memory-approval notor-extension-block-text" });

  // Header row: title + badge + open-note link
  const header = wrap.createDiv({ cls: "notor-memory-approval-header" });
  header.createSpan({ cls: "notor-memory-approval-title", text: title });
  header.createSpan({ cls: "notor-memory-badge " + badgeCls, text: badge });

  const openPath = isUpdate && targetPath ? targetPath : pendingPath;
  const openLink = header.createEl("a", { cls: "notor-memory-approval-open", text: "Open note" });
  openLink.addEventListener("click", (e: MouseEvent) => {
    e.preventDefault();
    ctx.openInternalLink(openPath);
  });

  // Body: for updates show before/after; for creates show proposed body
  const body = wrap.createDiv({ cls: "notor-memory-approval-body" });
  if (isUpdate) {
    const cols = body.createDiv({ cls: "notor-memory-approval-diff" });
    const before = cols.createDiv({ cls: "notor-memory-approval-diff-before" });
    before.createDiv({ cls: "notor-memory-approval-diff-label", text: "Current" });
    before.createEl("pre", { cls: "notor-memory-approval-diff-content", text: currentBody ?? "" });
    const after = cols.createDiv({ cls: "notor-memory-approval-diff-after" });
    after.createDiv({ cls: "notor-memory-approval-diff-label", text: "Proposed" });
    after.createEl("pre", { cls: "notor-memory-approval-diff-content notor-memory-approval-diff-content--proposed", text: proposedBody });
  } else {
    body.createEl("pre", { cls: "notor-memory-approval-diff-content", text: proposedBody });
  }

  // Approve / Reject buttons
  const actions = wrap.createDiv({ cls: "notor-memory-approval-actions" });
  const approveBtn = actions.createEl("button", { cls: "notor-approve-btn", text: "Approve" });
  const rejectBtn = actions.createEl("button", { cls: "notor-reject-btn", text: "Reject" });

  const setDecided = (accepted: boolean) => {
    actions.empty();
    const resultText = accepted ? "✓ Approved" : "✗ Rejected";
    const resultCls = accepted ? "notor-memory-approval-accepted" : "notor-memory-approval-rejected";
    actions.createSpan({ cls: resultCls, text: resultText });
  };

  approveBtn.addEventListener("click", async () => {
    if (!ctx.pendingMemoryManager) return;
    try {
      await ctx.pendingMemoryManager.approveSingle(pendingPath);
      setDecided(true);
    } catch (e) {
      console.error("Failed to approve memory", e);
    }
  });

  rejectBtn.addEventListener("click", async () => {
    if (!ctx.pendingMemoryManager) return;
    try {
      await ctx.pendingMemoryManager.rejectSingle(pendingPath);
      setDecided(false);
    } catch (e) {
      console.error("Failed to reject memory", e);
    }
  });
}

export function toLLMText(data: any): string | null {
  return null;
}
\`\`\`
`,
};

// ---------------------------------------------------------------------------
// Export map
// ---------------------------------------------------------------------------

export const BUILTIN_BLOCK_SCAFFOLDS: ReadonlyMap<string, BuiltinBlockScaffold> =
	new Map([
		[MEMORY_RECALLED.kind, MEMORY_RECALLED],
		[MEMORY_CAPTURED.kind, MEMORY_CAPTURED],
		[MEMORY_PENDING_APPROVAL.kind, MEMORY_PENDING_APPROVAL],
	]);
