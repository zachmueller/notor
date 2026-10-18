/**
 * Panel-free tool approval (headless circuits, background workflows, and the
 * external API). Without an approval callback the dispatcher auto-approves every
 * call that policy leaves for a human — including `never` path rules and blocked
 * command patterns — so runs with no chat panel route those prompts here.
 *
 * Prompts are queued and shown one at a time (parallel tool batches would
 * otherwise stack modals). Dismissing a modal rejects the call. When the
 * dispatcher's race settles another way (approval timeout, an
 * `on_approval_required` hook, or a run abort), the signal fires and the modal
 * closes itself.
 */

import { ButtonComponent, Modal } from "obsidian";
import type { App } from "obsidian";
import type { ApprovalCallback } from "../chat/dispatcher";
import type { NotorSettings } from "../settings/types";
import type { ToolCall } from "../types";
import { focusObsidianWindow, showOsNotification } from "./os-notification";

/** Maximum characters of parameter JSON shown in the modal. */
const PARAM_PREVIEW_CHARS = 1500;

type Decision = "approved" | "rejected";

class ToolApprovalModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly runLabel: string,
		private readonly toolCall: ToolCall,
		private readonly resolve: (decision: Decision) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Approve tool call" });
		contentEl.createEl("p", {
			text: `${this.runLabel} wants to run ${this.toolCall.tool_name}.`,
			cls: "setting-item-description",
		});
		contentEl.createEl("pre", {
			text: formatParams(this.toolCall.parameters),
			cls: "notor-tool-approval-params",
		});

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttonRow).setButtonText("Reject").onClick(() => this.decide("rejected"));
		new ButtonComponent(buttonRow)
			.setButtonText("Approve")
			.setCta()
			.onClick(() => this.decide("approved"));
	}

	onClose(): void {
		this.contentEl.empty();
		this.settle("rejected");
	}

	/** Close from outside (the race settled elsewhere) without a decision of our own. */
	dismiss(): void {
		this.settle("rejected");
		this.close();
	}

	private decide(decision: Decision): void {
		this.settle(decision);
		this.close();
	}

	private settle(decision: Decision): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(decision);
	}
}

function formatParams(params: Record<string, unknown> | undefined): string {
	let json: string;
	try {
		json = JSON.stringify(params ?? {}, null, 2);
	} catch {
		json = Object.keys(params ?? {}).join(", ");
	}
	return json.length > PARAM_PREVIEW_CHARS ? `${json.slice(0, PARAM_PREVIEW_CHARS)}\n…` : json;
}

/** Global FIFO so prompts from concurrent runs never stack. */
let queueTail: Promise<void> = Promise.resolve();

/**
 * Build an {@link ApprovalCallback} that asks the user through a modal.
 *
 * @param runLabel - Who is asking, e.g. `Circuit 'Meeting wrap-up'`.
 * @param settings - When given, an OS notification announces each prompt
 *   (subject to the user's notification settings).
 */
export function createModalApprovalCallback(
	app: App,
	runLabel: string,
	settings?: NotorSettings,
): ApprovalCallback {
	return (toolCall, abortSignal, _messageId, autoApproved) => {
		// Fire-and-forget render of an auto-approved call: nothing to show.
		if (autoApproved) return Promise.resolve("approved");
		if (abortSignal?.aborted) return Promise.resolve("rejected");

		return new Promise<Decision>((resolve) => {
			queueTail = queueTail.then(() => new Promise<void>((next) => {
				// Aborted while queued (timeout / hook / run cancel): skip the modal.
				if (abortSignal?.aborted) {
					resolve("rejected");
					next();
					return;
				}
				const finish = (decision: Decision) => {
					abortSignal?.removeEventListener("abort", onAbort);
					resolve(decision);
					next();
				};
				const modal = new ToolApprovalModal(app, runLabel, toolCall, finish);
				const onAbort = () => modal.dismiss();
				abortSignal?.addEventListener("abort", onAbort, { once: true });
				modal.open();
				if (settings) {
					showOsNotification(settings, {
						kind: "approval_required",
						title: "Notor — Approval needed",
						body: `${runLabel}: ${toolCall.tool_name}`,
						onClick: focusObsidianWindow,
					});
				}
			}));
		});
	};
}
