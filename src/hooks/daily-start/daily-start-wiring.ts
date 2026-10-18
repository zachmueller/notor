/**
 * Builds the `on_daily_start` detector from plugin services and registers
 * the activity signals that drive it. Keeps `main.ts` to a few lines.
 */

import { Notice } from "obsidian";
import type NotorPlugin from "../../main";
import type { Workflow } from "../../types";
import type { Circuit } from "../../circuits/types";
import type { SleepWakeDetector } from "../../utils/sleep-wake-detector";
import { logger } from "../../utils/logger";
import type { HookCircuitLaunchOptions } from "../vault-event-dispatcher";
import type { TriggerDispatchFn } from "../trigger-sources";
import { DailyStartDetector } from "./daily-start-detector";
import { LocalStorageDailyStartState, type DailyRunRecord } from "./daily-start-state";
import { resolveTargetProviders, runPreflight, type PreflightDeps } from "./preflight";
import { DailyStartNotices } from "../../ui/daily-start-notices";

const log = logger("DailyStart");

/** Delay before retrying after the browser reports it is back online. */
const ONLINE_SETTLE_MS = 1_000;

export interface DailyStartWiringOptions {
	dispatchFn: TriggerDispatchFn;
	sleepWakeDetector: SleepWakeDetector;
	getDiscoveredWorkflows: () => Workflow[];
	getDiscoveredCircuits: () => Circuit[];
}

/** The detector plus the plugin-facing helpers built around it. */
export class DailyStart {
	readonly detector: DailyStartDetector;
	private readonly notices: DailyStartNotices;
	private unsubscribeWake: (() => void) | null = null;

	constructor(private readonly plugin: NotorPlugin, opts: DailyStartWiringOptions) {
		this.notices = new DailyStartNotices({
			openRecord: (record) => this.openRecord(record),
			retryNow: () => this.detector.retryNow(),
		});

		const preflightDeps: PreflightDeps = {
			getSettings: () => plugin.settings,
			registry: plugin.getProviderRegistry(),
			getActivePersona: () => plugin.getPersonaManager().getActivePersona(),
			getPersonaByName: (name) => plugin.getPersonaManager().getPersonaByName(name),
			getDiscoveredWorkflows: opts.getDiscoveredWorkflows,
			getDiscoveredCircuits: opts.getDiscoveredCircuits,
		};

		this.detector = new DailyStartDetector({
			getSettings: () => plugin.settings,
			state: new LocalStorageDailyStartState(plugin.app),
			sources: {
				getSettings: () => plugin.settings,
				getDiscoveredWorkflows: opts.getDiscoveredWorkflows,
				getAutomations: (trigger) => plugin.getExtensionManager().getAutomationsForTrigger(trigger),
				getDiscoveredCircuits: opts.getDiscoveredCircuits,
			},
			executors: {
				dispatchFn: opts.dispatchFn,
				executeAutomation: (automation, context) => plugin.getExtensionManager().executeAutomation(automation, context),
				launchCircuit: (circuit, options) => this.launchCircuit(circuit, options),
			},
			preflight: {
				resolveProviders: (target) => resolveTargetProviders(target, preflightDeps),
				run: (ids) => runPreflight(ids, preflightDeps.registry),
			},
			ui: this.notices,
		});

		this.registerActivitySignals(opts.sleepWakeDetector);
	}

	/** Open what a run produced: its conversation, else its circuit run tree. */
	openRecord(record: DailyRunRecord): void {
		const conversationId = this.detector.conversationFor(record);
		if (conversationId) {
			void this.openConversation(conversationId);
		} else if (record.sessionId) {
			void this.plugin.openRunTreeView({ sessionId: record.sessionId });
		} else if (record.error) {
			new Notice(`Daily start: '${record.label}' didn't run: ${record.error}`);
		} else {
			new Notice(`Daily start: '${record.label}' has no conversation yet.`);
		}
	}

	destroy(): void {
		this.unsubscribeWake?.();
		this.unsubscribeWake = null;
		this.detector.destroy();
		this.notices.destroy();
	}

	private registerActivitySignals(sleepWakeDetector: SleepWakeDetector): void {
		const { plugin } = this;
		const note = () => this.detector.noteActivity();

		this.unsubscribeWake = sleepWakeDetector.onWake(note);
		plugin.registerDomEvent(window, "focus", note);
		plugin.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible") note();
		});
		plugin.registerDomEvent(document, "keydown", note);
		plugin.registerDomEvent(document, "pointerdown", note);
		plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", note));
		plugin.registerEvent(plugin.app.workspace.on("editor-change", note));
		plugin.registerDomEvent(window, "online", () => {
			window.setTimeout(() => this.detector.retryNow(), ONLINE_SETTLE_MS);
		});
	}

	private async launchCircuit(circuit: Circuit, options?: HookCircuitLaunchOptions): Promise<void> {
		if (!this.plugin.settings.circuits_enabled) return;
		const { launchCircuit } = await import("../../circuits/launch");
		const { requestCircuitInput } = await import("../../ui/circuit-modals");
		try {
			const result = await launchCircuit(this.plugin, circuit, `Daily start run of circuit '${circuit.name}'.`, {
				origin: "daily_start",
				sessionId: options?.sessionId,
				observer: options?.observer,
				requestUserInput: (flowName, question) => requestCircuitInput(this.plugin.app, flowName, question),
			});
			options?.onSettled?.(result.status, result.status === "error" ? result.text : undefined);
		} catch (e) {
			options?.onSettled?.("error", e instanceof Error ? e.message : String(e));
			throw e;
		}
	}

	/** Same navigation as the `obsidian://notor?id=` handler. */
	private async openConversation(conversationId: string): Promise<void> {
		await this.plugin.openChatPanel();
		const orchestrator = this.plugin.getActiveOrchestrator();
		if (!orchestrator) {
			new Notice("No active chat panel");
			return;
		}
		const found = await orchestrator.switchToConversationById(conversationId);
		if (!found) {
			log.warn("Daily start conversation not found", { conversationId });
			new Notice("Conversation not found — it may have been deleted");
		}
	}
}
