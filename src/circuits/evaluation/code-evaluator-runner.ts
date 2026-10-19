/**
 * Code evaluator runner — executes one `notor-eval-mode: code` evaluator
 * against one finished session.
 *
 * Same compile pipeline as a code step (`extractCodeFence` → `stripTypes` →
 * `compileFunction`), same `utils` / `libs` / `obsidian` objects (via the
 * code-step runtime factory in Plan mode), but a different argument list
 * ({@link CODE_EVALUATOR_ARG_NAMES}): the snippet receives the `input` bundle
 * and an `evaluation` helper, and must `return { scores, rationale, overall? }`.
 * Deterministic, zero tokens, not budget-gated.
 *
 * Deliberately not `buildCircuitHelper`: that helper needs a `SessionLog` and
 * would let the snippet write `step.log` lines into the evaluated run's log, or
 * emit events into a circuit that has already finished.
 */

import { compileFunction, stripTypes } from "../../extensions/compiler";
import { extractCodeFence } from "../../extensions/parser";
import type { ToolDispatcher } from "../../chat/dispatcher";
import type { ToolPolicyContext } from "../../chat/tool-policy";
import { newRootBudget } from "../../run-loop/budget";
import type { OrchestrationToolContext, RunContext } from "../../run-loop/types";
import { logger, type Logger } from "../../utils/logger";
import { withTimeout } from "../../utils/with-timeout";
import type { ScratchpadFs } from "../circuit-helper";
import { DEFAULT_CODE_STEP_TIMEOUT_SECONDS } from "../constants";
import type { CircuitHost } from "../host";
import { makeCodeStepRuntimeFactory } from "../launch-wiring";
import type { SessionLogEntry } from "../session-log";
import type { EvalDimension, EvaluatorDefinition, StepDefinition } from "../types";
import { validateScores } from "./score-validation";
import type { EvalFailureReason, EvalInput, EvaluatorOutcome } from "./types";

const log = logger("CircuitCodeEvaluator");

/** The compiled snippet's argument names, in order. */
export const CODE_EVALUATOR_ARG_NAMES = ["app", "obsidian", "utils", "libs", "input", "evaluation"] as const;

/** The `evaluation` helper a code evaluator receives (sixth argument). */
export interface CodeEvaluationHelper {
	/** The evaluator's declared dimensions. */
	dimensions: EvalDimension[];
	/** Dispatch a registered built-in tool by name (Plan mode: read tools only). */
	callTool(toolName: string, params: Record<string, unknown>): Promise<string>;
	/** Dispatch a tool on a connected MCP server. */
	callMcpTool(serverName: string, toolName: string, params: Record<string, unknown>): Promise<string>;
	/** The evaluated session (read-only). */
	session: {
		id: string;
		dir: string;
		scratchpad: {
			read(file: string): Promise<string | null>;
			list(): Promise<string[]>;
			exists(file: string): Promise<boolean>;
		};
		/** The session's parsed `session-log.jsonl`. */
		readLog(): Promise<SessionLogEntry[]>;
	};
	log: Logger;
}

/** The per-run runtime a code evaluator executes against (a code-step runtime minus tasks / once()). */
export interface CodeEvaluatorRuntime {
	app: unknown;
	obsidian: unknown;
	utils: unknown;
	libs: unknown;
	dispatcher: ToolDispatcher;
	scratchpadFs: ScratchpadFs;
	policyCtx: ToolPolicyContext;
}

export interface CodeEvaluatorRuntimeFactory {
	build(args: { orchestrationContext: OrchestrationToolContext; abortSignal: AbortSignal }): Promise<CodeEvaluatorRuntime>;
}

/** The real factory: the code-step runtime in Plan mode, with no `once()` ledger. */
export function makeCodeEvaluatorRuntimeFactory(host: CircuitHost): CodeEvaluatorRuntimeFactory {
	const inner = makeCodeStepRuntimeFactory(host, new Set<string>(), false, { mode: "plan" });
	return {
		async build({ orchestrationContext, abortSignal }) {
			const step: StepDefinition = {
				name: orchestrationContext.evaluation?.evaluatorName ?? "evaluator",
				description: "",
				triggers: [],
				publishes: [],
				defaultPublishes: null,
				persona: null,
				model: null,
				mode: "code",
				mcpServers: null,
				timeoutSeconds: null,
				bodyContent: "",
				notePath: "",
			};
			const rt = await inner.build({ step, orchestrationContext, mode: "plan", abortSignal });
			return {
				app: rt.app,
				obsidian: rt.obsidian,
				utils: rt.utils,
				libs: rt.libs,
				dispatcher: rt.dispatcher,
				scratchpadFs: rt.scratchpadFs,
				policyCtx: rt.policyCtx,
			};
		},
	};
}

export interface CodeEvaluatorRunArgs {
	evaluator: EvaluatorDefinition;
	input: EvalInput;
	sessionDir: string;
	abortSignal: AbortSignal;
	runtimeFactory: CodeEvaluatorRuntimeFactory;
	readLog: () => Promise<SessionLogEntry[]>;
}

