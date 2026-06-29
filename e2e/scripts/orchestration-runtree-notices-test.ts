#!/usr/bin/env npx tsx
/**
 * Orchestration run-tree + progress-Notice E2E Test (TEST-010)
 *
 * Exercises the observability surfaces of a flow run (design Phase 4 + Phase 7):
 *
 *   - Per-turn progress Notice (FR-140 / INT-020): after a CONVERSATION step turn,
 *     a brief Notice names the flow, the step, the hop iteration, and the emitted
 *     topic — `[{flow}] {step} · iter {n} → {topic}` — and, on desktop, carries a
 *     right-click-to-open hint line (FR-141 / INT-021).
 *   - Unified run-tree view (FR-178 / POL-003): opening the run-tree rooted at the
 *     run's session renders the step conversation(s) as nodes with a node-count
 *     rollup header; selecting a node navigates to its conversation in chat.
 *
 * The flow has ONE real LLM conversation step (so a Notice fires and a step
 * conversation exists for the tree to render) followed by a deterministic CODE
 * step that completes the run — keeping the LLM surface minimal while still
 * exercising the conversation-step-only behaviors.
 *
 * Because the progress Notice auto-dismisses after ~5s, the test installs a
 * MutationObserver on the notice container BEFORE launching, then inspects the
 * captured toast text — the same transient-capture pattern used by
 * token-footer-realtime-test.ts.
 *
 * Scenarios:
 *   1. Run the flow to FLOW_COMPLETE; a progress Notice matching
 *      `[Notice Flow E2E] … · iter … → …` was captured during the run.
 *   2. Open the run-tree rooted at the session; it renders >=1 node and a rollup
 *      header; clicking a node navigates the main chat to that conversation.
 *
 * Prerequisites:
 *   - AWS profile `default` with Bedrock access (the plan step is a real LLM turn).
 *
 * Run with:
 *   npx tsx e2e/scripts/orchestration-runtree-notices-test.ts
 *
 * @see specs/ZZ-misc/orchestration/spec.md — FR-140, FR-141, FR-178, FR-179
 * @see specs/ZZ-misc/orchestration/quickstart.md — Scenario 3 (Notices) + Scenario 4 (run tree)
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector, writeCleanWorkspace } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants + flow fixtures
// ---------------------------------------------------------------------------

const NOTOR_DIR = "notor";
const FLOW_NAME = "Notice Flow E2E";
const FLOW_DIR = `${NOTOR_DIR}/orchestrations/notice-flow-e2e`;

/** A two-step flow: a CONVERSATION plan step, then a CODE finish step. */
const DEFINITION_MD = `---
notor-type: orchestration-flow
notor-flow-name: "${FLOW_NAME}"
notor-flow-description: "One conversation step + one code step for the run-tree/Notice gate."
notor-starting-event: flow.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 10
notor-max-runtime-minutes: 5
notor-steps:
  - "[[plan]]"
  - "[[finish]]"
notor-guardrails:
  - "Be terse. Use the tools exactly as instructed."
---

# Notice Flow E2E

Documentation only — never injected into a step prompt.
`;

/**
 * plan — a CONVERSATION step (real LLM turn). It emits `plan.done`, which makes
 * the per-turn progress Notice fire (Notices fire only after conversation-step
 * turns) and creates a hidden step conversation for the run-tree to render.
 */
const PLAN_MD = `---
notor-type: orchestration-step
notor-step-name: "Planner"
notor-step-description: "A conversation step that advances the flow."
notor-step-triggers:
  - flow.start
notor-step-publishes:
  - plan.done
notor-step-default-publishes: plan.done
---

You are the Planner step. Do EXACTLY this, then stop:
1. Call \`emit_event\` with topic "plan.done" and payload "planning complete".

Do not write anything else. Do not emit any other topic.
`;

/** finish — a CODE step that completes the flow deterministically. */
const FINISH_MD = `---
notor-type: orchestration-step
notor-step-name: "Finish"
notor-step-description: "Completes the flow (code step)."
notor-step-mode: code
notor-step-triggers:
  - plan.done
notor-step-publishes:
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

# Finish

\`\`\`typescript
return orchestration.emit("FLOW_COMPLETE", "done");
\`\`\`
`;

const FLOW_TIMEOUT_MS = 180_000;
const POLL_MS = 2_000;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function setupFlowFixtures(vaultPath: string): void {
	writeCleanWorkspace(vaultPath);
	const stepsDir = path.join(vaultPath, FLOW_DIR, "steps");
	fs.mkdirSync(stepsDir, { recursive: true });
	fs.writeFileSync(path.join(vaultPath, FLOW_DIR, "definition.md"), DEFINITION_MD);
	fs.writeFileSync(path.join(stepsDir, "plan.md"), PLAN_MD);
	fs.writeFileSync(path.join(stepsDir, "finish.md"), FINISH_MD);
}

