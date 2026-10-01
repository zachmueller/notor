import { describe, it, expect } from "vitest";
import { parseTokenCount } from "../model-context-limits";

describe("parseTokenCount", () => {
	it("accepts plain, comma-separated and suffixed counts", () => {
		expect(parseTokenCount("200000")).toBe(200_000);
		expect(parseTokenCount("200,000")).toBe(200_000);
		expect(parseTokenCount("200k")).toBe(200_000);
		expect(parseTokenCount("1M")).toBe(1_000_000);
		expect(parseTokenCount("1.5m")).toBe(1_500_000);
		expect(parseTokenCount(" 128K ")).toBe(128_000);
	});

	it("rejects anything else", () => {
		for (const input of ["", "abc", "-5", "1g", "0", "1e6"]) {
			expect(parseTokenCount(input)).toBeNull();
		}
	});
});
