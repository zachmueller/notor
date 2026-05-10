---
notor-type: tool
notor-tool-name: read_rendered_note
notor-description: "Read a vault note with Dataview queries evaluated and rendered as Markdown. Requires the Dataview plugin to be installed and enabled."
notor-mode: read
tested-notor-version: "0.7.8"
author: Zach
---

# Read Rendered Note (Dataview)

Reads a note from the vault and evaluates any Dataview content before returning it to the AI. Without this tool, the AI only sees raw Dataview query source (e.g. `` ```dataview ... ``` ``) — this tool resolves those queries into their rendered Markdown output (tables, lists, task lists).

**Requires:** [Dataview](https://github.com/blacksmithgu/obsidian-dataview) plugin installed and enabled.

### What gets rendered

| Content type | Behavior |
|---|---|
| DQL code fences (`` ```dataview ``) | Fully evaluated → Markdown table/list/tasks |
| Inline DQL (`` `= expression` ``) | Replaced with computed value |
| DataviewJS fences (`` ```dataviewjs ``) | Left as raw source (requires DOM to render) |
| Inline JS (`` `$= expression` ``) | Left as raw source |

### Usage examples

- "Read my weekly review note with Dataview tables rendered"
- "Show me the task list from my daily note" (when the task list is a Dataview query)
- "Summarize the project status dashboard" (when it uses Dataview tables)

```yaml
params:
  path:
    type: string
    description: "Path to the note relative to vault root. The '.md' extension is optional."
    path_namespace: vault
  include_frontmatter:
    type: boolean
    description: "Whether to include YAML frontmatter in the returned content."
    default: false
```

```ts
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

const file = utils.resolveNote(params.path);
if (!file) throw new Error(`Note not found: ${params.path}`);
if (file.extension !== "md") throw new Error(`Path is not a Markdown note: ${params.path}`);

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

return content;
```
