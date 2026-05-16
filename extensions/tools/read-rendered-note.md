---
notor-type: tool
notor-tool-name: read_rendered_note
notor-description: "Read a vault note with Dataview and Bases queries evaluated and rendered as Markdown. Supports .base files directly. Requires Dataview for DQL queries; Bases rendering uses Obsidian's built-in engine (1.10.0+)."
notor-mode: read
tested-notor-version: "0.7.8"
author: Zach
---

# Read Rendered Note (Dataview + Bases)

Reads a note from the vault and evaluates any Dataview or Bases content before returning it to the AI. Without this tool, the AI only sees raw query source — this tool resolves those queries into their rendered Markdown output (tables, lists, task lists).

Also supports reading `.base` files directly — the query is evaluated and results are returned as a Markdown table.

**Requires:** [Dataview](https://github.com/blacksmithgu/obsidian-dataview) plugin for DQL queries. Bases rendering uses Obsidian's built-in engine (1.10.0+).

### What gets rendered

| Content type | Behavior |
|---|---|
| DQL code fences (`` ```dataview ``) | Fully evaluated → Markdown table/list/tasks |
| Bases code fences (`` ```base ``) | Fully evaluated → Markdown table |
| Inline DQL (`` `= expression` ``) | Replaced with computed value |
| DataviewJS fences (`` ```dataviewjs ``) | Left as raw source (requires DOM to render) |
| Inline JS (`` `$= expression` ``) | Left as raw source |
| `.base` files (via path param) | Fully evaluated → Markdown table |

### Usage examples

- "Read my weekly review note with Dataview tables rendered"
- "Show me the task list from my daily note" (when the task list is a Dataview query)
- "Summarize the project status dashboard" (when it uses Dataview tables)
- "Read my project tracker" (a `.base` file with structured views)
- "Show the 'Active' view from my tasks.base file"

```yaml
params:
  path:
    type: string
    description: "Path to the note (or .base file) relative to vault root. The '.md' extension is optional for notes."
    path_namespace: vault
  include_frontmatter:
    type: boolean
    description: "Whether to include YAML frontmatter in the returned content."
    default: false
  view:
    type: string
    description: "For .base files or notes with multiple Bases views: name of the view to render. Defaults to the first view."
```

```ts
// --- Bases helper: format BasesQueryResult as Markdown table ---
function formatBasesResult(basesView: any): string {
  const result = basesView.data;
  const config = basesView.config;
  const props: string[] = result.properties ?? [];

  if (props.length === 0) return "*No properties configured in this Bases view.*";

  const headers = props.map((p: string) => {
    try { return config?.getDisplayName?.(p) ?? p.split(".").pop()!; }
    catch { return p.split(".").pop()!; }
  });

  const entries: any[] = result.data ?? [];
  if (entries.length === 0) {
    const sep = headers.map(() => "---");
    return [
      `| ${headers.join(" | ")} |`,
      `| ${sep.join(" | ")} |`,
      `| *(no matching notes)* |` + " |".repeat(headers.length - 1),
    ].join("\n");
  }

  const rows = entries.map((entry: any) =>
    props.map((p: string) => {
      const val = entry.getValue(p);
      if (!val || val.toString() === "null") return "";
      return val.toString().replace(/\|/g, "\\|").replace(/\n/g, " ");
    })
  );

  const sep = headers.map(() => "---");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...rows.map(r => `| ${r.join(" | ")} |`),
  ].join("\n");
}

// --- Bases helper: open .base file, wait for results, extract view ---
async function evaluateBasesFile(baseFile: any, viewName?: string): Promise<string> {
  const leaf = app.workspace.getLeaf("tab");
  try {
    await leaf.openFile(baseFile);

    let basesView = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const controller = (leaf.view as any)?._children?.[0];
      if (controller?.view?.data?.data) {
        if (viewName && controller.viewName !== viewName) {
          const available: string[] = controller.getQueryViewNames?.() ?? [];
          if (!available.includes(viewName)) {
            throw new Error(`View "${viewName}" not found. Available views: ${available.join(", ")}`);
          }
          controller.selectView(viewName);
          await new Promise(r => setTimeout(r, 2000));
        }
        basesView = controller.view;
        break;
      }
    }

    if (!basesView?.data) throw new Error("Bases query did not return results within 10 seconds.");

    return formatBasesResult(basesView);
  } finally {
    leaf.detach();
  }
}

