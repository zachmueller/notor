import { describe, it, expect } from "vitest";

import { BedrockProvider } from "./bedrock-provider";
import type { StreamChunk } from "./provider";
import type { App } from "obsidian";

// ---------------------------------------------------------------------------
// handleBedrockEvent — thinking (reasoningContent) wire shapes
//
// Verified against live Bedrock streams (see memory: bedrock-thinking-wire-shape):
// Bedrock emits NO contentBlockStart for thinking — reasoning arrives only as
// contentBlockDelta. Adaptive Opus 4.8 sends a signed `reasoningContent` blob
// with no `.text`; we must still surface a `thinking_start` from it.
// ---------------------------------------------------------------------------

function makeProvider(
	config: Record<string, unknown> = {}
): BedrockProvider {
	return new BedrockProvider(
		{ id: "test", region: "us-east-1", ...config } as never,
		{} as App
	);
}

/** Access the private credential-retry helper for direct testing. */
function callRetry(
	provider: BedrockProvider,
	getClient: () => { send: (command: unknown) => Promise<unknown> },
	makeCommand: () => unknown
): Promise<unknown> {
	return (provider as unknown as {
		sendWithCredentialRetry: (
			getClient: () => { send: (command: unknown) => Promise<unknown> },
			makeCommand: () => unknown
		) => Promise<unknown>;
	}).sendWithCredentialRetry.call(provider, getClient, makeCommand);
}

/** Access the private auth-tailored expiry message for direct testing. */
function expiredMessage(provider: BedrockProvider): string {
	return (provider as unknown as {
		expiredCredentialMessage: () => string;
	}).expiredCredentialMessage.call(provider);
}

function expiredTokenError(): Error {
	const e = new Error("The security token included in the request is expired");
	e.name = "ExpiredTokenException";
	return e;
}

type BedrockEventHandler = (
	event: unknown,
	activeToolBlockIndices: Map<number, string>,
	streamState: { stopReason?: string },
) => Iterable<StreamChunk>;

function getHandler(provider: BedrockProvider): BedrockEventHandler {
	return (provider as unknown as { handleBedrockEvent: BedrockEventHandler }).handleBedrockEvent.bind(
		provider,
	);
}

function handleDelta(provider: BedrockProvider, delta: Record<string, unknown>): StreamChunk[] {
	return [...getHandler(provider)({ contentBlockDelta: { delta, contentBlockIndex: 0 } }, new Map(), {})];
}

describe("BedrockProvider — thinking reasoningContent deltas", () => {
	it("emits thinking_delta for reasoningContent.text (plaintext summary)", () => {
		const chunks = handleDelta(makeProvider(), { reasoningContent: { text: "Let me think" } });
		expect(chunks).toEqual([{ type: "thinking_delta", text: "Let me think" }]);
	});

	it("emits thinking_start for a signed reasoningContent blob with no text (Opus 4.8)", () => {
		const chunks = handleDelta(makeProvider(), { reasoningContent: { signature: "EoQCCm..." } });
		expect(chunks).toEqual([{ type: "thinking_start" }]);
	});

	it("emits thinking_start for a redacted reasoningContent blob", () => {
		const chunks = handleDelta(makeProvider(), { reasoningContent: { redactedContent: "…" } });
		expect(chunks).toEqual([{ type: "thinking_start" }]);
	});

	it("emits text_delta for a normal answer delta (no reasoning)", () => {
		const chunks = handleDelta(makeProvider(), { text: "answer" });
		expect(chunks).toEqual([{ type: "text_delta", text: "answer" }]);
	});
});

describe("BedrockProvider — stop_reason on message_end", () => {
	it("attaches messageStop.stopReason to the single metadata-driven message_end", () => {
		const provider = makeProvider();
		const handle = getHandler(provider);
		const indices = new Map<number, string>();
		const streamState: { stopReason?: string } = {};

		// messageStop arrives first (no message_end of its own — avoids double-emit)…
		const stopChunks = [...handle({ messageStop: { stopReason: "max_tokens" } }, indices, streamState)];
		expect(stopChunks).toEqual([]);
		expect(streamState.stopReason).toBe("max_tokens");

		// …then the metadata event yields exactly one message_end carrying both the
		// real token counts and the stashed stop reason.
		const metaChunks = [
			...handle(
				{ metadata: { usage: { inputTokens: 100, outputTokens: 4096 } } },
				indices,
				streamState,
			),
		];
		expect(metaChunks).toEqual([
			{ type: "message_end", input_tokens: 100, output_tokens: 4096, stop_reason: "max_tokens" },
		]);
	});

	it("emits message_end with undefined stop_reason when no messageStop preceded metadata", () => {
		const provider = makeProvider();
		const chunks = [
			...getHandler(provider)(
				{ metadata: { usage: { inputTokens: 5, outputTokens: 6 } } },
				new Map(),
				{},
			),
		];
		expect(chunks).toEqual([
			{ type: "message_end", input_tokens: 5, output_tokens: 6, stop_reason: undefined },
		]);
	});
});

describe("BedrockProvider — credential expiry retry", () => {
	it("transparently retries once on expired token for profile auth", async () => {
		// Profile auth (the default): a fresh client re-resolves credentials.
		const provider = makeProvider({ aws_auth_method: "profile" });
		let calls = 0;
		const client = {
			send: () => {
				calls += 1;
				if (calls === 1) return Promise.reject(expiredTokenError());
				return Promise.resolve("ok");
			},
		};

		const result = await callRetry(provider, () => client, () => ({}));

		expect(result).toBe("ok");
		expect(calls).toBe(2); // one failure + one successful retry
	});

	it("does not retry on expired token for static-keys auth", async () => {
		// Static keys can't self-refresh, so retrying would be wasted work.
		const provider = makeProvider({ aws_auth_method: "keys" });
		let calls = 0;
		const client = {
			send: () => {
				calls += 1;
				return Promise.reject(expiredTokenError());
			},
		};

		await expect(
			callRetry(provider, () => client, () => ({}))
		).rejects.toThrow(/expired/i);
		expect(calls).toBe(1); // no retry
	});

	it("does not retry on non-credential errors", async () => {
		const provider = makeProvider({ aws_auth_method: "profile" });
		let calls = 0;
		const client = {
			send: () => {
				calls += 1;
				const e = new Error("rate exceeded");
				e.name = "ThrottlingException";
				return Promise.reject(e);
			},
		};

		await expect(
			callRetry(provider, () => client, () => ({}))
		).rejects.toThrow(/rate exceeded/);
		expect(calls).toBe(1);
	});

	it("uses generic AWS messaging tailored by auth method", () => {
		const profileMsg = expiredMessage(makeProvider({ aws_auth_method: "profile" }));
		const keysMsg = expiredMessage(makeProvider({ aws_auth_method: "keys" }));

		// Profile auth points at refreshing the profile's credentials; keys auth
		// points at Settings. Both stay vendor-neutral (AWS SDK terms only).
		expect(profileMsg).toMatch(/profile/i);
		expect(keysMsg).toMatch(/access keys/i);
		expect(profileMsg).toMatch(/credentials have expired/i);
		expect(keysMsg).toMatch(/Settings → Notor/);
	});
});
