#!/usr/bin/env npx tsx
/**
 * Persona auto-approve flow E2E Test
 *
 * A scripted mock OpenAI-compatible server emits exact tool calls, so the
 * only variable is whether the chat panel's persona `<notor_tool_config>`
 * reaches the dispatch policy. Global settings keep `write_note` and
 * `read_notor_settings` prompting; each persona that auto-approves them must
 * run them without an approval card.
 *
 * Scenarios:
 *   1. Startup restore: `active_persona` in settings → the label and the
 *      panel's session persona agree, and a write auto-approves.
 *   2. Baseline: no persona → the write prompts (rejected; no file).
 *   3. Picker: picking the auto-approve persona → the write runs unprompted.
 *   4. Persona edit after pick: a prompting persona is picked, its file gains
 *      `auto_approve: true`, and the next write runs unprompted.
 *   5. Reopen: the scenario-3 conversation reopened from history keeps the
 *      persona and still auto-approves.
 *   6. Built-in persona: notor-help auto-approves read_notor_settings.
 *   7. No unexpected plugin errors.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	ensureCleanState,
	getPersonaChip,
	newConversation,
	selectPersona,
	sendMessageNoWait,
	waitForResponse,
	waitForResponseOrPlanReview,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants + fixtures
// ---------------------------------------------------------------------------

const MOCK_PORT = 18_743;
const MOCK_MODEL = "mock-model";
const FINAL_TEXT = "MOCK-DONE";

const PERSONAS_DIR = "notor/personas";
const AUTO_PERSONA = "e2e-autowrite";
const PROMPT_PERSONA = "e2e-promptwrite";
const OUT_DIR = "persona-auto-approve-out";

function personaFile(name: string): string {
	return `${PERSONAS_DIR}/${name}/system-prompt.md`;
}

function personaBody(writeNoteYaml: string): string {
	return `---
notor-persona-prompt-mode: append
---

You write notes for the e2e test.

<notor_tool_config>
write_note:
${writeNoteYaml}
</notor_tool_config>
`;
}

const AUTO_BODY = personaBody("  enabled: true\n  auto_approve: true");
const PROMPT_BODY = personaBody("  enabled: true");

// ---------------------------------------------------------------------------
// Scripted mock server
//
// "#call:<tool>:<json-args>" in the last user message → that tool call.
// Any request whose last message is a tool result gets FINAL_TEXT.
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const CALL_MARKER = /#call:(\w+):(\{[^\n]*\})/;

type OpenAiMessage = {
	role: string;
	content?: string | Array<{ type: string; text?: string }> | null;
};

/** Text of the tool result in every follow-up request, in order. */
const toolResults: string[] = [];
let callCounter = 0;

function messageText(m: OpenAiMessage | undefined): string {
	if (!m?.content) return "";
	if (typeof m.content === "string") return m.content;
	return m.content.map((p) => p.text ?? "").join("\n");
}

function sse(res: http.ServerResponse, payload: unknown): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function finish(res: http.ServerResponse, reason: "stop" | "tool_calls"): void {
	sse(res, { choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
	res.write("data: [DONE]\n\n");
	res.end();
}

function startMockServer(): http.Server {
	const srv = http.createServer((req, res) => {
		if (req.method === "OPTIONS") {
			res.writeHead(204, CORS_HEADERS);
			res.end();
			return;
		}
		if (req.url?.endsWith("/models")) {
			res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: MOCK_MODEL, object: "model" }] }));
			return;
		}
		if (!req.url?.endsWith("/chat/completions")) {
			res.writeHead(404, CORS_HEADERS);
			res.end();
			return;
		}

		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const messages = (JSON.parse(body) as { messages?: OpenAiMessage[] }).messages ?? [];
			const last = messages[messages.length - 1];
			res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });

			const call = last?.role === "user" ? CALL_MARKER.exec(messageText(last)) : null;
			if (call) {
				callCounter++;
				sse(res, {
					choices: [{
						index: 0,
						delta: {
							tool_calls: [{
								index: 0,
								id: `call_${callCounter}`,
								type: "function",
								function: { name: call[1], arguments: call[2] },
							}],
						},
					}],
				});
				finish(res, "tool_calls");
				return;
			}

			if (last?.role === "tool") toolResults.push(messageText(last));
			sse(res, { choices: [{ index: 0, delta: { content: FINAL_TEXT } }] });
			finish(res, "stop");
		});
	});
	srv.listen(MOCK_PORT, "127.0.0.1");
	return srv;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface TurnOutcome {
	/** Whether an approval button (inline or diff) was ever rendered this turn. */
	approvalSeen: boolean;
	/** Whether the turn reached an idle panel (after rejecting any prompt). */
	finished: boolean;
}

