/**
 * Output buffer — captures combined stdout+stderr from a child process
 * into a single string with a configurable character cap.
 *
 * When the cap is exceeded, the buffer is frozen and a truncation notice
 * is appended to the final output.
 *
 * @see specs/02-context-intelligence/research.md § R-3
 */

/** Default maximum character count for output buffering. */
const DEFAULT_MAX_CHARS = 50_000;

/**
 * Mutable buffer that accumulates process output with a size cap.
 *
 * Usage:
 * ```ts
 * const buf = new OutputBuffer(50000);
 * child.stdout.on('data', (d) => buf.append(d));
 * child.stderr.on('data', (d) => buf.append(d));
 * // After process exits:
 * const result = buf.toString();
 * const wasTruncated = buf.truncated;
 * ```
 */
export class OutputBuffer {
	private chunks: string[] = [];
	private length = 0;
	private _truncated = false;
	private readonly maxChars: number;

	/**
	 * @param maxChars - Maximum number of characters to retain.
	 *                   Defaults to 50,000.
	 */
	constructor(maxChars: number = DEFAULT_MAX_CHARS) {
		this.maxChars = maxChars;
	}

	/** Whether the output was truncated because it exceeded the cap. */
	get truncated(): boolean {
		return this._truncated;
	}

	/**
	 * Append data (Buffer or string) to the output buffer.
	 *
	 * Once the cap is reached, subsequent calls are silently ignored.
	 */
	append(data: Buffer | string): void {
		if (this._truncated) return;

		const str = typeof data === "string" ? data : data.toString("utf-8");
		const remaining = this.maxChars - this.length;

		if (str.length <= remaining) {
			this.chunks.push(str);
			this.length += str.length;
		} else {
			// Take only what fits
			this.chunks.push(str.substring(0, remaining));
			this.length = this.maxChars;
			this._truncated = true;
		}
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