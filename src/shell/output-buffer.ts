/**
 * Output buffer — captures combined stdout+stderr from a child process
 * into a single string with a configurable character cap.
 *
 * When the cap is exceeded, the buffer is frozen and a truncation notice
 * is appended to the final output. If an {@link IncrementalSpiller} is
 * provided, overflow data is streamed to disk instead of being discarded.
 *
 * @see specs/02-context-intelligence/research.md § R-3
 */

import type { IncrementalSpiller } from "./temp-output-spiller";

/** Default maximum character count for output buffering. */
const DEFAULT_MAX_CHARS = 50_000;

/**
 * Mutable buffer that accumulates process output with a size cap.
 *
 * Usage:
 * ```ts
 * const buf = new OutputBuffer(50000, spiller);
 * child.stdout.on('data', (d) => buf.append(d));
 * child.stderr.on('data', (d) => buf.append(d));
 * // After process exits:
 * await buf.finalizeSpillover();
 * const result = buf.toString();
 * const wasTruncated = buf.truncated;
 * ```
 */
export class OutputBuffer {
	private chunks: string[] = [];
	private length = 0;
	private _truncated = false;
	private readonly maxChars: number;
	private readonly spillover?: IncrementalSpiller;
	private _totalLength = 0;

	/**
	 * @param maxChars - Maximum number of characters to retain in memory.
	 *                   Defaults to 50,000.
	 * @param spillover - Optional incremental spiller. When provided, overflow
	 *                    data is written to disk instead of being discarded.
	 */
	constructor(maxChars: number = DEFAULT_MAX_CHARS, spillover?: IncrementalSpiller) {
		this.maxChars = maxChars;
		this.spillover = spillover;
	}

	/** Whether the output was truncated because it exceeded the cap. */
	get truncated(): boolean {
		return this._truncated;
	}

	/** Total character count including overflow written to disk. */
	get totalLength(): number {
		return this._totalLength;
	}

	/** Path to the spillover file, if one was created. */
	get spillFilePath(): string | undefined {
		return this.spillover?.filePath;
	}

	/**
	 * Append data (Buffer or string) to the output buffer.
	 *
	 * Once the cap is reached, subsequent data is routed to the spillover
	 * writer (if available) or silently ignored.
	 */
	append(data: Buffer | string): void {
		const str = typeof data === "string" ? data : data.toString("utf-8");
		this._totalLength += str.length;

		if (this._truncated) {
			this.spillover?.write(str);
			return;
		}

		const remaining = this.maxChars - this.length;

		if (str.length <= remaining) {
			this.chunks.push(str);
			this.length += str.length;
		} else {
			// Take only what fits in memory
			this.chunks.push(str.substring(0, remaining));
			this.length = this.maxChars;
			this._truncated = true;
			// Route the overflow portion to disk
			const overflow = str.substring(remaining);
			if (overflow.length > 0) {
				this.spillover?.write(overflow);
			}
		}
	}

	/**
	 * Finalize the spillover stream (flush and close).
	 * Must be called after the process exits and before reading results.
	 */
	async finalizeSpillover(): Promise<{ overflowChars: number } | undefined> {
		return this.spillover?.finalize();
	}

	/**
	 * Return the accumulated output as a single string.
	 *
	 * If truncated, a notice is appended indicating the cap.
	 */
	toString(): string {
		const output = this.chunks.join("");
		if (this._truncated) {
			return output + `\n[Output truncated at ${this.maxChars.toLocaleString()} characters]`;
		}
		return output;
	}
}
