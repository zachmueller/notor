#!/usr/bin/env npx tsx
/**
 * Circuit vocabulary + legacy alias E2E test (orchestrations → circuits reframe).
 *
 * Authors a circuit entirely in the NEW vocabulary under `notor/circuits/`
 * while seeding settings with LEGACY keys, then runs it through the unchanged
 * command ID. Locks in, end to end:
 *   - `notor-type: circuit` / `circuit-step` + `notor-circuit-*` keys are discovered
 *     under the new `circuits/` root;
 *   - the legacy `orchestration_enabled` + `auto_approve.orchestration_task_*`
 *     seeds migrate on load (`circuits_enabled`, `auto_approve.circuit_task_*`);
 *   - only canonical tool names are registered (`run_circuit`, `circuit_task_*`);
 *   - the `notor:run-orchestration` command ID still launches circuits;
 *   - a conversation step calling `circuit_task_*` and a code step returning
 *     `circuit.emit("CIRCUIT_COMPLETE", …)` complete the run;
 *   - persisted data stays canonical: `turn.complete.emitted_topic === "FLOW_COMPLETE"`,
 *     and sessions land in the install's sticky data root.
 *
 * Prerequisites:
 *   - AWS profile `default` with Bedrock access (one real LLM step turn).
 *
 * Run with:
 *   npx tsx e2e/scripts/circuit-alias-test.ts   (or: npm run e2e:circuit:alias)
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector, writeCleanWorkspace } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Fixtures (new vocabulary only)
// ---------------------------------------------------------------------------

const NOTOR_DIR = "notor";
const CIRCUIT_DIR = `${NOTOR_DIR}/circuits/alias-e2e`;
const CIRCUIT_NAME = "Circuit Alias E2E";

const DEFINITION_MD = `---
notor-type: circuit
notor-circuit-name: "${CIRCUIT_NAME}"
notor-circuit-description: "Exercises the circuit vocabulary end to end."
notor-starting-event: alias.start
notor-completion-event: CIRCUIT_COMPLETE
notor-max-iterations: 10
notor-max-runtime-minutes: 5
notor-steps:
  - "[[planner]]"
  - "[[verify]]"
notor-guardrails:
  - "Be terse. Use the tools exactly as instructed."
---

Documentation only.
`;

/** Conversation step: uses the renamed task tools, then advances. */
const PLANNER_MD = `---
notor-type: circuit-step
notor-step-name: "Planner"
notor-step-triggers:
  - alias.start
notor-step-publishes:
  - plan.done
notor-step-default-publishes: plan.done
---

You are the Planner step. Do EXACTLY this, then stop:
1. Call \`circuit_task_ensure\` with key "alias-1" and description "Alias check".
2. Call \`circuit_task_close\` with key "alias-1".
3. Call \`emit_event\` with topic "plan.done" and payload "planned".

Do not write anything else. Do not emit any other topic.
`;

/** Code step: routes with the `circuit` helper and a CIRCUIT_* terminal alias. */
const VERIFY_MD = `---
notor-type: circuit-step
notor-step-name: "Verify"
notor-step-mode: code
notor-step-triggers:
  - plan.done
notor-step-publishes:
  - CIRCUIT_COMPLETE
---

\`\`\`ts
const same = circuit === orchestration;
circuit.log.info("alias check", { same });
return circuit.emit("CIRCUIT_COMPLETE", same ? "aliases ok" : "helper mismatch", { same });
\`\`\`
`;

const RUN_TIMEOUT_MS = 180_000;
const POLL_MS = 2_000;

function setupFixtures(vaultPath: string): void {
	writeCleanWorkspace(vaultPath);
	const stepsDir = path.join(vaultPath, CIRCUIT_DIR, "steps");
	fs.mkdirSync(stepsDir, { recursive: true });
	fs.writeFileSync(path.join(vaultPath, CIRCUIT_DIR, "definition.md"), DEFINITION_MD);
	fs.writeFileSync(path.join(stepsDir, "planner.md"), PLANNER_MD);
	fs.writeFileSync(path.join(stepsDir, "verify.md"), VERIFY_MD);
}

