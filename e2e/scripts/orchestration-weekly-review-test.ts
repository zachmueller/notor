#!/usr/bin/env npx tsx
/**
 * Orchestration Weekly-Review Mega-Flow E2E Test (example flow #12)
 *
 * A committed regression fixture for the **composability showpiece**: a coordinator
 * flow that invokes several smaller INVOCABLE child flows via `run_flow`, then
 * aggregates each child's STRUCTURED return into a single weekly-review note. This
 * exercises the headline #12 mechanics:
 *   - flow-as-invocable-tool (call/return) for MULTIPLE children;
 *   - structured-return aggregation (engine reality #5: a child returns a typed
 *     object only when its terminal step is a code step passing emit's 3rd arg);
 *   - deep nesting (the run-tree's parent_session_id / child.spawned backing data);
 *   - a coordinator that raises the default ceilings because every nested child
 *     draws down the SAME aggregate budget cell (engine reality #3).
 *
 * Flows authored inline (mirrors orchestration-run-flow-test.ts):
 *   - "Weekly Digest E2E" (invocable): a CONVERSATION step writes a one-line digest
 *     to its scratchpad, then a terminal CODE step returns { digest, kind } structured.
 *     (Proves a conversation-step child nests and its structured return flows up.)
 *   - "Vault Stats E2E" (invocable): a single terminal CODE step that counts vault
 *     notes and returns { noteCount, kind } structured. (A pure-code child.)
 *   - "Weekly Review E2E" (coordinator): dispatch-digest → dispatch-stats → compose.
 *     Each dispatch is a code step calling `run_flow`; compose aggregates BOTH
 *     children's structured returns into Weekly/weekly-review.md, then FLOW_COMPLETE.
 *
 * Infra invariants asserted (never the LLM's prose):
 *   1. The coordinator (origin "user") reaches terminal status `completed`.
 *   2. Both children ran: the coordinator's ledger has >=2 child.spawned + >=2
 *      child.result, and >=2 sessions have origin "run_flow" + parent_session_id ==
 *      the coordinator (deep nesting / run-tree backing).
 *   3. Structured aggregation worked: weekly-review.md contains the digest section
 *      (from child A's structured return) AND a "Notes in vault: <n>" line (from
 *      child B's structured return).
 *   4. The coordinator's code steps ran without a `{step}.code_error`.
 *
 * Prerequisites:
 *   - AWS profile `default` with Bedrock access (child A has one conversation step).
 *
 * Run with:
 *   npx tsx e2e/scripts/orchestration-weekly-review-test.ts
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — run_flow / structured returns
 * @see ~/zm/ai/notor/ideas/Example orchestration flows to ship.md — flow #12
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

const DIGEST_NAME = "Weekly Digest E2E";
const STATS_NAME = "Vault Stats E2E";
const COORD_NAME = "Weekly Review E2E";
const DIGEST_DIR = `${ORCH_DIR}/weekly-digest-e2e`;
const STATS_DIR = `${ORCH_DIR}/vault-stats-e2e`;
const COORD_DIR = `${ORCH_DIR}/weekly-review-e2e`;

const REVIEW_PATH = "Weekly/weekly-review.md";

// ---- Child A: "Weekly Digest E2E" (conversation step + terminal code step) ----

const DIGEST_DEFINITION = `---
notor-type: orchestration-flow
notor-flow-name: "${DIGEST_NAME}"
notor-flow-description: "Invocable child: write a weekly digest and return it structured."
notor-starting-event: digest.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 10
notor-max-runtime-minutes: 10
notor-flow-invocable: true
notor-flow-inputs: "A short description of the week to digest."
notor-flow-returns: "A structured object { digest, kind } with a one-line digest."
notor-max-depth: 3
notor-steps:
  - "[[write-digest]]"
  - "[[finalize-digest]]"
---

# Weekly Digest E2E

Documentation only.
`;

const WRITE_DIGEST = `---
notor-type: orchestration-step
notor-step-name: "Write Digest"
notor-step-description: "Conversation step: writes a one-line weekly digest."
notor-step-triggers:
  - digest.start
notor-step-publishes:
  - digest.written
notor-step-default-publishes: digest.written
---

You are the Write Digest step. Do EXACTLY this, then stop:

1. Write ONE sentence summarizing a productive week (use the objective for flavor).
2. Call \`write_note\` with path "${DIGEST_DIR}/scratch-digest.md" and that sentence as content.
3. Call \`emit_event\` with topic "digest.written" and payload "digest written".

Do not emit any other topic. Keep it to one sentence.
`;

const FINALIZE_DIGEST = `---
notor-type: orchestration-step
notor-step-name: "Finalize Digest"
notor-step-description: "Terminal code step: returns the digest as a structured payload."
notor-step-mode: code
notor-step-triggers:
  - digest.written
notor-step-publishes:
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

# Finalize Digest

\`\`\`typescript
// Read the digest the conversation step wrote (fall back so the structured return is
// always well-formed even if the turn produced nothing).
const file = utils.resolveNote("${DIGEST_DIR}/scratch-digest.md");
let digest = "";
if (file) digest = (await app.vault.read(file)).trim();
if (!digest) digest = "Weekly digest (no content captured).";

// Terminal code step: the 3rd emit arg is the reliable structured return run_flow prefers.
return orchestration.emit("FLOW_COMPLETE", "digest ready", { digest, kind: "digest" });
\`\`\`
`;

// ---- Child B: "Vault Stats E2E" (single terminal code step) ----

const STATS_DEFINITION = `---
notor-type: orchestration-flow
notor-flow-name: "${STATS_NAME}"
notor-flow-description: "Invocable child: count vault notes and return the count structured."
notor-starting-event: stats.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 5
notor-max-runtime-minutes: 5
notor-flow-invocable: true
notor-flow-inputs: "No meaningful input — counts the whole vault."
notor-flow-returns: "A structured object { noteCount, kind }."
notor-max-depth: 3
notor-steps:
  - "[[count]]"
---

# Vault Stats E2E

Documentation only.
`;

const COUNT = `---
notor-type: orchestration-step
notor-step-name: "Count"
notor-step-description: "Terminal code step: counts vault markdown notes."
notor-step-mode: code
notor-step-triggers:
  - stats.start
notor-step-publishes:
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

# Count

\`\`\`typescript
const noteCount = app.vault.getMarkdownFiles().length;
return orchestration.emit("FLOW_COMPLETE", "counted", { noteCount, kind: "stats" });
\`\`\`
`;

// ---- Coordinator: "Weekly Review E2E" (run_flow x2 → aggregate) ----

const COORD_DEFINITION = `---
notor-type: orchestration-flow
notor-flow-name: "${COORD_NAME}"
notor-flow-description: "Coordinator: invoke child flows via run_flow and aggregate their structured returns (example #12)."
notor-starting-event: review.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 40
notor-max-runtime-minutes: 30
notor-max-cost-usd: 8.00
notor-max-depth: 3
notor-steps:
  - "[[dispatch-digest]]"
  - "[[dispatch-stats]]"
  - "[[compose]]"
---

# Weekly Review E2E

A coordinator that nests several invocable child flows. Because every nested child
draws down the SAME aggregate budget cell by reference, the ceilings here are raised
above the engine defaults (engine reality #3).

Documentation only.
`;

const DISPATCH_DIGEST = `---
notor-type: orchestration-step
notor-step-name: "Dispatch Digest"
notor-step-description: "Invokes the Weekly Digest child flow via run_flow."
notor-step-mode: code
notor-step-triggers:
  - review.start
notor-step-publishes:
  - digest.gathered
notor-step-default-publishes: digest.gathered
---

# Dispatch Digest

\`\`\`typescript
const childResult = await orchestration.callTool("run_flow", {
  flow: "${DIGEST_NAME}",
  payload: event.payload || "this week",
});
// run_flow returns the child's structured object, JSON-encoded as text.
await orchestration.scratchpad.write("child-digest.json", childResult);
return orchestration.emit("digest.gathered", "digest child returned");
\`\`\`
`;

const DISPATCH_STATS = `---
notor-type: orchestration-step
notor-step-name: "Dispatch Stats"
notor-step-description: "Invokes the Vault Stats child flow via run_flow."
notor-step-mode: code
notor-step-triggers:
  - digest.gathered
notor-step-publishes:
  - stats.gathered
notor-step-default-publishes: stats.gathered
---

# Dispatch Stats

\`\`\`typescript
const childResult = await orchestration.callTool("run_flow", {
  flow: "${STATS_NAME}",
  payload: "count the vault",
});
await orchestration.scratchpad.write("child-stats.json", childResult);
return orchestration.emit("stats.gathered", "stats child returned");
\`\`\`
`;

const COMPOSE = `---
notor-type: orchestration-step
notor-step-name: "Compose"
notor-step-description: "Aggregates both children's structured returns into one note."
notor-step-mode: code
notor-step-triggers:
  - stats.gathered
notor-step-publishes:
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

# Compose

\`\`\`typescript
function parseObj(text) {
  const raw = (text || "").trim();
  try { return JSON.parse(raw); } catch (_e) { /* fall through */ }
  const open = raw.indexOf("{"), close = raw.lastIndexOf("}");
  if (open !== -1 && close > open) {
    try { return JSON.parse(raw.slice(open, close + 1)); } catch (_e2) { /* fall through */ }
  }
  return {};
}

