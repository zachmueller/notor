/**
 * Failed-run debug notes (opt-in via `orchestration_write_failure_notes`).
 *
 * When an orchestration run terminates with `status: "error"`, this composes a
 * human-readable Markdown debug report from data the engine **already** captures
 * — `session.json` meta, the `OrchestrationRunResult`, and the `session-log.jsonl`
 * timeline — and writes it to a discoverable note under
 * `{notor_dir}/orchestrations/failures/{flow-slug}-{session_id}.md`. The user (or
 * Notor itself) can then open or `@`-reference that note to debug the failure
 * instead of spelunking the raw per-session JSON/JSONL machine state.
 *
 * This module **only composes & formats** — it adds no new capture. The note's
 * frontmatter uses a dedicated `notor-type: orchestration-failure-report`
 * discriminator (deliberately NOT `orchestration-flow` / `orchestration-step`) so
 * flow discovery and the flow parser ignore it.
 *
 * Mirrors {@link ./memories} — a tiny path helper + a writer over {@link SessionFs}.
 */

import { logger } from "../utils/logger";
import type { SessionFs } from "./session-manager";
import type { OrchestrationRunResult } from "./runner";
import type { OrchestrationSessionMeta } from "./types";
import { SessionLogReader } from "./session-log-reader";
import type { SessionLogEntry } from "./session-log";

const log = logger("OrchestrationFailureReport");

/** Strip a trailing slash so path joins never double up. */
function trimSlash(p: string): string {
	return p.replace(/\/+$/, "");
}

/**
 * Slugify a flow display name into a filesystem-safe, lowercase, dash-joined
 * token (e.g. `"Notor Usage Miner"` → `notor-usage-miner`). Falls back to `flow`
 * when the name reduces to nothing.
 */
export function slugifyFlowName(flowName: string): string {
	const slug = flowName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "flow";
}

/**
 * The gate for the opt-in failed-run debug note: write one iff the run actually
 * failed (`status === "error"`) **and** the setting is enabled. A user
 * `cancelled` run and a `completed` run never produce a note; nor does any run
 * while the setting is off.
 */
export function shouldWriteFailureReport(
	status: OrchestrationRunResult["status"],
	settingEnabled: boolean,
): boolean {
	return settingEnabled && status === "error";
}

/** Vault-relative path to a run's failure report note. */
export function failureReportPath(
	notorDir: string,
	flowName: string,
	sessionId: string,
): string {
	return `${trimSlash(notorDir)}/orchestrations/failures/${slugifyFlowName(flowName)}-${sessionId}.md`;
}

export interface WriteFailureReportArgs {
	notorDir: string;
	fs: SessionFs;
	/** The session's `session.json` metadata. */
	meta: OrchestrationSessionMeta;
	/** The terminal run result (caller guarantees `status === "error"`). */
	result: OrchestrationRunResult;
	/** Raw `session-log.jsonl` contents, or `null` if unreadable. */
	logJsonl: string | null;
	/** `sessions/{id}` dir (vault-relative) for the raw-data pointer links. */
	sessionDir: string;
}

/**
 * Compose and write the failure report note. Returns the written path.
 *
 * The caller is responsible for gating on the setting + `status === "error"` and
 * for wrapping this in a `.catch()` so a report-write failure never masks the
 * original run error.
 */
export async function writeFailureReport(args: WriteFailureReportArgs): Promise<string> {
	const { notorDir, fs, meta, result, logJsonl, sessionDir } = args;
	const path = failureReportPath(notorDir, meta.flow_name, meta.session_id);

	const entries = parseLogEntriesSafe(logJsonl);
	const content = buildReportMarkdown({ meta, result, entries, sessionDir });

	await fs.write(path, content);
	log.info("Wrote orchestration failure report", { path, session: meta.session_id });
	return path;
}

/**
 * Parse the log defensively — a failure report must never itself throw on a
 * malformed/torn log. Returns `[]` on any parse problem.
 */
function parseLogEntriesSafe(logJsonl: string | null): SessionLogEntry[] {
	if (!logJsonl) return [];
	try {
		return new SessionLogReader().parse(logJsonl).entries;
	} catch (e) {
		log.warn("Failed to parse session log for failure report", { error: String(e) });
		return [];
	}
}

interface BuildArgs {
	meta: OrchestrationSessionMeta;
	result: OrchestrationRunResult;
	entries: SessionLogEntry[];
	sessionDir: string;
}

