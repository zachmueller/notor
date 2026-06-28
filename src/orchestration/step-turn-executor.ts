/**
 * `StepTurnExecutor` (FEAT-007) — runs one conversation step turn.
 *
 * Runs on the shared **`RunLoop`** (`src/run-loop/`, ARCH-002), NOT
 * `ChatOrchestrator.responseLoop()` (which carries persistence / compaction /
 * view rendering orchestration does not want). Per turn it:
 *
 *  1. writes `turn.start` to the session log (FEAT-006) **before** any LLM call;
 *  2. resolves the step's persona via `PersonaManager.getPersonaByName()`
 *     **without** mutating global state (never `activatePersona()`);
 *  3. resolves provider/model via the **pure** `resolvePersonaProviderConfig(...)`
 *     (ARCH-007) — never the global-mutating `applyProviderModelOverrides()` — and
 *     **pins** it into the step's `RunLoop` (`modelId` → `RunLoopOptions.model`),
 *     so concurrent step turns never race on model selection;
 *  4. asks `StepPromptBuilder` (FEAT-005) to assemble the prompt;
 *  5. constructs a **fresh per-turn `OrchestrationToolContext`** and runs the turn
 *     on `RunLoop`, attaching the `onPersist`/progress hooks;
 *  6. after the turn, reads `orchestrationContext.pendingEmission` (FEAT-009);
 *  7. if no emission was captured, **synthesizes** `default_publishes` when the
 *     turn ended `completed`, or **`{step}.capped`** (carrying `stopReason`) when
 *     the turn ended non-`completed` (FR-117a) — a cut-off turn never
 *     masquerades as success;
 *  8. writes `turn.complete` carrying the per-turn `cost_usd` + `token_usage`
 *     (Issue-5);
 *  9. returns the captured/synthesized event for the runner to route.
 *
 * The **code-step** path (`notor-step-mode: code`) is dispatched through a seam
 * reserved for Phase 3 (INT-010); FEAT-007 handles the conversation path.
 *
 * The heavyweight chat-integration assembly (per-step dispatcher, filtered tool
 * definitions, persona-composed system prompt, MCP filtering) is injected via
 * {@link StepRuntimeFactory} so this component stays free of `ChatOrchestrator`
 * and unit-testable; the command (FEAT-011) wires a real factory from the plugin.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-007
 * @see specs/ZZ-misc/orchestration/contracts/run-loop.md
 */

import type { ChatMessage, LLMProvider, ToolDefinition } from "../providers/provider";
import type { ToolDispatcher } from "../chat/dispatcher";
import type { ConversationMode, Persona } from "../types";
import type { NotorSettings } from "../settings/types";
import type { ProviderRegistry } from "../providers/index";
import type {
	OrchestrationToolContext,
	ResolvedProviderConfig,
	RunContext,
	RunLoopHooks,
} from "../run-loop/types";
import { RunLoop } from "../run-loop/run-loop";
import { resolvePersonaProviderConfig } from "../personas/provider-config-resolver";
import { logger } from "../utils/logger";
import type { SessionLog } from "./session-log";
import type { StepPromptBuilder } from "./step-prompt-builder";
import type { StepConversationStore } from "./step-conversation-store";
import type { CodeStepExecutor } from "./code-step-executor";
import type { OrchestrationEvent, OrchestrationFlow, StepDefinition } from "./types";

const log = logger("StepTurnExecutor");

/**
 * The per-step runtime the heavy chat stack assembles for a resolved persona:
 * the filtered tool definitions, the persona-composed system prompt, the
 * dispatcher (with effective tool config, vault root, approval/interaction
 * callbacks), and the resolved provider instance. Injected so the executor stays
 * free of `ChatOrchestrator` internals.
 */
export interface StepRuntime {
	provider: LLMProvider;
	dispatcher: ToolDispatcher;
	toolDefinitions: ToolDefinition[];
	systemPrompt: string;
}

/** Builds the per-step {@link StepRuntime} from a resolved persona + provider/model. */
export interface StepRuntimeFactory {
	build(args: {
		step: StepDefinition;
		persona: Persona | null;
		resolved: ResolvedProviderConfig;
		mode: ConversationMode;
		orchestrationContext: OrchestrationToolContext;
		abortSignal: AbortSignal;
	}): Promise<StepRuntime>;
}

/** Resolves `<include_note>` tags in a step body (reuses the existing path). */
export type IncludeResolver = (body: string, notePath: string) => Promise<string>;

