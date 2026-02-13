/**
 * Log Collector
 *
 * Captures structured logs from Obsidian's console via Playwright's CDP
 * connection and writes them to JSONL files on disk that Cline can read.
 *
 * The collector:
 *  1. Listens to console events on a Playwright Page
 *  2. Filters for structured log entries (prefixed with [NOTOR_LOG])
 *  3. Writes each entry as a JSON line to a .jsonl file
 *  4. Optionally also captures unstructured console output
 *  5. Writes a summary file at the end for quick Cline review
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Page, ConsoleMessage } from "playwright-core";

const LOG_PREFIX = "[NOTOR_LOG]";

export interface CollectorOptions {
	/** Directory to write log files into */
	outputDir: string;
	/** Also capture non-structured console output (default: true) */
	captureAll?: boolean;
	/** Maximum log entries before rotating (default: 10000) */
	maxEntries?: number;
}

export interface LogEntry {
	timestamp: string;
	level: string;
	source: string;
	message: string;
	data?: unknown;
}

export interface RawConsoleEntry {
	timestamp: string;
	type: string;
	text: string;
}

export class LogCollector {
	private structuredLogs: LogEntry[] = [];
	private rawLogs: RawConsoleEntry[] = [];
	private structuredStream: fs.WriteStream;
	private rawStream: fs.WriteStream | null = null;
	private options: Required<CollectorOptions>;
	private disposed = false;

	constructor(options: CollectorOptions) {
		this.options = {
			captureAll: true,
			maxEntries: 10_000,
			...options,
		};

		// Ensure output directory exists
		fs.mkdirSync(this.options.outputDir, { recursive: true });

		// Open write streams
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		this.structuredStream = fs.createWriteStream(
			path.join(this.options.outputDir, `plugin-logs-${timestamp}.jsonl`),
			{ flags: "a" }
		);

		if (this.options.captureAll) {
			this.rawStream = fs.createWriteStream(
				path.join(this.options.outputDir, `console-all-${timestamp}.jsonl`),
				{ flags: "a" }
			);
		}
	}

	/**
	 * Attach to a Playwright page and start collecting console logs.
	 */
	attach(page: Page): void {
		page.on("console", (msg: ConsoleMessage) => {
			this.handleConsoleMessage(msg);
		});

		page.on("pageerror", (error: Error) => {
			const entry: LogEntry = {
				timestamp: new Date().toISOString(),
				level: "error",
				source: "page-error",
				message: error.message,
				data: { stack: error.stack },
			};
			this.writeStructured(entry);
		});
	}

	private handleConsoleMessage(msg: ConsoleMessage): void {
		const text = msg.text();
		const msgType = msg.type();

		// Capture raw console output
		if (this.options.captureAll && this.rawStream) {
			const raw: RawConsoleEntry = {
				timestamp: new Date().toISOString(),
				type: msgType,
				text,
			};
			this.rawLogs.push(raw);
			this.rawStream.write(JSON.stringify(raw) + "\n");
		}

		// Check for structured log entries
		if (text.startsWith(LOG_PREFIX)) {
			try {
				const jsonStr = text.slice(LOG_PREFIX.length).trim();
				const entry: LogEntry = JSON.parse(jsonStr);
				this.writeStructured(entry);
			} catch (err) {
				// Failed to parse structured log — record as raw error
				const fallback: LogEntry = {
					timestamp: new Date().toISOString(),
					level: "warn",
					source: "log-collector",
					message: "Failed to parse structured log entry",
					data: { rawText: text, error: String(err) },
				};
				this.writeStructured(fallback);
			}
		}
	}

	private writeStructured(entry: LogEntry): void {
		if (this.disposed) return;

		this.structuredLogs.push(entry);
		this.structuredStream.write(JSON.stringify(entry) + "\n");

		// Rotate if needed
		if (this.structuredLogs.length > this.options.maxEntries) {
			this.structuredLogs = this.structuredLogs.slice(-Math.floor(this.options.maxEntries / 2));
		}
	}

	/**
	 * Get all structured log entries collected so far.
	 */
	getStructuredLogs(): LogEntry[] {
		return [...this.structuredLogs];
	}

	/**
	 * Get log entries filtered by level.
	 */
	getLogsByLevel(level: string): LogEntry[] {
		return this.structuredLogs.filter((e) => e.level === level);
	}

	/**
	 * Get log entries filtered by source component.
	 */
	getLogsBySource(source: string): LogEntry[] {
		return this.structuredLogs.filter((e) => e.source === source);
	}

	/**
	 * Check if any error-level logs have been captured.
	 */
	hasErrors(): boolean {
		return this.structuredLogs.some((e) => e.level === "error");
	}

	/**
	 * Write a summary file with stats and recent errors for quick Cline review.
	 * This is the primary file Cline reads to understand plugin state.
	 */
	async writeSummary(): Promise<string> {
		const summaryPath = path.join(this.options.outputDir, "latest-summary.json");

		const errors = this.getLogsByLevel("error");
		const warnings = this.getLogsByLevel("warn");

		const summary = {
			generatedAt: new Date().toISOString(),
			stats: {
				totalEntries: this.structuredLogs.length,
				errors: errors.length,
				warnings: warnings.length,
				sources: [...new Set(this.structuredLogs.map((e) => e.source))],
			},
			recentErrors: errors.slice(-20),
			recentWarnings: warnings.slice(-10),
			lastEntries: this.structuredLogs.slice(-30),
		};

		fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
		return summaryPath;
	}

	/**
	 * Close all streams and finalize logs.
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;

		await this.writeSummary();

		return new Promise((resolve) => {
			this.structuredStream.end(() => {
				if (this.rawStream) {
					this.rawStream.end(() => resolve());
				} else {
					resolve();
				}
			});
		});
	}
}