const digestObj = parseObj(await orchestration.scratchpad.read("child-digest.json"));
const statsObj = parseObj(await orchestration.scratchpad.read("child-stats.json"));

const digest = typeof digestObj.digest === "string" ? digestObj.digest : "(no digest returned)";
const noteCount = typeof statsObj.noteCount === "number" ? statsObj.noteCount : -1;

const lines = [];
lines.push("# Weekly Review");
lines.push("");
lines.push("Aggregated from " + 2 + " child flows via run_flow.");
lines.push("");
lines.push("## Digest");
lines.push(digest);
lines.push("");
lines.push("## Vault Stats");
lines.push("Notes in vault: " + noteCount);
lines.push("");
await orchestration.callTool("write_note", { path: "${REVIEW_PATH}", content: lines.join("\\n") });

return orchestration.emit("FLOW_COMPLETE", "Weekly review composed from 2 child flows.");
\`\`\`
`;

const FLOW_TIMEOUT_MS = 240_000;
const POLL_MS = 2_000;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function setupFlowFixtures(vaultPath: string): void {
	writeCleanWorkspace(vaultPath);

	const digestSteps = path.join(vaultPath, DIGEST_DIR, "steps");
	const statsSteps = path.join(vaultPath, STATS_DIR, "steps");
	const coordSteps = path.join(vaultPath, COORD_DIR, "steps");
	fs.mkdirSync(digestSteps, { recursive: true });
	fs.mkdirSync(statsSteps, { recursive: true });
	fs.mkdirSync(coordSteps, { recursive: true });

	fs.writeFileSync(path.join(vaultPath, DIGEST_DIR, "definition.md"), DIGEST_DEFINITION);
	fs.writeFileSync(path.join(digestSteps, "write-digest.md"), WRITE_DIGEST);
	fs.writeFileSync(path.join(digestSteps, "finalize-digest.md"), FINALIZE_DIGEST);

	fs.writeFileSync(path.join(vaultPath, STATS_DIR, "definition.md"), STATS_DEFINITION);
	fs.writeFileSync(path.join(statsSteps, "count.md"), COUNT);

	fs.writeFileSync(path.join(vaultPath, COORD_DIR, "definition.md"), COORD_DEFINITION);
	fs.writeFileSync(path.join(coordSteps, "dispatch-digest.md"), DISPATCH_DIGEST);
	fs.writeFileSync(path.join(coordSteps, "dispatch-stats.md"), DISPATCH_STATS);
	fs.writeFileSync(path.join(coordSteps, "compose.md"), COMPOSE);
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

function coordinator(vaultPath: string): SessionInfo | undefined {
	return readAllSessions(vaultPath).find(
		(s) => s.meta.origin === "user" && s.meta.flow_name === COORD_NAME,
	);
}

function logTypes(log: string): string[] {
	return log
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => {
			try {
				return JSON.parse(l).type as string;
			} catch {
				return "";
			}
		});
}

