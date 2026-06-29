#!/usr/bin/env npx tsx
/**
 * Orchestration terminal code-step paths E2E Test (TEST-009)
 *
 * Covers the two NON-`FLOW_COMPLETE` terminal outcomes of the engine, both driven
 * by deterministic **code steps** (no LLM turns, no Bedrock dependency):
 *
 *   - FLOW_CANCELLED (FR-132 / INT-012): a code step emits `FLOW_CANCELLED`, which
 *     terminates the run with session.json status `cancelled` and **bypasses** the
 *     open-task completion enforcement (INT-003) — an open, never-closed task does
 *     NOT block the cancel.
 *   - {step}.code_error (FR-130 / INT-010): a code step throws; the executor
 *     synthesizes a `{step}.code_error` emission (never crashing the plugin), which
 *     — with no subscriber — reaches the engine's default failure handler and
 *     terminates with session.json status `error`. `turn.start` / `turn.complete`
 *     are still written for that step (audit + recovery), and the code step creates
 *     no conversation file (zero tokens).
 *
 * Both flows keep `FLOW_COMPLETE` statically reachable (a declared `publishes` /
 * `default-publishes` edge) so they pass the load-time reachability validator
 * (FR-110), while taking the cancel / error branch at runtime.
 *
 * Scenarios:
 *   1. Run the cancel flow → session.json status `cancelled`; the open task it
 *      created is still open at terminal (enforcement bypassed); a
 *      `session.cancelled` log entry is present.
 *   2. Run the error flow → session.json status `error`; the throwing code step
 *      logged turn.start + turn.complete and emitted a `{step}.code_error` topic;
 *      no orchestration_step_* conversation file was written for it (code step).
 *
 * Prerequisites:
 *   - None beyond a working build — both flows are 100% code steps (no LLM turns),
 *     so no AWS / Bedrock access is required.
 *
 * Run with:
 *   npx tsx e2e/scripts/orchestration-terminal-paths-test.ts
 *
 * @see specs/ZZ-misc/orchestration/spec.md — FR-130, FR-132
 * @see specs/ZZ-misc/orchestration/quickstart.md — Scenario 2 (code step + cancellation)
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector, writeCleanWorkspace } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants + flow fixtures
// ---------------------------------------------------------------------------

const NOTOR_DIR = "notor";
const ORCH_DIR = `${NOTOR_DIR}/orchestrations`;

const CANCEL_NAME = "Cancel Flow E2E";
const CANCEL_DIR = `${ORCH_DIR}/cancel-flow-e2e`;
const ERROR_NAME = "Error Flow E2E";
const ERROR_DIR = `${ORCH_DIR}/error-flow-e2e`;

/**
 * Cancel flow — a single terminal CODE step. It ensures an open task (never
 * closes it), then emits FLOW_CANCELLED. Because FLOW_CANCELLED bypasses task
 * enforcement, the run terminates `cancelled` even with the task left open.
 * FLOW_COMPLETE is declared in `publishes` purely to satisfy the load-time
 * reachability validator (FR-110) — it is never emitted at runtime.
 */
const CANCEL_DEFINITION = `---
notor-type: orchestration-flow
notor-flow-name: "${CANCEL_NAME}"
notor-flow-description: "Code step emits FLOW_CANCELLED with an open task (FR-132)."
notor-starting-event: cancel.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 5
notor-max-runtime-minutes: 5
notor-steps:
  - "[[decide]]"
---

# Cancel Flow E2E

Documentation only.
`;

const CANCEL_DECIDE = `---
notor-type: orchestration-step
notor-step-name: "Decide"
notor-step-description: "Opens a task, then cancels (bypasses enforcement)."
notor-step-mode: code
notor-step-triggers:
  - cancel.start
notor-step-publishes:
  - FLOW_CANCELLED
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_CANCELLED
---

# Decide

\`\`\`typescript
// Open a task and deliberately LEAVE IT OPEN. FLOW_CANCELLED must terminate the
// run anyway (it bypasses the open-task completion enforcement, FR-132/INT-003).
await orchestration.tasks.ensure("never-closed", "A task left intentionally open");
return orchestration.emit("FLOW_CANCELLED", "user aborted via code step");
\`\`\`
`;

