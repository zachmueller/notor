/**
 * `StepPromptBuilder` (FEAT-005) — assembles a conversation step's prompt.
 *
 * The step's raw `bodyContent` is **never** passed to the LLM unwrapped; it is
 * embedded in the `### 1. EXECUTE` section of a structural scaffold
 * (orientation → execute → verify → report → guardrails). The builder **always**
 * injects, regardless of the step's custom instructions:
 *
 *  - the **must-publish rule** (section *3. REPORT*);
 *  - the **objective** (original user prompt, set once at flow start);
 *  - the **incoming event** (topic + payload);
 *  - the **recent event history** (last N);
 *  - the **scratchpad path** (and tasks path), with the **overwrite-only rule**.
 *
 * Flow `guardrails` are injected into `### GUARDRAILS` on **every** step turn.
 *
 * Persona content integrates through the **existing** `SystemPromptBuilder`
 * append/replace mechanism (per the persona's prompt mode); the step scaffold is
 * appended after persona content. This builder does **not** reimplement
 * system-prompt assembly — it produces the *user-message* scaffold (the step
 * instructions + injected sections). `<include_note>` tags in `bodyContent` are
 * resolved by the caller (reusing the existing include-resolution path) and the
 * resolved body is passed in via `resolvedBody`; when omitted, the raw body is
 * embedded verbatim (tags preserved).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-005
 * @see specs/ZZ-misc/orchestration/contracts/event-engine.md — default_publishes synthesis
 */

import { EVENT_HISTORY_PROMPT_LIMIT } from "./constants";
import { FLOW_COMPLETE, type OrchestrationEvent, type OrchestrationFlow, type StepDefinition } from "./types";

export interface StepPromptBuildArgs {
	step: StepDefinition;
	flow: OrchestrationFlow;
	/** The incoming trigger event for this turn. */
	event: OrchestrationEvent;
	/** Recent event history (the builder takes the last {@link EVENT_HISTORY_PROMPT_LIMIT}). */
	eventHistory: OrchestrationEvent[];
	/** The original user objective, set once at flow start, injected every turn. */
	objective: string;
	/** `sessions/{id}/scratchpad/`. */
	scratchpadPath: string;
	/** `sessions/{id}/tasks/`. */
	tasksPath: string;
	/** Current engine iteration (turn number). */
	iteration: number;
	/**
	 * Vault-relative path to the persistent cross-session `memories.md` note
	 * (INT-004 / FR-124). When provided, a `### MEMORY` section is injected on
	 * **every** step turn telling the step where it lives, to consult it before
	 * acting in unfamiliar territory, and to append a fix-memory when blocked and
	 * recovered. Omitted (e.g. in unit tests) → the section is skipped.
	 */
	memoriesPath?: string;
	/**
	 * The step body with `<include_note>` tags already resolved (the caller
	 * reuses the existing include-resolution path). When omitted, the step's raw
	 * `bodyContent` is embedded verbatim (tags preserved).
	 */
	resolvedBody?: string;
	/**
	 * The chaining successor's `notor-flow-inputs` (INT-045 / FR-175). Set only when
	 * this flow has `notor-on-complete-flow` and this step can emit the completion
	 * event (the terminal step): the builder injects a `### HANDOFF` section so the
	 * predecessor shapes its forwarded terminal payload to fit the successor's input
	 * contract — the decoupling injection (the predecessor never hardcodes the
	 * successor). Omitted when there is no chaining successor or the step is not
	 * terminal.
	 */
	onCompleteFlowInputs?: string | null;
}

