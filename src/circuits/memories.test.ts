import { describe, it, expect } from "vitest";
import { MEMORIES_SKELETON, memoriesPath, seedMemoriesNote } from "./memories";
import type { SessionFs } from "./session-manager";

function memFs(files: Record<string, string>): SessionFs {
	const fs: SessionFs = {
		exists: async (p: string) => p in files,
		mkdir: async () => {},
		read: async (p: string) => files[p] ?? "",
		write: async (p: string, data: string) => {
			files[p] = data;
		},
	};
	return fs;
}

describe("memories.md location", () => {
	it("defaults to the legacy orchestrations root", () => {
		expect(memoriesPath("notor")).toBe("notor/orchestrations/memories.md");
	});

	it("follows the circuits data root when active", () => {
		expect(memoriesPath("notor/", "circuits")).toBe("notor/circuits/memories.md");
	});

	it("seeds once under the chosen root and never overwrites", async () => {
		const files: Record<string, string> = {};
		const path = await seedMemoriesNote("notor", memFs(files), "circuits");
		expect(path).toBe("notor/circuits/memories.md");
		expect(files[path]).toBe(MEMORIES_SKELETON);
		files[path] = "USER EDIT";
		await seedMemoriesNote("notor", memFs(files), "circuits");
		expect(files[path]).toBe("USER EDIT");
	});
});
