/**
 * Unit tests for orchestration progress Notices (INT-020 / FR-140 + INT-021 / FR-141).
 *
 * Covers:
 *  - AC-1: the message names flow + step + iteration;
 *  - AC-2: the message names the emitted "what's next" topic;
 *  - AC-4: the suppression seam withholds the toast (Notice fatigue);
 *  - INT-021 AC-1/AC-2: desktop attaches `oncontextmenu` invoking the jump with the
 *    right conversation id + appends the hint; mobile attaches neither.
 *
 * `obsidian` is mocked locally (the shared `src/__mocks__/obsidian.ts` exports
 * neither `Notice` nor `Platform`): `Notice` captures its constructor args and
 * exposes a settable `messageEl` so the right-click handler can be invoked, and
 * `Platform.isDesktop` is a mutable flag the desktop/mobile cases flip.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// -- obsidian mock ----------------------------------------------------------
// Mutable platform flag flipped per-test; a Notice double that records its
// message + timeout and carries a real settable `messageEl`.

const platform = { isDesktop: true };

interface NoticeCall {
	message: string;
	timeout: number | undefined;
	messageEl: { oncontextmenu: ((e?: unknown) => void) | null };
}

const noticeCalls: NoticeCall[] = [];

vi.mock("obsidian", () => ({
	get Platform() {
		return platform;
	},
	Notice: vi.fn().mockImplementation(function (
		this: { messageEl: NoticeCall["messageEl"] },
		message: string,
		timeout?: number,
	) {
		this.messageEl = { oncontextmenu: null };
		noticeCalls.push({ message, timeout, messageEl: this.messageEl });
	}),
}));

import {
	showOrchestrationProgressNotice,
	buildProgressNoticeMessage,
	PROGRESS_NOTICE_TIMEOUT_MS,
} from "./notices";

beforeEach(() => {
	noticeCalls.length = 0;
	platform.isDesktop = true;
});

// ---------------------------------------------------------------------------
// buildProgressNoticeMessage — the pure message contract (AC-1 / AC-2)
// ---------------------------------------------------------------------------

describe("buildProgressNoticeMessage", () => {
	it("names flow + step + iteration + emitted topic (AC-1 / AC-2)", () => {
		const msg = buildProgressNoticeMessage({
			flowName: "Code Implementation",
			stepName: "📋 Planner",
			iteration: 3,
			emittedTopic: "tasks.ready",
			withJumpHint: false,
		});
		expect(msg).toContain("Code Implementation"); // flow (AC-1)
		expect(msg).toContain("📋 Planner"); // step (AC-1)
		expect(msg).toContain("iter 3"); // iteration (AC-1)
		expect(msg).toContain("tasks.ready"); // what's-next topic (AC-2)
		// The documented example shape.
		expect(msg).toBe("[Code Implementation] 📋 Planner · iter 3 → tasks.ready");
	});

	it("appends the desktop hint on its own line only when withJumpHint", () => {
		const withHint = buildProgressNoticeMessage({
			flowName: "F",
			stepName: "S",
			iteration: 1,
			emittedTopic: "t",
			withJumpHint: true,
		});
		expect(withHint).toContain("\n(right-click to open step conversation)");

		const without = buildProgressNoticeMessage({
			flowName: "F",
			stepName: "S",
			iteration: 1,
			emittedTopic: "t",
			withJumpHint: false,
		});
		expect(without).not.toContain("right-click");
	});
});

// ---------------------------------------------------------------------------
// showOrchestrationProgressNotice — synthesis (INT-020) + jump (INT-021)
// ---------------------------------------------------------------------------

describe("showOrchestrationProgressNotice — synthesis (INT-020)", () => {
	it("shows a Notice naming flow + step + iteration + topic (AC-1 / AC-2)", () => {
		showOrchestrationProgressNotice({
			flowName: "Code Implementation",
			stepName: "📋 Planner",
			iteration: 3,
			emittedTopic: "tasks.ready",
		});
		expect(noticeCalls).toHaveLength(1);
		const { message, timeout } = noticeCalls[0]!;
		expect(message).toContain("Code Implementation");
		expect(message).toContain("📋 Planner");
		expect(message).toContain("iter 3");
		expect(message).toContain("tasks.ready");
		expect(timeout).toBe(PROGRESS_NOTICE_TIMEOUT_MS);
	});

	it("honors a custom timeout override", () => {
		showOrchestrationProgressNotice({
			flowName: "F",
			stepName: "S",
			iteration: 1,
			emittedTopic: "t",
			timeoutMs: 1234,
		});
		expect(noticeCalls[0]!.timeout).toBe(1234);
	});

	it("withholds the toast when suppressed (AC-4, Notice fatigue)", () => {
		showOrchestrationProgressNotice({
			flowName: "F",
			stepName: "S",
			iteration: 7,
			emittedTopic: "t",
			suppress: true,
		});
		expect(noticeCalls).toHaveLength(0);
	});

	it("emits one Notice per call when not suppressed (v1 one-per-turn)", () => {
		for (let i = 1; i <= 3; i++) {
			showOrchestrationProgressNotice({
				flowName: "F",
				stepName: "S",
				iteration: i,
				emittedTopic: "t",
			});
		}
		expect(noticeCalls).toHaveLength(3);
	});
});

describe("showOrchestrationProgressNotice — desktop right-click jump (INT-021)", () => {
	it("desktop: attaches oncontextmenu invoking the jump with the right conversation id (AC-1)", () => {
		platform.isDesktop = true;
		const jump = vi.fn();
		showOrchestrationProgressNotice({
			flowName: "F",
			stepName: "S",
			iteration: 1,
			emittedTopic: "t",
			conversationId: "step-conv-uuid-42",
			onJumpToConversation: jump,
		});
		const call = noticeCalls[0]!;
		// Hint line present on desktop.
		expect(call.message).toContain("right-click to open step conversation");
		// Handler attached and wired to the jump callback.
		expect(typeof call.messageEl.oncontextmenu).toBe("function");
		call.messageEl.oncontextmenu!();
		expect(jump).toHaveBeenCalledTimes(1);
	});

	it("desktop: the jump callback is the caller's closure (targets its conversation id)", () => {
		platform.isDesktop = true;
		// Mirror how launch.ts closes the jump over a specific conversation id.
		const opened: string[] = [];
		const conversationId = "step-conv-hidden-from-flat-list";
		showOrchestrationProgressNotice({
			flowName: "F",
			stepName: "S",
			iteration: 2,
			emittedTopic: "t",
			conversationId,
			onJumpToConversation: () => opened.push(conversationId),
		});
		noticeCalls[0]!.messageEl.oncontextmenu!();
		expect(opened).toEqual([conversationId]);
	});

	it("mobile: attaches no handler and adds no hint line (AC-2)", () => {
		platform.isDesktop = false;
		const jump = vi.fn();
		showOrchestrationProgressNotice({
			flowName: "F",
			stepName: "S",
			iteration: 1,
			emittedTopic: "t",
			conversationId: "step-conv-uuid-42",
			onJumpToConversation: jump,
		});
		const call = noticeCalls[0]!;
		expect(call.message).not.toContain("right-click");
		expect(call.messageEl.oncontextmenu).toBeNull();
	});

	it("desktop but no conversation id/callback: no handler, no hint", () => {
		platform.isDesktop = true;
		showOrchestrationProgressNotice({
			flowName: "F",
			stepName: "S",
			iteration: 1,
			emittedTopic: "t",
		});
		const call = noticeCalls[0]!;
		expect(call.message).not.toContain("right-click");
		expect(call.messageEl.oncontextmenu).toBeNull();
	});

	it("suppressed desktop turn produces no Notice to right-click (AC-5 inherited)", () => {
		platform.isDesktop = true;
		showOrchestrationProgressNotice({
			flowName: "F",
			stepName: "S",
			iteration: 9,
			emittedTopic: "t",
			conversationId: "step-conv-uuid-42",
			onJumpToConversation: vi.fn(),
			suppress: true,
		});
		expect(noticeCalls).toHaveLength(0);
	});
});