/**
 * The per-turn progress-Notice synthesis seam (INT-020 / FR-140). Invoked after a
 * **conversation-step** turn writes `turn.complete` and persists its step
 * conversation, carrying flow + step + iteration + the emitted topic, plus the
 * step conversation's id for the desktop right-click jump (INT-021 / FR-141).
 *
 * Injected (not open-coded) so `StepTurnExecutor` stays free of `obsidian`'s
 * `Notice` and of `ChatOrchestrator` — the runtime wiring (`launch.ts`) supplies
 * a callback that builds the Notice via `showOrchestrationProgressNotice(...)`
 * and closes the jump over `switchToConversationById(conversationId)`. Omitted in
 * unit tests → no Notice (the engine's routing is unaffected). Mirrors the
 * `notifyError` injection the code-step path already uses.
 */
export interface StepProgressNotifier {
	(args: {
		flowName: string;
		stepName: string;
		/** The flow hop/step-turn counter (includes code steps). */
		iteration: number;
		/** The topic this turn emitted (or the synthesized default). */
		emittedTopic: string;
		/** The step conversation's id (target of the INT-021 right-click jump). */
		conversationId: string;
	}): void;
}

export interface StepTurnExecutorDeps {
	personaManager: { getPersonaByName(name: string): Promise<Persona | null> };
	providerRegistry: ProviderRegistry;
	settings: NotorSettings;
	promptBuilder: StepPromptBuilder;
	runtimeFactory: StepRuntimeFactory;
	/** Optional include-note resolution (omitted in unit tests → body embedded verbatim). */
	resolveIncludes?: IncludeResolver;
	/** Per-run iteration cap for a step turn (default `SUB_AGENT_ITERATION_CAP`). */
	iterationCap?: number;
	/**
	 * Vault-relative path to the persistent `memories.md` note (INT-004 / FR-124),
	 * injected into every step prompt's `### MEMORY` section. Omitted in unit
	 * tests → the section is skipped.
	 */
	memoriesPath?: string;
	/**
	 * Persists each conversation-step turn as a hidden step conversation with its
	 * `orchestration_edges` header, backfilling the `next`/`prev` chain (INT-006).
	 * Omitted in unit tests → step conversations are not written (the engine's
	 * routing is unaffected).
	 */
	stepConversationStore?: StepConversationStore;
	/** Provider/model labels for the persisted step-conversation header (INT-006). */
	providerLabel?: { providerId: string; modelId: string };
	/**
	 * The deterministic code-step executor (Phase 3, INT-010). When a step has
	 * `notor-step-mode: code` this executor runs its code fence instead of the
	 * conversation path. Omitted in Phase-1 unit tests → a `code` step falls back
	 * to the inert default-emission seam (a Phase-1 flow with an accidental code
	 * step never silently stalls).
	 */
	codeStepExecutor?: CodeStepExecutor;
	/**
	 * Per-turn progress-Notice synthesizer (INT-020 / INT-021). Called after a
	 * conversation-step turn writes `turn.complete` + persists its step
	 * conversation. Omitted in unit tests → no Notice; a code step never calls it
	 * (it runs no `RunLoop` turn — see {@link executeCodeStep}, AC-5).
	 */
	showProgressNotice?: StepProgressNotifier;
}

/** Inputs the runner threads into a single step-turn execution. */
export interface StepTurnRequest {
	step: StepDefinition;
	flow: OrchestrationFlow;
	/** The incoming trigger event. */
	event: OrchestrationEvent;
	/** Recent event history (for the prompt scaffold). */
	eventHistory: OrchestrationEvent[];
	/** The original user objective (injected every turn). */
	objective: string;
	/** Engine hop/turn counter. */
	iteration: number;
	/** The per-step orchestration session carriage (fresh per turn). */
	orchestrationContext: OrchestrationToolContext;
	/** The shared run context (depth + shared budget cell + fresh subtreeConsumed). */
	runContext: RunContext;
	mode: ConversationMode;
	/** The conversation id assigned to this turn (for the log + persistence). */
	conversationId: string;
	/** Optional persistence hook (JSONL) — attached without baking into the engine. */
	onPersist?: RunLoopHooks["onPersist"];
	/** Optional progress callback. */
	onProgress?: (status: string) => void;
}

/** What the executor returns to the runner. */
export interface StepTurnResult {
	/** The captured or synthesized next event (topic + payload), ready to publish. */
	emission: { topic: string; payload: string; structured?: unknown };
	/** Why the underlying run stopped. */
	stopReason: string;
	/** Per-turn cost (Issue-5; recorded on `turn.complete`). */
	costUsd: number;
	/** Per-turn token usage (Issue-5). */
	tokenUsage: { input: number; output: number };
}

export class StepTurnExecutor {
	/**
	 * The id of the most recently persisted step conversation in this run — the
	 * `prev` target for the next turn's step conversation (INT-006 edge backfill).
	 * Reset only by constructing a new executor (one per run).
	 */
	private lastStepConversationId: string | null = null;

	constructor(
		private readonly deps: StepTurnExecutorDeps,
		private readonly sessionLog: SessionLog,
	) {}

