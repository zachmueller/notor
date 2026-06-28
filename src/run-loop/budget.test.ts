import { describe, it, expect, vi } from "vitest";

// Mock the logger (budget.ts → message-pipeline → logger).
vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
	newRootBudget,
	computeTurnCostUsd,
	decrementAggregate,
	hasHeadroom,
	canSpawnChild,
	deriveChildContext,
} from "./budget";
import type { RunContext } from "./types";
import type { NotorSettings } from "../settings/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<RunContext> = {}): RunContext {
	return {
		depth: 0,
		maxDepth: 0,
		budget: newRootBudget(Infinity, Infinity),
		subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: 0 },
		abort: new AbortController().signal,
		...overrides,
	};
}

function makeSettings(pricing: Record<string, { input: number; output: number }> = {}): NotorSettings {
	return { model_pricing: pricing } as unknown as NotorSettings;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("budget — newRootBudget", () => {
	it("defaults to a both-Infinity cell when unset (sub-agent seed)", () => {
		const b = newRootBudget();
		expect(b.iterationsRemaining).toBe(Infinity);
		expect(b.costRemainingUsd).toBe(Infinity);
	});

	it("constructs a finite cell from explicit ceilings", () => {
		const b = newRootBudget(10, 5.0);
		expect(b.iterationsRemaining).toBe(10);
		expect(b.costRemainingUsd).toBe(5.0);
	});
});

describe("budget — computeTurnCostUsd", () => {
	it("prices a turn from user-configured per-1k pricing", () => {
		const settings = makeSettings({ "test-model": { input: 3, output: 15 } });
		// 1000 in @ $3/1k + 500 out @ $15/1k = 3 + 7.5 = 10.5
		expect(computeTurnCostUsd(1000, 500, "test-model", settings)).toBeCloseTo(10.5);
	});

	it("returns 0 when no pricing is configured (unknown model → no draw-down)", () => {
		expect(computeTurnCostUsd(1000, 500, "unpriced-model", makeSettings())).toBe(0);
	});
});

describe("budget — two-layer decision rule (hasHeadroom)", () => {
	it("proceeds iff localIterations < cap AND both aggregate halves > 0", () => {
		const ctx = makeContext({ budget: newRootBudget(5, 1.0) });
		expect(hasHeadroom(ctx, 0, 20)).toBe(true);
	});

	it("blocks when the per-run cap is reached even with aggregate headroom", () => {
		const ctx = makeContext({ budget: newRootBudget(5, 1.0) });
		expect(hasHeadroom(ctx, 20, 20)).toBe(false);
	});

	it("blocks when aggregate iterations are exhausted even under the per-run cap", () => {
		const ctx = makeContext({ budget: newRootBudget(0, 1.0) });
		expect(hasHeadroom(ctx, 0, 20)).toBe(false);
	});

	it("blocks when aggregate cost is exhausted even under the per-run cap", () => {
		const ctx = makeContext({ budget: newRootBudget(5, 0) });
		expect(hasHeadroom(ctx, 0, 20)).toBe(false);
	});

	it("is strict-positive: any positive remainder still admits one more turn", () => {
		const ctx = makeContext({ budget: newRootBudget(1, 0.01) });
		expect(hasHeadroom(ctx, 0, 20)).toBe(true);
	});
});

describe("budget — decrementAggregate mutates the SHARED cell in place", () => {
	it("a child sharing the cell by reference sees a parent decrement (and vice versa)", () => {
		const parent = makeContext({ depth: 0, maxDepth: 3, budget: newRootBudget(10, 5.0) });
		const child = deriveChildContext(parent);

		// Same object by reference — the whole point of the shared cell.
		expect(child.budget).toBe(parent.budget);

		// Parent runs a turn → child observes it.
		decrementAggregate(parent.budget, 1.0, 1);
		expect(child.budget.iterationsRemaining).toBe(9);
		expect(child.budget.costRemainingUsd).toBeCloseTo(4.0);

		// Child runs a turn → parent observes it (tree-wide, not per-branch).
		decrementAggregate(child.budget, 2.0, 1);
		expect(parent.budget.iterationsRemaining).toBe(8);
		expect(parent.budget.costRemainingUsd).toBeCloseTo(2.0);
	});

	it("decrementing an Infinity cell is a no-op observable-wise (sub-agent equivalence)", () => {
		const b = newRootBudget(Infinity, Infinity);
		decrementAggregate(b, 9.99, 1);
		expect(b.iterationsRemaining).toBe(Infinity);
		expect(b.costRemainingUsd).toBe(Infinity);
	});

	it("a code step (turnIterations = 0) decrements neither half", () => {
		const b = newRootBudget(10, 5.0);
		decrementAggregate(b, 0, 0);
		expect(b.iterationsRemaining).toBe(10);
		expect(b.costRemainingUsd).toBe(5.0);
	});
});

describe("budget — spawn gate (canSpawnChild)", () => {
	it("sub-agent (maxDepth 0) cannot spawn a nested child (0 < 0 is false)", () => {
		const ctx = makeContext({ depth: 0, maxDepth: 0 });
		expect(canSpawnChild(ctx)).toBe(false);
	});

	it("a flow (maxDepth ≥ 1) permits a child at depth < maxDepth", () => {
		const ctx = makeContext({ depth: 0, maxDepth: 2, budget: newRootBudget(10, 5) });
		expect(canSpawnChild(ctx)).toBe(true);
	});

	it("exhausted aggregate budget blocks a new child spawn even with depth headroom", () => {
		const ctx = makeContext({ depth: 0, maxDepth: 2, budget: newRootBudget(0, 5) });
		expect(canSpawnChild(ctx)).toBe(false);
		const ctx2 = makeContext({ depth: 0, maxDepth: 2, budget: newRootBudget(5, 0) });
		expect(canSpawnChild(ctx2)).toBe(false);
	});
});

describe("budget — deriveChildContext", () => {
	it("child is depth+1, shares the budget cell by reference, gets a fresh subtree accumulator", () => {
		const parent = makeContext({ depth: 1, maxDepth: 3, budget: newRootBudget(10, 5) });
		parent.subtreeConsumed.costUsd = 99; // parent already spent in its own subtree
		const child = deriveChildContext(parent);

		expect(child.depth).toBe(2);
		expect(child.maxDepth).toBe(3);
		expect(child.budget).toBe(parent.budget); // shared by reference
		expect(child.subtreeConsumed).not.toBe(parent.subtreeConsumed); // fresh
		expect(child.subtreeConsumed.costUsd).toBe(0);
		expect(child.subtreeConsumed.iterations).toBe(0);
	});
});
