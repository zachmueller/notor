import { scaffold } from "./_scaffold-helper";

export const APPLY_TEMPLATE = scaffold(
	"apply_template",
	"Apply a template to create a new note. For Templater templates, automatically answers prompts and suggestors from ordered arrays.",
	"write",
	`params:
  template_path:
    type: string
    description: "Path to the template file relative to vault root."
    path_namespace: vault
    path_resolve_as: note
    path_access: read
  output_folder:
    type: string
    description: "Target folder for the new note. If omitted, uses vault root or Templater's configured location."
    default: ""
    path_namespace: vault
    path_access: write
  output_filename:
    type: string
    description: "Filename for the new note (without .md extension). If omitted, Templater decides or uses the template name."
    default: ""
  prompt_answers:
    type: "string[]"
    description: "Ordered array of answers for tp.system.prompt() calls. The Nth element answers the Nth prompt encountered during template execution."
    default: []
  suggester_answers:
    type: "string[]"
    description: "Ordered array of selected values for tp.system.suggester() calls. The Nth element selects the Nth suggester's choice. Match against display labels or raw values."
    default: []
settings:
  templates_apply_timeout:
    name: "Execution Timeout"
    type: number
    description: "Maximum seconds to wait for template execution before timing out."
    default: 30
    min: 5
    max: 120`,
	`const log = utils.logger("apply_template");

// --- Resolve template file ---

const templatePath = params.template_path as string;
if (!templatePath) throw new Error("Missing required parameter: template_path");

const templateFile = utils.resolveNote(templatePath);
if (!templateFile) {
  throw new Error(\`Template not found: \${templatePath}. Use list_templates to see available templates.\`);
}

// --- Detect engine ---

const templaterPlugin = app.plugins?.plugins?.["templater-obsidian"];
const hasTemplater = !!(templaterPlugin?.templater);

const outputFolder = ((params.output_folder as string) || "").trim();
const outputFilename = ((params.output_filename as string) || "").trim();
const promptAnswers = [...((params.prompt_answers as string[]) || [])];
const suggesterAnswers = [...((params.suggester_answers as string[]) || [])];
const timeoutMs = ((settings.templates_apply_timeout as number) || 30) * 1000;

log.info("Applying template", {
  template: templateFile.path,
  engine: hasTemplater ? "templater" : "core-templates",
  outputFolder,
  outputFilename,
  promptCount: promptAnswers.length,
  suggesterCount: suggesterAnswers.length,
});

// --- Execute with timeout ---

const timeoutPromise = new Promise<never>((_, reject) =>
  setTimeout(
    () => reject(new Error(\`Template execution timed out after \${Math.round(timeoutMs / 1000)} seconds.\`)),
    timeoutMs,
  ),
);

const executionPromise = utils.queue.enqueue("template-apply", async () => {
  if (hasTemplater) {
    // === Templater engine ===
    const templater = templaterPlugin.templater;
    const intFn = templater.functions_generator?.internal_functions;
    const modulesArray = intFn?.modules_array;
    if (!modulesArray) {
      throw new Error("Templater internal structure not accessible (modules_array missing). The Templater version may be incompatible.");
    }

    let systemModule: any = null;
    for (let i = 0; i < modulesArray.length; i++) {
      if (modulesArray[i].name === "system") {
        systemModule = modulesArray[i];
        break;
      }
    }
    if (!systemModule?.static_object) {
      throw new Error("Templater system module not found or not initialized. Try reloading the Templater plugin.");
    }

    const origPrompt = systemModule.static_object.prompt;
    const origSuggester = systemModule.static_object.suggester;

    const pQueue = [...promptAnswers];
    const sQueue = [...suggesterAnswers];

    systemModule.static_object.prompt = async (promptText?: string, defaultValue?: string) => {
      const answer = pQueue.shift();
      if (answer === undefined) {
        throw new Error(
          \`Template called tp.system.prompt("\${promptText ?? ""}") but no answer was provided. \` +
          \`Supply more entries in prompt_answers (provided \${promptAnswers.length}, needed at least \${promptAnswers.length + 1}).\`
        );
      }
      log.debug("Prompt intercepted", { promptText, answer });
      return answer;
    };

    systemModule.static_object.suggester = async (textItems: any, items: any) => {
      const answer = sQueue.shift();
      if (answer === undefined) {
        throw new Error(
          \`Template called tp.system.suggester() but no answer was provided. \` +
          \`Supply more entries in suggester_answers (provided \${suggesterAnswers.length}, needed at least \${suggesterAnswers.length + 1}).\`
        );
      }
      log.debug("Suggester intercepted", { answer });

      const valuesArr = Array.isArray(items) ? items : [items];
      const displayArr = Array.isArray(textItems) ? textItems : [];

      // Match against display labels first, then raw values
      const displayIdx = displayArr.indexOf(answer);
      if (displayIdx >= 0 && displayIdx < valuesArr.length) return valuesArr[displayIdx];

      const valueIdx = valuesArr.indexOf(answer);
      if (valueIdx >= 0) return valuesArr[valueIdx];

      // No match — return the raw answer (template may use it as-is)
      return answer;
    };

    try {
      const folder = outputFolder
        ? app.vault.getAbstractFileByPath(outputFolder)
        : undefined;

      const resultFile = await templater.create_new_note_from_template(
        templateFile,
        folder || undefined,
        outputFilename || undefined,
      );

      const outputPath = resultFile?.path ?? "(created — path not returned)";

      const warnings: string[] = [];
      if (pQueue.length > 0) warnings.push(\`\${pQueue.length} unused prompt answer(s) — template may have fewer prompts than expected.\`);
      if (sQueue.length > 0) warnings.push(\`\${sQueue.length} unused suggester answer(s) — template may have fewer suggestors than expected.\`);

      const warningStr = warnings.length > 0 ? "\\nWarnings:\\n- " + warnings.join("\\n- ") : "";
      return \`Template applied successfully via Templater.\\nCreated: \${outputPath}\${warningStr}\`;
    } finally {
      systemModule.static_object.prompt = origPrompt;
      systemModule.static_object.suggester = origSuggester;
    }
  } else {
    // === Core Templates fallback ===
    const content = await app.vault.read(templateFile);
    const now = new Date();
    const title = outputFilename || templateFile.basename;

    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toTimeString().split(" ")[0].slice(0, 5);

    const processed = content
      .replace(/\\{\\{date\\}\\}/g, dateStr)
      .replace(/\\{\\{time\\}\\}/g, timeStr)
      .replace(/\\{\\{title\\}\\}/g, title);

    const outPath = outputFolder
      ? \`\${outputFolder}/\${title}.md\`
      : \`\${title}.md\`;

    await utils.ensureDirectoryExists(outPath);
    await app.vault.create(outPath, processed);

    return \`Template applied via core Templates engine.\\nCreated: \${outPath}\`;
  }
});

return await Promise.race([executionPromise, timeoutPromise]);`,
	"templates",
);
