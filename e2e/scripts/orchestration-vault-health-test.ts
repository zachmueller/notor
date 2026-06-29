#!/usr/bin/env npx tsx
/**
 * Orchestration Vault Health Monitor E2E Test (example flow #14)
 *
 * A committed regression fixture for the full **"code finds → LLM decides → code
 * fixes"** arc — deterministic detection + LLM judgment + deterministic, guarded
 * remediation, with a human-reviewable report for anything ambiguous. The flow:
 *
 *   detect (CODE): scans the seed folder for broken wikilinks (a `[[Target]]` whose
 *     basename matches no note), and for each computes the closest existing note by
 *     edit distance as a *suggested* fix. Writes the findings to the scratchpad.
 *   propose (CONVERSATION): reads the findings and emits a simple APPROVE/REJECT
 *     judgment per suggested fix (the LLM decides which auto-fixes are safe).
 *   apply-safe (CODE): for each APPROVED fix whose suggested target actually exists,
 *     rewrites the broken link via `replace_in_note` (once()-guarded so a recovery
 *     re-run never re-errors); always writes a health-report note; FLOW_COMPLETE.
 *
 * Scope note: a full #14 also detects stale notes + malformed frontmatter. This
 * fixture focuses on broken wikilinks — the clearest "objective truth" detection —
 * to keep the regression deterministic; the other detectors are the same shape.
 *
 * Infra invariants asserted (never the LLM's prose):
 *   1. Terminal `session.json` status `completed`.
 *   2. The detect + apply code steps ran without a `{step}.code_error`.
 *   3. A health-report note was written and records the detected broken link
 *      (the deterministic detect → report path).
 *   4. The broken link was repaired in the source note — it now points at the real
 *      target and the typo'd link is gone (the code-owned safe fix committed).
 *
 * Prerequisites:
 *   - AWS profile `default` with Bedrock access (the `propose` step is a real LLM turn).
 *
 * Run with:
 *   npx tsx e2e/scripts/orchestration-vault-health-test.ts
 *
 * @see specs/ZZ-misc/orchestration/contracts/orchestration-helper.md — callTool / once / scratchpad
 * @see ~/zm/ai/notor/ideas/Example orchestration flows to ship.md — flow #14
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector, writeCleanWorkspace } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants + flow fixtures
// ---------------------------------------------------------------------------

const NOTOR_DIR = "notor";
const FLOW_NAME = "Vault Health Monitor E2E";
const FLOW_DIR = `${NOTOR_DIR}/orchestrations/vault-health-e2e`;

const HEALTH_FOLDER = "Health"; // scanned folder + where the report is written
const REPORT_PATH = `${HEALTH_FOLDER}/health-report.md`;
const BROKEN_LINK_TEXT = "[[Meting Notes]]"; // the seeded typo (missing 'e')
const FIX_TARGET = "Meeting Notes"; // the real note it should point at

/** Seed notes: a real target + a note carrying one broken wikilink to a near-match. */
const SEED_NOTES: Record<string, string> = {
	"Meeting Notes.md": "# Meeting Notes\n\nThe canonical meeting notes hub.\n",
	"Daily Log.md":
		"# Daily Log\n\nToday I reviewed " + BROKEN_LINK_TEXT + " before the standup.\n",
};

const DEFINITION_MD = `---
notor-type: orchestration-flow
notor-flow-name: "${FLOW_NAME}"
notor-flow-description: "Detect broken wikilinks, let the LLM approve fixes, apply the safe ones (example #14)."
notor-starting-event: health.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 10
notor-max-runtime-minutes: 10
notor-steps:
  - "[[detect]]"
  - "[[propose]]"
  - "[[apply-safe]]"
notor-guardrails:
  - "Be terse. Only approve a fix when the suggested target is clearly correct."
---

# Vault Health Monitor E2E

Documentation only — never injected into a step prompt.
`;

/**
 * detect — CODE. Deterministically finds broken wikilinks in the Health/ folder and
 * computes the closest existing note (edit distance) as a suggested fix. Writes the
 * structured findings to the scratchpad for the proposer + applier to consume.
 */
