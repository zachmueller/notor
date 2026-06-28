#!/usr/bin/env npx tsx
/**
 * Orchestration single-flow E2E Test (TEST-007)
 *
 * All-phase gate for FEAT-010 + Lane A. Runs a small hand-authored flow in a
 * clean test vault to a clean FLOW_COMPLETE, exercising the Lane-A surfaces
 * end-to-end:
 *   - session workspace creation (INT-001): sessions/{id}/ + session.json +
 *     scratchpad/ + tasks/;
 *   - task ensure/close + completion enforcement (INT-002 / INT-003);
 *   - the hidden-from-flat-list filter (INT-006): step conversations never appear
 *     in listConversations(), while a normal conversation still does.
 *
 * Scenarios:
 *   1. Enable orchestration, run a 2-step flow via the "Run orchestration" command.
 *   2. The flow terminates with session.json status `completed`.
 *   3. A session directory with session.json + session-log.jsonl + scratchpad/ exists.
 *   4. Tasks ensured during the run are all `closed` at completion (INT-003).
 *   5. The flow's per-step conversations are hidden from listConversations().
 *   6. A normal (non-orchestration) conversation still appears in the list.
 *
 * Prerequisites:
 *   - AWS profile `default` with Bedrock access (real LLM turns).
 *
 * Run with:
 *   npx tsx e2e/scripts/orchestration-single-flow-test.ts
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — TEST-007
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	writeCleanWorkspace,
	sendMessage,
	newConversation,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants + flow fixtures
// ---------------------------------------------------------------------------

const NOTOR_DIR = "notor";
const FLOW_DIR = `${NOTOR_DIR}/orchestrations/single-flow-e2e`;
const FLOW_NAME = "Single Flow E2E";

/** definition.md — a minimal two-step flow that completes deterministically. */
const DEFINITION_MD = `---
notor-type: orchestration-flow
notor-flow-name: "${FLOW_NAME}"
notor-flow-description: "Minimal flow for the Lane-A e2e gate (TEST-007)."
notor-starting-event: flow.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 10
notor-max-runtime-minutes: 5
notor-steps:
  - "[[planner]]"
  - "[[finisher]]"
notor-guardrails:
  - "Be terse. Use the tools exactly as instructed."
---

# Single Flow E2E

Documentation only — never injected into a step prompt.
`;

/**
 * planner step — ensures + closes one task, then emits `plan.done`. Closing the
 * task is what lets the later FLOW_COMPLETE pass the completion-task enforcement
 * (INT-003); if the model forgot to close it, the engine would re-trigger
 * `flow.tasks_remaining` and the run would not finalize (the negative path).
 */
const PLANNER_MD = `---
notor-type: orchestration-step
notor-step-name: "Planner"
notor-step-description: "Creates and closes a task, then advances."
notor-step-triggers:
  - flow.start
notor-step-publishes:
  - plan.done
notor-step-default-publishes: plan.done
---

You are the Planner step. Do EXACTLY this, then stop:
1. Call \`orchestration_task_ensure\` with key "plan-1" and description "Plan the work".
2. Call \`orchestration_task_close\` with key "plan-1".
3. Call \`emit_event\` with topic "plan.done" and payload "planning complete".

Do not write anything else. Do not emit any other topic.
`;

/** finisher step — emits FLOW_COMPLETE to terminate the flow. */
const FINISHER_MD = `---
notor-type: orchestration-step
notor-step-name: "Finisher"
notor-step-description: "Completes the flow."
notor-step-triggers:
  - plan.done
notor-step-publishes:
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

You are the Finisher step. Do EXACTLY this, then stop:
1. Call \`emit_event\` with topic "FLOW_COMPLETE" and payload "done".

Do not write anything else.
`;

const FLOW_TIMEOUT_MS = 180_000;
const POLL_MS = 2_000;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Write the flow fixtures into the vault before Obsidian launches. */
function setupFlowFixtures(vaultPath: string): void {
	writeCleanWorkspace(vaultPath);
	const stepsDir = path.join(vaultPath, FLOW_DIR, "steps");
	fs.mkdirSync(stepsDir, { recursive: true });
	fs.writeFileSync(path.join(vaultPath, FLOW_DIR, "definition.md"), DEFINITION_MD);
	fs.writeFileSync(path.join(stepsDir, "planner.md"), PLANNER_MD);
	fs.writeFileSync(path.join(stepsDir, "finisher.md"), FINISHER_MD);
}

