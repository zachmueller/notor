#!/usr/bin/env npx tsx
/**
 * Orchestration Zettelkasten Gardener E2E Test (example flow #6)
 *
 * A committed regression fixture for **vault-graph reasoning + a read-only proposer
 * + a critic gate before any mutation + a code step that owns all writes**. The flow:
 *
 *   scan   (CODE): builds the wikilink graph across the Garden/ folder and finds
 *     ORPHAN notes (no other note links to them), excluding the hub. Writes the
 *     structured findings to the scratchpad and forwards them as the event payload.
 *   propose(CONVERSATION, READ-ONLY persona — no write tools): proposes which orphans
 *     to surface by linking them from the hub. Emits a structured proposal.
 *   review (CONVERSATION, critic persona): GATES the proposal — approves the orphans
 *     worth surfacing. No mutation happens before this gate.
 *   apply  (CODE): authoritative + idempotent. For each APPROVED orphan that exists
 *     and is not already linked from the hub, appends a link to the hub note (full
 *     overwrite via write_note, once()-guarded, idempotent on re-run); FLOW_COMPLETE.
 *
 * The safety comes from "the proposer holds no write tools + a critic gates + a code
 * step makes exactly the approved changes" — not from trusting a restricted LLM.
 *
 * Infra invariants asserted (never the LLM's prose):
 *   1. Terminal `session.json` status `completed`.
 *   2. The scan + apply code steps ran without a `{step}.code_error`.
 *   3. The critic gate actually ran (a Review turn was logged) before completion.
 *   4. The orphan was surfaced — the hub note now links to the previously-orphan note.
 *
 * Prerequisites:
 *   - AWS profile `default` with Bedrock access (propose + review are real LLM turns).
 *
 * Run with:
 *   npx tsx e2e/scripts/orchestration-zettelkasten-test.ts
 *
 * @see specs/ZZ-misc/orchestration/contracts/orchestration-helper.md — scratchpad / callTool / once
 * @see ~/zm/ai/notor/ideas/Example orchestration flows to ship.md — flow #6
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector, writeCleanWorkspace } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants + flow fixtures
// ---------------------------------------------------------------------------

const NOTOR_DIR = "notor";
const FLOW_NAME = "Zettelkasten Gardener E2E";
const FLOW_DIR = `${NOTOR_DIR}/orchestrations/zettelkasten-e2e`;
const PROPOSER_DIR = `${NOTOR_DIR}/personas/zk-proposer-e2e`;
const CRITIC_DIR = `${NOTOR_DIR}/personas/zk-critic-e2e`;

const GARDEN_FOLDER = "Garden";
const HUB_PATH = `${GARDEN_FOLDER}/Index.md`;
const ORPHAN_BASENAME = "Beta"; // seeded orphan (nothing links to it)

/**
 * Seed: a hub that links to Alpha (so Alpha is not an orphan) and an orphan Beta
 * that nothing links to. The gardener should surface Beta by linking it from the hub.
 */
const SEED_NOTES: Record<string, string> = {
	"Index.md": "# Index\n\nThe map-of-content hub.\n\n## Notes\n\n- [[Alpha]]\n",
	"Alpha.md": "# Alpha\n\nLinked from the hub.\n",
	"Beta.md":
		"# Beta\n\nA substantive, well-developed note on the Beta concept that clearly " +
		"belongs in the knowledge base. It has real content worth surfacing on the hub, " +
		"but nothing links to it yet, leaving it orphaned.\n",
};

const DEFINITION_MD = `---
notor-type: orchestration-flow
notor-flow-name: "${FLOW_NAME}"
notor-flow-description: "Surface orphan notes via a read-only proposer + critic gate + code-owned writes (example #6)."
notor-starting-event: garden.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 12
notor-max-runtime-minutes: 12
notor-steps:
  - "[[scan]]"
  - "[[propose]]"
  - "[[review]]"
  - "[[apply]]"
notor-guardrails:
  - "Be terse. Only surface orphans that genuinely belong on the hub."
---

# Zettelkasten Gardener E2E

Documentation only — never injected into a step prompt.
`;

/**
 * scan — CODE. Builds the wikilink graph across Garden/ and finds orphans (notes no
 * other note links to), excluding the hub. Deterministic vault-graph reasoning.
 */
