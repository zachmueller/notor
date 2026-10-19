/**
 * Build an evaluator's input bundle from a loaded (finished) session.
 *
 * "Option a": the objective, the terminal outcome (status / topic / closing text
 * / structured return), and the notes the run's steps edited — reconstructed
 * from the persisted step conversations through `collectStepNotesTouched`, the
 * same path the scripting API uses. Step transcripts are never included. An LLM
 * judge may additionally get the edited notes' CURRENT contents (size-capped and
 * flagged when a note changed after the run finished).
 */

import { normalizePath } from "obsidian";
import { collectStepNotesTouched } from "../../api/notes-touched";
import { logger } from "../../utils/logger";
import type { CircuitHost } from "../host";
import type { SessionLogEntry } from "../session-log";
import type { Circuit, EvaluatorDefinition } from "../types";
import type { LoadedSession } from "./session-loader";
import type { EvalInput, EvalNoteContent } from "./types";

const log = logger("CircuitEvaluation");

/** Per-note cap on the contents shown to a judge. */
export const EVAL_NOTE_CAP_CHARS = 16_000;
/** Total cap across every note shown to a judge. */
export const EVAL_NOTES_TOTAL_CAP_CHARS = 60_000;

/** Conversation ids of the session's conversation-step turns, in log order, deduped. */
export function stepConversationIdsOf(entries: readonly SessionLogEntry[]): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const e of entries) {
		if ((e.type === "turn.start" || e.type === "turn.complete") && e.conversation_id && !seen.has(e.conversation_id)) {
			seen.add(e.conversation_id);
			ids.push(e.conversation_id);
		}
	}
	return ids;
}

/** The timestamp the run last wrote (its finish time, for the "changed since" flag). */
export function runFinishedAtOf(entries: readonly SessionLogEntry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.type === "run.result" || e.type === "session.complete" || e.type === "session.cancelled" || e.type === "turn.complete") {
			return e.ts ?? null;
		}
	}
	return null;
}

/** The minimal read surface for note contents (vault adapter in production). */
export interface NoteReader {
	read(path: string): Promise<string>;
	/** `null` when the platform cannot stat (mobile) or the file is gone. */
	stat(path: string): Promise<{ mtime: number } | null>;
}

export function vaultNoteReader(host: Pick<CircuitHost, "app">): NoteReader {
	const adapter = host.app.vault.adapter;
	return {
		read: (path) => adapter.read(normalizePath(path)),
		stat: async (path) => {
			try {
				const s = await adapter.stat(normalizePath(path));
				return s ? { mtime: s.mtime } : null;
			} catch {
				return null;
			}
		},
	};
}

/**
 * Read the edited notes' current contents under the caps. Notes past the total
 * cap are listed with empty, truncated content so the judge still knows they exist.
 */
export async function readNoteContents(
	reader: NoteReader,
	paths: readonly string[],
	runFinishedAt: string | null,
	caps: { perNote?: number; total?: number } = {},
): Promise<EvalNoteContent[]> {
	const perNote = caps.perNote ?? EVAL_NOTE_CAP_CHARS;
	const total = caps.total ?? EVAL_NOTES_TOTAL_CAP_CHARS;
	const finishedMs = runFinishedAt ? Date.parse(runFinishedAt) : NaN;
	const out: EvalNoteContent[] = [];
	let used = 0;
	for (const path of paths) {
		let content = "";
		let truncated = false;
		try {
			const raw = await reader.read(path);
			const room = Math.max(0, Math.min(perNote, total - used));
			if (raw.length > room) {
				content = raw.slice(0, room);
				truncated = true;
			} else {
				content = raw;
			}
			used += content.length;
		} catch (e) {
			content = "";
			truncated = true;
			log.debug("Edited note unreadable for evaluation", { path, error: String(e) });
		}
		let mtimeAfterRun: boolean | null = null;
		const stat = await reader.stat(path);
		if (stat && Number.isFinite(finishedMs)) mtimeAfterRun = stat.mtime > finishedMs;
		out.push({ path, content, truncated, mtimeAfterRun });
	}
	return out;
}

export interface BuildEvalInputArgs {
	circuit: Circuit;
	evaluator: EvaluatorDefinition;
	loaded: LoadedSession;
	/** Read the edited notes' current contents (LLM judges only). */
	includeNoteContents: boolean;
	/** Test seams. */
	deps?: {
		notesEdited?: (stepConversationIds: string[]) => Promise<string[]>;
		reader?: NoteReader;
	};
}

export async function buildEvalInput(host: CircuitHost, args: BuildEvalInputArgs): Promise<EvalInput> {
	const { circuit, evaluator, loaded } = args;
	const stepIds = stepConversationIdsOf(loaded.entries);

	let notesEdited: string[] = [];
	try {
		notesEdited = args.deps?.notesEdited
			? await args.deps.notesEdited(stepIds)
			: (await collectStepNotesTouched(host, stepIds)).notesEdited;
	} catch (e) {
		log.warn("Could not reconstruct edited notes for evaluation", { sessionId: loaded.meta.session_id, error: String(e) });
	}

	const noteContents =
		args.includeNoteContents && notesEdited.length > 0
			? await readNoteContents(args.deps?.reader ?? vaultNoteReader(host), notesEdited, runFinishedAtOf(loaded.entries))
			: [];

	return {
		circuit: { name: circuit.name, description: circuit.description },
		session: {
			sessionId: loaded.meta.session_id,
			startedAt: loaded.meta.started_at,
			origin: loaded.meta.origin,
			sessionDir: loaded.workspace.sessionDir,
		},
		objective: loaded.meta.prompt ?? "",
		outcome: loaded.outcome,
		notesEdited,
		noteContents,
		evaluator: { name: evaluator.name, dimensions: evaluator.dimensions },
	};
}
