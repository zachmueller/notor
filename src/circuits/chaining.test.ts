/**
 * F6 §5.3 — `chainToSuccessor` chaining gate (INT-045 / FR-175).
 *
 * Drives the chaining handoff over injected `resolveSuccessor` + `launch` seams
 * (no vault, no runner), locking the gate the review flagged:
 *  - a chain launches only on a discoverable, unblocked successor;
 *  - the SAME shared `AggregateBudget` cell flows to the successor **by reference**
 *    (an A → B → A cycle is bounded by one tree-wide ceiling, not a fresh budget);
 *  - the gate `depth + 1 >= maxDepth || iterationsRemaining <= 0 ||
 *    costRemainingUsd <= 0` blocks, and a blocked (or non-discoverable) handoff
 *    surfaces a Notice and **launches no successor** — with **no status change**
 *    (the code never mutated status; the old docstring's FLOW_ERROR claim was the
 *    drift, corrected in the module);
 *  - `parentScratchpadPath` is forwarded only for a `shared`-handoff successor.
 *
 * The launch-time guard (`launchOrchestration` only calls this when
 * `result.status === "completed" && flow.onCompleteFlow`) is asserted structurally
 * by locking `chainToSuccessor`'s no-op-on-missing-`onCompleteFlow` early return.
 *
 * @see specs/ZZ-misc/arch-review-july-2026/F6-launch-ts-decomposition.md — §5.3
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { chainToSuccessor, type ChainLauncher } from "./chaining";
import type { OrchestrationHost } from "./host";
import type { OrchestrationRunResult } from "./runner";
import { FLOW_COMPLETE, type OrchestrationFlow } from "./types";
import type { AggregateBudget } from "../run-loop/types";

// Capture Notice messages so the blocked/undiscoverable paths can be asserted.
const notices: string[] = [];
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	return {
		...actual,
		Notice: class {
			constructor(message: string | DocumentFragment) {
				notices.push(typeof message === "string" ? message : "[fragment]");
			}
			hide(): void {}
		},
	};
});

beforeEach(() => {
	notices.length = 0;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function flow(over: Partial<OrchestrationFlow> = {}): OrchestrationFlow {
	return {
		name: "Predecessor",
		description: "",
		flowDir: "d",
		startingEvent: "start",
		completionEvent: FLOW_COMPLETE,
		maxIterations: 100,
		maxRuntimeMinutes: 60,
		requiredEvents: [],
		fanoutTopics: [],
		steps: [],
		guardrails: [],
		schedule: null,
		invocable: false,
		flowInputs: null,
		flowReturns: null,
		onCompleteFlow: null,
		handoffIsolation: "isolated",
		maxDepth: null,
		maxCostUsd: 5,
		openNotesInEditor: null,
		allowConcurrent: false,
		...over,
	};
}

function budget(over: Partial<AggregateBudget> = {}): AggregateBudget {
	return { iterationsRemaining: 50, costRemainingUsd: 5, ...over };
}

function result(over: Partial<OrchestrationRunResult> = {}): OrchestrationRunResult {
	return {
		status: "completed",
		terminal: { topic: FLOW_COMPLETE, payload: "done", source_step: null, turn: 1, ts: "t" },
		iterations: 1,
		structured: null,
		text: "forwarded payload",
		subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: 0 },
		tokenUsage: { input: 0, output: 0 },
		budget: budget(),
		depth: 0,
		...over,
	};
}

/** A host stub — the injected `resolveSuccessor`/`launch` seams keep it inert. */
function fakeHost(): OrchestrationHost {
	return {
		settings: { notor_dir: "notor" },
		app: {},
	} as unknown as OrchestrationHost;
}

