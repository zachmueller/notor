/**
 * LLM judge runner — executes one `notor-eval-mode: conversation` evaluator
 * against one finished session.
 *
 * Built on the same layers a conversation step uses (`assembleStepDispatcher`,
 * `resolvePersonaProviderConfig`, `RunLoop`) but NOT on `StepTurnExecutor`,
 * whose prompt scaffold hardwires `emit_event`. The judge:
 *
 *  - is a **persona** (`notor-eval-persona`) or a **sub-agent profile**
 *    (`notor-eval-subagent`), or neither (the active provider/model);
 *  - runs in **Plan mode** with the circuit control tools disabled
 *    ({@link JUDGE_DISABLED_TOOLS}) and `submit_score` force-enabled, so it can
 *    read the vault but never mutate it, advance a circuit, or prompt for
 *    approval;
 *  - reports through `submit_score`, captured on the carriage's `evaluation`
 *    slot and validated post-turn. A judge that ends without calling it gets one
 *    reminder re-run, then fails with `no_score`.
 *
 * Cost is drawn from the pass budget the caller supplies (a fresh cell per
 * pass); `RunLoop` decrements it itself because `settings` is passed.
 */

import { resolvePersonaProviderConfig, type ModelPreferences } from "../../personas/provider-config-resolver";
import { RunLoop } from "../../run-loop/run-loop";
import type { AggregateBudget, OrchestrationToolContext, RunLoopOptions, RunResult } from "../../run-loop/types";
import { SUB_AGENT_PREAMBLE } from "../../sub-agents/preamble";
import type { SubAgentProfile } from "../../sub-agents/types";
import { intersectToolConfig } from "../../tool-config/merger";
import type { EffectiveToolConfig, ParsedToolConfig, ResolvedToolConfigEntry } from "../../tool-config/types";
import type { ToolPolicyContext } from "../../chat/tool-policy";
import type { Persona } from "../../types";
import { logger } from "../../utils/logger";
import { resolveNote } from "../../utils/resolve-note";
import type { CircuitHost } from "../host";
import { assembleStepDispatcher, buildToolDefinitions } from "../launch-wiring";
import type { EvaluatorDefinition } from "../types";
import { buildJudgePrompt } from "./judge-prompt";
import { validateScores } from "./score-validation";
import type { EvalFailureReason, EvalInput, EvaluatorOutcome } from "./types";

const log = logger("CircuitJudge");

/** Per-judge LLM turn cap (a judge reads a little and scores once). */
export const JUDGE_ITERATION_CAP = 8;

/** The tool a judge reports through. */
export const SUBMIT_SCORE_TOOL = "submit_score";

/**
 * Tools a judge must never reach, even though several are `read`-mode and so
 * survive Plan mode: circuit control (`emit_event`, the task tools), nesting
 * (`run_circuit`, `invoke_workflow`, `use_subagent`), the interactive pause
 * (`ask_user`), and memory writes.
 */
export const JUDGE_DISABLED_TOOLS: readonly string[] = [
	"emit_event",
	"circuit_task_ensure",
	"circuit_task_start",
	"circuit_task_close",
	"circuit_task_list",
	"run_circuit",
	"run_flow",
	"invoke_workflow",
	"use_subagent",
	"ask_user",
	"capture_memory",
];

export interface JudgeRunArgs {
	evaluator: EvaluatorDefinition;
	input: EvalInput;
	/** The evaluator body with `<include_note>` tags resolved. */
	resolvedBody: string;
	/** The rubric note body, or `null`. */
	rubric: string | null;
	/** The pass budget cell (shared by every judge in the pass). */
	budget: AggregateBudget;
	abortSignal: AbortSignal;
	/** The evaluated session's directory (its scratchpad is readable by the judge). */
	sessionDir: string;
	onProgress?: (status: string) => void;
}

/** Test seam: construct the run loop (defaults to the real `RunLoop`). */
export interface JudgeRunnerDeps {
	createRunLoop?: (options: RunLoopOptions) => { run(prompt: string): Promise<RunResult> };
}

function defaultEntry(): ResolvedToolConfigEntry {
	return {
		enabled: true,
		auto_approve: true,
		allowed_paths: [],
		blocked_paths: [],
		allowed_command_patterns: [],
		blocked_command_patterns: [],
		auto_approve_paths: [],
		never_auto_approve_paths: [],
		path_scopes: {},
	};
}

