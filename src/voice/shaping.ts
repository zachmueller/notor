/**
 * Voice-mode shaping: the two LLM passes around a conversation turn, plus the
 * pure helpers that build their inputs and the no-LLM fallbacks.
 *
 * - Input clean-up: raw transcript → the message the user meant to send.
 * - Speech summary: the finished turn (assistant text + condensed tool
 *   activity) → a short spoken script.
 *
 * Every pass degrades gracefully: on any failure the raw transcript is sent as
 * is, and the last assistant message (markdown stripped, truncated) is spoken.
 */

import type { Message } from "../types";
import type { NotorSettings } from "../settings/types";
import type { LLMProvider, ChatMessage } from "../providers/provider";
import type { ProviderRegistry } from "../providers/index";
import type { ModelSelection } from "../chat/model-selection";
import { resolvePreset } from "../presets/preset-resolver";
import { collectText } from "../providers/collect-text";
import { getTextContent } from "../media/types";
import { logger } from "../utils/logger";
import { toSpeakableText, truncateForSpeech } from "./speech-text";
import type { VoicePromptFiles } from "./shaping-prompts";
import type { VoiceConfig } from "./voice-settings";

const log = logger("VoiceShaping");

// ---------------------------------------------------------------------------
// Model target
// ---------------------------------------------------------------------------

export interface ShapingTarget {
	provider: LLMProvider;
	modelId: string;
	useExtendedContext: boolean;
	/** Where the model came from, for logs: `preset:<name>` or `conversation`. */
	label: string;
}

/**
 * Pick the model for the shaping passes: the configured preset when set and
 * resolvable, otherwise the panel's current selection (the user's normal
 * model). Null when neither yields a usable provider.
 */
export function resolveShapingTarget(
	config: VoiceConfig,
	settings: NotorSettings,
	fallback: ModelSelection,
	registry: Pick<ProviderRegistry, "getProvider">,
): ShapingTarget | null {
	if (config.shapingPreset) {
		const resolved = resolvePreset(config.shapingPreset, settings.model_presets);
		if (resolved) {
			try {
				return {
					provider: registry.getProvider(resolved.providerId),
					modelId: resolved.modelId,
					useExtendedContext: resolved.useExtendedContext,
					label: `preset:${resolved.presetName}`,
				};
			} catch (e) {
				log.warn("Voice shaping preset provider unavailable; using the conversation model", {
					preset: config.shapingPreset,
					error: String(e),
				});
			}
		} else {
			log.warn("Voice shaping preset is not configured; using the conversation model", {
				preset: config.shapingPreset,
			});
		}
	}
	if (!fallback.providerId || !fallback.modelId) return null;
	try {
		return {
			provider: registry.getProvider(fallback.providerId),
			modelId: fallback.modelId,
			useExtendedContext: fallback.useExtendedContext,
			label: "conversation",
		};
	} catch (e) {
		log.warn("Conversation provider unavailable for voice shaping", { error: String(e) });
		return null;
	}
}

export interface ShapingDeps {
	settings: NotorSettings;
	prompts: VoicePromptFiles;
	target: ShapingTarget | null;
	signal?: AbortSignal;
}

async function runPass(
	system: string,
	user: string,
	label: string,
	deps: ShapingDeps,
): Promise<string | null> {
	if (!deps.target) return null;
	const messages: ChatMessage[] = [
		{ role: "system", content: system },
		{ role: "user", content: user },
	];
	const result = await collectText(
		deps.target.provider,
		messages,
		{
			model: deps.target.modelId,
			use_extended_context: deps.target.useExtendedContext,
			// Shaping passes are latency-sensitive and simple; keep reasoning off.
			thinking_level: null,
		},
		deps.settings,
		{ label, signal: deps.signal },
	);
	if (result.failure) {
		log.warn("Voice shaping pass ended in a stream error", { label, error: result.failure.error });
		return null;
	}
	return result.text.trim() || null;
}

// ---------------------------------------------------------------------------
// Input clean-up
// ---------------------------------------------------------------------------

/** Minimum word count worth an LLM round-trip; shorter utterances go through untouched. */
const CLEANUP_MIN_WORDS = 4;

/**
 * Clean a raw transcript for sending. Returns the raw text when clean-up is
 * disabled, the utterance is very short, no model is available, or the pass
 * fails or produces something that is clearly not a clean-up (far longer).
 */
export async function cleanupTranscript(raw: string, config: VoiceConfig, deps: ShapingDeps): Promise<string> {
	const text = raw.trim();
	if (!text) return "";
	if (!config.inputCleanupEnabled || !deps.target) return text;
	if (text.split(/\s+/).length < CLEANUP_MIN_WORDS) return text;
	try {
		const { text: system } = await deps.prompts.inputCleanup.read();
		const cleaned = await runPass(system, text, "voice:cleanup", deps);
		if (!cleaned) return text;
		if (cleaned.length > text.length * 2 + 80) {
			log.warn("Clean-up output rejected as too long; sending raw transcript", {
				rawChars: text.length,
				cleanedChars: cleaned.length,
			});
			return text;
		}
		return cleaned;
	} catch (e) {
		log.warn("Transcript clean-up failed; sending raw transcript", { error: String(e) });
		return text;
	}
}

