import { describe, it, expect } from "vitest";
import { TemplateVariableRegistry } from "./registry";

describe("TemplateVariableRegistry", () => {
	function makeRegistry(): TemplateVariableRegistry {
		const registry = new TemplateVariableRegistry();
		registry.register("notor_dir", () => "notor");
		registry.register("vault_name", () => "My Vault");
		return registry;
	}

	it("resolves a single variable", () => {
		const r = makeRegistry();
		expect(r.resolve("{notor_dir}/memory")).toBe("notor/memory");
	});

	it("resolves multiple variables in one string", () => {
		const r = makeRegistry();
		expect(r.resolve("{notor_dir}/{vault_name}")).toBe("notor/My Vault");
	});

	it("leaves unknown variables as-is", () => {
		const r = makeRegistry();
		expect(r.resolve("{unknown}/foo")).toBe("{unknown}/foo");
	});

	it("is idempotent", () => {
		const r = makeRegistry();
		const input = "{notor_dir}/memory/{vault_name}";
		const once = r.resolve(input);
		const twice = r.resolve(once);
		expect(twice).toBe(once);
	});

	it("handles empty input", () => {
		const r = makeRegistry();
		expect(r.resolve("")).toBe("");
	});

	it("passes through plain text without variables", () => {
		const r = makeRegistry();
		expect(r.resolve("plain text")).toBe("plain text");
	});

	it("resolves adjacent variables without delimiter", () => {
		const r = makeRegistry();
		expect(r.resolve("{notor_dir}{vault_name}")).toBe("notorMy Vault");
	});

	it("resolves variable in code-like context", () => {
		const r = makeRegistry();
		expect(r.resolve("const x = {notor_dir}")).toBe("const x = notor");
	});

	it("lists registered variable names", () => {
		const r = makeRegistry();
		expect(r.list().sort()).toEqual(["notor_dir", "vault_name"]);
	});

	it("overwrites resolver when registering the same name twice", () => {
		const r = new TemplateVariableRegistry();
		r.register("notor_dir", () => "old");
		r.register("notor_dir", () => "new");
		expect(r.resolve("{notor_dir}")).toBe("new");
	});

	it("replaces all occurrences of a variable", () => {
		const r = makeRegistry();
		expect(r.resolve("{notor_dir}/a/{notor_dir}/b")).toBe(
			"notor/a/notor/b",
		);
	});
});
