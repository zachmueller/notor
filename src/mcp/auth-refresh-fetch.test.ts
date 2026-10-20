import { describe, it, expect, vi, afterEach } from "vitest";

const logCalls: unknown[][] = [];
vi.mock("../utils/logger", () => {
	const record = (...args: unknown[]) => { logCalls.push(args); };
	return { logger: () => ({ debug: record, info: record, warn: record, error: record }) };
});

import { createAuthRefreshFetch, isAuthFailure } from "./auth-refresh-fetch";

const SERVER = "https://mcp.example.com/mcp";

interface Sent { url: string; headers: Record<string, string>; body: unknown; method: string | undefined }

/** A scripted base fetch: answers each call with the next queued responder. */
function scriptedFetch(...responders: Array<(sent: Sent) => Response>) {
	const sent: Sent[] = [];
	const fetch = vi.fn((url: string | URL, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
		const call = { url: String(url), headers, body: init?.body, method: init?.method };
		sent.push(call);
		const responder = responders[Math.min(sent.length - 1, responders.length - 1)]!;
		return Promise.resolve(responder(call));
	});
	return { fetch, sent };
}

const ok = () => new Response("{}", { status: 200 });
const unauthorized = () => new Response("nope", { status: 401 });
const forbidden = () => new Response("nope", { status: 403 });
const toIdp = () => new Response("<html>sign in</html>", { status: 302, headers: { location: "https://login.example.com/authorize" } });
/** OK only when the request carries the given cookie. */
const okWithCookie = (cookie: string) => (s: Sent) => (s.headers.cookie === cookie ? ok() : unauthorized());

afterEach(() => { logCalls.length = 0; });

describe("isAuthFailure", () => {
	const origin = new URL(SERVER).origin;
	it("treats 401/403 and cross-origin redirects as auth failures", () => {
		expect(isAuthFailure(unauthorized(), origin)).toBe(true);
		expect(isAuthFailure(forbidden(), origin)).toBe(true);
		expect(isAuthFailure(toIdp(), origin)).toBe(true);
	});
	it("ignores successes, other errors and same-origin redirects", () => {
		expect(isAuthFailure(ok(), origin)).toBe(false);
		expect(isAuthFailure(new Response("", { status: 500 }), origin)).toBe(false);
		expect(isAuthFailure(new Response(null, { status: 307, headers: { location: "/mcp/" } }), origin)).toBe(false);
		expect(isAuthFailure(new Response(null, { status: 302 }), origin)).toBe(false);
	});
});

