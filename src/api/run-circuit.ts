/**
 * `api.runCircuit` — launch a circuit headless or with follow mode, where the
 * chosen chat panel loads each step's conversation as the step finishes.
 */

import { launchCircuit, newSessionId } from "../circuits/run-lifecycle";
import type { CircuitRunPolicy } from "../circuits/run-policy";
import type { CircuitRunResult } from "../circuits/runner";
import type { ChatOrchestrator } from "../chat/orchestrator";
import { buildPromptWithAttachments } from "../context/wikilink-attachments";
import { requestCircuitInput } from "../ui/circuit-modals";
import { logger } from "../utils/logger";
import type { NotorApiHost } from "./host";
import { discoverCircuitsNow } from "./discovery";
import { collectNotesTouched } from "./notes-touched";
import { applyInclude, linkSignal, openTargetPanel, resolveApproval, resolveDisplay, resolveMode } from "./options";
import { matchCircuits } from "./resolve";
import type { RunTracker } from "./run-tracker";
import { NotorApiError, type NotorRunInfo, type NotorRunOptions, type NotorRunResult } from "./types";

const log = logger("NotorApi");

export async function runCircuit(
	host: NotorApiHost,
	tracker: RunTracker,
	nameOrPath: string,
	opts: NotorRunOptions = {},
): Promise<NotorRunResult> {
	if (!host.settings.circuits_enabled) {
		throw new NotorApiError("circuits_disabled", "Circuits are turned off in Settings → Notor → Circuits.");
	}
	const matches = matchCircuits(await discoverCircuitsNow(host), nameOrPath);
	if (matches.length === 0) throw new NotorApiError("not_found", `No circuit named '${nameOrPath}'.`);
	if (matches.length > 1) {
		throw new NotorApiError(
			"ambiguous",
			`'${nameOrPath}' matches ${matches.length} circuits (${matches.map((c) => c.flowDir).join(", ")}). Pass a directory path.`,
		);
	}
	const circuit = matches[0]!;
	const label = `Circuit '${circuit.name}'`;
	const mode = resolveMode(opts.mode);
	const display = resolveDisplay(opts.display);
	const approvalOverride = resolveApproval(host, opts.approval, label);
	const panel = display === "headless" ? null : await openTargetPanel(host, display);

	const sessionId = newSessionId();
	const initial: NotorRunInfo = { runId: sessionId, kind: "circuit", name: circuit.name, status: "running", sessionId };

	const allowConcurrent = opts.allowConcurrent || circuit.allowConcurrent;
	if (!allowConcurrent && host.getCircuitRunRegistry().isFlowRunning(circuit.name)) {
		const info: NotorRunInfo = {
			...initial,
			status: "failed",
			error: `${label} is already running. Pass allowConcurrent: true to start another run.`,
			errorCode: "already_running",
		};
		return { ...info, done: Promise.resolve(info) };
	}

	const controller = new AbortController();
	linkSignal(controller, opts.signal);
	const approval = host.getRunApproval?.(label);
	const policy: CircuitRunPolicy = {
		mode: mode ?? host.settings.mode,
		approvalCallback: approval?.callback,
		approvalHook: approval?.hook,
		approvalOverride,
	};
	const objective = opts.prompt?.trim()
		? opts.prompt
		: `Run of circuit '${circuit.name}' started by a script.`;

	const handle = tracker.start(initial, () => controller.abort(), async (update) => {
		const { prompt, attachments } = await buildPromptWithAttachments(host.app, objective);
		const stepConversationIds: string[] = [];
		const follow = panel ? makeFollower(host, panel, sessionId) : null;

		const result = await launchCircuit(host, allowConcurrent ? { ...circuit, allowConcurrent: true } : circuit, prompt, {
			origin: "api",
			sessionId,
			abortSignal: controller.signal,
			policy,
			requestUserInput: opts.interactive === false
				? undefined
				: (flowName, question) => requestCircuitInput(host.app, flowName, question),
			observer: {
				onStepTurnSaved: (turn) => {
					stepConversationIds.push(turn.conversationId);
					update({ conversationId: turn.conversationId });
					follow?.(turn.conversationId);
				},
			},
		});

		const final: Partial<NotorRunInfo> = {
			...resultFields(result),
			conversationId: stepConversationIds[stepConversationIds.length - 1],
		};
		if (opts.include?.includes("notes")) {
			Object.assign(final, await collectNotesTouched(host, {
				stepConversationIds,
				attachedPaths: attachments.map((a) => a.path),
			}));
		}
		return final;
	}, (info) => applyInclude(info, opts.include));

	if (opts.wait === false) return handle;
	const final = await handle.done;
	return { ...final, done: handle.done };
}

function resultFields(result: CircuitRunResult): Partial<NotorRunInfo> {
	const status = result.status === "error" ? "failed" : result.status;
	return {
		status,
		text: result.text,
		structured: result.structured ?? undefined,
		costUsd: result.subtreeConsumed.costUsd,
		...(status === "completed" ? {} : { error: result.terminal.payload || `Circuit ${result.status}.` }),
		...(status === "failed" ? { errorCode: "run_failed" as const } : {}),
	};
}

/**
 * Follow mode: open the run-tree view on the first saved step, and load each
 * step conversation into the target panel as it's saved.
 */
function makeFollower(host: NotorApiHost, panel: ChatOrchestrator, sessionId: string): (conversationId: string) => void {
	let openedTree = false;
	return (conversationId) => {
		if (!openedTree) {
			openedTree = true;
			void host.openRunTreeView({ sessionId }).catch((e) =>
				log.warn("Couldn't open the run-tree view", { error: String(e) }),
			);
		}
		void panel.switchToConversationById(conversationId).catch((e) =>
			log.warn("Couldn't follow a step conversation", { conversationId, error: String(e) }),
		);
	};
}