async function waitForCoordinatorTerminal(ctx: TestContext): Promise<SessionInfo | null> {
	const start = Date.now();
	while (Date.now() - start < FLOW_TIMEOUT_MS) {
		await ctx.page.waitForTimeout(POLL_MS);
		const c = coordinator(ctx.vaultPath);
		const status = c?.meta?.status;
		if (status === "completed" || status === "cancelled" || status === "error") return c ?? null;
		const sessions = readAllSessions(ctx.vaultPath).length;
		const elapsed = Math.round((Date.now() - start) / 1000);
		console.log(`    [${elapsed}s] coordinator status: ${String(status ?? "(none)")} (${sessions} session(s))`);
	}
	return coordinator(ctx.vaultPath) ?? null;
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

async function testCoordinatorCompletes(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: the coordinator invokes both children and runs to FLOW_COMPLETE");
	const { page } = ctx;

	const enabled = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return plugin?.settings?.orchestration_enabled === true;
	});
	if (!enabled) {
		ctx.fail("orchestration enabled", "orchestration_enabled is not true at runtime");
		return;
	}

	const launched = await launchFlow(ctx, COORD_NAME, "Assemble my weekly review.");
	if (!launched) {
		ctx.fail("flow launched", "objective modal did not appear after selecting the coordinator flow");
		return;
	}
	const shot = await ctx.screenshot("01-coordinator-launched");

	const coord = await waitForCoordinatorTerminal(ctx);
	if (!coord) {
		ctx.fail("coordinator completed", "no coordinator (origin user) session reached a terminal status");
		return;
	}
	if (coord.meta.status === "completed") {
		ctx.pass("coordinator completed", `coordinator session.json status is 'completed' (id ${coord.id})`, shot);
	} else {
		ctx.fail("coordinator completed", `coordinator status is '${String(coord.meta.status)}' (expected 'completed')`, shot);
	}
}

