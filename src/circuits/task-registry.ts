/**
 * `TaskRegistry` (INT-002) — the runtime task-note read/write/parse helper the
 * four task tools (`orchestration_task_ensure` / `_start` / `_close` / `_list`)
 * and the runner's `FLOW_COMPLETE` enforcement (INT-003) share. The code-step
 * `OrchestrationHelper.tasks` API (INT-011, Lane B) dispatches through the same
 * implementation.
 *
 * Task notes live at `sessions/{id}/tasks/{key}.md` with `notor-type:
 * orchestration-task` frontmatter (the **single authority** of
 * [contracts/vault-schema.md]). The body is the free-form description.
 *
 * Frontmatter is read/written **deterministically** here (a tiny purpose-built
 * block, not the metadata-cache pipeline) because task notes live under the
 * runtime `sessions/` tree — alongside `session.json` / `session-log.jsonl` —
 * and are accessed through the vault adapter, not as cache-indexed vault notes.
 * The field set + value domain match the contract exactly.
 *
 * The module is **pure over an injected {@link TaskFs}** so it unit-tests with a
 * fake filesystem and so recovery replay (re-issuing the same `ensure` calls)
 * converges idempotently (FR-122 idempotency contract → FR-125 replay safety).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-002
 * @see specs/ZZ-misc/orchestration/contracts/tools.md — Task tools
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md — Task Note
 */

import { logger } from "../utils/logger";

const log = logger("TaskRegistry");

/** A task's lifecycle status. */
export type TaskStatus = "open" | "running" | "closed";

/** A parsed task note. */
export interface TaskNote {
	/** `notor-task-key` (matches the filename). */
	key: string;
	/** `notor-task-status`. */
	status: TaskStatus;
	/** `notor-task-created` (ISO). */
	created: string;
	/** `notor-task-started` (ISO) or `null`. */
	started: string | null;
	/** `notor-task-completed` (ISO) or `null`. */
	completed: string | null;
	/** Free-form body (the human-readable description). */
	description: string;
}

/**
 * The minimal durable filesystem surface the registry needs (vault adapter in
 * production; a fake in tests). Paths are vault-relative, forward-slash.
 */
export interface TaskFs {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	/** List entries directly under `dir`. Returns vault-relative file paths. */
	list(dir: string): Promise<string[]>;
}

/** Result of `ensure` — whether a note was created and the resulting note. */
export interface EnsureResult {
	created: boolean;
	note: TaskNote;
}

/** Result of a `start`/`close` mutation. */
export interface MutateResult {
	ok: boolean;
	note?: TaskNote;
	error?: string;
}

/**
 * Sanitize a task key into a safe filename stem. Keys are author/LLM-controlled,
 * so collapse anything outside `[A-Za-z0-9._-]` to `_` and forbid traversal.
 * Returns `null` for an empty/degenerate key.
 */
export function sanitizeTaskKey(key: string): string | null {
	const cleaned = key.trim().replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
	if (cleaned === "" || cleaned === "." || cleaned === "..") return null;
	return cleaned;
}

export class TaskRegistry {
	private readonly now: () => string;

	constructor(
		private readonly fs: TaskFs,
		now?: () => string,
	) {
		this.now = now ?? (() => new Date().toISOString());
	}

	/** Vault-relative path to a task note within `tasksDir`. */
	private notePath(tasksDir: string, safeKey: string): string {
		return `${tasksDir.replace(/\/+$/, "")}/${safeKey}.md`;
	}

	/**
	 * **Idempotent** create (FR-122). Creates `{key}.md` with status `open` if it
	 * does not exist; if it already exists, returns the existing note unchanged
	 * (no duplicate, no status reset). This is what makes recovery replay safe.
	 */
	async ensure(tasksDir: string, key: string, description: string): Promise<EnsureResult> {
		const safeKey = sanitizeTaskKey(key);
		if (!safeKey) throw new Error(`Invalid task key: "${key}"`);
		const path = this.notePath(tasksDir, safeKey);

		if (await this.fs.exists(path)) {
			const existing = parseTaskNote(await this.fs.read(path), safeKey);
			return { created: false, note: existing };
		}

		await this.ensureDir(tasksDir);
		const note: TaskNote = {
			key: safeKey,
			status: "open",
			created: this.now(),
			started: null,
			completed: null,
			description: description ?? "",
		};
		await this.fs.write(path, serializeTaskNote(note));
		log.debug("Ensured task (created)", { tasksDir, key: safeKey });
		return { created: true, note };
	}

	/** Set status `running` + stamp `notor-task-started`. Unknown key → `ok: false`. */
	async start(tasksDir: string, key: string): Promise<MutateResult> {
		return this.mutate(tasksDir, key, (note) => {
			note.status = "running";
			note.started = this.now();
		});
	}

