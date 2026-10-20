/**
 * McpHub + headersHelper end to end: a real SDK MCP server behind a fake login
 * proxy that only accepts the current session cookie and otherwise redirects
 * to a different-origin sign-in page.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as http from "http";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";

const logCalls: unknown[][] = [];
vi.mock("../utils/logger", () => {
	const record = (...args: unknown[]) => { logCalls.push(args); };
	return { logger: () => ({ debug: record, info: record, warn: record, error: record }) };
});
vi.mock("../shell/login-shell-path", () => ({
	resolveLoginShellPath: () => process.env.PATH ?? "",
}));

import { Platform } from "obsidian";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpHub } from "./mcp-hub";
import type { NotorSettings } from "../settings";
import type { McpServerConfig } from "./mcp-types";

const describePosix = process.platform === "win32" ? describe.skip : describe;
const SERVER = "proxied";

let proxy: http.Server;
let mcpUrl: string;
let workDir: string;
let helperFile: string;
let helperRuns: string;
/** Cookie value the proxy currently accepts. */
let validSession = "test-token";
/** Authorization headers the MCP server saw. */
let seenAuthorization: Array<string | undefined> = [];
let seenFixed: Array<string | undefined> = [];

function setHelperOutput(headers: Record<string, string>): void {
	writeFileSync(helperFile, JSON.stringify(headers));
}

function helperOutputFor(session: string): Record<string, string> {
	return { Authorization: "Bearer test-token-bearer", Cookie: `_proxy_session=${session}` };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

function makeHub(config: Partial<McpServerConfig>): McpHub {
	const hub = new McpHub("0.0.0-test", workDir);
	const settings = {
		mcp_servers: {
			[SERVER]: { name: SERVER, type: "streamableHttp", url: mcpUrl, ...config },
		},
		providers: [],
		active_provider: "local",
	} as unknown as NotorSettings;
	void hub.initialize(settings, { get: () => null });
	return hub;
}

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "notor-headers-helper-"));
	helperFile = join(workDir, "headers.json");
	helperRuns = join(workDir, "runs");

	proxy = http.createServer((req, res) => {
		if (req.headers.cookie !== `_proxy_session=${validSession}`) {
			res.writeHead(302, { location: "https://login.example.com/authorize?rd=mcp" });
			res.end("<html>sign in</html>");
			return;
		}
		seenAuthorization.push(req.headers.authorization);
		seenFixed.push(req.headers["x-fixed"] as string | undefined);

		const server = new McpServer({ name: "test", version: "1.0.0" });
		server.tool("ping", async () => ({ content: [{ type: "text", text: "pong" }] }));
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		res.on("close", () => { void transport.close(); void server.close(); });
		void server.connect(transport).then(() => transport.handleRequest(req, res));
	});
	await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
	mcpUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/mcp`;
});

afterAll(() => {
	proxy.closeAllConnections();
	proxy.close();
	rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
	validSession = "test-token";
	seenAuthorization = [];
	seenFixed = [];
	setHelperOutput(helperOutputFor("test-token"));
	writeFileSync(helperRuns, "");
});

afterEach(() => {
	Platform.isDesktopApp = true;
	// Every test in this file runs with test-token values — none may reach a log.
	const logged = JSON.stringify(logCalls);
	logCalls.length = 0;
	expect(logged).not.toContain("test-token");
});

/** Helper command: record a run, then print the current headers file. */
const helperCommand = () => `echo run >> '${helperRuns}'; cat '${helperFile}'`;

describePosix("McpHub with a headersHelper", () => {
	it("connects through the login proxy, helper headers overriding fixed ones", async () => {
		const hub = makeHub({
			headersHelper: helperCommand(),
			headers: [
				{ key: "Authorization", value: "Bearer fixed", sensitive: false },
				{ key: "X-Fixed", value: "1", sensitive: false },
			],
		});
		try {
			await waitFor(() => hub.getConnection(SERVER)?.status === "connected");
			const result = await hub.callTool(SERVER, "ping", {}, "act");
			expect(result).toMatchObject({ success: true, result: "pong" });
			expect(seenAuthorization.every((a) => a === "Bearer test-token-bearer")).toBe(true);
			expect(seenFixed.every((v) => v === "1")).toBe(true);
		} finally {
			await hub.dispose();
		}
	});

	it("re-runs the helper and retries when the session expires mid-connection", async () => {
		const hub = makeHub({ headersHelper: helperCommand() });
		try {
			await waitFor(() => hub.getConnection(SERVER)?.status === "connected");
			const { readFileSync } = await import("fs");
			const runsBefore = readFileSync(helperRuns, "utf8").split("\n").filter(Boolean).length;

			// The proxy rotates the session; the helper now prints the new cookie.
			validSession = "test-token-rotated";
			setHelperOutput(helperOutputFor("test-token-rotated"));

			const result = await hub.callTool(SERVER, "ping", {}, "act");
			expect(result).toMatchObject({ success: true, result: "pong" });
			expect(hub.getConnection(SERVER)?.status).toBe("connected");
			const runsAfter = readFileSync(helperRuns, "utf8").split("\n").filter(Boolean).length;
			expect(runsAfter).toBe(runsBefore + 1);
		} finally {
			await hub.dispose();
		}
	});

	it("falls into reconnect/backoff when the refreshed headers are still rejected", async () => {
		const hub = makeHub({ headersHelper: helperCommand() });
		try {
			await waitFor(() => hub.getConnection(SERVER)?.status === "connected");

			// Session expires and the helper keeps printing the stale cookie.
			validSession = "test-token-rotated";
			const result = await hub.callTool(SERVER, "ping", {}, "act");
			expect(result.success).toBe(false);
			expect(result.error).toContain("Authentication failed after refreshing headers (HTTP 302).");
			expect(result.error).not.toContain("sign in");

			await waitFor(() => hub.getConnection(SERVER)?.status === "error");
			expect(hub.getConnection(SERVER)?.error).toBe("Authentication failed after refreshing headers (HTTP 302).");

			// The helper recovers; the scheduled reconnect re-runs it and connects.
			setHelperOutput(helperOutputFor("test-token-rotated"));
			await waitFor(() => hub.getConnection(SERVER)?.status === "connected", 8_000);
		} finally {
			await hub.dispose();
		}
	}, 15_000);

	it("surfaces a failing helper's stderr in the connection error and keeps retrying", async () => {
		const hub = makeHub({ headersHelper: `cat '${helperFile}'; echo "login required" >&2; exit 2` });
		try {
			await waitFor(() => hub.getConnection(SERVER)?.status === "error");
			const error = hub.getConnection(SERVER)?.error ?? "";
			expect(error).toBe("headersHelper failed (exit 2): login required");
			expect((hub as unknown as { reconnectTimers: Map<string, unknown> }).reconnectTimers.has(SERVER)).toBe(true);
		} finally {
			await hub.dispose();
		}
	});

	it("fails with a clear message on mobile and does not schedule a reconnect", async () => {
		Platform.isDesktopApp = false;
		const hub = makeHub({ headersHelper: helperCommand() });
		try {
			await waitFor(() => hub.getConnection(SERVER)?.status === "error");
			expect(hub.getConnection(SERVER)?.error).toBe("headersHelper requires the Obsidian desktop app.");
			expect((hub as unknown as { reconnectTimers: Map<string, unknown> }).reconnectTimers.has(SERVER)).toBe(false);
		} finally {
			await hub.dispose();
		}
	});
});
