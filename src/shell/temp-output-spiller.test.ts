import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger", () => {
	const noop = () => undefined;
	return { logger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});

describe("createTempOutputSpiller", () => {
	afterEach(() => {
		vi.doUnmock("fs");
		vi.resetModules();
	});

	it("returns a spiller when the temp directory can be created", async () => {
		vi.resetModules();
		const { createTempOutputSpiller, TempOutputSpiller } = await import("./temp-output-spiller");
		const spiller = await createTempOutputSpiller();
		expect(spiller).toBeInstanceOf(TempOutputSpiller);
	});

	it("returns null instead of throwing when the directory can't be created", async () => {
		vi.resetModules();
		vi.doMock("fs", async (orig) => {
			const actual = await orig<typeof import("fs")>();
			return {
				...actual,
				promises: { ...actual.promises, mkdir: async () => { throw new Error("EROFS: read-only file system"); } },
			};
		});
		const { createTempOutputSpiller } = await import("./temp-output-spiller");
		await expect(createTempOutputSpiller()).resolves.toBeNull();
	});
});
