/**
 * PersonaManager events that keep per-panel personas in sync with disk:
 * the refreshed list (persona file edits) and the startup restore.
 * Discovery is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Persona } from "../types";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const discovered: { list: Persona[] } = { list: [] };
vi.mock("./persona-discovery", () => ({
	discoverPersonas: async () => discovered.list,
	getPersonasRootPath: (d: string) => `${d.replace(/\/$/, "")}/personas`,
}));

import { PersonaManager } from "./persona-manager";

function persona(name: string, prompt_content = ""): Persona {
	return { name, prompt_content, preferred_preset: null, preferred_provider: null, preferred_model: null } as unknown as Persona;
}

function manager(activePersona = "") {
	const settings = { notor_dir: "notor", active_persona: activePersona, model_presets: [] };
	const pm = new PersonaManager({} as never, {} as never, settings as never, {} as never, async () => {});
	return { pm, settings };
}

describe("PersonaManager.refreshActivePersona — refreshed event", () => {
	beforeEach(() => {
		discovered.list = [];
	});

	it("fires with fresh personas even when the manager has no active persona", async () => {
		discovered.list = [persona("writer", "v2")];
		const { pm } = manager();
		const seen: Persona[][] = [];
		pm.setOnPersonasRefreshed((list) => seen.push(list));

		expect(await pm.refreshActivePersona()).toEqual({ status: "no-active-persona" });
		expect(seen).toHaveLength(1);
		expect(seen[0]![0]!.prompt_content).toBe("v2");
	});

	it("stops firing after unregister", async () => {
		const { pm } = manager();
		const cb = vi.fn();
		pm.setOnPersonasRefreshed(cb)();
		await pm.refreshActivePersona();
		expect(cb).not.toHaveBeenCalled();
	});
});

describe("PersonaManager.restoreFromSettings — restored event", () => {
	beforeEach(() => {
		discovered.list = [];
	});

	it("fires with the restored persona", async () => {
		discovered.list = [persona("writer")];
		const { pm, settings } = manager("writer");
		const cb = vi.fn();
		pm.setOnPersonaRestored(cb);

		await pm.restoreFromSettings();
		expect(cb).toHaveBeenCalledWith(expect.objectContaining({ name: "writer" }));
		expect(settings.active_persona).toBe("writer");
	});

	it("does not fire, and clears the setting, when the persona is gone", async () => {
		const { pm, settings } = manager("writer");
		const cb = vi.fn();
		pm.setOnPersonaRestored(cb);

		await pm.restoreFromSettings();
		expect(cb).not.toHaveBeenCalled();
		expect(settings.active_persona).toBe("");
	});
});
