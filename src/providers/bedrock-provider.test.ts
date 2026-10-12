import { describe, it, expect, afterEach } from "vitest";

import { BedrockProvider } from "./bedrock-provider";
import type { StreamChunk } from "./provider";
import type { App } from "obsidian";
import { getLearnedContextWindow, isBetaRejected, resetModelLimits } from "./model-limits";

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

// ---------------------------------------------------------------------------
// sendMessage — 1M beta header, context overflow and beta rejection
// ---------------------------------------------------------------------------

/**
 * Run sendMessage with the SDK call replaced: captures the Converse input and
 * rejects with `error` (or resolves with an empty stream when omitted).
 */
async function runSend(
	model: string,
	opts: { useExtendedContext?: boolean; thinkingLevel?: string; error?: Error } = {}
): Promise<{ input: Record<string, unknown>; thrown?: unknown }> {
	const provider = makeProvider();
	let input: Record<string, unknown> = {};
	(provider as unknown as { sendWithCredentialRetry: unknown }).sendWithCredentialRetry = async (
		_getClient: unknown,
		makeCommand: () => { input: Record<string, unknown> }
	) => {
		input = makeCommand().input;
		if (opts.error) throw opts.error;
		return { stream: (async function* () { /* empty */ })() };
	};
	try {
		for await (const _chunk of provider.sendMessage([{ role: "user", content: "hi" }], [], {
			model,
			use_extended_context: opts.useExtendedContext,
			thinking_level: opts.thinkingLevel,
		})) {
			// drain
		}
		return { input };
	} catch (thrown) {
		return { input, thrown };
	}
}

function awsError(name: string, message: string): Error {
	const e = new Error(message);
	e.name = name;
	return e;
}

function betaOf(input: Record<string, unknown>): unknown {
	return (input.additionalModelRequestFields as Record<string, unknown> | undefined)?.anthropic_beta;
}

describe("BedrockProvider — 1M beta and context limits", () => {
	afterEach(() => resetModelLimits());

	it("sends the 1M beta by default for default-1M models (static and inferred)", async () => {
		for (const model of ["us.anthropic.claude-opus-5-5", "us.anthropic.claude-opus-6"]) {
			const { input } = await runSend(model);
			expect(betaOf(input)).toEqual(["context-1m-2025-08-07"]);
		}
	});

	it("sends the beta for a known model only when the 1M variant is selected", async () => {
		expect(betaOf((await runSend("us.anthropic.claude-opus-5")).input)).toBeUndefined();
		expect(betaOf((await runSend("us.anthropic.claude-opus-5", { useExtendedContext: true })).input))
			.toEqual(["context-1m-2025-08-07"]);
	});

	it("classifies 'Input is too long' as CONTEXT_LENGTH_EXCEEDED without learning a limit", async () => {
		const { thrown } = await runSend("us.anthropic.claude-opus-5-5", {
			error: awsError("ValidationException", "Input is too long for requested model."),
		});
		expect(thrown).toMatchObject({ code: "CONTEXT_LENGTH_EXCEEDED" });
		expect(getLearnedContextWindow("us.anthropic.claude-opus-5-5")).toBeUndefined();
	});

	it("learns a numeric limit under the ::1m key when the 1M variant is selected", async () => {
		await runSend("us.anthropic.claude-sonnet-4-6", {
			useExtendedContext: true,
			error: awsError("ValidationException", "prompt is too long: 950000 tokens > 900000 maximum"),
		});
		expect(getLearnedContextWindow("us.anthropic.claude-sonnet-4-6", true)).toBe(900_000);
	});

	it("keeps 'Too many tokens' as RATE_LIMITED", async () => {
		const { thrown } = await runSend("us.anthropic.claude-opus-5-5", {
			error: awsError("ThrottlingException", "Too many tokens, please wait before trying again."),
		});
		expect(thrown).toMatchObject({ code: "RATE_LIMITED" });
	});

	it("records a rejected default beta and stops sending it", async () => {
		const { thrown } = await runSend("us.anthropic.claude-opus-5-5", {
			error: awsError("ValidationException", "invalid beta flag"),
		});
		expect(thrown).toMatchObject({ code: "PROVIDER_ERROR" });
		expect(isBetaRejected("us.anthropic.claude-opus-5-5")).toBe(true);
		expect(betaOf((await runSend("us.anthropic.claude-opus-5-5")).input)).toBeUndefined();
	});

	it("attaches details to stream validation exceptions and learns from them", () => {
		const chunks = [...getHandler(makeProvider())(
			{ validationException: { message: "prompt is too long: 300000 tokens > 200000 maximum" } },
			new Map(),
			{ model: "us.anthropic.claude-opus-5-5" } as { stopReason?: string },
		)];
		expect(chunks[0]).toMatchObject({ type: "error", details: { name: "ValidationException" } });
		expect(getLearnedContextWindow("us.anthropic.claude-opus-5-5")).toBe(200_000);
	});
});

