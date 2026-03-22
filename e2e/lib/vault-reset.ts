/**
 * Vault Reset — ensures clean state between e2e test runs.
 *
 * Uses a surgical approach: deletes known test-generated artifacts while
 * preserving the vault structure, Obsidian config, and base fixtures.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface VaultResetOptions {
	/** Additional vault-relative file/dir paths to delete. */
	extraDeletePaths?: string[];
	/** Additional vault-relative file/dir paths to preserve (skip deletion). */
	extraPreservePaths?: string[];
}

/** Directories under the plugin data dir that accumulate test state. */
const PLUGIN_STATE_DIRS = ["history", "checkpoints"];

/** Known test-generated notes (vault-relative paths). */
const TEST_GENERATED_NOTES = [
	"AutoTest.md",
	"Checkpoint-Test.md",
	"E2E-Generated-Note.md",
	"Diff-Test-Source.md",
	"Diff-Test-Write.md",
	"Plan-Mode-Test.md",
	"Test-Write.md",
	"Deletable-Note.md",
	"Stale-Content-Test.md",
	"Include-Note-Test.md",
	"Attachment-Test.md",
	"Activity-Test.md",
	"Scroll-Test.md",
	"Execute-Command-Test.md",
	"Hook-Test.md",
	"Vault-Event-Test.md",
	"Context-Test.md",
	"Abort-Test.md",
];

/** Known test-generated directories (vault-relative). */
const TEST_GENERATED_DIRS = [
	"Notes",
	"Research",
	"Workflows",
	"notor/personas/restrictive",
	"notor/personas/permissive",
	"notor/personas/test-persona",
];

function rmSafe(targetPath: string): void {
	try {
		if (!fs.existsSync(targetPath)) return;
		const stat = fs.lstatSync(targetPath);
		if (stat.isDirectory()) {
			fs.rmSync(targetPath, { recursive: true, force: true });
		} else {
			fs.unlinkSync(targetPath);
		}
	} catch {
		// Best-effort cleanup
	}
}

/**
 * Reset the test vault to a clean state.
 *
 * Deletes:
 *   - Plugin history and checkpoint directories
 *   - Known test-generated notes and directories
 *   - Any extra paths specified in options
 *
 * Preserves:
 *   - .obsidian/ config and plugin symlink
 *   - Test Note.md (base fixture)
 *   - notor/personas/researcher/, notor/personas/organizer/ (base personas)
 */
export function resetVault(vaultPath: string, options?: VaultResetOptions): void {
	const pluginDataDir = path.join(vaultPath, ".obsidian", "plugins", "notor");

	// 1. Clear plugin state dirs (history, checkpoints)
	for (const dir of PLUGIN_STATE_DIRS) {
		rmSafe(path.join(pluginDataDir, dir));
	}

	// 2. Build preserve set
	const preserveSet = new Set<string>([
		"Test Note.md",
		...(options?.extraPreservePaths ?? []),
	]);

	// 3. Delete known test-generated notes
	for (const note of TEST_GENERATED_NOTES) {
		if (!preserveSet.has(note)) {
			rmSafe(path.join(vaultPath, note));
		}
	}

	// 4. Delete known test-generated directories
	for (const dir of TEST_GENERATED_DIRS) {
		if (!preserveSet.has(dir)) {
			rmSafe(path.join(vaultPath, dir));
		}
	}

	// 5. Delete extra paths
	for (const extra of options?.extraDeletePaths ?? []) {
		rmSafe(path.join(vaultPath, extra));
	}

	console.log(`  Vault reset complete: ${vaultPath}`);
}
