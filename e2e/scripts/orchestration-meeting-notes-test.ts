#!/usr/bin/env npx tsx
/**
 * Orchestration Meeting-Notes Cleaner E2E Test (example flow #3)
 *
 * A committed regression fixture for the **conversation → code structured handoff**
 * — the simplest "LLM produces structure, a deterministic code step does the reliable
 * side effects" sandwich. The flow:
 *
 *   reformat (CONVERSATION step): reads a seed raw-meeting note, extracts the action
 *     items, and emits `reformat.done` with the items as a JSON-array payload.
 *   create-tasks (CODE step): parses the action items off `event.payload` and
 *     deterministically writes one task note per item via `orchestration.callTool(
 *     "write_note", …)`, then emits FLOW_COMPLETE.
 *
 * The infra invariants asserted (never the LLM's prose, which is nondeterministic):
 *   1. The flow reaches a terminal `session.json` status of `completed`.
 *   2. The code step ran cleanly — no `{step}.code_error` topic in the session log.
 *   3. The handoff worked — at least one task note exists on disk under `Tasks/`,
 *      proving the code step received `event.payload` and exercised the write path.
 *
 * Prerequisites:
 *   - AWS profile `default` with Bedrock access (the `reformat` step is a real LLM turn).
 *
 * Run with:
 *   npx tsx e2e/scripts/orchestration-meeting-notes-test.ts
 *
 * @see specs/ZZ-misc/orchestration/contracts/orchestration-helper.md — callTool / emit
 * @see ~/zm/ai/notor/ideas/Example orchestration flows to ship.md — flow #3
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector, writeCleanWorkspace } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants + flow fixtures
// ---------------------------------------------------------------------------

const NOTOR_DIR = "notor";
const FLOW_NAME = "Meeting Notes Cleaner E2E";
const FLOW_DIR = `${NOTOR_DIR}/orchestrations/meeting-notes-cleaner-e2e`;

/** Where the seed raw-meeting note lives and where the code step files task notes. */
const RAW_NOTE_PATH = "Meetings/2026-06-29 Raw.md";
const TASKS_FOLDER = "Tasks";

/** The seed raw meeting note — three unambiguous action items for the LLM to extract. */
const RAW_MEETING_NOTE = `# Standup — 2026-06-29

attendees: alice, bob, carol

bunch of messy notes from the call:

- we talked about the q3 launch, seems on track
- ACTION: Alice to draft the launch announcement by Friday
- carol raised the flaky CI issue again
- ACTION: Bob to investigate the flaky integration test on main
- ACTION: Carol to schedule the design review with the platform team
- random tangent about the office coffee machine
`;

/** definition.md — a two-step flow: a conversation reformat step, then a code step. */
const DEFINITION_MD = `---
notor-type: orchestration-flow
notor-flow-name: "${FLOW_NAME}"
notor-flow-description: "Reformat raw meeting notes and spawn task notes from the action items (example #3)."
notor-starting-event: meeting.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 10
notor-max-runtime-minutes: 10
notor-steps:
  - "[[reformat]]"
  - "[[create-tasks]]"
notor-guardrails:
  - "Be terse. Use the tools exactly as instructed."
---

# Meeting Notes Cleaner E2E

Documentation only — never injected into a step prompt.
`;

/**
 * reformat — a CONVERSATION step. Reads the raw meeting note, extracts the action
 * items, and hands them to the code step as a JSON-array payload. This is the
 * structured-handoff seam the flow exists to demonstrate.
 */
const REFORMAT_MD = `---
notor-type: orchestration-step
notor-step-name: "Reformat"
notor-step-description: "Extracts action items from the raw meeting note."
notor-step-triggers:
  - meeting.start
notor-step-publishes:
  - reformat.done
notor-step-default-publishes: reformat.done
---

You are the Reformat step. Do EXACTLY this, then stop:

1. Call \`read_note\` with path "${RAW_NOTE_PATH}" to read the raw meeting note.
2. Identify every action item (the lines beginning with "ACTION:").
3. Call \`emit_event\` with:
   - topic: "reformat.done"
   - payload: a JSON array of the action-item strings (drop the "ACTION:" prefix),
     for example: ["Alice to draft the announcement", "Bob to investigate the test"]

Emit the array as raw JSON in the payload — no prose, no markdown fences around it.
Do not write any notes. Do not emit any other topic.
`;

