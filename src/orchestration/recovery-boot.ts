/**
 * Session recovery on reload (INT-005 / FR-125) — the load-time recovery scan +
 * resume half of the former `launch.ts`.
 *
 * Scans `{notor_dir}/orchestrations/sessions/*` for recoverable roots, classifies
 * each dangling tail, rebuilds budget + safety state, and offers a resume; the
 * per-session resume ({@link resumeRecoveredSession}) is also the primitive a
 * `run_flow` parent uses to resume a non-terminal child in place (via child-spawn).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — INT-005
 * @see specs/ZZ-misc/arch-review-july-2026/F6-launch-ts-decomposition.md
 */

import { Notice, ButtonComponent, normalizePath } from "obsidian";
import type { OrchestrationHost } from "./host";
import type { AggregateBudget, OrchestrationToolContext } from "../run-loop/types";
import { logger } from "../utils/logger";
import { FlowDefinitionParser } from "./flow-parser";
import { SessionLog } from "./session-log";
import { OrchestrationSessionManager } from "./session-manager";
import { OrchestrationRunner, type OrchestrationRunResult } from "./runner";
import { SessionRecovery, type RecoveryFs, type RecoverableSession } from "./session-recovery";
import { isSessionLogMtimeLive } from "./recovery-liveness";
import type { OrchestrationFlow } from "./types";
import { VaultSessionFs, VaultSessionLogWriter, buildExecutor, listOpenTaskKeys } from "./launch-wiring";
import { finalizeRun, type RequestUserInput } from "./run-lifecycle";

const log = logger("OrchestrationLaunch");

/** Build the {@link RecoveryFs} the scan + child-resume read sessions through. */
export function makeRecoveryFs(
	host: OrchestrationHost,
	sessionManager: OrchestrationSessionManager,
): RecoveryFs {
	const fsVault = new VaultSessionFs(host.app);
	const sessionsRoot = `${sessionManager.rootPath}/sessions`;
	return {
		listSessions: async () => {
			if (!(await fsVault.exists(sessionsRoot))) return [];
			const listing = await host.app.vault.adapter.list(normalizePath(sessionsRoot));
			return listing.folders.map((f) => f.split("/").pop() ?? f);
		},
		readMeta: async (sessionId) => {
			const path = `${sessionsRoot}/${sessionId}/session.json`;
			if (!(await fsVault.exists(path))) return null;
			return fsVault.read(path);
		},
		readLog: async (sessionId) => {
			const path = `${sessionsRoot}/${sessionId}/session-log.jsonl`;
			if (!(await fsVault.exists(path))) return null;
			return fsVault.read(path);
		},
	};
}

/**
 * Load-time orchestration recovery scan. Gated on `orchestration_enabled` by the
 * caller (main.ts). Scans `{notor_dir}/orchestrations/sessions/*` for recoverable
 * roots (`user`/`hook` always; terminal-parent `chaining`), classifies each
 * dangling tail, rebuilds budget + safety state, and resumes each on its own
 * runner. Loud recovery errors (interior log corruption, absent/unexpected
 * `origin`, missing files) are surfaced as Notices and the session is marked
 * `error` — never silently skipped.
 *
 * Resume is offered, not forced (F1 Fix 2): each recoverable root surfaces a
 * Notice with a **Resume** button and only restarts on click, so a deliberately
 * stopped run is not silently relaunched. A still-`active` root whose
 * `session-log.jsonl` mtime is fresh is treated as **live** and skipped entirely
 * (no second runner on a session the original runner is still writing).
 *
 * `requestUserInput` is injected from the composition site (main.ts) so a resumed
 * paused session re-surfaces its prompt through the same modal — this module never
 * imports ui.
 */
