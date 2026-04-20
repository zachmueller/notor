/**
 * Markdown exporter — converts a conversation and its messages to a
 * Markdown string suitable for saving as an Obsidian vault note.
 *
 * Uses Obsidian callout syntax for tool calls, tool results, attachments,
 * and other collapsible sections so they render natively in Obsidian.
 */

import type { Conversation, Message, ToolCall, ToolResult } from "../types";
import { assertUnreachable } from "../utils/assert-unreachable";
import { formatToolDisplayName } from "../ui/tool-call-ui";
import { getTextContent } from "../media/types";

const WORKFLOW_RE = /<workflow_instructions\s+type="([^"]*)">([\s\S]*?)<\/workflow_instructions>/;
const ATTACHMENTS_RE = /<attachments>([\s\S]*?)<\/attachments>/;

/**
 * Export a conversation to Markdown.
 */
export function exportToMarkdown(conversation: Conversation, messages: Message[]): string {
	const sections: string[] = [];

	// ── Frontmatter ──────────────────────────────────────────────────────
	sections.push(buildFrontmatter(conversation));

	// ── Title ────────────────────────────────────────────────────────────
	const title = conversation.title ?? "Untitled conversation";
	const date = new Date(conversation.created_at).toLocaleString();
	sections.push(`# ${title}\n\n*${date} · ${conversation.provider_id} / ${conversation.model_id}*`);

	// ── Messages ─────────────────────────────────────────────────────────
	for (const msg of messages) {
		const rendered = renderMessage(msg);
		if (rendered) sections.push(rendered);
	}

	// ── Footer ───────────────────────────────────────────────────────────
	const footer: string[] = ["---", ""];
	if (conversation.total_input_tokens || conversation.total_output_tokens) {
		footer.push(
			`*Tokens — input: ${conversation.total_input_tokens.toLocaleString()}, ` +
			`output: ${conversation.total_output_tokens.toLocaleString()}*`
		);
	}
	if (conversation.estimated_cost != null) {
		footer.push(`*Estimated cost: $${conversation.estimated_cost.toFixed(4)}*`);
	}
	if (footer.length > 2) sections.push(footer.join("\n"));

	return sections.join("\n\n") + "\n";
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function buildFrontmatter(c: Conversation): string {
	const lines = [
		"---",
		`conversation_id: ${c.id}`,
		`provider: ${c.provider_id}`,
		`model: ${c.model_id}`,
		`created: ${c.created_at}`,
		`updated: ${c.updated_at}`,
		`mode: ${c.mode}`,
	];
	if (c.total_input_tokens) lines.push(`input_tokens: ${c.total_input_tokens}`);
	if (c.total_output_tokens) lines.push(`output_tokens: ${c.total_output_tokens}`);
	if (c.estimated_cost != null) lines.push(`estimated_cost: ${c.estimated_cost}`);
	if (c.workflow_name) lines.push(`workflow: ${c.workflow_name}`);
	if (c.persona_name) lines.push(`persona: ${c.persona_name}`);
	lines.push("---");
	return lines.join("\n");
}

function renderMessage(msg: Message): string | null {
	switch (msg.role) {
		case "system":
			return null; // skip system/compaction messages
		case "user":
			return renderUserMessage(msg);
		case "assistant":
			return renderAssistantMessage(msg);
		case "tool_call":
			return renderToolCall(msg);
		case "tool_result":
			return renderToolResult(msg);
		default:
			assertUnreachable(msg.role);
	}
}

function renderUserMessage(msg: Message): string {
	const parts: string[] = [];
	const timestamp = formatTimestamp(msg.timestamp);
	parts.push(`## User\n*${timestamp}*`);

	if (msg.is_hook_injection) {
		parts.push(wrapCallout("info", "Hook output", getTextContent(msg.content), true));
		return parts.join("\n\n");
	}

	let content = getTextContent(msg.content);

	// Extract and render attachments block
	const attachMatch = ATTACHMENTS_RE.exec(content);
	if (attachMatch) {
		content = (content.slice(0, attachMatch.index) + content.slice(attachMatch.index + attachMatch[0].length)).trim();
		parts.push(wrapCallout("info", "Attachments", "```xml\n" + attachMatch[0] + "\n```", true));
	}

	// Extract and render workflow instructions
	if (msg.is_workflow_message) {
		const wfMatch = WORKFLOW_RE.exec(content);
		if (wfMatch) {
			const before = content.slice(0, wfMatch.index).trim();
			const after = content.slice(wfMatch.index + wfMatch[0].length).trim();
			if (before) {
				parts.push(wrapCallout("info", "Trigger context", "```\n" + before + "\n```", true));
			}
			parts.push(wrapCallout("info", `Workflow: ${wfMatch[1] ?? ""}`, (wfMatch[2] ?? "").trim(), true));
			content = after;
		}
	}

	// Render attachment metadata if present
	if (msg.attachments?.length) {
		const attachList = msg.attachments
			.map((a) => `- **${a.display_name}** (${a.type}, ${a.status})`)
			.join("\n");
		parts.push(wrapCallout("info", "Attached files", attachList, true));
	}

	if (content.trim()) parts.push(content.trim());

	return parts.join("\n\n");
}

function renderAssistantMessage(msg: Message): string {
	const parts: string[] = [];
	const timestamp = formatTimestamp(msg.timestamp);
	parts.push(`## Assistant\n*${timestamp}*`);
	const assistantContent = typeof msg.content === "string"
		? msg.content
		: (() => { throw new Error("Expected string content for assistant message"); })();
	parts.push(assistantContent);

	if (msg.input_tokens || msg.output_tokens) {
		parts.push(`*↑${msg.input_tokens ?? 0} · ↓${msg.output_tokens ?? 0}*`);
	}

	return parts.join("\n\n");
}

function renderToolCall(msg: Message): string {
	const tc: ToolCall | undefined | null = msg.tool_call;
	if (!tc) return "";

	const displayName = formatToolDisplayName(tc.tool_name);
	const hasParams = Object.keys(tc.parameters).length > 0;
	const body = hasParams
		? "```json\n" + JSON.stringify(tc.parameters, null, 2) + "\n```"
		: "*No parameters*";

	return wrapCallout("abstract", `Tool: ${displayName} (${tc.status})`, body, true);
}

function renderToolResult(msg: Message): string {
	const tr: ToolResult | undefined | null = msg.tool_result;
	if (!tr) return "";

	const displayName = formatToolDisplayName(tr.tool_name);
	const calloutType = tr.success ? "success" : "failure";
	const icon = tr.success ? "✓" : "✗";

	let body: string;
	if (!tr.success) {
		body = tr.error ?? "Unknown error";
	} else {
		const resultStr = typeof tr.result === "string"
			? tr.result
			: JSON.stringify(tr.result, null, 2);
		body = resultStr.length > 200
			? "```\n" + resultStr + "\n```"
			: resultStr;
	}

	return wrapCallout(calloutType, `${icon} Result: ${displayName}`, body, true);
}

/**
 * Wrap content in an Obsidian callout block.
 * Collapsed callouts use `> [!type]- Title` syntax.
 */
function wrapCallout(type: string, title: string, body: string, collapsed: boolean): string {
	const marker = collapsed ? "-" : "+";
	const lines = body.split("\n");
	return `> [!${type}]${marker} ${title}\n` + lines.map((l) => `> ${l}`).join("\n");
}

function formatTimestamp(iso: string): string {
	return new Date(iso).toLocaleString();
}