/**
 * Send `message`, recording whether any `.notor-approve-btn` appears. A
 * pending prompt is rejected so the turn can finish and the vault stays clean.
 */
async function sendAndObserve(ctx: TestContext, message: string): Promise<TurnOutcome> {
	await ctx.page.evaluate(`(() => {
		window.__e2eApprovalObserver?.disconnect();
		window.__e2eApprovalSeen = false;
		const obs = new MutationObserver(() => {
			if (document.querySelector(".notor-approve-btn")) window.__e2eApprovalSeen = true;
		});
		obs.observe(document.body, { childList: true, subtree: true });
		window.__e2eApprovalObserver = obs;
	})()`);

	await sendMessageNoWait(ctx.page, message);
	const outcome = await waitForResponseOrPlanReview(ctx.page, 30_000, 500);
	let finished = outcome === "done";
	if (outcome === "approval") {
		await ctx.page.evaluate(() => {
			const btns = document.querySelectorAll(".notor-reject-btn");
			(btns[btns.length - 1] as HTMLButtonElement | undefined)?.click();
		});
		finished = await waitForResponse(ctx.page, 30_000, 500);
	}

	const approvalSeen = await ctx.page.evaluate(`(() => {
		window.__e2eApprovalObserver?.disconnect();
		return window.__e2eApprovalSeen === true;
	})()`) as boolean;
	return { approvalSeen, finished };
}

function writeCall(notePath: string): string {
	return `Please #call:write_note:${JSON.stringify({ path: notePath, content: `# ${notePath}\n` })}`;
}

function noteExists(ctx: TestContext, notePath: string): boolean {
	return fs.existsSync(path.join(ctx.vaultPath, notePath));
}

/** The persona the panel's sessions will pin (not just what the label shows). */
async function panelPersonaName(ctx: TestContext): Promise<string | null> {
	return ctx.page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return plugin?.getActiveOrchestrator?.()?.getActivePersona?.()?.name ?? null;
	});
}

async function activeConversationId(ctx: TestContext): Promise<string | null> {
	return ctx.page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return plugin?.getActiveOrchestrator?.()?.getConversationManager?.()?.getActiveConversation?.()?.id ?? null;
	});
}

