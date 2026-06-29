#!/usr/bin/env npx tsx
/**
 * Orchestration Draft → Critique → Revise E2E Test (example flow #5)
 *
 * A committed regression fixture for the **Ralph-style loop with a deterministic
 * exit gate** — the headline lesson that a *code step*, not the LLM, owns the
 * stopping condition. The flow:
 *
 *   draft (CONVERSATION): writes/revises a short artifact into the scratchpad,
 *     then emits `draft.done`.
 *   critique (CONVERSATION): reviews it against criteria and emits `critique.done`
 *     with a verdict ("APPROVE" or "REVISE: …") as the payload.
 *   gate (CODE): the deterministic exit. Approves → FLOW_COMPLETE; otherwise routes
 *     `draft.revise` back to `draft` with the critique as context — but ALWAYS
 *     force-completes once a hard round cap is hit, so the stop is owned by code,
 *     never left to the model. The draft→critique→gate→draft triangle yields
 *     distinct (topic, source_step) pairs, so it never trips the 4-identical-repeat
 *     stale-loop guard.
 *
 * The infra invariants asserted (never the LLM's prose, which is nondeterministic):
 *   1. The flow reaches a terminal `session.json` status of `completed`.
 *   2. The loop actually iterated — at least one `draft` turn AND one `critique`
 *      turn were logged (the multi-persona collaboration happened).
 *   3. The gate owned the exit — a FLOW_COMPLETE was emitted by the `Gate` step,
 *      and the loop respected the round cap (no runaway; bounded by max-iterations).
 *
 * Prerequisites:
 *   - AWS profile `default` with Bedrock access (draft + critique are real LLM turns).
 *
 * Run with:
 *   npx tsx e2e/scripts/orchestration-draft-critique-test.ts
 *
 * @see specs/ZZ-misc/orchestration/contracts/orchestration-helper.md — emit / eventHistory
 * @see ~/zm/ai/notor/ideas/Example orchestration flows to ship.md — flow #5
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector, writeCleanWorkspace } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants + flow fixtures
// ---------------------------------------------------------------------------

const NOTOR_DIR = "notor";
const FLOW_NAME = "Draft Critique Revise E2E";
const FLOW_DIR = `${NOTOR_DIR}/orchestrations/draft-critique-revise-e2e`;

/** Hard cap on revise rounds the GATE enforces (the deterministic exit). */
const MAX_REVISE_ROUNDS = 2;

/** definition.md — three steps: draft (conv) → critique (conv) → gate (code). */
const DEFINITION_MD = `---
notor-type: orchestration-flow
notor-flow-name: "${FLOW_NAME}"
notor-flow-description: "Writer/critic Ralph loop with a code-step exit gate (example #5)."
notor-starting-event: write.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 12
notor-max-runtime-minutes: 15
notor-steps:
  - "[[draft]]"
  - "[[critique]]"
  - "[[gate]]"
notor-guardrails:
  - "Be terse. Use the tools exactly as instructed."
---

# Draft Critique Revise E2E

Documentation only — never injected into a step prompt.
`;

/**
 * draft — a CONVERSATION step. Writes (or revises) the artifact into the
 * scratchpad. Triggered both at the start and on a `draft.revise` re-route from
 * the gate, so a single step body handles both the first draft and revisions.
 */
const DRAFT_MD = `---
notor-type: orchestration-step
notor-step-name: "Draft"
notor-step-description: "Writes or revises the artifact."
notor-step-triggers:
  - write.start
  - draft.revise
notor-step-publishes:
  - draft.done
notor-step-default-publishes: draft.done
---

You are the Draft step. Do EXACTLY this, then stop:

1. Write a SHORT (2–3 sentence) product tagline paragraph for the objective.
   - If the incoming event payload contains critique feedback, revise to address it.
2. Call \`write_note\` with path "${FLOW_DIR}/scratch-draft.md" and the paragraph as content.
3. Call \`emit_event\` with topic "draft.done" and payload "draft written".

Do not emit any other topic. Keep it terse.
`;

/**
 * critique — a CONVERSATION step (the adversarial second persona). Emits a verdict
 * the deterministic gate reads. We instruct an APPROVE on a clean draft so the loop
 * usually exits naturally; the gate's round cap guarantees termination regardless.
 */
const CRITIQUE_MD = `---
notor-type: orchestration-step
notor-step-name: "Critique"
notor-step-description: "Reviews the draft and emits a verdict."
notor-step-triggers:
  - draft.done
notor-step-publishes:
  - critique.done
notor-step-default-publishes: critique.done
---

You are the Critique step — a terse, fair editor. Do EXACTLY this, then stop:

1. Call \`read_note\` with path "${FLOW_DIR}/scratch-draft.md" to read the current draft.
2. Judge it: is it a clear, grammatical 2–3 sentence tagline with no placeholder text?
3. Call \`emit_event\` with topic "critique.done" and payload:
   - "APPROVE" if it is acceptable, OR
   - "REVISE: <one concrete fix>" if it genuinely needs one change.

Approve as soon as it is acceptable — do not nitpick. Do not emit any other topic.
`;

/**
 * gate — the CODE step that OWNS the exit. Approves → FLOW_COMPLETE. Otherwise
 * re-routes draft.revise — but force-completes once the round cap is hit, so
 * termination is deterministic and code-owned (never the model's choice).
 */