// --- Resolve the file ---
const file = utils.resolveNote(params.path);
if (!file) throw new Error(`Note not found: ${params.path}`);

// --- .base file: evaluate and return immediately ---
if (file.extension === "base") {
  const basesEnabled = (app as any).internalPlugins?.plugins?.["bases"]?.enabled;
  if (!basesEnabled) throw new Error("Obsidian Bases is not enabled in this vault.");
  return evaluateBasesFile(file, params.view);
}

// --- Markdown note path ---
if (file.extension !== "md") throw new Error(`Path is not a Markdown note or .base file: ${params.path}`);

const dvPlugin = app.plugins.plugins["dataview"];
if (!dvPlugin) {
  throw new Error(
    "The Dataview plugin is not installed or not enabled. " +
    "This tool requires Dataview to evaluate queries. " +
    "Please install and enable it from Obsidian's Community Plugins."
  );
}
const api = dvPlugin.api;
const dvSettings = dvPlugin.settings;

let content = await app.vault.read(file);
const sourcePath = file.path;

if (!params.include_frontmatter) {
  const fmInfo = obsidian.getFrontMatterInfo(content);
  if (fmInfo.exists) {
    content = content.slice(fmInfo.contentStart).replace(/^\n/, "");
  }
}

// --- Async replace helper ---
async function replaceAsync(str: string, regex: RegExp, asyncFn: (match: string, ...args: any[]) => Promise<string>): Promise<string> {
  const promises: Promise<string>[] = [];
  str.replace(regex, (match: string, ...args: any[]) => {
    promises.push(asyncFn(match, ...args));
    return match;
  });
  const replacements = await Promise.all(promises);
  let i = 0;
  return str.replace(regex, () => replacements[i++]);
}

// --- Escape regex special chars ---
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 1. Evaluate DQL code fences (```dataview ... ```)
const dqlFenceRegex = /```dataview\n([\s\S]*?)```/g;
content = await replaceAsync(content, dqlFenceRegex, async (_match: string, query: string) => {
  const result = await api.queryMarkdown(query.trim(), sourcePath);
  if (result.successful) return result.value.trim();
  return `${_match}\n\n> [!warning] Dataview query error\n> ${result.error}`;
});

// 2. Annotate DataviewJS fences (cannot render headlessly)
const dvjsKeyword = dvSettings.dataviewJsKeyword || "dataviewjs";
if (dvSettings.enableDataviewJs) {
  const dvjsFenceRegex = new RegExp("```" + escapeRegex(dvjsKeyword) + "\\n[\\s\\S]*?```", "g");
  content = content.replace(dvjsFenceRegex, (match: string) => {
    return `${match}\n\n> [!info] DataviewJS blocks cannot be rendered to text. View the rendered output in Obsidian.`;
  });
}

// 3. Evaluate inline DQL expressions (`= expr`)
if (dvSettings.enableInlineDataview !== false) {
  const prefix = dvSettings.inlineQueryPrefix || "=";
  const inlineRegex = new RegExp("`" + escapeRegex(prefix) + "\\s*(.+?)`", "g");
  content = content.replace(inlineRegex, (_match: string, expr: string) => {
    const result = api.evaluateInline(expr.trim(), sourcePath);
    if (result.successful) return String(result.value);
    return _match;
  });
}

// 4. Evaluate Bases code fences (```base ... ```)
const basesEnabled = (app as any).internalPlugins?.plugins?.["bases"]?.enabled;
if (basesEnabled) {
  const baseFenceRegex = /```base\n([\s\S]*?)```/g;
  const baseFences = [...content.matchAll(baseFenceRegex)];

  for (const match of baseFences.reverse()) {
    const yaml = match[1];
    const startIdx = match.index!;
    const endIdx = startIdx + match[0].length;

    try {
      const tmpName = `.notor-bases-tmp-${Date.now()}.base`;
      const tmpFile = await app.vault.create(tmpName, yaml.trim());
      try {
        const table = await evaluateBasesFile(tmpFile);
        content = content.slice(0, startIdx) + table + content.slice(endIdx);
      } finally {
        await app.vault.delete(tmpFile);
      }
    } catch (e: any) {
      const warning = `\n\n> [!warning] Bases query error\n> ${e.message}`;
      content = content.slice(0, endIdx) + warning + content.slice(endIdx);
    }
  }
}

return content;
```
