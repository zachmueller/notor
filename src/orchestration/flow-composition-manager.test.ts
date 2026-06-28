/**
 * TEST-006 (part 1) — `FlowCompositionManager` invocable-flow discovery (INT-041).
 *
 * Asserts the stateless re-scan contract: only `notor-flow-invocable: true` flows
 * are listed (each carrying its `notor-flow-inputs` / `notor-flow-returns`), a
 * flow toggled invocable on disk is reflected on the next scan with no cache
 * invalidation, and `resolveFlow` returns null for an unknown / non-invocable
 * name. Reuses the flow-parser fake-vault fixturing.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — INT-041 / TEST-006
 */

import { describe, it, expect } from "vitest";
import { TFile, TFolder } from "obsidian";
import { FlowCompositionManager } from "./flow-composition-manager";
import { FLOW_COMPLETE } from "./types";

interface FileFixture {
	frontmatter: Record<string, unknown> | null;
	body: string;
}

/**
 * A mutable fake vault: fixtures live in a shared map so a test can flip a flow's
 * `notor-flow-invocable` between scans and prove the manager holds no state.
 */
function buildMutableVault(files: Record<string, FileFixture>) {
	const fileObjs = new Map<string, TFile>();
	const folderObjs = new Map<string, TFolder>();

	function ensureFolder(path: string): TFolder {
		let folder = folderObjs.get(path);
		if (!folder) {
			folder = new TFolder();
			folder.path = path;
			folder.name = path.split("/").pop() ?? path;
			folder.children = [];
			folderObjs.set(path, folder);
			if (path !== "") {
				const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
				const parent = ensureFolder(parentPath);
				if (!parent.children.includes(folder)) parent.children.push(folder);
			}
		}
		return folder;
	}

	for (const path of Object.keys(files)) {
		const file = new TFile();
		file.path = path;
		file.name = path.split("/").pop() ?? path;
		file.extension = "md";
		fileObjs.set(path, file);
		const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		const parent = ensureFolder(parentPath);
		if (!parent.children.includes(file)) parent.children.push(file);
	}

	const serialize = (fx: FileFixture): string => {
		if (!fx.frontmatter) return fx.body;
		const yaml = Object.entries(fx.frontmatter)
			.map(([k, v]) =>
				Array.isArray(v)
					? `${k}:\n${v.map((x) => `  - ${JSON.stringify(x)}`).join("\n")}`
					: `${k}: ${JSON.stringify(v)}`,
			)
			.join("\n");
		return `---\n${yaml}\n---\n${fx.body}`;
	};

	const vault = {
		getAbstractFileByPath: (path: string) => {
			const n = path.replace(/\/$/, "");
			return fileObjs.get(n) ?? folderObjs.get(n) ?? null;
		},
		read: async (file: TFile) => {
			const fx = files[file.path];
			if (!fx) throw new Error(`no fixture for ${file.path}`);
			return serialize(fx);
		},
	} as unknown as import("obsidian").Vault;

	const metadataCache = {
		getFileCache: (file: TFile) => {
			const fx = files[file.path];
			return fx ? { frontmatter: fx.frontmatter ?? undefined } : null;
		},
		getFirstLinkpathDest: (linkpath: string, sourcePath: string) => {
			const flowDir = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
			return fileObjs.get(`${flowDir}/steps/${linkpath}.md`) ?? null;
		},
	} as unknown as import("obsidian").MetadataCache;

	ensureFolder("notor/orchestrations");
	return { vault, metadataCache };
}

/** A minimal valid flow at `notor/orchestrations/{slug}`. */
function flowFiles(
	slug: string,
	name: string,
	flowOver: Record<string, unknown> = {},
): Record<string, FileFixture> {
	const dir = `notor/orchestrations/${slug}`;
	return {
		[`${dir}/definition.md`]: {
			frontmatter: {
				"notor-type": "orchestration-flow",
				"notor-flow-name": name,
				"notor-flow-description": `${name} flow`,
				"notor-starting-event": "start",
				"notor-steps": ["[[finisher]]"],
				...flowOver,
			},
			body: "# doc",
		},
		[`${dir}/steps/finisher.md`]: {
			frontmatter: {
				"notor-type": "orchestration-step",
				"notor-step-name": "Finisher",
				"notor-step-triggers": ["start"],
				"notor-step-publishes": [FLOW_COMPLETE],
				"notor-step-default-publishes": FLOW_COMPLETE,
			},
			body: "Emit FLOW_COMPLETE.",
		},
	};
}

describe("FlowCompositionManager", () => {
	it("lists only invocable flows, each carrying its inputs/returns contract", async () => {
		const files = {
			...flowFiles("callee", "Callee", {
				"notor-flow-invocable": true,
				"notor-flow-inputs": "a research question",
				"notor-flow-returns": "a cited report",
			}),
			...flowFiles("private", "Private"), // invocable defaults false
		};
		const { vault, metadataCache } = buildMutableVault(files);
		const mgr = new FlowCompositionManager(vault, metadataCache, "notor");

		const invocable = await mgr.listInvocableFlows();
		expect(invocable.map((f) => f.name)).toEqual(["Callee"]);
		expect(invocable[0]!.flowInputs).toBe("a research question");
		expect(invocable[0]!.flowReturns).toBe("a cited report");
	});

	it("holds no active state — a flow toggled invocable on disk shows up on the next scan", async () => {
		const files = flowFiles("callee", "Callee"); // not invocable yet
		const { vault, metadataCache } = buildMutableVault(files);
		const mgr = new FlowCompositionManager(vault, metadataCache, "notor");

		expect(await mgr.listInvocableFlows()).toHaveLength(0);

		// Flip the field on disk; the stateless manager picks it up with no cache bust.
		files["notor/orchestrations/callee/definition.md"]!.frontmatter![
			"notor-flow-invocable"
		] = true;
		const after = await mgr.listInvocableFlows();
		expect(after.map((f) => f.name)).toEqual(["Callee"]);
	});

	it("resolveFlow returns the matching invocable flow, or null for unknown/non-invocable", async () => {
		const files = {
			...flowFiles("callee", "Callee", { "notor-flow-invocable": true }),
			...flowFiles("private", "Private"),
		};
		const { vault, metadataCache } = buildMutableVault(files);
		const mgr = new FlowCompositionManager(vault, metadataCache, "notor");

		expect((await mgr.resolveFlow("Callee"))?.name).toBe("Callee");
		expect(await mgr.resolveFlow("Private")).toBeNull(); // exists but not invocable
		expect(await mgr.resolveFlow("Nope")).toBeNull(); // unknown
	});
});
