/**
 * HTML exporter — converts a conversation and its messages to a
 * self-contained HTML document with embedded CSS.
 *
 * The output is portable: no external dependencies, collapsible sections
 * via native `<details>` elements, and a clean, readable design.
 */

import type { Conversation, Message, ToolCall, ToolResult } from "../types";
import { assertUnreachable } from "../utils/assert-unreachable";
import { formatToolDisplayName } from "../ui/tool-call-ui";
import { USE_SUBAGENT_TOOL_NAME } from "../sub-agents/constants";
import { marked } from "marked";
import { getTextContent, type ContentBlock } from "../media/types";

const WORKFLOW_RE = /<workflow_instructions\s+type="([^"]*)">([\s\S]*?)<\/workflow_instructions>/;
const ATTACHMENTS_RE = /<attachments>([\s\S]*?)<\/attachments>/;

/**
 * Sub-agent conversation data for HTML export rendering.
 *
 * Keyed by JSONL filename (from `ToolResult.sub_agent_metadata.jsonl_filename`).
 * Loaded by the caller before invoking `exportToHtml()`.
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 5.3
 */
export type SubAgentConversationMap = Map<string, Message[]>;

/**
 * Export a conversation to a self-contained HTML document.
 *
 * @param subAgentConversations - Optional map of sub-agent conversation
 *   messages, keyed by JSONL filename. When provided, `use_subagent` tool
 *   results render an expandable section with the full sub-agent conversation.
 */
export function exportToHtml(
	conversation: Conversation,
	messages: Message[],
	subAgentConversations?: SubAgentConversationMap,
): string {
	const title = escapeHtml(conversation.title ?? "Untitled conversation");
	const date = new Date(conversation.created_at).toLocaleString();
	const model = escapeHtml(`${conversation.provider_id} / ${conversation.model_id}`);

	const messageSections = messages
		.map((msg) => renderMessage(msg, subAgentConversations))
		.filter(Boolean)
		.join("\n");

	const tokenInfo = buildTokenInfo(conversation);

	const jsonlBlock = buildJsonlBlock(conversation, messages);

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
${EMBEDDED_CSS}
</head>
<body>
<div class="container">
  <header class="conversation-header">
    <h1>${title}</h1>
    <div class="meta">${date} &middot; ${model}</div>
  </header>
  <div class="messages">
${messageSections}
  </div>
${tokenInfo}
</div>
${jsonlBlock}
</body>
</html>`;
}

// ─── Embedded CSS ────────────────────────────────────────────────────────

const EMBEDDED_CSS = `<style>
:root {
  --bg: #ffffff;
  --bg-secondary: #f6f8fa;
  --bg-code: #f0f2f5;
  --text: #1f2328;
  --text-muted: #656d76;
  --border: #d0d7de;
  --accent-user: #0969da;
  --accent-assistant: #1a7f37;
  --accent-tool: #8250df;
  --accent-success: #1a7f37;
  --accent-error: #cf222e;
  --radius: 8px;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --bg-secondary: #161b22;
    --bg-code: #1c2128;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --border: #30363d;
    --accent-user: #58a6ff;
    --accent-assistant: #3fb950;
    --accent-tool: #bc8cff;
    --accent-success: #3fb950;
    --accent-error: #f85149;
  }
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.6;
  color: var(--text);
  background: var(--bg);
  padding: 0;
}

.container {
  max-width: 820px;
  margin: 0 auto;
  padding: 32px 24px;
}

.conversation-header {
  margin-bottom: 32px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}

.conversation-header h1 {
  font-size: 1.6em;
  font-weight: 600;
  margin-bottom: 4px;
}

.meta {
  color: var(--text-muted);
  font-size: 0.85em;
}

/* ── Message blocks ─────────────────────────────────────── */

.message {
  margin-bottom: 24px;
  padding: 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
}

.message-role {
  font-size: 0.78em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 8px;
}

.message-timestamp {
  font-size: 0.75em;
  color: var(--text-muted);
  font-weight: 400;
  margin-left: 8px;
  text-transform: none;
  letter-spacing: normal;
}

.message-user { background: var(--bg); }
.message-user .message-role { color: var(--accent-user); }