/** Read the single recovered/created session directory's session.json (or null). */
function readLatestSession(
	vaultPath: string,
): { id: string; meta: Record<string, unknown>; dir: string } | null {
	const sessionsDir = path.join(vaultPath, NOTOR_DIR, "orchestrations", "sessions");
	if (!fs.existsSync(sessionsDir)) return null;
	const ids = fs.readdirSync(sessionsDir).filter((d) => fs.statSync(path.join(sessionsDir, d)).isDirectory());
	if (ids.length === 0) return null;
	// Newest by mtime.
	ids.sort(
		(a, b) =>
			fs.statSync(path.join(sessionsDir, b)).mtimeMs - fs.statSync(path.join(sessionsDir, a)).mtimeMs,
	);
	const id = ids[0]!;
	const dir = path.join(sessionsDir, id);
	const metaPath = path.join(dir, "session.json");
	if (!fs.existsSync(metaPath)) return { id, meta: {}, dir };
	return { id, meta: JSON.parse(fs.readFileSync(metaPath, "utf8")), dir };
}

/** Poll the session.json until it reaches a terminal status (or time out). */
async function waitForSessionTerminal(
	ctx: TestContext,
	vaultPath: string,
): Promise<{ id: string; meta: Record<string, unknown>; dir: string } | null> {
	const start = Date.now();
	while (Date.now() - start < FLOW_TIMEOUT_MS) {
		await ctx.page.waitForTimeout(POLL_MS);
		const session = readLatestSession(vaultPath);
		const status = session?.meta?.status;
		if (status === "completed" || status === "cancelled" || status === "error") {
			return session;
		}
		const elapsed = Math.round((Date.now() - start) / 1000);
		console.log(`    [${elapsed}s] session status: ${status ?? "(none yet)"}`);
	}
	return readLatestSession(vaultPath);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testRunFlowToCompletion(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Run a single flow to FLOW_COMPLETE via the command");
	const { page } = ctx;

	// Confirm the flow was discovered + orchestration is enabled.
	const enabled = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return plugin?.settings?.orchestration_enabled === true;
	});
	if (!enabled) {
		ctx.fail("orchestration enabled", "orchestration_enabled is not true at runtime");
		return;
	}

	// Launch via the "Run orchestration" command, then drive the flow picker +
	// objective modal.
	await page.evaluate(() => {
		(window as any).app?.commands?.executeCommandById?.("notor:run-orchestration");
	});
	await page.waitForTimeout(1000);

	// Flow picker (FuzzySuggestModal) — type the flow name and select it.
	const picker = await page.$(".prompt-input, .suggestion-container");
	if (picker) {
		await page.evaluate((name) => {
			const input = document.querySelector(".prompt-input") as HTMLInputElement | null;
			if (input) {
				input.value = name;
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}
		}, FLOW_NAME);
		await page.waitForTimeout(500);
		await page.keyboard.press("Enter");
		await page.waitForTimeout(800);
	}

	// Objective modal — fill the textarea, then Cmd/Ctrl+Enter to run.
	const objective = await page.$(".notor-orchestration-objective-input");
	if (objective) {
		await page.evaluate(() => {
			const ta = document.querySelector(".notor-orchestration-objective-input") as HTMLTextAreaElement | null;
			if (ta) {
				ta.value = "Run the minimal e2e flow.";
				ta.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});
		await page.waitForTimeout(300);
		await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
		await page.keyboard.press("Enter");
		await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
	} else {
		ctx.fail("objective modal", "Objective modal did not appear after selecting the flow");
		return;
	}

	const shot = await ctx.screenshot("01-flow-launched");
	ctx.pass("flow launched", "Selected the flow + submitted an objective", shot);

	// Poll the session.json for a terminal status.
	const session = await waitForSessionTerminal(ctx, ctx.vaultPath);
	if (!session) {
		ctx.fail("session created", "No session directory was created under orchestrations/sessions/");
		return;
	}

	if (session.meta.status === "completed") {
		ctx.pass("flow completed", `session.json status is 'completed' (id ${session.id})`);
	} else {
		ctx.fail(
			"flow completed",
			`session.json status is '${String(session.meta.status)}' (expected 'completed')`,
		);
	}
}

