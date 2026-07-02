/**
 * Reference flows (POL-002 / FR-161) — three first-party example flows
 * materialized into `{notor_dir}/orchestrations/` when the user enables the
 * orchestration feature group. They demonstrate the three pillars of the engine —
 * **conversation steps**, **code steps**, and **composition**.
 *
 * These are first-party *examples*, not e2e fixtures (F6 §4.4, verified): no e2e
 * script uses them — all 10 `e2e/scripts/orchestration-*-test.ts` write bespoke
 * inline flows against live Bedrock. The verifiable gate on this content is the
 * unit-level flow-parse test (`reference-flows.test.ts`), which asserts each
 * `materializeReferenceFlows` output parses + validates through
 * `FlowDefinitionParser` with zero errors/warnings. A live-provider e2e for one
 * reference flow (a real TEST-007) remains a separate team decision — the e2e
 * harness has no provider stub today — and is deliberately out of scope here.
 *
 * Lifecycle mirrors the built-in personas: the content lives here as constants and
 * is **materialized on first enable, preserving user edits** ({@link materializeReferenceFlows}
 * never overwrites an existing file). Each flow is authored to pass the FEAT-002
 * load-time validators (reachable completion, single-subscriber topics, no
 * published-but-unsubscribed non-terminal topic, required-events published).
 *
 *  1. `code-assist` — TDD build loop: conversation steps + a code-step verifier
 *     that routes on the test outcome. Invocable (returns a structured summary).
 *  2. `research` — multi-phase research loop ending in a **code step** that emits
 *     `FLOW_COMPLETE` with a **structured** payload (the reliable-returns path).
 *  3. `review` — composition demo: a code step calls `code-assist` via `run_flow`,
 *     then a conversation step composes the final review.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — POL-002
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md
 */

import { logger } from "../utils/logger";

const log = logger("ReferenceFlows");

