/**
 * McpHub.whenInitialConnectsSettled — lets the plugin wait (capped) for the
 * initial connection attempts started by initialize() before the first
 * daily-start check, now that connections begin at layout ready.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger", () => {
	const noop = () => undefined;
	return { logger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});

import { McpHub } from "./mcp-hub";
import type { NotorSettings } from "../settings";

function settingsWith(servers: Record<string, { disabled?: boolean }>): NotorSettings {
	const mcp_servers = Object.fromEntries(
		Object.entries(servers).map(([name, c]) => [name, { name, type: "stdio", command: "x", ...c }]),
	);
	return { mcp_servers } as unknown as NotorSettings;
}

function deferred() {
	let resolve!: () => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

const settled = async (p: Promise<void>) => {
	let done = false;
	void p.then(() => { done = true; });
	await new Promise((r) => setTimeout(r, 0));
	return done;
};

describe("McpHub.whenInitialConnectsSettled", () => {
	it("resolves immediately before initialize()", async () => {
		const hub = new McpHub("0.0.0-test", "/vault");
		expect(await settled(hub.whenInitialConnectsSettled())).toBe(true);
	});

	it("waits for every enabled server's first attempt, connected or failed", async () => {
		const hub = new McpHub("0.0.0-test", "/vault");
		const a = deferred();
		const b = deferred();
		const connect = vi.spyOn(hub, "connectServer").mockImplementation(async (name: string) => {
			await (name === "a" ? a.promise : b.promise);
		});
		await hub.initialize(settingsWith({ a: {}, b: {}, off: { disabled: true } }), { get: () => null });

		expect(connect.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
		expect(await settled(hub.whenInitialConnectsSettled())).toBe(false);
		a.resolve();
		expect(await settled(hub.whenInitialConnectsSettled())).toBe(false);
		b.reject(new Error("spawn failed"));
		expect(await settled(hub.whenInitialConnectsSettled())).toBe(true);
	});

	it("resolves immediately when no server is enabled", async () => {
		const hub = new McpHub("0.0.0-test", "/vault");
		await hub.initialize(settingsWith({ off: { disabled: true } }), { get: () => null });
		expect(await settled(hub.whenInitialConnectsSettled())).toBe(true);
	});
});
