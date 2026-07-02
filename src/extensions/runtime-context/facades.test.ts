import { describe, it, expect, vi } from "vitest";

vi.mock("../../utils/logger", () => ({
	logger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Minimal obsidian surface used by buildPluginUtils / NoteOpener.
vi.mock("obsidian", () => ({
	Notice: class {},
	Platform: { isDesktopApp: false, isDesktop: false },
	normalizePath: (p: string) => p,
	TFile: class {},
}));

import { buildPluginUtils } from "./plugin-utils";
import type { BuilderContext } from "./types";
import { NoteOpener } from "../../tools/note-opener";

function makeCtx() {
	const checkpointManager = { createCheckpoint: vi.fn(async () => ({ id: "cp1" })) };
	const staleTracker = {
		recordRead: vi.fn(),
		check: vi.fn(() => ({ isStale: false, error: null })),
		invalidate: vi.fn(),
		updateAfterWrite: vi.fn(),
		updateAfterFrontmatterWrite: vi.fn(),
	};
	const defaultOpener = { openNote: vi.fn(async () => {}) };
	const plugin = {
		app: { vault: { adapter: {} } },
		settings: {},
		getSharedCheckpointManager: () => checkpointManager,
		getStaleTracker: () => staleTracker,
		getNoteOpener: () => defaultOpener,
		getTaskLaneQueue: () => ({ enqueue: vi.fn(), pending: vi.fn() }),
		getWebviewLeafCache: () => new Map(),
	};
	const ctx = { plugin, vaultRootPath: "", conversationId: "c1" } as unknown as BuilderContext;
	return { ctx, checkpointManager, staleTracker, defaultOpener };
}

describe("plugin-utils facades", () => {
	it("checkpoints.create delegates to CheckpointManager.createCheckpoint", async () => {
		const { ctx, checkpointManager } = makeCtx();
		const utils = buildPluginUtils(ctx);
		const cp = await utils.checkpoints.create("note.md", "write_note", "msg1");
		expect(checkpointManager.createCheckpoint).toHaveBeenCalledWith("note.md", "write_note", "msg1");
		expect(cp).toEqual({ id: "cp1" });
	});

	it("staleContent methods delegate to the StaleContentTracker (the 5 consumed methods)", () => {
		const { ctx, staleTracker } = makeCtx();
		const utils = buildPluginUtils(ctx);

		utils.staleContent.recordRead("a.md", "x");
		utils.staleContent.check("a.md", "x");
		utils.staleContent.invalidate("a.md");
		utils.staleContent.updateAfterWrite("a.md", "y");
		utils.staleContent.updateAfterFrontmatterWrite("a.md", "z");

		expect(staleTracker.recordRead).toHaveBeenCalledWith("a.md", "x");
		expect(staleTracker.check).toHaveBeenCalledWith("a.md", "x");
		expect(staleTracker.invalidate).toHaveBeenCalledWith("a.md");
		expect(staleTracker.updateAfterWrite).toHaveBeenCalledWith("a.md", "y");
		expect(staleTracker.updateAfterFrontmatterWrite).toHaveBeenCalledWith("a.md", "z");
	});

	it("notes.open delegates to the default opener, and _setNoteOpener swaps the backing opener", async () => {
		const { ctx, defaultOpener } = makeCtx();
		const utils = buildPluginUtils(ctx);

		await utils.notes.open("a.md");
		expect(defaultOpener.openNote).toHaveBeenCalledWith("a.md");

		// Swap in a disabled opener (as UserToolAdapter does for silent/orchestration).
		const replacement = new NoteOpener({} as never, false, false);
		const spy = vi.spyOn(replacement, "openNote").mockResolvedValue();
		utils._setNoteOpener(replacement);
		await utils.notes.open("b.md");
		expect(spy).toHaveBeenCalledWith("b.md");
		// The original opener was not called again.
		expect(defaultOpener.openNote).toHaveBeenCalledTimes(1);
	});

	it("raw manager members are not present on the facade object", () => {
		const { ctx } = makeCtx();
		const utils = buildPluginUtils(ctx) as Record<string, unknown>;
		expect(utils.staleTracker).toBeUndefined();
		expect(utils.checkpointManager).toBeUndefined();
		expect(utils.noteOpener).toBeUndefined();
	});
});