describe("createAuthRefreshFetch", () => {
	it("layers helper headers over the request's headers, helper winning on a clash", async () => {
		const { fetch, sent } = scriptedFetch(ok);
		const wrapped = createAuthRefreshFetch({
			serverName: "s", serverUrl: SERVER, baseFetch: fetch,
			initialHeaders: { authorization: "Bearer test-token", Cookie: "_proxy_session=test-token" },
			runHelper: vi.fn(),
		});
		await wrapped(SERVER, {
			method: "POST",
			headers: new Headers({ Authorization: "Bearer fixed", "X-Fixed": "1", "content-type": "application/json" }),
			body: "{}",
		});
		expect(sent[0]!.headers).toEqual({
			authorization: "Bearer test-token",
			cookie: "_proxy_session=test-token",
			"x-fixed": "1",
			"content-type": "application/json",
		});
	});

	it.each([
		["401", unauthorized],
		["403", forbidden],
		["cross-origin 302", toIdp],
	])("re-runs the helper and retries once on %s", async (_label, failure) => {
		const { fetch, sent } = scriptedFetch(failure, okWithCookie("s=new"));
		const runHelper = vi.fn().mockResolvedValue({ Cookie: "s=new" });
		const onAuthFailure = vi.fn();
		const wrapped = createAuthRefreshFetch({
			serverName: "s", serverUrl: SERVER, baseFetch: fetch,
			initialHeaders: { Cookie: "s=old" }, runHelper, onAuthFailure,
		});
		const res = await wrapped(SERVER, { method: "POST", body: '{"id":1}' });
		expect(res.status).toBe(200);
		expect(runHelper).toHaveBeenCalledTimes(1);
		expect(sent).toHaveLength(2);
		expect(sent[1]!.body).toBe('{"id":1}');
		expect(sent[1]!.headers.cookie).toBe("s=new");
		expect(onAuthFailure).not.toHaveBeenCalled();

		// Later requests keep using the refreshed headers.
		await wrapped(SERVER, { method: "POST", body: "{}" });
		expect(sent[2]!.headers.cookie).toBe("s=new");
	});

	it("stops after one retry, reports the failure and hides the proxy body", async () => {
		const { fetch, sent } = scriptedFetch(toIdp, toIdp, ok);
		const runHelper = vi.fn().mockResolvedValue({ Cookie: "s=still-bad" });
		const onAuthFailure = vi.fn();
		const wrapped = createAuthRefreshFetch({
			serverName: "s", serverUrl: SERVER, baseFetch: fetch,
			initialHeaders: { Cookie: "s=old" }, runHelper, onAuthFailure,
		});
		const res = await wrapped(SERVER, { method: "POST", body: "{}" });
		expect(sent).toHaveLength(2);
		expect(runHelper).toHaveBeenCalledTimes(1);
		expect(res.status).toBe(401);
		const text = await res.text();
		expect(text).toBe("Authentication failed after refreshing headers (HTTP 302).");
		expect(text).not.toContain("sign in");
		expect(onAuthFailure).toHaveBeenCalledWith("Authentication failed after refreshing headers (HTTP 302).");
	});

	it("reports a helper failure during refresh without retrying", async () => {
		const { fetch, sent } = scriptedFetch(unauthorized);
		const onAuthFailure = vi.fn();
		const wrapped = createAuthRefreshFetch({
			serverName: "s", serverUrl: SERVER, baseFetch: fetch,
			initialHeaders: {},
			runHelper: vi.fn().mockRejectedValue(new Error("headersHelper failed (exit 1): login required")),
			onAuthFailure,
		});
		const res = await wrapped(SERVER);
		expect(sent).toHaveLength(1);
		expect(res.status).toBe(401);
		expect(onAuthFailure).toHaveBeenCalledWith(
			"Authentication failed and headersHelper could not refresh headers: headersHelper failed (exit 1): login required"
		);
	});

	it("shares one helper run across concurrent auth failures", async () => {
		const { fetch } = scriptedFetch(okWithCookie("s=new"));
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		const runHelper = vi.fn(async () => { await gate; return { Cookie: "s=new" }; });
		const wrapped = createAuthRefreshFetch({
			serverName: "s", serverUrl: SERVER, baseFetch: fetch,
			initialHeaders: { Cookie: "s=old" }, runHelper,
		});
		const pending = [wrapped(SERVER), wrapped(SERVER), wrapped(SERVER)];
		await new Promise((r) => setTimeout(r, 0));
		release();
		const results = await Promise.all(pending);
		expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
		expect(runHelper).toHaveBeenCalledTimes(1);
	});

	it("retries with already-refreshed headers instead of re-running the helper", async () => {
		// Request A is sent with the old cookie and fails only after request B
		// has already triggered (and completed) a refresh.
		let resolveSlow!: (r: Response) => void;
		const slow = new Promise<Response>((r) => { resolveSlow = r; });
		let calls = 0;
		const fetch = vi.fn((_url: string | URL, init?: RequestInit) => {
			calls++;
			const cookie = new Headers(init?.headers).get("cookie");
			if (calls === 1) return slow;
			return Promise.resolve(cookie === "s=new" ? ok() : unauthorized());
		});
		const runHelper = vi.fn().mockResolvedValue({ Cookie: "s=new" });
		const wrapped = createAuthRefreshFetch({
			serverName: "s", serverUrl: SERVER, baseFetch: fetch,
			initialHeaders: { Cookie: "s=old" }, runHelper,
		});
		const a = wrapped(SERVER);
		const b = await wrapped(SERVER);
		expect(b.status).toBe(200);
		resolveSlow(unauthorized());
		expect((await a).status).toBe(200);
		expect(runHelper).toHaveBeenCalledTimes(1);
	});

	it("passes non-auth errors through without running the helper", async () => {
		const { fetch } = scriptedFetch(() => new Response("boom", { status: 500 }));
		const runHelper = vi.fn();
		const wrapped = createAuthRefreshFetch({
			serverName: "s", serverUrl: SERVER, baseFetch: fetch, initialHeaders: {}, runHelper,
		});
		expect((await wrapped(SERVER)).status).toBe(500);
		expect(runHelper).not.toHaveBeenCalled();
	});

	it("never logs header values", async () => {
		const { fetch } = scriptedFetch(unauthorized, unauthorized);
		const wrapped = createAuthRefreshFetch({
			serverName: "s", serverUrl: SERVER, baseFetch: fetch,
			initialHeaders: { Cookie: "_proxy_session=test-token" },
			runHelper: vi.fn().mockResolvedValue({ Cookie: "_proxy_session=test-token-2" }),
			onAuthFailure: vi.fn(),
		});
		await wrapped(SERVER);
		expect(logCalls.length).toBeGreaterThan(0);
		expect(JSON.stringify(logCalls)).not.toContain("test-token");
	});
});
