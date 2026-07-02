/**
 * CheckpointStorage — schema_version, shape validation, and future-version gate.
 *
 * Currently zero coverage; these tests establish the baseline contract introduced
 * by Task 01 (schema versioning).
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Vault } from "obsidian";
import { CheckpointStorage } from "./storage";
import type { Checkpoint } from "../types";

function makeVault(files: Record<string, string>): Vault {
	const dirs = new Set<string>();
	// Auto-register all parent directories so exists() returns true for them.
	for (const key of Object.keys(files)) {
		const parts = key.split("/");
		let acc = "";
		for (let i = 0; i < parts.length - 1; i++) {
			acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
			dirs.add(acc);
		}
	}
	const adapter = {
		exists: async (p: string): Promise<boolean> => p in files || dirs.has(p),
		mkdir: async (p: string): Promise<void> => { dirs.add(p); },
		list: async (p: string) => {
			const prefix = p.endsWith("/") ? p : p + "/";
			return {
				files: Object.keys(files).filter((k) => k.startsWith(prefix)),
				folders: [],
			};
		},
		read: async (p: string): Promise<string> => {
			if (!(p in files)) throw new Error(`ENOENT: ${p}`);
			return files[p]!;
		},
		write: async (p: string, data: string): Promise<void> => { files[p] = data; },
		stat: async () => ({ mtime: 0, size: 0 }),
	};
	return { adapter } as unknown as Vault;
}

function validCheckpoint(over: Partial<Checkpoint> = {}): Checkpoint {
	return {
		id: "ckpt-1",
		conversation_id: "conv-1",
		note_path: "notes/foo.md",
		content: "# Foo\n",
		timestamp: "2026-07-01T00:00:00Z",
		description: "Before edit",
		tool_name: "write_note",
		message_id: "msg-1",
		schema_version: 1,
		...over,
	};
}

const BASE = ".obsidian/plugins/notor/checkpoints/";

let storage: CheckpointStorage;

beforeEach(() => {
	storage = new CheckpointStorage(makeVault({}), BASE.replace(/\/$/, ""), 10, 90);
});

describe("CheckpointStorage — schema_version round-trip", () => {
	it("save + load round-trips schema_version: 1", async () => {
		const vault = makeVault({});
		const s = new CheckpointStorage(vault, BASE.replace(/\/$/, ""), 10, 90);
		const ckpt = validCheckpoint();
		await s.save(ckpt);
		const loaded = await s.load("conv-1", "ckpt-1");
		expect(loaded).not.toBeNull();
		expect(loaded!.schema_version).toBe(1);
	});
});

describe("CheckpointStorage — legacy tolerance (no schema_version field)", () => {
	it("load normalizes schema_version to 1 for legacy checkpoints", async () => {
		const ckpt = validCheckpoint();
		const legacy = { ...ckpt } as Record<string, unknown>;
		delete legacy.schema_version;

		const path = `${BASE}conv-1/ckpt-1.json`;
		const vault = makeVault({ [path]: JSON.stringify(legacy) });
		const s = new CheckpointStorage(vault, BASE.replace(/\/$/, ""), 10, 90);
		const loaded = await s.load("conv-1", "ckpt-1");
		expect(loaded).not.toBeNull();
		expect(loaded!.schema_version).toBe(1);
	});

	it("listForConversation normalizes schema_version to 1 for legacy checkpoints", async () => {
		const ckpt = validCheckpoint();
		const legacy = { ...ckpt } as Record<string, unknown>;
		delete legacy.schema_version;

		const path = `${BASE}conv-1/ckpt-1.json`;
		const vault = makeVault({ [path]: JSON.stringify(legacy) });
		const s = new CheckpointStorage(vault, BASE.replace(/\/$/, ""), 10, 90);
		const list = await s.listForConversation("conv-1");
		expect(list).toHaveLength(1);
		expect(list[0]!.schema_version).toBe(1);
	});
});

describe("CheckpointStorage — shape validation", () => {
	it("load skips a file missing required field (note_path)", async () => {
		const bad = { id: "ckpt-1", conversation_id: "conv-1", content: "x", schema_version: 1 };
		const path = `${BASE}conv-1/ckpt-1.json`;
		const vault = makeVault({ [path]: JSON.stringify(bad) });
		const s = new CheckpointStorage(vault, BASE.replace(/\/$/, ""), 10, 90);
		const result = await s.load("conv-1", "ckpt-1");
		expect(result).toBeNull();
	});

	it("listForConversation skips files missing required fields", async () => {
		const bad = { id: "ckpt-bad", conversation_id: "conv-1", schema_version: 1 };
		const good = validCheckpoint({ id: "ckpt-good" });
		const vault = makeVault({
			[`${BASE}conv-1/ckpt-bad.json`]: JSON.stringify(bad),
			[`${BASE}conv-1/ckpt-good.json`]: JSON.stringify(good),
		});
		const s = new CheckpointStorage(vault, BASE.replace(/\/$/, ""), 10, 90);
		const list = await s.listForConversation("conv-1");
		expect(list.map((c) => c.id)).toEqual(["ckpt-good"]);
	});
});

describe("CheckpointStorage — future-version gate", () => {
	it("load skips a checkpoint with schema_version: 2 and returns null", async () => {
		const future = validCheckpoint({ schema_version: 2 });
		const path = `${BASE}conv-1/ckpt-future.json`;
		const vault = makeVault({ [path]: JSON.stringify(future) });
		const s = new CheckpointStorage(vault, BASE.replace(/\/$/, ""), 10, 90);
		const result = await s.load("conv-1", "ckpt-future");
		expect(result).toBeNull();
	});

	it("listForConversation silently skips schema_version: 2 checkpoints", async () => {
		const future = validCheckpoint({ id: "ckpt-future", schema_version: 2 });
		const current = validCheckpoint({ id: "ckpt-current" });
		const vault = makeVault({
			[`${BASE}conv-1/ckpt-future.json`]: JSON.stringify(future),
			[`${BASE}conv-1/ckpt-current.json`]: JSON.stringify(current),
		});
		const s = new CheckpointStorage(vault, BASE.replace(/\/$/, ""), 10, 90);
		const list = await s.listForConversation("conv-1");
		expect(list.map((c) => c.id)).toEqual(["ckpt-current"]);
	});
});
