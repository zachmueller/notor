import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock("obsidian", () => ({
	parseYaml: vi.fn((yaml: string) => {
		const result: Record<string, unknown> = {};
		for (const line of yaml.split("\n")) {
			const match = line.match(/^\s*(\w+):\s*(.+)/);
			if (match && match[1] && match[2]) result[match[1]] = match[2];
		}
		return result;
	}),
}));

vi.mock("../include-note/resolver", () => ({
	resolveIncludeNotes: vi.fn(async (text: string) => ({
		inlineContent: text,
		attachments: [],
	})),
}));

import { SystemPromptBuilder } from "./system-prompt";
import { DEFAULT_SYSTEM_PROMPT } from "./default-system-prompt";
import { TemplateVariableRegistry } from "../template-vars";
import { resolveIncludeNotes } from "../include-note/resolver";
import type { ToolDefinition } from "../providers/provider";
import type { Persona, PersonaPromptMode } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockVault(files: Record<string, string> = {}) {
	return {
		adapter: {
			exists: vi.fn(async (path: string) => path in files),
			read: vi.fn(async (path: string) => {
				if (path in files) return files[path];
				throw new Error(`File not found: ${path}`);
			}),
			write: vi.fn(),
			mkdir: vi.fn(),
		},
	} as any;
}

function createMockMetadataCache() {
	return {} as any;
}

function createRegistry(): TemplateVariableRegistry {
	const registry = new TemplateVariableRegistry();
	registry.register("notor_dir", () => "notor");
	registry.register("vault_name", () => "test-vault");
	return registry;
}

function createPersona(overrides: Partial<Persona> & { name: string; prompt_content: string; prompt_mode: PersonaPromptMode }): Persona {
	return {
		directory_path: `notor/personas/${overrides.name}`,
		system_prompt_path: `notor/personas/${overrides.name}/system-prompt.md`,
		preferred_provider: null,
		preferred_model: null,
		preferred_preset: null,
		chip_color: null,
		chip_emoji: null,
		...overrides,
	};
}

const SAMPLE_TOOLS: ToolDefinition[] = [
	{
		name: "read_note",
		description: "Read a note from the vault.",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Note path" },
			},
			required: ["path"],
		},
	},
];

// ---------------------------------------------------------------------------
// Tests — backward compatibility (no markers)
// ---------------------------------------------------------------------------

describe("SystemPromptBuilder.assemble() — no dynamic markers", () => {
	it("appends all sections when base prompt has no markers", async () => {
		const vault = createMockVault();
		const builder = new SystemPromptBuilder(vault, "notor", undefined, createRegistry());

		const result = await builder.assemble("act", SAMPLE_TOOLS, undefined, "<auto-context/>", null, true);

		// Base prompt is the default (no custom file)
		expect(result).toContain(DEFAULT_SYSTEM_PROMPT);
		// Tool definitions appended
		expect(result).toContain("## Available tools");
		expect(result).toContain("### read_note");
		// Mode section appended
		expect(result).toContain("## Current mode: Act");
		// Memory convention appended
		expect(result).toContain("## Memory context");
		// Auto-context appended
		expect(result).toContain("## Workspace context");
	});

	it("does not include empty sections", async () => {
		const vault = createMockVault();
		const builder = new SystemPromptBuilder(vault, "notor", undefined, createRegistry());

		const result = await builder.assemble("act", [], undefined, undefined, null, false);

		expect(result).not.toContain("## Available tools");
		expect(result).not.toContain("## Memory context");
		expect(result).not.toContain("## Workspace context");
		// Mode section is always present
		expect(result).toContain("## Current mode: Act");
	});
});

// ---------------------------------------------------------------------------
// Tests — dynamic markers in custom base prompt
// ---------------------------------------------------------------------------

