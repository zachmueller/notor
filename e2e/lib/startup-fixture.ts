/**
 * Synthetic vault generator for the startup-timing harness.
 *
 * Builds a vault whose *shape* matches a heavy real-world Notor install
 * (file counts, size distributions, feature flags), filled with generated
 * content. Only aggregate statistics (counts and size deciles) are embedded
 * below. No real conversation or note content is used.
 *
 * Deterministic: the same options always produce byte-identical output
 * (seeded PRNG, fixed "now"-relative timestamps rounded to the day).
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Profile — aggregate stats from a real heavy install (Nov 2026)
// ---------------------------------------------------------------------------

/** Size deciles in bytes (p0, p10, …, p100). */
type Deciles = readonly number[];

export const REAL_PROFILE = {
	conversations: { count: 360, sizes: [205, 2151, 31955, 61176, 105838, 147007, 211924, 269801, 341414, 555891, 3456710] as Deciles },
	stepConversations: { count: 1165, sizes: [35158, 39821, 41343, 43624, 47935, 56983, 65743, 74405, 87554, 89709, 304573] as Deciles },
	subAgentConversations: { count: 200, sizes: [2029, 18782, 55736, 80863, 138936, 204450, 255124, 312938, 355025, 458862, 2606420] as Deciles },
	checkpoints: { conversations: 538, count: 3627, sizes: [437, 5312, 8472, 12880, 17469, 21584, 26183, 32685, 43908, 70725, 134104] as Deciles },
	circuitSessions: { count: 1981, logSizes: [936, 1086, 1270, 4500, 6913, 9743, 18818, 30882, 44531, 54173, 55831] as Deciles },
	circuits: 6,
	workflows: 16,
	personas: 12,
	userTools: 2,
	notes: 7859,
	otherFiles: 1211,
	mcpServers: 10,
	/** The restored conversation: ~315 KB over 24 lines. */
	restored: { bytes: 315_000, lines: 24 },
} as const;

export interface StartupFixtureOptions {
	/** Multiplier applied to every count (default 1 = real profile). */
	scale?: number;
	/** Number of echo MCP stdio servers (default: profile count). 0 disables MCP. */
	mcpServers?: number;
	/** Plugin log level written to data.json (the real install runs "debug"). */
	logLevel?: "debug" | "info" | "warn" | "error";
	/** Absolute path of e2e/fixtures/echo-mcp-server.mjs. */
	echoServerPath: string;
	/** Directory holding the built plugin (main.js, manifest.json, styles.css). */
	buildDir: string;
}