	/**
	 * Execute one step turn. The code-step path is dispatched through the
	 * Phase-3 seam ({@link executeCodeStep}); the conversation path runs on
	 * `RunLoop`.
	 */
	async execute(req: StepTurnRequest): Promise<StepTurnResult> {
		if (req.step.mode === "code") {
			return this.executeCodeStep(req);
		}
		return this.executeConversationStep(req);
	}

	// -- Conversation path ---------------------------------------------------

	private async executeConversationStep(req: StepTurnRequest): Promise<StepTurnResult> {
		const { step, flow, event, runContext } = req;

		// (1) turn.start BEFORE any LLM call (recovery anchor).
		await this.sessionLog.appendTurnStart({
			turn: req.iteration,
			step: step.name,
			trigger_topic: event.topic,
			conversation_id: req.conversationId,
		});

		// (2) Resolve persona WITHOUT mutating global state.
		const persona = step.persona
			? await this.deps.personaManager.getPersonaByName(step.persona)
			: null;

		// (3) Resolve provider/model via the PURE resolver — pinned, no global write.
		const resolved = resolvePersonaProviderConfig(
			persona,
			step.model,
			this.deps.settings,
			this.deps.providerRegistry,
		);

		// (5a) Build the per-step runtime (dispatcher + tool defs + system prompt).
		const runtime = await this.deps.runtimeFactory.build({
			step,
			persona,
			resolved,
			mode: req.mode,
			orchestrationContext: req.orchestrationContext,
			abortSignal: req.runContext.abort,
		});

		// (4) Build the prompt (resolve <include_note> if a resolver is wired).
		const resolvedBody = this.deps.resolveIncludes
			? await this.deps.resolveIncludes(step.bodyContent, step.notePath)
			: undefined;
		const prompt = this.deps.promptBuilder.build({
			step,
			flow,
			event,
			eventHistory: req.eventHistory,
			objective: req.objective,
			scratchpadPath: req.orchestrationContext.scratchpadPath,
			tasksPath: req.orchestrationContext.tasksPath,
			iteration: req.iteration,
			memoriesPath: this.deps.memoriesPath,
			resolvedBody,
		});

		// (5b) Run the turn on the shared RunLoop with the PINNED model.
		let perTurnCost = 0;
		let perTurnTokens = { input: 0, output: 0 };
		const hooks: RunLoopHooks = {
			onPersist: req.onPersist,
			onProgress: req.onProgress,
			onTurnComplete: (_turn, outcome) => {
				// Surface the per-turn cost/tokens for turn.complete (Issue-5).
				perTurnCost += outcome.costUsd;
				perTurnTokens = {
					input: perTurnTokens.input + outcome.tokenUsage.input,
					output: perTurnTokens.output + outcome.tokenUsage.output,
				};
			},
		};

		const runLoop = new RunLoop({
			provider: runtime.provider,
			model: resolved.modelId,
			systemPrompt: runtime.systemPrompt,
			toolDefinitions: runtime.toolDefinitions,
			dispatcher: runtime.dispatcher,
			mode: req.mode,
			iterationCap: this.deps.iterationCap,
			thinkingLevel: resolved.thinkingLevel,
			settings: this.deps.settings,
			runContext,
			orchestrationContext: req.orchestrationContext,
			hooks,
			onProgress: req.onProgress,
		});

		const result = await runLoop.run(prompt);
		// RunResult carries the authoritative cumulative totals; prefer them.
		const costUsd = perTurnCost;
		const tokenUsage = result.tokenUsage;

		// (6/7) Capture the emission, or synthesize default_publishes / {step}.capped.
		const emission = this.resolveEmission(step, req.orchestrationContext, result.stopReason);

		// (Issue-13e) Flush any within-turn overwrite audit entries.
		await this.flushEmissionOverwrites(step.name, req.iteration, req.orchestrationContext);

		// (8) turn.complete carrying per-turn cost + tokens (Issue-5).
		await this.sessionLog.appendTurnComplete({
			turn: req.iteration,
			step: step.name,
			emitted_topic: emission.topic,
			conversation_id: req.conversationId,
			cost_usd: costUsd,
			token_usage: tokenUsage,
		});

		// (INT-006) Persist the step conversation with its orchestration_edges
		// header; backfill the next/prev chain. The header `_type` marker hides it
		// from the flat conversation list. Persistence failure never fails the turn.
		await this.persistStepConversation(req, result.messages, resolved.modelId);

		// (INT-020 / FR-140) Synthesize the per-turn progress Notice from this same
		// completion path — naming flow + step + iteration + the just-emitted topic
		// ("what's next"), carrying the step conversation id for the INT-021
		// right-click jump. The engine never constructs a Notice (AC-3); the
		// notifier is injected, so this stays obsidian-free. A suppressed turn
		// (Notice-fatigue policy) still wrote turn.complete + persisted above.
		this.deps.showProgressNotice?.({
			flowName: flow.name,
			stepName: step.name,
			iteration: req.iteration,
			emittedTopic: emission.topic,
			conversationId: req.conversationId,
		});

		return { emission, stopReason: result.stopReason, costUsd, tokenUsage };
	}

