#!/usr/bin/env npx tsx
/**
 * Orchestration Inbox Triage & Filing E2E Test (example flow #2)
 *
 * A committed regression fixture for the **task-registry loop + per-persona
 * tool-gating + code-owns-the-writes** pattern. The flow iterates a deterministically
 * built work-queue, lets a READ-ONLY proposer persona decide where each note goes
 * (it physically cannot mutate — its `<notor_tool_config>` exposes read tools +
 * `emit_event` only, NO write tools), and a deterministic CODE step owns every
 * mutation (tag + move), each `once()`-guarded for crash-recovery safety.
 *
 *   list  (CODE): enumerate Inbox/ notes, `ensure` one task per note.
 *   router(CODE): start the next open task, route to `triage` (or FLOW_COMPLETE
 *     when the queue is empty). The ROUTER owns task lifecycle (start/close).
 *   triage(CONVERSATION, read-only persona): reads the note, emits a structured
 *     destination+tags proposal on its `emit_event` payload. It holds no write tools.
 *   apply (CODE): reads the proposal, owns the tag + move (each once()-guarded),
 *     closes the task, routes back to the router.
 *
 * The loop is a router→triage→apply→router cycle (distinct topics), so it never
 * trips the 4-identical-repeat stale-loop guard.
 *
 * The infra invariants asserted (never the LLM's prose):
 *   1. The flow reaches a terminal `session.json` status of `completed`.
 *   2. Every task in the registry is `closed` at completion (INT-003 enforcement held).
 *   3. The notes were filed — Inbox/ is drained and the seed notes now live under a
 *      destination folder (the code step's moves committed).
 *   4. Step conversations stay hidden from listConversations() (INT-006).
 *
 * Prerequisites:
 *   - AWS profile `default` with Bedrock access (the `triage` step is a real LLM turn).
 *
 * Run with:
 *   npx tsx e2e/scripts/orchestration-inbox-triage-test.ts
 *
 * @see specs/ZZ-misc/orchestration/contracts/orchestration-helper.md — tasks / once / callTool
 * @see ~/zm/ai/notor/ideas/Example orchestration flows to ship.md — flow #2
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	writeCleanWorkspace,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants + flow fixtures
// ---------------------------------------------------------------------------

const NOTOR_DIR = "notor";
const FLOW_NAME = "Inbox Triage E2E";
const FLOW_DIR = `${NOTOR_DIR}/orchestrations/inbox-triage-e2e`;
const PERSONA_DIR = `${NOTOR_DIR}/personas/inbox-triager-e2e`;

const INBOX_FOLDER = "Inbox";
const FILED_FOLDER = "Filed"; // all destinations live under here (code-owned)

/** The seed inbox notes — distinct topics so triage proposals differ per note. */
const INBOX_NOTES: Record<string, string> = {
	"meeting-recap.md": "# Q3 sync recap\n\nNotes from the Q3 planning sync with the team.\n",
	"recipe-idea.md": "# Sourdough experiment\n\nTrying a higher-hydration sourdough this weekend.\n",
	"bug-report.md": "# Crash on startup\n\nThe app crashes on launch when the cache is empty.\n",
};

/** definition.md — a task-registry loop: list → (router → triage → apply)* → complete. */
const DEFINITION_MD = `---
notor-type: orchestration-flow
notor-flow-name: "${FLOW_NAME}"
notor-flow-description: "Triage Inbox/ notes with a read-only proposer + code-owned filing (example #2)."
notor-starting-event: triage.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 30
notor-max-runtime-minutes: 20
notor-steps:
  - "[[list]]"
  - "[[router]]"
  - "[[triage]]"
  - "[[apply]]"
notor-guardrails:
  - "Be terse. Use the tools exactly as instructed."
---

# Inbox Triage E2E

Documentation only — never injected into a step prompt.
`;