describe("SystemPromptBuilder.assemble() — dynamic markers", () => {
	it("resolves {available_tools} inline and does not duplicate", async () => {
		const customPrompt = `---
description: Custom prompt
---

You are a helpful assistant.

{available_tools}

Be concise.`;

		const vault = createMockVault({
			"notor/prompts/core-system-prompt.md": customPrompt,
		});
		const builder = new SystemPromptBuilder(vault, "notor", createMockMetadataCache(), createRegistry());

		const result = await builder.assemble("act", SAMPLE_TOOLS);

		// Tool definitions appear inline (between the two text blocks)
		const toolSectionIndex = result.indexOf("## Available tools");
		const beConciseIndex = result.indexOf("Be concise.");
		expect(toolSectionIndex).toBeGreaterThan(-1);
		expect(toolSectionIndex).toBeLessThan(beConciseIndex);

		// Tool definitions appear only once
		const firstOccurrence = result.indexOf("## Available tools");
		const secondOccurrence = result.indexOf("## Available tools", firstOccurrence + 1);
		expect(secondOccurrence).toBe(-1);
	});

	it("resolves multiple markers inline", async () => {
		const customPrompt = `---
description: Custom prompt
---

# Instructions

{available_tools}

{mode_instructions}

{memory_convention}

End.`;

		const vault = createMockVault({
			"notor/prompts/core-system-prompt.md": customPrompt,
		});
		const builder = new SystemPromptBuilder(vault, "notor", createMockMetadataCache(), createRegistry());

		const result = await builder.assemble("plan", SAMPLE_TOOLS, undefined, "<auto-context/>", null, true);

		// All three are inline
		expect(result).toContain("## Available tools");
		expect(result).toContain("## Current mode: Plan");
		expect(result).toContain("## Memory context");

		// Auto-context was NOT a marker, so it should still be appended
		expect(result).toContain("## Workspace context");

		// Verify no duplicates of marked sections
		expect(result.split("## Available tools").length).toBe(2); // 1 occurrence → 2 splits
		expect(result.split("## Current mode: Plan").length).toBe(2);
		expect(result.split("## Memory context").length).toBe(2);
	});

	it("resolves marker for empty section to empty string", async () => {
		const customPrompt = `---
description: Custom prompt
---

Prompt.

{vault_rules}

End.`;

		const vault = createMockVault({
			"notor/prompts/core-system-prompt.md": customPrompt,
		});
		const builder = new SystemPromptBuilder(vault, "notor", createMockMetadataCache(), createRegistry());

		// No rules provided → vault_rules section is empty
		const result = await builder.assemble("act", []);

		// The marker was resolved to empty — no "Vault instructions" header
		expect(result).not.toContain("## Vault instructions");
		// The surrounding text is still present
		expect(result).toContain("Prompt.");
		expect(result).toContain("End.");
	});

	it("resolves all markers — nothing appended", async () => {
		const customPrompt = `---
description: Custom prompt
---

{available_tools}
{mode_instructions}
{vault_rules}
{auto_context}
{memory_convention}`;

		const vault = createMockVault({
			"notor/prompts/core-system-prompt.md": customPrompt,
		});
		const builder = new SystemPromptBuilder(vault, "notor", createMockMetadataCache(), createRegistry());

		const result = await builder.assemble("act", SAMPLE_TOOLS, undefined, "<auto-context/>", null, true);

		// All sections present
		expect(result).toContain("## Available tools");
		expect(result).toContain("## Current mode: Act");
		expect(result).toContain("## Workspace context");
		expect(result).toContain("## Memory context");

		// Each appears exactly once
		for (const section of ["## Available tools", "## Current mode: Act", "## Workspace context", "## Memory context"]) {
			expect(result.split(section).length).toBe(2);
		}
	});
});

// ---------------------------------------------------------------------------
// Tests — static vars + include_note second pass
// ---------------------------------------------------------------------------

