#!/usr/bin/env npx tsx
/**
 * Read-only inventory helper for the audit-personas-docs skill.
 *
 * Imports the SAME built-in registries the plugin ships and prints them as
 * JSON ground truth, so the persona/doc audit diffs against real code instead
 * of a hand-copied list that can silently drift. Mirrors the pattern in
 * `.claude/skills/audit-bedrock-thinking/classify.ts`.
 *
 * Sources (all verified free of value-level `obsidian` imports, so they load
 * cleanly under tsx outside the Obsidian runtime):
 *   - BUILTIN_TOOL_SCAFFOLDS    src/extensions/builtin-tool-scaffolds/index.ts
 *   - USE_SUBAGENT_TOOL_NAME    src/sub-agents/constants.ts
 *   - BUILTIN_PERSONA_PROFILES  src/personas/builtin-personas.ts
 *   - BUILTIN_SUBAGENT_PROFILES src/sub-agents/builtin-profiles.ts
 *
 * Usage (from anywhere):
 *   npx tsx .claude/skills/audit-personas-docs/inventory.ts
 *
 * Output: a single pretty-printed JSON object —
 *   { tools: [{ name, mode }], toolCount, personas: [name], subAgentProfiles: [name] }
 *
 * `use_subagent` is unioned into `tools` because it is a real invocable tool
 * registered OUTSIDE the scaffold map (src/sub-agents/constants.ts). Omitting it
 * would make the audit falsely flag it as "documented but nonexistent". Other
 * truth surfaces (settings sections, the `utils`/`libs` API, injected vars) live
 * in obsidian-coupled modules that cannot be imported under tsx — the skill reads
 * those from source. See SKILL.md's source-of-truth map.
 *
 * Read-only: imports nothing with side effects and writes nothing.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// .claude/skills/audit-personas-docs/ -> repo root is three levels up
// (audit-personas-docs -> skills -> .claude -> <repo root>).
const repoRoot = resolve(here, "..", "..", "..");

const { BUILTIN_TOOL_SCAFFOLDS } = await import(
	resolve(repoRoot, "src/extensions/builtin-tool-scaffolds/index.ts")
);
const { USE_SUBAGENT_TOOL_NAME } = await import(
	resolve(repoRoot, "src/sub-agents/constants.ts")
);
const { BUILTIN_PERSONA_PROFILES } = await import(
	resolve(repoRoot, "src/personas/builtin-personas.ts")
);
const { BUILTIN_SUBAGENT_PROFILES } = await import(
	resolve(repoRoot, "src/sub-agents/builtin-profiles.ts")
);

// Scaffold tools in registry order, then the separately-registered use_subagent.
const scaffoldTools = [...BUILTIN_TOOL_SCAFFOLDS.values()].map(
	(s: { name: string; mode: "read" | "write" }) => ({ name: s.name, mode: s.mode })
);
const tools = [...scaffoldTools, { name: USE_SUBAGENT_TOOL_NAME, mode: "read" }];

const inventory = {
	tools,
	toolCount: tools.length,
	personas: [...BUILTIN_PERSONA_PROFILES.keys()],
	subAgentProfiles: [...BUILTIN_SUBAGENT_PROFILES.keys()],
};

console.log(JSON.stringify(inventory, null, 2));
