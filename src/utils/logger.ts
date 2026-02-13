/**
 * Structured logger for the Obsidian plugin.
 *
 * Outputs JSON-formatted log entries via console.log so they can be
 * captured by Playwright through the Chrome DevTools Protocol (CDP).
 *
 * Each log entry includes:
 *  - timestamp (ISO 8601)
 *  - level (debug | info | warn | error)
 *  - source (component that emitted the log)
 *  - message (human-readable description)
 *  - data (optional structured payload)
 *
 * Usage:
 *   import { logger } from "./utils/logger";
 *   const log = logger("MyComponent");
 *   log.info("Something happened", { key: "value" });
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
	timestamp: string;
	level: LogLevel;
	source: string;
	message: string;
	data?: unknown;
}

/** Prefix used to identify structured log lines among other console output. */
export const LOG_PREFIX = "[NOTOR_LOG]";

function emit(level: LogLevel, source: string, message: string, data?: unknown): void {
	const entry: LogEntry = {
		timestamp: new Date().toISOString(),
		level,
		source,
		message,
		...(data !== undefined && { data }),
	};

	const line = `${LOG_PREFIX} ${JSON.stringify(entry)}`;

	switch (level) {
		case "debug":
			console.debug(line);
			break;
		case "info":
			console.log(line);
			break;
		case "warn":
			console.warn(line);
			break;
		case "error":
			console.error(line);
			break;
	}
}

export interface Logger {
	debug(message: string, data?: unknown): void;
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
}

/**
 * Create a scoped logger for a specific component / module.
 *
 * @param source - identifier for the component (e.g. "Settings", "CommandPalette")
 */
export function logger(source: string): Logger {
	return {
		debug: (message: string, data?: unknown) => emit("debug", source, message, data),
		info: (message: string, data?: unknown) => emit("info", source, message, data),
		warn: (message: string, data?: unknown) => emit("warn", source, message, data),
		error: (message: string, data?: unknown) => emit("error", source, message, data),
	};
}