import { describe, it, expect, vi, afterEach } from "vitest";
import type { App } from "obsidian";
import { Modal } from "obsidian";
import { createModalApprovalCallback } from "./tool-approval-modal";
import type { ToolCall } from "../types";

// os-notification pulls in the chat view; the OS-notification path isn't under test.
vi.mock("./os-notification", () => ({ focusObsidianWindow: vi.fn(), showOsNotification: vi.fn() }));

const call = (tool_name: string): ToolCall => ({ tool_name, parameters: { path: "a.md" }, status: "pending" });

/** Modals opened so far; the mock's open() is inert, so tests decide via the instance. */
let opened: Array<{ decide(d: "approved" | "rejected"): void }> = [];

function trackOpens(): void {
	opened = [];
	vi.spyOn(Modal.prototype, "open").mockImplementation(function (this: unknown) {
		opened.push(this as { decide(d: "approved" | "rejected"): void });
	});
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.restoreAllMocks());

describe("createModalApprovalCallback", () => {
	it("approves fire-and-forget renders of auto-approved calls without a modal", async () => {
		trackOpens();
		const approve = createModalApprovalCallback({} as App, "Circuit 'X'");
		await expect(approve(call("read_note"), undefined, "m", true)).resolves.toBe("approved");
		expect(opened).toHaveLength(0);
	});

	it("resolves with the user's decision", async () => {
		trackOpens();
		const approve = createModalApprovalCallback({} as App, "Circuit 'X'");
		const decision = approve(call("write_note"));
		await flush();
		opened[0]?.decide("approved");
		await expect(decision).resolves.toBe("approved");
	});

	it("shows one modal at a time across concurrent prompts", async () => {
		trackOpens();
		const approve = createModalApprovalCallback({} as App, "Circuit 'X'");
		const first = approve(call("write_note"));
		const second = approve(call("move_note"));
		await flush();
		expect(opened).toHaveLength(1);

		opened[0]?.decide("rejected");
		await expect(first).resolves.toBe("rejected");
		await flush();
		expect(opened).toHaveLength(2);
		opened[1]?.decide("approved");
		await expect(second).resolves.toBe("approved");
	});

	it("closes on abort and skips prompts aborted while queued", async () => {
		trackOpens();
		const approve = createModalApprovalCallback({} as App, "Circuit 'X'");
		const a = new AbortController();
		const b = new AbortController();
		const first = approve(call("write_note"), a.signal);
		const second = approve(call("move_note"), b.signal);
		await flush();

		b.abort();
		a.abort();
		await expect(first).resolves.toBe("rejected");
		await expect(second).resolves.toBe("rejected");
		await flush();
		expect(opened).toHaveLength(1);
	});
});