/** Expect the write in `outcome` to have auto-approved and created `notePath`. */
function expectAutoApproved(ctx: TestContext, label: string, outcome: TurnOutcome, notePath: string, shot: string): void {
	if (!outcome.finished) {
		ctx.fail(`${label}: turn finished`, "panel never went idle", shot);
		return;
	}
	if (!outcome.approvalSeen) ctx.pass(`${label}: no approval prompt`, "no .notor-approve-btn rendered", shot);
	else ctx.fail(`${label}: no approval prompt`, "an approval prompt appeared", shot);

	if (noteExists(ctx, notePath)) ctx.pass(`${label}: note written`, notePath);
	else ctx.fail(`${label}: note written`, `${notePath} missing; last tool result: ${toolResults[toolResults.length - 1] ?? "(none)"}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testStartupRestore(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: The persona restored at startup applies to the first turn");
	await ensureCleanState(ctx.page);

	const chip = await getPersonaChip(ctx.page);
	const panel = await panelPersonaName(ctx);
	const global = await ctx.page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return {
			setting: plugin?.settings?.active_persona ?? null,
			manager: plugin?.getPersonaManager?.()?.getActivePersona?.()?.name ?? null,
		};
	});
	const detail = `label "${chip?.text ?? "(none)"}", session ${panel ?? "null"}, ` +
		`settings.active_persona "${global.setting}", manager ${global.manager ?? "null"}`;
	if (chip?.text.endsWith(AUTO_PERSONA) && panel === AUTO_PERSONA) {
		ctx.pass("Label and session persona agree", detail);
	} else {
		ctx.fail("Label and session persona agree", detail);
	}

	const note = `${OUT_DIR}/startup.md`;
	const outcome = await sendAndObserve(ctx, writeCall(note));
	expectAutoApproved(ctx, "Startup persona", outcome, note, await ctx.screenshot("startup-restore"));
}

async function testBaselinePrompts(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: With no persona the write prompts");
	await ensureCleanState(ctx.page);
	await newConversation(ctx.page);
	if (!(await selectPersona(ctx.page, null))) {
		ctx.fail("Deselect persona", "persona menu unavailable");
		return;
	}

	const note = `${OUT_DIR}/baseline.md`;
	const outcome = await sendAndObserve(ctx, writeCall(note));
	const shot = await ctx.screenshot("baseline");
	if (outcome.approvalSeen) ctx.pass("Approval prompt shown", "write_note prompted", shot);
	else ctx.fail("Approval prompt shown", "no prompt — global write_note=false not applied", shot);

	if (!noteExists(ctx, note)) ctx.pass("Rejected write left no file", note);
	else ctx.fail("Rejected write left no file", `${note} exists`);
}

let pickerConversationId: string | null = null;

async function testPickerPersona(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: A persona picked in the panel auto-approves");
	await ensureCleanState(ctx.page);
	await newConversation(ctx.page);
	if (!(await selectPersona(ctx.page, AUTO_PERSONA))) {
		ctx.fail("Pick persona", `${AUTO_PERSONA} not in the persona menu`);
		return;
	}

	const note = `${OUT_DIR}/picker.md`;
	const outcome = await sendAndObserve(ctx, writeCall(note));
	expectAutoApproved(ctx, "Picked persona", outcome, note, await ctx.screenshot("picker"));
	pickerConversationId = await activeConversationId(ctx);
}

async function testPersonaEditAfterPick(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Editing the picked persona's tool config applies to the next turn");
	await ensureCleanState(ctx.page);
	await newConversation(ctx.page);
	if (!(await selectPersona(ctx.page, PROMPT_PERSONA))) {
		ctx.fail("Pick persona", `${PROMPT_PERSONA} not in the persona menu`);
		return;
	}

	const before = await sendAndObserve(ctx, writeCall(`${OUT_DIR}/edit-before.md`));
	if (before.approvalSeen) ctx.pass("Prompts before the edit", "write_note prompted");
	else ctx.fail("Prompts before the edit", "no prompt for a persona without auto_approve");

	const modified = await ctx.page.evaluate(async (args: { file: string; body: string }) => {
		const app = (window as any).app;
		const file = app?.vault?.getAbstractFileByPath?.(args.file);
		if (!file) return false;
		await app.vault.modify(file, args.body);
		return true;
	}, { file: personaFile(PROMPT_PERSONA), body: AUTO_BODY });
	if (!modified) {
		ctx.fail("Edit persona file", `${personaFile(PROMPT_PERSONA)} not found in vault`);
		return;
	}
	// Watcher debounce is 1s; allow for the metadata-cache event and rediscovery.
	await ctx.page.waitForTimeout(3_000);

	const note = `${OUT_DIR}/edit-after.md`;
	const after = await sendAndObserve(ctx, writeCall(note));
	expectAutoApproved(ctx, "Edited persona", after, note, await ctx.screenshot("persona-edit"));
}

async function testReopenConversation(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: A reopened conversation keeps its persona's auto-approve");
	await ensureCleanState(ctx.page);
	if (!pickerConversationId) {
		ctx.fail("Reopen conversation", "scenario 3 recorded no conversation id");
		return;
	}
	// Leave the panel on a different persona so the reopen has to restore it.
	await newConversation(ctx.page);
	if (!(await selectPersona(ctx.page, null))) {
		ctx.fail("Deselect persona", "persona menu unavailable");
		return;
	}

	const switched = await ctx.page.evaluate(async (id: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return (await plugin?.getActiveOrchestrator?.()?.switchToConversationById?.(id)) ?? false;
	}, pickerConversationId);
	await ctx.page.waitForTimeout(1_500);
	const panel = await panelPersonaName(ctx);
	if (switched && panel === AUTO_PERSONA) ctx.pass("Persona restored from header", panel);
	else ctx.fail("Persona restored from header", `switched=${switched}, session persona ${panel ?? "null"}`);

	const note = `${OUT_DIR}/reopen.md`;
	const outcome = await sendAndObserve(ctx, writeCall(note));
	expectAutoApproved(ctx, "Reopened conversation", outcome, note, await ctx.screenshot("reopen"));
}

async function testBuiltinPersona(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: notor-help auto-approves read_notor_settings");
	await ensureCleanState(ctx.page);
	await newConversation(ctx.page);
	if (!(await selectPersona(ctx.page, "notor-help"))) {
		ctx.fail("Pick persona", "notor-help not in the persona menu");
		return;
	}

	const resultsBefore = toolResults.length;
	const outcome = await sendAndObserve(ctx, "Please #call:read_notor_settings:{}");
	const shot = await ctx.screenshot("builtin-notor-help");
	if (!outcome.finished) {
		ctx.fail("Built-in persona: turn finished", "panel never went idle", shot);
		return;
	}
	if (!outcome.approvalSeen) ctx.pass("Built-in persona: no approval prompt", "read_notor_settings ran unprompted", shot);
	else ctx.fail("Built-in persona: no approval prompt", "read_notor_settings prompted", shot);

	const result = toolResults.slice(resultsBefore).join("\n");
	if (result.includes("notor_dir")) ctx.pass("Built-in persona: tool returned settings", result.slice(0, 120));
	else ctx.fail("Built-in persona: tool returned settings", result.slice(0, 300) || "(no tool result)");
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: No unexpected plugin errors");
	const errors = ctx.collector.getLogsByLevel("error");
	if (errors.length === 0) ctx.pass("No unexpected errors", "clean error log");
	else ctx.fail("No unexpected errors", JSON.stringify(errors.slice(0, 3)).slice(0, 600));
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const srv = startMockServer();
	try {
		await ctx.page.waitForTimeout(5_000);
		await testStartupRestore(ctx);
		await testBaselinePrompts(ctx);
		await testPickerPersona(ctx);
		await testPersonaEditAfterPick(ctx);
		await testReopenConversation(ctx);
		await testBuiltinPersona(ctx);
		await testNoUnexpectedErrors(ctx);
	} finally {
		srv.close();
	}
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	active_provider: "local",
	providers: [
		{ id: "local", type: "local", enabled: true, display_name: "Mock local", endpoint: `http://127.0.0.1:${MOCK_PORT}/v1`, model_id: MOCK_MODEL },
	],
	model_presets: [
		{ name: "tiny", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
		{ name: "small", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
		{ name: "medium", provider_id: "local", model_id: MOCK_MODEL, use_extended_context: false, thinking_level: null },
		{ name: "large", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
	],
	default_preset: "medium",
	model_context_overrides: { [MOCK_MODEL]: 128_000 },
	mode: "act",
	auto_approve: { write_note: false, read_notor_settings: false },
	active_persona: AUTO_PERSONA,
});

runTest(
	{
		name: "persona-auto-approve-flow",
		settings,
		setupVault: (vaultPath) => {
			for (const [name, body] of [[AUTO_PERSONA, AUTO_BODY], [PROMPT_PERSONA, PROMPT_BODY]] as const) {
				const file = path.join(vaultPath, personaFile(name));
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, body);
			}
			fs.rmSync(path.join(vaultPath, OUT_DIR), { recursive: true, force: true });
		},
		cleanupFiles: [`${PERSONAS_DIR}/${AUTO_PERSONA}`, `${PERSONAS_DIR}/${PROMPT_PERSONA}`, OUT_DIR],
	},
	tests,
);