// ---------------------------------------------------------------------------
// Turn transcript (input of the summary pass)
// ---------------------------------------------------------------------------

const PARAM_VALUE_MAX = 80;
const RESULT_SNIPPET_MAX = 200;

function basename(path: string): string {
	const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
	return name.replace(/\.md$/i, "");
}

function compactValue(value: unknown): string {
	if (typeof value === "string") {
		if (value.length > PARAM_VALUE_MAX) return `<${value.length} chars>`;
		return JSON.stringify(value);
	}
	if (value === null || value === undefined) return String(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.length} items]`;
	return "{…}";
}

/** `name(key: value, …)` with at most three parameters, long values elided. */
export function describeToolCall(toolName: string, parameters: Record<string, unknown>): string {
	const entries = Object.entries(parameters ?? {}).slice(0, 3);
	const params = entries.map(([k, v]) => `${k}: ${compactValue(v)}`).join(", ");
	const more = Object.keys(parameters ?? {}).length > 3 ? ", …" : "";
	return `${toolName}(${params}${more})`;
}

function resultSnippet(result: Message["tool_result"]): string {
	if (!result) return "";
	if (!result.success) {
		const err = result.error ?? (typeof result.result === "string" ? result.result : "");
		return `error: ${err.trim().slice(0, RESULT_SNIPPET_MAX)}`;
	}
	const text = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
	const flat = text.replace(/\s+/g, " ").trim();
	return `ok: ${flat.slice(0, RESULT_SNIPPET_MAX)}${flat.length > RESULT_SNIPPET_MAX ? "…" : ""}`;
}

/** Messages produced by the turn that started with `userMessageId` (whole list when unknown). */
export function turnMessages(messages: Message[], userMessageId: string | null): Message[] {
	if (!userMessageId) return messages;
	const index = messages.findIndex((m) => m.id === userMessageId);
	return index >= 0 ? messages.slice(index + 1) : messages;
}

/**
 * Condense a turn into a compact transcript for the summary pass: assistant
 * text verbatim, each tool call as `TOOL name(params)` with its result on the
 * next line, and runs of the same tool collapsed (`TOOL search_notes ×4`).
 */
export function buildTurnTranscript(messages: Message[], userMessageId: string | null): string {
	const turn = turnMessages(messages, userMessageId);
	const lines: string[] = [];

	// Pair each tool_call with its tool_result (by id when present, else by order).
	const results = new Map<string, Message>();
	const unpaired: Message[] = [];
	for (const m of turn) {
		if (m.role !== "tool_result" || !m.tool_result) continue;
		const id = m.tool_result.tool_call_id;
		if (id) results.set(id, m);
		else unpaired.push(m);
	}

	type Run = { name: string; first: Message; count: number; last: Message | undefined; failures: number };
	let run: Run | null = null;
	const flushRun = () => {
		if (!run) return;
		const call = run.first.tool_call!;
		const head = run.count > 1
			? `TOOL ${run.name} ×${run.count} (first: ${describeToolCall(run.name, call.parameters)})`
			: `TOOL ${describeToolCall(run.name, call.parameters)}`;
		lines.push(head);
		const summary = run.last?.tool_result ? resultSnippet(run.last.tool_result) : "";
		const failures = run.failures > 0 && run.count > 1 ? ` (${run.failures} failed)` : "";
		if (summary) lines.push(`  → ${summary}${failures}`);
		run = null;
	};

	for (const m of turn) {
		if (m.role === "tool_call" && m.tool_call) {
			const name = m.tool_call.tool_name;
			const result = (m.tool_call.id ? results.get(m.tool_call.id) : undefined) ?? unpaired.shift();
			const failed = result?.tool_result ? !result.tool_result.success : false;
			if (run && run.name === name && !failed) {
				run.count++;
				run.last = result;
				continue;
			}
			flushRun();
			run = { name, first: m, count: 1, last: result, failures: failed ? 1 : 0 };
			if (failed) flushRun();
			continue;
		}
		if (m.role === "tool_result") continue;
		flushRun();
		if (m.role === "assistant") {
			const text = getTextContent(m.content).trim();
			if (text) lines.push(text);
		} else if (m.role === "error") {
			const text = getTextContent(m.content).trim();
			if (text) lines.push(`ERROR: ${text}`);
		}
		// user / system / extension_block / hook injections are not spoken.
	}
	flushRun();
	return lines.join("\n");
}

/** The last assistant message of the turn, as plain text (used when the summary pass is unavailable). */
export function turnFallbackText(messages: Message[], userMessageId: string | null): string {
	const turn = turnMessages(messages, userMessageId);
	for (let i = turn.length - 1; i >= 0; i--) {
		const m = turn[i]!;
		if (m.role === "assistant") {
			const text = getTextContent(m.content).trim();
			if (text) return text;
		}
	}
	return "";
}

// ---------------------------------------------------------------------------
// Speech summary
// ---------------------------------------------------------------------------

/** Keep a spoken error headline short. */
export function truncateSpokenError(text: string): string {
	return truncateForSpeech(text, 200);
}

/** No-LLM spoken fallback: strip markdown and cut to the configured budget. */
export function fallbackSpoken(text: string, config: VoiceConfig): string {
	return truncateForSpeech(toSpeakableText(text), config.summaryMaxChars);
}

/**
 * Summarize a turn for speech. Falls back to the last assistant message when
 * no model is available or the pass fails.
 */
export async function summarizeTurnForSpeech(
	transcript: string,
	fallbackText: string,
	config: VoiceConfig,
	deps: ShapingDeps,
): Promise<string> {
	if (!transcript.trim()) return fallbackSpoken(fallbackText, config);
	if (!deps.target) return fallbackSpoken(fallbackText, config);
	try {
		const { text: system } = await deps.prompts.speechSummary.read();
		const sentences = Math.max(1, Math.round(config.summaryMaxChars / 90));
		const user = `${transcript}\n\nLength limit: about ${config.summaryMaxChars} characters (roughly ${sentences} sentences).`;
		const summary = await runPass(system, user, "voice:summary", deps);
		const spoken = summary ? toSpeakableText(summary) : "";
		if (!spoken) return fallbackSpoken(fallbackText, config);
		// Hard cap with slack: the prompt asks for the budget, this prevents runaways.
		return truncateForSpeech(spoken, Math.round(config.summaryMaxChars * 1.5));
	} catch (e) {
		log.warn("Speech summary failed; speaking the last assistant message", { error: String(e) });
		return fallbackSpoken(fallbackText, config);
	}
}

// ---------------------------------------------------------------------------
// Spoken progress / announcements (no LLM)
// ---------------------------------------------------------------------------

const VERBS: Array<[RegExp, string]> = [
	[/^(read|get|open|show)/, "reading"],
	[/^(search|find|grep|query|web_search)/, "searching"],
	[/^(write|create|append|save)/, "writing"],
	[/^(replace|edit|update|modify|rename|move|manage)/, "editing"],
	[/^(delete|remove)/, "deleting"],
	[/^(list|browse)/, "listing"],
	[/^(fetch|download|browse_web)/, "fetching"],
	[/^(run|execute|exec)/, "running"],
	[/^(use_subagent|delegate|spawn)/, "delegating to"],
	[/^(ask|prompt)/, "asking"],
];

function humanizeToolName(toolName: string): string {
	return toolName.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A template one-liner for the `every_tool` verbosity level, e.g. "reading Daily note". */
export function formatToolProgressLine(toolName: string, parameters: Record<string, unknown>): string {
	const verb = VERBS.find(([re]) => re.test(toolName))?.[1];
	const path = typeof parameters?.path === "string" ? parameters.path
		: typeof parameters?.note_path === "string" ? parameters.note_path
		: typeof parameters?.file_path === "string" ? parameters.file_path
		: null;
	const query = typeof parameters?.query === "string" ? parameters.query
		: typeof parameters?.pattern === "string" ? parameters.pattern
		: null;
	if (verb === "delegating to") return "delegating to a sub-agent";
	if (verb === "asking") return "asking you a question";
	if (verb && path) return `${verb} ${basename(path)}`;
	if (verb === "searching" && query) return `searching for ${truncateForSpeech(query, 60)}`;
	if (verb === "fetching") return "fetching a web page";
	if (verb === "running" && toolName.includes("command")) return "running a command";
	if (verb) return `${verb} with ${humanizeToolName(toolName)}`;
	return `running ${humanizeToolName(toolName)}`;
}

/** Spoken approval announcement for one blocked episode. */
export function formatApprovalAnnouncement(
	pending: Array<{ toolName: string; parameters: Record<string, unknown> }>,
): string {
	if (pending.length === 0) return "";
	const first = pending[0]!;
	const what = formatToolProgressLine(first.toolName, first.parameters).replace(/^running with /, "running ");
	if (pending.length === 1) return `Approval needed for ${what}. Say approve or reject.`;
	return `${pending.length} approvals needed. The first is ${what}. Say approve, approve all, or reject.`;
}

/** Spoken announcement for an `ask_user` style question list. */
export function formatQuestionAnnouncement(
	questions: Array<{ question: string; suggestions?: string[] }>,
): string {
	const first = questions[0];
	if (!first) return "";
	const parts = [first.question.trim()];
	const suggestions = (first.suggestions ?? []).filter(Boolean).slice(0, 4);
	if (suggestions.length > 0) {
		parts.push(`Options: ${suggestions.map((s, i) => `${i + 1}, ${s}`).join("; ")}.`);
	}
	if (questions.length > 1) parts.push(`There are ${questions.length} questions in total.`);
	parts.push("Say answer, followed by your reply.");
	return parts.join(" ");
}