/** The sticky data root rule (mirrors src/circuits/data-root.ts). */
function dataRootSessionsDir(vaultPath: string): string {
	const base = path.join(vaultPath, NOTOR_DIR);
	if (fs.existsSync(path.join(base, "circuits", "sessions"))) return path.join(base, "circuits", "sessions");
	if (fs.existsSync(path.join(base, "orchestrations"))) return path.join(base, "orchestrations", "sessions");
	return path.join(base, "circuits", "sessions");
}

function readLatestSession(vaultPath: string): { id: string; meta: Record<string, unknown>; dir: string } | null {
	const sessionsDir = dataRootSessionsDir(vaultPath);
	if (!fs.existsSync(sessionsDir)) return null;
	const ids = fs.readdirSync(sessionsDir).filter((d) => fs.statSync(path.join(sessionsDir, d)).isDirectory());
	if (ids.length === 0) return null;
	ids.sort((a, b) => fs.statSync(path.join(sessionsDir, b)).mtimeMs - fs.statSync(path.join(sessionsDir, a)).mtimeMs);
	const id = ids[0]!;
	const dir = path.join(sessionsDir, id);
	const metaPath = path.join(dir, "session.json");
	if (!fs.existsSync(metaPath)) return { id, meta: {}, dir };
	return { id, meta: JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>, dir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSettingsMigratedAndToolsCanonical(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Legacy settings seeds migrate; only canonical tool names register");
	const state = await ctx.page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const s = plugin?.settings ?? {};
		const registry = plugin?.getToolRegistry?.();
		return {
			circuitsEnabled: s.circuits_enabled === true,
			legacyEnabledGone: s.orchestration_enabled === undefined,
			autoApprove: s.auto_approve ?? {},
			hasRunCircuit: registry?.has?.("run_circuit") === true,
			hasRunFlow: registry?.has?.("run_flow") === true,
			hasCircuitTask: registry?.has?.("circuit_task_ensure") === true,
			hasLegacyTask: registry?.has?.("orchestration_task_ensure") === true,
		};
	});

	if (state.circuitsEnabled && state.legacyEnabledGone) {
		ctx.pass("settings key migrated", "orchestration_enabled → circuits_enabled");
	} else {
		ctx.fail("settings key migrated", JSON.stringify(state));
	}

	const aa = state.autoApprove as Record<string, unknown>;
	if (aa.circuit_task_ensure === true && aa.circuit_task_close === true && !("orchestration_task_ensure" in aa)) {
		ctx.pass("auto_approve keys migrated", "orchestration_task_* → circuit_task_*");
	} else {
		ctx.fail("auto_approve keys migrated", JSON.stringify(aa));
	}

	if (state.hasRunCircuit && state.hasCircuitTask && !state.hasRunFlow && !state.hasLegacyTask) {
		ctx.pass("canonical tool names", "run_circuit + circuit_task_* registered; legacy names are aliases only");
	} else {
		ctx.fail("canonical tool names", JSON.stringify(state));
	}
}

