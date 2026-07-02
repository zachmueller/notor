import { describe, it, expect, vi } from "vitest";

vi.mock("../../utils/logger", () => ({
	logger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Desktop app so the webview branch is reachable; the gate then depends on the
// webview tool being enabled in settings.
vi.mock("obsidian", () => ({
	Notice: class {},
	Platform: { isDesktopApp: true, isDesktop: true },
	normalizePath: (p: string) => p,
	TFile: class {},
}));

import { buildPluginUtils } from "./plugin-utils";
import type { BuilderContext } from "./types";

function makeCtx(toolEnabled?: Record<string, boolean>) {
	const plugin = {
		app: { vault: { adapter: {} }, workspace: {}, viewRegistry: { viewByType: {} } },
		settings: { tool_enabled: toolEnabled ?? {} },
		getSharedCheckpointManager: () => ({ createCheckpoint: vi.fn() }),
		getStaleTracker: () => ({
			recordRead: vi.fn(), check: vi.fn(), invalidate: vi.fn(),
			updateAfterWrite: vi.fn(), updateAfterFrontmatterWrite: vi.fn(),
		}),
		getNoteOpener: () => ({ openNote: vi.fn() }),
		getTaskLaneQueue: () => ({ enqueue: vi.fn(), pending: vi.fn() }),
		getWebviewLeafCache: () => new Map(),
	};
	return { plugin, vaultRootPath: "", conversationId: "c1" } as unknown as BuilderContext;
}

describe("webview gate", () => {
	it("webview tool disabled (default) → stub whose methods throw the enable-the-tool error", () => {
		const utils = buildPluginUtils(makeCtx());
		expect(utils.webview).not.toBeNull();
		expect(() => utils.webview!.getActiveWebview()).toThrow(/enable the webview tool/i);
		expect(() => utils.webview!.getConversationId()).toThrow(/Settings → Tools/);
	});

	it("webview tool enabled → real facade (methods do not throw the gate error)", () => {
		const utils = buildPluginUtils(makeCtx({ webview: true }));
		expect(utils.webview).not.toBeNull();
		// getActiveWebview on the real facade returns null (no live leaf) rather than
		// throwing the gate error.
		expect(utils.webview!.getActiveWebview()).toBeNull();
		expect(utils.webview!.getConversationId()).toBe("c1");
	});
});
