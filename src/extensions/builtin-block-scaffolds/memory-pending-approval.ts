import type { BuiltinBlockScaffold } from "../types";

export const MEMORY_PENDING_APPROVAL: BuiltinBlockScaffold = {
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
