import { describe, it, expect, vi } from "vitest";

// Isolate buildUtils from the sub-builder graph — we only care that it stamps
// `api.version` from RUNTIME_API_VERSION onto the returned object.
vi.mock("../../utils/logger", () => ({
	logger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("./file-utils", () => ({ buildFileUtils: () => ({}) }));
vi.mock("./media-utils", () => ({ buildMediaUtils: () => ({}) }));
vi.mock("./web-utils", () => ({ buildWebUtils: () => ({}) }));
vi.mock("./chat-utils", () => ({
	buildChatUtils: () => ({}),
	buildAsk: () => async () => null,
	buildAskMany: () => async () => [],
}));
vi.mock("./sub-agent-utils", () => ({ buildSubAgentUtils: () => ({ runSubAgent: async () => null }) }));
vi.mock("./memory-utils", () => ({ buildMemoryUtils: () => ({ memory: null, memoryApprovalMode: null }) }));
vi.mock("./plugin-utils", () => ({ buildPluginUtils: () => ({}) }));
vi.mock("./orchestration-utils", () => ({ buildOrchestrationUtils: () => ({}) }));

import { buildUtils } from "./index";
import { RUNTIME_API_VERSION } from "./version";

function makePlugin() {
	return { app: { vault: { adapter: { basePath: "/vault" } } } } as never;
}

describe("buildUtils — runtime API version", () => {
	it("stamps api.version === 1 (RUNTIME_API_VERSION)", () => {
		const utils = buildUtils(makePlugin());
		expect(utils.api.version).toBe(1);
		expect(utils.api.version).toBe(RUNTIME_API_VERSION);
	});

	it("code steps inherit api.version — they call the same buildUtils(plugin)", () => {
		// Orchestration code steps build their utils via this exact function
		// (src/orchestration/launch.ts calls buildUtils(plugin)); there is no
		// separate builder, so the version stamp is carried for free.
		const utils = buildUtils(makePlugin());
		expect(utils.api.version).toBe(RUNTIME_API_VERSION);
	});
});