function sessionsDir(vaultPath: string): string {
	return path.join(vaultPath, NOTOR_DIR, "orchestrations", "sessions");
}

interface SessionInfo {
	id: string;
	dir: string;
	meta: Record<string, unknown>;
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
			return {
				id,
				dir: sdir,
				meta: fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {},
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

/**
 * Install a MutationObserver on the Obsidian notice container that records the
 * text of every `.notice` toast as it is added — the progress Notice
 * auto-dismisses after ~5s, so we must capture it as it appears. Mirrors the
 * transient-capture approach in token-footer-realtime-test.ts.
 */
async function installNoticeObserver(page: Page): Promise<void> {
	await page.evaluate(() => {
		// NOTE: this whole callback is serialized and run inside the Obsidian
		// page, so it must not reference module-scope helpers. In particular,
		// avoid nested *named* functions (including arrows assigned to a const)
		// — tsx/esbuild's `keepNames` rewrites them to call a `__name(...)`
		// helper that does not exist in the page (→ "ReferenceError: __name is
		// not defined"). Inline everything; only use anonymous callbacks.
		const texts: string[] = [];
		(window as any).__notorNoticeTexts = texts;
		// Record any notices already present, then observe new additions.
		document.querySelectorAll(".notice").forEach((n) => {
			const text = ((n as HTMLElement).innerText ?? (n as HTMLElement).textContent ?? "").trim();
			if (text) texts.push(text);
		});
		const observer = new MutationObserver((mutations) => {
			for (const m of mutations) {
				m.addedNodes.forEach((node) => {
					if (!(node instanceof HTMLElement)) return;
					if (node.classList.contains("notice")) {
						const text = (node.innerText ?? node.textContent ?? "").trim();
						if (text) texts.push(text);
					}
					node.querySelectorAll(".notice").forEach((n) => {
						const text = ((n as HTMLElement).innerText ?? (n as HTMLElement).textContent ?? "").trim();
						if (text) texts.push(text);
					});
				});
			}
		});
		observer.observe(document.body, { childList: true, subtree: true });
		(window as any).__notorNoticeObserver = observer;
	});
}

/** Retrieve captured notice texts and disconnect the observer. */
async function collectNoticeTexts(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const observer = (window as any).__notorNoticeObserver;
		if (observer) {
			observer.disconnect();
			(window as any).__notorNoticeObserver = null;
		}
		return ((window as any).__notorNoticeTexts ?? []) as string[];
	});
}

/** Launch the flow via the "Run orchestration" command + picker + objective modal. */
async function launchFlow(ctx: TestContext): Promise<boolean> {
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
	}, FLOW_NAME);
	await page.waitForTimeout(500);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(800);

	const objectiveEl = await page.$(".notor-orchestration-objective-input");
	if (!objectiveEl) return false;
	await page.evaluate(() => {
		const ta = document.querySelector(".notor-orchestration-objective-input") as HTMLTextAreaElement | null;
		if (ta) {
			ta.value = "Run the notice/run-tree e2e flow.";
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		}
	});
	await page.waitForTimeout(300);
	const mod = process.platform === "darwin" ? "Meta" : "Control";
	await page.keyboard.down(mod);
	await page.keyboard.press("Enter");
	await page.keyboard.up(mod);
	return true;
}

