/**
 * Child-flow spawn (INT-043 / INT-044) — the `run_flow` execution body split out
 * of the former `launch.ts`.
 *
 * Builds the {@link SpawnChildFlow} callback injected into `RunFlowTool`, plus the
 * durable-ledger reconciliation that makes a `run_flow` dispatch replay-safe on a
 * recovery re-run (reuse a terminal child's recorded result; resume a non-terminal
 * child in place — never tombstone-and-respawn).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — INT-043/044
 * @see specs/ZZ-misc/arch-review-july-2026/F6-launch-ts-decomposition.md
 */

import type { OrchestrationHost } from "./host";
import type { AggregateBudget } from "../run-loop/types";
import { logger } from "../utils/logger";
import { FlowCompositionManager } from "./flow-composition-manager";
import type {
	SpawnChildFlow,
	SpawnChildFlowRequest,
	SpawnChildFlowResult,
} from "./child-flow";
import { SessionLog } from "./session-log";
import { OrchestrationSessionManager } from "./session-manager";
import { SessionRecovery, type RecoverableSession } from "./session-recovery";
import { matchChildInLedger, parseLedgerEntries } from "./child-ledger";
import type { OrchestrationRunResult } from "./runner";
import type { OrchestrationFlow, OrchestrationSessionMeta } from "./types";
import { VaultStepConversationStore } from "./step-conversation-store";
import { VaultSessionFs, VaultSessionLogWriter } from "./launch-wiring";
import { launchOrchestration, newSessionId, type RequestUserInput } from "./run-lifecycle";
import { makeRecoveryFs, resumeRecoveredSession } from "./recovery-boot";

const log = logger("OrchestrationLaunch");

/**
 * The minimal read surface the child-ledger reconciliation + entry-conversation
 * resolution need (F1 Fix 3). Mirrors the `exists`/`read` half of `RecoveryFs`;
 * `makeChildFlowSpawner` builds the vault-backed adapter in production, and tests
 * inject a fake so the replay path is unit-testable without a host.
 */
export interface ChildLedgerFs {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
}

/**
 * Behavior-preserving test seams for {@link makeChildFlowSpawner} (production
 * defaults built inline). Injecting these lets the reuse/no-double-spawn/ordinal
 * paths (F1 Fix 3 / F6 §5.1) be driven over a fake ledger without a vault or a
 * live runner.
 */
export interface ChildSpawnDeps {
	/** The `(exists/read)` ledger reader (defaults to the `VaultSessionFs` seam). */
	ledgerFs?: ChildLedgerFs;
	/** Resolve the callee flow by name (defaults to `FlowCompositionManager`). */
	resolveFlow?: (flowName: string) => Promise<OrchestrationFlow | null>;
	/** Launch the child run (defaults to {@link launchOrchestration}). */
	launch?: typeof launchOrchestration;
}

/**
 * Build the {@link SpawnChildFlow} callback injected into `RunFlowTool`.
 * Closes over the host; for each `run_flow` call it:
 *  1. resolves the parent session's depth (from the parent's `RunContext` cascade,
 *     passed by the tool) and writes a **`child.spawned`** ledger entry on the
 *     **parent** session log (the recovery anchor — FR-125);
 *  2. runs the child flow to its terminal event on a child session + child runner
 *     inheriting the parent's SHARED budget cell + `depth + 1` (INT-046);
 *  3. writes **`child.result`** on the parent log (the reuse-on-recovery artifact);
 *  4. backfills the reciprocal `parent` edge on the child entry conversation;
 *  5. returns the child's `structured`/`text` + the aggregate-subtree rollup.
 *
 * **Recovery reuse/resume (INT-044 / FR-125, F1 Fix 3).** Before spawning, it
 * scans the parent log for the Nth `child.spawned` matching the replay-stable key
 * `(step === stepName, flow_name === flowName, ordinal === n)`:
 *  - a matching **`child.result`** (terminal child) ⇒ **reuse** the recorded result
 *    (no re-spawn) — the parent's replay must not double-execute the child;
 *  - a `child.spawned` with **no** `child.result` (non-terminal child) ⇒ **resume**
 *    that child session in place (replay its own log) and await it — never
 *    tombstone-and-respawn, so the child's `once()` markers survive.
 *
 * The match is **occurrence order per (step name, callee flowName)**, NOT
 * `via_tool_call_id`: recovery re-runs the step from fresh context and the LLM
 * re-issues `run_flow` with a brand-new `via_tool_call_id` (and new provider
 * `tool_use` ids), so an id-keyed match could never hit. v1 runs `run_flow`
 * serially within a step, so the per-step ordinal is a stable cross-replay key.
 * Old logs lacking the enriched fields never match → fresh spawn (today's behavior).
 *
 * `requestUserInput` is threaded to the child's launch/resume so a child flow that
 * pauses interactively surfaces the same modal a root run does (INT-030); injected
 * from the composition site (main.ts) so this logic module never imports ui.
 */
