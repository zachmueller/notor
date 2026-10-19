import { describe, it, expect, vi, beforeEach } from "vitest";
import { parse as parseYamlReal } from "yaml";

vi.mock("obsidian", () => ({ parseYaml: (text: string) => parseYamlReal(text) }));
vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ConfigResolver, filterToolsForMode } from "./config-resolver";
import { SystemPromptBuilder } from "./system-prompt";
import { evaluateToolPolicy } from "./tool-policy";
import { extractToolConfigs } from "../tool-config/parser";
import { TOOL_PATH_PARAMS } from "../tool-config/path-enforcer";
import { DEFAULT_AUTO_APPROVE } from "../settings/defaults";
import type { ToolDefinition } from "../providers/provider";
import type { ToolDispatcher, DispatchableTool } from "./dispatcher";
import type { NotorSettings } from "../settings";
import type { Persona, WorkflowAssemblyResult } from "../types";
import type { PathScopeRule } from "../settings/path-scoping";

const defs = ["read_note", "submit_plan", "write_note"].map(
	(name): ToolDefinition => ({ name, description: name, input_schema: { type: "object", properties: {} } }),
);

describe("filterToolsForMode", () => {
	it("drops submit_plan in Act mode", () => {
		expect(filterToolsForMode(defs, "act").map((t) => t.name)).toEqual(["read_note", "write_note"]);
	});

	it("keeps submit_plan in Plan mode", () => {
		expect(filterToolsForMode(defs, "plan").map((t) => t.name)).toEqual(["read_note", "submit_plan", "write_note"]);
	});

	it("leaves the list untouched when no mode is given", () => {
		expect(filterToolsForMode(defs)).toBe(defs);
	});
});

// ---------------------------------------------------------------------------
// Persona <notor_tool_config> → resolveEffectiveConfig → evaluateToolPolicy
// ---------------------------------------------------------------------------

const TOOL_NAMES = ["read_note", "write_note", "replace_in_note", "search_vault"];
const WRITE_NOTE: DispatchableTool = { name: "write_note", mode: "write" } as any;

function persona(body: string): Persona {
	return {
		name: "writer",
		directory_path: "notor/personas/writer/",
		system_prompt_path: "notor/personas/writer/system-prompt.md",
		prompt_content: body,
		prompt_mode: "append",
		preferred_provider: null,
		preferred_model: null,
		preferred_preset: null,
		chip_color: null,
		chip_emoji: null,
	};
}

const AUTO_WRITE_PERSONA = persona(`You write notes.

<notor_tool_config>
write_note:
  auto_approve: true
</notor_tool_config>
`);

function makeResolver(over: Partial<NotorSettings> = {}): ConfigResolver {
	const settings = {
		auto_approve: { ...DEFAULT_AUTO_APPROVE },
		tool_enabled: {},
		path_scope_rules: [],
		...over,
	} as unknown as NotorSettings;
	const builder = new SystemPromptBuilder({} as any, "notor");
	const dispatcher = { getRegisteredToolNames: () => TOOL_NAMES } as unknown as ToolDispatcher;
	return new ConfigResolver(settings, builder, dispatcher);
}

async function writeNoteDecision(resolver: ConfigResolver, p: Persona | null, workflow?: WorkflowAssemblyResult) {
	const { effective } = await resolver.resolveEffectiveConfig([], workflow ?? null, p, "act");
	return evaluateToolPolicy("write_note", { path: "Notes/A.md", content: "x" }, WRITE_NOTE, {
		effectiveConfig: effective,
		mode: "act",
		vaultRootPath: "/vault",
	});
}

