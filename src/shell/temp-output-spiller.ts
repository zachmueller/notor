/**
 * Temp output spiller — writes truncated tool output to temporary files
 * so the AI can access it via `read_file` instead of losing it permanently.
 *
 * Provides two modes:
 * 1. One-shot: full content in memory → write to disk (fetch_webpage, dispatcher)
 * 2. Incremental: stream chunks to disk as they arrive (OutputBuffer/execute_command)
 */

import { tmpdir } from "os";
import { join } from "path";
import { promises as fs, createWriteStream, type WriteStream } from "fs";
import { randomUUID } from "crypto";
import { Platform } from "obsidian";
import { logger } from "../utils/logger";

const log = logger("TempOutputSpiller");

const NOTOR_SPILL_DIR = "notor-spillover";
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/** Handle for incremental disk writing used by OutputBuffer. */
export interface IncrementalSpiller {
	/** Absolute path where overflow data is being written. */
	filePath: string;
	/** Write a chunk of overflow data to disk. */
	write: (chunk: string) => void;
	/** Flush and close the stream. Returns total overflow chars written. */
	finalize: () => Promise<{ overflowChars: number }>;
}

export class TempOutputSpiller {
	private trackedFiles = new Set<string>();
	readonly spillDir: string;

	constructor() {
		this.spillDir = join(tmpdir(), NOTOR_SPILL_DIR);
	}

	async ensureSpillDir(): Promise<void> {
		try {
			await fs.mkdir(this.spillDir, { recursive: true });
		} catch (e) {
			log.error("Failed to create spillover directory", { dir: this.spillDir, error: String(e) });
			throw e;
		}
	}

	/**
	 * Remove stale spillover files from previous sessions (older than 1 hour).
	 */
	async cleanupStale(): Promise<void> {
		if (!Platform.isDesktopApp) return;
		try {
			const entries = await fs.readdir(this.spillDir);
			const now = Date.now();
			for (const entry of entries) {
				const filePath = join(this.spillDir, entry);
				try {
					const stat = await fs.stat(filePath);
					if (now - stat.mtimeMs > STALE_THRESHOLD_MS) {
						await fs.unlink(filePath);
						log.info("Removed stale spillover file", { filePath });
					}
				} catch { /* file may have been removed concurrently */ }
			}
		} catch (e) {
			// spillDir may not exist yet on first run
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
				log.warn("Failed to clean stale spillover files", { error: String(e) });
			}
		}
	}

	generatePath(toolName: string): string {
		const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 30);
		const filename = `notor-spillover-${safeName}-${randomUUID().slice(0, 8)}.txt`;
		return join(this.spillDir, filename);
	}

	/**
	 * Write full content to a temp file and return the formatted spillover message.
	 *
	 * Used by fetch_webpage and the dispatcher-level generic check where the
	 * full content is already in memory.
	 */
	async spillToFile(
		toolName: string,
		fullContent: string,
		truncatedContent: string,
		maxChars: number,
	): Promise<string> {
		const filePath = this.generatePath(toolName);
		try {
			await fs.writeFile(filePath, fullContent, "utf-8");
			this.trackedFiles.add(filePath);
			log.info("Spilled output to temp file", {
				toolName,
				filePath,
				totalChars: fullContent.length,
				maxChars,
			});
			return this.formatSpilloverMessage(truncatedContent, filePath, fullContent.length, maxChars);
		} catch (e) {
			log.error("Failed to write spillover file, falling back to truncation", {
				toolName,
				filePath,
				error: String(e),
			});
			return truncatedContent + `\n\n[Output truncated at ${maxChars.toLocaleString()} characters. Spillover write failed.]`;
		}
	}

	/**
	 * Create an incremental spiller for streaming overflow to disk.
	 *
	 * Used by OutputBuffer when capturing execute_command output that
	 * exceeds the character cap. Writes directly to disk without holding
	 * overflow in memory.
	 */
	createIncrementalSpiller(toolName: string): IncrementalSpiller {
		const filePath = this.generatePath(toolName);
		let stream: WriteStream | null = null;
		let overflowChars = 0;
		let writeError = false;

		const getStream = (): WriteStream | null => {
			if (writeError) return null;
			if (!stream) {
				try {
					stream = createWriteStream(filePath, { encoding: "utf-8" });
					stream.on("error", (err) => {
						writeError = true;
						log.error("Incremental spiller write stream error", { filePath, error: String(err) });
					});
					this.trackedFiles.add(filePath);
				} catch (e) {
					writeError = true;
					log.error("Failed to create spiller write stream", { filePath, error: String(e) });
					return null;
				}
			}
			return stream;
		};

		return {
			filePath,
			write: (chunk: string) => {
				const s = getStream();
				if (s && !writeError) {
					s.write(chunk);
					overflowChars += chunk.length;
				}
			},
			finalize: async () => {
				if (stream) {
					await new Promise<void>((resolve, reject) => {
						stream!.end(() => resolve());
						stream!.on("error", reject);
					});
				}
				if (writeError || overflowChars === 0) {
					// Clean up empty/failed file
					try { await fs.unlink(filePath); } catch { /* ignore */ }
					this.trackedFiles.delete(filePath);
				}
				return { overflowChars };
			},
		};
	}

	/**
	 * Format the message returned to the AI when output is spilled to disk.
	 */
	formatSpilloverMessage(
		truncatedContent: string,
		filePath: string,
		totalChars: number,
		_maxChars: number,
	): string {
		return (
			truncatedContent +
			`\n\n---\n[Output truncated — full output (${totalChars.toLocaleString()} characters) saved to: ${filePath}]\n` +
			`[Use read_file with the path above to access the complete output.]`
		);
	}

	/** Delete all tracked temp files. Called on plugin unload. */
	async cleanup(): Promise<void> {
		const files = [...this.trackedFiles];
		this.trackedFiles.clear();
		const results = await Promise.allSettled(
			files.map((f) => fs.unlink(f)),
		);
		const failures = results.filter((r) => r.status === "rejected");
		if (failures.length > 0) {
			log.warn("Some spillover files could not be deleted", { count: failures.length });
		} else if (files.length > 0) {
			log.info("Cleaned up spillover files", { count: files.length });
		}
	}

	/** Get the spillover directory path (for allowed_paths augmentation). */
	getSpillDir(): string {
		return this.spillDir;
	}
}
