/**
 * Validation and normalization of external-API call options, shared by the
 * circuit, workflow, and tool runners.
 */

import { Notice } from "obsidian";
import type { ApprovalOverride } from "../chat/tool-policy";
import type { ChatOrchestrator } from "../chat/orchestrator";
import type { ConversationMode } from "../types";
import type { NotorApiHost } from "./host";
import {
	NotorApiError,
	type NotorApproval,
	type NotorDisplay,
	type NotorResultDetail,
	type NotorRunInfo,
} from "./types";

const DEFAULT_INCLUDE: NotorResultDetail[] = ["conversation", "text", "cost"];

/** Validate a `mode` option (undefined = caller's default applies). */
export function resolveMode(mode: unknown): ConversationMode | undefined {
	if (mode === undefined) return undefined;
	if (mode === "plan" || mode === "act") return mode;
	throw new NotorApiError("invalid_option", `mode must be "plan" or "act", not ${JSON.stringify(mode)}.`);
}

/**
 * Turn an `approval` option into a policy override. `"auto"` needs the
 * user's opt-in and announces itself with a Notice.
 */
export function resolveApproval(
	host: NotorApiHost,
	approval: NotorApproval | undefined,
	runLabel: string,
): ApprovalOverride | undefined {
	switch (approval) {
		case undefined:
		case "inherit":
			return undefined;
		case "prompt":
			return "prompt";
		case "auto":
			if (!host.settings.external_api_allow_auto_approve) {
				throw new NotorApiError(
					"auto_approve_not_allowed",
					"approval: \"auto\" requires Settings → Notor → Automation → External API → Allow scripts to auto-approve.",
				);
			}
			new Notice(`${runLabel} was started by a script and is auto-approving tool calls.`);
			return "auto";
		default:
			throw new NotorApiError(
				"invalid_option",
				`approval must be "inherit", "auto", or "prompt", not ${JSON.stringify(approval)}.`,
			);
	}
}

/** Validate a `display` option (default `"headless"`). */
export function resolveDisplay(display: unknown): NotorDisplay {
	if (display === undefined) return "headless";
	if (display === "headless" || display === "main" || display === "new-panel") return display;
	throw new NotorApiError(
		"invalid_option",
		`display must be "headless", "main", or "new-panel", not ${JSON.stringify(display)}.`,
	);
}

/**
 * Open the chat panel a visible run targets. The main panel must be idle so the
 * run never interrupts a conversation in progress.
 */
export async function openTargetPanel(
	host: NotorApiHost,
	display: Exclude<NotorDisplay, "headless">,
): Promise<ChatOrchestrator> {
	const orchestrator = display === "main"
		? await host.openMainChatOrchestrator()
		: await host.openChatTabOrchestrator();
	if (!orchestrator) {
		throw new NotorApiError("panel_unavailable", "Couldn't open a Notor chat panel.");
	}
	if (display === "main" && orchestrator.getActiveSessions().length > 0) {
		throw new NotorApiError(
			"panel_busy",
			"The main Notor chat panel is responding. Wait for it to finish, or use display: \"new-panel\".",
		);
	}
	return orchestrator;
}

/** Drop result fields the caller didn't ask for. */
export function applyInclude<T extends Partial<NotorRunInfo>>(info: T, include: NotorResultDetail[] | undefined): T {
	const want = new Set(include ?? DEFAULT_INCLUDE);
	const out = { ...info };
	if (!want.has("conversation")) delete out.conversationId;
	if (!want.has("text")) {
		delete out.text;
		delete out.structured;
	}
	if (!want.has("cost")) delete out.costUsd;
	if (!want.has("notes")) {
		delete out.notesRead;
		delete out.notesEdited;
	}
	return out;
}

/** Link a caller's optional signal to a run-owned controller. */
export function linkSignal(controller: AbortController, signal: AbortSignal | undefined): void {
	if (!signal) return;
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", () => controller.abort(), { once: true });
}
