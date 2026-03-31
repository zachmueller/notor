/**
 * HTML exporter — converts a conversation and its messages to a
 * self-contained HTML document with embedded CSS.
 *
 * The output is portable: no external dependencies, collapsible sections
 * via native `<details>` elements, and a clean, readable design.
 */

import type { Conversation, Message, ToolCall, ToolResult } from "../types";
import { formatToolDisplayName } from "../ui/tool-call-ui";
import { marked } from "marked";

const WORKFLOW_RE = /<workflow_instructions\s+type="([^"]*)">([\s\S]*?)<\/workflow_instructions>/;
const ATTACHMENTS_RE = /<attachments>([\s\S]*?)<\/attachments>/;

/**
 * Export a conversation to a self-contained HTML document.
 */
export function exportToHtml(conversation: Conversation, messages: Message[]): string {
	const title = escapeHtml(conversation.title ?? "Untitled conversation");
	const date = new Date(conversation.created_at).toLocaleString();
	const model = escapeHtml(`${conversation.provider_id} / ${conversation.model_id}`);

	const messageSections = messages
		.map((msg) => renderMessage(msg))
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
</style>`;

// ─── Message rendering ───────────────────────────────────────────────────

function renderMessage(msg: Message): string | null {
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
			return renderToolResultHtml(msg);
		default:
			return null;
	}
}

function renderUserMessage(msg: Message): string {
	const ts = formatTimestamp(msg.timestamp);
	const parts: string[] = [];

	if (msg.is_hook_injection) {
		parts.push(detailsBlock("Hook output", `<pre>${escapeHtml(msg.content)}</pre>`));
		return messageBlock("user", "User", ts, parts.join("\n"));
	}

	let content = msg.content;

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

	return messageBlock("user", "User", ts, parts.join("\n"));
}

function renderAssistantMessage(msg: Message): string {
	const ts = formatTimestamp(msg.timestamp);
	const htmlContent = marked.parse(msg.content, { async: false }) as string;
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

function renderToolResultHtml(msg: Message): string {
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

	return `    <div class="tool-result${errorClass}">
      <div class="tool-result-summary">
        <span class="${iconClass}">${icon}</span> <strong>${displayName}</strong>: ${resultBody}
      </div>
    </div>`;
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
