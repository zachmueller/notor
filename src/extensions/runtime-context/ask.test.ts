import { describe, it, expect, vi } from "vitest";

vi.mock("../../utils/logger", () => ({
	logger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { buildAsk } from "./chat-utils";
import type { ExtensionUtils } from "./types";
import type { InteractionRequest, InteractionResponse } from "../../ui/interaction-ui";

function makeUtils(
	cb?: (req: InteractionRequest) => Promise<InteractionResponse>,
): ExtensionUtils {
	// Only the fields buildAsk reads are needed.
	return { interactionCallback: cb } as unknown as ExtensionUtils;
}

describe("buildAsk", () => {
	it("returns null when no interaction channel is wired", async () => {
		const ask = buildAsk(makeUtils(undefined));
		expect(await ask("anything")).toBeNull();
	});

	it("forwards the question and suggestions and returns the answer value", async () => {
		const seen: InteractionRequest[] = [];
		const utils = makeUtils(async (req) => {
			seen.push(req);
			return { id: req.id, value: "chosen" };
		});
		const ask = buildAsk(utils);
		const answer = await ask("What color?", { suggestions: ["red", "blue"] });

		expect(answer).toBe("chosen");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			type: "ask",
			question: "What color?",
			suggestions: ["red", "blue"],
		});
		expect(seen[0]!.id).toBeTruthy();
	});

	it("assigns a unique id per call", async () => {
		const ids: string[] = [];
		const utils = makeUtils(async (req) => {
			ids.push(req.id);
			return { id: req.id, value: "x" };
		});
		const ask = buildAsk(utils);
		await ask("q1");
		await ask("q2");
		expect(ids[0]).not.toBe(ids[1]);
	});

	it("throws on an empty question", async () => {
		const ask = buildAsk(makeUtils(async (req) => ({ id: req.id, value: "" })));
		await expect(ask("   ")).rejects.toThrow("non-empty question");
	});
});
