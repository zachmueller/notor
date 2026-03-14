/**
 * Tool call transparency UI — renders tool calls inline in the chat thread.
 *
 * Displays tool name, status, parameters (collapsed by default), and result
 * (collapsed for long results). Provides expand/collapse interaction.
 *
 * This component is used by NotorChatView to render tool_call and tool_result
 * messages inline in the conversation flow.
 *
 * @see specs/01-mvp/spec.md — FR-16 (tool call transparency)
 * @see design/ux.md — tool call display
 */

import type { ToolCall, ToolResult } from "../types";
import { isMcpTool, parseMcpToolName } from "../mcp/mcp-tool-adapter";

/**
 * Format a tool name for human-readable display.
 *
 * MCP tools use the internal `server__tool` naming convention but should
 * be displayed as `server/tool` in the UI for readability (FR-62, FEAT-005).
 * Built-in tool names are returned unchanged.
 *
 * @param toolName - The internal tool name (e.g., `my-db-server__query`)
 * @returns Human-readable display name (e.g., `my-db-server/query`)
 *
 * @see specs/04-mcp/tasks.md — FEAT-005
 */
export function formatToolDisplayName(toolName: string): string {
	if (isMcpTool(toolName)) {
		const { serverName, toolName: rawName } = parseMcpToolName(toolName);
		return `${serverName}/${rawName}`;
	}
	return toolName;
}

/**
 * Renders a tool call card inline in the chat thread.
 *
 * @param container - Parent element to append the tool call card into
 * @param toolCall - The tool call data to render
 * @returns The created tool call element (can be updated later with updateStatus)
 */
export function renderToolCallCard(
	container: HTMLElement,
	toolCall: ToolCall
): HTMLElement {
	const toolEl = container.createDiv({ cls: "notor-tool-call" });

	// Header row: tool name + status badge
	const headerEl = toolEl.createDiv({ cls: "notor-tool-call-header" });

	const nameEl = headerEl.createSpan({ cls: "notor-tool-call-name" });
	// FEAT-005: Display MCP tools as "server/tool" for human readability.
	// The LLM and registry use "server__tool" internally; the UI shows "server/tool".
	nameEl.textContent = formatToolDisplayName(toolCall.tool_name);

	const statusEl = headerEl.createSpan({
		cls: `notor-tool-call-status notor-tool-status-${toolCall.status}`,
	});
	statusEl.textContent = toolCall.status;

	// Collapsible parameters section (collapsed by default)
	const hasParams = Object.keys(toolCall.parameters).length > 0;
	if (hasParams) {
		const paramsToggle = toolEl.createDiv({ cls: "notor-tool-call-toggle" });
		paramsToggle.textContent = "▶ Parameters";

		const paramsEl = toolEl.createDiv({ cls: "notor-tool-call-params notor-hidden" });
		const pre = paramsEl.createEl("pre");
		pre.createEl("code", { text: JSON.stringify(toolCall.parameters, null, 2) });

		paramsToggle.addEventListener("click", () => {
			const isHidden = paramsEl.hasClass("notor-hidden");
			paramsEl.toggleClass("notor-hidden", !isHidden);
			paramsToggle.textContent = isHidden ? "▼ Parameters" : "▶ Parameters";
		});
	}

	return toolEl;
}

/**
 * Update the status badge on an existing tool call card.
 *
 * @param toolEl - The tool call card element returned by renderToolCallCard
 * @param status - New status to display
 */
export function updateToolCallStatus(
	toolEl: HTMLElement,
	status: ToolCall["status"]
): void {
	const statusEl = toolEl.querySelector(".notor-tool-call-status");
	if (!statusEl) return;

	// Remove all status classes and add the new one
	statusEl.className = `notor-tool-call-status notor-tool-status-${status}`;
	statusEl.textContent = status;
}

/**
 * Renders a tool result summary below its tool call card (or standalone).
 *
 * @param container - Parent element to append the result into
 * @param toolResult - The tool result data to render
 */
export function renderToolResultSummary(
	container: HTMLElement,
	toolResult: ToolResult
): void {
	const resultEl = container.createDiv({ cls: "notor-tool-result" });

	// Summary line: ✓ or ✗ with brief output
	const summaryEl = resultEl.createDiv({ cls: "notor-tool-result-summary" });

	if (toolResult.success) {
		summaryEl.addClass("notor-tool-result-success");
		const resultStr =
			typeof toolResult.result === "string"
				? toolResult.result
				: JSON.stringify(toolResult.result);
		const preview = resultStr.length > 120
			? resultStr.substring(0, 120) + "…"
			: resultStr;
		summaryEl.textContent = `✓ ${preview}`;

		// Collapsible full result for longer outputs
		if (resultStr.length > 120) {
			const toggle = resultEl.createDiv({ cls: "notor-tool-call-toggle" });
			toggle.textContent = "▶ Full result";

			const fullEl = resultEl.createDiv({ cls: "notor-tool-result-full notor-hidden" });
			const pre = fullEl.createEl("pre");
			pre.createEl("code", {
				text: typeof toolResult.result === "string"
					? toolResult.result
					: JSON.stringify(toolResult.result, null, 2),
			});

			toggle.addEventListener("click", () => {
				const isHidden = fullEl.hasClass("notor-hidden");
				fullEl.toggleClass("notor-hidden", !isHidden);
				toggle.textContent = isHidden ? "▼ Full result" : "▶ Full result";
			});
		}
	} else {
		summaryEl.addClass("notor-tool-result-error");
		summaryEl.textContent = `✗ ${toolResult.error ?? "Unknown error"}`;
	}
}