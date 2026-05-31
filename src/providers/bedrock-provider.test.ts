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

function handleDelta(provider: BedrockProvider, delta: Record<string, unknown>): StreamChunk[] {
	const handle = (provider as unknown as {
		handleBedrockEvent: (
			event: unknown,
			activeToolBlockIndices: Map<number, string>,
		) => Iterable<StreamChunk>;
	}).handleBedrockEvent.bind(provider);
	return [...handle({ contentBlockDelta: { delta, contentBlockIndex: 0 } }, new Map())];
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

	it("uses an auth-tailored message free of internal tooling references", () => {
		const profileMsg = expiredMessage(makeProvider({ aws_auth_method: "profile" }));
		const keysMsg = expiredMessage(makeProvider({ aws_auth_method: "keys" }));

		expect(profileMsg).toMatch(/profile/i);
		expect(keysMsg).toMatch(/access keys/i);
		for (const msg of [profileMsg, keysMsg]) {
			expect(msg).not.toMatch(/midway|ada|mwinit/i);
		}
	});
});
