import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskLaneQueue } from "../../queue/task-lane-queue";
import { SearchProviderRegistry } from "../provider-registry";
import { WebSearchQueue } from "../queue";
import type {
	SearchProvider,
	SearchProviderMeta,
	SearchProviderResult,
	ProviderConfig,
} from "../providers/provider";

/** Create a mock provider whose search() can be controlled per-test. */
function createMockProvider(
	type: string,
	requiresApiKey: boolean,
	searchImpl?: (
		query: string,
		numResults: number,
		timeoutMs: number,
		apiKey: string | null,
		signal?: AbortSignal,
	) => Promise<SearchProviderResult>,
): SearchProvider & { searchFn: ReturnType<typeof vi.fn> } {
	const searchFn = vi.fn(
		searchImpl ??
			(async (): Promise<SearchProviderResult> => ({
				results: [
					{ title: "Result", url: "https://example.com", snippet: "text" },
				],
			})),
	);

	return {
		meta: {
			type,
			displayName: type.charAt(0).toUpperCase() + type.slice(1),
			requiresApiKey,
			defaultDelayMs: type === "duckduckgo" ? 1500 : 0,
		} as SearchProviderMeta,
		search: searchFn,
		searchFn,
		isConfigured(config: ProviderConfig): boolean {
			if (!config.enabled) return false;
			if (requiresApiKey && !config.apiKey) return false;
			return true;
		},
	};
}