/** A reference flow: its `definition.md` + a `{stepFileName: body}` map. */
export interface ReferenceFlow {
	/** Directory slug under `{notor_dir}/orchestrations/`. */
	slug: string;
	/** Full `definition.md` content (frontmatter + documentation body). */
	definition: string;
	/** Step note contents keyed by file name (written under `steps/`). */
	steps: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 1. code-assist — conversation steps + a code-step verifier (invocable)
// ---------------------------------------------------------------------------

const CODE_ASSIST: ReferenceFlow = {
	slug: "code-assist",
	definition: `---
notor-type: orchestration-flow
notor-flow-name: "Code Assist"
notor-flow-description: "TDD-style implementation loop: plan, build, verify, review, finalize."
notor-starting-event: build.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 100
notor-max-runtime-minutes: 120
notor-required-events:
  - review.approved
notor-steps:
  - "[[planner]]"
  - "[[builder]]"
  - "[[verify-tests]]"
  - "[[critic]]"
  - "[[finalizer]]"
notor-guardrails:
  - "Verification is mandatory — tests must pass before review."
  - "YAGNI — implement only what the task requires."
notor-flow-invocable: true
notor-flow-inputs: "A natural-language feature description plus the absolute path to the target repo."
notor-flow-returns: "A summary of what was implemented and the list of files changed."
notor-handoff-isolation: isolated
notor-max-depth: 3
notor-max-cost-usd: 5.00
---

# Code Assist

A TDD-style implementation loop. Provide a feature description and the target repo
path as the objective. The flow plans the work, implements it, verifies with the
test suite (a deterministic code step), reviews, and finalizes.

(This body is documentation only — it is never injected into a step's prompt.)
`,
	steps: {
		"planner.md": `---
notor-type: orchestration-step
notor-step-name: "📋 Planner"
notor-step-description: "Decomposes the objective and owns the task queue."
notor-step-triggers:
  - build.start
  - tests.failed
notor-step-publishes:
  - build.ready
notor-step-default-publishes: build.ready
notor-step-persona: null
---

## PLANNER MODE

You own decomposition and the task queue. Do **not** implement; do **not** review.

1. Read \`plan.md\` and \`progress.md\` from the session scratchpad (if present).
2. Break the objective into discrete, testable tasks with \`orchestration_task_ensure\`.
3. Write the complete plan to \`plan.md\` in the scratchpad (overwrite the whole file — never append).
4. Emit \`build.ready\` with the next task and the repo path as the payload.
`,
		"builder.md": `---
notor-type: orchestration-step
notor-step-name: "🛠️ Builder"
notor-step-description: "Implements the next task against the repo."
notor-step-triggers:
  - build.ready
notor-step-publishes:
  - build.done
notor-step-default-publishes: build.done
notor-step-persona: null
---

## BUILDER MODE

Implement the next task. Mark it \`orchestration_task_start\` before you begin and
\`orchestration_task_close\` when done.

1. Read \`plan.md\` from the scratchpad to see the planned work.
2. Implement the change in the target repo (the repo path is in the incoming event payload).
3. When the implementation is complete, emit \`build.done\` with the repo path as the payload.
`,
		"verify-tests.md": `---
notor-type: orchestration-step
notor-step-name: "🔍 Verify Tests"
notor-step-description: "Runs the test suite and routes deterministically on the result."
notor-step-mode: code
notor-step-triggers:
  - build.done
notor-step-publishes:
  - tests.passed
  - tests.failed
notor-step-default-publishes: tests.failed
---

# Verify Tests

Runs the test suite and routes on the exit code — the canonical "replaces verification
steps" code step. Replaces a pass/fail verification step with arbitrary deterministic logic.

\`\`\`typescript
// The builder forwarded the repo path as the event payload.
const repoPath = event.payload;

const result = await utils.executeShellCommand("npm test", {
  cwd: repoPath,
  timeoutSeconds: 120,
});

// ShellExecuteResult.stdout is COMBINED stdout+stderr (no separate stderr field).
if (result.exitCode === 0 && !result.timedOut) {
  await orchestration.scratchpad.write("last-test-run.txt", result.stdout);
  return orchestration.emit("tests.passed", repoPath);
}

// Failure: forward the full context so the planner can re-plan a fix.
return orchestration.emit(
  "tests.failed",
  JSON.stringify({ exitCode: result.exitCode, timedOut: result.timedOut, output: result.stdout }),
);
\`\`\`
`,
		"critic.md": `---
notor-type: orchestration-step
notor-step-name: "🧐 Critic"
notor-step-description: "Adversarial review of the implementation."
notor-step-triggers:
  - tests.passed
notor-step-publishes:
  - review.approved
notor-step-default-publishes: review.approved
notor-step-persona: null
---

## CRITIC MODE

Adversarially review the implementation. Do **not** write code.

1. Inspect the changed files in the repo (the path is in the incoming event payload).
2. Check correctness, edge cases, and that the work matches the objective.
3. When satisfied, emit \`review.approved\` with a one-line verdict as the payload.
`,
		"finalizer.md": `---
notor-type: orchestration-step
notor-step-name: "✅ Finalizer"
notor-step-description: "Closes remaining tasks and completes the flow with a structured summary."
notor-step-mode: code
notor-step-triggers:
  - review.approved
notor-step-publishes:
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

# Finalizer

Closes any lingering tasks and completes the flow, returning a **structured** summary
(the reliable-returns path for a \`run_flow\` caller).

\`\`\`typescript
// Close any still-open/running tasks so FLOW_COMPLETE enforcement passes.
const open = await orchestration.tasks.list({ status: "open" });
const running = await orchestration.tasks.list({ status: "running" });
for (const t of [...open, ...running]) {
  await orchestration.tasks.close(t.key);
}

const plan = (await orchestration.scratchpad.read("plan.md")) ?? "";
const summary = "Implementation complete and reviewed.";

// Terminal code step → the 3rd arg is lifted onto the run's structured return.
return orchestration.emit("FLOW_COMPLETE", summary, {
  summary,
  plan,
});
\`\`\`
`,
	},
};

// ---------------------------------------------------------------------------
// 2. research — conversation steps + a structured-return terminal code step
// ---------------------------------------------------------------------------

const RESEARCH: ReferenceFlow = {
	slug: "research",
	definition: `---
notor-type: orchestration-flow
notor-flow-name: "Research"
notor-flow-description: "Multi-phase research loop: explore, synthesize, verify, summarize."
notor-starting-event: research.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 60
notor-max-runtime-minutes: 60
notor-required-events:
  - synthesize.done
notor-steps:
  - "[[explore]]"
  - "[[synthesize]]"
  - "[[verify]]"
  - "[[summarize]]"
notor-guardrails:
  - "Cite a source for every factual claim."
  - "Write findings to the scratchpad — never rely on conversation context."
notor-flow-invocable: true
notor-flow-inputs: "A single research question as a plain string."
notor-flow-returns: "A short markdown report with at least one cited source per angle."
notor-handoff-isolation: isolated
notor-max-depth: 2
notor-max-cost-usd: 3.00
---

# Research

Give it a research question as the objective. The flow plans angles, gathers findings
into the scratchpad, verifies something was gathered, then a terminal **code step**
emits the completion event with a **structured** report (so a \`run_flow\` caller
receives \`structured\`, not loose text).

(This body is documentation only.)
`,
	steps: {
		"explore.md": `---
notor-type: orchestration-step
notor-step-name: "🔭 Explore"
notor-step-description: "Plans research angles and gathers initial findings."
notor-step-triggers:
  - research.start
notor-step-publishes:
  - explore.done
notor-step-default-publishes: explore.done
notor-step-persona: null
---

## EXPLORE MODE

1. Decompose the research question into 2–4 angles.
2. Use \`web_search\` / \`fetch_webpage\` to gather initial findings for each angle.
3. Write the **complete** findings set (with sources) to \`findings.md\` in the scratchpad —
   overwrite the whole file; do not append.
4. Emit \`explore.done\` with a one-line summary as the payload.
`,
		"synthesize.md": `---
notor-type: orchestration-step
notor-step-name: "🧪 Synthesize"
notor-step-description: "Synthesizes findings into a coherent draft."
notor-step-triggers:
  - explore.done
notor-step-publishes:
  - synthesize.done
notor-step-default-publishes: synthesize.done
notor-step-persona: null
---

## SYNTHESIZE MODE

1. Read \`findings.md\` from the scratchpad.
2. Synthesize the findings into a coherent draft, resolving contradictions.
3. Write the draft to \`draft.md\` in the scratchpad (overwrite the whole file).
4. Emit \`synthesize.done\` with a one-line summary as the payload.
`,
		"verify.md": `---
notor-type: orchestration-step
notor-step-name: "✅ Verify Findings"
notor-step-description: "Verifies findings were actually gathered before summarizing."
notor-step-mode: code
notor-step-triggers:
  - synthesize.done
notor-step-publishes:
  - verify.passed
  - FLOW_CANCELLED
notor-step-default-publishes: FLOW_CANCELLED
---

# Verify Findings

Routes to the summarizer only if the scratchpad actually has findings; otherwise cancels
(bypassing completion-task enforcement).

\`\`\`typescript
const findings = await orchestration.scratchpad.read("findings.md");
if (!findings || findings.trim().length === 0) {
  return orchestration.emit("FLOW_CANCELLED", "No findings were gathered — nothing to summarize.");
}
return orchestration.emit("verify.passed", JSON.stringify({ bytes: findings.length }));
\`\`\`
`,
		"summarize.md": `---
notor-type: orchestration-step
notor-step-name: "📝 Summarize"
notor-step-description: "Emits the final report as a structured terminal return."
notor-step-mode: code
notor-step-triggers:
  - verify.passed
notor-step-publishes:
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

# Summarize

Reads the synthesized draft and completes the flow with a **structured** report — the
reliable-returns path a \`run_flow\` caller prefers over loose text.

\`\`\`typescript
const draft = (await orchestration.scratchpad.read("draft.md")) ?? "";
const findings = (await orchestration.scratchpad.read("findings.md")) ?? "";

return orchestration.emit("FLOW_COMPLETE", "Research complete.", {
  report: draft,
  findings,
});
\`\`\`
`,
	},
};

// ---------------------------------------------------------------------------
// 3. review — composition demo (run_flow caller) + a report step
// ---------------------------------------------------------------------------

const REVIEW: ReferenceFlow = {
	slug: "review",
	definition: `---
notor-type: orchestration-flow
notor-flow-name: "Review"
notor-flow-description: "Composition demo: dispatch a child flow via run_flow, then compose a report."
notor-starting-event: review.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 40
notor-max-runtime-minutes: 120
notor-required-events:
  - dispatch.done
notor-steps:
  - "[[dispatch]]"
  - "[[report]]"
notor-guardrails:
  - "Base the report only on the child flow's actual returned result."
notor-flow-invocable: false
notor-max-depth: 3
notor-max-cost-usd: 8.00
---

# Review

Demonstrates **composition** (the \`run_flow\` caller side). A code-step \`dispatch\`
invokes the \`Code Assist\` flow via \`run_flow\` and writes its result to the scratchpad;
a conversation \`report\` step then composes the final review from that result.

Requires \`Code Assist\` to be invocable (it is, by default).

(This body is documentation only.)
`,
	steps: {
		"dispatch.md": `---
notor-type: orchestration-step
notor-step-name: "🚚 Dispatch"
notor-step-description: "Invokes the Code Assist child flow via run_flow."
notor-step-mode: code
notor-step-triggers:
  - review.start
notor-step-publishes:
  - dispatch.done
notor-step-default-publishes: dispatch.done
---

# Dispatch

Invokes the \`Code Assist\` flow as a child via \`run_flow\` (a child session on a child
run-loop), then forwards its result to the report step via the scratchpad.

\`\`\`typescript
// run_flow is orchestration-context-only; here we are inside a flow step, so it spawns
// a child run. The child's result (structured preferred, else text) comes back as text.
const childResult = await orchestration.callTool("run_flow", {
  flow: "Code Assist",
  payload: event.payload, // the feature description + repo path forwarded from review.start
});

await orchestration.scratchpad.write("child-result.md", childResult);
return orchestration.emit("dispatch.done", "Child flow returned.");
\`\`\`
`,
		"report.md": `---
notor-type: orchestration-step
notor-step-name: "🧾 Report"
notor-step-description: "Composes the final review from the child flow's result."
notor-step-triggers:
  - dispatch.done
notor-step-publishes:
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
notor-step-persona: null
---

## REPORT MODE

1. Read \`child-result.md\` from the scratchpad — this is the \`Code Assist\` child flow's
   returned result.
2. Compose a concise review of what the child flow accomplished.
3. Emit \`FLOW_COMPLETE\` with your review as the payload.
`,
	},
};

/** The three first-party reference flows (FR-161). */
export const REFERENCE_FLOWS: readonly ReferenceFlow[] = [CODE_ASSIST, RESEARCH, REVIEW];

/** Minimal durable FS surface the materializer needs (vault adapter in production). */
export interface ReferenceFlowFs {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	write(path: string, data: string): Promise<void>;
}

/**
 * Materialize the reference flows under `{notorDir}/orchestrations/` (POL-002).
 * **Idempotent + edit-preserving**: a flow file that already exists is never
 * overwritten (mirrors the built-in-persona "materialize-on-enable, preserve-user-
 * edits" lifecycle), so re-enabling the feature group is safe. Returns the slugs
 * that were freshly written.
 */
export async function materializeReferenceFlows(
	notorDir: string,
	fs: ReferenceFlowFs,
): Promise<string[]> {
	const root = `${notorDir.replace(/\/+$/, "")}/orchestrations`;
	const written: string[] = [];

	for (const flow of REFERENCE_FLOWS) {
		const flowDir = `${root}/${flow.slug}`;
		const stepsDir = `${flowDir}/steps`;
		try {
			if (!(await fs.exists(flowDir))) await fs.mkdir(flowDir);
			if (!(await fs.exists(stepsDir))) await fs.mkdir(stepsDir);

			const defPath = `${flowDir}/definition.md`;
			let touched = false;
			if (!(await fs.exists(defPath))) {
				await fs.write(defPath, flow.definition);
				touched = true;
			}
			for (const [fileName, body] of Object.entries(flow.steps)) {
				const stepPath = `${stepsDir}/${fileName}`;
				if (!(await fs.exists(stepPath))) {
					await fs.write(stepPath, body);
					touched = true;
				}
			}
			if (touched) written.push(flow.slug);
		} catch (e) {
			log.warn("Failed to materialize reference flow", { slug: flow.slug, error: String(e) });
		}
	}

	if (written.length > 0) {
		log.info("Materialized reference flows", { written });
	}
	return written;
}
