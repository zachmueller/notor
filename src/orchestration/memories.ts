/**
 * Persistent cross-session orchestration memory (INT-004 / FR-124).
 *
 * A single plain note at `{notor_dir}/orchestrations/memories.md`, **not** under
 * any session. Free-form (Patterns / Decisions / Fixes / Context sections); it is
 * **not parsed structurally** — steps read/append it as plain Markdown through
 * their normal note tools (its path is the orchestrations root, not the per-session
 * scratchpad, so no path auto-allow beyond what a step's persona already grants for
 * the orchestrations directory is required).
 *
 * On first use the note is **seeded** with the section skeleton if it does not
 * yet exist; seeding is **idempotent** — it never overwrites an existing note.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-004
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md — memories.md
 */

import { logger } from "../utils/logger";
import type { SessionFs } from "./session-manager";

const log = logger("OrchestrationMemories");

/** The section skeleton seeded on first use (free-form thereafter). */
export const MEMORIES_SKELETON = `# Orchestration Memories

Cross-session memory for orchestration flows. Free-form — consult before acting
in unfamiliar territory, and append a fix-memory when you get blocked and recover.

## Patterns

## Decisions

## Fixes

## Context
`;

/** Vault-relative path to the persistent memories note. */
export function memoriesPath(notorDir: string): string {
	return `${notorDir.replace(/\/+$/, "")}/orchestrations/memories.md`;
}

/**
 * Seed `memories.md` with the section skeleton **iff it does not exist**.
 * Idempotent: an existing note is never overwritten. Returns the resolved path.
 */
export async function seedMemoriesNote(notorDir: string, fs: SessionFs): Promise<string> {
	const path = memoriesPath(notorDir);
	if (await fs.exists(path)) return path;
	await fs.write(path, MEMORIES_SKELETON);
	log.debug("Seeded orchestration memories.md", { path });
	return path;
}