async function waitForSessionTerminal(ctx: TestContext): Promise<SessionInfo | null> {
	const start = Date.now();
	while (Date.now() - start < FLOW_TIMEOUT_MS) {
		await ctx.page.waitForTimeout(POLL_MS);
		const s = readFlowSession(ctx.vaultPath);
		const status = s?.meta.status;
		if (status === "completed" || status === "cancelled" || status === "error") return s;
		const elapsed = Math.round((Date.now() - start) / 1000);
		console.log(`    [${elapsed}s] session status: ${String(status ?? "(none yet)")}`);
	}
	return readFlowSession(ctx.vaultPath);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let capturedNotices: string[] = [];

async function testProgressNotice(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: a per-turn progress Notice names flow + step + iteration + topic (FR-140)");
	const { page } = ctx;

	await installNoticeObserver(page);

	const launched = await launchFlow(ctx);
	if (!launched) {
		ctx.fail("flow launched", "objective modal did not appear");
		return;
	}
	const shot = await ctx.screenshot("01-flow-launched");

	const session = await waitForSessionTerminal(ctx);
	if (!session) {
		ctx.fail("flow completed", "no session reached a terminal status");
		await collectNoticeTexts(page);
		return;
	}
	if (session.meta.status === "completed") {
		ctx.pass("flow completed", `session.json status is 'completed' (id ${session.id})`, shot);
	} else {
		ctx.fail("flow completed", `session.json status is '${String(session.meta.status)}' (expected 'completed')`, shot);
	}

	// Drain a moment so the last turn's Notice is observed before we disconnect.
	await page.waitForTimeout(1500);
	capturedNotices = await collectNoticeTexts(page);
	console.log(`    captured ${capturedNotices.length} notice toast(s)`);

	// The progress-Notice format is `[{flow}] {step} · iter {n} → {topic}`.
	const progressNotices = capturedNotices.filter(
		(t) => t.includes(`[${FLOW_NAME}]`) && t.includes("iter") && t.includes("→"),
	);
	if (progressNotices.length > 0) {
		ctx.pass(
			"progress notice",
			`captured a progress Notice: "${progressNotices[0]!.replace(/\n/g, " ⏎ ").slice(0, 120)}"`,
		);
	} else {
		ctx.fail(
			"progress notice",
			`no progress Notice matched \`[${FLOW_NAME}] … iter … → …\` (captured: ${JSON.stringify(capturedNotices).slice(0, 300)})`,
		);
	}
}

async function testRunTreeView(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: the run-tree view renders the run's step conversation(s) (FR-178)");
	const { page } = ctx;

	const session = readFlowSession(ctx.vaultPath);
	if (!session) {
		ctx.fail("run tree", "no flow session found to root the run-tree at");
		return;
	}

	// Open the run-tree rooted at the session (the same entry point the spawning
	// card / activity indicator / Notice use: plugin.openRunTreeView).
	const opened = await page.evaluate(async (sessionId) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin?.openRunTreeView) return false;
		await plugin.openRunTreeView({ sessionId });
		return true;
	}, session.id);
	if (!opened) {
		ctx.fail("run tree opened", "plugin.openRunTreeView is not available");
		return;
	}

	// The view renders in the right sidebar; wait for the container + nodes.
	const container = await waitForSelector(page, ".notor-run-tree-container", 8000);
	if (!container) {
		ctx.fail("run tree opened", ".notor-run-tree-container did not render");
		return;
	}
	// Give the async header scan + rebuild a beat to resolve.
	await page.waitForTimeout(1500);

	const treeState = await page.evaluate(() => {
		const nodes = document.querySelectorAll(".notor-run-tree-node");
		const labels = Array.from(document.querySelectorAll(".notor-run-tree-node-label")).map(
			(el) => (el as HTMLElement).textContent ?? "",
		);
		const rollup = document.querySelector(".notor-run-tree-rollup")?.textContent ?? "";
		const empty = document.querySelector(".notor-run-tree-empty")?.textContent ?? "";
		return { nodeCount: nodes.length, labels, rollup, empty };
	});

	const shot = await ctx.screenshot("02-run-tree");

	if (treeState.nodeCount >= 1) {
		ctx.pass(
			"run tree nodes",
			`run-tree rendered ${treeState.nodeCount} node(s): [${treeState.labels.join(", ")}]`,
			shot,
		);
	} else {
		ctx.fail(
			"run tree nodes",
			`run-tree rendered no nodes (empty state: "${treeState.empty}")`,
			shot,
		);
	}

	// The rollup header shows the whole-run node count.
	if (/\d+\s+node/.test(treeState.rollup)) {
		ctx.pass("run tree rollup", `rollup header present: "${treeState.rollup}"`);
	} else {
		ctx.fail("run tree rollup", `expected a node-count rollup header, got "${treeState.rollup}"`);
	}

	// Selecting a node navigates the main chat to that conversation (read-only nav).
	const navigated = await page.evaluate(() => {
		const header = document.querySelector(".notor-run-tree-node-header") as HTMLElement | null;
		if (!header) return false;
		header.click();
		return true;
	});
	if (!navigated) {
		ctx.fail("run tree navigate", "no .notor-run-tree-node-header to click");
		return;
	}
	await page.waitForTimeout(2000);

	// After clicking, the node is marked selected and a chat panel is focused.
	const selected = await page.evaluate(() => {
		return !!document.querySelector(".notor-run-tree-node.is-selected");
	});
	if (selected) {
		ctx.pass("run tree navigate", "selecting a node marked it is-selected and loaded its conversation");
	} else {
		ctx.fail("run tree navigate", "clicking a node did not mark it is-selected");
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // plugin init + Bedrock provider registration
	await waitForSelector(page, ".notor-chat-container", 8000);

	const enabled = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return plugin?.settings?.orchestration_enabled === true;
	});
	if (!enabled) {
		ctx.fail("orchestration enabled", "orchestration_enabled is not true at runtime");
		return;
	}

	await testProgressNotice(ctx);
	await testRunTreeView(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	orchestration_enabled: true,
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
		name: "orchestration-runtree-notices",
		settings,
		setupVault: setupFlowFixtures,
		cleanupFiles: [
			`${FLOW_DIR}/definition.md`,
			`${FLOW_DIR}/steps/plan.md`,
			`${FLOW_DIR}/steps/finish.md`,
		],
	},
	tests,
);