describe("SystemPromptBuilder — static var resolution", () => {
	it("resolves {notor_dir} and {vault_name} in custom prompt", async () => {
		const customPrompt = `---
description: Custom prompt
---

Files are in {notor_dir}. Vault: {vault_name}.`;

		const vault = createMockVault({
			"notor/prompts/core-system-prompt.md": customPrompt,
		});
		const builder = new SystemPromptBuilder(vault, "notor", createMockMetadataCache(), createRegistry());

		const result = await builder.assemble("act", []);

		expect(result).toContain("Files are in notor. Vault: test-vault.");
	});

	it("second-pass resolves static vars in included content", async () => {
		const customPrompt = `---
description: Custom prompt
---

<include_note>notor/snippet.md</include_note>`;

		const vault = createMockVault({
			"notor/prompts/core-system-prompt.md": customPrompt,
		});

		// Mock include_note to return content with {vault_name}
		vi.mocked(resolveIncludeNotes).mockResolvedValueOnce({
			inlineContent: "Included content for {vault_name}.",
			attachments: [],
		});

		const builder = new SystemPromptBuilder(vault, "notor", createMockMetadataCache(), createRegistry());

		const result = await builder.assemble("act", []);

		// The {vault_name} inside the included note should be resolved
		expect(result).toContain("Included content for test-vault.");
		expect(result).not.toContain("{vault_name}");
	});
});

// ---------------------------------------------------------------------------
// Tests — replace-mode persona with markers
// ---------------------------------------------------------------------------

describe("SystemPromptBuilder.assemble() — replace-mode persona", () => {
	it("resolves dynamic markers in replace-mode persona content", async () => {
		const vault = createMockVault();
		const builder = new SystemPromptBuilder(vault, "notor", createMockMetadataCache(), createRegistry());

		const persona = createPersona({
			name: "custom",
			prompt_content: "You are a custom assistant.\n\n{available_tools}\n\nBe helpful.",
			prompt_mode: "replace",
		});

		const result = await builder.assemble("act", SAMPLE_TOOLS, undefined, "<auto-context/>", persona);

		// Tool definitions appear inline within persona content
		expect(result).toContain("You are a custom assistant.");
		expect(result).toContain("## Available tools");
		expect(result).toContain("Be helpful.");

		// Not duplicated — only one occurrence
		expect(result.split("## Available tools").length).toBe(2);
	});

	it("appends unmarked sections in replace-mode persona", async () => {
		const vault = createMockVault();
		const builder = new SystemPromptBuilder(vault, "notor", createMockMetadataCache(), createRegistry());

		const persona = createPersona({
			name: "custom",
			prompt_content: "You are a custom assistant.",
			prompt_mode: "replace",
		});

		const result = await builder.assemble("act", SAMPLE_TOOLS, undefined, undefined, persona);

		// No markers → sections appended
		expect(result).toContain("You are a custom assistant.");
		expect(result).toContain("## Available tools");
		expect(result).toContain("## Current mode: Act");
	});
});

// ---------------------------------------------------------------------------
// Tests — getRawBasePrompt / getBasePrompt
// ---------------------------------------------------------------------------

describe("SystemPromptBuilder.getBasePrompt()", () => {
	it("returns DEFAULT_SYSTEM_PROMPT when no custom file exists", async () => {
		const vault = createMockVault();
		const builder = new SystemPromptBuilder(vault, "notor", undefined, createRegistry());

		const result = await builder.getBasePrompt();
		expect(result).toBe(DEFAULT_SYSTEM_PROMPT);
	});

	it("returns custom file content with static vars resolved", async () => {
		const customPrompt = `---
description: test
---

My vault is {vault_name} in {notor_dir}.`;

		const vault = createMockVault({
			"notor/prompts/core-system-prompt.md": customPrompt,
		});
		const builder = new SystemPromptBuilder(vault, "notor", createMockMetadataCache(), createRegistry());

		const result = await builder.getBasePrompt();
		expect(result).toContain("My vault is test-vault in notor.");
	});
});
