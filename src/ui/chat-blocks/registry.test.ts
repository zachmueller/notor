import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/logger", () => ({
	logger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import { ChatBlockRegistry, type ChatBlockDefinition } from "./registry";

function makeDef(kind: string): ChatBlockDefinition {
	return {
		kind,
		displayName: `Display: ${kind}`,
		render: vi.fn(),
	};
}

describe("ChatBlockRegistry — 13.3", () => {
	let registry: ChatBlockRegistry;

	beforeEach(() => {
		registry = new ChatBlockRegistry();
	});

	// -----------------------------------------------------------------------
	// register / get
	// -----------------------------------------------------------------------

	it("registers a definition and retrieves it by kind", () => {
		const def = makeDef("memory_recalled");
		registry.register(def);
		expect(registry.get("memory_recalled")).toBe(def);
	});

	it("returns undefined for an unregistered kind", () => {
		expect(registry.get("nonexistent")).toBeUndefined();
	});

	// -----------------------------------------------------------------------
	// duplicate kind — keeps first, logs error
	// -----------------------------------------------------------------------

	it("duplicate kind registration keeps first and does not overwrite", () => {
		const first = makeDef("my_block");
		const second = { ...makeDef("my_block"), displayName: "Second" };
		registry.register(first);
		registry.register(second);
		expect(registry.get("my_block")).toBe(first);
		expect(registry.get("my_block")?.displayName).toBe("Display: my_block");
	});

	// -----------------------------------------------------------------------
	// has / list
	// -----------------------------------------------------------------------

	it("has() returns true for registered kind", () => {
		registry.register(makeDef("block_a"));
		expect(registry.has("block_a")).toBe(true);
	});

	it("has() returns false for unregistered kind", () => {
		expect(registry.has("block_a")).toBe(false);
	});

	it("list() returns all registered definitions", () => {
		const a = makeDef("block_a");
		const b = makeDef("block_b");
		registry.register(a);
		registry.register(b);
		const listed = registry.list();
		expect(listed).toHaveLength(2);
		expect(listed).toContain(a);
		expect(listed).toContain(b);
	});

	it("list() returns empty array when nothing registered", () => {
		expect(registry.list()).toEqual([]);
	});

	// -----------------------------------------------------------------------
	// unregister (extension reload cleanup)
	// -----------------------------------------------------------------------

	it("unregister removes the definition", () => {
		registry.register(makeDef("my_block"));
		registry.unregister("my_block");
		expect(registry.has("my_block")).toBe(false);
		expect(registry.get("my_block")).toBeUndefined();
	});

	it("unregister on unknown kind is a no-op (no throw)", () => {
		expect(() => registry.unregister("nonexistent")).not.toThrow();
	});

	it("after unregister, re-registering the same kind succeeds", () => {
		const first = makeDef("my_block");
		registry.register(first);
		registry.unregister("my_block");

		const second = { ...makeDef("my_block"), displayName: "After reload" };
		registry.register(second);
		expect(registry.get("my_block")).toBe(second);
		expect(registry.get("my_block")?.displayName).toBe("After reload");
	});
});
