/**
 * `headersHelper` — dynamic HTTP headers for MCP servers.
 *
 * Runs a user-configured shell command and parses the JSON object it prints on
 * stdout into request headers. The contract mirrors Claude Code's
 * `headersHelper` (same env var names, same output shape, same 10 s timeout) so
 * helper scripts written for Claude Code work unchanged.
 *
 * Secret hygiene: stdout carries credentials. It is never logged, and no error
 * raised here includes any part of it — only stderr excerpts and header names.
 *
 * @see specs/04d-mcp-headers-helper/spec.md — FR-181
 */

import { spawn, type ChildProcess } from "child_process";
import { Platform } from "obsidian";
import { resolveLoginShellPath } from "../shell/login-shell-path";
import { logger } from "../utils/logger";

const log = logger("McpHeadersHelper");

/** Helper timeout (matches Claude Code). */
export const HEADERS_HELPER_TIMEOUT_MS = 10_000;

/** Grace period after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 1_000;

/** Maximum stdout accepted from a helper. */
const MAX_STDOUT_BYTES = 64 * 1024;

/** Stderr retained for error messages (tail). */
const MAX_STDERR_CHARS = 2_000;

/** Stderr excerpt length included in an error message. */
const STDERR_EXCERPT_CHARS = 500;

/** RFC 9110 `token` — valid header field names. */
const HEADER_NAME_REGEX = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Characters that would allow header injection / are rejected by Node. */
const HEADER_VALUE_FORBIDDEN = /[\r\n\0]/;

/** A failure running the helper or interpreting its output. */
export class HeadersHelperError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HeadersHelperError";
	}
}

/**
 * A configuration problem that retrying cannot fix (e.g. the helper cannot run
 * on this platform). McpHub skips auto-reconnect for these.
 */
export class McpConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpConfigError";
	}
}

/**
 * Parse and validate helper stdout into a header map.
 *
 * Throws {@link HeadersHelperError} whose message never contains the output —
 * notably `JSON.parse`'s own message is discarded, because V8 quotes the input.
 */
export function parseHeadersHelperOutput(stdout: string): Record<string, string> {
	const text = stdout.trim();
	if (!text) {
		throw new HeadersHelperError("headersHelper produced no output (expected a JSON object of string values).");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new HeadersHelperError("headersHelper output is not valid JSON (expected a JSON object of string values).");
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		const kind = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : `a ${typeof parsed}`;
		throw new HeadersHelperError(`headersHelper output must be a JSON object, got ${kind}.`);
	}

	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!HEADER_NAME_REGEX.test(name)) {
			throw new HeadersHelperError("headersHelper output contains an invalid header name.");
		}
		if (typeof value !== "string") {
			throw new HeadersHelperError(`headersHelper value for "${name}" must be a string, got ${value === null ? "null" : typeof value}.`);
		}
		if (HEADER_VALUE_FORBIDDEN.test(value)) {
			throw new HeadersHelperError(`headersHelper value for "${name}" contains a line break or NUL character.`);
		}
		headers[name] = value;
	}
	return headers;
}

/** Where and for which server a helper runs. */
export interface HeadersHelperContext {
	/** Server name — exported as `CLAUDE_CODE_MCP_SERVER_NAME`. */
	serverName: string;
	/** Server URL — exported as `CLAUDE_CODE_MCP_SERVER_URL`. */
	url: string;
	/** Working directory (the vault root). */
	cwd: string;
	/** Test seam — override {@link HEADERS_HELPER_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/** Environment for the helper: plugin env + login PATH + server identity. */
export function buildHeadersHelperEnv(ctx: HeadersHelperContext): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) env[k] = v;
	}
	const loginPath = resolveLoginShellPath();
	if (loginPath) env.PATH = loginPath;

	env.CLAUDE_CODE_MCP_SERVER_NAME = ctx.serverName;
	env.CLAUDE_CODE_MCP_SERVER_URL = ctx.url;
	env.NOTOR_MCP_SERVER_NAME = ctx.serverName;
	env.NOTOR_MCP_SERVER_URL = ctx.url;
	return env;
}

