/**
 * Orchestration run lifecycle (FEAT-011 / FEAT-012) — the "run a flow to a
 * terminal event" half of the former `launch.ts`.
 *
 * Exposes {@link launchOrchestration} — resolve/parse a flow + run it to a
 * terminal event (used by the command and by the `run_orchestration` hook) — plus
 * the chaining handoff (`notor-on-complete-flow`) and the shared finalize
 * invariant ({@link finalizeRun}) that both a fresh launch and a crash-recovery
 * resume must apply identically.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-011
 * @see specs/ZZ-misc/arch-review-july-2026/F6-launch-ts-decomposition.md
 */

import { Notice } from "obsidian";
import type { OrchestrationHost } from "./host";
import type { ConversationMode } from "../types";
import type { AggregateBudget, OrchestrationToolContext } from "../run-loop/types";
import { logger } from "../utils/logger";
import { SessionLog } from "./session-log";
import { OrchestrationSessionManager } from "./session-manager";
import { seedMemoriesNote } from "./memories";
import { writeFailureReport, shouldWriteFailureReport } from "./failure-report";
import { OrchestrationRunner, type OrchestrationRunResult } from "./runner";
import { newRootBudget } from "../run-loop/budget";
import { FLOW_CANCELLED } from "./types";
import type { OrchestrationFlow } from "./types";
import { VaultSessionFs, VaultSessionLogWriter, buildExecutor, listOpenTaskKeys } from "./launch-wiring";
import { chainToSuccessor, resolveSuccessorInputs } from "./chaining";

const log = logger("OrchestrationLaunch");

/**
 * The interactive-pause callback the runner uses when a flow pauses for user
 * input (INT-030). Injected from the composition site (the UI layer) rather than
 * imported here, so the run-lifecycle logic never depends on the ui module —
 * keeping the ui→logic import direction clean.
 */
export type RequestUserInput = (flowName: string, question: string) => Promise<string | null>;

/** Generate a short session id. */
export function newSessionId(): string {
	return `sess-${crypto.randomUUID().slice(0, 12)}`;
}

/**
 * Opt-in failed-run debug note (Part B). When a run terminates with
 * `status: "error"` and `orchestration_write_failure_notes` is on, compose a
 * human-readable Markdown report from data already captured (session.json meta +
 * the run result + session-log.jsonl) and write it under
 * `{notor_dir}/orchestrations/failures/`. Called from both finalize sites (a
 * fresh run and a crash-recovery resume).
 *
 * Fully best-effort: a missing log, an absent meta, or a write failure is logged
 * and swallowed so the report never masks the original run error.
 */
export async function maybeWriteFailureReport(
	host: OrchestrationHost,
	sessionManager: OrchestrationSessionManager,
	sessionId: string,
	flow: OrchestrationFlow,
	result: OrchestrationRunResult,
): Promise<void> {
	if (!shouldWriteFailureReport(result.status, host.settings.orchestration_write_failure_notes)) {
		return;
	}
	try {
		const ws = sessionManager.resolveWorkspace(sessionId);
		const meta = await sessionManager.readMeta(sessionId);
		const fsVault = new VaultSessionFs(host.app);
		const logJsonl = await fsVault.read(ws.logPath).catch(() => null);
		const path = await writeFailureReport({
			notorDir: host.settings.notor_dir,
			fs: fsVault,
			meta,
			result,
			logJsonl,
			sessionDir: ws.sessionDir,
		});
		new Notice(`Orchestration '${flow.name}' failed — debug report: ${path}`);
	} catch (e) {
		log.warn("Failed to write orchestration failure report", { sessionId, error: String(e) });
	}
}

/**
 * The shared finalize invariant applied identically by a fresh launch and a
 * crash-recovery resume: reflect the terminal status into session.json (the
 * recovery entry point) and, when the run ended in error with the setting on,
 * write the opt-in failure report (Part B). Returns the mapped final status so
 * the caller can mirror it into any additional surface (e.g. the flow-run
 * indicator). Extracting it keeps the "both sites finalize the same way"
 * invariant structural rather than a copy pair that can drift.
 */