const SCAN_MD = `---
notor-type: orchestration-step
notor-step-name: "Scan"
notor-step-description: "Builds the link graph and finds orphan notes."
notor-step-mode: code
notor-step-triggers:
  - garden.start
notor-step-publishes:
  - scan.done
notor-step-default-publishes: scan.done
---

# Scan

\`\`\`typescript
const hubPath = "${HUB_PATH}";
const folder = app.vault.getAbstractFileByPath("${GARDEN_FOLDER}");
const notes = [];
if (folder && folder.children) {
  for (const child of folder.children) {
    if (child instanceof obsidian.TFile && child.extension === "md") notes.push(child);
  }
}

// Build the set of link TARGETS (basenames) referenced by ANY note in the folder.
const linkedTargets = new Set();
for (const note of notes) {
  const content = await app.vault.read(note);
  const re = /\\[\\[([^\\]]+)\\]\\]/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const target = match[1].split("|")[0].split("#")[0].trim().toLowerCase();
    if (target) linkedTargets.add(target);
  }
}

// An orphan = a note nothing links to, and that is not the hub itself.
const orphans = [];
for (const note of notes) {
  if (note.path === hubPath) continue;
  if (!linkedTargets.has(note.basename.toLowerCase())) {
    orphans.push({ path: note.path, basename: note.basename });
  }
}
orphans.sort((a, b) => a.basename.localeCompare(b.basename));

const findings = { hub: hubPath, orphans };
await orchestration.scratchpad.write("findings.json", JSON.stringify(findings, null, 2));
return orchestration.emit("scan.done", JSON.stringify(findings));
\`\`\`
`;

/**
 * propose — CONVERSATION, READ-ONLY proposer persona. Proposes which orphans to
 * surface. Holds NO write tools (enforced by its <notor_tool_config>).
 */
const PROPOSE_MD = `---
notor-type: orchestration-step
notor-step-name: "Propose"
notor-step-description: "Read-only proposer: which orphans to surface on the hub."
notor-step-persona: zk-proposer-e2e
notor-step-triggers:
  - scan.done
notor-step-publishes:
  - propose.done
notor-step-default-publishes: propose.done
---

You are the Propose step — a READ-ONLY zettelkasten gardener. The incoming event
payload is a JSON object with a "hub" path and an "orphans" array (each has a
"basename"). Do EXACTLY this, then stop:

1. For each orphan, decide whether it deserves to be surfaced on the hub (a real,
   substantive note generally does).
2. Call \`emit_event\` with topic "propose.done" and payload a JSON object:
   {"surface":["<orphan basename>", ...]}

Emit raw JSON only — no prose, no fences. You have NO write tools; you only propose.
`;

/**
 * review — CONVERSATION, critic persona. Gates the proposal before any mutation.
 */
const REVIEW_MD = `---
notor-type: orchestration-step
notor-step-name: "Review"
notor-step-description: "Critic gate: approves the orphans worth surfacing."
notor-step-persona: zk-critic-e2e
notor-step-triggers:
  - propose.done
notor-step-publishes:
  - review.done
notor-step-default-publishes: review.done
---

You are the Review step — a critic gating changes to the vault graph. The incoming
event payload is a JSON object {"surface":[...]} listing orphan basenames the proposer
wants to surface on the hub. Do EXACTLY this, then stop:

1. A note deserves a hub link unless it is clearly empty, a stub, or junk. Default to
   APPROVING a proposed orphan that names a real, substantive note.
2. Call \`emit_event\` with topic "review.done" and payload a JSON object listing the
   approved basenames:
   {"approved":["<orphan basename>", ...]}

Emit raw JSON only — no prose, no fences. Approve every orphan that is a genuine note;
only withhold approval for an obviously empty or junk note.
`;

/**
 * apply — CODE. Authoritative + idempotent. Appends a hub link for each APPROVED
 * orphan that exists and is not already linked. Full overwrite (re-run safe),
 * once()-guarded. The code owns the write; the LLMs only proposed/approved.
 */
