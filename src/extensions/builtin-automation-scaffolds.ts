/**
 * Built-in automation scaffolds — pre-packaged automations that ship with
 * the plugin and can be overridden by user-defined automations in the vault.
 *
 * Follows the same pattern as `builtin-tool-scaffolds.ts`:
 * - Scaffold content is a complete `.md` file (frontmatter + prose + code fence)
 * - If no vault file exists for a scaffold, the in-memory scaffold is injected
 * - Users can "Open" to create a vault file, edit the code, and customize
 * - The vault file overrides the scaffold on next extension reload
 *
 * @see specs/ZZ-misc/model-presets-design.md — Section 12.1, Phase G
 */

import type { AutomationTrigger, SettingsFieldSchema } from "./types";

/** Definition of a built-in automation scaffold (code-side constant). */
export interface BuiltinAutomationScaffold {
	/** Internal name (matches the vault filename without `.md`). */
	name: string;
	/** Display name shown in settings UI. */
	displayName: string;
	/** Trigger event. */
	trigger: AutomationTrigger;
	/**
	 * Full content of the `.md` scaffold file including frontmatter
	 * and TS code fence — identical to what gets written to the vault.
	 */
	scaffoldContent: string;
	/** Optional settings schema for per-automation settings (rendered in gear modal). */
	settingsSchema?: SettingsFieldSchema[];
	/** When true, awaited before the first LLM turn proceeds. */
	blocking?: boolean;
	/** Block kind to emit as a loading placeholder (only when `blocking` is true). */
	blockingEmitKind?: string;
	/** Timeout in milliseconds for blocking execution. */
	blockingTimeout?: number;
	/** Feature group for gating (e.g. `"memory"` → gated by `memory_enabled`). */
	featureGroup?: string;
	/** Cron expression for `on_schedule` trigger. */
	schedule?: string;
}

/**
 * Built-in automation scaffolds keyed by internal name.
 */
export const BUILTIN_AUTOMATION_SCAFFOLDS: ReadonlyMap<string, BuiltinAutomationScaffold> = new Map([
	[
		"title-generation",
		{
			name: "title-generation",
			displayName: "Title Generation",
			trigger: "on_conversation_start" as AutomationTrigger,
			settingsSchema: [
				{
					key: "preset",
					name: "Title generation preset",
					type: "string",
					description: "The model preset used for LLM title generation calls.",
					optionsSource: "model_presets",
					default: "small",
				},
			],
			scaffoldContent:
`---
notor-type: automation
notor-trigger: on_conversation_start
notor-display-name: Title Generation
---

Automatically generates a descriptive conversation title using an LLM call.
Fires once when the first user message is sent. The title generation preset
is configured via the gear icon in Automation settings; the enable/disable
toggle controls whether this automation runs.

Edit the code below to customize the prompt, model selection, or title
post-processing. Reload extensions to apply changes.

\`\`\`ts
// Built-in: title-generation automation
// Trigger: on_conversation_start
// Settings: preset (model preset name, resolved via settingsSchema)

const messageText = context.firstMessage as string;
if (!messageText || messageText.length < 10) return;

// Read preset from per-extension settings (resolved via settingsSchema defaults)
const presetName = (settings as Record<string, unknown>).preset as string;
if (!presetName) return;

// Use utils.llmCall (available to all extensions) and utils.conversationApi
const response = await utils.llmCall(presetName, [
  { role: "system", content: "Generate a concise title (5-8 words) for this conversation based on the user's message. Reply with ONLY the title text, no quotes, no punctuation wrapping." },
  { role: "user", content: messageText.substring(0, 500) },
]);
if (!response) return;

const title = response.trim();
if (title && utils.conversationApi) {
  utils.conversationApi.setTitle(title);
}
\`\`\`
`,
		},
	],
]);
