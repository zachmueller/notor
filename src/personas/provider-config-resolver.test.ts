import { describe, it, expect, vi } from "vitest";

// Mock the logger.
vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { resolvePersonaProviderConfig } from "./provider-config-resolver";
import type { Persona } from "../types";
import type { NotorSettings } from "../settings/types";
import type { ProviderRegistry } from "../providers/index";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makePersona(overrides: Partial<Persona> = {}): Persona {
	return {
		name: "researcher",
		directory_path: "notor/personas/researcher/",
		system_prompt_path: "notor/personas/researcher/system-prompt.md",
		prompt_content: "You research.",
		prompt_mode: "append",
		preferred_provider: null,
		preferred_model: null,
		preferred_preset: null,
		chip_color: null,
		chip_emoji: null,
		...overrides,
	};
}

function makeSettings(): NotorSettings {
	return {
		model_presets: [
			{ name: "tiny", provider_id: "anthropic", model_id: "claude-haiku-3", use_extended_context: false, thinking_level: null },
		],
	} as unknown as NotorSettings;
}

/** Registry with mutating methods spied so we can assert ZERO mutation. */
function makeRegistry(overrides: Partial<Record<string, unknown>> = {}) {
	const switchProvider = vi.fn();
	const updateConfig = vi.fn();
	const registry = {
		switchProvider,
		updateConfig,
		getActiveId: vi.fn(() => "active-provider"),
		getConfig: vi.fn((id: string) => {
			if (id === "active-provider") return { id, type: "anthropic", model_id: "active-model", use_extended_context: false };
			if (id === "anthropic") return { id, type: "anthropic", model_id: "configured-model", use_extended_context: true };
			return undefined;
		}),
		resolveTypeToId: vi.fn((t: string) => (t === "anthropic" ? "anthropic" : null)),
		...overrides,
	} as unknown as ProviderRegistry;
	return { registry, switchProvider, updateConfig };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolvePersonaProviderConfig — purity", () => {
	it("makes ZERO switchProvider / updateConfig calls (preset path)", () => {
		const { registry, switchProvider, updateConfig } = makeRegistry();
		const persona = makePersona({ preferred_preset: "tiny" });
		const result = resolvePersonaProviderConfig(persona, null, makeSettings(), registry);
		expect(result.providerId).toBe("anthropic");
		expect(result.modelId).toBe("claude-haiku-3");
		expect(switchProvider).not.toHaveBeenCalled();
		expect(updateConfig).not.toHaveBeenCalled();
	});

	it("makes ZERO mutating calls in the provider/model and active-fallback paths", () => {
		const { registry, switchProvider, updateConfig } = makeRegistry();
		resolvePersonaProviderConfig(makePersona({ preferred_provider: "anthropic", preferred_model: "m" }), null, makeSettings(), registry);
		resolvePersonaProviderConfig(makePersona(), null, makeSettings(), registry);
		expect(switchProvider).not.toHaveBeenCalled();
		expect(updateConfig).not.toHaveBeenCalled();
	});
});

describe("resolvePersonaProviderConfig — precedence", () => {
	it("preset wins over preferred_provider/model", () => {
		const { registry } = makeRegistry();
		const persona = makePersona({ preferred_preset: "tiny", preferred_provider: "openai", preferred_model: "gpt-4" });
		const result = resolvePersonaProviderConfig(persona, null, makeSettings(), registry);
		expect(result.providerId).toBe("anthropic");
		expect(result.modelId).toBe("claude-haiku-3");
	});

	it("falls through an unconfigured preset to preferred_provider/model", () => {
		const { registry } = makeRegistry();
		const persona = makePersona({ preferred_preset: "nonexistent", preferred_provider: "anthropic", preferred_model: "fallback-model" });
		const result = resolvePersonaProviderConfig(persona, null, makeSettings(), registry);
		expect(result.providerId).toBe("anthropic");
		expect(result.modelId).toBe("fallback-model");
	});

	it("falls back to the active provider/model when the persona has no overrides", () => {
		const { registry } = makeRegistry();
		const result = resolvePersonaProviderConfig(makePersona(), null, makeSettings(), registry);
		expect(result.providerId).toBe("active-provider");
		expect(result.modelId).toBe("active-model");
	});

	it("a null persona resolves to the active provider/model", () => {
		const { registry } = makeRegistry();
		const result = resolvePersonaProviderConfig(null, null, makeSettings(), registry);
		expect(result.providerId).toBe("active-provider");
		expect(result.modelId).toBe("active-model");
	});
});

describe("resolvePersonaProviderConfig — notor-step-model override", () => {
	it("stepModelOverride overrides the persona's preset model", () => {
		const { registry } = makeRegistry();
		const persona = makePersona({ preferred_preset: "tiny" });
		const result = resolvePersonaProviderConfig(persona, "step-model-x", makeSettings(), registry);
		expect(result.providerId).toBe("anthropic"); // provider still from the preset
		expect(result.modelId).toBe("step-model-x"); // model overridden
	});

	it("stepModelOverride overrides the persona's preferred_model", () => {
		const { registry } = makeRegistry();
		const persona = makePersona({ preferred_provider: "anthropic", preferred_model: "persona-model" });
		const result = resolvePersonaProviderConfig(persona, "step-model-y", makeSettings(), registry);
		expect(result.modelId).toBe("step-model-y");
	});

	it("stepModelOverride overrides the active-fallback model", () => {
		const { registry } = makeRegistry();
		const result = resolvePersonaProviderConfig(makePersona(), "step-model-z", makeSettings(), registry);
		expect(result.providerId).toBe("active-provider");
		expect(result.modelId).toBe("step-model-z");
	});
});

describe("resolvePersonaProviderConfig — independence", () => {
	it("two resolutions produce two independent value objects with no shared mutation", () => {
		const { registry } = makeRegistry();
		const a = resolvePersonaProviderConfig(makePersona({ preferred_preset: "tiny" }), null, makeSettings(), registry);
		const b = resolvePersonaProviderConfig(makePersona({ preferred_provider: "anthropic", preferred_model: "m2" }), null, makeSettings(), registry);
		expect(a).not.toBe(b);
		expect(a.modelId).toBe("claude-haiku-3");
		expect(b.modelId).toBe("m2");
	});
});