/**
 * Error flow — a single terminal CODE step that THROWS. The executor synthesizes
 * `{step}.code_error`, which (unsubscribed) reaches the default failure handler →
 * status `error`. FLOW_COMPLETE is declared so the validator's reachability check
 * passes (the throw branch is invisible to the static validator).
 */
const ERROR_DEFINITION = `---
notor-type: orchestration-flow
notor-flow-name: "${ERROR_NAME}"
notor-flow-description: "Code step throws → {step}.code_error → status error (FR-130)."
notor-starting-event: error.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 5
notor-max-runtime-minutes: 5
notor-steps:
  - "[[boom]]"
---

# Error Flow E2E

Documentation only.
`;

const ERROR_BOOM = `---
notor-type: orchestration-step
notor-step-name: "Boom"
notor-step-description: "Throws to exercise the {step}.code_error channel."
notor-step-mode: code
notor-step-triggers:
  - error.start
notor-step-publishes:
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

# Boom

\`\`\`typescript
// A deliberate runtime throw. The executor must NOT crash the plugin: it
// synthesizes a "Boom.code_error" emission, still writes turn.start/turn.complete,
// and (unsubscribed) the default failure handler terminates the run with status
// "error".
throw new Error("intentional code-step failure (e2e)");
\`\`\`
`;

const FLOW_TIMEOUT_MS = 90_000;
const POLL_MS = 1_500;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function setupFlowFixtures(vaultPath: string): void {
	writeCleanWorkspace(vaultPath);
	const cancelSteps = path.join(vaultPath, CANCEL_DIR, "steps");
	const errorSteps = path.join(vaultPath, ERROR_DIR, "steps");
	fs.mkdirSync(cancelSteps, { recursive: true });
	fs.mkdirSync(errorSteps, { recursive: true });
	fs.writeFileSync(path.join(vaultPath, CANCEL_DIR, "definition.md"), CANCEL_DEFINITION);
	fs.writeFileSync(path.join(cancelSteps, "decide.md"), CANCEL_DECIDE);
	fs.writeFileSync(path.join(vaultPath, ERROR_DIR, "definition.md"), ERROR_DEFINITION);
	fs.writeFileSync(path.join(errorSteps, "boom.md"), ERROR_BOOM);
}

function sessionsDir(vaultPath: string): string {
	return path.join(vaultPath, NOTOR_DIR, "orchestrations", "sessions");
}

interface SessionInfo {
	id: string;
	dir: string;
	meta: Record<string, unknown>;
	log: string;
}

function readAllSessions(vaultPath: string): SessionInfo[] {
	const dir = sessionsDir(vaultPath);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((d) => fs.statSync(path.join(dir, d)).isDirectory())
		.map((id) => {
			const sdir = path.join(dir, id);
			const metaPath = path.join(sdir, "session.json");
			const logPath = path.join(sdir, "session-log.jsonl");
			return {
				id,
				dir: sdir,
				meta: fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {},
				log: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "",
			};
		});
}

/** Parse a session-log into an array of `{type, ...}` entry objects. */
function parseLog(log: string): Array<Record<string, unknown>> {
	return log
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => {
			try {
				return JSON.parse(l) as Record<string, unknown>;
			} catch {
				return {} as Record<string, unknown>;
			}
		});
}

/**
 * Launch a flow by name via the "Run orchestration" command, driving the flow
 * picker + objective modal. Mirrors the existing orchestration e2e tests.
 */