/** list — CODE: enumerate Inbox/ markdown notes and ensure one task per note. */
const LIST_MD = `---
notor-type: orchestration-step
notor-step-name: "List"
notor-step-description: "Enumerates Inbox/ and seeds one task per note."
notor-step-mode: code
notor-step-triggers:
  - triage.start
notor-step-publishes:
  - queue.advance
notor-step-default-publishes: queue.advance
---

# List

\`\`\`typescript
const folder = app.vault.getAbstractFileByPath("${INBOX_FOLDER}");
const files = [];
if (folder && folder.children) {
  for (const child of folder.children) {
    if (child instanceof obsidian.TFile && child.extension === "md") {
      files.push(child.path);
    }
  }
}
files.sort();

// Use CLEAN task keys (note-1, note-2, …) — task keys are sanitized (slashes → "_"),
// so the real note path must NOT be the key. The path rides in the description, which
// the registry preserves verbatim and the router/apply steps read back authoritatively.
for (let i = 0; i < files.length; i++) {
  await orchestration.tasks.ensure("note-" + (i + 1), files[i]);
}

return orchestration.emit("queue.advance", JSON.stringify({ total: files.length }));
\`\`\`
`;

/**
 * router — CODE: starts the next open task and routes to triage; emits FLOW_COMPLETE
 * when none remain. Owns task lifecycle (start here, close in apply on the way back).
 */
const ROUTER_MD = `---
notor-type: orchestration-step
notor-step-name: "Router"
notor-step-description: "Pops the next open task or completes when the queue is empty."
notor-step-mode: code
notor-step-triggers:
  - queue.advance
notor-step-publishes:
  - triage.note
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

# Router

\`\`\`typescript
const open = await orchestration.tasks.list({ status: "open" });
if (open.length === 0) {
  return orchestration.emit("FLOW_COMPLETE", "Inbox drained — all notes filed.");
}
const next = open[0];
await orchestration.tasks.start(next.key);
// The note path is the task DESCRIPTION (the key is a sanitized "note-N"). Forward the
// real path to the read-only proposer.
return orchestration.emit("triage.note", next.description.trim());
\`\`\`
`;

/**
 * triage — CONVERSATION, read-only proposer persona. Holds NO write tools (enforced
 * by the persona's <notor_tool_config>): it reads the note and emits a structured
 * destination+tags proposal. It proposes; it never writes.
 */
const TRIAGE_MD = `---
notor-type: orchestration-step
notor-step-name: "Triage"
notor-step-description: "Read-only proposer: emits a destination + tags proposal."
notor-step-persona: inbox-triager-e2e
notor-step-triggers:
  - triage.note
notor-step-publishes:
  - triage.proposed
notor-step-default-publishes: triage.proposed
---

You are the Triage step — a READ-ONLY proposer. The incoming event payload is the
EXACT path of ONE inbox note (for example "Inbox/bug-report.md"). Do EXACTLY this,
then stop:

1. Call \`read_note\` with the path copied VERBATIM from the event payload — keep the
   slashes and the ".md" extension exactly as given; never replace "/" with "_" or
   drop the extension.
2. Decide a single-word category folder for it (e.g. "Meetings", "Recipes", "Bugs")
   and 1–2 lowercase topic tags.
3. Call \`emit_event\` with topic "triage.proposed" and payload a JSON object whose
   "path" is that SAME verbatim path:
   {"path":"<the exact note path>","category":"<FolderName>","tags":["tag1","tag2"]}

Emit raw JSON only — no prose, no fences. You have NO write tools; you only propose.
`;

/**
 * apply — CODE: owns every mutation. Reads the proposal, tags + moves the note
 * (each once()-guarded so a recovery re-run never re-errors), closes the task, and
 * routes back to the router. The destination is code-derived under Filed/ with a
 * safe fallback, so a malformed proposal never breaks the move.
 */
