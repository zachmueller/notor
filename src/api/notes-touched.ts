/**
 * Which vault notes a run read and edited, reconstructed after the run from
 * its persisted tool calls. Each successful call's vault path parameters are
 * classified by the access the tool registered for them (`read` / `write`),
 * the same descriptors path enforcement uses.
 */

import type { App } from "obsidian";
import type { ChatMessage } from "../providers/provider";
import type { ToolPathParam } from "../tool-config/types";
import { TOOL_PATH_PARAMS } from "../tool-config/path-enforcer";
import { canonicalToolName } from "../tools/tool-aliases";
import { resolveNote } from "../utils/resolve-note";
import type { Message } from "../types";
import type { NotorApiHost } from "./host";

export interface ToolCallRecord {
	toolName: string;
	parameters: Record<string, unknown>;
	success: boolean;
}

export interface NotesTouched {
	notesRead: string[];
	notesEdited: string[];
}

/**
 * Classify successful calls into read and edited note paths. A note that was
 * both read and edited is reported only as edited.
 */
export function classifyNotesTouched(
	calls: readonly ToolCallRecord[],
	pathParamsOf: (toolName: string) => readonly ToolPathParam[] | undefined,
	resolvePath: (path: string) => string | null,
): NotesTouched {
	const read = new Set<string>();
	const edited = new Set<string>();
	for (const call of calls) {
		if (!call.success) continue;
		for (const param of pathParamsOf(canonicalToolName(call.toolName)) ?? []) {
			if (param.namespace !== "vault") continue;
			const raw = call.parameters[param.paramName];
			if (typeof raw !== "string" || !raw) continue;
			const path = resolvePath(raw);
			if (!path) continue;
			(param.access === "write" ? edited : read).add(path);
		}
	}
	for (const path of edited) read.delete(path);
	return { notesRead: [...read].sort(), notesEdited: [...edited].sort() };
}

/** Tool calls from a chat conversation (`tool_call` / `tool_result` messages). */
export function toolCallsFromMessages(messages: readonly Message[]): ToolCallRecord[] {
	const records: ToolCallRecord[] = [];
	const pending: Array<{ id?: string; record: ToolCallRecord }> = [];
	for (const m of messages) {
		if (m.role === "tool_call" && m.tool_call) {
			const record = { toolName: m.tool_call.tool_name, parameters: m.tool_call.parameters ?? {}, success: false };
			records.push(record);
			pending.push({ id: m.tool_call.id, record });
		} else if (m.role === "tool_result" && m.tool_result) {
			// Pair by call id; legacy results without one pair by tool name, then order.
			const { tool_call_id: id, tool_name: resultTool } = m.tool_result;
			let i = id ? pending.findIndex((p) => p.id === id) : -1;
			if (i < 0) i = pending.findIndex((p) => p.record.toolName === resultTool);
			const match = pending.splice(Math.max(i, 0), 1)[0];
			if (match) match.record.success = m.tool_result.success;
		}
	}
	return records;
}

/** Tool calls from a circuit step conversation (provider-format messages). */
export function toolCallsFromChatMessages(messages: readonly ChatMessage[]): ToolCallRecord[] {
	const failed = new Set<string>();
	const finished = new Set<string>();
	for (const m of messages) {
		for (const r of m.tool_results ?? []) {
			finished.add(r.tool_call_id);
			if (r.is_error) failed.add(r.tool_call_id);
		}
	}
	return messages.flatMap((m) =>
		(m.tool_calls ?? []).map((c) => ({
			toolName: c.tool_name,
			parameters: c.parameters ?? {},
			success: finished.has(c.id) && !failed.has(c.id),
		})),
	);
}

/**
 * Collect notes touched across a run's conversations: chat-format
 * conversations by id, circuit step conversations by id, plus notes the
 * prompt attached (counted as reads).
 */
export async function collectNotesTouched(
	host: NotorApiHost,
	sources: { conversationIds?: string[]; stepConversationIds?: string[]; attachedPaths?: string[] },
): Promise<NotesTouched> {
	const calls: ToolCallRecord[] = [];

	if (sources.conversationIds?.length) {
		const history = host.getHistoryManager();
		const entries = await history.listConversations();
		for (const id of sources.conversationIds) {
			const entry = entries.find((e) => e.id === id);
			if (!entry) continue;
			const { messages } = await history.loadConversation(entry.filename);
			calls.push(...toolCallsFromMessages(messages));
		}
	}

	for (const id of sources.stepConversationIds ?? []) {
		calls.push(...toolCallsFromChatMessages(await readStepConversation(host, id)));
	}

	const touched = classifyNotesTouched(calls, (t) => TOOL_PATH_PARAMS[t], (p) => resolveVaultFile(host.app, p));
	const read = new Set(touched.notesRead);
	for (const p of sources.attachedPaths ?? []) {
		if (!touched.notesEdited.includes(p)) read.add(p);
	}
	return { notesRead: [...read].sort(), notesEdited: touched.notesEdited };
}

/** The vault path of an existing file (folders and missing paths are dropped). */
function resolveVaultFile(app: App, path: string): string | null {
	const file = resolveNote(path, app.vault, app.metadataCache) ?? app.vault.getFileByPath(path);
	return file?.path ?? null;
}

/** Messages of a persisted circuit step conversation (see VaultStepConversationStore). */
async function readStepConversation(host: NotorApiHost, conversationId: string): Promise<ChatMessage[]> {
	const dir = host.settings.history_path.replace(/\/+$/, "");
	const path = `${dir}/orchestration_step_${conversationId}.jsonl`;
	const adapter = host.app.vault.adapter;
	if (!(await adapter.exists(path))) return [];
	const messages: ChatMessage[] = [];
	for (const line of (await adapter.read(path)).split("\n")) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line) as { _type?: string } & ChatMessage;
			if (obj._type === "message") messages.push(obj);
		} catch {
			// A torn line never fails the collection.
		}
	}
	return messages;
}
