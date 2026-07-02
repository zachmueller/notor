/**
 * Orchestration command UI (FEAT-011 / INT-030) — the modal + picker surfaces
 * split out of the former `launch.ts`. This is the ui layer for the orchestration
 * feature: the flow picker + objective prompt behind the "Notor: Run
 * Orchestration" command, the interactive-pause input modal, and the step-jump
 * navigation from a progress Notice.
 *
 * Kept ui→logic: this module imports {@link launchOrchestration} from the
 * run-lifecycle logic layer; the logic modules never import back (the
 * interactive-pause callback is injected into them via `requestOrchestrationInput`).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-011 / INT-030
 * @see specs/ZZ-misc/arch-review-july-2026/F6-launch-ts-decomposition.md
 */

import { FuzzySuggestModal, Modal, Notice, ButtonComponent } from "obsidian";
import type { App } from "obsidian";
import type { OrchestrationHost } from "../orchestration/host";
import { logger } from "../utils/logger";
import { FlowDefinitionParser } from "../orchestration/flow-parser";
import type { OrchestrationFlow } from "../orchestration/types";
import { launchOrchestration } from "../orchestration/run-lifecycle";

const log = logger("OrchestrationLaunch");

/**
 * Open a step conversation by id from a progress-Notice right-click (INT-021 /
 * FR-141). Opens the chat panel if needed, then reuses
 * `ChatOrchestrator.switchToConversationById(...)` — the **same** navigation
 * primitive behind the `notor-conversation://{id}` link and main.ts's
 * `obsidian://notor?id=` handler (no new navigation is introduced, AC-4). A
 * conversation that cannot be resolved surfaces the same "may have been deleted"
 * Notice the protocol handler uses.
 */
export function jumpToStepConversation(host: OrchestrationHost, conversationId: string): void {
	void host.openChatPanel().then(() => {
		const orchestrator = host.getActiveOrchestrator();
		if (!orchestrator) {
			new Notice("No active chat panel");
			return;
		}
		void orchestrator.switchToConversationById(conversationId).then((found) => {
			if (!found) {
				new Notice("Step conversation not found — it may have been deleted");
			}
		});
	});
}

// ---------------------------------------------------------------------------
// Flow picker + objective prompt (the command UI)
// ---------------------------------------------------------------------------

class FlowPickerModal extends FuzzySuggestModal<OrchestrationFlow> {
	constructor(
		app: App,
		private readonly flows: OrchestrationFlow[],
		private readonly onSelect: (flow: OrchestrationFlow) => void,
		private readonly emptyMessage: string,
	) {
		super(app);
		this.setPlaceholder("Select an orchestration flow to run…");
	}

	getItems(): OrchestrationFlow[] {
		return this.flows;
	}

	getItemText(flow: OrchestrationFlow): string {
		return flow.description ? `${flow.name} — ${flow.description}` : flow.name;
	}

	onChooseItem(flow: OrchestrationFlow): void {
		this.onSelect(flow);
	}

	onNoSuggestion(): void {
		if (this.flows.length === 0) {
			this.resultContainerEl.empty();
			const msg = this.resultContainerEl.createDiv({ cls: "notor-orchestration-picker-empty" });
			msg.textContent = this.emptyMessage;
		}
	}
}

class ObjectiveModal extends Modal {
	constructor(
		app: App,
		private readonly flowName: string,
		private readonly onSubmit: (objective: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: `Run "${this.flowName}"` });
		contentEl.createEl("p", {
			text: "Describe the objective for this flow run.",
			cls: "setting-item-description",
		});

		const input = contentEl.createEl("textarea", { cls: "notor-orchestration-objective-input" });
		input.rows = 4;
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.submit(input.value.trim());
			}
		});

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttonRow).setButtonText("Cancel").onClick(() => this.close());
		new ButtonComponent(buttonRow)
			.setButtonText("Run")
			.setCta()
			.onClick(() => this.submit(input.value.trim()));

		setTimeout(() => input.focus(), 10);
	}

	private submit(objective: string): void {
		if (!objective) {
			new Notice("Enter an objective to run the flow.");
			return;
		}
		this.close();
		this.onSubmit(objective);
	}
}

// ---------------------------------------------------------------------------
// Interactive pause prompt (INT-030 / FR-150)
// ---------------------------------------------------------------------------

/**
 * The modal a paused flow surfaces to collect the user's answer. Resolves with
 * the entered text on submit, or `null` when the user dismisses/cancels (which
 * the runner finalizes via `FLOW_CANCELLED`). Resolves exactly once.
 */
class UserInputModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly flowName: string,
		private readonly question: string,
		private readonly resolve: (value: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: `"${this.flowName}" needs your input` });
		contentEl.createEl("p", { text: this.question, cls: "setting-item-description" });

		const input = contentEl.createEl("textarea", { cls: "notor-orchestration-objective-input" });
		input.rows = 4;
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.submit(input.value.trim());
			}
		});

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttonRow).setButtonText("Cancel run").onClick(() => this.close());
		new ButtonComponent(buttonRow)
			.setButtonText("Submit")
			.setCta()
			.onClick(() => this.submit(input.value.trim()));

		setTimeout(() => input.focus(), 10);
	}

	onClose(): void {
		// Dismissed without submitting → the run cancels. (submit() settles first,
		// so a settled modal closing is a no-op.)
		this.settle(null);
	}

	private submit(value: string): void {
		if (!value) {
			new Notice("Enter a response, or cancel the run.");
			return;
		}
		this.settle(value);
		this.close();
	}

	private settle(value: string | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(value);
	}
}

/**
 * Surface the interactive-pause prompt and await the user's answer (INT-030).
 * Wired as the runner's `requestUserInput` callback (injected into the logic
 * layer from the composition site); resolves with the entered text or `null` on
 * dismiss/cancel.
 */
export function requestOrchestrationInput(
	app: App,
	flowName: string,
	question: string,
): Promise<string | null> {
	return new Promise((resolve) => {
		new UserInputModal(app, flowName, question, resolve).open();
	});
}

/**
 * Open the flow picker → objective prompt → launch. Discovers flows via
 * {@link FlowDefinitionParser}. Surfaced by the "Notor: Run Orchestration"
 * command (gated on `orchestration_enabled`).
 */
export async function showOrchestrationPicker(host: OrchestrationHost): Promise<void> {
	const parser = new FlowDefinitionParser(
		host.app.vault,
		host.app.metadataCache,
		host.settings.notor_dir,
	);

	let parsed;
	try {
		parsed = await parser.discoverFlows();
	} catch (e) {
		log.error("Flow discovery failed", { error: String(e) });
		new Notice(`Orchestration discovery failed: ${e instanceof Error ? e.message : String(e)}`);
		return;
	}

	const flows = parsed.map((p) => p.flow);
	const emptyMessage = `No orchestration flows found in ${host.settings.notor_dir.replace(/\/$/, "")}/orchestrations/`;

	new FlowPickerModal(
		host.app,
		flows,
		(flow) => {
			new ObjectiveModal(host.app, flow.name, (objective) => {
				launchOrchestration(host, flow, objective, {
					origin: "user",
					requestUserInput: (flowName, question) =>
						requestOrchestrationInput(host.app, flowName, question),
				}).catch((e) => {
					log.error("Orchestration run failed", { flow: flow.name, error: String(e) });
					new Notice(`Orchestration '${flow.name}' failed: ${e instanceof Error ? e.message : String(e)}`);
				});
			}).open();
		},
		emptyMessage,
	).open();
}
