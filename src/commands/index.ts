import { FuzzySuggestModal, MarkdownView, Notice } from "obsidian";
import type { App } from "obsidian";
import type NotorPlugin from "../main";
import type { OrchestrationRunHandle } from "../orchestration/run-registry";
import { NotorChatView } from "../ui/chat-view";
import {
	showWorkflowPicker,
	showActiveNoteWorkflowPicker,
	buildActiveNoteContent,
	resolveActiveNotePrompt,
} from "../workflows/workflow-executor";
import { getLastActiveFilePath } from "../context/auto-context";
import { extractJsonlFromHtml, reassignIds } from "../export/html-importer";
import { openPersonaPickerModal } from "../ui/persona-picker-modal";
import { MemoryApprovalModal } from "../ui/memory-approval-modal";
import { logger } from "../utils/logger";

const log = logger("Commands");

/** Fuzzy picker over live orchestration runs for the Stop Orchestration command. */
class OrchestrationRunStopModal extends FuzzySuggestModal<OrchestrationRunHandle> {
	constructor(
		app: App,
		private readonly runs: OrchestrationRunHandle[],
		private readonly onChoose: (sessionId: string, flowName: string) => void,
	) {
		super(app);
		this.setPlaceholder("Select a running orchestration flow to stop…");
	}

	getItems(): OrchestrationRunHandle[] {
		return this.runs;
	}

	getItemText(run: OrchestrationRunHandle): string {
		return `${run.flowName} (${run.sessionId})`;
	}

	onChooseItem(run: OrchestrationRunHandle): void {
		this.onChoose(run.sessionId, run.flowName);
	}
}

