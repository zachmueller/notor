import type { BuiltinBlockScaffold } from "../types";

export const MEMORY_RECALLED: BuiltinBlockScaffold = {
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