describe("WebSearchQueue", () => {
	let laneQueue: TaskLaneQueue;
	let registry: SearchProviderRegistry;
	let settingsValues: Record<string, unknown>;
	let getSettings: () => Record<string, unknown>;

	let ddg: ReturnType<typeof createMockProvider>;
	let tavily: ReturnType<typeof createMockProvider>;
	let brave: ReturnType<typeof createMockProvider>;

	beforeEach(() => {
		vi.clearAllMocks();

		laneQueue = new TaskLaneQueue();
		registry = new SearchProviderRegistry();

		ddg = createMockProvider("duckduckgo", false);
		tavily = createMockProvider("tavily", true);
		brave = createMockProvider("brave", true);

		registry.register(ddg);
		registry.register(tavily);
		registry.register(brave);

		settingsValues = {
			web_search_round_robin: false,
			web_search_provider_priority: ["duckduckgo", "tavily", "brave"],
			web_search_max_fallback_providers: 2,
			web_search_duckduckgo_enabled: true,
			web_search_duckduckgo_delay_ms: 0, // 0 for fast tests
			web_search_tavily_enabled: true,
			web_search_tavily_api_key: "tav-key",
			web_search_tavily_delay_ms: 0,
			web_search_brave_enabled: true,
			web_search_brave_api_key: "brave-key",
			web_search_brave_delay_ms: 0,
		};

		getSettings = () => settingsValues;
	});

	// ── Single provider success ────────────────────────────────────

	it("returns result from first provider on success", async () => {
		const queue = new WebSearchQueue(getSettings, registry, laneQueue);
		const result = await queue.search("test query", 5, 10000);

		expect(result.results).toHaveLength(1);
		expect(result.provider).toBe("duckduckgo");
		expect(result.failures).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	it("returns result with provider type 'duckduckgo' when only DDG enabled", async () => {
		settingsValues.web_search_tavily_enabled = false;
		settingsValues.web_search_brave_enabled = false;

		const queue = new WebSearchQueue(getSettings, registry, laneQueue);
		const result = await queue.search("ddg only", 3, 5000);

		expect(result.provider).toBe("duckduckgo");
		expect(ddg.searchFn).toHaveBeenCalledOnce();
		expect(tavily.searchFn).not.toHaveBeenCalled();
	});

	// ── Fallback: rate-limited ─────────────────────────────────────

	it("falls back to second provider when first is rate-limited", async () => {
		ddg.searchFn.mockResolvedValue({ results: [], rateLimited: true });

		const queue = new WebSearchQueue(getSettings, registry, laneQueue);
		const result = await queue.search("fallback test", 5, 10000);

		expect(result.provider).toBe("tavily");
		expect(result.failures).toEqual([
			{ provider: "duckduckgo", error: "Rate limited" },
		]);
	});

	// ── Fallback: error ────────────────────────────────────────────

	it("falls back to second provider when first throws", async () => {
		ddg.searchFn.mockRejectedValue(new Error("Network error"));

		const queue = new WebSearchQueue(getSettings, registry, laneQueue);
		const result = await queue.search("error test", 5, 10000);

		expect(result.provider).toBe("tavily");
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].provider).toBe("duckduckgo");
		expect(result.failures[0].error).toContain("Network error");
	});

	// ── All providers fail ─────────────────────────────────────────

	it("returns aggregated error when all providers fail", async () => {
		ddg.searchFn.mockResolvedValue({ results: [], rateLimited: true });
		tavily.searchFn.mockRejectedValue(new Error("Timeout"));

		// maxFallbackProviders = 2 means only 2 are tried
		const queue = new WebSearchQueue(getSettings, registry, laneQueue);
		const result = await queue.search("all fail", 5, 10000);

		expect(result.results).toEqual([]);
		expect(result.provider).toBe("");
		expect(result.error).toBe("All search providers failed");
		expect(result.failures).toHaveLength(2);
		expect(result.failures[0]).toEqual({
			provider: "duckduckgo",
			error: "Rate limited",
		});
		expect(result.failures[1].provider).toBe("tavily");
	});

	// ── No providers configured ────────────────────────────────────

	it("returns immediate error when no providers are configured", async () => {
		settingsValues.web_search_duckduckgo_enabled = false;
		settingsValues.web_search_tavily_enabled = false;
		settingsValues.web_search_brave_enabled = false;

		const queue = new WebSearchQueue(getSettings, registry, laneQueue);
		const result = await queue.search("no providers", 5, 10000);

		expect(result.results).toEqual([]);
		expect(result.provider).toBe("");
		expect(result.failures).toEqual([]);
		expect(result.error).toBe("No web search providers are configured");
		expect(ddg.searchFn).not.toHaveBeenCalled();
	});

	// ── Round-robin OFF ────────────────────────────────────────────

	it("always starts with highest-priority provider when round-robin is off", async () => {
		const queue = new WebSearchQueue(getSettings, registry, laneQueue);

		await queue.search("q1", 5, 10000);
		await queue.search("q2", 5, 10000);
		await queue.search("q3", 5, 10000);

		// DDG is always the first attempted provider
		expect(ddg.searchFn).toHaveBeenCalledTimes(3);
		// Tavily never tried because DDG succeeds
		expect(tavily.searchFn).not.toHaveBeenCalled();
	});

	// ── Round-robin ON ─────────────────────────────────────────────

	it("cycles starting provider when round-robin is on", async () => {
		settingsValues.web_search_round_robin = true;

		const searchTracker: string[] = [];
		ddg.searchFn.mockImplementation(async () => {
			searchTracker.push("duckduckgo");
			return { results: [{ title: "DDG", url: "https://ddg.com", snippet: "d" }] };
		});
		tavily.searchFn.mockImplementation(async () => {
			searchTracker.push("tavily");
			return { results: [{ title: "Tav", url: "https://tav.com", snippet: "t" }] };
		});
		brave.searchFn.mockImplementation(async () => {
			searchTracker.push("brave");
			return { results: [{ title: "Brv", url: "https://brv.com", snippet: "b" }] };
		});

		const queue = new WebSearchQueue(getSettings, registry, laneQueue);

		// 6 requests should cycle: ddg, tavily, brave, ddg, tavily, brave
		const results: string[] = [];
		for (let i = 0; i < 6; i++) {
			const r = await queue.search(`q${i}`, 5, 10000);
			results.push(r.provider);
		}

		expect(results).toEqual([
			"duckduckgo",
			"tavily",
			"brave",
			"duckduckgo",
			"tavily",
			"brave",
		]);
	});

	// ── buildConfig() ──────────────────────────────────────────────

	describe("buildConfig", () => {
		it("maps flat settings to typed config", () => {
			const queue = new WebSearchQueue(getSettings, registry, laneQueue);
			const config = queue.buildConfig(settingsValues);

			expect(config.roundRobin).toBe(false);
			expect(config.providerPriority).toEqual([
				"duckduckgo",
				"tavily",
				"brave",
			]);
			expect(config.maxFallbackProviders).toBe(2);
			expect(config.providers.duckduckgo).toEqual({
				enabled: true,
				delayMs: 0,
				apiKey: null,
			});
			expect(config.providers.tavily).toEqual({
				enabled: true,
				delayMs: 0,
				apiKey: "tav-key",
			});
		});

		it("falls back to defaults for missing settings", () => {
			const queue = new WebSearchQueue(getSettings, registry, laneQueue);
			const config = queue.buildConfig({});

			expect(config.roundRobin).toBe(false);
			expect(config.providerPriority).toEqual([
				"duckduckgo",
				"tavily",
				"brave",
				"serpapi",
			]);
			expect(config.maxFallbackProviders).toBe(2);
			expect(config.providers.duckduckgo.enabled).toBe(true);
			expect(config.providers.duckduckgo.delayMs).toBe(1500);
			expect(config.providers.tavily.enabled).toBe(false);
			expect(config.providers.brave.enabled).toBe(false);
			expect(config.providers.serpapi.enabled).toBe(false);
		});
	});

	// ── Lane delegation ────────────────────────────────────────────

	it("enqueues to laneQueue with correct lane key and delay", async () => {
		const enqueueSpy = vi.spyOn(laneQueue, "enqueue");

		settingsValues.web_search_duckduckgo_delay_ms = 1500;

		const queue = new WebSearchQueue(getSettings, registry, laneQueue);
		await queue.search("lane test", 5, 10000);

		expect(enqueueSpy).toHaveBeenCalledWith(
			"duckduckgo",
			expect.any(Function),
			1500,
		);
	});

	it("uses provider-specific delay from settings for each lane", async () => {
		ddg.searchFn.mockResolvedValue({ results: [], rateLimited: true });
		settingsValues.web_search_duckduckgo_delay_ms = 1500;
		settingsValues.web_search_tavily_delay_ms = 200;

		const enqueueSpy = vi.spyOn(laneQueue, "enqueue");

		const queue = new WebSearchQueue(getSettings, registry, laneQueue);
		await queue.search("lane delays", 5, 10000);

		// First call: DDG with 1500ms delay
		expect(enqueueSpy).toHaveBeenNthCalledWith(
			1,
			"duckduckgo",
			expect.any(Function),
			1500,
		);
		// Second call (fallback): Tavily with 200ms delay
		expect(enqueueSpy).toHaveBeenNthCalledWith(
			2,
			"tavily",
			expect.any(Function),
			200,
		);
	});

	// ── Settings read fresh ────────────────────────────────────────

	it("reads settings fresh on each search call", async () => {
		const queue = new WebSearchQueue(getSettings, registry, laneQueue);

		// First call: DDG enabled
		const r1 = await queue.search("fresh1", 5, 10000);
		expect(r1.provider).toBe("duckduckgo");

		// Disable DDG between calls
		settingsValues.web_search_duckduckgo_enabled = false;

		const r2 = await queue.search("fresh2", 5, 10000);
		expect(r2.provider).toBe("tavily");
	});

	// ── maxFallbackProviders ───────────────────────────────────────

	it("stops after maxFallbackProviders attempts even if providers remain", async () => {
		ddg.searchFn.mockResolvedValue({ results: [], rateLimited: true });
		tavily.searchFn.mockResolvedValue({ results: [], rateLimited: true });

		settingsValues.web_search_max_fallback_providers = 2;

		const queue = new WebSearchQueue(getSettings, registry, laneQueue);
		const result = await queue.search("max attempts", 5, 10000);

		expect(result.failures).toHaveLength(2);
		expect(result.error).toBe("All search providers failed");
		// Brave was available but not tried
		expect(brave.searchFn).not.toHaveBeenCalled();
	});

	it("tries all providers when maxFallbackProviders exceeds available count", async () => {
		ddg.searchFn.mockResolvedValue({ results: [], rateLimited: true });
		tavily.searchFn.mockResolvedValue({ results: [], rateLimited: true });
		brave.searchFn.mockResolvedValue({ results: [], rateLimited: true });

		settingsValues.web_search_max_fallback_providers = 10;

		const queue = new WebSearchQueue(getSettings, registry, laneQueue);
		const result = await queue.search("all tried", 5, 10000);

		expect(result.failures).toHaveLength(3);
		expect(ddg.searchFn).toHaveBeenCalledOnce();
		expect(tavily.searchFn).toHaveBeenCalledOnce();
		expect(brave.searchFn).toHaveBeenCalledOnce();
	});

	// ── resolveProviderChain() ─────────────────────────────────────

	describe("resolveProviderChain", () => {
		it("returns priority order when round-robin is off", () => {
			const queue = new WebSearchQueue(getSettings, registry, laneQueue);
			const config = queue.buildConfig(settingsValues);
			config.roundRobin = false;

			const chain = queue.resolveProviderChain(config, 5);
			expect(chain.map((p) => p.meta.type)).toEqual([
				"duckduckgo",
				"tavily",
				"brave",
			]);
		});

		it("rotates starting position when round-robin is on", () => {
			const queue = new WebSearchQueue(getSettings, registry, laneQueue);
			const config = queue.buildConfig(settingsValues);
			config.roundRobin = true;

			const chain0 = queue.resolveProviderChain(config, 0);
			expect(chain0.map((p) => p.meta.type)).toEqual([
				"duckduckgo",
				"tavily",
				"brave",
			]);

			const chain1 = queue.resolveProviderChain(config, 1);
			expect(chain1.map((p) => p.meta.type)).toEqual([
				"tavily",
				"brave",
				"duckduckgo",
			]);

			const chain2 = queue.resolveProviderChain(config, 2);
			expect(chain2.map((p) => p.meta.type)).toEqual([
				"brave",
				"duckduckgo",
				"tavily",
			]);

			// Wraps around
			const chain3 = queue.resolveProviderChain(config, 3);
			expect(chain3.map((p) => p.meta.type)).toEqual([
				"duckduckgo",
				"tavily",
				"brave",
			]);
		});

		it("returns empty array when no providers available", () => {
			settingsValues.web_search_duckduckgo_enabled = false;
			settingsValues.web_search_tavily_enabled = false;
			settingsValues.web_search_brave_enabled = false;

			const queue = new WebSearchQueue(getSettings, registry, laneQueue);
			const config = queue.buildConfig(settingsValues);
			config.roundRobin = true;

			expect(queue.resolveProviderChain(config, 0)).toEqual([]);
		});
	});

	// ── Signal / abort handling ────────────────────────────────────

	it("passes signal through to provider search", async () => {
		const controller = new AbortController();

		const queue = new WebSearchQueue(getSettings, registry, laneQueue);
		await queue.search("signal test", 5, 10000, controller.signal);

		expect(ddg.searchFn).toHaveBeenCalledWith(
			"signal test",
			5,
			10000,
			null,
			controller.signal,
		);
	});

	it("stops iteration when signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const queue = new WebSearchQueue(getSettings, registry, laneQueue);
		const result = await queue.search("aborted", 5, 10000, controller.signal);

		expect(result.error).toBe("All search providers failed");
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].error).toBe("Aborted");
		expect(ddg.searchFn).not.toHaveBeenCalled();
	});
});
