import { describe, it, expect } from "vitest";
import { resolvePersonaOverrides } from "./persona-overrides";
import type { ProviderRegistry } from "../providers/index";
import type { LLMProviderConfig, Persona } from "../types";

const configs: Record<string, Partial<LLMProviderConfig>> = {
	global: { id: "global", type: "bedrock", model_id: "global-default" },
	panel: { id: "panel", type: "anthropic", model_id: "panel-default" },
};

const registry = {
	getActiveId: () => "global",
	getConfig: (id: string) => configs[id] as LLMProviderConfig | undefined,
	resolveTypeToId: () => null,
	getCachedModels: () => [],
} as unknown as ProviderRegistry;

const persona = (over: Partial<Persona>): Persona => ({ name: "p", ...over }) as Persona;

describe("resolvePersonaOverrides", () => {
	// A model-only persona override pairs with the PANEL's provider, not the
	// global active one (which another panel may have changed).
	it("pairs a model-only override with the caller's panel provider", () => {
		const res = resolvePersonaOverrides(persona({ preferred_model: "m" }), registry, [], "panel");
		expect(res).toMatchObject({ providerId: "panel", modelId: "m", presetName: null });
	});

	it("defaults to the global active provider when no panel provider is given", () => {
		const res = resolvePersonaOverrides(persona({ preferred_model: "m" }), registry, []);
		expect(res?.providerId).toBe("global");
	});

	it("returns null when the persona has no overrides", () => {
		expect(resolvePersonaOverrides(persona({}), registry, [], "panel")).toBeNull();
	});
});
