import { describe, it, expect } from "vitest";
import { circuitDataRootOf, circuitDataRootPath, resolveCircuitDataRootName } from "./data-root";

const existing = (...paths: string[]) => (p: string) => paths.includes(p);

describe("resolveCircuitDataRootName (sticky single data root)", () => {
	it("fresh install (neither root exists) → circuits", () => {
		expect(resolveCircuitDataRootName("notor", existing())).toBe("circuits");
	});

	it("legacy install (orchestrations/ exists) → orchestrations, even if circuits/ definitions exist", () => {
		expect(resolveCircuitDataRootName("notor", existing("notor/orchestrations", "notor/circuits"))).toBe(
			"orchestrations",
		);
	});

	it("data already under circuits/sessions → circuits, even when orchestrations/ also exists (sticky)", () => {
		expect(
			resolveCircuitDataRootName("notor", existing("notor/orchestrations", "notor/circuits/sessions")),
		).toBe("circuits");
	});

	it("tolerates a trailing slash on notor_dir", () => {
		expect(resolveCircuitDataRootName("notor/", existing("notor/orchestrations"))).toBe("orchestrations");
		expect(circuitDataRootPath("notor/", "circuits")).toBe("notor/circuits");
	});

	it("defaults a host without the member to the legacy root", () => {
		expect(circuitDataRootOf({})).toBe("orchestrations");
		expect(circuitDataRootOf({ getCircuitDataRootName: () => "circuits" })).toBe("circuits");
	});
});
