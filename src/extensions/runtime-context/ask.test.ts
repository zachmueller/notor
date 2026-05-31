import { describe, it, expect, vi } from "vitest";

vi.mock("../../utils/logger", () => ({
	logger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { buildAsk, buildAskMany } from "./chat-utils";
import type { ExtensionUtils } from "./types";
import type { InteractionRequest, InteractionResponse } from "../../ui/interaction-ui";

function makeUtils(
	cb?: (req: InteractionRequest) => Promise<InteractionResponse>,
): ExtensionUtils {
	// Only the field buildAskMany reads is needed.
	return { interactionCallback: cb } as unknown as ExtensionUtils;
}

describe("buildAskMany", () => {
	it("returns an array of nulls (one per question) when no interaction channel is wired", async () => {
		const askMany = buildAskMany(makeUtils(undefined));
		const answers = await askMany([{ question: "a" }, { question: "b" }]);
		expect(answers).toEqual([null, null]);
	});

	it("sends one batched request with all questions and returns the values in order", async () => {
		const seen: InteractionRequest[] = [];
		const utils = makeUtils(async (req) => {
			seen.push(req);
			return { id: req.id, values: ["red", "noted"] };
		});
		const askMany = buildAskMany(utils);
		const answers = await askMany([
			{ question: "What color?", suggestions: ["red", "blue"] },
			{ question: "Any notes?" },
		]);

		expect(answers).toEqual(["red", "noted"]);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ type: "ask" });
		expect((seen[0] as { questions: unknown[] }).questions).toMatchObject([
			{ question: "What color?", suggestions: ["red", "blue"] },
			{ question: "Any notes?" },
		]);
		expect(seen[0]!.id).toBeTruthy();
	});

	it("pads missing answers with null", async () => {
		const utils = makeUtils(async (req) => ({ id: req.id, values: ["only-one"] }));
		const askMany = buildAskMany(utils);
		const answers = await askMany([{ question: "a" }, { question: "b" }]);
		expect(answers).toEqual(["only-one", null]);
	});

	it("throws on an empty questions array", async () => {
		const askMany = buildAskMany(makeUtils(async (req) => ({ id: req.id, values: [] })));
		await expect(askMany([])).rejects.toThrow("non-empty questions array");
	});

	it("throws when a question is empty", async () => {
		const askMany = buildAskMany(makeUtils(async (req) => ({ id: req.id, values: [] })));
		await expect(askMany([{ question: "   " }])).rejects.toThrow("non-empty string");
	});
});

describe("buildAsk (wrapper over askMany)", () => {
	it("returns null when no interaction channel is wired", async () => {
		const utils = makeUtils(undefined);
		const ask = buildAsk(buildAskMany(utils));
		expect(await ask("anything")).toBeNull();
	});

	it("forwards a single question and returns its answer value", async () => {
		const seen: InteractionRequest[] = [];
		const utils = makeUtils(async (req) => {
			seen.push(req);
			return { id: req.id, values: ["chosen"] };
		});
		const ask = buildAsk(buildAskMany(utils));
		const answer = await ask("What color?", { suggestions: ["red", "blue"] });

		expect(answer).toBe("chosen");
		expect(seen).toHaveLength(1);
		expect((seen[0] as { questions: unknown[] }).questions).toMatchObject([
			{ question: "What color?", suggestions: ["red", "blue"] },
		]);
	});

	it("throws on an empty question", async () => {
		const utils = makeUtils(async (req) => ({ id: req.id, values: [""] }));
		const ask = buildAsk(buildAskMany(utils));
		await expect(ask("   ")).rejects.toThrow("non-empty question");
	});
});