function buildReportMarkdown({ meta, result, entries, sessionDir }: BuildArgs): string {
	const sections: string[] = [];

	// --- Frontmatter (dedicated discriminator so flow discovery ignores it) ---
	sections.push(
		[
			"---",
			"notor-type: orchestration-failure-report",
			`notor-flow: ${yamlString(meta.flow_name)}`,
			`notor-session-id: ${yamlString(meta.session_id)}`,
			`notor-status: ${yamlString(result.status)}`,
			`notor-terminal-topic: ${yamlString(result.terminal.topic)}`,
			`notor-started-at: ${yamlString(meta.started_at)}`,
			`notor-iterations: ${result.iterations}`,
			`notor-origin: ${yamlString(meta.origin)}`,
			`notor-parent-session-id: ${meta.parent_session_id ? yamlString(meta.parent_session_id) : "null"}`,
			"---",
		].join("\n"),
	);

	sections.push(`# Orchestration failure: ${meta.flow_name}`);

	sections.push(
		[
			`**Session:** \`${meta.session_id}\``,
			`**Status:** ${result.status} (terminal event \`${result.terminal.topic}\`)`,
			`**Started:** ${meta.started_at}`,
			`**Step-turns (hops):** ${result.iterations}`,
			`**Origin:** ${meta.origin}`,
		].join("  \n"),
	);

	// --- Objective -------------------------------------------------------------
	sections.push(`## Objective\n\n${meta.prompt?.trim() || "_(none recorded)_"}`);

	// --- Failure reason (the terminal FLOW_ERROR payload) ----------------------
	sections.push(`## Failure reason\n\n${codeFence(result.terminal.payload || "(no reason recorded)")}`);

	// --- Failing step + stack (from a {step}.code_error log entry) -------------
	const codeError = findCodeError(entries);
	if (codeError) {
		const lines = [`**Failing step:** \`${codeError.step ?? "(unknown)"}\``, ""];
		lines.push(`**Error:** ${codeError.error ?? "(none)"}`);
		if (codeError.stack) {
			lines.push("", "**Stack:**", codeFence(codeError.stack));
		}
		sections.push(`## Failing step\n\n${lines.join("\n")}`);
	}

	// --- Event timeline --------------------------------------------------------
	sections.push(`## Event timeline\n\n${buildTimelineTable(entries)}`);

	// --- Raw data pointer ------------------------------------------------------
	sections.push(
		`## Raw data\n\n` +
			`For a deep dive, inspect the raw session state:\n\n` +
			`- Session metadata: \`${sessionDir}/session.json\`\n` +
			`- Full event log: \`${sessionDir}/session-log.jsonl\`\n` +
			`- Working files: \`${sessionDir}/scratchpad/\``,
	);

	return sections.join("\n\n") + "\n";
}

interface CodeErrorInfo {
	step: string | null;
	error: string | null;
	stack: string | null;
}

/**
 * Scan the log's emitted events for the most recent `{step}.code_error`, whose
 * payload is `JSON.stringify({ step, error, stack })` (see code-step-executor).
 */
function findCodeError(entries: SessionLogEntry[]): CodeErrorInfo | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.type === "event.emitted" && e.topic.endsWith(".code_error")) {
			try {
				const parsed = JSON.parse(e.payload) as Partial<CodeErrorInfo>;
				return {
					step: parsed.step ?? e.source_step ?? null,
					error: parsed.error ?? null,
					stack: parsed.stack ?? null,
				};
			} catch {
				// Payload wasn't the expected JSON — still surface what we have.
				return { step: e.source_step ?? null, error: e.payload || null, stack: null };
			}
		}
	}
	return null;
}

/** A compact Markdown table of the turn timeline, ending at the failure. */
function buildTimelineTable(entries: SessionLogEntry[]): string {
	const rows: string[] = [];
	for (const e of entries) {
		if (e.type === "turn.complete") {
			rows.push(
				`| ${e.turn} | ${mdCell(e.step)} | \`${e.emitted_topic}\` | ${e.cost_usd.toFixed(4)} |`,
			);
		} else if (e.type === "event.emitted" && isTerminalLike(e.topic)) {
			// Surface the terminal/error event even though it has no turn.complete.
			rows.push(`| ${e.turn} | ${mdCell(e.source_step ?? "—")} | \`${e.topic}\` | — |`);
		}
	}
	if (rows.length === 0) return "_(no turns recorded)_";
	return ["| Turn | Step | Emitted | Cost (USD) |", "|---|---|---|---|", ...rows].join("\n");
}

function isTerminalLike(topic: string): boolean {
	return (
		topic === "FLOW_ERROR" ||
		topic === "FLOW_CANCELLED" ||
		topic === "FLOW_COMPLETE" ||
		topic.endsWith(".code_error") ||
		topic.endsWith(".capped")
	);
}

// --- Small formatting helpers ----------------------------------------------

/** Quote a YAML scalar safely (double-quoted, escaping `"` and `\`). */
function yamlString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Escape pipes/newlines so a value is safe inside a Markdown table cell. */
function mdCell(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Wrap text in a fenced code block, picking a fence that won't collide. */
function codeFence(text: string): string {
	const fence = text.includes("```") ? "````" : "```";
	return `${fence}\n${text}\n${fence}`;
}