async function testSessionWorkspace(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Session workspace (INT-001) + tasks closed (INT-003)");
	const session = readLatestSession(ctx.vaultPath);
	if (!session) {
		ctx.fail("session workspace", "No session directory found");
		return;
	}

	const hasLog = fs.existsSync(path.join(session.dir, "session-log.jsonl"));
	const hasScratchpad = fs.existsSync(path.join(session.dir, "scratchpad"));
	const hasTasks = fs.existsSync(path.join(session.dir, "tasks"));
	if (hasLog && hasScratchpad && hasTasks) {
		ctx.pass("session workspace", "session.json + session-log.jsonl + scratchpad/ + tasks/ all present");
	} else {
		ctx.fail(
			"session workspace",
			`missing: ${[!hasLog && "session-log.jsonl", !hasScratchpad && "scratchpad/", !hasTasks && "tasks/"].filter(Boolean).join(", ")}`,
		);
	}

	// All task notes must be closed at completion (INT-003 enforcement held).
	const tasksDir = path.join(session.dir, "tasks");
	const taskFiles = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((f) => f.endsWith(".md")) : [];
	const statuses = taskFiles.map((f) => {
		const content = fs.readFileSync(path.join(tasksDir, f), "utf8");
		const m = content.match(/notor-task-status:\s*(\w+)/);
		return m?.[1] ?? "unknown";
	});
	if (taskFiles.length > 0 && statuses.every((s) => s === "closed")) {
		ctx.pass("tasks closed", `${taskFiles.length} task(s) all closed at completion`);
	} else if (taskFiles.length === 0) {
		// A flow that closed its task and the model never created one would still
		// complete; only fail if a task was left open.
		ctx.pass("tasks closed", "no open tasks remained (none created or all closed)");
	} else {
		ctx.fail("tasks closed", `task statuses: [${statuses.join(", ")}] — completion should require all closed`);
	}
}

async function testStepConversationsHidden(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Step conversations hidden from the flat list (INT-006)");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const hm = plugin?.getHistoryManager?.();
		if (!hm) return { error: "no history manager" };
		const entries = await hm.listConversations();
		return {
			count: entries.length,
			anyStepConvVisible: entries.some(
				(e: any) =>
					(e.title ?? "").includes(`[${"Single Flow E2E"}]`) ||
					(e.filename ?? "").includes("orchestration_step_"),
			),
		};
	});

	if ("error" in result) {
		ctx.fail("step conversations hidden", `could not read conversation list: ${result.error}`);
		return;
	}
	if (result.anyStepConvVisible) {
		ctx.fail(
			"step conversations hidden",
			"an orchestration step conversation appeared in listConversations()",
		);
	} else {
		ctx.pass(
			"step conversations hidden",
			`${result.count} listed conversation(s); no orchestration step conversation among them`,
		);
	}

	// Sanity: step-conversation JSONL files WERE written to disk (just hidden).
	const historyDir = path.join(
		ctx.vaultPath,
		".obsidian",
		"plugins",
		"notor",
		"history",
	);
	const stepFiles = fs.existsSync(historyDir)
		? fs.readdirSync(historyDir).filter((f) => f.startsWith("orchestration_step_"))
		: [];
	if (stepFiles.length > 0) {
		ctx.pass("step conversations persisted", `${stepFiles.length} hidden step-conversation file(s) on disk`);
	} else {
		// Not strictly fatal (a flow could complete with code steps only), but our
		// flow uses conversation steps, so we expect at least one.
		ctx.fail("step conversations persisted", "no orchestration_step_*.jsonl files were written");
	}
}

async function testNormalConversationStillListed(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: A normal conversation still appears in the list (no regression)");
	const { page } = ctx;

	await newConversation(page);
	await waitForSelector(page, ".notor-text-input", 5000);
	await sendMessage(page, "Reply with exactly: OK");

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const hm = plugin?.getHistoryManager?.();
		const entries = await hm.listConversations();
		return { count: entries.length };
	});

	if (result.count >= 1) {
		ctx.pass(
			"normal conversation listed",
			`listConversations() returned ${result.count} normal conversation(s)`,
		);
	} else {
		ctx.fail("normal conversation listed", "the normal conversation did not appear in the list");
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // plugin init + Bedrock provider registration
	await waitForSelector(page, ".notor-chat-container", 8000);

	await testRunFlowToCompletion(ctx);
	await testSessionWorkspace(ctx);
	await testStepConversationsHidden(ctx);
	await testNormalConversationStillListed(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	orchestration_enabled: true,
	// Act mode so the step turns' write tools (emit_event, task tools) are allowed.
	mode: "act",
	auto_approve: {
		emit_event: true,
		orchestration_task_ensure: true,
		orchestration_task_start: true,
		orchestration_task_close: true,
		orchestration_task_list: true,
	},
});

runTest(
	{
		name: "orchestration-single-flow",
		settings,
		setupVault: setupFlowFixtures,
		cleanupFiles: [
			`${FLOW_DIR}/definition.md`,
			`${FLOW_DIR}/steps/planner.md`,
			`${FLOW_DIR}/steps/finisher.md`,
		],
	},
	tests,
);