/**
 * create-tasks — a CODE step. Parses the action items off the event payload and
 * deterministically writes one task note per item. Tolerant of the LLM wrapping the
 * array in prose/fences: it extracts the first JSON array, and falls back to
 * newline-splitting if no array parses.
 */
const CREATE_TASKS_MD = `---
notor-type: orchestration-step
notor-step-name: "Create Tasks"
notor-step-description: "Writes one task note per extracted action item."
notor-step-mode: code
notor-step-triggers:
  - reformat.done
notor-step-publishes:
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

# Create Tasks

\`\`\`typescript
const raw = (event.payload || "").trim();

// Tolerant parse: prefer a JSON array, else slice the first [ ... ], else split lines.
let items = [];
function asStrings(arr) {
  return arr.map((x) => String(x).trim()).filter((s) => s.length > 0);
}
try {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) items = asStrings(parsed);
} catch (_e) {
  const open = raw.indexOf("[");
  const close = raw.lastIndexOf("]");
  if (open !== -1 && close > open) {
    try {
      const parsed = JSON.parse(raw.slice(open, close + 1));
      if (Array.isArray(parsed)) items = asStrings(parsed);
    } catch (_e2) { /* fall through */ }
  }
}
if (items.length === 0 && raw.length > 0) {
  items = raw.split("\\n").map((l) => l.replace(/^[-*\\d.\\s]+/, "").trim()).filter((s) => s.length > 0);
}

// Deterministically file one task note per item (stable names, re-run safe via overwrite).
let created = 0;
for (let i = 0; i < items.length && i < 20; i++) {
  const notePath = "${TASKS_FOLDER}/task-" + (i + 1) + ".md";
  const content = "---\\nnotor-type: task\\nsource: \\"${RAW_NOTE_PATH}\\"\\n---\\n\\n# " + items[i] + "\\n";
  await orchestration.callTool("write_note", { path: notePath, content });
  created++;
}

return orchestration.emit("FLOW_COMPLETE", "Created " + created + " task note(s).");
\`\`\`
`;

const FLOW_TIMEOUT_MS = 180_000;
const POLL_MS = 2_000;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Write the flow fixtures + the seed raw-meeting note before Obsidian launches. */
function setupFlowFixtures(vaultPath: string): void {
	writeCleanWorkspace(vaultPath);
	const stepsDir = path.join(vaultPath, FLOW_DIR, "steps");
	fs.mkdirSync(stepsDir, { recursive: true });
	fs.writeFileSync(path.join(vaultPath, FLOW_DIR, "definition.md"), DEFINITION_MD);
	fs.writeFileSync(path.join(stepsDir, "reformat.md"), REFORMAT_MD);
	fs.writeFileSync(path.join(stepsDir, "create-tasks.md"), CREATE_TASKS_MD);

	// Seed raw meeting note the reformat step reads.
	const meetingsDir = path.join(vaultPath, path.dirname(RAW_NOTE_PATH));
	fs.mkdirSync(meetingsDir, { recursive: true });
	fs.writeFileSync(path.join(vaultPath, RAW_NOTE_PATH), RAW_MEETING_NOTE);
}

interface SessionInfo {
	id: string;
	dir: string;
	meta: Record<string, unknown>;
	log: string;
}

function sessionsDir(vaultPath: string): string {
	return path.join(vaultPath, NOTOR_DIR, "orchestrations", "sessions");
}

/** Read the newest session for this flow (by session.json mtime). */
function readFlowSession(vaultPath: string): SessionInfo | null {
	const dir = sessionsDir(vaultPath);
	if (!fs.existsSync(dir)) return null;
	const matching = fs
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
		})
		.filter((s) => s.meta.flow_name === FLOW_NAME);
	if (matching.length === 0) return null;
	matching.sort(
		(a, b) =>
			fs.statSync(path.join(b.dir, "session.json")).mtimeMs -
			fs.statSync(path.join(a.dir, "session.json")).mtimeMs,
	);
	return matching[0]!;
}