/** A spy launcher capturing the args the gate forwards to the successor run. */
function spyLauncher(): { launch: ChainLauncher; calls: Array<{ flow: OrchestrationFlow; prompt: string; options: NonNullable<Parameters<ChainLauncher>[3]> }> } {
	const calls: Array<{ flow: OrchestrationFlow; prompt: string; options: NonNullable<Parameters<ChainLauncher>[3]> }> = [];
	const launch: ChainLauncher = vi.fn(async (_host, f, prompt, options) => {
		calls.push({ flow: f, prompt, options: options ?? {} });
		return result();
	});
	return { launch, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("chainToSuccessor — chaining gate (F6 §5.3)", () => {
	it("no-ops when the predecessor declares no on-complete flow", async () => {
		const { launch, calls } = spyLauncher();
		const resolveSuccessor = vi.fn(async () => null);
		await chainToSuccessor(fakeHost(), flow({ onCompleteFlow: null }), result(), "sess-p", undefined, {
			resolveSuccessor,
			launch,
		});
		expect(resolveSuccessor).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
	});

	it("launches the successor when discoverable and unblocked", async () => {
		const { launch, calls } = spyLauncher();
		const successor = flow({ name: "Successor" });
		await chainToSuccessor(
			fakeHost(),
			flow({ onCompleteFlow: "Successor" }),
			result(),
			"sess-p",
			undefined,
			{ resolveSuccessor: async () => successor, launch },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.flow.name).toBe("Successor");
		expect(calls[0]!.prompt).toBe("forwarded payload");
		expect(calls[0]!.options.origin).toBe("chaining");
		expect(calls[0]!.options.parentSessionId).toBe("sess-p");
		// depth + 1 over the SAME cell.
		expect(calls[0]!.options.inheritedContext?.depth).toBe(1);
	});

	it("passes the SAME budget cell to the successor by reference", async () => {
		const { launch, calls } = spyLauncher();
		const cell = budget({ iterationsRemaining: 7, costRemainingUsd: 2 });
		await chainToSuccessor(
			fakeHost(),
			flow({ onCompleteFlow: "Successor" }),
			result({ budget: cell }),
			"sess-p",
			undefined,
			{ resolveSuccessor: async () => flow({ name: "Successor" }), launch },
		);
		expect(calls[0]!.options.inheritedContext?.budget).toBe(cell); // same reference, not a copy
	});

	it("blocks (no launch, no status change) when the aggregate iterations are exhausted", async () => {
		const { launch, calls } = spyLauncher();
		await chainToSuccessor(
			fakeHost(),
			flow({ onCompleteFlow: "Successor" }),
			result({ budget: budget({ iterationsRemaining: 0 }) }),
			"sess-p",
			undefined,
			{ resolveSuccessor: async () => flow({ name: "Successor" }), launch },
		);
		expect(calls).toHaveLength(0);
		expect(notices.some((m) => m.includes("blocked"))).toBe(true);
	});

	it("blocks when the aggregate cost is exhausted", async () => {
		const { launch, calls } = spyLauncher();
		await chainToSuccessor(
			fakeHost(),
			flow({ onCompleteFlow: "Successor" }),
			result({ budget: budget({ costRemainingUsd: 0 }) }),
			"sess-p",
			undefined,
			{ resolveSuccessor: async () => flow({ name: "Successor" }), launch },
		);
		expect(calls).toHaveLength(0);
	});

	it("blocks when depth + 1 reaches the successor's maxDepth ceiling", async () => {
		const { launch, calls } = spyLauncher();
		// successor.maxDepth = 0 ⇒ maxDepth = depth + 1 + 0 = 1; depth + 1 = 1 >= 1 ⇒ blocked.
		await chainToSuccessor(
			fakeHost(),
			flow({ onCompleteFlow: "Successor" }),
			result({ depth: 0 }),
			"sess-p",
			undefined,
			{ resolveSuccessor: async () => flow({ name: "Successor", maxDepth: 0 }), launch },
		);
		expect(calls).toHaveLength(0);
	});

	it("stops with a Notice and launches nothing when the successor is not discoverable", async () => {
		const { launch, calls } = spyLauncher();
		await chainToSuccessor(
			fakeHost(),
			flow({ onCompleteFlow: "Ghost" }),
			result(),
			"sess-p",
			undefined,
			{ resolveSuccessor: async () => null, launch },
		);
		expect(calls).toHaveLength(0);
		expect(notices.some((m) => m.includes("not discoverable"))).toBe(true);
	});

	it("forwards parentScratchpadPath only for a shared-handoff successor", async () => {
		const { launch, calls } = spyLauncher();
		// isolated successor → no parent scratchpad forwarded.
		await chainToSuccessor(
			fakeHost(),
			flow({ onCompleteFlow: "Successor" }),
			result(),
			"sess-p",
			undefined,
			{ resolveSuccessor: async () => flow({ name: "Successor", handoffIsolation: "isolated" }), launch },
		);
		expect(calls[0]!.options.parentScratchpadPath).toBeUndefined();
	});

	// Bug B (F1) regression: the handoff is AWAITED, not fire-and-forget. This is
	// the documented, intended semantics (a run_flow parent transitively sees the
	// whole chain complete). Locking it here so a future refactor that drops the
	// await — silently detaching the successor — fails loudly instead. If detaching
	// ever becomes desired, it must be a deliberate change that also updates this
	// test and the run_flow parent-semantics + abort-cascade wiring.
	it("awaits the successor launch — does not resolve until the successor run completes", async () => {
		const calls: string[] = [];
		let releaseSuccessor: (() => void) | undefined;
		const successorDone = new Promise<void>((resolve) => {
			releaseSuccessor = resolve;
		});
		// A launcher that only resolves once we release it, so we can observe whether
		// chainToSuccessor waits for it.
		const launch: ChainLauncher = vi.fn(async () => {
			calls.push("launch:start");
			await successorDone;
			calls.push("launch:resolved");
			return result();
		});

		const chainPromise = chainToSuccessor(
			fakeHost(),
			flow({ onCompleteFlow: "Successor" }),
			result(),
			"sess-p",
			undefined,
			{ resolveSuccessor: async () => flow({ name: "Successor" }), launch },
		).then(() => {
			calls.push("chain:resolved");
		});

		// Let microtasks flush: the launcher has started but is still pending.
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toEqual(["launch:start"]);

		// Release the successor; only now may the chain resolve.
		releaseSuccessor!();
		await chainPromise;
		expect(calls).toEqual(["launch:start", "launch:resolved", "chain:resolved"]);
	});
});
