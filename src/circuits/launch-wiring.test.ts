import { describe, it, expect } from "vitest";
import type { App, Vault } from "obsidian";
import { VaultSessionFs } from "./launch-wiring";

/**
 * A stateful fake vault adapter that models Obsidian's *real* desktop-adapter
 * `rename` contract: it REFUSES to overwrite an existing destination, throwing
 * "Destination file already exists!" — exactly as observed in the live app.
 *
 * This is the contract the in-memory fake-fs doubles elsewhere failed to model,
 * which is why the F4 Phase B rename-over-existing regression only surfaced under
 * the live e2e harness. Modeling it here pins the remove-before-rename fix.
 */
function makeRenameStrictVault(): { app: App; files: Record<string, string> } {
	const files: Record<string, string> = {};
	const dirs = new Set<string>();
	const adapter = {
		exists: async (p: string) => p in files || dirs.has(p),
		mkdir: async (p: string) => {
			dirs.add(p);
		},
		read: async (p: string) => {
			if (!(p in files)) throw new Error(`ENOENT: ${p}`);
			return files[p]!;
		},
		write: async (p: string, data: string) => {
			files[p] = data;
		},
		remove: async (p: string) => {
			delete files[p];
		},
		rename: async (from: string, to: string) => {
			if (to in files) {
				// Obsidian's desktop DataAdapter.rename throws on an existing target.
				throw new Error("Destination file already exists!");
			}
			files[to] = files[from]!;
			delete files[from];
		},
	};
	return { app: { vault: { adapter } as unknown as Vault } as unknown as App, files };
}

describe("VaultSessionFs.write (atomic temp-write + rename)", () => {
	it("creates a new file via temp-write + rename", async () => {
		const { app, files } = makeRenameStrictVault();
		const fs = new VaultSessionFs(app);

		await fs.write("dir/session.json", "first");

		expect(files["dir/session.json"]).toBe("first");
		// The temp file must not linger.
		expect(files["dir/session.json.tmp"]).toBeUndefined();
	});

	it("overwrites an existing file even though rename refuses an existing target (F4 regression)", async () => {
		const { app, files } = makeRenameStrictVault();
		const fs = new VaultSessionFs(app);

		// First write establishes the target — as createWorkspace does.
		await fs.write("dir/session.json", "status:active");
		// Second write is the terminal finalize (status: completed). Pre-fix this
		// threw "Destination file already exists!" and left the flow stuck active.
		await fs.write("dir/session.json", "status:completed");

		expect(files["dir/session.json"]).toBe("status:completed");
		expect(files["dir/session.json.tmp"]).toBeUndefined();
	});
});