export class StepPromptBuilder {
	/**
	 * Assemble the step prompt: scaffold + embedded body + injected sections.
	 * The must-publish rule, objective, incoming event, history, and
	 * scratchpad/tasks guidance are present in **every** output regardless of the
	 * step's custom instructions.
	 */
	build(args: StepPromptBuildArgs): string {
		const { step, flow, event, eventHistory, objective, scratchpadPath, tasksPath, iteration } =
			args;
		const body = args.resolvedBody ?? step.bodyContent;

		const sections: string[] = [];

		// --- Orientation -----------------------------------------------------
		sections.push(
			`## ORCHESTRATION STEP: ${step.name}\n` +
				`You are one step in the "${flow.name}" flow (iteration ${iteration}). ` +
				`Steps communicate ONLY by publishing events — never assume the next step shares your ` +
				`conversation context. Use the scratchpad for any state the next step needs.`,
		);

		sections.push(`### OBJECTIVE\n${objective || "(no objective provided)"}`);

		sections.push(
			`### INCOMING EVENT\n` +
				`topic: ${event.topic}\n` +
				`payload: ${event.payload}`,
		);

		sections.push(this.buildHistorySection(eventHistory));

		// --- 1. EXECUTE (the raw step body is embedded ONLY here) ------------
		sections.push(`### 1. EXECUTE\n${body.trim()}`);

		// --- 2. VERIFY -------------------------------------------------------
		sections.push(
			`### 2. VERIFY\n` +
				`Confirm your work satisfies the objective and this step's responsibility before reporting. ` +
				`If verification is part of this flow, ensure it has passed.`,
		);

		// --- 3. REPORT (always-injected must-publish rule) -------------------
		sections.push(this.buildReportSection(step));

		// --- HANDOFF (INT-045): chaining successor input-shaping -------------
		// On a flow with `notor-on-complete-flow`, the terminal step's output is
		// forwarded to the successor instead of returning. Inject the successor's
		// input contract so the predecessor shapes its terminal payload to fit —
		// without hardcoding any successor knowledge (the decoupling injection).
		if (args.onCompleteFlowInputs && this.isTerminalStep(step, flow)) {
			sections.push(
				`### HANDOFF\n` +
					`When this flow completes, its result is handed off to a successor flow ` +
					`(no return to here). Shape the payload you emit with the completion event so it ` +
					`satisfies the successor's expected input:\n${args.onCompleteFlowInputs}`,
			);
		}

		// --- Scratchpad / tasks (overwrite-only rule) ------------------------
		sections.push(this.buildScratchpadSection(scratchpadPath, tasksPath));

		// --- Persistent memory (INT-004 / FR-124), injected every turn -------
		if (args.memoriesPath) {
			sections.push(this.buildMemorySection(args.memoriesPath));
		}

		// --- Guardrails (injected every turn) --------------------------------
		sections.push(this.buildGuardrailsSection(flow));

		return sections.join("\n\n");
	}

	/**
	 * The persistent-memory section (FR-124). Always present when a `memoriesPath`
	 * is supplied — tells the step where cross-session memory lives, to consult it
	 * before acting in unfamiliar territory, and to append a fix-memory when it
	 * gets blocked and recovers. The note is free-form Markdown read/appended
	 * through the step's normal note tools.
	 */
	private buildMemorySection(memoriesPath: string): string {
		return (
			`### MEMORY\n` +
			`Persistent cross-session memory: ${memoriesPath}\n` +
			`CONSULT it before acting in unfamiliar territory (Patterns / Decisions / Fixes / Context). ` +
			`When you get BLOCKED and then recover, APPEND a concise fix-memory under ## Fixes so a future ` +
			`run avoids the same dead-end. Read/append it with your normal note tools.`
		);
	}

	/** A step is "terminal" when it can emit the flow's completion event. */
	private isTerminalStep(step: StepDefinition, flow: OrchestrationFlow): boolean {
		return (
			step.publishes.includes(flow.completionEvent) || step.publishes.includes(FLOW_COMPLETE)
		);
	}

	private buildHistorySection(eventHistory: OrchestrationEvent[]): string {
		const recent = eventHistory.slice(-EVENT_HISTORY_PROMPT_LIMIT);
		if (recent.length === 0) {
			return `### EVENT HISTORY (last ${EVENT_HISTORY_PROMPT_LIMIT})\n(no prior events)`;
		}
		const lines = recent.map(
			(e) => `- ${e.topic} (from ${e.source_step ?? "start"}): ${truncate(e.payload)}`,
		);
		return `### EVENT HISTORY (last ${EVENT_HISTORY_PROMPT_LIMIT})\n${lines.join("\n")}`;
	}

	/**
	 * The must-publish rule. ALWAYS present — even when the step body carries its
	 * own custom instructions (the Phase-1 gate).
	 */
	private buildReportSection(step: StepDefinition): string {
		const allowed = step.publishes.length > 0 ? step.publishes.join(", ") : "(none declared)";
		return (
			`### 3. REPORT\n` +
			`You MUST call the \`emit_event\` tool with exactly one of: {${allowed}}. ` +
			`A narrative summary in your text does NOT count as an emission — only a real \`emit_event\` ` +
			`tool call advances the flow. Emit before ending your turn. ` +
			`If all of the flow's work is done, emit \`${FLOW_COMPLETE}\`.`
		);
	}

	private buildScratchpadSection(scratchpadPath: string, tasksPath: string): string {
		return (
			`### SHARED STATE\n` +
			`Scratchpad: ${scratchpadPath}\n` +
			`Tasks: ${tasksPath}\n` +
			`Write cross-step state to the scratchpad. OVERWRITE-ONLY: always write the COMPLETE current ` +
			`content of a file (or use a per-iteration filename) — never incrementally append, because a ` +
			`crash-recovery re-run would duplicate appended content.`
		);
	}

	private buildGuardrailsSection(flow: OrchestrationFlow): string {
		if (flow.guardrails.length === 0) {
			return `### GUARDRAILS\n(none specified)`;
		}
		const lines = flow.guardrails.map((g) => `- ${g}`);
		return `### GUARDRAILS\n${lines.join("\n")}`;
	}
}

function truncate(s: string, max = 300): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}
