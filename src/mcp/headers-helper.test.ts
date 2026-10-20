import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "os";

const logCalls: unknown[][] = [];
vi.mock("../utils/logger", () => {
	const record = (...args: unknown[]) => { logCalls.push(args); };
	return { logger: () => ({ debug: record, info: record, warn: record, error: record }) };
});
vi.mock("../shell/login-shell-path", () => ({
	resolveLoginShellPath: () => process.env.PATH ?? "",
}));

import { Platform } from "obsidian";
import {
	HeadersHelperError,
	McpConfigError,
	parseHeadersHelperOutput,
	runHeadersHelper,
} from "./headers-helper";

const ctx = { serverName: "test-server", url: "https://mcp.example.com/mcp", cwd: tmpdir() };
const posixOnly = process.platform === "win32" ? it.skip : it;

afterEach(() => {
	Platform.isDesktopApp = true;
	logCalls.length = 0;
});

/** Expect `fn` to throw a HeadersHelperError whose message omits `secret`. */
function expectSafeError(fn: () => unknown, secret: string, pattern: RegExp): void {
	let err: unknown;
	try { fn(); } catch (e) { err = e; }
	expect(err).toBeInstanceOf(HeadersHelperError);
	expect((err as Error).message).toMatch(pattern);
	expect((err as Error).message).not.toContain(secret);
}

describe("parseHeadersHelperOutput", () => {
	it("parses a JSON object of string values, tolerating surrounding whitespace", () => {
		expect(parseHeadersHelperOutput('\n {"Authorization":"Bearer test-token","Cookie":"_proxy_session=test-token"}\n'))
			.toEqual({ Authorization: "Bearer test-token", Cookie: "_proxy_session=test-token" });
	});

	it("accepts an empty object", () => {
		expect(parseHeadersHelperOutput("{}")).toEqual({});
	});

	it("rejects empty or whitespace-only output", () => {
		expect(() => parseHeadersHelperOutput("")).toThrow(/no output/);
		expect(() => parseHeadersHelperOutput("  \n\t")).toThrow(/no output/);
	});

	it("rejects invalid JSON without echoing the output", () => {
		expectSafeError(() => parseHeadersHelperOutput("Bearer test-token"), "test-token", /not valid JSON/);
		expectSafeError(() => parseHeadersHelperOutput('{"Authorization": "Bearer test-token"'), "test-token", /not valid JSON/);
	});

	it("rejects non-object JSON", () => {
		expect(() => parseHeadersHelperOutput('["test-token"]')).toThrow(/must be a JSON object, got an array/);
		expect(() => parseHeadersHelperOutput("null")).toThrow(/got null/);
		expect(() => parseHeadersHelperOutput("42")).toThrow(/got a number/);
		expectSafeError(() => parseHeadersHelperOutput('"test-token"'), "test-token", /got a string/);
	});

	it("rejects non-string values, naming the header but not the value", () => {
		expect(() => parseHeadersHelperOutput('{"X-Count": 3}')).toThrow(/"X-Count" must be a string, got number/);
		expect(() => parseHeadersHelperOutput('{"X-Null": null}')).toThrow(/got null/);
		expect(() => parseHeadersHelperOutput('{"X-Obj": {"token":"test-token"}}')).toThrow(/got object/);
	});

	it("rejects invalid header names without echoing them", () => {
		expectSafeError(() => parseHeadersHelperOutput('{"Bearer test-token": "x"}'), "test-token", /invalid header name/);
	});

	it("rejects values containing line breaks", () => {
		expectSafeError(
			() => parseHeadersHelperOutput('{"Cookie": "a=test-token\\r\\nX-Injected: 1"}'),
			"test-token",
			/"Cookie" contains a line break/
		);
	});
});

describe("runHeadersHelper", () => {
	posixOnly("returns the parsed headers from stdout", async () => {
		const headers = await runHeadersHelper(`printf '%s' '{"Authorization":"Bearer test-token"}'`, ctx);
		expect(headers).toEqual({ Authorization: "Bearer test-token" });
	});

	posixOnly("passes the Claude Code and Notor server env vars to the helper", async () => {
		const headers = await runHeadersHelper(
			`printf '{"name":"%s","url":"%s","nname":"%s","nurl":"%s"}' "$CLAUDE_CODE_MCP_SERVER_NAME" "$CLAUDE_CODE_MCP_SERVER_URL" "$NOTOR_MCP_SERVER_NAME" "$NOTOR_MCP_SERVER_URL"`,
			ctx
		);
		expect(headers).toEqual({
			name: "test-server",
			url: "https://mcp.example.com/mcp",
			nname: "test-server",
			nurl: "https://mcp.example.com/mcp",
		});
	});

	posixOnly("runs in the given working directory", async () => {
		const headers = await runHeadersHelper(`printf '{"cwd":"%s"}' "$(pwd -P)"`, { ...ctx, cwd: "/" });
		expect(headers).toEqual({ cwd: "/" });
	});

	posixOnly("reports a non-zero exit with a stderr excerpt and never stdout", async () => {
		const err = await runHeadersHelper(
			`printf '%s' '{"Authorization":"Bearer test-token"}'; echo "login required" >&2; exit 3`,
			ctx
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(HeadersHelperError);
		expect((err as Error).message).toBe("headersHelper failed (exit 3): login required");
		expect((err as Error).message).not.toContain("test-token");
	});

	posixOnly("reports a non-zero exit with no stderr", async () => {
		await expect(runHeadersHelper("exit 1", ctx)).rejects.toThrow("headersHelper failed (exit 1).");
	});

	posixOnly("times out a helper that hangs", async () => {
		const started = Date.now();
		await expect(runHeadersHelper("sleep 5", { ...ctx, timeoutMs: 200 })).rejects.toThrow(/timed out/);
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	posixOnly("rejects invalid output from a successful helper without echoing it", async () => {
		const err = await runHeadersHelper("echo Bearer test-token", ctx).catch((e: unknown) => e);
		expect((err as Error).message).toMatch(/not valid JSON/);
		expect((err as Error).message).not.toContain("test-token");
	});

	posixOnly("rejects empty output", async () => {
		await expect(runHeadersHelper("true", ctx)).rejects.toThrow(/no output/);
	});

	posixOnly("never logs header values", async () => {
		await runHeadersHelper(`printf '%s' '{"Cookie":"_proxy_session=test-token"}'`, ctx);
		expect(logCalls.length).toBeGreaterThan(0);
		expect(JSON.stringify(logCalls)).not.toContain("test-token");
		expect(JSON.stringify(logCalls)).toContain("Cookie");
	});

	it("fails with a configuration error on mobile", async () => {
		Platform.isDesktopApp = false;
		const err = await runHeadersHelper("true", ctx).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(McpConfigError);
		expect((err as Error).message).toBe("headersHelper requires the Obsidian desktop app.");
	});
});