export interface StartupFixtureInfo {
	restoredConversationId: string;
	runTreeRootSessionId: string;
	markdownNotePath: string;
	counts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function sampleDeciles(rand: () => number, d: Deciles): number {
	const x = rand() * 10;
	const i = Math.min(9, Math.floor(x));
	const lo = d[i]!;
	const hi = d[i + 1]!;
	return Math.round(lo + (hi - lo) * (x - i));
}

function uuid(rand: () => number): string {
	const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
	return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

const DAY = 86_400_000;
/** Midnight UTC today, so a fixture built twice on the same day is identical. */
const NOW = Math.floor(Date.now() / DAY) * DAY;

function compactTs(ms: number): string {
	const d = new Date(ms).toISOString(); // 2026-11-25T03:53:56.000Z
	return `${d.slice(0, 4)}${d.slice(5, 7)}${d.slice(8, 10)}_${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}`;
}

const LOREM =
	"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus. " +
	"Vestibulum id ligula porta felis euismod semper. Cras mattis consectetur purus sit amet fermentum. ";

/** Markdown-ish filler of roughly `n` characters (headings, lists, code). */
function markdownFiller(rand: () => number, n: number): string {
	const parts: string[] = [];
	let len = 0;
	while (len < n) {
		const r = rand();
		const chunk =
			r < 0.15 ? `\n## Section ${Math.floor(rand() * 100)}\n\n`
				: r < 0.3 ? `- ${LOREM.slice(0, 60 + Math.floor(rand() * 60))}\n`
					: r < 0.38 ? "\n```ts\nconst value = compute(input);\nreturn value;\n```\n\n"
						: LOREM;
		parts.push(chunk);
		len += chunk.length;
	}
	return parts.join("").slice(0, Math.max(0, n));
}

function write(file: string, content: string | Buffer): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

// ---------------------------------------------------------------------------
// JSONL builders (shapes match src/chat/history.ts and step-conversation-store.ts)
// ---------------------------------------------------------------------------

interface HeaderBase {
	id: string;
	created_at: string;
	updated_at: string;
	title: string;
}

function conversationJsonl(
	rand: () => number,
	header: Record<string, unknown> & HeaderBase,
	targetBytes: number,
	targetLines?: number,
): string {
	const lines = [JSON.stringify({ schema_version: 1, provider_id: "local", model_id: "fixture-model", total_input_tokens: 0, total_output_tokens: 0, estimated_cost: null, mode: "act", ...header })];
	let bytes = lines[0]!.length + 1;
	const perMessage = targetLines ? Math.max(200, Math.floor(targetBytes / Math.max(1, targetLines - 1))) : 4000;
	let i = 0;
	while (bytes < targetBytes && (!targetLines || lines.length < targetLines)) {
		const role = i % 2 === 0 ? "user" : "assistant";
		const remaining = targetBytes - bytes;
		const size = Math.max(40, Math.min(remaining, role === "user" ? Math.min(perMessage, 600) : perMessage) - 160);
		const msg = {
			_type: "message",
			id: uuid(rand),
			conversation_id: header.id,
			role,
			content: role === "user" ? `Question ${i}: ${markdownFiller(rand, size)}` : markdownFiller(rand, size),
			timestamp: header.updated_at,
		};
		const line = JSON.stringify(msg);
		lines.push(line);
		bytes += line.length + 1;
		i++;
	}
	return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Workspace layouts
// ---------------------------------------------------------------------------

export type WorkspaceVariant = "collapsed" | "visible";

/**
 * The real install's layout: chat as the current tab of the left sidebar,
 * inspector + run-tree in the right sidebar, a note active in the main area.
 * `collapsed` = both sidebars collapsed (the real state); `visible` = expanded.
 */
export function buildWorkspace(variant: WorkspaceVariant, info: StartupFixtureInfo): Record<string, unknown> {
	const collapsed = variant === "collapsed";
	const leaf = (id: string, type: string, state: Record<string, unknown>, icon: string, title: string) => ({
		id, type: "leaf", state: { type, state, icon, title },
	});
	return {
		main: {
			id: "st-main", type: "split", direction: "vertical",
			children: [{
				id: "st-main-tabs", type: "tabs",
				children: [leaf("st-note", "markdown", { file: info.markdownNotePath, mode: "source", source: false }, "lucide-file", "Note")],
			}],
		},
		left: {
			id: "st-left", type: "split", direction: "horizontal", width: 600, collapsed,
			children: [{
				id: "st-left-tabs", type: "tabs", currentTab: 2,
				children: [
					leaf("st-files", "file-explorer", { sortOrder: "alphabetical" }, "lucide-folder-closed", "Files"),
					leaf("st-search", "search", { query: "" }, "lucide-search", "Search"),
					leaf("st-chat", "notor-chat-view", { conversationId: info.restoredConversationId }, "message-square", "Notor chat"),
				],
			}],
		},
		right: {
			id: "st-right", type: "split", direction: "horizontal", width: 450, collapsed,
			children: [
				{
					id: "st-right-tabs-1", type: "tabs",
					children: [leaf("st-inspector", "notor-tool-config-inspector", {}, "sliders-horizontal", "Tool config inspector")],
				},
				{
					id: "st-right-tabs-2", type: "tabs",
					children: [leaf("st-runtree", "notor-run-tree-view", { rootSessionId: info.runTreeRootSessionId }, "git-branch", "Run tree")],
				},
			],
		},
		active: "st-note",
		lastOpenFiles: [info.markdownNotePath],
	};
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function generateStartupFixture(vaultDir: string, opts: StartupFixtureOptions): StartupFixtureInfo {
	const scale = opts.scale ?? 1;
	const n = (x: number) => Math.max(1, Math.round(x * scale));
	const rand = mulberry32(0x5eed);
	const P = REAL_PROFILE;

	fs.rmSync(vaultDir, { recursive: true, force: true });
	const cfg = path.join(vaultDir, ".obsidian");
	const pluginDir = path.join(cfg, "plugins", "notor");
	const historyDir = path.join(pluginDir, "history");
	const checkpointDir = path.join(pluginDir, "checkpoints");
	const notorDir = path.join(vaultDir, "notor");

	// --- Obsidian config + plugin artifacts --------------------------------
	write(path.join(cfg, "app.json"), JSON.stringify({ settingsPopoutWindow: false }, null, 2));
	write(path.join(cfg, "community-plugins.json"), JSON.stringify(["notor"]));
	for (const f of ["main.js", "manifest.json", "styles.css"]) {
		const src = path.join(opts.buildDir, f);
		if (fs.existsSync(src)) write(path.join(pluginDir, f), fs.readFileSync(src));
	}

	// --- Vault notes + other files ------------------------------------------
	const noteCount = n(P.notes);
	let firstNote = "";
	for (let i = 0; i < noteCount; i++) {
		const rel = `Notes/Area-${String(i % 40).padStart(2, "0")}/Note ${String(i).padStart(5, "0")}.md`;
		if (!firstNote) firstNote = rel;
		const tags = [`topic/${i % 25}`, `status/${["open", "done", "idea"][i % 3]}`];
		const body = `---\ntags: [${tags.join(", ")}]\ncreated: ${new Date(NOW - (i % 400) * DAY).toISOString().slice(0, 10)}\n---\n\n# Note ${i}\n\nSee [[Note ${String((i * 7) % noteCount).padStart(5, "0")}]].\n\n${markdownFiller(rand, 600 + Math.floor(rand() * 2400))}\n`;
		write(path.join(vaultDir, rel), body);
	}
	for (let i = 0; i < n(P.otherFiles); i++) {
		write(path.join(vaultDir, "Attachments", `file-${i}.png`), Buffer.alloc(256 + (i % 7) * 512, i % 251));
	}

	// --- Personas, workflows, user tools -----------------------------------
	for (let i = 0; i < n(P.personas); i++) {
		write(
			path.join(notorDir, "personas", `fixture-persona-${i}`, "system-prompt.md"),
			`---\nnotor-persona-prompt-mode: "append"\n---\n\nYou are fixture persona ${i}. ${LOREM}\n`,
		);
	}
	for (let i = 0; i < n(P.workflows); i++) {
		write(
			path.join(notorDir, "workflows", `Fixture workflow ${i}.md`),
			`---\nnotor-type: workflow\nnotor-trigger: manual\n---\n\nSummarize the active note. ${LOREM}\n`,
		);
	}
	for (let i = 0; i < n(P.userTools); i++) {
		const name = `fixture_tool_${i}`;
		write(
			path.join(notorDir, "tools", `${name}.md`),
			`---\nnotor-type: tool\nnotor-tool-name: ${name}\nnotor-description: "Fixture tool ${i}."\nnotor-mode: read\n---\n\nFixture tool.\n\n\`\`\`yaml\nparams:\n  text:\n    type: string\n    description: "Input"\n\`\`\`\n\n\`\`\`ts\nconst text: string = String(params.text ?? "");\nreturn text.toUpperCase();\n\`\`\`\n`,
		);
	}

	// --- Circuits (legacy orchestrations/ data root, like the real install) --
	const circuitsRoot = path.join(notorDir, "orchestrations");
	const circuitNames: string[] = [];
	for (let c = 0; c < n(P.circuits); c++) {
		const name = `fixture-circuit-${c}`;
		circuitNames.push(name);
		const dir = path.join(circuitsRoot, name);
		const steps = ["plan", "work", "review"];
		write(path.join(dir, "definition.md"), [
			"---",
			"notor-type: circuit",
			`notor-circuit-name: ${name}`,
			`notor-circuit-description: "Fixture circuit ${c}"`,
			"notor-starting-event: START",
			"notor-completion-event: CIRCUIT_COMPLETE",
			`notor-steps: [${steps.map((s) => `"[[${s}]]"`).join(", ")}]`,
			...(c === 0 ? ["notor-circuit-invocable: true"] : []),
			"---",
			"",
			`Fixture circuit ${c}.`,
			"",
		].join("\n"));
		const topics = ["START", "PLANNED", "WORKED", "CIRCUIT_COMPLETE"];
		steps.forEach((s, i) => {
			write(path.join(dir, "steps", `${s}.md`), [
				"---",
				"notor-type: circuit-step",
				`notor-step-name: ${s}`,
				`notor-step-triggers: [${topics[i]}]`,
				`notor-step-publishes: [${topics[i + 1]}]`,
				`notor-step-default-publishes: ${topics[i + 1]}`,
				"---",
				"",
				`Step ${s}: ${LOREM}`,
				"",
			].join("\n"));
		});
	}

	// --- Circuit sessions (all finished, like a long-lived install) ---------
	const sessionIds: string[] = [];
	const sessionsRoot = path.join(circuitsRoot, "sessions");
	for (let i = 0; i < n(P.circuitSessions.count); i++) {
		const sid = `sess-${uuid(rand).slice(0, 8)}-${uuid(rand).slice(0, 3)}`;
		sessionIds.push(sid);
		const startedMs = NOW - Math.floor(rand() * 200) * DAY;
		const dir = path.join(sessionsRoot, sid);
		write(path.join(dir, "session.json"), JSON.stringify({
			session_id: sid, flow_name: circuitNames[i % circuitNames.length], status: "completed",
			iteration: 3, active_step: null, started_at: new Date(startedMs).toISOString(),
			prompt: "Fixture objective", parent_session_id: null, origin: "user", schema_version: 1,
		}, null, 2));
		const logBytes = sampleDeciles(rand, P.circuitSessions.logSizes);
		const logLines: string[] = [];
		let b = 0;
		while (b < logBytes) {
			const line = JSON.stringify({ type: "event", topic: "WORKED", payload: LOREM.slice(0, 120), turn: logLines.length, ts: new Date(startedMs).toISOString() });
			logLines.push(line);
			b += line.length + 1;
		}
		write(path.join(dir, "session-log.jsonl"), logLines.join("\n") + "\n");
		write(path.join(dir, ".tasks", "tasks.json"), "[]");
		write(path.join(dir, ".scratchpad", "notes.txt"), "scratch\n");
	}
	const runTreeRootSessionId = sessionIds[0]!;

	// --- History: conversations, step conversations, sub-agents -------------
	const convIds: string[] = [];
	const convFiles: string[] = [];
	const restoredConversationId = uuid(rand);
	const convCount = n(P.conversations.count);
	for (let i = 0; i < convCount; i++) {
		const isRestored = i === 0;
		const id = isRestored ? restoredConversationId : uuid(rand);
		// Keep everything inside the default 90-day retention window so the
		// retention pass deletes nothing and every launch sees the same fixture.
		const createdMs = NOW - (isRestored ? 1 : 2 + Math.floor(rand() * 85)) * DAY + Math.floor(rand() * DAY);
		const updatedMs = isRestored ? NOW - 3600_000 : createdMs + Math.floor(rand() * DAY);
		const file = `${compactTs(createdMs)}_${id}.jsonl`;
		convIds.push(id);
		convFiles.push(file);
		const header = {
			_type: "conversation", id, title: `Fixture conversation ${i}`,
			created_at: new Date(createdMs).toISOString(), updated_at: new Date(updatedMs).toISOString(),
			...(i % 30 === 0 ? { is_favorite: true } : {}),
		};
		const content = isRestored
			? conversationJsonl(rand, header, P.restored.bytes, P.restored.lines)
			: conversationJsonl(rand, header, sampleDeciles(rand, P.conversations.sizes));
		write(path.join(historyDir, file), content);
	}

	const stepCount = n(P.stepConversations.count);
	let prevRootStep: string | null = null;
	for (let i = 0; i < stepCount; i++) {
		const id = uuid(rand);
		// The first 8 step conversations form the run-tree root session's chain.
		const inRoot = i < 8;
		const sid = inRoot ? runTreeRootSessionId : sessionIds[1 + (i % (sessionIds.length - 1 || 1))] ?? runTreeRootSessionId;
		const createdMs = NOW - Math.floor(rand() * 120) * DAY;
		const edges = inRoot && prevRootStep ? [{ kind: "prev", conversation_id: prevRootStep }] : [];
		const header = {
			_type: "orchestration_step_conversation", id,
			title: `[fixture] step — iteration ${i}`,
			created_at: new Date(createdMs).toISOString(), updated_at: new Date(createdMs).toISOString(),
			orchestration_session_id: sid, orchestration_flow_name: circuitNames[i % circuitNames.length],
			orchestration_step_name: ["plan", "work", "review"][i % 3], orchestration_iteration: i,
			orchestration_edges: edges,
		};
		if (inRoot) prevRootStep = id;
		write(path.join(historyDir, `orchestration_step_${id}.jsonl`), conversationJsonl(rand, header, sampleDeciles(rand, P.stepConversations.sizes)));
	}

	for (let i = 0; i < n(P.subAgentConversations.count); i++) {
		const parent = i % convIds.length;
		const parentFile = convFiles[parent]!;
		const parentTs = parentFile.slice(0, 15);
		const id = uuid(rand);
		const createdMs = NOW - Math.floor(rand() * 80) * DAY;
		const header = {
			_type: "sub_agent_conversation", id, title: `Sub-agent ${i}`,
			created_at: new Date(createdMs).toISOString(), updated_at: new Date(createdMs).toISOString(),
			parent_conversation_id: convIds[parent],
		};
		write(path.join(historyDir, `${parentTs}_${convIds[parent]}_subagent_${id}.jsonl`), conversationJsonl(rand, header, sampleDeciles(rand, P.subAgentConversations.sizes)));
	}

	// --- Checkpoints (not read at startup today; present for disk realism) --
	const ckConvs = Math.min(n(P.checkpoints.conversations), convIds.length);
	const ckTotal = n(P.checkpoints.count);
	for (let i = 0; i < ckTotal; i++) {
		const convId = convIds[i % ckConvs]!;
		const id = uuid(rand);
		const size = sampleDeciles(rand, P.checkpoints.sizes);
		write(path.join(checkpointDir, convId, `${id}.json`), JSON.stringify({
			id, conversation_id: convId, note_path: firstNote, content: markdownFiller(rand, size),
			timestamp: new Date(NOW - (i % 60) * DAY).toISOString(), description: "fixture", tool_name: "write_note",
			message_id: uuid(rand), schema_version: 1,
		}, null, 2));
	}

	// --- Plugin settings -----------------------------------------------------
	const mcpCount = opts.mcpServers ?? P.mcpServers;
	const mcp_servers: Record<string, unknown> = {};
	for (let i = 0; i < mcpCount; i++) {
		const name = `echo-${i}`;
		mcp_servers[name] = { name, type: "stdio", command: "node", args: [opts.echoServerPath, "8"], disabled: false, timeout: 30, annotationsNoticeShown: true };
	}
	write(path.join(pluginDir, "data.json"), JSON.stringify({
		log_level: opts.logLevel ?? "debug",
		circuits_enabled: true,
		templates_enabled: true,
		voice_enabled: true,
		output_spillover_enabled: true,
		active_persona: "fixture-persona-0",
		mcp_servers,
	}, null, 2));

	return {
		restoredConversationId,
		runTreeRootSessionId,
		markdownNotePath: firstNote,
		counts: {
			notes: noteCount,
			conversations: convCount,
			stepConversations: stepCount,
			subAgentConversations: n(P.subAgentConversations.count),
			checkpoints: ckTotal,
			circuitSessions: sessionIds.length,
			circuits: circuitNames.length,
			mcpServers: mcpCount,
		},
	};
}
