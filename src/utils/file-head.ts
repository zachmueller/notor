/**
 * Read just the first line of a vault file — e.g. a JSONL header — without
 * reading the whole file.
 *
 * On the desktop file-system adapter (Notor is desktop-only) this reads at most
 * `maxBytes` from the start of the file via Node `fs` and cuts at the first
 * newline byte (byte-level, so a multi-byte character split at the buffer end
 * can't corrupt the line). If no newline appears within `maxBytes`, or the
 * adapter has no file-system paths, it falls back to a full `adapter.read`.
 */

import { promises as fsPromises } from "fs";
import type { DataAdapter } from "obsidian";

/** Default bytes read from the start of a file when looking for its first line. */
export const FIRST_LINE_READ_BYTES = 16 * 1024;

type FileHandleLike = {
	read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
	close(): Promise<void>;
};

/** The subset of `fs.promises` used here (injectable for tests). */
export interface FirstLineFs {
	open(path: string, flags: string): Promise<FileHandleLike>;
}

export async function readFirstLine(
	adapter: DataAdapter,
	path: string,
	maxBytes = FIRST_LINE_READ_BYTES,
	fsApi: FirstLineFs = fsPromises,
): Promise<string> {
	const getFullPath = (adapter as { getFullPath?: (p: string) => string }).getFullPath;
	if (typeof getFullPath === "function") {
		const handle = await fsApi.open(getFullPath.call(adapter, path), "r");
		try {
			const buffer = Buffer.alloc(maxBytes);
			const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
			const head = buffer.subarray(0, bytesRead);
			const newline = head.indexOf(0x0a);
			if (newline >= 0) return head.subarray(0, newline).toString("utf8");
			// The whole file fit and has no newline: it is the first line.
			if (bytesRead < maxBytes) return head.toString("utf8");
		} finally {
			await handle.close();
		}
	}
	const content = await adapter.read(path);
	const newline = content.indexOf("\n");
	return newline >= 0 ? content.slice(0, newline) : content;
}