export function registerCommands(plugin: NotorPlugin): void {
	plugin.addCommand({
		id: "open-chat-panel",
		name: "Open chat panel",
		callback: () => plugin.openChatPanel(),
	});

	plugin.addCommand({
		id: "new-conversation",
		name: "New conversation",
		callback: () => plugin.newConversation(),
	});

	plugin.addCommand({
		id: "compact-context",
		name: "Compact context",
		callback: () => {
			const orchestrator = plugin.getActiveOrchestrator();
			if (!orchestrator) {
				new Notice("No active chat panel");
				return;
			}
			orchestrator.manualCompaction().catch((e) => {
				log.error("Manual compaction failed", { error: String(e) });
				new Notice(`Compaction failed: ${e instanceof Error ? e.message : String(e)}`);
			});
		},
	});

	plugin.addCommand({
		id: "open-tool-config-inspector",
		name: "Open tool config inspector",
		callback: () => plugin.openInspector(),
	});

	plugin.addCommand({
		id: "run-workflow",
		name: "Run workflow",
		callback: () => {
			try {
				showWorkflowPicker(
					plugin.app,
					() => plugin.rescanWorkflows(),
					(workflow) => {
						plugin.openChatPanel().then(() => {
							log.info("Workflow selected from command palette", {
								display_name: workflow.display_name,
								file_path: workflow.file_path,
							});
							const orchestrator = plugin.getActiveOrchestrator();
							if (!orchestrator) {
								new Notice("No active chat panel");
								return;
							}
							return orchestrator.executeWorkflow(workflow);
						}).catch((e) => {
							log.error("Failed to execute workflow from command palette", {
								error: String(e),
							});
							new Notice(`Workflow execution failed: ${e instanceof Error ? e.message : String(e)}`);
						});
					},
					plugin.settings.notor_dir
				);
			} catch (e) {
				log.error("Run workflow command failed", { error: String(e) });
				new Notice(`Failed to open workflow picker: ${e instanceof Error ? e.message : String(e)}`);
			}
		},
	});

	plugin.addCommand({
		id: "launch-active-note-workflow",
		name: "Launch active note workflow",
		callback: () => {
			try {
				const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
				let activeFilePath = activeView?.file?.path ?? null;
				if (!activeFilePath) {
					const cached = getLastActiveFilePath();
					if (cached?.endsWith(".md")) {
						activeFilePath = cached;
					}
				}
				if (!activeFilePath) {
					new Notice("No active note found.");
					return;
				}

				const capturedPath = activeFilePath;

				showActiveNoteWorkflowPicker(
					plugin.app,
					() => plugin.rescanWorkflows(),
					(workflow) => {
						(async () => {
							const activeNoteContent = await buildActiveNoteContent(
								capturedPath,
								plugin.app.vault,
							);
							const resolvedPrompt = resolveActiveNotePrompt(
								workflow.active_note_prompt!,
								activeNoteContent,
							);

							await plugin.openChatPanel();
							log.info("Active note workflow selected", {
								display_name: workflow.display_name,
								active_note: capturedPath,
							});
							const orchestrator = plugin.getActiveOrchestrator();
							if (!orchestrator) {
								new Notice("No active chat panel");
								return;
							}
							await orchestrator.executeWorkflow(workflow, resolvedPrompt);
						})().catch((e) => {
							log.error("Failed to execute active note workflow", {
								error: String(e),
							});
							new Notice(
								`Active note workflow failed: ${e instanceof Error ? e.message : String(e)}`
							);
						});
					},
					plugin.settings.notor_dir
				);
			} catch (e) {
				log.error("Launch active note workflow command failed", { error: String(e) });
				new Notice(
					`Failed to open active note workflow picker: ${e instanceof Error ? e.message : String(e)}`
				);
			}
		},
	});

	plugin.addCommand({
		id: "export-conversation",
		name: "Export conversation",
		callback: () => {
			try {
				const orchestrator = plugin.getActiveOrchestrator();
				if (!orchestrator) {
					new Notice("No active chat panel");
					return;
				}
				const convManager = orchestrator.getConversationManager();
				const conversation = convManager.getActiveConversation();
				const messages = convManager.getMessages();
				if (!conversation) {
					new Notice("No active conversation to export");
					return;
				}
				plugin.showExportModal(conversation, messages);
			} catch (e) {
				log.error("Export conversation command failed", { error: String(e) });
				new Notice(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		},
	});

	plugin.addCommand({
		id: "import-conversation",
		name: "Import conversation from HTML",
		callback: () => {
			const input = document.createElement("input");
			input.type = "file";
			input.accept = ".html";
			input.addClass("notor-hidden");
			document.body.appendChild(input);

			input.addEventListener("change", () => {
				const file = input.files?.[0];
				if (!file) {
					input.remove();
					return;
				}

				const reader = new FileReader();
				reader.onload = async () => {
					try {
						const htmlContent = reader.result as string;
						const extracted = extractJsonlFromHtml(htmlContent);
						if (!extracted) {
							new Notice("This HTML file does not contain embedded conversation data");
							return;
						}
						const { conversation, messages } = reassignIds(
							extracted.conversation,
							extracted.messages
						);
						const filename = await plugin.getHistoryManager().importConversation(conversation, messages);
						const orchestrator = plugin.getActiveOrchestrator();
						if (orchestrator) {
							await orchestrator.switchConversation(filename);
						}
						new Notice(`Imported conversation: ${conversation.title ?? "Untitled"}`);
					} catch (e) {
						log.error("Import conversation command failed", { error: String(e) });
						new Notice(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
					} finally {
						input.remove();
					}
				};
				reader.onerror = () => {
					log.error("Failed to read imported file", { error: reader.error?.message ?? "unknown error" });
					new Notice("Failed to read selected file");
					input.remove();
				};
				reader.readAsText(file);
			});

			input.click();
		},
	});

	plugin.addCommand({
		id: "open-secondary-chat",
		name: "Open new chat panel",
		callback: () => {
			plugin.openChatInNewTab(undefined, true);
		},
	});

	plugin.addCommand({
		id: "btw-side-conversation",
		name: "/btw — open side conversation in new panel",
		callback: () => {
			const orch = plugin.getLastFocusedOrchestrator();
			if (!orch) return;
			const messages = orch.getConversationManager().getMessages();
			const lastId = messages[messages.length - 1]?.id;
			if (!lastId) return;
			orch.forkConversation(lastId).then((result) => {
				if (!result) return;
				plugin.openChatInNewTab(result.filename);
				new Notice(`Side conversation: ${result.conversation.title}`);
			}).catch((e) => {
				log.error("Failed to create side conversation", { error: String(e) });
			});
		},
	});

	plugin.addCommand({
		id: "reload-extensions",
		name: "Reload user extensions",
		callback: () => {
			plugin.getExtensionManager().reload(false).then((result) => {
				const summary =
					`Extensions reloaded: ${result.toolCount} tool${result.toolCount !== 1 ? "s" : ""}, ` +
					`${result.automationCount} automation${result.automationCount !== 1 ? "s" : ""}, ` +
					`${result.blockCount} block kind${result.blockCount !== 1 ? "s" : ""}` +
					(result.errors.length > 0 ? ` (${result.errors.length} error${result.errors.length !== 1 ? "s" : ""})` : "");
				new Notice(summary);
			}).catch((e) => {
				log.error("Extension reload failed", { error: String(e) });
				new Notice(`Extension reload failed: ${e instanceof Error ? e.message : String(e)}`);
			});
		},
	});

	plugin.addCommand({
		id: "switch-persona",
		name: "Switch persona",
		checkCallback: (checking: boolean) => {
			const activeView = plugin.app.workspace.getActiveViewOfType(NotorChatView);
			if (!activeView) return false;
			if (checking) return true;

			const personaManager = plugin.getPersonaManager();
			void openPersonaPickerModal(plugin.app, personaManager, (selected) => {
				if (selected) {
					activeView.applyPersonaSwitch(selected);
				} else {
					activeView.applyPersonaSwitch(null);
				}
			});
			return true;
		},
	});

	plugin.addCommand({
		id: "find-in-messages",
		name: "Find in messages",
		checkCallback: (checking: boolean) => {
			const activeView = plugin.app.workspace.getActiveViewOfType(NotorChatView);
			if (!activeView) return false;
			if (checking) return true;
			activeView.openFindBar();
			return true;
		},
	});

	plugin.addCommand({
		id: "open-memory-approval",
		name: "Open memory approval panel",
		checkCallback: (checking: boolean) => {
			if (!plugin.settings.memory_enabled) return false;
			if (plugin.settings.memory_approval_mode === "auto") return false;
			if (checking) return true;
			const manager = plugin.getPendingMemoryManager();
			if (!manager) return false;
			new MemoryApprovalModal(plugin.app, manager).open();
			return true;
		},
	});

	// Run Orchestration — gated on the orchestration feature group (FEAT-011).
	plugin.addCommand({
		id: "run-orchestration",
		name: "Run orchestration",
		checkCallback: (checking: boolean) => {
			if (!plugin.settings.orchestration_enabled) return false;
			if (checking) return true;
			void import("../orchestration/launch").then(({ showOrchestrationPicker }) =>
				showOrchestrationPicker(plugin).catch((e) => {
					log.error("Run Orchestration command failed", { error: String(e) });
					new Notice(`Run Orchestration failed: ${e instanceof Error ? e.message : String(e)}`);
				}),
			);
			return true;
		},
	});

	// Stop Orchestration — abort a live flow run via the run registry (F1 Fix 1).
	// The activity dropdown is the canonical Stop surface; this command is a cheap
	// picker over the currently-live registry entries.
	plugin.addCommand({
		id: "stop-orchestration",
		name: "Stop orchestration",
		checkCallback: (checking: boolean) => {
			if (!plugin.settings.orchestration_enabled) return false;
			const registry = plugin.getOrchestrationRunRegistry();
			const live = registry.listActive();
			if (live.length === 0) return false;
			if (checking) return true;
			if (live.length === 1) {
				registry.abort(live[0]!.sessionId);
				new Notice(`Stopping orchestration '${live[0]!.flowName}'…`);
				return true;
			}
			new OrchestrationRunStopModal(plugin.app, live, (sessionId, flowName) => {
				registry.abort(sessionId);
				new Notice(`Stopping orchestration '${flowName}'…`);
			}).open();
			return true;
		},
	});
}
