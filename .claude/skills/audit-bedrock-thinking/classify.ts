#!/usr/bin/env npx tsx
/**
 * Read-only thinking-classification helper for the audit-bedrock-thinking skill.
 *
 * Runs a list of Bedrock model IDs through the SAME classifier the plugin ships
 * (`supportsThinking` / `getThinkingMode` from src/providers/model-metadata.ts) so
 * the audit never drifts from a hand-copied regex. Imports nothing with side
 * effects and writes nothing — it only reads the IDs and prints JSON.
 *
 * Usage:
 *   npx tsx .claude/skills/audit-bedrock-thinking/classify.ts <ids.json>
 *   echo '["global.anthropic.claude-opus-4-8"]' | \
 *     npx tsx .claude/skills/audit-bedrock-thinking/classify.ts
 *
 * <ids.json> is a JSON array of model-id strings. With no argument, the JSON
 * array is read from stdin.
 *
 * Output: one JSON object per line —
 *   { id, supportsThinking, thinkingMode, matchedLegacyPattern }
 *
 * `matchedLegacyPattern` is true when the model lands in "enabled" mode because it
 * matched the closed LEGACY_ENABLED_THINKING_PATTERNS allowlist (vs. reaching
 * "effort" via the default fallback). It is derived as `thinkingMode === "enabled"`,
 * since getThinkingMode returns "enabled" only for allowlist matches.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// .claude/skills/audit-bedrock-thinking/ -> repo root is three levels up
// (audit-bedrock-thinking -> skills -> .claude -> <repo root>).
const repoRoot = resolve(here, "..", "..", "..");

const { supportsThinking, getThinkingMode } = await import(
	resolve(repoRoot, "src/providers/model-metadata.ts")
);

function readInput(): string {
	const argPath = process.argv[2];
	if (argPath) {
		return readFileSync(resolve(process.cwd(), argPath), "utf8");
	}
	// No path argument: read the JSON array from stdin.
	return readFileSync(0, "utf8");
}

const raw = readInput().trim();
if (!raw) {
	console.error("No input: pass a path to a JSON array of model IDs, or pipe one on stdin.");
	process.exit(1);
}

let ids: unknown;
try {
	ids = JSON.parse(raw);
} catch (e) {
	console.error(`Input is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
}

if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
	console.error("Input must be a JSON array of model-id strings.");
	process.exit(1);
}

for (const id of ids as string[]) {
	const canThink = supportsThinking(id);
	// getThinkingMode is only meaningful for thinking-capable models.
	const thinkingMode = canThink ? getThinkingMode(id) : null;
	const matchedLegacyPattern = thinkingMode === "enabled";
	console.log(
		JSON.stringify({ id, supportsThinking: canThink, thinkingMode, matchedLegacyPattern })
	);
}