const APPLY_MD = `---
notor-type: orchestration-step
notor-step-name: "Apply"
notor-step-description: "Code owns the tag + move; closes the task; loops back."
notor-step-mode: code
notor-step-triggers:
  - triage.proposed
notor-step-publishes:
  - queue.advance
notor-step-default-publishes: queue.advance
---

# Apply

\`\`\`typescript
// The CODE step owns the mutations and is AUTHORITATIVE about which note it acts on:
// it uses the running task's description (the real path the router started), NOT the
// LLM-echoed path — so a proposer that mangles the path can never misfile a note.
const running = await orchestration.tasks.list({ status: "running" });
if (running.length === 0) {
  throw new Error("Apply: no running task to apply (router lifecycle invariant broken)");
}
const task = running[0];
const notePath = task.description.trim();

// Parse the proposer's structured payload only for the CATEGORY + TAGS (advisory).
let proposal = {};
const raw = (event.payload || "").trim();
try {
  proposal = JSON.parse(raw);
} catch (_e) {
  const open = raw.indexOf("{");
  const close = raw.lastIndexOf("}");
  if (open !== -1 && close > open) {
    try { proposal = JSON.parse(raw.slice(open, close + 1)); } catch (_e2) { /* advisory only */ }
  }
}

// Sanitize a code-owned destination under Filed/ (never trust the LLM's raw string).
const safe = (s) => String(s || "").replace(/[^A-Za-z0-9 _-]/g, "").trim();
const category = safe(proposal.category) || "Misc";
const base = notePath.split("/").pop();
const destPath = "${FILED_FOLDER}/" + category + "/" + base;

const tags = Array.isArray(proposal.tags)
  ? proposal.tags.map((t) => safe(t).toLowerCase()).filter((t) => t.length > 0).slice(0, 5)
  : [];

// 1. Tag the note in place (once-guarded, keyed by the canonical path).
if (tags.length > 0) {
  await orchestration.once("tag:" + notePath, async () => {
    await orchestration.callTool("manage_tags", { path: notePath, add: tags });
  });
}

// 2. Move the note (non-idempotent: a re-run would error "note not found"), so once()-guard it.
await orchestration.once("move:" + notePath, async () => {
  await orchestration.callTool("move_note", { path: notePath, new_path: destPath });
});

// 3. The router started this task; close it here on the way back (router owns lifecycle).
await orchestration.tasks.close(task.key);

return orchestration.emit("queue.advance", JSON.stringify({ filed: destPath }));
\`\`\`
`;

/**
 * The read-only proposer persona. Its <notor_tool_config> grants ONLY read tools +
 * emit_event and explicitly disables every write tool — so the persona physically
 * cannot mutate a note. This is the per-persona tool-gating the flow showcases.
 */
const PERSONA_SYSTEM_PROMPT = `---
notor-persona-prompt-mode: append
notor-persona-chip-emoji: 📥
---

You are a read-only inbox triager. You analyze notes and propose where they should
go, but you never modify anything. You only ever read and emit a proposal event.

<notor_tool_config>
read_note:
  enabled: true
  auto_approve: true
search_vault:
  enabled: true
  auto_approve: true
list_vault:
  enabled: true
  auto_approve: true
emit_event:
  enabled: true
  auto_approve: true
write_note:
  enabled: false
replace_in_note:
  enabled: false
update_frontmatter:
  enabled: false
manage_tags:
  enabled: false
move_note:
  enabled: false
delete_note:
  enabled: false
execute_command:
  enabled: false
</notor_tool_config>
`;

const FLOW_TIMEOUT_MS = 300_000;
const POLL_MS = 2_000;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function setupFlowFixtures(vaultPath: string): void {
	writeCleanWorkspace(vaultPath);

	// Flow + steps.
	const stepsDir = path.join(vaultPath, FLOW_DIR, "steps");
	fs.mkdirSync(stepsDir, { recursive: true });
	fs.writeFileSync(path.join(vaultPath, FLOW_DIR, "definition.md"), DEFINITION_MD);
	fs.writeFileSync(path.join(stepsDir, "list.md"), LIST_MD);
	fs.writeFileSync(path.join(stepsDir, "router.md"), ROUTER_MD);
	fs.writeFileSync(path.join(stepsDir, "triage.md"), TRIAGE_MD);
	fs.writeFileSync(path.join(stepsDir, "apply.md"), APPLY_MD);

	// Read-only proposer persona.
	const personaDir = path.join(vaultPath, PERSONA_DIR);
	fs.mkdirSync(personaDir, { recursive: true });
	fs.writeFileSync(path.join(personaDir, "system-prompt.md"), PERSONA_SYSTEM_PROMPT);

	// Seed inbox notes.
	const inboxDir = path.join(vaultPath, INBOX_FOLDER);
	fs.mkdirSync(inboxDir, { recursive: true });
	for (const [name, content] of Object.entries(INBOX_NOTES)) {
		fs.writeFileSync(path.join(inboxDir, name), content);
	}
}

interface SessionInfo {
	id: string;
	dir: string;
	meta: Record<string, unknown>;
	log: string;
}

