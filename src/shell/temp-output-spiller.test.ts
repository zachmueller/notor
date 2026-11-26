import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger", () => {
	const noop = () => undefined;
	return { logger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});

import { createTempOutputSpiller, TempOutputSpiller } from "./temp-output-spiller";

describe("createTempOutputSpiller", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns a spiller when the temp directory can be created", async () => {
		vi.spyOn(TempOutputSpiller.prototype, "ensureSpillDir").mockResolvedValue();
		await expect(createTempOutputSpiller()).resolves.toBeInstanceOf(TempOutputSpiller);
	});

	it("returns null instead of throwing when the directory can't be created", async () => {
		vi.spyOn(TempOutputSpiller.prototype, "ensureSpillDir").mockRejectedValue(new Error("EROFS: read-only file system"));
		await expect(createTempOutputSpiller()).resolves.toBeNull();
	});
});