const DETECT_MD = `---
notor-type: orchestration-step
notor-step-name: "Detect"
notor-step-description: "Scans for broken wikilinks and suggests fixes."
notor-step-mode: code
notor-step-triggers:
  - health.start
notor-step-publishes:
  - detect.done
notor-step-default-publishes: detect.done
---

# Detect

\`\`\`typescript
// Levenshtein distance (small inputs — note basenames).
function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

// All existing note basenames (the universe a wikilink can resolve to).
const allFiles = app.vault.getMarkdownFiles();
const basenames = allFiles.map((f) => f.basename);
const basenameSet = new Set(basenames.map((b) => b.toLowerCase()));

// Scan the Health/ folder's notes for [[wikilinks]].
const folder = app.vault.getAbstractFileByPath("${HEALTH_FOLDER}");
const findings = [];
if (folder && folder.children) {
  for (const child of folder.children) {
    if (!(child instanceof obsidian.TFile) || child.extension !== "md") continue;
    const content = await app.vault.read(child);
    const re = /\\[\\[([^\\]]+)\\]\\]/g;
    let match;
    while ((match = re.exec(content)) !== null) {
      // Strip alias (|) and heading (#) parts to get the link target's note name.
      const target = match[1].split("|")[0].split("#")[0].trim();
      if (!target) continue;
      if (basenameSet.has(target.toLowerCase())) continue; // resolves — not broken

      // Suggest the closest existing basename within a small edit-distance threshold.
      let best = null, bestD = Infinity;
      for (const b of basenames) {
        const dist = lev(target.toLowerCase(), b.toLowerCase());
        if (dist < bestD) { bestD = dist; best = b; }
      }
      const suggested = best && bestD <= 3 ? best : null;
      findings.push({ source: child.path, brokenTarget: target, suggested });
    }
  }
}

await orchestration.scratchpad.write("findings.json", JSON.stringify(findings, null, 2));
// Forward the findings to the proposer as the event payload (conversation steps see it).
return orchestration.emit("detect.done", JSON.stringify(findings));
\`\`\`
`;

/**
 * propose — CONVERSATION. Reads the findings and emits a simple approve/reject
 * judgment per suggested fix. The LLM's only job is the *decision*; the code step
 * generated the candidate and the code step will verify + apply it.
 */
const PROPOSE_MD = `---
notor-type: orchestration-step
notor-step-name: "Propose"
notor-step-description: "Approves or rejects each suggested broken-link fix."
notor-step-triggers:
  - detect.done
notor-step-publishes:
  - propose.done
notor-step-default-publishes: propose.done
---

You are the Propose step. The incoming event payload is a JSON array of detected
broken wikilinks. Each item has a "brokenTarget" (the dead link) and a code-suggested
"suggested" replacement note name. Do EXACTLY this, then stop:

1. Read the array from the event payload.
2. Approve any fix where "suggested" is a clear typo-correction of "brokenTarget"
   (e.g. "Meting Notes" → "Meeting Notes").
3. Call \`emit_event\` with topic "propose.done" and payload a JSON object listing the
   approved brokenTargets:
   {"approve":["<brokenTarget to fix>", ...]}

Emit raw JSON only — no prose, no fences. If unsure, approve the obvious typo fixes.
You have no write tools; the code step applies the fixes you approve.
`;

/**
 * apply-safe — CODE. Authoritative: applies only approved fixes whose suggested
 * target actually exists, via replace_in_note (once()-guarded). Always writes a
 * health-report note summarizing detected + fixed + skipped.
 */
const APPLY_SAFE_MD = `---
notor-type: orchestration-step
notor-step-name: "Apply Safe"
notor-step-description: "Applies approved+verified fixes; writes a health report."
notor-step-mode: code
notor-step-triggers:
  - propose.done
notor-step-publishes:
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

# Apply Safe

\`\`\`typescript
const findingsRaw = (await orchestration.scratchpad.read("findings.json")) || "[]";
let findings = [];
try { findings = JSON.parse(findingsRaw); } catch (_e) { findings = []; }

// Parse the proposer's approve list (tolerant of stray prose/fences).
let approve = [];
const raw = (event.payload || "").trim();
function parseApprove(text) {
  try {
    const o = JSON.parse(text);
    if (o && Array.isArray(o.approve)) return o.approve.map((s) => String(s));
  } catch (_e) { /* fall through */ }
  return null;
}
approve = parseApprove(raw);
if (approve === null) {
  const open = raw.indexOf("{"), close = raw.lastIndexOf("}");
  if (open !== -1 && close > open) approve = parseApprove(raw.slice(open, close + 1));
}
if (approve === null) approve = [];
const approveSet = new Set(approve.map((s) => s.toLowerCase()));

// Build the set of existing basenames so we never point a link at a missing note.
const basenameSet = new Set(app.vault.getMarkdownFiles().map((f) => f.basename.toLowerCase()));

const fixed = [];
const skipped = [];
for (const f of findings) {
  const approved = approveSet.has(String(f.brokenTarget || "").toLowerCase());
  const targetExists = f.suggested && basenameSet.has(String(f.suggested).toLowerCase());
  if (approved && targetExists) {
    await orchestration.once("fix:" + f.source + ":" + f.brokenTarget, async () => {
      await orchestration.callTool("replace_in_note", {
        path: f.source,
        changes: [{ old_text: "[[" + f.brokenTarget + "]]", new_text: "[[" + f.suggested + "]]" }],
      });
    });
    fixed.push(f.brokenTarget + " → " + f.suggested + " (in " + f.source + ")");
  } else {
    skipped.push(f.brokenTarget + " (in " + f.source + ") — " +
      (approved ? "suggested target missing" : "not approved"));
  }
}

// Always write a human-reviewable report (the ambiguous/unfixed items live here).
const lines = [];
lines.push("# Vault Health Report");
lines.push("");
lines.push("Detected " + findings.length + " broken wikilink(s).");
lines.push("");
lines.push("## Fixed (" + fixed.length + ")");
for (const x of fixed) lines.push("- " + x);
lines.push("");
lines.push("## Skipped / needs review (" + skipped.length + ")");
for (const x of skipped) lines.push("- " + x);
lines.push("");
lines.push("## All detected");
for (const f of findings) lines.push("- [[" + f.brokenTarget + "]] in " + f.source);
lines.push("");
await orchestration.callTool("write_note", { path: "${REPORT_PATH}", content: lines.join("\\n") });

return orchestration.emit("FLOW_COMPLETE", "Fixed " + fixed.length + " of " + findings.length + " broken link(s).");
\`\`\`
`;

