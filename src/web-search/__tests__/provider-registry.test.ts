import { describe, it, expect, beforeEach } from "vitest";
import { SearchProviderRegistry } from "../provider-registry";
import type {
	SearchProvider,
	SearchProviderMeta,
	ProviderConfig,
	SearchProviderResult,
} from "../providers/provider";

/** Minimal mock provider for registry tests. */
function createMockProvider(
	type: string,
	requiresApiKey: boolean,
): SearchProvider {
	return {
		meta: {
			type,
			displayName: type.charAt(0).toUpperCase() + type.slice(1),
			requiresApiKey,
			defaultDelayMs: 0,
		} as SearchProviderMeta,
		search: async (): Promise<SearchProviderResult> => ({ results: [] }),
		isConfigured(config: ProviderConfig): boolean {
			if (!config.enabled) return false;
			if (requiresApiKey && !config.apiKey) return false;
			return true;
		},
	};
}

describe("SearchProviderRegistry", () => {
	let registry: SearchProviderRegistry;

	const ddg = createMockProvider("duckduckgo", false);
	const tavily = createMockProvider("tavily", true);
	const brave = createMockProvider("brave", true);
	const serpapi = createMockProvider("serpapi", true);

	beforeEach(() => {
		registry = new SearchProviderRegistry();
	});

	// ── register() and get() ───────────────────────────────────────

	describe("register and get", () => {
		it("registers and retrieves a provider by type", () => {
			registry.register(ddg);
			expect(registry.get("duckduckgo")).toBe(ddg);
		});

		it("returns undefined for unregistered type", () => {
			expect(registry.get("tavily")).toBeUndefined();
		});

		it("overwrites a previously registered provider of the same type", () => {
			const ddg2 = createMockProvider("duckduckgo", false);
			registry.register(ddg);
			registry.register(ddg2);
			expect(registry.get("duckduckgo")).toBe(ddg2);
		});
	});

	// ── getAll() ───────────────────────────────────────────────────

	describe("getAll", () => {
		it("returns all registered providers", () => {
			registry.register(ddg);
			registry.register(tavily);
			registry.register(brave);

			const all = registry.getAll();
			expect(all).toHaveLength(3);
			expect(all).toContain(ddg);
			expect(all).toContain(tavily);
			expect(all).toContain(brave);
		});

		it("returns empty array when no providers registered", () => {
			expect(registry.getAll()).toEqual([]);
		});
	});

	// ── getAvailable() ─────────────────────────────────────────────

	describe("getAvailable", () => {
		beforeEach(() => {
			registry.register(ddg);
			registry.register(tavily);
			registry.register(brave);
		});

		it("includes enabled provider without key requirement", () => {
			const configs: Record<string, ProviderConfig> = {
				duckduckgo: { enabled: true, delayMs: 1500, apiKey: null },
				tavily: { enabled: false, delayMs: 0, apiKey: null },
				brave: { enabled: false, delayMs: 0, apiKey: null },
			};
			const available = registry.getAvailable(configs);
			expect(available).toHaveLength(1);
			expect(available[0].meta.type).toBe("duckduckgo");
		});

		it("includes enabled provider with key present", () => {
			const configs: Record<string, ProviderConfig> = {
				duckduckgo: { enabled: true, delayMs: 1500, apiKey: null },
				tavily: { enabled: true, delayMs: 0, apiKey: "key-123" },
				brave: { enabled: false, delayMs: 0, apiKey: null },
			};
			const available = registry.getAvailable(configs);
			expect(available).toHaveLength(2);
		});

		it("excludes enabled provider with missing key when key is required", () => {
			const configs: Record<string, ProviderConfig> = {
				duckduckgo: { enabled: false, delayMs: 1500, apiKey: null },
				tavily: { enabled: true, delayMs: 0, apiKey: null },
				brave: { enabled: true, delayMs: 0, apiKey: "key" },
			};
			const available = registry.getAvailable(configs);
			expect(available).toHaveLength(1);
			expect(available[0].meta.type).toBe("brave");
		});

		it("excludes disabled provider even with key", () => {
			const configs: Record<string, ProviderConfig> = {
				duckduckgo: { enabled: false, delayMs: 1500, apiKey: null },
				tavily: { enabled: false, delayMs: 0, apiKey: "key" },
				brave: { enabled: false, delayMs: 0, apiKey: "key" },
			};
			expect(registry.getAvailable(configs)).toEqual([]);
		});

		it("excludes provider with no config entry", () => {
			const configs: Record<string, ProviderConfig> = {
				duckduckgo: { enabled: true, delayMs: 1500, apiKey: null },
				// tavily and brave not in configs
			};
			const available = registry.getAvailable(configs);
			expect(available).toHaveLength(1);
			expect(available[0].meta.type).toBe("duckduckgo");
		});
	});

	// ── getAvailableByPriority() ───────────────────────────────────

	describe("getAvailableByPriority", () => {
		beforeEach(() => {
			registry.register(ddg);
			registry.register(tavily);
			registry.register(brave);
			registry.register(serpapi);
		});

		const allEnabled: Record<string, ProviderConfig> = {
			duckduckgo: { enabled: true, delayMs: 1500, apiKey: null },
			tavily: { enabled: true, delayMs: 0, apiKey: "tav-key" },
			brave: { enabled: true, delayMs: 0, apiKey: "brave-key" },
			serpapi: { enabled: true, delayMs: 0, apiKey: "serp-key" },
		};

		it("returns providers in the specified priority order", () => {
			const result = registry.getAvailableByPriority(allEnabled, [
				"brave",
				"tavily",
				"duckduckgo",
				"serpapi",
			]);
			expect(result.map((p) => p.meta.type)).toEqual([
				"brave",
				"tavily",
				"duckduckgo",
				"serpapi",
			]);
		});

		it("excludes providers not in priority list", () => {
			const result = registry.getAvailableByPriority(allEnabled, [
				"tavily",
				"duckduckgo",
			]);
			expect(result.map((p) => p.meta.type)).toEqual([
				"tavily",
				"duckduckgo",
			]);
		});

		it("excludes unconfigured providers even if in priority list", () => {
			const configs: Record<string, ProviderConfig> = {
				duckduckgo: { enabled: true, delayMs: 1500, apiKey: null },
				tavily: { enabled: true, delayMs: 0, apiKey: null }, // missing key
				brave: { enabled: false, delayMs: 0, apiKey: "key" }, // disabled
				serpapi: { enabled: true, delayMs: 0, apiKey: "key" },
			};
			const result = registry.getAvailableByPriority(configs, [
				"tavily",
				"brave",
				"duckduckgo",
				"serpapi",
			]);
			expect(result.map((p) => p.meta.type)).toEqual([
				"duckduckgo",
				"serpapi",
			]);
		});

		it("returns empty array when no providers match", () => {
			const configs: Record<string, ProviderConfig> = {
				duckduckgo: { enabled: false, delayMs: 1500, apiKey: null },
				tavily: { enabled: false, delayMs: 0, apiKey: null },
				brave: { enabled: false, delayMs: 0, apiKey: null },
				serpapi: { enabled: false, delayMs: 0, apiKey: null },
			};
			expect(
				registry.getAvailableByPriority(configs, [
					"duckduckgo",
					"tavily",
					"brave",
					"serpapi",
				]),
			).toEqual([]);
		});

		it("handles priority list with unknown provider types gracefully", () => {
			const result = registry.getAvailableByPriority(allEnabled, [
				"unknown-provider",
				"tavily",
				"duckduckgo",
			]);
			expect(result.map((p) => p.meta.type)).toEqual([
				"tavily",
				"duckduckgo",
			]);
		});
	});
});