	/** Set status `closed` + stamp `notor-task-completed`. Unknown key → `ok: false`. */
	async close(tasksDir: string, key: string): Promise<MutateResult> {
		return this.mutate(tasksDir, key, (note) => {
			note.status = "closed";
			note.completed = this.now();
		});
	}

	/** All tasks in the session, optionally filtered by status (FR-122). */
	async list(tasksDir: string, filter?: { status?: TaskStatus }): Promise<TaskNote[]> {
		const notes = await this.readAll(tasksDir);
		if (filter?.status) return notes.filter((n) => n.status === filter.status);
		return notes;
	}

	/** Tasks still `open` or `running` — the FLOW_COMPLETE enforcement set (INT-003). */
	async listOpen(tasksDir: string): Promise<TaskNote[]> {
		const notes = await this.readAll(tasksDir);
		return notes.filter((n) => n.status === "open" || n.status === "running");
	}

	/** True iff any task is `open` or `running` (the cheap enforcement predicate). */
	async hasOpenTasks(tasksDir: string): Promise<boolean> {
		return (await this.listOpen(tasksDir)).length > 0;
	}

	// -- Internals -----------------------------------------------------------

	private async mutate(
		tasksDir: string,
		key: string,
		apply: (note: TaskNote) => void,
	): Promise<MutateResult> {
		const safeKey = sanitizeTaskKey(key);
		if (!safeKey) return { ok: false, error: `Invalid task key: "${key}"` };
		const path = this.notePath(tasksDir, safeKey);
		if (!(await this.fs.exists(path))) {
			return { ok: false, error: `Unknown task key: "${key}"` };
		}
		const note = parseTaskNote(await this.fs.read(path), safeKey);
		apply(note);
		await this.fs.write(path, serializeTaskNote(note));
		return { ok: true, note };
	}

	private async readAll(tasksDir: string): Promise<TaskNote[]> {
		if (!(await this.fs.exists(tasksDir))) return [];
		const files = await this.fs.list(tasksDir);
		const notes: TaskNote[] = [];
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			const stem = (file.split("/").pop() ?? file).replace(/\.md$/, "");
			try {
				notes.push(parseTaskNote(await this.fs.read(file), stem));
			} catch (e) {
				log.warn("Failed to parse task note", { file, error: String(e) });
			}
		}
		// Stable order by creation time, then key.
		notes.sort((a, b) => a.created.localeCompare(b.created) || a.key.localeCompare(b.key));
		return notes;
	}

	private async ensureDir(dir: string): Promise<void> {
		if (!(await this.fs.exists(dir))) {
			await this.fs.mkdir(dir);
		}
	}
}

// ---------------------------------------------------------------------------
// Frontmatter (de)serialization — the bytes the contract pins down
// ---------------------------------------------------------------------------

/** Serialize a {@link TaskNote} to its on-disk Markdown (frontmatter + body). */
export function serializeTaskNote(note: TaskNote): string {
	const fm = [
		"---",
		"notor-type: orchestration-task",
		`notor-task-status: ${note.status}`,
		`notor-task-key: ${note.key}`,
		`notor-task-created: ${note.created}`,
		`notor-task-started: ${note.started ?? "null"}`,
		`notor-task-completed: ${note.completed ?? "null"}`,
		"---",
		"",
		note.description.trim(),
		"",
	];
	return fm.join("\n");
}

/**
 * Parse a task note's Markdown. `fallbackKey` (the filename stem) is used when
 * the frontmatter omits `notor-task-key`. Tolerant of quoting / extra fields.
 */
export function parseTaskNote(markdown: string, fallbackKey: string): TaskNote {
	const lines = markdown.split("\n");
	let status: TaskStatus = "open";
	let key = fallbackKey;
	let created = "";
	let started: string | null = null;
	let completed: string | null = null;

	let inFm = false;
	let fmEnded = false;
	let bodyStart = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (i === 0 && line.trim() === "---") {
			inFm = true;
			continue;
		}
		if (inFm && line.trim() === "---") {
			inFm = false;
			fmEnded = true;
			bodyStart = i + 1;
			break;
		}
		if (inFm) {
			const idx = line.indexOf(":");
			if (idx < 0) continue;
			const k = line.slice(0, idx).trim();
			const v = unquote(line.slice(idx + 1).trim());
			switch (k) {
				case "notor-task-status":
					if (v === "open" || v === "running" || v === "closed") status = v;
					break;
				case "notor-task-key":
					if (v) key = v;
					break;
				case "notor-task-created":
					created = v;
					break;
				case "notor-task-started":
					started = v === "null" || v === "" ? null : v;
					break;
				case "notor-task-completed":
					completed = v === "null" || v === "" ? null : v;
					break;
			}
		}
	}

	const description = fmEnded ? lines.slice(bodyStart).join("\n").trim() : markdown.trim();
	return { key, status, created, started, completed, description };
}

/** Strip surrounding quotes from a scalar value. */
function unquote(v: string): string {
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		return v.slice(1, -1);
	}
	return v;
}
