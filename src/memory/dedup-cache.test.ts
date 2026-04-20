import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	readDedupCache,
	writeDedupEntry,
	readDreamCursor,
	advanceDreamCursor,
} from "./dedup-cache";

function buildMockApp(files: Map<string, string> = new Map()) {
	return {
		vault: {
			adapter: {
				exists: vi.fn(async (path: string) => files.has(path)),
				read: vi.fn(async (path: string) => {
					const content = files.get(path);
					if (content === undefined) throw new Error(`File not found: ${path}`);
					return content;
				}),
				write: vi.fn(async (path: string, content: string) => {
					files.set(path, content);
				}),
				rename: vi.fn(async (from: string, to: string) => {
					const content = files.get(from);
					if (content !== undefined) {
						files.set(to, content);
						files.delete(from);
					}
				}),
			},
		},
	} as unknown as import("obsidian").App;
}

describe("readDedupCache / writeDedupEntry", () => {
	let files: Map<string, string>;
	let app: import("obsidian").App;
	const cachePath = "notor/memory/.dedup-cache.json";

	beforeEach(() => {
		files = new Map();
		app = buildMockApp(files);
	});

	it("returns empty object when file does not exist", async () => {
		const cache = await readDedupCache(app, cachePath, 24);
		expect(cache).toEqual({});
	});

	it("round-trips a written entry", async () => {
		const ts = new Date().toISOString();
		await writeDedupEntry(app, cachePath, "abc123", ts);

		const cache = await readDedupCache(app, cachePath, 24);
		expect(cache["abc123"]).toBe(ts);
	});

	it("preserves existing entries when adding new ones", async () => {
		const ts1 = new Date().toISOString();
		const ts2 = new Date().toISOString();

		await writeDedupEntry(app, cachePath, "first", ts1);
		await writeDedupEntry(app, cachePath, "second", ts2);

		const cache = await readDedupCache(app, cachePath, 24);
		expect(cache["first"]).toBe(ts1);
		expect(cache["second"]).toBe(ts2);
	});

	it("prunes entries older than the dedup window", async () => {
		const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
		const recent = new Date().toISOString();

		files.set(cachePath, JSON.stringify({ old_fp: old, recent_fp: recent }));

		const cache = await readDedupCache(app, cachePath, 24);
		expect(cache["old_fp"]).toBeUndefined();
		expect(cache["recent_fp"]).toBe(recent);
	});

	it("returns empty object for corrupt JSON", async () => {
		files.set(cachePath, "not json{{{");

		const cache = await readDedupCache(app, cachePath, 24);
		expect(cache).toEqual({});
	});

	it("uses atomic write pattern (tmp then rename)", async () => {
		const ts = new Date().toISOString();
		await writeDedupEntry(app, cachePath, "test", ts);

		expect(app.vault.adapter.write).toHaveBeenCalledWith(
			cachePath + ".tmp",
			expect.any(String),
		);
		expect(app.vault.adapter.rename).toHaveBeenCalledWith(
			cachePath + ".tmp",
			cachePath,
		);
	});
});

describe("readDreamCursor / advanceDreamCursor", () => {
	let files: Map<string, string>;
	let app: import("obsidian").App;
	const cursorPath = "notor/memory/.dream-cursor.json";

	beforeEach(() => {
		files = new Map();
		app = buildMockApp(files);
	});

	it("returns null when no file exists", async () => {
		const cursor = await readDreamCursor(app, cursorPath);
		expect(cursor).toBeNull();
	});

	it("round-trips cursor timestamp", async () => {
		const ts = "2026-04-18T12:00:00.000Z";
		await advanceDreamCursor(app, cursorPath, ts);

		const cursor = await readDreamCursor(app, cursorPath);
		expect(cursor).toBe(ts);
	});

	it("overwrites existing cursor", async () => {
		await advanceDreamCursor(app, cursorPath, "2026-04-18T12:00:00.000Z");
		await advanceDreamCursor(app, cursorPath, "2026-04-19T15:30:00.000Z");

		const cursor = await readDreamCursor(app, cursorPath);
		expect(cursor).toBe("2026-04-19T15:30:00.000Z");
	});

	it("returns null for corrupt JSON", async () => {
		files.set(cursorPath, "corrupt");

		const cursor = await readDreamCursor(app, cursorPath);
		expect(cursor).toBeNull();
	});

	it("uses atomic write pattern", async () => {
		await advanceDreamCursor(app, cursorPath, "2026-04-18T12:00:00.000Z");

		expect(app.vault.adapter.write).toHaveBeenCalledWith(
			cursorPath + ".tmp",
			expect.any(String),
		);
		expect(app.vault.adapter.rename).toHaveBeenCalledWith(
			cursorPath + ".tmp",
			cursorPath,
		);
	});
});