.message-assistant { background: var(--bg-secondary); }
.message-assistant .message-role { color: var(--accent-assistant); }

.message-content p { margin: 0.5em 0; }
.message-content p:first-child { margin-top: 0; }
.message-content p:last-child { margin-bottom: 0; }
.message-content pre {
  background: var(--bg-code);
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.88em;
  margin: 0.5em 0;
}
.message-content code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--bg-code);
  padding: 2px 5px;
  border-radius: 3px;
}
.message-content pre code {
  background: none;
  padding: 0;
}
.message-content ul, .message-content ol {
  padding-left: 1.5em;
  margin: 0.5em 0;
}
.message-content blockquote {
  border-left: 3px solid var(--border);
  padding-left: 12px;
  color: var(--text-muted);
  margin: 0.5em 0;
}
.message-content table {
  border-collapse: collapse;
  margin: 0.5em 0;
  width: 100%;
}
.message-content th, .message-content td {
  border: 1px solid var(--border);
  padding: 6px 12px;
  text-align: left;
}
.message-content th {
  background: var(--bg-secondary);
  font-weight: 600;
}

.inline-image {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
  margin: 4px 0;
}

.token-annotation {
  font-size: 0.75em;
  color: var(--text-muted);
  margin-top: 8px;
}

/* ── Tool calls & results ───────────────────────────────── */

.tool-call, .tool-result {
  margin-bottom: 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  overflow: hidden;
}

.tool-call { border-left: 3px solid var(--accent-tool); }

.tool-call-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  font-size: 0.85em;
}

.tool-name {
  font-weight: 600;
  font-family: var(--font-mono);
  color: var(--accent-tool);
}