export async function recoverOrchestrations(
	host: OrchestrationHost,
	requestUserInput?: RequestUserInput,
): Promise<void> {
	const fsVault = new VaultSessionFs(host.app);
	const sessionManager = new OrchestrationSessionManager(host.settings.notor_dir, fsVault);
	const recoveryFs = makeRecoveryFs(host, sessionManager);

	// Resolve each flow's finite ceilings so the budget re-seeds from the real
	// caps (not the engine defaults) when the flow is still discoverable.
	let flowsByName = new Map<string, OrchestrationFlow>();
	try {
		const parser = new FlowDefinitionParser(
			host.app.vault,
			host.app.metadataCache,
			host.settings.notor_dir,
		);
		const parsed = await parser.discoverFlows();
		flowsByName = new Map(parsed.map((p) => [p.flow.name, p.flow]));
	} catch (e) {
		log.warn("Flow discovery during recovery failed; using engine-default ceilings", {
			error: String(e),
		});
	}

	const recovery = new SessionRecovery();
	const scan = await recovery.scan(recoveryFs, {
		resolveCeilings: (flowName) => {
			const f = flowsByName.get(flowName);
			return f ? { maxIterations: f.maxIterations, maxCostUsd: f.maxCostUsd } : null;
		},
	});

	// Surface loud recovery errors and mark those sessions `error`.
	for (const err of scan.errors) {
		log.error("Orchestration recovery error", { sessionId: err.sessionId, reason: err.reason });
		new Notice(`Orchestration recovery error (${err.sessionId}): ${err.reason}`);
		await sessionManager.updateStatus(err.sessionId, "error").catch(() => undefined);
	}

	if (scan.recoverable.length === 0) return;

	for (const recovered of scan.recoverable) {
		const flow = flowsByName.get(recovered.meta.flow_name);
		if (!flow) {
			log.warn("Cannot resume — flow no longer discoverable", {
				sessionId: recovered.sessionId,
				flow: recovered.meta.flow_name,
			});
			new Notice(
				`Cannot resume orchestration '${recovered.meta.flow_name}' — its flow definition is missing.`,
			);
			continue;
		}

		// F1 Fix 2: liveness guard. A crashed host can leave a session
		// `status: "active"` while its original runner is still live (unload was
		// unsafe before Fix 1, and the bounded unload abort is best-effort). Resuming
		// such a session spawns a SECOND runner racing on one log. Detect the live
		// case via the log's mtime — the only writer keeping it fresh is a live
		// runner (the log advances ≥2×/turn). A `null` stat (adapter differences) is
		// treated as not-live. `interrupted` (paused) sessions are exempt — they are
		// legitimately idle.
		if (recovered.meta.status === "active" && (await isSessionLogLive(host, sessionManager, recovered.sessionId))) {
			log.info("Recovery: session log is fresh — treating as live, skipping resume", {
				sessionId: recovered.sessionId,
				flow: flow.name,
			});
			continue;
		}

		// F1 Fix 2: resume is OFFERED, not forced — the user may have deliberately
		// stopped Obsidian mid-run (or Stopped the flow). Surface a Notice with a
		// Resume button; the run (and its indicator re-seed) only restarts on click.
		offerResumeNotice(host, flow, recovered, sessionManager, requestUserInput);
	}
}

/**
 * Stat a recoverable session's `session-log.jsonl` and decide whether it is still
 * being written by a live runner (F1 Fix 2). Delegates the freshness decision to
 * the pure {@link isSessionLogMtimeLive}.
 */
async function isSessionLogLive(
	host: OrchestrationHost,
	sessionManager: OrchestrationSessionManager,
	sessionId: string,
): Promise<boolean> {
	try {
		const ws = sessionManager.resolveWorkspace(sessionId);
		const stat = await host.app.vault.adapter.stat(normalizePath(ws.logPath));
		const mtime = stat && typeof stat.mtime === "number" ? stat.mtime : null;
		return isSessionLogMtimeLive(mtime, Date.now());
	} catch {
		return false;
	}
}

/**
 * Offer to resume a recovered session via a Notice carrying a Resume button (F1
 * Fix 2). The run restarts only on click — resume is offered, not forced.
 */
function offerResumeNotice(
	host: OrchestrationHost,
	flow: OrchestrationFlow,
	recovered: RecoverableSession,
	sessionManager: OrchestrationSessionManager,
	requestUserInput?: RequestUserInput,
): void {
	const fragment = document.createDocumentFragment();
	const wrapper = fragment.createDiv({ cls: "notor-orchestration-resume-notice" });
	wrapper.createDiv({
		text: `Orchestration '${flow.name}' was interrupted (${recovered.action.kind}). Resume it?`,
	});
	const buttonRow = wrapper.createDiv({ cls: "notor-orchestration-resume-actions" });
	const notice = new Notice(fragment, 0);
	new ButtonComponent(buttonRow)
		.setButtonText("Resume")
		.setCta()
		.onClick(() => {
			notice.hide();
			// POL-004: re-seed the unified indicator so the resumed run surfaces.
			host.upsertFlowRun({
				type: "flow-run",
				sessionId: recovered.sessionId,
				flowName: flow.name,
				status: "active",
				startedAt: recovered.meta.started_at,
			});
			resumeRecoveredSession(host, flow, recovered, sessionManager, undefined, requestUserInput).catch((e) =>
				log.error("Orchestration resume failed", {
					sessionId: recovered.sessionId,
					error: String(e),
				}),
			);
		});
	new ButtonComponent(buttonRow).setButtonText("Dismiss").onClick(() => notice.hide());
}