export function makeChildFlowSpawner(
	host: OrchestrationHost,
	requestUserInput?: RequestUserInput,
	deps?: ChildSpawnDeps,
): SpawnChildFlow {
	const fsVault = new VaultSessionFs(host.app);
	const sessionManager = new OrchestrationSessionManager(host.settings.notor_dir, fsVault);
	// The vault-backed reader the ledger reconciliation + entry-conversation
	// resolution read through (F1 Fix 3 — injected so both are unit-testable). A
	// `RecoveryFs`-shaped reader (exists/read); routed through the `VaultSessionFs`
	// seam rather than the raw adapter so child-spawn holds no direct vault I/O.
	const ledgerFs: ChildLedgerFs = deps?.ledgerFs ?? {
		exists: (p) => fsVault.exists(p),
		read: (p) => fsVault.read(p),
	};
	const resolveFlow =
		deps?.resolveFlow ??
		((flowName: string) =>
			new FlowCompositionManager(
				host.app.vault,
				host.app.metadataCache,
				host.settings.notor_dir,
			).resolveFlow(flowName));
	const launch = deps?.launch ?? launchOrchestration;
	// The single owner for step-conversation header surgery (F6 §4.2) — the
	// reciprocal `parent`-edge backfill goes through the store's atomic fs seam
	// instead of raw adapter I/O.
	const stepConversationStore = new VaultStepConversationStore(fsVault, host.settings.history_path);

	return async (req: SpawnChildFlowRequest): Promise<SpawnChildFlowResult> => {
		// Resolve the callee flow (the tool already validated it is invocable, but
		// re-resolve so the spawner is self-contained / testable).
		const flow = await resolveFlow(req.flowName);
		if (!flow) {
			return childErrorResult(req, `Flow '${req.flowName}' is not invocable.`);
		}

		const parentWs = sessionManager.resolveWorkspace(req.parentSessionId);
		const parentLog = new SessionLog(parentWs.logPath, new VaultSessionLogWriter(host.app));

		// --- Recovery reuse/resume (INT-044 / F1 Fix 3) --------------------------
		const reconciled = await reconcileChildLedger(host, req, ledgerFs, sessionManager, requestUserInput, resolveFlow);
		if (reconciled) return reconciled;

		// --- Fresh spawn ---------------------------------------------------------
		const childSessionId = newSessionId();

		// child.spawned BEFORE launch (the recovery anchor). F1 Fix 3: record the
		// real turn + step name + callee flow_name + per-step ordinal so a recovery
		// replay can match this dispatch deterministically (via_tool_call_id is kept
		// for observability only).
		await parentLog
			.appendChildSpawned({
				turn: req.turn ?? 0,
				step: req.stepName ?? "",
				flow_name: req.flowName,
				ordinal: req.ordinal ?? 0,
				via_tool_call_id: req.viaToolCallId,
				child_session_id: childSessionId,
			})
			.catch((e) => log.warn("child.spawned append failed", { error: String(e) }));

		let result: OrchestrationRunResult;
		try {
			result = await launch(host, flow, req.payload, {
				origin: "run_flow",
				parentSessionId: req.parentSessionId,
				sessionId: childSessionId,
				inheritedContext: req.cascade,
				parentScratchpadPath: req.parentScratchpadPath,
				parentConversationId: req.parentConversationId,
				abortSignal: req.cascade.abort,
				requestUserInput,
			});
		} catch (e) {
			log.error("Child flow run threw", { flow: flow.name, error: String(e) });
			return childErrorResult(req, e instanceof Error ? e.message : String(e), childSessionId);
		}

		// child.result AFTER the child returns, BEFORE the parent turn continues.
		// Record the child subtree's cost/iterations (F3 §3.3.3) so a root that spent
		// budget via this child can subtract it on recovery — the shared cell was
		// drawn down live, but the root's OWN log never recorded the child's spend.
		await parentLog
			.appendChildResult({
				turn: req.turn ?? 0,
				child_session_id: childSessionId,
				structured: result.structured ?? undefined,
				text: result.text,
				stop_reason: result.terminal.topic,
				cost_usd: result.subtreeConsumed.costUsd,
				iterations: result.subtreeConsumed.iterations,
			})
			.catch((e) => log.warn("child.result append failed", { error: String(e) }));

		const entryConversationId = await resolveChildEntryConversationId(ledgerFs, sessionManager, childSessionId);
		// Backfill the reciprocal `parent` edge on the child entry conversation
		// (through the store — the single owner for step-conversation header surgery).
		if (entryConversationId && req.parentConversationId) {
			await stepConversationStore.backfillParentEdge(
				entryConversationId,
				req.parentConversationId,
				req.parentSessionId,
			);
		}

		return {
			status: result.status,
			structured: result.structured,
			text: result.text,
			stopReason: result.terminal.topic,
			childSessionId,
			entryConversationId,
			rollup: {
				costUsd: result.subtreeConsumed.costUsd,
				iterations: result.subtreeConsumed.iterations,
				maxDepthReached: result.subtreeConsumed.maxDepthReached,
				tokenUsage: result.tokenUsage,
			},
		};
	};
}