function buildHelper(args: {
	evaluator: EvaluatorDefinition;
	input: EvalInput;
	sessionDir: string;
	runtime: CodeEvaluatorRuntime;
	carriage: OrchestrationToolContext;
	runContext: RunContext;
	readLog: () => Promise<SessionLogEntry[]>;
}): CodeEvaluationHelper {
	const { runtime, carriage, runContext } = args;
	const scratchpadDir = carriage.scratchpadPath.replace(/\/+$/, "");
	const scratchpadPathFor = (file: string): string => {
		const clean = file.replace(/^\/+/, "");
		if (!clean || clean.includes("..") || clean.includes("\\")) {
			throw new Error(`Invalid scratchpad file name: "${file}"`);
		}
		return `${scratchpadDir}/${clean}`;
	};
	let counter = 0;
	const callTool = async (toolName: string, params: Record<string, unknown>): Promise<string> => {
		const result = await runtime.dispatcher.dispatch(
			toolName,
			params,
			"plan",
			`eval-${args.evaluator.name}-${++counter}`,
			runContext.abort,
			undefined,
			runtime.policyCtx,
			undefined,
			undefined,
			undefined,
			undefined,
			runContext,
			carriage,
		);
		if (!result.success) throw new Error(`Tool '${toolName}' failed: ${result.error ?? "unknown dispatch error"}`);
		return typeof result.result === "string" ? result.result : JSON.stringify(result.result);
	};
	return {
		dimensions: args.evaluator.dimensions,
		callTool,
		callMcpTool: (serverName, toolName, params) => callTool(`${serverName}__${toolName}`, params),
		session: {
			id: args.input.session.sessionId,
			dir: args.sessionDir,
			scratchpad: {
				read: (file) => runtime.scratchpadFs.read(scratchpadPathFor(file)),
				exists: (file) => runtime.scratchpadFs.exists(scratchpadPathFor(file)),
				list: async () => {
					const paths = await runtime.scratchpadFs.list(scratchpadDir);
					return paths.map((p) => p.slice(p.lastIndexOf("/") + 1));
				},
			},
			readLog: args.readLog,
		},
		log: logger(`CodeEvaluator:${args.evaluator.name}`),
	};
}

export async function runCodeEvaluator(args: CodeEvaluatorRunArgs): Promise<EvaluatorOutcome> {
	const { evaluator, input, abortSignal } = args;
	const fail = (reason: EvalFailureReason, detail: string): EvaluatorOutcome => ({
		evaluator: evaluator.name,
		mode: "code",
		ok: false,
		reason,
		detail,
		costUsd: 0,
		modelId: null,
	});
	if (abortSignal.aborted) return fail("aborted", "evaluation cancelled");

	const fence = extractCodeFence(evaluator.bodyContent);
	if (!fence) return fail("error", "the evaluator note has no ts/js code fence");

	let fn: (...fnArgs: unknown[]) => Promise<unknown>;
	try {
		fn = compileFunction([...CODE_EVALUATOR_ARG_NAMES], stripTypes(fence.code)) as typeof fn;
	} catch (e) {
		return fail("error", `compile error: ${e instanceof Error ? e.message : String(e)}`);
	}

	const carriage: OrchestrationToolContext = {
		sessionId: input.session.sessionId,
		scratchpadPath: `${args.sessionDir}/scratchpad`,
		tasksPath: `${args.sessionDir}/tasks`,
		pendingEmission: null,
		emissionOverwrites: [],
		evaluation: { evaluatorName: evaluator.name, dimensions: evaluator.dimensions, pendingScore: null },
	};
	const runContext: RunContext = {
		depth: 0,
		maxDepth: 0,
		budget: newRootBudget(),
		subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: 0 },
		abort: abortSignal,
	};

	let returned: unknown;
	try {
		const runtime = await args.runtimeFactory.build({ orchestrationContext: carriage, abortSignal });
		const helper = buildHelper({ evaluator, input, sessionDir: args.sessionDir, runtime, carriage, runContext, readLog: args.readLog });
		const timeoutSeconds = evaluator.timeoutSeconds ?? DEFAULT_CODE_STEP_TIMEOUT_SECONDS;
		returned = await withTimeout(
			() => fn(runtime.app, runtime.obsidian, runtime.utils, runtime.libs, input, helper),
			timeoutSeconds * 1000,
		);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		const isTimeout = (e instanceof Error && e.name === "ExtensionTimeoutError") || /timed out/i.test(message);
		log.warn("Code evaluator failed", { evaluator: evaluator.name, error: message });
		return fail(isTimeout ? "timeout" : "error", message);
	}

	const validation = validateScores(evaluator.dimensions, returned);
	if (!validation.ok) return fail("invalid_score", validation.errors.join("; "));
	return {
		evaluator: evaluator.name,
		mode: "code",
		ok: true,
		scores: validation.value.scores,
		rationale: validation.value.rationale,
		overall: validation.value.overall ?? null,
		costUsd: 0,
		modelId: null,
	};
}
