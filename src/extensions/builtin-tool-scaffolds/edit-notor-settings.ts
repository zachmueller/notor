import { scaffold } from "./_scaffold-helper";

export const EDIT_NOTOR_SETTINGS = scaffold(
	"edit_notor_settings",
	"Change a single Notor plugin setting by key path.",
	"write",
	`params:
  key_path:
    type: string
    description: "Dot-separated path into the settings object (e.g. 'compaction_threshold' or 'auto_approve.write_note'). Use numeric indices for array items (e.g. 'providers.0.model_id')."
  value:
    type: string
    description: 'The new value as a JSON literal (e.g. 0.9, true, "hello"). Parsed as JSON; if parsing fails, used as a raw string.'`,
	`const keyPath = params.key_path as string;
if (!keyPath) throw new Error("key_path is required");

const rawValue = params.value as string;
let parsed: unknown;
try {
  parsed = JSON.parse(rawValue);
} catch {
  parsed = rawValue;
}

const result = await utils.editPluginSetting(keyPath, parsed);
if (!result.success) {
  throw new Error(result.error ?? "Unknown error");
}

return \`Setting updated: \${keyPath}\\n  Old: \${JSON.stringify(result.oldValue)}\\n  New: \${JSON.stringify(result.newValue)}\`;`,
);
