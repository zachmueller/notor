import { scaffold } from "./_scaffold-helper";

export const LIST_TEMPLATES = scaffold(
	"list_templates",
	"List available templates from the configured template folder. Detects Templater prompt/suggester calls so the AI knows what answers to supply.",
	"read",
	`params:
  detect_prompts:
    type: boolean
    description: "Scan templates for tp.system.prompt() and tp.system.suggester() calls and report their sequential order."
    default: true`,
	`const log = utils.logger("list_templates");

const detectPrompts = params.detect_prompts !== false;

// --- Detect template folder ---

const templaterPlugin = app.plugins?.plugins?.["templater-obsidian"];
const coreTemplates = app.internalPlugins?.getPluginById?.("templates");

let templateFolder: string | null = null;
let engine: "templater" | "core-templates" = "core-templates";

if (templaterPlugin?.settings?.templates_folder) {
  templateFolder = templaterPlugin.settings.templates_folder;
  engine = "templater";
} else if (coreTemplates?.instance?.options?.folder) {
  templateFolder = coreTemplates.instance.options.folder;
  engine = "core-templates";
}

if (!templateFolder) {
  throw new Error(
    "No template folder configured. " +
    "Configure one in Templater settings (Settings → Templater → Template folder location) " +
    "or core Templates settings (Settings → Templates → Template folder location)."
  );
}

log.info("Listing templates", { engine, templateFolder });

// --- List template files ---

const normalizedFolder = templateFolder.replace(/\\/+$/, "");
const allFiles = app.vault.getFiles();
const templateFiles = allFiles.filter(
  (f) => f.path.startsWith(normalizedFolder + "/") && f.extension === "md"
);

if (templateFiles.length === 0) {
  return JSON.stringify({ engine, template_folder: templateFolder, templates: [] });
}

// --- Scan for prompts/suggestors ---

function extractArgs(src, startIdx) {
  let depth = 1;
  let i = startIdx;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '"' || ch === "'" || ch === '\`') {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\\\') i++;
        i++;
      }
    }
    if (depth > 0) i++;
  }
  return src.substring(startIdx, i);
}

function splitArgs(argsStr) {
  const result = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      result.push(current.trim());
      current = '';
      continue;
    } else if (ch === '"' || ch === "'" || ch === '\`') {
      const quote = ch;
      current += ch;
      i++;
      while (i < argsStr.length && argsStr[i] !== quote) {
        if (argsStr[i] === '\\\\') { current += argsStr[i]; i++; }
        current += argsStr[i];
        i++;
      }
      if (i < argsStr.length) current += argsStr[i];
      continue;
    }
    current += ch;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function extractStringLiteral(arg) {
  const m = arg.match(/^["'\`]([\\s\\S]*?)["'\`]$/);
  return m ? m[1] : null;
}

function extractArrayLiteral(arg) {
  const m = arg.match(/^\\[([^\\]]*)\\]$/);
  if (!m) return null;
  return m[1].split(',').map(s => s.trim().replace(/^["'\`]|["'\`]$/g, '')).filter(Boolean);
}

function scanForCalls(src, callRegex, startIdx, sourceTag) {
  const found = [];
  let callMatch;
  callRegex.lastIndex = 0;
  while ((callMatch = callRegex.exec(src)) !== null) {
    const type = callMatch[1];
    const argsStart = callMatch.index + callMatch[0].length;
    const argsStr = extractArgs(src, argsStart);
    const args = splitArgs(argsStr);

    if (type === "prompt") {
      const label = args.length > 0 ? extractStringLiteral(args[0]) : null;
      const info = { index: startIdx++, type: "prompt", label: label ?? "" };
      if (label === null && args.length > 0) {
        info.dynamic = true;
        info.expression = args[0].substring(0, 60);
      }
      if (sourceTag) info.source = sourceTag;
      found.push(info);
    } else {
      const firstArg = args[0] || "";
      const arrayItems = extractArrayLiteral(firstArg);
      const promptTextArg = args.length >= 3 ? extractStringLiteral(args[2]) : null;

      const info = { index: startIdx++, type: "suggester" };
      if (arrayItems) {
        info.options_preview = arrayItems.slice(0, 5);
      } else {
        info.dynamic = true;
        info.source_expression = firstArg.substring(0, 80);
      }
      if (promptTextArg) info.prompt_text = promptTextArg;
      if (sourceTag) info.source = sourceTag;
      found.push(info);
    }
  }
  return { found, nextIdx: startIdx };
}

const callSiteRegex = /tp\\.system\\.(prompt|suggester)\\s*\\(/g;

const templates = [];

for (const file of templateFiles) {
  const entry: any = {
    name: file.basename,
    path: file.path,
  };

  if (detectPrompts && engine === "templater") {
    const content = await app.vault.read(file);
    let idx = 0;

    const { found: prompts, nextIdx } = scanForCalls(content, callSiteRegex, idx, null);
    idx = nextIdx;

    // Scan user scripts for additional prompts/suggestors
    const userScriptsFolder = templaterPlugin?.settings?.user_scripts_folder;
    if (userScriptsFolder) {
      const userCallRegex = /tp\\.user\\.(\\w+)/g;
      const seenScripts = new Set();
      let userMatch;
      userCallRegex.lastIndex = 0;
      while ((userMatch = userCallRegex.exec(content)) !== null) {
        seenScripts.add(userMatch[1]);
      }
      for (const scriptName of seenScripts) {
        const scriptPath = userScriptsFolder + "/" + scriptName + ".js";
        const scriptFile = app.vault.getAbstractFileByPath(scriptPath);
        if (scriptFile) {
          try {
            const scriptContent = await app.vault.read(scriptFile);
            const { found: scriptPrompts, nextIdx: ni } = scanForCalls(scriptContent, callSiteRegex, idx, "user_script:" + scriptName);
            prompts.push(...scriptPrompts);
            idx = ni;
          } catch (e) { /* script unreadable */ }
        }
      }
    }

    if (prompts.length > 0) {
      entry.prompts = prompts;
    }
  }

  templates.push(entry);
}

return JSON.stringify({ engine, template_folder: templateFolder, templates }, null, 2);`,
	"templates",
);
