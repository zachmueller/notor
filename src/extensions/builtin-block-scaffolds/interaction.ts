import type { BuiltinBlockScaffold } from "../types";

export const INTERACTION: BuiltinBlockScaffold = {
	kind: "interaction",
	displayName: "Follow-up Questions",
	icon: "❓",
	excludeFromCompaction: false,
	rendererExport: "render",
	toLLMTextExport: "toLLMText",
	scaffoldContent:
`---
notor-type: block
notor-block-kind: interaction
notor-display-name: Follow-up Questions
notor-icon: "❓"
notor-renderer-export: render
notor-to-llm-text-export: toLLMText
---

Renders a completed follow-up-question interaction inline in the conversation:
each question with its suggested-answer chips (the chosen one highlighted) and
the user's answer. Read-only replay — emitted by the \`ask_user\` tool after the
user has answered, so reloading the conversation re-renders the full Q&A.

\`\`\`ts
export function render(container: HTMLElement, data: any, ctx: any): void {
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  if (items.length === 0) return;

  const wrap = container.createDiv({ cls: "notor-interaction-block notor-extension-block-text" });

  for (const item of items) {
    const question: string = item?.question ?? "";
    const suggestions: string[] = Array.isArray(item?.suggestions) ? item.suggestions : [];
    // answer is a string (single-select) or a string[] (multi-select); older
    // persisted blocks are always strings.
    const answer: any = item?.answer ?? "";
    if (!question) continue;

    const qa = wrap.createDiv({ cls: "notor-interaction-qa" });
    qa.createDiv({ cls: "notor-interaction-q", text: question });

    if (suggestions.length > 0) {
      const chips = qa.createDiv({ cls: "notor-interaction-chips notor-interaction-chips--replay" });
      for (const s of suggestions) {
        const chosen = Array.isArray(answer) ? answer.includes(s) : s === answer;
        chips.createSpan({
          cls: "notor-interaction-chip" + (chosen ? " notor-interaction-chip--chosen" : ""),
          text: s,
        });
      }
    }

    // Show the answer (always — covers free-text answers not in suggestions).
    const answerText = Array.isArray(answer) ? answer.join(", ") : answer;
    const ansRow = qa.createDiv({ cls: "notor-interaction-a" });
    ansRow.createSpan({ cls: "notor-interaction-a-label", text: "Answer: " });
    ansRow.createSpan({ cls: "notor-interaction-a-value", text: answerText || "(no answer)" });
  }
}

export function toLLMText(data: any): string | null {
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  if (items.length === 0) return null;
  return items
    .map((it) => {
      const a = it?.answer;
      const aText = Array.isArray(a) ? a.join(", ") : (a == null ? "" : a);
      return "Q: " + (it?.question ?? "") + "\\nA: " + aText;
    })
    .join("\\n\\n");
}
\`\`\`
`,
};