const GATE_MD = `---
notor-type: orchestration-step
notor-step-name: "Gate"
notor-step-description: "Deterministic exit: approve or loop, with a hard round cap."
notor-step-mode: code
notor-step-triggers:
  - critique.done
notor-step-publishes:
  - draft.revise
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

# Gate

\`\`\`typescript
const verdict = (event.payload || "").trim();
const approved = /^approve/i.test(verdict);

// Count how many revise rounds we have already issued (distinct-topic loop).
const history = orchestration.eventHistory();
const reviseRounds = history.filter((e) => e.topic === "draft.revise").length;

if (approved) {
  return orchestration.emit("FLOW_COMPLETE", "Critic approved after " + reviseRounds + " revise round(s).");
}

// Deterministic exit: the CODE step caps the loop — the LLM never decides "done".
if (reviseRounds >= ${MAX_REVISE_ROUNDS}) {
  return orchestration.emit("FLOW_COMPLETE", "Round cap reached (" + reviseRounds + ") — accepting current draft.");
}

// Otherwise loop back to draft with the critique as revision context.
return orchestration.emit("draft.revise", verdict);
\`\`\`
`;

const FLOW_TIMEOUT_MS = 300_000;
const POLL_MS = 2_000;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function setupFlowFixtures(vaultPath: string): void {
	writeCleanWorkspace(vaultPath);
	const stepsDir = path.join(vaultPath, FLOW_DIR, "steps");
	fs.mkdirSync(stepsDir, { recursive: true });
	fs.writeFileSync(path.join(vaultPath, FLOW_DIR, "definition.md"), DEFINITION_MD);
	fs.writeFileSync(path.join(stepsDir, "draft.md"), DRAFT_MD);
	fs.writeFileSync(path.join(stepsDir, "critique.md"), CRITIQUE_MD);
	fs.writeFileSync(path.join(stepsDir, "gate.md"), GATE_MD);
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
	console.log("\nTest 1: draft → critique → gate loop runs to FLOW_COMPLETE");
	const { page } = ctx;

	const enabled = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return plugin?.settings?.orchestration_enabled === true;
	});
	if (!enabled) {
		ctx.fail("orchestration enabled", "orchestration_enabled is not true at runtime");
		return;
	}

	const launched = await launchFlow(ctx, FLOW_NAME, "Write a tagline for a focus-timer app called Notor.");
	if (!launched) {
		ctx.fail("flow launched", "objective modal did not appear after selecting the flow");
		return;
	}
	const shot = await ctx.screenshot("01-flow-launched");

	const session = await waitForFlowTerminal(ctx);
	if (!session) {
		ctx.fail("session created", "no Draft Critique Revise E2E session reached a terminal status");
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

async function testLoopIterated(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: both personas took turns (draft + critique turns logged)");
	const session = readFlowSession(ctx.vaultPath);
	if (!session) {
		ctx.fail("loop iterated", "no session found");
		return;
	}
	const entries = parseLog(session.log);
	const draftTurns = entries.filter((e) => e.type === "turn.complete" && e.step === "Draft").length;
	const critiqueTurns = entries.filter((e) => e.type === "turn.complete" && e.step === "Critique").length;

	if (draftTurns >= 1 && critiqueTurns >= 1) {
		ctx.pass(
			"loop iterated",
			`Draft ran ${draftTurns}x, Critique ran ${critiqueTurns}x (multi-persona collaboration occurred)`,
		);
	} else {
		ctx.fail(
			"loop iterated",
			`expected >=1 Draft and >=1 Critique turn; saw Draft ${draftTurns}, Critique ${critiqueTurns}`,
		);
	}
}

async function testGateOwnsExit(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: the code-step Gate owned the exit and bounded the loop");
	const session = readFlowSession(ctx.vaultPath);
	if (!session) {
		ctx.fail("gate owns exit", "no session found");
		return;
	}
	const entries = parseLog(session.log);

	// The terminal FLOW_COMPLETE was emitted by the Gate code step.
	const gateCompleted = entries.some(
		(e) => e.type === "turn.complete" && e.step === "Gate" && e.emitted_topic === "FLOW_COMPLETE",
	);

	// The loop respected the cap: revise re-routes never exceed MAX_REVISE_ROUNDS.
	const reviseRounds = entries.filter(
		(e) =>
			(e.type === "event.emitted" && e.topic === "draft.revise") ||
			(e.type === "turn.complete" && e.step === "Gate" && e.emitted_topic === "draft.revise"),
	).length;

	if (gateCompleted && reviseRounds <= MAX_REVISE_ROUNDS) {
		ctx.pass(
			"gate owns exit",
			`Gate emitted FLOW_COMPLETE; ${reviseRounds} revise round(s) (cap ${MAX_REVISE_ROUNDS}, no runaway)`,
		);
	} else if (!gateCompleted) {
		ctx.fail("gate owns exit", "the terminal FLOW_COMPLETE was not emitted by the Gate step");
	} else {
		ctx.fail(
			"gate owns exit",
			`revise rounds (${reviseRounds}) exceeded the cap (${MAX_REVISE_ROUNDS}) — the gate failed to bound the loop`,
		);
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
	await testLoopIterated(ctx);
	await testGateOwnsExit(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	orchestration_enabled: true,
	// Act mode so the conversation steps' write_note/read_note/emit_event are allowed;
	// auto-approve them so the multi-round loop stays unattended.
	mode: "act",
	auto_approve: {
		emit_event: true,
		write_note: true,
		read_note: true,
	},
});

runTest(
	{
		name: "orchestration-draft-critique",
		settings,
		setupVault: setupFlowFixtures,
		cleanupFiles: [FLOW_DIR],
	},
	tests,
);