describe("ConfigResolver.resolveEffectiveConfig — persona auto_approve", () => {
	beforeEach(() => {
		for (const key of Object.keys(TOOL_PATH_PARAMS)) delete TOOL_PATH_PARAMS[key];
		TOOL_PATH_PARAMS["write_note"] = [{ paramName: "path", namespace: "vault", access: "write" }];
	});

	it("persona auto_approve: true beats the global write_note default of false", async () => {
		const decision = await writeNoteDecision(makeResolver(), AUTO_WRITE_PERSONA);
		expect(decision).toMatchObject({ allowed: true, autoApproved: true });
	});

	it("no persona falls back to the global setting", async () => {
		const decision = await writeNoteDecision(makeResolver(), null);
		expect(decision).toMatchObject({ allowed: true, autoApproved: false });
	});

	it("a persona block that leaves auto_approve unset keeps the global value", async () => {
		const p = persona("<notor_tool_config>\nwrite_note:\n  enabled: true\n</notor_tool_config>\n");
		const decision = await writeNoteDecision(makeResolver(), p);
		expect(decision.autoApproved).toBe(false);
	});

	it("a workflow auto_approve: false beats the persona's true", async () => {
		const workflowConfigs = extractToolConfigs(
			"<notor_tool_config>\nwrite_note:\n  auto_approve: false\n</notor_tool_config>",
			"workflow",
			"notor/workflows/wf.md",
			undefined,
			parseYamlReal,
		).configs;
		const workflow = { toolConfigs: workflowConfigs } as unknown as WorkflowAssemblyResult;
		const decision = await writeNoteDecision(makeResolver(), AUTO_WRITE_PERSONA, workflow);
		expect(decision.autoApproved).toBe(false);
	});

	// By design (path tier = default the persona replaces only with its own list),
	// not a loss of the persona's auto_approve — pinned so it isn't mistaken for one.
	it("a global 'Always ask' path scope still prompts despite persona auto_approve", async () => {
		const rules: PathScopeRule[] = [{ path: "Notes", read: "default", write: "always_ask" }];
		const decision = await writeNoteDecision(makeResolver({ path_scope_rules: rules }), AUTO_WRITE_PERSONA);
		expect(decision).toMatchObject({ allowed: true, autoApproved: false });
	});
});

// ---------------------------------------------------------------------------
// Circuit control-flow tools with no explicit setting (headless circuit steps)
// ---------------------------------------------------------------------------

describe("ConfigResolver.resolveEffectiveConfig — circuit tools with no explicit setting", () => {
	const CIRCUIT_TOOL_NAMES = [...TOOL_NAMES, "emit_event", "circuit_task_ensure"];
	const EMIT_EVENT: DispatchableTool = { name: "emit_event", mode: "read" } as any;
	const TASK_ENSURE: DispatchableTool = { name: "circuit_task_ensure", mode: "write" } as any;

	function circuitResolver(): ConfigResolver {
		const settings = {
			auto_approve: { ...DEFAULT_AUTO_APPROVE },
			tool_enabled: {},
			path_scope_rules: [],
		} as unknown as NotorSettings;
		const builder = new SystemPromptBuilder({} as any, "notor");
		const dispatcher = { getRegisteredToolNames: () => CIRCUIT_TOOL_NAMES } as unknown as ToolDispatcher;
		return new ConfigResolver(settings, builder, dispatcher);
	}

	beforeEach(() => {
		for (const key of Object.keys(TOOL_PATH_PARAMS)) delete TOOL_PATH_PARAMS[key];
	});

	it("emit_event auto-approves in Plan mode, so a circuit step never prompts on its own output", async () => {
		const { effective } = await circuitResolver().resolveEffectiveConfig([], null, null, "plan");
		const decision = evaluateToolPolicy("emit_event", { topic: "FLOW_COMPLETE", payload: "x" }, EMIT_EVENT, {
			effectiveConfig: effective,
			mode: "plan",
			vaultRootPath: "/vault",
		});
		expect(decision).toMatchObject({ allowed: true, autoApproved: true });
	});

	it("write-mode task tools are still blocked in Plan mode", async () => {
		const { effective } = await circuitResolver().resolveEffectiveConfig([], null, null, "plan");
		const decision = evaluateToolPolicy("circuit_task_ensure", { key: "t1" }, TASK_ENSURE, {
			effectiveConfig: effective,
			mode: "plan",
			vaultRootPath: "/vault",
		});
		expect(decision.allowed).toBe(false);
	});
});