function sessionsDir(vaultPath: string): string {
	return path.join(vaultPath, NOTOR_DIR, "orchestrations", "sessions");
}

function readFlowSession(vaultPath: string): SessionInfo | null {
	const dir = sessionsDir(vaultPath);
	if (!fs.existsSync(dir)) return null;
	const matching = fs
		.readdirSync(dir)
		.filter((d) => fs.statSync(path.join(dir, d)).isDirectory())
		.map((id) => {
			const sdir = path.join(dir, id);
			const metaPath = path.join(sdir, "session.json");
			const logPath = path.join(sdir, "session-log.jsonl");
			return {
				id,
				dir: sdir,
				meta: fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {},
				log: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "",
			};
		})
		.filter((s) => s.meta.flow_name === FLOW_NAME);
	if (matching.length === 0) return null;
	matching.sort(
		(a, b) =>
			fs.statSync(path.join(b.dir, "session.json")).mtimeMs -
			fs.statSync(path.join(a.dir, "session.json")).mtimeMs,
	);
	return matching[0]!;
}

async function waitForFlowTerminal(ctx: TestContext): Promise<SessionInfo | null> {
	const start = Date.now();
	while (Date.now() - start < FLOW_TIMEOUT_MS) {
		await ctx.page.waitForTimeout(POLL_MS);
		const s = readFlowSession(ctx.vaultPath);
		const status = s?.meta?.status;
		if (status === "completed" || status === "cancelled" || status === "error") return s;
		const elapsed = Math.round((Date.now() - start) / 1000);
		console.log(`    [${elapsed}s] session status: ${String(status ?? "(none yet)")}`);
	}
	return readFlowSession(ctx.vaultPath);
}

async function launchFlow(ctx: TestContext, flowName: string, objective: string): Promise<boolean> {
	const { page } = ctx;
	await page.evaluate(() => {
		(window as any).app?.commands?.executeCommandById?.("notor:run-orchestration");
	});
	await page.waitForTimeout(1000);

	await page.evaluate((name) => {
		const input = document.querySelector(".prompt-input") as HTMLInputElement | null;
		if (input) {
			input.value = name;
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
	}, flowName);
	await page.waitForTimeout(500);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(800);

	const objectiveEl = await page.$(".notor-orchestration-objective-input");
	if (!objectiveEl) return false;
	await page.evaluate((text) => {
		const ta = document.querySelector(".notor-orchestration-objective-input") as HTMLTextAreaElement | null;
		if (ta) {
			ta.value = text;
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		}
	}, objective);
	await page.waitForTimeout(300);
	const mod = process.platform === "darwin" ? "Meta" : "Control";
	await page.keyboard.down(mod);
	await page.keyboard.press("Enter");
	await page.keyboard.up(mod);
	return true;
}

/** Count markdown files directly under a vault folder. */
function countMarkdown(vaultPath: string, folder: string): number {
	const dir = path.join(vaultPath, folder);
	if (!fs.existsSync(dir)) return 0;
	return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length;
}

/** Count markdown files recursively under a vault folder. */
function countMarkdownRecursive(vaultPath: string, folder: string): number {
	const dir = path.join(vaultPath, folder);
	if (!fs.existsSync(dir)) return 0;
	let n = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) n += countMarkdownRecursive(vaultPath, path.join(folder, entry.name));
		else if (entry.name.endsWith(".md")) n++;
	}
	return n;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testFlowCompletes(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: list → (router → triage → apply)* runs to FLOW_COMPLETE");
	const { page } = ctx;

	const enabled = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return plugin?.settings?.orchestration_enabled === true;
	});
	if (!enabled) {
		ctx.fail("orchestration enabled", "orchestration_enabled is not true at runtime");
		return;
	}

	const launched = await launchFlow(ctx, FLOW_NAME, "Triage and file the inbox notes.");
	if (!launched) {
		ctx.fail("flow launched", "objective modal did not appear after selecting the flow");
		return;
	}
	const shot = await ctx.screenshot("01-flow-launched");

	const session = await waitForFlowTerminal(ctx);
	if (!session) {
		ctx.fail("session created", "no Inbox Triage E2E session reached a terminal status");
		return;
	}

	if (session.meta.status === "completed") {
		ctx.pass("flow completed", `session.json status is 'completed' (id ${session.id})`, shot);
	} else {
		ctx.fail(
			"flow completed",
			`session.json status is '${String(session.meta.status)}' (expected 'completed')`,
			shot,
		);
	}
}

