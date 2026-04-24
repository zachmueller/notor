import type { App, Vault } from "obsidian";
import type { ExtensionUtils } from "../extensions/runtime-context";
import {
	serializeNote,
	parseNote,
	slugifyTitle,
	assertMemoryPath,
	serializePendingNote,
	assertPendingMemoryPath,
	parsePendingNote,
	extractJSON,
	patchFrontmatterField,
	extractMemoryWikilinks,
} from "./note-format";

export interface ResolveConceptArgs {
	insight: string;
	memoryDir: string;
	resolverProfile: string;
	app: App;
	runSubAgent: ExtensionUtils["runSubAgent"];
	vault: Vault;
	/** Suppress editor-open side effects within the resolver sub-agent. */
	silent?: boolean;
	/**
	 * When true, write the resolved note to `pendingMemoryDir` instead of
	 * `memoryDir`. The sub-agent is also given `pendingMemoryDir` as context
	 * so it can avoid duplicating notes that are already pending.
	 */
	pendingMode?: boolean;
	/** Required when `pendingMode` is true. */
	pendingMemoryDir?: string;
}

export interface ResolveConceptResult {
	action: "created" | "updated" | "skipped";
	path?: string;
}

interface ResolverDirective {
	action: "update" | "create";
	path?: string;
	title?: string;
	merged_body: string;
	linked_titles?: string[];
}

export async function resolveConcept(
	args: ResolveConceptArgs,
): Promise<ResolveConceptResult> {
	const { insight, memoryDir, resolverProfile, app, runSubAgent, vault } = args;
	const pendingMode = args.pendingMode === true && !!args.pendingMemoryDir;
	const pendingMemoryDir = args.pendingMemoryDir ?? "";

	// Give the sub-agent awareness of pending notes so it avoids duplicating them.
	const task = pendingMode
		? `${insight}\n\n[Pending memory dir: ${pendingMemoryDir}]`
		: insight;

	const result = await runSubAgent({
		profileName: resolverProfile,
		task,
		detached: false,
		silent: args.silent,
	});

	if (!result) {
		return { action: "skipped" };
	}

	const extracted = extractJSON(result.text);
	if (!extracted || typeof extracted !== "object") {
		return { action: "skipped" };
	}
	const directive = extracted as ResolverDirective;

	if (!directive || !directive.action || !directive.merged_body) {
		return { action: "skipped" };
	}

	if (directive.action === "create") {
		const title = directive.title ?? "untitled";
		let slug = slugifyTitle(title);

		if (pendingMode) {
			// Write to pending dir. If a pending note for this title already exists,
			// overwrite it (no stacking of pending edits).
			let filePath = `${pendingMemoryDir}/${slug}.md`;
			let suffix = 1;
			while (
				(await app.vault.adapter.exists(filePath)) &&
				!await isPendingNote(app, filePath)
			) {
				suffix++;
				filePath = `${pendingMemoryDir}/${slug}-${suffix}.md`;
			}

			assertPendingMemoryPath(filePath, pendingMemoryDir);

			const now = new Date().toISOString();
			const content = serializePendingNote({
				title,
				body: directive.merged_body,
				sources: ["chat"],
				createdAt: now,
				memoryUpdatedAt: now,
				approvalState: "pending",
				originalAction: "create",
			});

			await app.vault.adapter.write(filePath, content);
			return { action: "created", path: filePath };
		}

		let filePath = `${memoryDir}/${slug}.md`;
		let suffix = 1;

		while (await app.vault.adapter.exists(filePath)) {
			suffix++;
			filePath = `${memoryDir}/${slug}-${suffix}.md`;
		}

		assertMemoryPath(filePath, memoryDir);

		const now = new Date().toISOString();
		const content = serializeNote({
			title,
			body: directive.merged_body,
			sources: ["chat"],
			createdAt: now,
		});

		await app.vault.adapter.write(filePath, content);
		await updateLinkedToTimestamps(app, vault, directive.merged_body, memoryDir, now);
		return { action: "created", path: filePath };
	}

	if (directive.action === "update") {
		if (!directive.path) {
			return { action: "skipped" };
		}

		if (pendingMode) {
			// The directive path refers to a live memory note. Look for an existing
			// pending note that already targets the same live note (stacking prevention).
			assertMemoryPath(directive.path, memoryDir);

			const liveFile = app.vault.getAbstractFileByPath(directive.path);
			if (!liveFile) {
				return { action: "skipped" };
			}
			const liveNote = parseNote(await vault.read(liveFile as import("obsidian").TFile));

			// Derive the wikilink target path (vault-relative, no .md extension).
			const targetWikiPath = directive.path.replace(/\.md$/, "");

			// Check for an existing pending note targeting the same live note.
			const existingPendingPath = await findExistingPendingForTarget(
				app,
				pendingMemoryDir,
				targetWikiPath,
			);

			const pendingFilePath =
				existingPendingPath ?? `${pendingMemoryDir}/${slugifyTitle(liveNote.title)}.md`;

			assertPendingMemoryPath(pendingFilePath, pendingMemoryDir);

			const now = new Date().toISOString();
			const updatedSources = liveNote.sources.includes("chat")
				? liveNote.sources
				: [...liveNote.sources, "chat"];

			const content = serializePendingNote({
				title: liveNote.title,
				body: directive.merged_body,
				sources: updatedSources,
				createdAt: liveNote.createdAt || now,
				memoryUpdatedAt: now,
				approvalState: "pending",
				originalAction: "update",
				targetPath: targetWikiPath,
			});

			await app.vault.adapter.write(pendingFilePath, content);
			return { action: "updated", path: pendingFilePath };
		}

		assertMemoryPath(directive.path, memoryDir);

		const file = app.vault.getAbstractFileByPath(directive.path);
		if (!file) {
			return { action: "skipped" };
		}

		const existing = await vault.read(file as import("obsidian").TFile);
		const parsed = parseNote(existing);

		const now = new Date().toISOString();
		const updatedSources = parsed.sources.includes("chat")
			? parsed.sources
			: [...parsed.sources, "chat"];

		const updated = serializeNote({
			title: parsed.title,
			body: directive.merged_body,
			sources: updatedSources,
			createdAt: parsed.createdAt || now,
		});

		await vault.modify(file as import("obsidian").TFile, updated);
		await updateLinkedToTimestamps(app, vault, directive.merged_body, memoryDir, now);
		return { action: "updated", path: directive.path };
	}

	return { action: "skipped" };
}