.status-badge {
  font-size: 0.78em;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
}
.status-success { background: #dafbe1; color: #1a7f37; }
.status-error   { background: #ffebe9; color: #cf222e; }
.status-pending  { background: #fff8c5; color: #9a6700; }
.status-approved { background: #dafbe1; color: #1a7f37; }
.status-rejected { background: #ffebe9; color: #cf222e; }

@media (prefers-color-scheme: dark) {
  .status-success  { background: #0d2818; color: #3fb950; }
  .status-error    { background: #2d0e0e; color: #f85149; }
  .status-pending  { background: #2d2200; color: #d29922; }
  .status-approved { background: #0d2818; color: #3fb950; }
  .status-rejected { background: #2d0e0e; color: #f85149; }
}

.tool-result { border-left: 3px solid var(--accent-success); }
.tool-result-error { border-left-color: var(--accent-error); }

.tool-result-summary {
  padding: 8px 12px;
  font-size: 0.85em;
  background: var(--bg-secondary);
}

.result-icon-success { color: var(--accent-success); font-weight: 600; }
.result-icon-error   { color: var(--accent-error); font-weight: 600; }

/* ── Collapsible details ────────────────────────────────── */

details {
  border: 1px solid var(--border);
  border-radius: 6px;
  margin: 8px 0;
  overflow: hidden;
}

details summary {
  padding: 6px 12px;
  cursor: pointer;
  font-size: 0.85em;
  color: var(--text-muted);
  background: var(--bg-secondary);
  user-select: none;
  list-style: none;
}

details summary::-webkit-details-marker { display: none; }

details summary::before {
  content: "\\25B6";
  font-size: 0.7em;
  margin-right: 6px;
  display: inline-block;
  transition: transform 0.15s ease;
}

details[open] summary::before {
  transform: rotate(90deg);
}

details .details-body {
  padding: 8px 12px;
  font-size: 0.88em;
}

details pre {
  background: var(--bg-code);
  border-radius: 4px;
  padding: 10px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.88em;
  margin: 0;
}

/* ── Footer ─────────────────────────────────────────────── */

.conversation-footer {
  margin-top: 32px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  font-size: 0.82em;
  color: var(--text-muted);
}

/* ── Sub-agent conversation detail ─────────────────────── */

.sub-agent-conversation {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sub-agent-msg {
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 0.88em;
  border-left: 2px solid var(--border);
}

.sub-agent-system { color: var(--text-muted); font-size: 0.82em; }
.sub-agent-user { border-left-color: var(--accent-user); }
.sub-agent-assistant { border-left-color: var(--accent-assistant); }
.sub-agent-tool-call { border-left-color: var(--accent-tool); }
.sub-agent-tool-result { border-left-color: var(--accent-success); }
</style>`;

// ─── Message rendering ───────────────────────────────────────────────────

function renderMessage(msg: Message, subAgentConversations?: SubAgentConversationMap): string | null {
	switch (msg.role) {
		case "system":
			return null;
		case "user":
			return renderUserMessage(msg);
		case "assistant":
			return renderAssistantMessage(msg);
		case "tool_call":
			return renderToolCallHtml(msg);
		case "tool_result":
			return renderToolResultHtml(msg, subAgentConversations);
		default:
			assertUnreachable(msg.role);
	}
}

function renderUserMessage(msg: Message): string {
	const ts = formatTimestamp(msg.timestamp);
	const parts: string[] = [];

	if (msg.is_hook_injection) {
		parts.push(detailsBlock("Hook output", `<pre>${escapeHtml(getTextContent(msg.content))}</pre>`));
		return messageBlock("user", "User", ts, parts.join("\n"));
	}

	let content = getTextContent(msg.content);

	// Attachments XML block
	const attachMatch = ATTACHMENTS_RE.exec(content);
	if (attachMatch) {
		content = (content.slice(0, attachMatch.index) + content.slice(attachMatch.index + attachMatch[0].length)).trim();
		parts.push(detailsBlock("Attachments", `<pre>${escapeHtml(attachMatch[0])}</pre>`));
	}

	// Workflow instructions
	if (msg.is_workflow_message) {
		const wfMatch = WORKFLOW_RE.exec(content);
		if (wfMatch) {
			const before = content.slice(0, wfMatch.index).trim();
			const after = content.slice(wfMatch.index + wfMatch[0].length).trim();
			if (before) {
				parts.push(detailsBlock("Trigger context", `<pre>${escapeHtml(before)}</pre>`));
			}
			parts.push(detailsBlock(`Workflow: ${escapeHtml(wfMatch[1] ?? "")}`, `<pre>${escapeHtml((wfMatch[2] ?? "").trim())}</pre>`));
			content = after;
		}
	}

	// Attachment metadata
	if (msg.attachments?.length) {
		const items = msg.attachments
			.map((a) => `<li><strong>${escapeHtml(a.display_name)}</strong> (${escapeHtml(a.type)}, ${escapeHtml(a.status)})</li>`)
			.join("\n");
		parts.push(detailsBlock("Attached files", `<ul>${items}</ul>`));
	}

	if (content.trim()) {
		parts.push(`<div class="message-content">${escapeHtml(content.trim()).replace(/\n/g, "<br>")}</div>`);
	}

	// Render inline media blocks (images and PDF placeholders).
	// custom_block entries won't appear in user messages — they only appear in extension_block messages.
	if (Array.isArray(msg.content)) {
		for (const block of msg.content as ContentBlock[]) {
			if (block.type === "image") {
				const widthAttr = block.width ? ` width="${block.width}"` : "";
				const heightAttr = block.height ? ` height="${block.height}"` : "";
				parts.push(`<div class="message-content"><img class="inline-image" src="data:${escapeHtml(block.media_type)};base64,${block.data}"${widthAttr}${heightAttr} alt="Attached image"></div>`);
			} else if (block.type === "document") {
				parts.push(`<div class="message-content"><em>[PDF document attached]</em></div>`);
			}
		}
	}

	return messageBlock("user", "User", ts, parts.join("\n"));
}

function renderAssistantMessage(msg: Message): string {
	const ts = formatTimestamp(msg.timestamp);
	const assistantText = typeof msg.content === "string"
		? msg.content
		: (() => { throw new Error("Expected string content for assistant message"); })();
	const htmlContent = marked.parse(assistantText, { async: false }) as string;
	let body = `<div class="message-content">${htmlContent}</div>`;

	if (msg.input_tokens || msg.output_tokens) {
		body += `\n<div class="token-annotation">↑${msg.input_tokens ?? 0} · ↓${msg.output_tokens ?? 0}</div>`;
	}

	return messageBlock("assistant", "Assistant", ts, body);
}

function renderToolCallHtml(msg: Message): string {
	const tc: ToolCall | undefined | null = msg.tool_call;
	if (!tc) return "";

	const displayName = escapeHtml(formatToolDisplayName(tc.tool_name));
	const statusClass = `status-${tc.status}`;
	const hasParams = Object.keys(tc.parameters).length > 0;

	let paramsHtml = "";
	if (hasParams) {
		paramsHtml = detailsBlock(
			"Parameters",
			`<pre>${escapeHtml(JSON.stringify(tc.parameters, null, 2))}</pre>`
		);
	}

	return `    <div class="tool-call">
      <div class="tool-call-header">
        <span class="tool-name">${displayName}</span>
        <span class="status-badge ${statusClass}">${escapeHtml(tc.status)}</span>
      </div>
${paramsHtml}
    </div>`;
}

function renderToolResultHtml(msg: Message, subAgentConversations?: SubAgentConversationMap): string {
	const tr: ToolResult | undefined | null = msg.tool_result;
	if (!tr) return "";

	const displayName = escapeHtml(formatToolDisplayName(tr.tool_name));
	const errorClass = tr.success ? "" : " tool-result-error";
	const icon = tr.success ? "✓" : "✗";
	const iconClass = tr.success ? "result-icon-success" : "result-icon-error";

	let resultBody: string;
	if (!tr.success) {
		resultBody = escapeHtml(tr.error ?? "Unknown error");
	} else {
		const resultStr = typeof tr.result === "string"
			? tr.result
			: JSON.stringify(tr.result, null, 2);
		const preview = resultStr.length > 120
			? escapeHtml(resultStr.substring(0, 120)) + "…"
			: escapeHtml(resultStr);
		resultBody = preview;

		if (resultStr.length > 120) {
			resultBody += "\n" + detailsBlock(
				"Full result",
				`<pre>${escapeHtml(resultStr)}</pre>`
			);
		}
	}

	// Phase 6.3: Expandable sub-agent conversation detail
	let subAgentDetail = "";
	if (
		tr.tool_name === USE_SUBAGENT_TOOL_NAME &&
		tr.sub_agent_metadata?.jsonl_filename &&
		subAgentConversations
	) {
		const subMessages = subAgentConversations.get(tr.sub_agent_metadata.jsonl_filename);
		if (subMessages && subMessages.length > 0) {
			subAgentDetail = renderSubAgentDetail(tr.sub_agent_metadata, subMessages);
		}
	}

	return `    <div class="tool-result${errorClass}">
      <div class="tool-result-summary">
        <span class="${iconClass}">${icon}</span> <strong>${displayName}</strong>: ${resultBody}
      </div>
${subAgentDetail}
    </div>`;
}

/**
 * Render an expandable `<details>` section containing the full sub-agent
 * conversation, formatted in the same style as the parent messages.
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 5.3
 */
function renderSubAgentDetail(
	metadata: NonNullable<ToolResult["sub_agent_metadata"]>,
	messages: Message[],
): string {
	const profileLabel = escapeHtml(metadata.profile_name);
	const tokenInfo = `${metadata.token_usage.input.toLocaleString()} in / ${metadata.token_usage.output.toLocaleString()} out`;
	const iterInfo = `${metadata.iteration_count} turn${metadata.iteration_count !== 1 ? "s" : ""}`;
	const capWarning = metadata.stop_reason !== "completed"
		? ` (stopped: ${metadata.stop_reason.replace(/_/g, " ")})`
		: "";
	const summaryText = `Sub-agent: ${profileLabel} — ${iterInfo}, ${tokenInfo}${capWarning}`;

	const renderedMessages = messages
		.map((msg) => renderSubAgentMessage(msg))
		.filter(Boolean)
		.join("\n");

	return detailsBlock(summaryText, `<div class="sub-agent-conversation">\n${renderedMessages}\n</div>`);
}

/**
 * Render a single sub-agent message for the expandable detail section.
 * Simplified version of the parent message renderers.
 */
function renderSubAgentMessage(msg: Message): string | null {
	switch (msg.role) {
		case "system": {
			const sysText = getTextContent(msg.content);
			return `<div class="sub-agent-msg sub-agent-system"><em>System:</em> <pre>${escapeHtml(sysText.substring(0, 200))}${sysText.length > 200 ? "…" : ""}</pre></div>`;
		}
		case "user":
			return `<div class="sub-agent-msg sub-agent-user"><strong>Task:</strong> ${escapeHtml(getTextContent(msg.content))}</div>`;
		case "assistant": {
			const asstText = typeof msg.content === "string"
				? msg.content
				: (() => { throw new Error("Expected string content for assistant message"); })();
			return `<div class="sub-agent-msg sub-agent-assistant"><strong>Assistant:</strong> <div class="message-content">${marked.parse(asstText, { async: false }) as string}</div></div>`;
		}
		case "tool_call": {
			const tc = msg.tool_call;
			if (!tc) return null;
			const displayName = escapeHtml(formatToolDisplayName(tc.tool_name));
			const hasParams = Object.keys(tc.parameters).length > 0;
			const params = hasParams
				? `<pre>${escapeHtml(JSON.stringify(tc.parameters, null, 2))}</pre>`
				: "";
			return `<div class="sub-agent-msg sub-agent-tool-call"><span class="tool-name">${displayName}</span>${params}</div>`;
		}
		case "tool_result": {
			const tr = msg.tool_result;
			if (!tr) return null;
			const displayName = escapeHtml(formatToolDisplayName(tr.tool_name));
			const resultStr = typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result, null, 2);
			const preview = resultStr.length > 200
				? escapeHtml(resultStr.substring(0, 200)) + "…"
				: escapeHtml(resultStr);
			const iconClass = tr.success ? "result-icon-success" : "result-icon-error";
			const icon = tr.success ? "✓" : "✗";
			return `<div class="sub-agent-msg sub-agent-tool-result"><span class="${iconClass}">${icon}</span> <strong>${displayName}</strong>: ${preview}</div>`;
		}
		default:
			assertUnreachable(msg.role);
	}
}

// ─── Utilities ───────────────────────────────────────────────────────────

function messageBlock(role: string, label: string, timestamp: string, body: string): string {
	return `    <div class="message message-${role}">
      <div class="message-role">${label}<span class="message-timestamp">${timestamp}</span></div>
      ${body}
    </div>`;
}

function detailsBlock(summary: string, body: string): string {
	return `<details>
  <summary>${summary}</summary>
  <div class="details-body">${body}</div>
</details>`;
}

function buildTokenInfo(conversation: Conversation): string {
	const parts: string[] = [];
	if (conversation.total_input_tokens || conversation.total_output_tokens) {
		parts.push(
			`Tokens — input: ${conversation.total_input_tokens.toLocaleString()}, ` +
			`output: ${conversation.total_output_tokens.toLocaleString()}`
		);
	}
	if (conversation.estimated_cost != null) {
		parts.push(`Estimated cost: $${conversation.estimated_cost.toFixed(4)}`);
	}
	if (parts.length === 0) return "";
	return `  <footer class="conversation-footer">${parts.join(" &middot; ")}</footer>`;
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function formatTimestamp(iso: string): string {
	return new Date(iso).toLocaleString();
}

// ─── Embedded JSONL data block ──────────────────────────────────────────

/**
 * Build a hidden `<script type="application/jsonl">` block containing the
 * raw conversation data in the same JSONL format used by HistoryManager.
 *
 * This enables re-importing the conversation into another Notor instance.
 * The `type="application/jsonl"` ensures the browser does not execute the
 * script tag — it serves purely as a data container.
 */
function buildJsonlBlock(conversation: Conversation, messages: Message[]): string {
	const lines: string[] = [];

	lines.push(JSON.stringify({ _type: "conversation", ...conversation }));

	for (const msg of messages) {
		lines.push(JSON.stringify({ _type: "message", ...msg }));
	}

	// Escape </ sequences so that </script> in message content
	// does not prematurely close the script tag.
	const escaped = lines.join("\n").replace(/<\//g, "<\\/");

	return `<script type="application/jsonl" id="notor-conversation-data">\n${escaped}\n</script>`;
}