/**
 * Resume one recovered session on a freshly-wired runner. Returns the terminal
 * result (used by a `run_flow` parent reconciling a non-terminal child in place,
 * INT-044). `inheritedContext` is set only for a child resume — a root resume
 * re-seeds its budget from the rehydrated state.
 */
export async function resumeRecoveredSession(
	host: OrchestrationHost,
	flow: OrchestrationFlow,
	recovered: RecoverableSession,
	sessionManager: OrchestrationSessionManager,
	inheritedContext?: { budget: AggregateBudget; depth: number; abort?: AbortSignal },
	requestUserInput?: RequestUserInput,
): Promise<OrchestrationRunResult> {
	const ws = sessionManager.resolveWorkspace(recovered.sessionId);
	await sessionManager.updateStatus(recovered.sessionId, "active").catch(() => undefined);

	const sessionLog = new SessionLog(ws.logPath, new VaultSessionLogWriter(host.app));
	// Resolve the note-opening decision identically to a fresh launch (per-flow
	// override, else the global orchestration setting).
	const openNotes = flow.openNotesInEditor ?? host.settings.orchestration_open_notes_in_editor;
	// Resume: seed the once() skip set from the recovered log so an
	// already-committed external effect is not re-run (FR-125 / INT-010).
	const executor = buildExecutor(host, sessionLog, new Set(recovered.committedKeys), openNotes);
	// F1 Fix 1: a child resume cascades from the parent's abort signal; a ROOT
	// resume owns its controller and registers it so the Stop UI / onunload can
	// cancel it (children are cancelled transitively via the cascade — register
	// root sessions only, i.e. when no `inheritedContext` was passed).
	const registry = host.getOrchestrationRunRegistry();
	const rootController = inheritedContext?.abort ? null : new AbortController();
	const abortSignal = inheritedContext?.abort ?? rootController!.signal;
	if (rootController) {
		registry.register({
			sessionId: recovered.sessionId,
			flowName: flow.name,
			controller: rootController,
			lastProgressAt: Date.now(),
		});
	}

	const requestUserInputCb = requestUserInput;
	const runner = new OrchestrationRunner({
		executor,
		sessionLog,
		makeOrchestrationContext: (): OrchestrationToolContext => ({
			sessionId: recovered.sessionId,
			scratchpadPath: ws.scratchpadPath,
			tasksPath: ws.tasksPath,
			pendingEmission: null,
			emissionOverwrites: [],
			workflowInvocations: [],
			childRunResults: [],
			childEdges: [],
		}),
		makeConversationId: () => crypto.randomUUID(),
		mode: host.settings.mode,
		sessionId: recovered.sessionId,
		abortSignal,
		origin: recovered.meta.origin,
		parentSessionId: recovered.meta.parent_session_id,
		// INT-044: a resumed child inherits the parent's shared budget cell + depth
		// so its turns keep drawing down the tree-wide ceiling. A root resume omits
		// this (its budget is re-seeded from the rehydrated decrements in resume()).
		inheritedContext: inheritedContext
			? { budget: inheritedContext.budget, depth: inheritedContext.depth }
			: undefined,
		listOpenTasks: () => listOpenTaskKeys(host, ws.tasksPath),
		// INT-030: a recovered paused session re-surfaces its prompt through the
		// same modal; supplying input resumes the loop, dismissing cancels it. The
		// callback is injected from the composition site so this module never imports ui.
		requestUserInput: requestUserInputCb
			? (question) => requestUserInputCb(flow.name, question)
			: undefined,
		setSessionStatus: (status) => sessionManager.updateStatus(recovered.sessionId, status),
		// F1 Fix 1: refresh the registry heartbeat each turn (a no-op for a child
		// resume we did not register).
		onProgress: (status) => {
			registry.touch(recovered.sessionId);
			log.debug("orchestration resume progress", { status });
		},
	});

	let result: OrchestrationRunResult;
	try {
		result = await runner.resume(flow, recovered);
	} catch (e) {
		await sessionManager.updateStatus(recovered.sessionId, "interrupted").catch(() => undefined);
		throw e;
	} finally {
		// F1 Fix 1: release the lifecycle handle once the resume settles (a no-op
		// for a child resume we did not register).
		if (rootController) registry.unregister(recovered.sessionId);
	}

	// INT-001 + Part B: the shared finalize invariant — reflect the terminal status
	// into session.json and write the opt-in failure report for a recovered run that
	// ends in error, identically to a fresh launch.
	await finalizeRun(host, sessionManager, recovered.sessionId, flow, result);

	return result;
}