/**
 * For each memory note linked from `body`, patches `notor-last-linked-to-at`
 * on the target note. Skips targets that don't exist or fail to read/write.
 */
export async function updateLinkedToTimestamps(
	app: App,
	vault: Vault,
	body: string,
	memoryDir: string,
	now: string,
): Promise<void> {
	const linkedPaths = extractMemoryWikilinks(body, memoryDir);
	for (const linkedPath of linkedPaths) {
		try {
			const file = app.vault.getFileByPath(linkedPath);
			if (!file) continue;
			const content = await vault.read(file);
			const patched = patchFrontmatterField(content, "notor-last-linked-to-at", now);
			await vault.modify(file, patched);
		} catch {
			// best-effort; don't propagate failures
		}
	}
}

/** Returns true if the file at `filePath` is a pending memory note. */
async function isPendingNote(app: App, filePath: string): Promise<boolean> {
	try {
		const content = await app.vault.adapter.read(filePath);
		return content.includes("notor-type: pending-memory");
	} catch {
		return false;
	}
}

/**
 * Scans `pendingMemoryDir` for a pending note whose `notor-target-path` resolves
 * to `targetWikiPath` (vault-relative path without extension). Returns the
 * vault-relative path of the pending note, or null if none found.
 */
async function findExistingPendingForTarget(
	app: App,
	pendingMemoryDir: string,
	targetWikiPath: string,
): Promise<string | null> {
	const listed = await app.vault.adapter.list(pendingMemoryDir).catch(() => null);
	if (!listed) return null;
	for (const filePath of listed.files) {
		if (!filePath.endsWith(".md")) continue;
		try {
			const content = await app.vault.adapter.read(filePath);
			const parsed = parsePendingNote(content);
			if (
				parsed.originalAction === "update" &&
				parsed.targetPath &&
				parsed.targetPath.replace(/\.md$/, "") === targetWikiPath
			) {
				return filePath;
			}
		} catch {
			// ignore unreadable files
		}
	}
	return null;
}
