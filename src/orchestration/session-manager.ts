/**
 * `OrchestrationSessionManager` (INT-001) — owner of per-session workspace
 * lifecycle.
 *
 * On flow start it allocates a session id and creates
 * `{notor_dir}/orchestrations/sessions/{session-id}/` containing:
 *  - `session.json` — the {@link OrchestrationSessionMeta} (initial status
 *    `active`, flow name, iteration 0, the original prompt, and the always-set
 *    `origin` recovery discriminator);
 *  - an empty `session-log.jsonl` directory slot (the *writer* is FEAT-006's
 *    `SessionLog` — this task only owns the directory and the metadata file);
 *  - a `scratchpad/` directory (shared, restriction-free cross-step working
 *    space — auto-allowed in path enforcement for the owning session's step
 *    turns, FR-121);
 *  - a `tasks/` directory (populated by the four task tools, INT-002).
 *
 * It exposes the resolved `scratchpadPath` / `tasksPath` for the prompt scaffold
 * (FEAT-005) to inject and for the engine to thread into step turns via the
 * per-step {@link OrchestrationToolContext}. **The defining responsibility beyond
 * directory creation is path auto-allow** — but that is implemented as a
 * *session-scoped* prefix carried on the `OrchestrationToolContext` and consumed
 * by `enforcePathConstraints(..., sessionAllowedPaths)` at the single dispatch
 * site (INT-001 path-enforcer change). The manager never mutates the shared/global
 * tool config and never introduces a global "current session", so a step in
 * session A can never reach session B's scratchpad.
 *
 * Shape authority: [data-model.md] `OrchestrationSessionMeta`. Vault layout +
 * `session.json` field semantics: [contracts/vault-schema.md].
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-001
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md — Directory Structure / session.json
 */

import { logger } from "../utils/logger";
import type { OrchestrationSessionMeta } from "./types";

const log = logger("OrchestrationSessionManager");

/**
 * The minimal durable filesystem surface the session manager needs. In
 * production this is backed by Obsidian's `vault.adapter`; tests inject a fake.
 * Paths are vault-relative, forward-slash, already normalized by the caller.
 */
export interface SessionFs {
	/** True if a file/dir exists at `path`. */
	exists(path: string): Promise<boolean>;
	/** Create the directory at `path` (and intermediate dirs as needed). */
	mkdir(path: string): Promise<void>;
	/** Overwrite the file at `path` with `data` (create if absent). */
	write(path: string, data: string): Promise<void>;
	/** Read the file at `path`. Rejects if absent. */
	read(path: string): Promise<string>;
}

/** A resolved session workspace: the directory + its well-known sub-paths. */
export interface SessionWorkspace {
	sessionId: string;
	/** `{notor_dir}/orchestrations/sessions/{id}`. */
	sessionDir: string;
	/** `{sessionDir}/scratchpad`. */
	scratchpadPath: string;
	/** `{sessionDir}/tasks`. */
	tasksPath: string;
	/** `{sessionDir}/session.json`. */
	metaPath: string;
	/** `{sessionDir}/session-log.jsonl`. */
	logPath: string;
}

export interface CreateSessionArgs {
	sessionId: string;
	flowName: string;
	prompt: string;
	/** Always set — never null (the recovery discriminator). */
	origin: OrchestrationSessionMeta["origin"];
	/** `null` for a root (`user` / `hook`); set for a composition child. */
	parentSessionId?: string | null;
}

/** Strip a trailing slash so path joins never double up. */
function trimSlash(p: string): string {
	return p.replace(/\/+$/, "");
}

export class OrchestrationSessionManager {
	private readonly orchestrationsRoot: string;

	/**
	 * @param notorDir - The configured Notor directory (e.g. `notor`).
	 * @param fs       - Durable filesystem surface (vault adapter in production).
	 */
	constructor(
		notorDir: string,
		private readonly fs: SessionFs,
	) {
		this.orchestrationsRoot = `${trimSlash(notorDir)}/orchestrations`;
	}

	/** `{notor_dir}/orchestrations`. */
	get rootPath(): string {
		return this.orchestrationsRoot;
	}

	/** Resolve a session's well-known paths (no I/O). */
	resolveWorkspace(sessionId: string): SessionWorkspace {
		const sessionDir = `${this.orchestrationsRoot}/sessions/${sessionId}`;
		return {
			sessionId,
			sessionDir,
			scratchpadPath: `${sessionDir}/scratchpad`,
			tasksPath: `${sessionDir}/tasks`,
			metaPath: `${sessionDir}/session.json`,
			logPath: `${sessionDir}/session-log.jsonl`,
		};
	}

	/**
	 * Create the session workspace on flow start: the session directory and its
	 * `scratchpad/` + `tasks/` subdirectories, plus `session.json` with status
	 * `active`, iteration 0, the flow name, the prompt, and the always-set
	 * `origin`. Idempotent on the directories (re-create is a no-op). Returns the
	 * resolved workspace paths the engine threads into step turns.
	 */
	async createSession(args: CreateSessionArgs): Promise<SessionWorkspace> {
		const ws = this.resolveWorkspace(args.sessionId);

		await this.ensureDir(ws.sessionDir);
		await this.ensureDir(ws.scratchpadPath);
		await this.ensureDir(ws.tasksPath);

		const meta: OrchestrationSessionMeta = {
			session_id: args.sessionId,
			flow_name: args.flowName,
			status: "active",
			iteration: 0,
			active_step: null,
			started_at: new Date().toISOString(),
			prompt: args.prompt,
			parent_session_id: args.parentSessionId ?? null,
			origin: args.origin,
		};
		await this.writeMeta(ws, meta);

		log.info("Created orchestration session workspace", {
			sessionId: args.sessionId,
			flow: args.flowName,
			origin: args.origin,
		});
		return ws;
	}

	/** Read `session.json`. Throws if absent / unparseable. */
	async readMeta(sessionId: string): Promise<OrchestrationSessionMeta> {
		const ws = this.resolveWorkspace(sessionId);
		const raw = await this.fs.read(ws.metaPath);
		return JSON.parse(raw) as OrchestrationSessionMeta;
	}

	/** Overwrite `session.json` with `meta`. */
	async writeMeta(
		ws: SessionWorkspace | string,
		meta: OrchestrationSessionMeta,
	): Promise<void> {
		const metaPath =
			typeof ws === "string" ? this.resolveWorkspace(ws).metaPath : ws.metaPath;
		await this.fs.write(metaPath, JSON.stringify(meta, null, 2) + "\n");
	}

	/**
	 * Patch a session's status (and optionally `iteration` / `active_step`),
	 * preserving every other field. Used at finalize and by recovery to mark a
	 * session `error`/`completed`/`interrupted`.
	 */
	async updateStatus(
		sessionId: string,
		status: OrchestrationSessionMeta["status"],
		patch?: Partial<Pick<OrchestrationSessionMeta, "iteration" | "active_step">>,
	): Promise<void> {
		const meta = await this.readMeta(sessionId);
		meta.status = status;
		if (patch?.iteration !== undefined) meta.iteration = patch.iteration;
		if (patch?.active_step !== undefined) meta.active_step = patch.active_step;
		await this.writeMeta(sessionId, meta);
	}

	// -- Internals -----------------------------------------------------------

	private async ensureDir(path: string): Promise<void> {
		if (!(await this.fs.exists(path))) {
			await this.fs.mkdir(path);
		}
	}
}