const FLOW_TIMEOUT_MS = 180_000;
const POLL_MS = 2_000;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function setupFlowFixtures(vaultPath: string): void {
	writeCleanWorkspace(vaultPath);
	const stepsDir = path.join(vaultPath, FLOW_DIR, "steps");
	fs.mkdirSync(stepsDir, { recursive: true });
	fs.writeFileSync(path.join(vaultPath, FLOW_DIR, "definition.md"), DEFINITION_MD);
	fs.writeFileSync(path.join(stepsDir, "detect.md"), DETECT_MD);
	fs.writeFileSync(path.join(stepsDir, "propose.md"), PROPOSE_MD);
	fs.writeFileSync(path.join(stepsDir, "apply-safe.md"), APPLY_SAFE_MD);

	const healthDir = path.join(vaultPath, HEALTH_FOLDER);
	fs.mkdirSync(healthDir, { recursive: true });
	for (const [name, content] of Object.entries(SEED_NOTES)) {
		fs.writeFileSync(path.join(healthDir, name), content);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testFlowCompletes(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: detect → propose → apply-safe runs to FLOW_COMPLETE");
	const { page } = ctx;

	const enabled = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return plugin?.settings?.orchestration_enabled === true;
	});
	if (!enabled) {
		ctx.fail("orchestration enabled", "orchestration_enabled is not true at runtime");
		return;
	}

	const launched = await launchFlow(ctx, FLOW_NAME, "Find and fix broken links in the Health folder.");
	if (!launched) {
		ctx.fail("flow launched", "objective modal did not appear after selecting the flow");
		return;
	}
	const shot = await ctx.screenshot("01-flow-launched");

	const session = await waitForFlowTerminal(ctx);
	if (!session) {
		ctx.fail("session created", "no Vault Health Monitor E2E session reached a terminal status");
		return;
	}
	if (session.meta.status === "completed") {
		ctx.pass("flow completed", `session.json status is 'completed' (id ${session.id})`, shot);
	} else {
		ctx.fail("flow completed", `session.json status is '${String(session.meta.status)}' (expected 'completed')`, shot);
	}
}

async function testCodeStepsClean(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: the detect + apply-safe code steps ran without a code_error");
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

async function testReportWritten(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: a health report note was written recording the broken link");
	const reportFull = path.join(ctx.vaultPath, REPORT_PATH);
	if (!fs.existsSync(reportFull)) {
		ctx.fail("report written", `no health report at ${REPORT_PATH}`);
		return;
	}
	const report = fs.readFileSync(reportFull, "utf8");
	// The detect step is deterministic, so the report MUST mention the seeded broken target.
	if (report.includes("Meting Notes")) {
		ctx.pass("report written", `health report records the detected broken link (Meting Notes)`);
	} else {
		ctx.fail("report written", `report exists but does not mention the seeded broken link`);
	}
}

async function testLinkRepaired(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: the broken link was repaired in the source note");
	const sourceFull = path.join(ctx.vaultPath, HEALTH_FOLDER, "Daily Log.md");
	if (!fs.existsSync(sourceFull)) {
		ctx.fail("link repaired", "Daily Log.md not found");
		return;
	}
	const content = fs.readFileSync(sourceFull, "utf8");
	const stillBroken = content.includes(BROKEN_LINK_TEXT);
	const nowFixed = content.includes("[[" + FIX_TARGET + "]]");
	if (!stillBroken && nowFixed) {
		ctx.pass("link repaired", `the broken link now points at [[${FIX_TARGET}]] (code-owned safe fix committed)`);
	} else {
		ctx.fail(
			"link repaired",
			`expected the typo'd link fixed to [[${FIX_TARGET}]] (stillBroken=${stillBroken}, nowFixed=${nowFixed})`,
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
	await testCodeStepsClean(ctx);
	await testReportWritten(ctx);
	await testLinkRepaired(ctx);
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
		replace_in_note: true,
		write_note: true,
	},
});

runTest(
	{
		name: "orchestration-vault-health",
		settings,
		setupVault: setupFlowFixtures,
		cleanupFiles: [FLOW_DIR, HEALTH_FOLDER],
	},
	tests,
);
