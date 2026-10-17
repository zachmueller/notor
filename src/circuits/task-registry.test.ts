/**
 * INT-002 — `TaskRegistry` unit tests (the runtime task registry).
 *
 * Asserts the FR-122 idempotency contract (`ensure` never duplicates / never
 * resets), the status transitions (`start` → running, `close` → closed), list +
 * status filter, the open-task predicate the runner's FLOW_COMPLETE enforcement
 * reads (INT-003), and the frontmatter round-trip the contract pins down.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-002
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md — Task Note
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TaskRegistry, type TaskFs, parseTaskNote, serializeTaskNote, sanitizeTaskKey } from "./task-registry";

/** An in-memory TaskFs. */
class FakeTaskFs implements TaskFs {
	files = new Map<string, string>();
	dirs = new Set<string>();
	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.dirs.has(path);
	}
	async read(path: string): Promise<string> {
		const v = this.files.get(path);
		if (v === undefined) throw new Error(`ENOENT: ${path}`);
		return v;
	}
	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}
	async mkdir(path: string): Promise<void> {
		this.dirs.add(path);
	}
	async list(dir: string): Promise<string[]> {
		const prefix = dir.replace(/\/+$/, "") + "/";
		return [...this.files.keys()].filter((p) => p.startsWith(prefix));
	}
}

const TASKS = "sessions/s1/tasks";
let fs: FakeTaskFs;
let reg: TaskRegistry;
let clock: number;

beforeEach(() => {
	fs = new FakeTaskFs();
	clock = 0;
	reg = new TaskRegistry(fs, () => `2026-06-28T00:00:${String(clock++).padStart(2, "0")}.000Z`);
});

describe("TaskRegistry — ensure idempotency (FR-122)", () => {
	it("creates a task note with status open on first ensure", async () => {
		const res = await reg.ensure(TASKS, "step-01", "Implement the flag");
		expect(res.created).toBe(true);
		expect(res.note.status).toBe("open");
		expect(res.note.key).toBe("step-01");
		expect(fs.files.has(`${TASKS}/step-01.md`)).toBe(true);
	});

	it("a second ensure with the same key is a no-op (no duplicate, no reset)", async () => {
		await reg.ensure(TASKS, "step-01", "Implement");
		await reg.start(TASKS, "step-01"); // → running
		const res = await reg.ensure(TASKS, "step-01", "different description");
		expect(res.created).toBe(false);
		expect(res.note.status).toBe("running"); // NOT reset to open
		// Exactly one note for the key.
		const list = await reg.list(TASKS);
		expect(list).toHaveLength(1);
	});

	it("rejects an invalid (empty) key", async () => {
		await expect(reg.ensure(TASKS, "   ", "x")).rejects.toThrow(/Invalid task key/);
	});
});

describe("TaskRegistry — status transitions", () => {
	it("start sets running + stamps started; close sets closed + stamps completed", async () => {
		await reg.ensure(TASKS, "t", "desc");
		const started = await reg.start(TASKS, "t");
		expect(started.ok).toBe(true);
		expect(started.note!.status).toBe("running");
		expect(started.note!.started).not.toBeNull();
		expect(started.note!.completed).toBeNull();

		const closed = await reg.close(TASKS, "t");
		expect(closed.note!.status).toBe("closed");
		expect(closed.note!.completed).not.toBeNull();
	});

	it("start/close on an unknown key returns ok:false (not a throw)", async () => {
		expect((await reg.start(TASKS, "ghost")).ok).toBe(false);
		expect((await reg.close(TASKS, "ghost")).ok).toBe(false);
	});
});

describe("TaskRegistry — list, filter, and open predicate", () => {
	beforeEach(async () => {
		await reg.ensure(TASKS, "open-1", "o1");
		await reg.ensure(TASKS, "run-1", "r1");
		await reg.start(TASKS, "run-1");
		await reg.ensure(TASKS, "done-1", "d1");
		await reg.close(TASKS, "done-1");
	});

	it("lists all tasks", async () => {
		expect((await reg.list(TASKS)).map((t) => t.key).sort()).toEqual(["done-1", "open-1", "run-1"]);
	});

	it("filters by status", async () => {
		expect((await reg.list(TASKS, { status: "open" })).map((t) => t.key)).toEqual(["open-1"]);
		expect((await reg.list(TASKS, { status: "running" })).map((t) => t.key)).toEqual(["run-1"]);
		expect((await reg.list(TASKS, { status: "closed" })).map((t) => t.key)).toEqual(["done-1"]);
	});

	it("listOpen / hasOpenTasks reflect open + running (the INT-003 enforcement set)", async () => {
		const open = await reg.listOpen(TASKS);
		expect(open.map((t) => t.key).sort()).toEqual(["open-1", "run-1"]);
		expect(await reg.hasOpenTasks(TASKS)).toBe(true);

		await reg.start(TASKS, "open-1");
		await reg.close(TASKS, "open-1");
		await reg.close(TASKS, "run-1");
		expect(await reg.hasOpenTasks(TASKS)).toBe(false);
	});

	it("returns an empty list for a tasks dir that was never created", async () => {
		expect(await reg.list("sessions/empty/tasks")).toEqual([]);
		expect(await reg.hasOpenTasks("sessions/empty/tasks")).toBe(false);
	});
});

describe("TaskRegistry — frontmatter (de)serialization", () => {
	it("round-trips a task note through serialize → parse", () => {
		const md = serializeTaskNote({
			key: "step-01-impl",
			status: "running",
			created: "2026-06-27T10:00:42Z",
			started: "2026-06-27T10:01:00Z",
			completed: null,
			description: "Implement the --verbose flag.",
		});
		expect(md).toContain("notor-type: orchestration-task");
		expect(md).toContain("notor-task-status: running");
		expect(md).toContain("notor-task-completed: null");
		const parsed = parseTaskNote(md, "step-01-impl");
		expect(parsed).toMatchObject({
			key: "step-01-impl",
			status: "running",
			started: "2026-06-27T10:01:00Z",
			completed: null,
			description: "Implement the --verbose flag.",
		});
	});

	it("sanitizeTaskKey collapses unsafe chars and forbids traversal", () => {
		expect(sanitizeTaskKey("step/../etc")).not.toContain("/");
		expect(sanitizeTaskKey("..")).toBeNull();
		expect(sanitizeTaskKey("ok-key.1")).toBe("ok-key.1");
	});

	it("a malicious key cannot escape the tasks directory", async () => {
		await reg.ensure(TASKS, "../escape", "x");
		// Written under the tasks dir, not outside it.
		const written = [...fs.files.keys()];
		expect(written.every((p) => p.startsWith(TASKS + "/"))).toBe(true);
	});
});