/**
 * Reconcile a `run_flow` child against the parent's durable ledger on a recovery
 * re-run (INT-044 / F1 Fix 3). Returns a reuse/resume result when the parent
 * already has a `child.spawned` for this dispatch's replay-stable key
 * `(step === stepName, flow_name === flowName, ordinal === ordinal)`; `null` for a
 * fresh spawn (the common live case, and any old log lacking the enriched fields).
 *
 * The match is occurrence-order per (step, flow), NOT `via_tool_call_id` — a
 * recovery replay re-runs the step and re-issues `run_flow` with a fresh id, so an
 * id-keyed match could never hit and the child would double-execute.
 */
async function reconcileChildLedger(
	host: OrchestrationHost,
	req: SpawnChildFlowRequest,
	fs: ChildLedgerFs,
	sessionManager: OrchestrationSessionManager,
	requestUserInput: RequestUserInput | undefined,
	resolveFlow: (flowName: string) => Promise<OrchestrationFlow | null>,
): Promise<SpawnChildFlowResult | null> {
	// Without a step identity (defensive — real step turns always thread one) there
	// is no stable key, so never match: fall through to a fresh spawn.
	if (req.stepName === undefined || req.ordinal === undefined) return null;

	const parentWs = sessionManager.resolveWorkspace(req.parentSessionId);
	let raw: string;
	try {
		if (!(await fs.exists(parentWs.logPath))) return null;
		raw = await fs.read(parentWs.logPath);
	} catch {
		return null;
	}

	// F1 Fix 3: match on the replay-stable (step, flow_name, ordinal) key. An old
	// `child.spawned` lacking `flow_name`/`ordinal` never matches → fresh spawn.
	const match = matchChildInLedger(parseLedgerEntries(raw), {
		stepName: req.stepName,
		flowName: req.flowName,
		ordinal: req.ordinal,
	});
	if (!match) return null; // fresh spawn

	const childSessionId = match.spawned.child_session_id;
	const childResult = match.result;

	if (childResult) {
		// Terminal child → REUSE the recorded result (no re-spawn).
		log.info("run_flow recovery: reusing terminal child result", { childSessionId });
		const entryConversationId = await resolveChildEntryConversationId(fs, sessionManager, childSessionId);
		return {
			status: childResult.stop_reason === "FLOW_CANCELLED" ? "cancelled" : "completed",
			structured: childResult.structured ?? null,
			text: childResult.text,
			stopReason: childResult.stop_reason,
			childSessionId,
			entryConversationId,
			rollup: { costUsd: 0, iterations: 0, maxDepthReached: req.cascade.depth + 1, tokenUsage: { input: 0, output: 0 } },
		};
	}

	// Non-terminal child → RESUME it in place (replay its own log), never respawn.
	log.info("run_flow recovery: resuming non-terminal child in place", { childSessionId });
	const flow = await resolveFlow(req.flowName);
	if (!flow) return childErrorResult(req, `Flow '${req.flowName}' is no longer invocable.`, childSessionId);

	const recovery = new SessionRecovery();
	const recoveryFs = makeRecoveryFs(host, sessionManager);
	const logRaw = await recoveryFs.readLog(childSessionId);
	const metaRaw = await recoveryFs.readMeta(childSessionId);
	if (!logRaw || !metaRaw) {
		return childErrorResult(req, "Child session log/meta missing on resume.", childSessionId);
	}
	const childMeta = JSON.parse(metaRaw) as OrchestrationSessionMeta;
	const recovered = recovery.replay(childMeta, logRaw, {
		resolveCeilings: () => ({ maxIterations: flow.maxIterations, maxCostUsd: flow.maxCostUsd }),
	});
	const result = await resumeChildSession(host, flow, recovered, sessionManager, req.cascade, requestUserInput);
	const entryConversationId = await resolveChildEntryConversationId(fs, sessionManager, childSessionId);
	return {
		status: result.status,
		structured: result.structured,
		text: result.text,
		stopReason: result.terminal.topic,
		childSessionId,
		entryConversationId,
		rollup: {
			costUsd: result.subtreeConsumed.costUsd,
			iterations: result.subtreeConsumed.iterations,
			maxDepthReached: result.subtreeConsumed.maxDepthReached,
			tokenUsage: result.tokenUsage,
		},
	};
}