export async function finalizeRun(
	host: OrchestrationHost,
	sessionManager: OrchestrationSessionManager,
	sessionId: string,
	flow: OrchestrationFlow,
	result: OrchestrationRunResult,
): Promise<"completed" | "cancelled" | "error"> {
	// INT-001: `completed` → done; `cancelled`/`error` map to their statuses.
	const finalStatus =
		result.status === "completed"
			? "completed"
			: result.status === "cancelled"
				? "cancelled"
				: "error";
	await sessionManager
		.updateStatus(sessionId, finalStatus, { iteration: result.iterations })
		.catch((e) => log.warn("Failed to finalize session.json status", { error: String(e) }));

	// Part B: opt-in failed-run debug note (no-op unless status is error + setting on).
	await maybeWriteFailureReport(host, sessionManager, sessionId, flow, result);

	return finalStatus;
}

/**
 * Resolve, parse, and run a flow by directory to a terminal event. Used by both
 * the command (FEAT-011) and the `run_orchestration` hook (FEAT-012).
 */
export async function launchOrchestration(
	host: OrchestrationHost,
	flow: OrchestrationFlow,
	promptText: string,
	options?: {
		origin?: "user" | "hook" | "schedule" | "run_flow" | "chaining";
		parentSessionId?: string | null;
		mode?: ConversationMode;
		abortSignal?: AbortSignal;
		/**
		 * Pre-allocated child session id (INT-044). When omitted a fresh one is
		 * minted. A child / chaining launch supplies it so the parent's
		 * `child.spawned` ledger entry can record the id **before** the run starts.
		 */
		sessionId?: string;
		/**
		 * Inherited cascade context for a child / chaining run (INT-043/045/046):
		 * the SHARED budget cell + the parent's depth (the child runs at `depth+1`).
		 * Omitted for a root run, which seeds a fresh cell from the flow's ceilings.
		 */
		inheritedContext?: { budget: AggregateBudget; depth: number };
		/**
		 * The parent session's scratchpad path, auto-allowed for a `shared`-handoff
		 * child's step turns (FR-174). Only consulted when the callee flow's
		 * `notor-handoff-isolation` is `shared`.
		 */
		parentScratchpadPath?: string;
		/**
		 * The caller's step conversation id (INT-043). Written as the child entry
		 * conversation's `parent` back-link edge so the run-tree can ascend.
		 */
		parentConversationId?: string;
		/**
		 * The interactive-pause callback injected from the composition site
		 * (INT-030). Wired as the runner's `requestUserInput`; omitted ⇒ the runner
		 * cancels on a pause (no input channel).
		 */
		requestUserInput?: RequestUserInput;
	},
): Promise<OrchestrationRunResult> {
	const sessionId = options?.sessionId ?? newSessionId();
	const origin = options?.origin ?? "user";
	const parentSessionId = options?.parentSessionId ?? null;
	// `shared` handoff: auto-allow the parent scratchpad for this child's turns.
	const sharedParentScratchpad =
		flow.handoffIsolation === "shared" ? options?.parentScratchpadPath : undefined;

	// F1 Fix 4: per-flow single-instance guard. Skip-with-Notice when another live
	// session is already running this flow (mirrors WorkflowConcurrencyManager's
	// isWorkflowRunning consumption). Exempt `run_flow` children and `chaining`
	// self-succession — both are legal depth/budget-bounded recursion, and a flow
	// legitimately calling or chaining to itself must not be blocked. Opt out
	// per-flow with `notor-flow-allow-concurrent: true`. In-memory only: after a
	// crash the recovery liveness guard (Fix 2) is the protection.
	if (origin !== "run_flow" && origin !== "chaining" && !flow.allowConcurrent) {
		const registry = host.getOrchestrationRunRegistry();
		if (registry.isFlowRunning(flow.name)) {
			const running = registry.listActive().find((h) => h.flowName === flow.name);
			log.info("Skipping launch — flow already running", {
				flow: flow.name,
				runningSessionId: running?.sessionId,
			});
			new Notice(
				`Orchestration '${flow.name}' is already running (${running?.sessionId ?? "active"}); skipped.`,
			);
			return skippedRunResult(flow);
		}
	}

	// INT-001: create the session workspace (dir + scratchpad/ + tasks/ +
	// session.json status `active`) before the first turn runs.
	const sessionManager = new OrchestrationSessionManager(
		host.settings.notor_dir,
		new VaultSessionFs(host.app),
	);
	const ws = await sessionManager.createSession({
		sessionId,
		flowName: flow.name,
		prompt: promptText,
		origin,
		parentSessionId,
	});

	// INT-004: seed the persistent cross-session memories note on first use
	// (idempotent — never overwrites an existing note).
	await seedMemoriesNote(host.settings.notor_dir, new VaultSessionFs(host.app)).catch((e) =>
		log.warn("memories.md seeding failed", { error: String(e) }),
	);

	// POL-004: surface this run in the unified activity indicator as an active
	// `flow-run` entry (session-file-backed registry).
	const flowRunStartedAt = new Date().toISOString();
	host.upsertFlowRun({
		type: "flow-run",
		sessionId,
		flowName: flow.name,
		status: "active",
		startedAt: flowRunStartedAt,
	});

	const sessionLog = new SessionLog(ws.logPath, new VaultSessionLogWriter(host.app));
	// Resolve once: the per-flow `notor-open-notes-in-editor` override (when set)
	// wins, else the global `orchestration_open_notes_in_editor` setting.
	const openNotes = flow.openNotesInEditor ?? host.settings.orchestration_open_notes_in_editor;
	// Fresh launch: no prior committed side-effects (INT-010 once() skip set).
	const executor = buildExecutor(host, sessionLog, new Set<string>(), openNotes);

	const abortController = new AbortController();
	const abortSignal = options?.abortSignal ?? abortController.signal;

	// F1 Fix 1: give this run a lifecycle handle so the Stop UI, the single-instance
	// guard, and onunload teardown can find and cancel it. A child / chaining run
	// that inherits a parent abort signal (`options.abortSignal`) is cancelled
	// transitively via the cascade, so only register the controller we own here.
	const registry = host.getOrchestrationRunRegistry();
	if (!options?.abortSignal) {
		registry.register({
			sessionId,
			flowName: flow.name,
			controller: abortController,
			lastProgressAt: Date.now(),
		});
	}

	// INT-045: if this flow chains (`notor-on-complete-flow`), resolve the
	// successor's `notor-flow-inputs` so the prompt builder injects the HANDOFF
	// section on the terminal step (the predecessor shapes its forwarded payload).
	const onCompleteFlowInputs = flow.onCompleteFlow
		? await resolveSuccessorInputs(host, flow.onCompleteFlow)
		: null;

	const requestUserInput = options?.requestUserInput;
	const runner = new OrchestrationRunner({
		executor,
		sessionLog,
		makeOrchestrationContext: (_conversationId): OrchestrationToolContext => ({
			sessionId,
			scratchpadPath: ws.scratchpadPath,
			tasksPath: ws.tasksPath,
			// `shared` handoff: the parent scratchpad is auto-allowed for this
			// child's step turns (FR-174 / INT-044).
			parentScratchpadPath: sharedParentScratchpad,
			pendingEmission: null,
			emissionOverwrites: [],
			workflowInvocations: [],
			childRunResults: [],
			childEdges: [],
		}),
		makeConversationId: () => crypto.randomUUID(),
		mode: options?.mode ?? host.settings.mode,
		sessionId,
		abortSignal,
		origin,
		parentSessionId,
		// INT-046: a child / chaining run inherits the parent's SHARED budget cell
		// + depth (so the whole tree respects one ceiling). Omitted ⇒ root run.
		inheritedContext: options?.inheritedContext,
		// INT-045: the chaining successor's input contract, injected into the
		// terminal step's HANDOFF section so the predecessor shapes its payload.
		onCompleteFlowInputs,
		// INT-003: query the session's task registry to gate FLOW_COMPLETE.
		listOpenTasks: () => listOpenTaskKeys(host, ws.tasksPath),
		// INT-030: interactive pause. The runner writes user.input.required,
		// suspends, and calls this to collect the answer (a modal). Returning
		// null (declined/dismissed) finalizes via FLOW_CANCELLED. The callback is
		// injected from the composition site so this module never imports ui.
		requestUserInput: requestUserInput
			? (question) => requestUserInput(flow.name, question)
			: undefined,
		// INT-030: mirror session.json status while paused so a crash-while-paused
		// is recovered as a dangling user.input.required tail ("still paused").
		setSessionStatus: (status) => sessionManager.updateStatus(sessionId, status),
		// F1 Fix 1: refresh this run's registry heartbeat each turn (the recovery
		// liveness guard reads it); a no-op for a child run we did not register.
		onProgress: (status) => {
			registry.touch(sessionId);
			log.debug("orchestration progress", { status });
		},
	});

	log.info("Launching orchestration flow", { flow: flow.name, sessionId, origin });

	let result: OrchestrationRunResult;
	try {
		result = await runner.start(flow, promptText);
	} catch (e) {
		// A crash before a terminal: mark the session interrupted so the recovery
		// scan (INT-005) picks it up on next load.
		await sessionManager
			.updateStatus(sessionId, "interrupted")
			.catch(() => undefined);
		throw e;
	} finally {
		// F1 Fix 1: release the lifecycle handle once the run settles (success,
		// cancel, or crash) — a no-op for a child run we did not register.
		registry.unregister(sessionId);
	}

	// INT-001 + Part B: reflect the terminal status into session.json (the recovery
	// entry point) and write the opt-in failure report — the shared finalize
	// invariant both a fresh launch and a recovery resume apply identically.
	const finalStatus = await finalizeRun(host, sessionManager, sessionId, flow, result);

	// POL-004: reflect the terminal status into the unified indicator's flow-run
	// entry. Bug C: preserve the entry's original `startedAt` (overwriting it with
	// the finalize timestamp mis-sorted completed entries).
	host.upsertFlowRun({
		type: "flow-run",
		sessionId,
		flowName: flow.name,
		status: finalStatus,
		startedAt: flowRunStartedAt,
	});

	// INT-045: chaining / one-way handoff. On successful completion, if the flow
	// declares `notor-on-complete-flow`, launch the successor INSTEAD of returning
	// to any caller. Bug B (F1): the successor is AWAITED here (not fire-and-forget)
	// — a run_flow parent transitively awaits the whole chain. The handoff is gated
	// exactly like a run_flow spawn over the SAME shared budget cell + depth, so an
	// A → B → A on-complete cycle terminates at max_depth / the aggregate budget. A
	// blocked handoff surfaces a Notice and stops the chain without changing the
	// predecessor's status (see chainToSuccessor).
	if (result.status === "completed" && flow.onCompleteFlow) {
		await chainToSuccessor(host, flow, result, sessionId, requestUserInput).catch((e) =>
			log.error("Chaining handoff failed", { flow: flow.name, error: String(e) }),
		);
	}

	return result;
}

/**
 * The synthetic terminal result returned when a launch is skipped by the per-flow
 * single-instance guard (F1 Fix 4). Reported as `cancelled` with a `FLOW_CANCELLED`
 * terminal so a caller (e.g. a scheduler) treats it as a benign no-op, not an
 * error — no session was created.
 */
function skippedRunResult(flow: OrchestrationFlow): OrchestrationRunResult {
	return {
		status: "cancelled",
		terminal: {
			topic: FLOW_CANCELLED,
			payload: `Skipped: '${flow.name}' is already running.`,
			source_step: null,
			turn: 0,
			ts: new Date().toISOString(),
		},
		iterations: 0,
		structured: null,
		text: "",
		subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: 0 },
		tokenUsage: { input: 0, output: 0 },
		budget: newRootBudget(flow.maxIterations, flow.maxCostUsd),
		depth: 0,
	};
}
