/**
 * `CircuitHost` (F6) — the narrow capability interface the orchestration
 * integration layer depends on, instead of the concrete `NotorPlugin`.
 *
 * `NotorPlugin implements CircuitHost` structurally: every member already
 * exists on the plugin, so the `implements` clause simply makes the compiler
 * enforce that the plugin never drifts away from what launch-wiring /
 * run-lifecycle / child-spawn / recovery-boot need. The one plugin-shaped member
 * is `buildExtensionUtils()`, which wraps `buildUtils(this)` so the whole plugin
 * type does not leak through — narrowing `buildUtils` itself is F5/worker-isolation
 * territory, out of scope here.
 *
 * Precedent for this deps-interface style: `StepTurnExecutorDeps` /
 * `CircuitRunnerDeps` in the core — this extends the same pattern one layer
 * out.
 *
 * @see specs/ZZ-misc/arch-review-july-2026/F6-launch-ts-decomposition.md — §3
 */

import type { App } from "obsidian";
import type { NotorSettings } from "../settings";
import type { ToolRegistry } from "../tools/index";
import type { SystemPromptBuilder } from "../chat/system-prompt";
import type { ProviderRegistry } from "../providers/index";
import type { PersonaManager } from "../personas/persona-manager";
import type { ChatOrchestrator } from "../chat/orchestrator";
import type { FlowRunEntry } from "../workflows/workflow-activity-tracker";
import type { ExtensionUtils } from "../extensions/runtime-context/types";
import type { CircuitRunRegistry } from "./run-registry";
import type { CircuitDataRootName } from "./data-root";
import type { RunApprovalChannel } from "./run-policy";

export interface CircuitHost {
	readonly app: App;
	readonly settings: NotorSettings;
	readonly vaultRootPath: string;
	getToolRegistry(): ToolRegistry;
	getSystemPromptBuilder(): SystemPromptBuilder;
	getProviderRegistry(): ProviderRegistry;
	getPersonaManager(): PersonaManager;
	/** POL-004: upsert a flow-run entry in the unified activity indicator registry. */
	upsertFlowRun(entry: FlowRunEntry): void;
	/** Open (or reveal) a Notor chat panel. */
	openChatPanel(): Promise<void>;
	getActiveOrchestrator(): ChatOrchestrator | null;
	/**
	 * Build the extension `utils` object a code step receives — wraps
	 * `buildUtils(this)` so the host stays plugin-shaped in exactly this one member
	 * rather than leaking the whole `NotorPlugin` type.
	 */
	buildExtensionUtils(): ExtensionUtils;
	/** F1 Fix 1: the in-memory live-run registry (Stop UI / liveness / teardown). */
	getCircuitRunRegistry(): CircuitRunRegistry;
	/**
	 * Which root holds runtime data (sessions/, failures/, memories.md). Optional
	 * so narrow test hosts keep compiling; read through `circuitDataRootOf()`,
	 * which defaults to the legacy `orchestrations` root.
	 */
	getCircuitDataRootName?(): CircuitDataRootName;
	/**
	 * The approval channel for a run with no chat panel (a modal, raced against
	 * the `on_approval_required` hook). Optional so narrow test hosts keep
	 * compiling; without it the dispatcher auto-approves.
	 */
	getRunApproval?(runLabel: string): RunApprovalChannel;
}