/** Last part of stderr, whitespace-collapsed, for an error message. */
function stderrExcerpt(stderr: string): string {
	const collapsed = stderr.replace(/\s+/g, " ").trim();
	if (!collapsed) return "";
	return collapsed.length > STDERR_EXCERPT_CHARS
		? `…${collapsed.slice(-STDERR_EXCERPT_CHARS)}`
		: collapsed;
}

/**
 * Spawn the helper in the user's shell.
 *
 * Deliberately not a login shell (`-l`): profile scripts that echo would
 * corrupt the JSON on stdout. The login PATH is injected via env instead.
 */
function spawnHelper(command: string, ctx: HeadersHelperContext): ChildProcess {
	const options = {
		cwd: ctx.cwd,
		env: buildHeadersHelperEnv(ctx),
		stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
	};
	if (process.platform === "win32") {
		return spawn(command, { ...options, shell: true });
	}
	return spawn(process.env.SHELL || "/bin/sh", ["-c", command], options);
}

/**
 * Run a `headersHelper` command and return the headers it prints.
 *
 * @throws McpConfigError when a shell cannot be spawned on this platform
 * @throws HeadersHelperError on spawn failure, non-zero exit, timeout, or bad output
 */
export async function runHeadersHelper(
	command: string,
	ctx: HeadersHelperContext
): Promise<Record<string, string>> {
	if (!Platform.isDesktopApp) {
		throw new McpConfigError("headersHelper requires the Obsidian desktop app.");
	}

	const timeoutMs = ctx.timeoutMs ?? HEADERS_HELPER_TIMEOUT_MS;
	const startedAt = Date.now();
	log.debug("Running headersHelper", { serverName: ctx.serverName });

	const stdout = await new Promise<string>((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawnHelper(command, ctx);
		} catch (e) {
			reject(new HeadersHelperError(`headersHelper could not be started: ${e instanceof Error ? e.message : String(e)}`));
			return;
		}

		const stdoutChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderr = "";
		let failure: HeadersHelperError | null = null;
		let graceTimer: ReturnType<typeof setTimeout> | null = null;

		const kill = () => {
			child.kill("SIGTERM");
			graceTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		};

		const timer = setTimeout(() => {
			failure = new HeadersHelperError(`headersHelper timed out after ${Math.round(timeoutMs / 1000)}s.`);
			kill();
		}, timeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > MAX_STDOUT_BYTES) {
				if (!failure) {
					failure = new HeadersHelperError(`headersHelper output exceeded ${MAX_STDOUT_BYTES / 1024} KB.`);
					kill();
				}
				return;
			}
			stdoutChunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-MAX_STDERR_CHARS);
		});

		child.on("error", (e) => {
			clearTimeout(timer);
			if (graceTimer) clearTimeout(graceTimer);
			reject(new HeadersHelperError(`headersHelper could not be started: ${e.message}`));
		});

		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (graceTimer) clearTimeout(graceTimer);
			if (failure) {
				reject(failure);
				return;
			}
			if (code !== 0) {
				const how = code === null ? `killed by ${signal ?? "signal"}` : `exit ${code}`;
				const excerpt = stderrExcerpt(stderr);
				reject(new HeadersHelperError(`headersHelper failed (${how})${excerpt ? `: ${excerpt}` : "."}`));
				return;
			}
			resolve(Buffer.concat(stdoutChunks).toString("utf8"));
		});
	});

	const headers = parseHeadersHelperOutput(stdout);
	log.debug("headersHelper completed", {
		serverName: ctx.serverName,
		durationMs: Date.now() - startedAt,
		headerKeys: Object.keys(headers),
	});
	return headers;
}
