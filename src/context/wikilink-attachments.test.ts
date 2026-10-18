import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import {
	buildPromptWithAttachments,
	extractWikilinkAttachments,
	parseWikilinkSegments,
} from "./wikilink-attachments";
import { createVaultNoteAttachment } from "./attachment";

/** Minimal App fake: a flat map of vault path → content, resolved by basename. */
function fakeApp(files: Record<string, string>): App {
	const byPath = new Map(
		Object.keys(files).map((path) => [path, { path, extension: path.split(".").pop() ?? "" }]),
	);
	return {
		metadataCache: {
			getFirstLinkpathDest: (linkpath: string) =>
				[...byPath.values()].find(
					(f) => {
						const noExt = f.path.replace(/\.[^.]+$/, "");
						return f.path === linkpath || noExt === linkpath
							|| noExt.split("/").pop() === linkpath || f.path.split("/").pop() === linkpath;
					},
				) ?? null,
		},
		vault: {
			getFileByPath: (path: string) => byPath.get(path) ?? null,
			read: async (file: { path: string }) => files[file.path] ?? "",
		},
	} as unknown as App;
}

const app = fakeApp({
	"Meetings/Standup.md": "# Standup\nnotes",
	"Projects/Alpha.md": "# Alpha\n## Goals\nship it",
	"assets/diagram.png": "",
});

describe("parseWikilinkSegments", () => {
	it("returns a single text segment when there are no links", () => {
		expect(parseWikilinkSegments(app, "plain text")).toEqual([{ kind: "text", text: "plain text" }]);
	});

	it("splits text around resolvable note links, preserving spacing", () => {
		const segs = parseWikilinkSegments(app, "Process [[Standup]], then stop");
		expect(segs.map((s) => s.kind)).toEqual(["text", "link", "text"]);
		expect(segs[0]).toEqual({ kind: "text", text: "Process " });
		expect(segs[2]).toEqual({ kind: "text", text: ", then stop" });
		const link = segs[1];
		expect(link?.kind === "link" && link.attachment.path).toBe("Meetings/Standup.md");
	});

	it("creates a section attachment for [[Note#Section]]", () => {
		const [seg] = parseWikilinkSegments(app, "[[Alpha#Goals]]");
		expect(seg?.kind === "link" && seg.attachment.type).toBe("vault_note_section");
		expect(seg?.kind === "link" && seg.attachment.section).toBe("Goals");
	});

	it("ignores a |alias suffix when resolving", () => {
		const [seg] = parseWikilinkSegments(app, "[[Standup|today's standup]]");
		expect(seg?.kind === "link" && seg.attachment.path).toBe("Meetings/Standup.md");
		const [secSeg] = parseWikilinkSegments(app, "[[Alpha#Goals|goals]]");
		expect(secSeg?.kind === "link" && secSeg.attachment.section).toBe("Goals");
	});

	it("leaves unresolved and non-Markdown links as plain text", () => {
		const segs = parseWikilinkSegments(app, "[[Missing]] and ![[diagram.png]]");
		expect(segs).toEqual([{ kind: "text", text: "[[Missing]] and ![[diagram.png]]" }]);
	});

	it("skips duplicates within the text and against existing attachments", () => {
		const segs = parseWikilinkSegments(app, "[[Standup]] [[Standup]]");
		expect(segs.filter((s) => s.kind === "link")).toHaveLength(1);

		const existing = [createVaultNoteAttachment("Meetings/Standup.md")];
		expect(parseWikilinkSegments(app, "[[Standup]]", existing)).toEqual([
			{ kind: "text", text: "[[Standup]]" },
		]);
	});
});

describe("extractWikilinkAttachments", () => {
	it("renders attached links by display name, like chat-input tokens", () => {
		const out = extractWikilinkAttachments(app, "Wrap up [[Meetings/Standup|standup]] and [[Alpha#Goals]]");
		expect(out.text).toBe("Wrap up [[Standup]] and [[Alpha § Goals]]");
		expect(out.attachments.map((a) => a.path)).toEqual(["Meetings/Standup.md", "Projects/Alpha.md"]);
	});
});

describe("buildPromptWithAttachments", () => {
	it("inlines linked note content ahead of the prose", async () => {
		const { prompt, attachments } = await buildPromptWithAttachments(app, "Process [[Standup]]");
		expect(attachments[0]?.status).toBe("resolved");
		expect(prompt).toContain('<vault-note path="Meetings/Standup.md">');
		expect(prompt).toContain("# Standup\nnotes");
		expect(prompt.endsWith("Process [[Standup]]")).toBe(true);
	});

	it("returns the text unchanged when nothing resolves", async () => {
		const { prompt, attachments } = await buildPromptWithAttachments(app, "No links [[Missing]]");
		expect(prompt).toBe("No links [[Missing]]");
		expect(attachments).toEqual([]);
	});
});
