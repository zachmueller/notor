import type { App, Vault } from "obsidian";
import {
	parsePendingNote,
	parseNote,
	serializeNote,
	assertPendingMemoryPath,
	type PendingMemoryNote,
} from "./note-format";
import { updateLinkedToTimestamps } from "./concept-resolver";

export class PendingMemoryManager {
	constructor(
		private app: App,
		private vault: Vault,
		private pendingDir: string,
		private memoryDir: string,
	) {}

	async ensurePendingDir(): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(this.pendingDir);
		if (!existing) {
			await this.app.vault.createFolder(this.pendingDir);
		}
	}

	/** List pending memory notes, newest first, up to `limit`. */
	async listPending(limit = 50): Promise<Array<PendingMemoryNote & { filePath: string }>> {
		const listed = await this.app.vault.adapter.list(this.pendingDir).catch(() => null);
		if (!listed) return [];

		const files = listed.files.filter((f) => f.endsWith(".md"));
		const results: Array<PendingMemoryNote & { filePath: string }> = [];

		for (const filePath of files) {
			if (results.length >= limit) break;
			try {
				const content = await this.app.vault.adapter.read(filePath);
				if (!content.includes("notor-type: pending-memory")) continue;
				const parsed = parsePendingNote(content);
				results.push({ ...parsed, filePath });
			} catch {
				// skip unreadable files
			}
		}

		return results;
	}

	/** Read the current content of the live memory note a pending note targets. */
	async getLiveNoteContent(targetPath: string): Promise<string | null> {
		const withExt = targetPath.endsWith(".md") ? targetPath : `${targetPath}.md`;
		const file = this.app.vault.getFileByPath(withExt);
		if (!file) return null;
		try {
			return await this.vault.read(file);
		} catch {
			return null;
		}
	}

	/** Approve a single pending note: write it to the live memory dir, then delete the pending file. */
	async approveSingle(pendingPath: string): Promise<void> {
		assertPendingMemoryPath(pendingPath, this.pendingDir);

		const content = await this.app.vault.adapter.read(pendingPath);
		const pending = parsePendingNote(content);

		const now = new Date().toISOString();

		if (pending.originalAction === "create") {
			// Derive the live path from the pending path filename.
			const filename = pendingPath.split("/").pop() ?? "untitled.md";
			const livePath = `${this.memoryDir}/${filename}`;

			const liveContent = serializeNote({
				title: pending.title,
				body: pending.body,
				sources: pending.sources,
				createdAt: pending.createdAt || now,
			});
			await this.app.vault.adapter.write(livePath, liveContent);
			await updateLinkedToTimestamps(this.app, this.vault, pending.body, this.memoryDir, now);
		} else {
			// Update: write merged body back to the live note.
			const targetPath = pending.targetPath;
			if (!targetPath) return;

			const withExt = targetPath.endsWith(".md") ? targetPath : `${targetPath}.md`;
			const liveFile = this.app.vault.getFileByPath(withExt);
			if (!liveFile) return;

			const existing = await this.vault.read(liveFile);
			const parsed = parseNote(existing);

			const updated = serializeNote({
				title: parsed.title,
				body: pending.body,
				sources: parsed.sources,
				createdAt: parsed.createdAt || now,
			});
			await this.vault.modify(liveFile, updated);
			await updateLinkedToTimestamps(this.app, this.vault, pending.body, this.memoryDir, now);
		}

		await this.app.vault.adapter.remove(pendingPath);
	}

	/** Reject a single pending note: delete it from the pending dir. */
	async rejectSingle(pendingPath: string): Promise<void> {
		assertPendingMemoryPath(pendingPath, this.pendingDir);
		await this.app.vault.adapter.remove(pendingPath);
	}

	/** Approve all supplied pending paths in order. */
	async approveAll(pendingPaths: string[]): Promise<void> {
		for (const p of pendingPaths) {
			await this.approveSingle(p).catch(() => { /* skip failures */ });
		}
	}

	/** Reject all supplied pending paths. */
	async rejectAll(pendingPaths: string[]): Promise<void> {
		for (const p of pendingPaths) {
			await this.rejectSingle(p).catch(() => { /* skip failures */ });
		}
	}
}