async function testTasksClosed(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: every task closed at completion (INT-003)");
	const session = readFlowSession(ctx.vaultPath);
	if (!session) {
		ctx.fail("tasks closed", "no session found");
		return;
	}
	const tasksDir = path.join(session.dir, "tasks");
	const taskFiles = fs.existsSync(tasksDir)
		? fs.readdirSync(tasksDir).filter((f) => f.endsWith(".md"))
		: [];
	const statuses = taskFiles.map((f) => {
		const content = fs.readFileSync(path.join(tasksDir, f), "utf8");
		const m = content.match(/notor-task-status:\s*(\w+)/);
		return m?.[1] ?? "unknown";
	});

	if (taskFiles.length >= 1 && statuses.every((s) => s === "closed")) {
		ctx.pass("tasks closed", `${taskFiles.length} task(s) all closed at completion`);
	} else if (taskFiles.length === 0) {
		ctx.fail("tasks closed", "no task notes were created — the list step did not seed the registry");
	} else {
		ctx.fail("tasks closed", `task statuses: [${statuses.join(", ")}] (expected all 'closed')`);
	}
}

async function testNotesFiled(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Inbox drained and notes filed under Filed/ (code-owned moves)");
	const seedCount = Object.keys(INBOX_NOTES).length;
	const remainingInbox = countMarkdown(ctx.vaultPath, INBOX_FOLDER);
	const filed = countMarkdownRecursive(ctx.vaultPath, FILED_FOLDER);

	if (remainingInbox === 0 && filed >= seedCount) {
		ctx.pass(
			"notes filed",
			`Inbox/ drained (0 left); ${filed} note(s) under ${FILED_FOLDER}/ (seed was ${seedCount})`,
		);
	} else {
		ctx.fail(
			"notes filed",
			`Inbox/ has ${remainingInbox} left, ${filed} filed (expected 0 left, >=${seedCount} filed)`,
		);
	}
}

async function testStepConversationsHidden(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: step conversations hidden from the flat list (INT-006)");
	const { page } = ctx;
	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const hm = plugin?.getHistoryManager?.();
		if (!hm) return { error: "no history manager" };
		const entries = await hm.listConversations();
		return {
			count: entries.length,
			anyStepConvVisible: entries.some(
				(e: any) =>
					(e.title ?? "").includes("[Inbox Triage E2E]") ||
					(e.filename ?? "").includes("orchestration_step_"),
			),
		};
	});

	if ("error" in result) {
		ctx.fail("step conversations hidden", `could not read conversation list: ${result.error}`);
		return;
	}
	if (result.anyStepConvVisible) {
		ctx.fail("step conversations hidden", "an orchestration step conversation appeared in listConversations()");
	} else {
		ctx.pass(
			"step conversations hidden",
			`${result.count} listed conversation(s); no orchestration step conversation among them`,
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // plugin init + Bedrock provider registration
	await waitForSelector(page, ".notor-chat-container", 8000);

	await testFlowCompletes(ctx);
	await testTasksClosed(ctx);
	await testNotesFiled(ctx);
	await testStepConversationsHidden(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	orchestration_enabled: true,
	// Act mode so the code steps' manage_tags/move_note and the proposer's read tools
	// + emit_event are allowed; auto-approve so the loop stays unattended. (The proposer
	// persona's own <notor_tool_config> still withholds all write tools from the LLM.)
	mode: "act",
	auto_approve: {
		emit_event: true,
		read_note: true,
		search_vault: true,
		list_vault: true,
		manage_tags: true,
		move_note: true,
		orchestration_task_ensure: true,
		orchestration_task_start: true,
		orchestration_task_close: true,
		orchestration_task_list: true,
	},
});

runTest(
	{
		name: "orchestration-inbox-triage",
		settings,
		setupVault: setupFlowFixtures,
		cleanupFiles: [FLOW_DIR, PERSONA_DIR, INBOX_FOLDER, FILED_FOLDER],
	},
	tests,
);