async function testRunCircuitViaLegacyCommandId(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: notor:run-orchestration launches a circuit-vocabulary circuit to completion");
	const { page } = ctx;

	await page.evaluate(() => {
		(window as any).app?.commands?.executeCommandById?.("notor:run-orchestration");
	});
	await page.waitForTimeout(1000);

	const picker = await page.$(".prompt-input, .suggestion-container");
	if (!picker) {
		ctx.fail("circuit picker", "Picker did not open from notor:run-orchestration");
		return;
	}
	await page.evaluate((name) => {
		const input = document.querySelector(".prompt-input") as HTMLInputElement | null;
		if (input) {
			input.value = name;
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
	}, CIRCUIT_NAME);
	await page.waitForTimeout(500);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(800);

	const objective = await page.$(".notor-orchestration-objective-input");
	if (!objective) {
		ctx.fail("objective modal", "Objective modal did not appear after selecting the circuit");
		return;
	}
	await page.evaluate(() => {
		const ta = document.querySelector(".notor-orchestration-objective-input") as HTMLTextAreaElement | null;
		if (ta) {
			ta.value = "Run the alias e2e circuit.";
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		}
	});
	await page.waitForTimeout(300);
	const mod = process.platform === "darwin" ? "Meta" : "Control";
	await page.keyboard.down(mod);
	await page.keyboard.press("Enter");
	await page.keyboard.up(mod);
	ctx.pass("circuit launched", "Selected the circuit + submitted an objective", await ctx.screenshot("01-circuit-launched"));

	const start = Date.now();
	let session = readLatestSession(ctx.vaultPath);
	while (Date.now() - start < RUN_TIMEOUT_MS) {
		const status = session?.meta?.status;
		if (status === "completed" || status === "cancelled" || status === "error") break;
		console.log(`    [${Math.round((Date.now() - start) / 1000)}s] session status: ${String(status ?? "(none yet)")}`);
		await page.waitForTimeout(POLL_MS);
		session = readLatestSession(ctx.vaultPath);
	}

	if (!session) {
		ctx.fail("session created", `No session under ${path.relative(ctx.vaultPath, dataRootSessionsDir(ctx.vaultPath))}`);
		return;
	}
	if (session.meta.status === "completed") {
		ctx.pass("circuit completed", `session.json status 'completed' (id ${session.id})`);
	} else {
		ctx.fail("circuit completed", `session.json status '${String(session.meta.status)}'`);
		return;
	}

	const logPath = path.join(session.dir, "session-log.jsonl");
	const entries = fs.existsSync(logPath)
		? fs
				.readFileSync(logPath, "utf8")
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l) as Record<string, unknown>)
		: [];
	const turns = entries.filter((e) => e.type === "turn.complete");
	const verifyTurn = turns.find((e) => e.step === "Verify");
	if (verifyTurn?.emitted_topic === "FLOW_COMPLETE") {
		ctx.pass("canonical terminal topic", "circuit.emit(\"CIRCUIT_COMPLETE\") persisted as FLOW_COMPLETE");
	} else {
		ctx.fail("canonical terminal topic", `Verify turn: ${JSON.stringify(verifyTurn ?? null)}`);
	}
	if (entries.some((e) => e.type === "step.log" && JSON.stringify(e).includes("\"same\":true"))) {
		ctx.pass("circuit helper alias", "`circuit` and `orchestration` are the same helper object");
	} else {
		ctx.fail("circuit helper alias", "No step.log entry recording same:true");
	}
	if (!turns.some((e) => typeof e.emitted_topic === "string" && (e.emitted_topic as string).startsWith("CIRCUIT_"))) {
		ctx.pass("no alias leaks into the log", "every persisted terminal topic is the FLOW_* spelling");
	} else {
		ctx.fail("no alias leaks into the log", JSON.stringify(turns.map((t) => t.emitted_topic)));
	}
}

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(5_000); // plugin init + Bedrock provider registration
	await waitForSelector(ctx.page, ".notor-chat-container", 8000);
	await testSettingsMigratedAndToolsCanonical(ctx);
	await testRunCircuitViaLegacyCommandId(ctx);
}

// Seeds deliberately use LEGACY keys so every run exercises the migration.
const settings = buildDefaultSettings({
	orchestration_enabled: true,
	mode: "act",
	auto_approve: {
		emit_event: true,
		orchestration_task_ensure: true,
		orchestration_task_close: true,
	},
});

runTest(
	{
		name: "circuit-alias",
		settings,
		setupVault: setupFixtures,
		cleanupFiles: [
			`${CIRCUIT_DIR}/definition.md`,
			`${CIRCUIT_DIR}/steps/planner.md`,
			`${CIRCUIT_DIR}/steps/verify.md`,
		],
	},
	tests,
);
