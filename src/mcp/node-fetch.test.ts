import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import { nodeFetch, headersToRecord } from "./node-fetch";

let server: http.Server;
let other: http.Server;
let base: string;
let otherBase: string;

/** Collect a request body. */
function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	});
}

beforeAll(async () => {
	other = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<html>sign in</html>");
	});
	await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
	otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;

	server = http.createServer((req, res) => {
		void (async () => {
			const body = await readBody(req);
			switch (req.url) {
				case "/echo":
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
					return;
				case "/sse": {
					res.writeHead(200, { "content-type": "text/event-stream" });
					let n = 0;
					const t = setInterval(() => {
						res.write(`data: ${n}\n\n`);
						if (++n === 3) { clearInterval(t); res.end(); }
					}, 100);
					return;
				}
				case "/hang":
					res.writeHead(200, { "content-type": "text/event-stream" });
					res.write("data: first\n\n");
					return; // never ends
				case "/no-content":
					res.writeHead(204);
					res.end();
					return;
				case "/to-idp":
					res.writeHead(302, { location: `${otherBase}/login` });
					res.end("redirect body");
					return;
				case "/same-307":
					res.writeHead(307, { location: "/echo" });
					res.end();
					return;
				case "/same-303":
					res.writeHead(303, { location: "/echo" });
					res.end();
					return;
				case "/loop":
					res.writeHead(302, { location: "/loop" });
					res.end();
					return;
				default:
					res.writeHead(404);
					res.end();
			}
		})();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
	server.closeAllConnections();
	server.close();
	other.close();
});

describe("nodeFetch", () => {
	it("sends Cookie and Authorization headers (forbidden in the renderer fetch)", async () => {
		const res = await nodeFetch(`${base}/echo`, {
			headers: new Headers({ Cookie: "_proxy_session=test-token", Authorization: "Bearer test-token" }),
		});
		const json = await res.json() as { headers: Record<string, string> };
		expect(res.status).toBe(200);
		expect(json.headers.cookie).toBe("_proxy_session=test-token");
		expect(json.headers.authorization).toBe("Bearer test-token");
	});

	it("sends a POST body", async () => {
		const res = await nodeFetch(new URL(`${base}/echo`), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"jsonrpc":"2.0"}',
		});
		const json = await res.json() as { method: string; body: string; headers: Record<string, string> };
		expect(json.method).toBe("POST");
		expect(json.body).toBe('{"jsonrpc":"2.0"}');
		expect(json.headers["content-length"]).toBe("17");
	});

	it("streams SSE chunks incrementally", async () => {
		const res = await nodeFetch(`${base}/sse`);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
		const arrivals: Array<{ at: number; text: string }> = [];
		const t0 = Date.now();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			arrivals.push({ at: Date.now() - t0, text: value });
		}
		expect(arrivals.map((a) => a.text).join("")).toBe("data: 0\n\ndata: 1\n\ndata: 2\n\n");
		expect(arrivals.length).toBeGreaterThanOrEqual(3);
		// The first chunk must not wait for the stream to finish.
		expect(arrivals[0]!.at).toBeLessThan(arrivals[arrivals.length - 1]!.at);
	});

	it("aborts before the response arrives", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(nodeFetch(`${base}/echo`, { signal: controller.signal })).rejects.toBeDefined();
	});

	it("aborts a streaming response mid-body", async () => {
		const controller = new AbortController();
		const res = await nodeFetch(`${base}/hang`, { signal: controller.signal });
		const reader = res.body!.getReader();
		await reader.read();
		controller.abort();
		await expect(reader.read()).rejects.toBeDefined();
	});

	it("returns a null body for 204", async () => {
		const res = await nodeFetch(`${base}/no-content`, { method: "DELETE" });
		expect(res.status).toBe(204);
		expect(res.body).toBeNull();
	});

	it("never follows a cross-origin redirect", async () => {
		const res = await nodeFetch(`${base}/to-idp`);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe(`${otherBase}/login`);
	});

	it("follows a same-origin 307, preserving method and body", async () => {
		const res = await nodeFetch(`${base}/same-307`, { method: "POST", body: "payload" });
		const json = await res.json() as { method: string; body: string };
		expect(res.status).toBe(200);
		expect(json).toMatchObject({ method: "POST", body: "payload" });
	});

	it("turns a same-origin 303 into a bodiless GET", async () => {
		const res = await nodeFetch(`${base}/same-303`, {
			method: "POST",
			headers: { "content-type": "application/json", Cookie: "a=b" },
			body: "payload",
		});
		const json = await res.json() as { method: string; body: string; headers: Record<string, string> };
		expect(json.method).toBe("GET");
		expect(json.body).toBe("");
		expect(json.headers["content-type"]).toBeUndefined();
		expect(json.headers.cookie).toBe("a=b");
	});

	it("does not follow redirects in manual mode", async () => {
		const res = await nodeFetch(`${base}/same-307`, { redirect: "manual" });
		expect(res.status).toBe(307);
	});

	it("stops after too many redirects", async () => {
		await expect(nodeFetch(`${base}/loop`)).rejects.toThrow(/too many redirects/);
	});

	it("rejects with a TypeError when the server is unreachable", async () => {
		await expect(nodeFetch("http://127.0.0.1:1/mcp")).rejects.toThrow(TypeError);
	});
});

describe("headersToRecord", () => {
	it("flattens Headers, tuples and plain objects", () => {
		expect(headersToRecord(new Headers({ A: "1" }))).toEqual({ a: "1" });
		expect(headersToRecord([["B", "2"]])).toEqual({ B: "2" });
		expect(headersToRecord({ C: "3" })).toEqual({ C: "3" });
		expect(headersToRecord(undefined)).toEqual({});
	});
});