/** Poll the flow's session.json until it reaches a terminal status (or time out). */
async function waitForFlowTerminal(ctx: TestContext): Promise<SessionInfo | null> {
	const start = Date.now();
	while (Date.now() - start < FLOW_TIMEOUT_MS) {
		await ctx.page.waitForTimeout(POLL_MS);
		const s = readFlowSession(ctx.vaultPath);
		const status = s?.meta?.status;
		if (status === "completed" || status === "cancelled" || status === "error") return s;
		const elapsed = Math.round((Date.now() - start) / 1000);
		console.log(`    [${elapsed}s] session status: ${String(status ?? "(none yet)")}`);
	}
	return readFlowSession(ctx.vaultPath);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testFlowCompletes(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Reformat → create-tasks runs to FLOW_COMPLETE");
	const { page } = ctx;

	const enabled = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return plugin?.settings?.orchestration_enabled === true;
	});
	if (!enabled) {
		ctx.fail("orchestration enabled", "orchestration_enabled is not true at runtime");
		return;
	}

	const launched = await launchFlow(ctx, FLOW_NAME, `Clean up the meeting note at ${RAW_NOTE_PATH}.`);
	if (!launched) {
		ctx.fail("flow launched", "objective modal did not appear after selecting the flow");
		return;
	}
	const shot = await ctx.screenshot("01-flow-launched");

	const session = await waitForFlowTerminal(ctx);
	if (!session) {
		ctx.fail("session created", "no Meeting Notes Cleaner E2E session reached a terminal status");
		return;
	}

	if (session.meta.status === "completed") {
		ctx.pass("flow completed", `session.json status is 'completed' (id ${session.id})`, shot);
	} else {
		ctx.fail(
			"flow completed",
			`session.json status is '${String(session.meta.status)}' (expected 'completed')`,
			shot,
		);
	}
}

async function testCodeStepRanClean(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: the create-tasks code step ran without a code_error");
	const session = readFlowSession(ctx.vaultPath);
	if (!session) {
		ctx.fail("code step clean", "no session found");
		return;
	}
	if (session.log.includes(".code_error")) {
		ctx.fail("code step clean", "session-log contains a `{step}.code_error` emission");
	} else {
		ctx.pass("code step clean", "no `{step}.code_error` emission in the session log");
	}
}

async function testTaskNotesCreated(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: the structured handoff created task notes on disk");
	const tasksDir = path.join(ctx.vaultPath, TASKS_FOLDER);
	const taskFiles = fs.existsSync(tasksDir)
		? fs.readdirSync(tasksDir).filter((f) => f.endsWith(".md"))
		: [];

	// Infra gate: >= 1 proves the code step received event.payload and the write
	// path works. We log the exact count (3 expected from the seed) without making
	// the LLM's extraction count a hard failure.
	if (taskFiles.length >= 1) {
		ctx.pass(
			"task notes created",
			`${taskFiles.length} task note(s) written under ${TASKS_FOLDER}/ (3 expected from the seed)`,
		);
	} else {
		ctx.fail("task notes created", `no task notes written under ${TASKS_FOLDER}/`);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // plugin init + Bedrock provider registration
	await waitForSelector(page, ".notor-chat-container", 8000);

	await testFlowCompletes(ctx);
	await testCodeStepRanClean(ctx);
	await testTaskNotesCreated(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	orchestration_enabled: true,
	// Act mode so the conversation step's emit_event and the code step's write_note
	// are allowed; auto-approve them so the run stays unattended.
	mode: "act",
	auto_approve: {
		emit_event: true,
		write_note: true,
	},
});

runTest(
	{
		name: "orchestration-meeting-notes",
		settings,
		setupVault: setupFlowFixtures,
		cleanupFiles: [
			FLOW_DIR,
			path.dirname(RAW_NOTE_PATH),
			TASKS_FOLDER,
		],
	},
	tests,
);