	/**
	 * Persist the just-completed conversation step as a hidden step conversation
	 * (INT-006). Links `prev` → the previous step conversation; the store backfills
	 * the reciprocal `next` on the predecessor. No-op when no store is wired (unit
	 * tests). Best-effort — a persistence error is logged, never thrown.
	 */
	private async persistStepConversation(
		req: StepTurnRequest,
		messages: ChatMessage[],
		modelId: string,
	): Promise<void> {
		const store = this.deps.stepConversationStore;
		if (!store) return;
		try {
			await store.persist({
				conversationId: req.conversationId,
				sessionId: req.orchestrationContext.sessionId,
				flowName: req.flow.name,
				stepName: req.step.name,
				iteration: req.iteration,
				prevConversationId: this.lastStepConversationId,
				createdAtMs: Date.now(),
				providerId: this.deps.providerLabel?.providerId ?? "",
				modelId: this.deps.providerLabel?.modelId ?? modelId,
				messages,
			});
			this.lastStepConversationId = req.conversationId;
		} catch (e) {
			log.warn("Failed to persist step conversation", {
				step: req.step.name,
				error: String(e),
			});
		}
	}

	/**
	 * Resolve the next event from the post-turn capture:
	 *  - a captured `emit_event` always wins;
	 *  - else, a `completed` turn synthesizes `default_publishes` (or `{step}.no_emit`
	 *    when none is declared);
	 *  - else (non-`completed` / cut-off), synthesizes `{step}.capped` carrying the
	 *    stop reason — a cut-off turn never masquerades as success (FR-117a).
	 */
	private resolveEmission(
		step: StepDefinition,
		ctx: OrchestrationToolContext,
		stopReason: string,
	): { topic: string; payload: string; structured?: unknown } {
		if (ctx.pendingEmission) {
			return ctx.pendingEmission;
		}
		if (stopReason === "completed") {
			if (step.defaultPublishes) {
				return { topic: step.defaultPublishes, payload: "" };
			}
			// No default_publishes → recognized {step}.no_emit failure channel.
			return {
				topic: `${step.name}.no_emit`,
				payload: `Step '${step.name}' completed its turn without emitting an event and declares no default_publishes.`,
			};
		}
		// Cut-off turn (iteration/token/context/cost/depth cap): {step}.capped.
		return {
			topic: `${step.name}.capped`,
			payload: JSON.stringify({ stopReason, step: step.name }),
		};
	}

	/** Flush the within-turn overwrite audit (Issue-13e) to `event.emission_overwritten`. */
	private async flushEmissionOverwrites(
		stepName: string,
		turn: number,
		ctx: OrchestrationToolContext,
	): Promise<void> {
		const overwrites = ctx.emissionOverwrites;
		if (!overwrites || overwrites.length === 0) return;
		for (const o of overwrites) {
			await this.sessionLog.appendEventEmissionOverwritten({
				turn,
				step: stepName,
				prev_topic: o.prev_topic,
				new_topic: o.new_topic,
			});
		}
		overwrites.length = 0;
	}

	// -- Code-step seam (Phase 3, INT-010) -----------------------------------

	/**
	 * Code-step dispatch seam (Phase 3, INT-010). Delegates to the injected
	 * `CodeStepExecutor` (deterministic fence execution, zero tokens). When no
	 * executor is wired (Phase-1 unit tests), falls back to an inert default
	 * emission so a flow with an accidental code step never silently stalls.
	 */
	private async executeCodeStep(req: StepTurnRequest): Promise<StepTurnResult> {
		if (this.deps.codeStepExecutor) {
			return this.deps.codeStepExecutor.execute(req);
		}

		const { step, event } = req;
		log.warn("Code-step execution has no executor wired; synthesizing default emission", {
			step: step.name,
		});
		await this.sessionLog.appendTurnStart({
			turn: req.iteration,
			step: step.name,
			trigger_topic: event.topic,
			conversation_id: null,
		});
		const emission = step.defaultPublishes
			? { topic: step.defaultPublishes, payload: "" }
			: {
					topic: `${step.name}.no_emit`,
					payload: `Code step '${step.name}' is not yet executable (Phase 3, INT-010).`,
				};
		await this.sessionLog.appendTurnComplete({
			turn: req.iteration,
			step: step.name,
			emitted_topic: emission.topic,
			conversation_id: null,
			cost_usd: 0,
			token_usage: { input: 0, output: 0 },
		});
		return { emission, stopReason: "completed", costUsd: 0, tokenUsage: { input: 0, output: 0 } };
	}
}
