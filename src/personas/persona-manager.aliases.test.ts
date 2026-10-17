/**
 * PersonaManager lookups through built-in persona aliases
 * (`orchestration-creator` ↔ `circuit-creator`). Discovery is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Persona } from "../types";

// ---------------------------------------------------------------------------
// PersonaManager lookup matrix (discovery mocked)
// ---------------------------------------------------------------------------

const discovered: { list: Persona[] } = { list: [] };
vi.mock("./persona-discovery", () => ({
	discoverPersonas: async () => discovered.list,
	getPersonasRootPath: (d: string) => `${d.replace(/\/$/, "")}/personas`,
}));

import { PersonaManager } from "./persona-manager";

function persona(name: string): Persona {
	return { name } as unknown as Persona;
}

function manager() {
	return new PersonaManager(
		{} as never,
		{} as never,
		{ notor_dir: "notor", active_persona: "" } as never,
		{} as never,
		async () => {},
	);
}

describe("PersonaManager — alias-aware lookup", () => {
	beforeEach(() => {
		discovered.list = [];
	});

	it.each([
		["orchestration-creator", ["circuit-creator"], "circuit-creator"],
		["circuit-creator", ["circuit-creator"], "circuit-creator"],
		["circuit-creator", ["orchestration-creator"], "orchestration-creator"],
		["orchestration-creator", ["orchestration-creator"], "orchestration-creator"],
	])("getPersonaByName(%j) with %j discovered → %j", async (requested, available, expected) => {
		discovered.list = available.map(persona);
		expect((await manager().getPersonaByName(requested))?.name).toBe(expected);
	});

	it("prefers an exact match over an alias match", async () => {
		discovered.list = [persona("circuit-creator"), persona("orchestration-creator")];
		expect((await manager().getPersonaByName("orchestration-creator"))?.name).toBe("orchestration-creator");
	});

	it("treats a legacy-named folder as a built-in", () => {
		expect(manager().isBuiltinPersona("orchestration-creator")).toBe(true);
		expect(manager().isBuiltinPersona("researcher")).toBe(false);
	});
});