const APPLY_MD = `---
notor-type: orchestration-step
notor-step-name: "Apply"
notor-step-description: "Code owns the writes; surfaces approved orphans on the hub."
notor-step-mode: code
notor-step-triggers:
  - review.done
notor-step-publishes:
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

# Apply

\`\`\`typescript
const findingsRaw = (await orchestration.scratchpad.read("findings.json")) || "{}";
let findings = {};
try { findings = JSON.parse(findingsRaw); } catch (_e) { findings = {}; }
const hubPath = findings.hub;
const orphans = Array.isArray(findings.orphans) ? findings.orphans : [];

// Parse the critic's approved list (tolerant of stray prose/fences).
let approved = [];
const raw = (event.payload || "").trim();
function parseApproved(text) {
  try {
    const o = JSON.parse(text);
    if (o && Array.isArray(o.approved)) return o.approved.map((s) => String(s));
  } catch (_e) { /* fall through */ }
  return null;
}
approved = parseApproved(raw);
if (approved === null) {
  const open = raw.indexOf("{"), close = raw.lastIndexOf("}");
  if (open !== -1 && close > open) approved = parseApproved(raw.slice(open, close + 1));
}
if (approved === null) approved = [];
const approvedSet = new Set(approved.map((s) => s.toLowerCase()));

if (!hubPath) {
  throw new Error("Apply: scan findings missing 'hub' path");
}

// Resolve + read the hub note (authoritative — code owns the write).
const hubFile = utils.resolveNote(hubPath);
if (!hubFile) throw new Error("Apply: hub note not found: " + hubPath);
let hubContent = await app.vault.read(hubFile);

// Append a link for each approved orphan that exists and is not already linked.
// IDEMPOTENT: skip any link already present, so a recovery re-run never duplicates.
const existing = new Set(app.vault.getMarkdownFiles().map((f) => f.basename.toLowerCase()));
const surfaced = [];
for (const o of orphans) {
  const name = o.basename;
  if (!approvedSet.has(String(name).toLowerCase())) continue;
  if (!existing.has(String(name).toLowerCase())) continue;
  const linkText = "[[" + name + "]]";
  if (hubContent.includes(linkText)) continue; // already linked — idempotent skip
  hubContent = hubContent.replace(/\\s*$/, "") + "\\n- " + linkText + "\\n";
  surfaced.push(name);
}

if (surfaced.length > 0) {
  await orchestration.once("surface:" + surfaced.join(","), async () => {
    await orchestration.callTool("write_note", { path: hubPath, content: hubContent });
  });
}

return orchestration.emit("FLOW_COMPLETE", "Surfaced " + surfaced.length + " orphan(s) on the hub.");
\`\`\`
`;

/** Read-only proposer persona: read tools + emit_event only; every write tool disabled. */
const PROPOSER_PROMPT = `---
notor-persona-prompt-mode: append
notor-persona-chip-emoji: 🌱
---

You are a read-only zettelkasten gardener. You analyze the vault graph and propose
improvements, but you never modify anything.

<notor_tool_config>
read_note:
  enabled: true
  auto_approve: true
search_vault:
  enabled: true
  auto_approve: true
get_backlinks:
  enabled: true
  auto_approve: true
get_outlinks:
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
</notor_tool_config>
`;

/** Critic persona: read tools + emit_event; also no write tools (it only gates). */
const CRITIC_PROMPT = `---
notor-persona-prompt-mode: append
notor-persona-chip-emoji: 🧐
---

You are a careful critic who gates changes to the vault graph before they are applied.
You read and judge; you never modify anything yourself.

<notor_tool_config>
read_note:
  enabled: true
  auto_approve: true
get_backlinks:
  enabled: true
  auto_approve: true
emit_event:
  enabled: true
  auto_approve: true
write_note:
  enabled: false
replace_in_note:
  enabled: false
manage_tags:
  enabled: false
move_note:
  enabled: false
delete_note:
  enabled: false
</notor_tool_config>
`;

