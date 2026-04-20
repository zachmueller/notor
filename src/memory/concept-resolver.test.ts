import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { resolveConcept } from "./concept-resolver";
import type { ResolveConceptArgs } from "./concept-resolver";

function buildMockApp(files: Map<string, string> = new Map()) {
	return {
		vault: {
			adapter: {
				exists: vi.fn(async (path: string) => files.has(path)),
				read: vi.fn(async (path: string) => files.get(path) ?? ""),
				write: vi.fn(async (path: string, content: string) => {
					files.set(path, content);
				}),
			},
			getAbstractFileByPath: vi.fn((path: string) => {
				if (files.has(path)) {
					return { path, name: path.split("/").pop()! };
				}
				return null;
			}),
			create: vi.fn(async (path: string, content: string) => {
				files.set(path, content);
				return { path };
			}),
			read: vi.fn(async (file: { path: string }) => files.get(file.path) ?? ""),
			modify: vi.fn(async (file: { path: string }, content: string) => {
				files.set(file.path, content);
			}),
		},
	} as unknown as import("obsidian").App;
}

function buildArgs(
	overrides: Partial<ResolveConceptArgs> & {
		files?: Map<string, string>;
		subAgentResponse?: string | null;
	} = {},
): ResolveConceptArgs {
	const files = overrides.files ?? new Map();
	const app = buildMockApp(files);
	const subAgentText = overrides.subAgentResponse ?? "";

	const runSubAgent = vi.fn(async () =>
		subAgentText === null
			? null
			: {
					text: subAgentText,
					messages: [],
					tokenUsage: { input: 0, output: 0 },
					iterationCount: 1,
					stopReason: "completed" as const,
				},
	);

	return {
		insight: overrides.insight ?? "Test insight",
		memoryDir: overrides.memoryDir ?? "notor/memory",
		resolverProfile: overrides.resolverProfile ?? "memory-resolver",
		app,
		runSubAgent: runSubAgent as unknown as ResolveConceptArgs["runSubAgent"],
		vault: app.vault as unknown as import("obsidian").Vault,
		...overrides,
		// re-apply app/vault so they aren't overwritten by spread
	};
}

