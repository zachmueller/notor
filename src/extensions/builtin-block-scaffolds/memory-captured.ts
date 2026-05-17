import type { BuiltinBlockScaffold } from "../types";

export const MEMORY_CAPTURED: BuiltinBlockScaffold = {
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