const FLOW_TIMEOUT_MS = 240_000;
const POLL_MS = 2_000;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function setupFlowFixtures(vaultPath: string): void {
	writeCleanWorkspace(vaultPath);

	const stepsDir = path.join(vaultPath, FLOW_DIR, "steps");
	fs.mkdirSync(stepsDir, { recursive: true });
	fs.writeFileSync(path.join(vaultPath, FLOW_DIR, "definition.md"), DEFINITION_MD);
	fs.writeFileSync(path.join(stepsDir, "scan.md"), SCAN_MD);
	fs.writeFileSync(path.join(stepsDir, "propose.md"), PROPOSE_MD);
	fs.writeFileSync(path.join(stepsDir, "review.md"), REVIEW_MD);
	fs.writeFileSync(path.join(stepsDir, "apply.md"), APPLY_MD);

	const proposerDir = path.join(vaultPath, PROPOSER_DIR);
	const criticDir = path.join(vaultPath, CRITIC_DIR);
	fs.mkdirSync(proposerDir, { recursive: true });
	fs.mkdirSync(criticDir, { recursive: true });
	fs.writeFileSync(path.join(proposerDir, "system-prompt.md"), PROPOSER_PROMPT);
	fs.writeFileSync(path.join(criticDir, "system-prompt.md"), CRITIC_PROMPT);

	const gardenDir = path.join(vaultPath, GARDEN_FOLDER);
	fs.mkdirSync(gardenDir, { recursive: true });
	for (const [name, content] of Object.entries(SEED_NOTES)) {
		fs.writeFileSync(path.join(gardenDir, name), content);
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

function parseLog(log: string): Array<Record<string, unknown>> {
	return log
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => {
			try {
				return JSON.parse(l) as Record<string, unknown>;
			} catch {
				return {} as Record<string, unknown>;
			}
		});
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testFlowCompletes(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: scan → propose → review → apply runs to FLOW_COMPLETE");
	const { page } = ctx;

	const enabled = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return plugin?.settings?.orchestration_enabled === true;
	});
	if (!enabled) {
		ctx.fail("orchestration enabled", "orchestration_enabled is not true at runtime");
		return;
	}

	const launched = await launchFlow(ctx, FLOW_NAME, "Tend the Garden: surface orphan notes on the hub.");
	if (!launched) {
		ctx.fail("flow launched", "objective modal did not appear after selecting the flow");
		return;
	}
	const shot = await ctx.screenshot("01-flow-launched");

	const session = await waitForFlowTerminal(ctx);
	if (!session) {
		ctx.fail("session created", "no Zettelkasten Gardener E2E session reached a terminal status");
		return;
	}
	if (session.meta.status === "completed") {
		ctx.pass("flow completed", `session.json status is 'completed' (id ${session.id})`, shot);
	} else {
		ctx.fail("flow completed", `session.json status is '${String(session.meta.status)}' (expected 'completed')`, shot);
	}
}

async function testCodeStepsClean(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: the scan + apply code steps ran without a code_error");
	const session = readFlowSession(ctx.vaultPath);
	if (!session) {
		ctx.fail("code steps clean", "no session found");
		return;
	}
	if (session.log.includes(".code_error")) {
		ctx.fail("code steps clean", "session-log contains a `{step}.code_error` emission");
	} else {
		ctx.pass("code steps clean", "no `{step}.code_error` emission in the session log");
	}
}

async function testCriticGateRan(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: the critic gate ran before completion");
	const session = readFlowSession(ctx.vaultPath);
	if (!session) {
		ctx.fail("critic gate", "no session found");
		return;
	}
	const entries = parseLog(session.log);
	const reviewRan = entries.some((e) => e.type === "turn.complete" && e.step === "Review");
	if (reviewRan) {
		ctx.pass("critic gate", "a Review (critic) turn was logged before the flow completed");
	} else {
		ctx.fail("critic gate", "no Review turn was logged — the critic gate did not run");
	}
}

async function testOrphanSurfaced(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: the orphan was surfaced on the hub (code-owned write)");
	const hubFull = path.join(ctx.vaultPath, HUB_PATH);
	if (!fs.existsSync(hubFull)) {
		ctx.fail("orphan surfaced", `hub note not found at ${HUB_PATH}`);
		return;
	}
	const hub = fs.readFileSync(hubFull, "utf8");
	if (hub.includes("[[" + ORPHAN_BASENAME + "]]")) {
		ctx.pass("orphan surfaced", `the hub now links to the previously-orphan note [[${ORPHAN_BASENAME}]]`);
	} else {
		ctx.fail("orphan surfaced", `the hub does not link to [[${ORPHAN_BASENAME}]] after the run`);
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
	await testCodeStepsClean(ctx);
	await testCriticGateRan(ctx);
	await testOrphanSurfaced(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	orchestration_enabled: true,
	mode: "act",
	auto_approve: {
		emit_event: true,
		read_note: true,
		search_vault: true,
		get_backlinks: true,
		get_outlinks: true,
		write_note: true,
	},
});

runTest(
	{
		name: "orchestration-zettelkasten",
		settings,
		setupVault: setupFlowFixtures,
		cleanupFiles: [FLOW_DIR, PROPOSER_DIR, CRITIC_DIR, GARDEN_FOLDER],
	},
	tests,
);