describe("resolveConcept", () => {
	it("creates a new note on 'create' directive", async () => {
		const files = new Map<string, string>();
		const args = buildArgs({
			files,
			subAgentResponse: JSON.stringify({
				action: "create",
				title: "Test Concept",
				merged_body: "This is the concept body.",
			}),
		});

		const result = await resolveConcept(args);

		expect(result.action).toBe("created");
		expect(result.path).toBe("notor/memory/test-concept.md");
		expect(files.has("notor/memory/test-concept.md")).toBe(true);

		const content = files.get("notor/memory/test-concept.md")!;
		expect(content).toContain("notor-type: memory");
		expect(content).toContain("# Test Concept");
		expect(content).toContain("This is the concept body.");
		expect(content).toContain("notor-sources: [chat]");
	});

	it("updates an existing note on 'update' directive", async () => {
		const files = new Map<string, string>();
		files.set(
			"notor/memory/existing-note.md",
			[
				"---",
				"notor-type: memory",
				"notor-created-at: 2026-04-18T12:00:00.000Z",
				"notor-updated-at: 2026-04-18T12:00:00.000Z",
				"notor-sources: [chat]",
				"---",
				"",
				"# Existing Note",
				"",
				"Old body content.",
				"",
			].join("\n"),
		);

		const args = buildArgs({
			files,
			subAgentResponse: JSON.stringify({
				action: "update",
				path: "notor/memory/existing-note.md",
				merged_body: "Updated body content with new evidence.",
			}),
		});

		const result = await resolveConcept(args);

		expect(result.action).toBe("updated");
		expect(result.path).toBe("notor/memory/existing-note.md");

		const content = files.get("notor/memory/existing-note.md")!;
		expect(content).toContain("Updated body content with new evidence.");
		expect(content).toContain("# Existing Note");
	});

	it("returns skipped on malformed JSON", async () => {
		const args = buildArgs({
			subAgentResponse: "not valid json {{{",
		});

		const result = await resolveConcept(args);
		expect(result.action).toBe("skipped");
	});

	it("returns skipped on sub-agent failure (null result)", async () => {
		const args = buildArgs({
			subAgentResponse: null,
		});

		const result = await resolveConcept(args);
		expect(result.action).toBe("skipped");
	});

	it("returns skipped when directive has no action", async () => {
		const args = buildArgs({
			subAgentResponse: JSON.stringify({ merged_body: "body" }),
		});

		const result = await resolveConcept(args);
		expect(result.action).toBe("skipped");
	});

	it("returns skipped when directive has no merged_body", async () => {
		const args = buildArgs({
			subAgentResponse: JSON.stringify({ action: "create", title: "Test" }),
		});

		const result = await resolveConcept(args);
		expect(result.action).toBe("skipped");
	});

	it("handles filename collision with suffix", async () => {
		const files = new Map<string, string>();
		files.set("notor/memory/test-concept.md", "existing");

		const args = buildArgs({
			files,
			subAgentResponse: JSON.stringify({
				action: "create",
				title: "Test Concept",
				merged_body: "New concept with same title.",
			}),
		});

		const result = await resolveConcept(args);

		expect(result.action).toBe("created");
		expect(result.path).toBe("notor/memory/test-concept-2.md");
	});

	it("handles multiple filename collisions", async () => {
		const files = new Map<string, string>();
		files.set("notor/memory/test-concept.md", "existing");
		files.set("notor/memory/test-concept-2.md", "existing");

		const args = buildArgs({
			files,
			subAgentResponse: JSON.stringify({
				action: "create",
				title: "Test Concept",
				merged_body: "Third concept with same title.",
			}),
		});

		const result = await resolveConcept(args);

		expect(result.action).toBe("created");
		expect(result.path).toBe("notor/memory/test-concept-3.md");
	});

	it("calls assertMemoryPath before every write (create)", async () => {
		const args = buildArgs({
			subAgentResponse: JSON.stringify({
				action: "create",
				title: "Good Note",
				merged_body: "Safe content.",
			}),
		});

		const result = await resolveConcept(args);
		expect(result.action).toBe("created");
		expect(result.path).toMatch(/^notor\/memory\//);
	});

	it("rejects update with path outside memory directory", async () => {
		const args = buildArgs({
			subAgentResponse: JSON.stringify({
				action: "update",
				path: "notor/notes/outside.md",
				merged_body: "Malicious content.",
			}),
		});

		await expect(resolveConcept(args)).rejects.toThrow(/outside memory directory/);
	});

	it("returns skipped when update path is missing", async () => {
		const args = buildArgs({
			subAgentResponse: JSON.stringify({
				action: "update",
				merged_body: "No path provided.",
			}),
		});

		const result = await resolveConcept(args);
		expect(result.action).toBe("skipped");
	});

	it("returns skipped when update file does not exist", async () => {
		const args = buildArgs({
			subAgentResponse: JSON.stringify({
				action: "update",
				path: "notor/memory/nonexistent.md",
				merged_body: "File does not exist.",
			}),
		});

		const result = await resolveConcept(args);
		expect(result.action).toBe("skipped");
	});

	it("writes oversized merged_body as-is (no error)", async () => {
		const largeBody = "x".repeat(100_000);
		const args = buildArgs({
			subAgentResponse: JSON.stringify({
				action: "create",
				title: "Oversized Note",
				merged_body: largeBody,
			}),
		});

		const result = await resolveConcept(args);
		expect(result.action).toBe("created");
	});

	it("appends 'chat' source on update if not already present", async () => {
		const files = new Map<string, string>();
		files.set(
			"notor/memory/dream-only.md",
			[
				"---",
				"notor-type: memory",
				"notor-created-at: 2026-04-18T12:00:00.000Z",
				"notor-updated-at: 2026-04-18T12:00:00.000Z",
				"notor-sources: [dream]",
				"---",
				"",
				"# Dream Only",
				"",
				"Original body.",
				"",
			].join("\n"),
		);

		const args = buildArgs({
			files,
			subAgentResponse: JSON.stringify({
				action: "update",
				path: "notor/memory/dream-only.md",
				merged_body: "Updated body.",
			}),
		});

		const result = await resolveConcept(args);
		expect(result.action).toBe("updated");

		const content = files.get("notor/memory/dream-only.md")!;
		expect(content).toContain("notor-sources: [dream, chat]");
	});

	it("does not duplicate 'chat' source on update", async () => {
		const files = new Map<string, string>();
		files.set(
			"notor/memory/already-chat.md",
			[
				"---",
				"notor-type: memory",
				"notor-created-at: 2026-04-18T12:00:00.000Z",
				"notor-updated-at: 2026-04-18T12:00:00.000Z",
				"notor-sources: [chat]",
				"---",
				"",
				"# Already Chat",
				"",
				"Body.",
				"",
			].join("\n"),
		);

		const args = buildArgs({
			files,
			subAgentResponse: JSON.stringify({
				action: "update",
				path: "notor/memory/already-chat.md",
				merged_body: "Updated body.",
			}),
		});

		await resolveConcept(args);

		const content = files.get("notor/memory/already-chat.md")!;
		expect(content).toContain("notor-sources: [chat]");
		expect(content).not.toContain("notor-sources: [chat, chat]");
	});

	it("uses 'untitled' as default title when directive omits it", async () => {
		const args = buildArgs({
			subAgentResponse: JSON.stringify({
				action: "create",
				merged_body: "Body without explicit title.",
			}),
		});

		const result = await resolveConcept(args);
		expect(result.action).toBe("created");
		expect(result.path).toBe("notor/memory/untitled.md");
	});
});