/**
 * Narrow a resolved effective config to the judge toolset: disable
 * {@link JUDGE_DISABLED_TOOLS}, force `submit_score` on and auto-approved.
 * Returns a new config (the input is not mutated).
 */
export function judgeToolConfig(effective: EffectiveToolConfig): EffectiveToolConfig {
	const tools: Record<string, ResolvedToolConfigEntry> = { ...effective.tools };
	for (const name of JUDGE_DISABLED_TOOLS) {
		if (tools[name]) tools[name] = { ...tools[name], enabled: false };
	}
	tools[SUBMIT_SCORE_TOOL] = { ...(tools[SUBMIT_SCORE_TOOL] ?? defaultEntry()), enabled: true, auto_approve: true };
	return { tools };
}

export async function runJudge(
	host: CircuitHost,
	args: JudgeRunArgs,
	deps: JudgeRunnerDeps = {},
): Promise<EvaluatorOutcome> {
	const { evaluator, input, budget, abortSignal } = args;
	let modelId: string | null = null;
	let costUsd = 0;
	const fail = (reason: EvalFailureReason, detail: string): EvaluatorOutcome => ({
		evaluator: evaluator.name,
		mode: "conversation",
		ok: false,
		reason,
		detail,
		costUsd,
		modelId,
	});

	// (1) Judge identity: a persona, a sub-agent profile, or neither.
	let persona: Persona | null = null;
	let profile: SubAgentProfile | null = null;
	if (evaluator.persona) {
		persona = await host.getPersonaManager().getPersonaByName(evaluator.persona);
		if (!persona) return fail("unresolved_persona", `persona '${evaluator.persona}' not found`);
	} else if (evaluator.subagent) {
		const manager = host.getSubAgentManager?.();
		if (!manager) return fail("unresolved_subagent", "this host has no sub-agent manager");
		profile = await manager.getProfile(evaluator.subagent, host.getToolRegistry().getNames());
		if (!profile) return fail("unresolved_subagent", `sub-agent profile '${evaluator.subagent}' not found`);
	}

	// (2) Model, pinned without touching the global registry.
	const prefs: ModelPreferences | null = persona ?? profile;
	const resolved = resolvePersonaProviderConfig(prefs, evaluator.model, host.settings, host.getProviderRegistry());
	modelId = resolved.modelId;

	// (3) Budget pre-check: never start a judge the pass cannot pay for.
	if (budget.costRemainingUsd <= 0) return fail("budget", "the evaluation budget is exhausted");
	if (abortSignal.aborted) return fail("aborted", "evaluation cancelled");

	// (4) Runtime: the same dispatcher assembly a conversation step uses, then
	//     narrowed to the judge toolset.
	const registry = host.getToolRegistry();
	if (!registry.get(SUBMIT_SCORE_TOOL)) {
		return fail("error", "the submit_score tool is not registered (is the Circuits feature group enabled?)");
	}
	let dispatcher: Awaited<ReturnType<typeof assembleStepDispatcher>>["dispatcher"];
	let effective: EffectiveToolConfig;
	try {
		const assembled = await assembleStepDispatcher(host, { persona, openNotesInEditor: false, policy: { mode: "plan" } });
		dispatcher = assembled.dispatcher;
		effective = assembled.effective;
	} catch (e) {
		return fail("error", `could not assemble the judge runtime: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (profile) {
		// A sub-agent judge honors its profile's tool config, intersected with the
		// host's effective config exactly as `utils.runSubAgent` does.
		const merged: ParsedToolConfig = {
			source: "subagent",
			sourceFile: profile.system_prompt_path,
			documentPosition: 0,
			tools: {},
		};
		for (const config of profile.tool_configs) Object.assign(merged.tools, config.tools);
		const toolModes: Record<string, "read" | "write"> = {};
		for (const tool of registry.getAll()) toolModes[tool.name] = tool.mode;
		effective = intersectToolConfig(effective, merged, toolModes);
	}
	effective = judgeToolConfig(effective);
	const toolDefinitions = buildToolDefinitions(registry.getAll(), effective);

	let provider: RunLoopOptions["provider"];
	try {
		provider = host.getProviderRegistry().getProvider(resolved.providerId);
	} catch (e) {
		return fail("error", `provider '${resolved.providerId}' is not configured: ${e instanceof Error ? e.message : String(e)}`);
	}

	const settings = host.settings;
	const systemPrompt = profile
		? `${SUB_AGENT_PREAMBLE}\n${profile.prompt_content}`
		: await host
				.getSystemPromptBuilder()
				.assemble("plan", toolDefinitions, undefined, undefined, persona, settings.memory_enabled, null, settings.enable_popover_references);

	const carriage: OrchestrationToolContext = {
		sessionId: input.session.sessionId,
		scratchpadPath: `${args.sessionDir}/scratchpad`,
		tasksPath: `${args.sessionDir}/tasks`,
		pendingEmission: null,
		emissionOverwrites: [],
		evaluation: { evaluatorName: evaluator.name, dimensions: evaluator.dimensions, pendingScore: null },
	};

	const policyCtx: ToolPolicyContext = {
		effectiveConfig: effective,
		mode: "plan",
		domainDenylist: settings.domain_denylist,
		vaultRootPath: host.vaultRootPath ?? "",
		resolveVaultPath: (p: string) => resolveNote(p, host.app.vault, host.app.metadataCache)?.path ?? null,
		sessionAllowedPaths: [carriage.scratchpadPath],
		// The toolset is read-only + submit_score, so every allowed call is
		// approved: a judge must never block a manual or scheduled pass on a modal.
		approvalOverride: "auto",
	};

	const createRunLoop = deps.createRunLoop ?? ((options: RunLoopOptions) => new RunLoop(options));
	const attempt = async (reminder: boolean): Promise<RunResult> => {
		const runLoop = createRunLoop({
			provider,
			model: resolved.modelId,
			systemPrompt,
			toolDefinitions,
			dispatcher,
			mode: "plan",
			iterationCap: profile?.iteration_cap ?? JUDGE_ITERATION_CAP,
			thinkingLevel: profile?.thinking_level ?? resolved.thinkingLevel,
			settings,
			runContext: {
				depth: 0,
				maxDepth: 0,
				budget,
				subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: 0 },
				abort: abortSignal,
			},
			orchestrationContext: carriage,
			policyCtx,
			hooks: {
				onTurnComplete: (_turn, outcome) => {
					costUsd += outcome.costUsd;
				},
				onProgress: args.onProgress,
			},
			onProgress: args.onProgress,
		});
		return runLoop.run(buildJudgePrompt({ evaluator, resolvedBody: args.resolvedBody, rubric: args.rubric, input, reminder }));
	};

	const classify = (result: RunResult): EvaluatorOutcome | null => {
		const reason = String(result.stopReason);
		if (reason === "cost_cap") return fail("budget", "the evaluation budget ran out mid-judgement");
		if (reason === "cancelled") return fail("aborted", "evaluation cancelled");
		if (reason === "error") return fail("error", result.errorMessage ?? result.text ?? "provider error");
		return null;
	};

	let result: RunResult;
	try {
		result = await attempt(false);
	} catch (e) {
		return fail("error", e instanceof Error ? e.message : String(e));
	}
	let failure = classify(result);
	if (!failure && !carriage.evaluation!.pendingScore) {
		// One reminder re-run, budget permitting.
		if (budget.costRemainingUsd <= 0) {
			failure = fail("budget", "the judge ended without a score and the budget is exhausted");
		} else if (abortSignal.aborted) {
			failure = fail("aborted", "evaluation cancelled");
		} else {
			log.info("Judge ended without submit_score; re-running once with a reminder", { evaluator: evaluator.name });
			try {
				result = await attempt(true);
				failure = classify(result);
			} catch (e) {
				failure = fail("error", e instanceof Error ? e.message : String(e));
			}
		}
	}
	if (failure) return failure;

	const pending = carriage.evaluation!.pendingScore;
	if (!pending) return fail("no_score", "the judge ended without calling submit_score");
	const validation = validateScores(evaluator.dimensions, pending);
	if (!validation.ok) return fail("invalid_score", validation.errors.join("; "));

	return {
		evaluator: evaluator.name,
		mode: "conversation",
		ok: true,
		scores: validation.value.scores,
		rationale: validation.value.rationale,
		overall: validation.value.overall ?? null,
		costUsd,
		modelId,
	};
}