async function launchFlow(ctx: TestContext, flowName: string, objective: string): Promise<boolean> {
	const { page } = ctx;
	await page.evaluate(() => {
		(window as any).app?.commands?.executeCommandById?.("notor:run-orchestration");
	});
	await page.waitForTimeout(1000);

	// Flow picker (FuzzySuggestModal) — type the flow name and select it.
	await page.evaluate((name) => {
		const input = document.querySelector(".prompt-input") as HTMLInputElement | null;
		if (input) {
			input.value = name;
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
	}, flowName);
	await page.waitForTimeout(500);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(800);

	// Objective modal — fill, then Cmd/Ctrl+Enter to run.
	const objectiveEl = await page.$(".notor-orchestration-objective-input");
	if (!objectiveEl) return false;
	await page.evaluate((text) => {
		const ta = document.querySelector(".notor-orchestration-objective-input") as HTMLTextAreaElement | null;
		if (ta) {
			ta.value = text;
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		}
	}, objective);
	await page.waitForTimeout(300);
	const mod = process.platform === "darwin" ? "Meta" : "Control";
	await page.keyboard.down(mod);
	await page.keyboard.press("Enter");
	await page.keyboard.up(mod);
	return true;
}

/** Poll for the newest session of the given flow to reach a terminal status. */
async function waitForFlowTerminal(
	ctx: TestContext,
	flowName: string,
): Promise<SessionInfo | null> {
	const start = Date.now();
	const pick = (): SessionInfo | undefined => {
		const matching = readAllSessions(ctx.vaultPath).filter((s) => s.meta.flow_name === flowName);
		matching.sort(
			(a, b) =>
				fs.statSync(path.join(b.dir, "session.json")).mtimeMs -
				fs.statSync(path.join(a.dir, "session.json")).mtimeMs,
		);
		return matching[0];
	};
	while (Date.now() - start < FLOW_TIMEOUT_MS) {
		await ctx.page.waitForTimeout(POLL_MS);
		const s = pick();
		const status = s?.meta.status;
		if (status === "completed" || status === "cancelled" || status === "error") return s ?? null;
		const elapsed = Math.round((Date.now() - start) / 1000);
		console.log(`    [${elapsed}s] ${flowName} status: ${String(status ?? "(none yet)")}`);
	}
	return pick() ?? null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testCancelBypassesEnforcement(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: FLOW_CANCELLED terminates `cancelled` and bypasses open-task enforcement (FR-132)");

	const launched = await launchFlow(ctx, CANCEL_NAME, "Run the cancel flow.");
	if (!launched) {
		ctx.fail("cancel flow launched", "objective modal did not appear for the cancel flow");
		return;
	}
	const shot = await ctx.screenshot("01-cancel-launched");

	const session = await waitForFlowTerminal(ctx, CANCEL_NAME);
	if (!session) {
		ctx.fail("cancel flow terminal", "no Cancel Flow E2E session reached a terminal status");
		return;
	}

	if (session.meta.status === "cancelled") {
		ctx.pass("cancel status", `session.json status is 'cancelled' (id ${session.id})`, shot);
	} else {
		ctx.fail("cancel status", `session.json status is '${String(session.meta.status)}' (expected 'cancelled')`, shot);
	}

	// The task the code step ensured must still be OPEN at terminal — proving
	// FLOW_CANCELLED bypassed the open-task completion enforcement (INT-003).
	const tasksDir = path.join(session.dir, "tasks");
	const taskFiles = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((f) => f.endsWith(".md")) : [];
	const statuses = taskFiles.map((f) => {
		const content = fs.readFileSync(path.join(tasksDir, f), "utf8");
		const m = content.match(/notor-task-status:\s*(\w+)/);
		return m?.[1] ?? "unknown";
	});
	if (taskFiles.length === 0) {
		ctx.fail("cancel bypasses enforcement", "the code step's ensured task note was not written to tasks/");
	} else if (statuses.some((s) => s === "open" || s === "running")) {
		ctx.pass(
			"cancel bypasses enforcement",
			`an open task remained (statuses: [${statuses.join(", ")}]) yet the run still cancelled`,
		);
	} else {
		ctx.fail(
			"cancel bypasses enforcement",
			`expected an open/running task to remain (statuses: [${statuses.join(", ")}])`,
		);
	}

	// A `session.cancelled` log entry is the terminal marker for a cancel.
	const types = parseLog(session.log).map((e) => e.type);
	if (types.includes("session.cancelled")) {
		ctx.pass("cancel log marker", "session-log carries a session.cancelled entry");
	} else {
		ctx.fail(
			"cancel log marker",
			`session-log has no session.cancelled entry (types seen: ${[...new Set(types)].join(", ")})`,
		);
	}
}

async function testCodeErrorChannel(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: a throwing code step → {step}.code_error → status `error` (FR-130)");

	const launched = await launchFlow(ctx, ERROR_NAME, "Run the error flow.");
	if (!launched) {
		ctx.fail("error flow launched", "objective modal did not appear for the error flow");
		return;
	}
	const shot = await ctx.screenshot("02-error-launched");

	const session = await waitForFlowTerminal(ctx, ERROR_NAME);
	if (!session) {
		ctx.fail("error flow terminal", "no Error Flow E2E session reached a terminal status");
		return;
	}

	if (session.meta.status === "error") {
		ctx.pass("error status", `session.json status is 'error' (id ${session.id})`, shot);
	} else {
		ctx.fail("error status", `session.json status is '${String(session.meta.status)}' (expected 'error')`, shot);
	}

	const entries = parseLog(session.log);
	const types = entries.map((e) => e.type);

	// The throwing step still wrote turn.start AND turn.complete (audit + recovery).
	const hasTurnStart = entries.some((e) => e.type === "turn.start" && e.step === "Boom");
	const hasTurnComplete = entries.some((e) => e.type === "turn.complete" && e.step === "Boom");
	if (hasTurnStart && hasTurnComplete) {
		ctx.pass("error turn logged", "the throwing step wrote both turn.start and turn.complete");
	} else {
		ctx.fail(
			"error turn logged",
			`missing for step Boom: ${[!hasTurnStart && "turn.start", !hasTurnComplete && "turn.complete"].filter(Boolean).join(", ")}`,
		);
	}

	// The synthesized failure topic is `Boom.code_error` (named after the step).
	const emittedCodeError = entries.some(
		(e) =>
			(e.type === "turn.complete" && e.emitted_topic === "Boom.code_error") ||
			(e.type === "event.emitted" && e.topic === "Boom.code_error"),
	);
	if (emittedCodeError) {
		ctx.pass("code_error topic", "the throwing step emitted the `Boom.code_error` failure topic");
	} else {
		ctx.fail(
			"code_error topic",
			`no Boom.code_error emission found (types seen: ${[...new Set(types)].join(", ")})`,
		);
	}

	// A code step creates NO conversation file (zero tokens, no JSONL conversation).
	const historyDir = path.join(ctx.vaultPath, ".obsidian", "plugins", "notor", "history");
	const stepFiles = fs.existsSync(historyDir)
		? fs.readdirSync(historyDir).filter((f) => f.startsWith("orchestration_step_"))
		: [];
	// Neither flow in this test uses a conversation step, so there should be zero
	// step-conversation files on disk attributable to these runs.
	if (stepFiles.length === 0) {
		ctx.pass("code step no conversation", "no orchestration_step_*.jsonl files written (code steps only)");
	} else {
		ctx.fail(
			"code step no conversation",
			`expected zero step-conversation files for code-only flows, found ${stepFiles.length}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // plugin init + extension/scaffold registration
	await waitForSelector(page, ".notor-chat-container", 8000);

	const enabled = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return plugin?.settings?.orchestration_enabled === true;
	});
	if (!enabled) {
		ctx.fail("orchestration enabled", "orchestration_enabled is not true at runtime");
		return;
	}

	await testCancelBypassesEnforcement(ctx);
	await testCodeErrorChannel(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	orchestration_enabled: true,
	// Act mode so the code steps' task tools / emit are allowed. Code steps call
	// the task registry directly (orchestration.tasks.*), but Act mode keeps the
	// run unattended regardless.
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
		name: "orchestration-terminal-paths",
		settings,
		setupVault: setupFlowFixtures,
		cleanupFiles: [
			`${CANCEL_DIR}/definition.md`,
			`${CANCEL_DIR}/steps/decide.md`,
			`${ERROR_DIR}/definition.md`,
			`${ERROR_DIR}/steps/boom.md`,
		],
	},
	tests,
);