describe("BedrockProvider — thinking request fields", () => {
	function fieldsOf(input: Record<string, unknown>): Record<string, unknown> | undefined {
		return input.additionalModelRequestFields as Record<string, unknown> | undefined;
	}

	it("requests summarized adaptive thinking for effort models", async () => {
		const { input } = await runSend("us.anthropic.claude-opus-4-8", { thinkingLevel: "high" });
		expect(fieldsOf(input)?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(fieldsOf(input)?.output_config).toEqual({ effort: "high" });
	});

	it("leaves legacy budget thinking without a display field", async () => {
		const { input } = await runSend("us.anthropic.claude-opus-4-6-v1", { thinkingLevel: "high" });
		expect(fieldsOf(input)?.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
	});
});

// ---------------------------------------------------------------------------
// Transient network / server failures
// ---------------------------------------------------------------------------

describe("BedrockProvider — transient failure classification", () => {
	/** Run sendMessage with the SDK call replaced by `send`; collect chunks or the throw. */
	async function runStream(
		send: () => Promise<unknown>,
	): Promise<{ chunks: StreamChunk[]; thrown?: unknown; provider: BedrockProvider }> {
		const provider = makeProvider();
		(provider as unknown as { sendWithCredentialRetry: unknown }).sendWithCredentialRetry = send;
		const chunks: StreamChunk[] = [];
		try {
			for await (const chunk of provider.sendMessage([{ role: "user", content: "hi" }], [], { model: "us.anthropic.claude-opus-5-5" })) {
				chunks.push(chunk);
			}
			return { chunks, provider };
		} catch (thrown) {
			return { chunks, thrown, provider };
		}
	}

	function cachedClient(provider: BedrockProvider): unknown {
		return (provider as unknown as { runtimeClient: unknown }).runtimeClient;
	}

	it("maps a pre-stream ENOTFOUND to CONNECTION_FAILED and drops the cached client", async () => {
		const provider = makeProvider();
		(provider as unknown as { runtimeClient: unknown }).runtimeClient = { stale: true };
		(provider as unknown as { sendWithCredentialRetry: unknown }).sendWithCredentialRetry = async () => {
			throw new Error("The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-west-2.amazonaws.com)");
		};
		let thrown: unknown;
		try {
			for await (const _chunk of provider.sendMessage([{ role: "user", content: "hi" }], [], { model: "m" })) {
				// drain
			}
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toMatchObject({ code: "CONNECTION_FAILED" });
		expect((thrown as Error).message).toMatch(/^Network connection to AWS Bedrock/);
		expect(cachedClient(provider)).toBeNull();
	});

	it("maps pre-stream InternalServerException to SERVICE_UNAVAILABLE", async () => {
		const { thrown } = await runStream(async () => {
			throw awsError("InternalServerException", "Internal failure");
		});
		expect(thrown).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	});

	it("tags a mid-stream network drop with CONNECTION_FAILED", async () => {
		const { chunks } = await runStream(async () => ({
			stream: (async function* () {
				yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } };
				throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
			})(),
		}));
		expect(chunks.at(-1)).toMatchObject({ type: "error", code: "CONNECTION_FAILED" });
	});

	it("tags in-stream throttling and server exceptions", () => {
		const handler = getHandler(makeProvider());
		const codeOf = (event: unknown) => [...handler(event, new Map(), {})][0];
		expect(codeOf({ throttlingException: { message: "slow down" } })).toMatchObject({ code: "RATE_LIMITED" });
		expect(codeOf({ internalServerException: { message: "oops" } })).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(codeOf({ modelStreamErrorException: { message: "oops" } })).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(codeOf({ serviceUnavailableException: { message: "oops" } })).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(codeOf({ validationException: { message: "bad" } })).not.toHaveProperty("code");
	});

	it("forwards the abort signal to the SDK send", async () => {
		const controller = new AbortController();
		let seen: unknown;
		const provider = makeProvider();
		await (provider as unknown as {
			sendWithCredentialRetry: (g: unknown, m: unknown, s?: AbortSignal) => Promise<unknown>;
		}).sendWithCredentialRetry.call(
			provider,
			() => ({ send: (_c: unknown, opts?: { abortSignal?: AbortSignal }) => { seen = opts?.abortSignal; return Promise.resolve("ok"); } }),
			() => ({}),
			controller.signal,
		);
		expect(seen).toBe(controller.signal);
	});
});
