import { FuzzySuggestModal, MarkdownView, Notice } from "obsidian";
import type { App } from "obsidian";
import type NotorPlugin from "../main";
import type { CircuitRunHandle } from "../circuits/run-registry";
import type { DailyRunRecord } from "../hooks/daily-start/daily-start-state";
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

/** Fuzzy picker over live circuit runs for the Stop circuit command. */
class CircuitRunStopModal extends FuzzySuggestModal<CircuitRunHandle> {
	constructor(
		app: App,
		private readonly runs: CircuitRunHandle[],
		private readonly onChoose: (sessionId: string, flowName: string) => void,
	) {
		super(app);
		this.setPlaceholder("Select a running circuit to stop…");
	}

	getItems(): CircuitRunHandle[] {
		return this.runs;
	}

	getItemText(run: CircuitRunHandle): string {
		return `${run.flowName} (${run.sessionId})`;
	}

	onChooseItem(run: CircuitRunHandle): void {
		this.onChoose(run.sessionId, run.flowName);
	}
}

/** Fuzzy picker over the most recent day's daily-start runs. */
class DailyRunPickerModal extends FuzzySuggestModal<DailyRunRecord> {
	constructor(
		app: App,
		private readonly runs: DailyRunRecord[],
		private readonly onChoose: (record: DailyRunRecord) => void,
	) {
		super(app);
		this.setPlaceholder("Select a daily start run to open…");
	}

	getItems(): DailyRunRecord[] {
		return this.runs;
	}

	getItemText(record: DailyRunRecord): string {
		return `${record.label} (${record.status.replace("_", " ")})`;
	}

	onChooseItem(record: DailyRunRecord): void {
		this.onChoose(record);
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
		id: "open-plan",
		name: "Open plan for current conversation",
		callback: () => {
			void (async () => {
				const conversation = plugin.getActiveOrchestrator()?.getConversationManager().getActiveConversation();
				if (!conversation) {
					new Notice("No active conversation");
					return;
				}
				const plan = await plugin.getPlanStore().load(conversation.id);
				if (!plan) {
					new Notice("This conversation has no plan yet");
					return;
				}
				await plugin.openPlanView(conversation.id);
			})();
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
		id: "toggle-voice-mode",
		name: "Toggle voice mode",
		checkCallback: (checking: boolean) => {
			if (!plugin.getVoiceManager().isAvailable()) return false;
			const orchestrator = plugin.getActiveOrchestrator();
			if (!orchestrator?.getView()) return false;
			if (checking) return true;
			void plugin.getVoiceManager().toggle(orchestrator);
			return true;
		},
	});

	plugin.addCommand({
		id: "voice-stop-speaking",
		name: "Stop speaking (voice mode)",
		checkCallback: (checking: boolean) => {
			const controller = plugin.peekVoiceManager()?.getActiveController() ?? null;
			if (!controller) return false;
			if (checking) return true;
			controller.stopSpeaking();
			return true;
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

	// Run circuit — gated on the circuits feature group (FEAT-011). The command
	// ID keeps its original value so users' hotkeys survive the rename.
	plugin.addCommand({
		id: "run-orchestration",
		name: "Run circuit",
		checkCallback: (checking: boolean) => {
			if (!plugin.settings.circuits_enabled) return false;
			if (checking) return true;
			void import("../circuits/launch").then(({ showCircuitPicker }) =>
				showCircuitPicker(plugin).catch((e) => {
					log.error("Run circuit command failed", { error: String(e) });
					new Notice(`Run circuit failed: ${e instanceof Error ? e.message : String(e)}`);
				}),
			);
			return true;
		},
	});

	// Evaluate circuit sessions — pick a circuit that declares evaluators, then
	// the finished sessions to score. New command, so it has a circuit-native id.
	plugin.addCommand({
		id: "evaluate-circuit-sessions",
		name: "Evaluate circuit sessions",
		checkCallback: (checking: boolean) => {
			if (!plugin.settings.circuits_enabled) return false;
			if (checking) return true;
			void import("../ui/circuit-eval-modals").then(({ showEvaluationPicker }) =>
				showEvaluationPicker(plugin).catch((e) => {
					log.error("Evaluate circuit sessions command failed", { error: String(e) });
					new Notice(`Evaluate circuit sessions failed: ${e instanceof Error ? e.message : String(e)}`);
				}),
			);
			return true;
		},
	});

	// Stop circuit — abort a live circuit run via the run registry (F1 Fix 1).
	// The command ID keeps its original value so users' hotkeys survive the rename.
	// The activity dropdown is the canonical Stop surface; this command is a cheap
	// picker over the currently-live registry entries.
	plugin.addCommand({
		id: "stop-orchestration",
		name: "Stop circuit",
		checkCallback: (checking: boolean) => {
			if (!plugin.settings.circuits_enabled) return false;
			const registry = plugin.getCircuitRunRegistry();
			const live = registry.listActive();
			if (live.length === 0) return false;
			if (checking) return true;
			if (live.length === 1) {
				registry.abort(live[0]!.sessionId);
				new Notice(`Stopping circuit '${live[0]!.flowName}'…`);
				return true;
			}
			new CircuitRunStopModal(plugin.app, live, (sessionId, flowName) => {
				registry.abort(sessionId);
				new Notice(`Stopping circuit '${flowName}'…`);
			}).open();
			return true;
		},
	});

	// on_daily_start: both commands show only when a daily-start target exists.
	plugin.addCommand({
		id: "open-latest-daily-start-run",
		name: "Open most recent daily start run",
		checkCallback: (checking: boolean) => {
			const dailyStart = plugin.getDailyStart();
			if (!dailyStart?.detector.hasTargets()) return false;
			if (checking) return true;
			const runs = dailyStart.detector.recentRuns();
			if (runs.length === 0) {
				new Notice("No daily start run on this device yet.");
			} else if (runs.length === 1) {
				dailyStart.openRecord(runs[0]!);
			} else {
				new DailyRunPickerModal(plugin.app, runs, (record) => dailyStart.openRecord(record)).open();
			}
			return true;
		},
	});

	plugin.addCommand({
		id: "run-daily-start-now",
		name: "Run daily start now",
		checkCallback: (checking: boolean) => {
			const dailyStart = plugin.getDailyStart();
			if (!dailyStart?.detector.hasTargets()) return false;
			if (checking) return true;
			void dailyStart.detector.runNow();
			return true;
		},
	});
}