/** A child-run error result (no usable child output). */
function childErrorResult(
	req: SpawnChildFlowRequest,
	message: string,
	childSessionId = "",
): SpawnChildFlowResult {
	return {
		status: "error",
		structured: null,
		text: message,
		stopReason: "error",
		childSessionId,
		entryConversationId: null,
		rollup: { costUsd: 0, iterations: 0, maxDepthReached: req.cascade.depth + 1, tokenUsage: { input: 0, output: 0 } },
	};
}

/**
 * Resolve the **entry** (first) step conversation id of a child session from its
 * log — the `turn.start` `conversation_id` of the first conversation turn (the
 * `child` edge target). `null` when the child ran only code steps (no conversation).
 * Reads through the injected {@link ChildLedgerFs} (F1 Fix 3) so it is testable
 * over a fake fs.
 */
async function resolveChildEntryConversationId(
	fs: ChildLedgerFs,
	sessionManager: OrchestrationSessionManager,
	childSessionId: string,
): Promise<string | null> {
	const ws = sessionManager.resolveWorkspace(childSessionId);
	try {
		if (!(await fs.exists(ws.logPath))) return null;
		const raw = await fs.read(ws.logPath);
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line) as { type?: string; conversation_id?: string | null };
				if (e.type === "turn.start" && e.conversation_id) return e.conversation_id;
			} catch {
				// tolerate a malformed/truncated line
			}
		}
	} catch {
		// no log / unreadable — no entry conversation
	}
	return null;
}

/**
 * Resume a non-terminal `run_flow` child in place (INT-044). The parent's replay
 * (via {@link makeChildFlowSpawner}'s reconciliation) calls this to replay the
 * child's own log and await its terminal result, inheriting the parent's shared
 * budget cell + `depth + 1` — never tombstone-and-respawn, so the child's `once()`
 * markers survive.
 *
 * Kept in child-spawn (rather than recovery-boot) so recovery-boot has no inbound
 * edge from child-spawn — breaking the recovery↔child module cycle (F6 §2). It
 * calls {@link resumeRecoveredSession} directly.
 */
async function resumeChildSession(
	host: OrchestrationHost,
	flow: OrchestrationFlow,
	recovered: RecoverableSession,
	sessionManager: OrchestrationSessionManager,
	cascade: { budget: AggregateBudget; depth: number; abort: AbortSignal },
	requestUserInput?: RequestUserInput,
): Promise<OrchestrationRunResult> {
	return resumeRecoveredSession(host, flow, recovered, sessionManager, {
		budget: cascade.budget,
		depth: cascade.depth,
		abort: cascade.abort,
	}, requestUserInput);
}
