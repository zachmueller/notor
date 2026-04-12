/**
 * Built-in automation scaffolds — pre-packaged automations that ship with
 * the plugin and can be overridden by user-defined automations.
 *
 * Parallel to `builtin-tool-scaffolds.ts` for tools.
 *
 * @see specs/ZZ-misc/model-presets-design.md — Section 12.1, Phase G
 */

import type { AutomationTrigger } from "./types";

/** Shape of a single built-in automation scaffold. */
export interface BuiltinAutomationScaffold {
	/** Internal name used for override detection. */
	name: string;
	/** Display name shown in settings UI. */
	displayName: string;
	/** Trigger event. */
	trigger: AutomationTrigger;
	/** The scaffold TypeScript code (compiled at load time). */
	scaffoldContent: string;
}

/**
 * Built-in automation scaffolds keyed by internal name.
 *
 * Currently contains only the title generation automation. More may be
 * added in the future.
 */
export const BUILTIN_AUTOMATION_SCAFFOLDS: ReadonlyMap<string, BuiltinAutomationScaffold> = new Map([
	[
		"title-generation",
		{
			name: "title-generation",
			displayName: "Title Generation",
			trigger: "on_conversation_start" as AutomationTrigger,
			scaffoldContent: [
				"```ts",
				"// Built-in scaffold: title-generation automation",
				"// Trigger: on_conversation_start",
				"",
				'const messageText = context.firstMessage as string;',
				"if (!messageText || messageText.length < 10) return;",
				"",
				'const presetName = (settings as Record<string, unknown>).title_generation_preset as string ?? "small";',
				'const enabled = (settings as Record<string, unknown>).title_generation_enabled as boolean ?? false;',
				"if (!enabled) return;",
				"",
				"const llmCall = context.llmCall as (preset: string, msgs: Array<{role: string; content: string}>) => Promise<string | null>;",
				"if (!llmCall) return;",
				"",
				"const response = await llmCall(presetName, [",
				'  { role: "system", content: "Generate a concise title (5-8 words) for this conversation based on the user\'s message. Reply with ONLY the title text, no quotes, no punctuation wrapping." },',
				'  { role: "user", content: messageText.substring(0, 500) },',
				"]);",
				"if (!response) return;",
				"",
				"const title = response.trim();",
				"if (title) {",
				"  const api = context.conversationApi as { setTitle: (t: string) => Promise<void> };",
				"  await api.setTitle(title);",
				"}",
				"```",
			].join("\n"),
		},
	],
]);