function testChildrenNested(ctx: TestContext): void {
	console.log("\nTest 2: both children spawned + nested under the coordinator (run-tree backing)");
	const coord = coordinator(ctx.vaultPath);
	if (!coord) {
		ctx.fail("children nested", "no coordinator session");
		return;
	}
	const types = logTypes(coord.log);
	const spawned = types.filter((t) => t === "child.spawned").length;
	const results = types.filter((t) => t === "child.result").length;

	const children = readAllSessions(ctx.vaultPath).filter(
		(s) => s.meta.origin === "run_flow" && s.meta.parent_session_id === coord.id,
	);

	if (spawned >= 2 && results >= 2 && children.length >= 2) {
		ctx.pass(
			"children nested",
			`coordinator ledger: ${spawned} child.spawned / ${results} child.result; ${children.length} run_flow child session(s) parented to it`,
		);
	} else {
		ctx.fail(
			"children nested",
			`expected >=2 of each: child.spawned=${spawned}, child.result=${results}, nested children=${children.length}`,
		);
	}
}

function testStructuredAggregation(ctx: TestContext): void {
	console.log("\nTest 3: both children's structured returns aggregated into the review note");
	const reviewFull = path.join(ctx.vaultPath, REVIEW_PATH);
	if (!fs.existsSync(reviewFull)) {
		ctx.fail("structured aggregation", `no weekly review note at ${REVIEW_PATH}`);
		return;
	}
	const review = fs.readFileSync(reviewFull, "utf8");

	// From child B (pure code, fully deterministic): "Notes in vault: <n>" with n >= 1.
	const statsMatch = review.match(/Notes in vault:\s*(\d+)/);
	const statsOk = !!statsMatch && Number(statsMatch[1]) >= 1;

	// From child A (structured digest flowed up): a non-empty Digest section that is
	// NOT the "no digest returned" fallback.
	const digestMatch = review.match(/##\s*Digest\s*\n([\s\S]*?)\n##/);
	const digestBody = (digestMatch?.[1] ?? "").trim();
	const digestOk = digestBody.length > 0 && !digestBody.includes("no digest returned");

	if (statsOk && digestOk) {
		ctx.pass(
			"structured aggregation",
			`review note carries child B's count (${statsMatch![1]}) and child A's digest (${digestBody.length} chars)`,
		);
	} else {
		ctx.fail(
			"structured aggregation",
			`statsOk=${statsOk}, digestOk=${digestOk} — review note did not aggregate both structured returns`,
		);
	}
}

function testCoordinatorCodeClean(ctx: TestContext): void {
	console.log("\nTest 4: the coordinator's code steps ran without a code_error");
	const coord = coordinator(ctx.vaultPath);
	if (!coord) {
		ctx.fail("coordinator code clean", "no coordinator session");
		return;
	}
	if (coord.log.includes(".code_error")) {
		ctx.fail("coordinator code clean", "coordinator session-log contains a `{step}.code_error` emission");
	} else {
		ctx.pass("coordinator code clean", "no `{step}.code_error` emission in the coordinator log");
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // plugin init + Bedrock provider registration
	await waitForSelector(page, ".notor-chat-container", 8000);

	await testCoordinatorCompletes(ctx);
	testChildrenNested(ctx);
	testStructuredAggregation(ctx);
	testCoordinatorCodeClean(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	orchestration_enabled: true,
	mode: "act",
	auto_approve: {
		emit_event: true,
		run_flow: true,
		write_note: true,
		read_note: true,
	},
});

runTest(
	{
		name: "orchestration-weekly-review",
		settings,
		setupVault: setupFlowFixtures,
		cleanupFiles: [DIGEST_DIR, STATS_DIR, COORD_DIR, "Weekly"],
	},
	tests,
);
