import { describe, it, expect } from "vitest";
import {
	stripTypes,
	compileToolFunction,
	compileAutomationFunction,
	compileExtension,
} from "../compiler";

// ---------------------------------------------------------------------------
// stripTypes
// ---------------------------------------------------------------------------

describe("stripTypes", () => {
	it("strips type annotations", () => {
		const code = `const x: string = "hello";`;
		const result = stripTypes(code);
		expect(result).toContain(`const x = "hello"`);
		expect(result).not.toContain(": string");
	});

	it("strips interface declarations", () => {
		const code = `interface Foo { bar: string; }\nconst x = 1;`;
		const result = stripTypes(code);
		expect(result).not.toContain("interface");
		expect(result).toContain("const x = 1");
	});

	it("strips as casts", () => {
		const code = `const x = foo as string;`;
		const result = stripTypes(code);
		expect(result).toContain("const x = foo ");
		expect(result).not.toContain("as string");
	});

	it("strips generic type parameters", () => {
		const code = `const arr: Array<string> = [];`;
		const result = stripTypes(code);
		expect(result).toContain("const arr");
		expect(result).not.toContain("Array<string>");
	});

	it("passes plain JavaScript through unchanged", () => {
		const code = `const x = 42;\nfunction add(a, b) { return a + b; }`;
		const result = stripTypes(code);
		expect(result).toContain("const x = 42");
		expect(result).toContain("function add(a, b)");
	});

	it("strips type-only imports", () => {
		const code = `import type { Foo } from "bar";\nconst x = 1;`;
		const result = stripTypes(code);
		expect(result).not.toContain("import type");
		expect(result).toContain("const x = 1");
	});

	it("throws descriptive error for syntax errors", () => {
		const code = `const x: = ;`;
		expect(() => stripTypes(code)).toThrow("TypeScript transform failed");
	});
});

// ---------------------------------------------------------------------------
// compileToolFunction
// ---------------------------------------------------------------------------

describe("compileToolFunction", () => {
	it("creates a callable async function with 7 parameters", () => {
		const fn = compileToolFunction(`return params.query;`);
		expect(typeof fn).toBe("function");
		expect(fn.length).toBe(7); // 7 named params
	});

	it("compiled function is callable with correct arguments", async () => {
		const fn = compileToolFunction(`return params.value + 1;`);
		const result = await fn(
			null,           // app
			null,           // obsidian
			null,           // utils
			null,           // libs
			null,           // settings
			null,           // shared
			{ value: 41 },  // params
		);
		expect(result).toBe(42);
	});

	it("supports async/await in compiled code", async () => {
		const fn = compileToolFunction(`
			const result = await Promise.resolve("hello");
			return result + " world";
		`);
		const result = await fn(null, null, null, null, null, null, {});
		expect(result).toBe("hello world");
	});

	it("return value is accessible", async () => {
		const fn = compileToolFunction(`return { key: "value" };`);
		const result = await fn(null, null, null, null, null, null, {});
		expect(result).toEqual({ key: "value" });
	});

	it("can access all injected arguments", async () => {
		const fn = compileToolFunction(`
			return {
				hasApp: app !== null,
				hasObsidian: obsidian !== null,
				hasUtils: utils !== null,
				hasLibs: libs !== null,
				hasSettings: settings !== null,
				hasShared: shared !== null,
				query: params.query,
			};
		`);
		const result = await fn(
			{ vault: {} },         // app
			{ Notice: class {} },  // obsidian
			{ logger: () => {} },  // utils
			{ marked: {} },        // libs
			{ apiKey: "key" },     // settings
			{ debug: false },      // shared
			{ query: "test" },     // params
		);
		expect(result).toEqual({
			hasApp: true,
			hasObsidian: true,
			hasUtils: true,
			hasLibs: true,
			hasSettings: true,
			hasShared: true,
			query: "test",
		});
	});
});

// ---------------------------------------------------------------------------
// compileAutomationFunction
// ---------------------------------------------------------------------------

describe("compileAutomationFunction", () => {
	it("creates a callable async function with 7 parameters", () => {
		const fn = compileAutomationFunction(`return context.hookEvent;`);
		expect(typeof fn).toBe("function");
		expect(fn.length).toBe(7);
	});

	it("compiled function receives context (not params)", async () => {
		const fn = compileAutomationFunction(`return context.hookEvent;`);
		const result = await fn(
			null, null, null, null, null, null,
			{ hookEvent: "on_save" },
		);
		expect(result).toBe("on_save");
	});
});

// ---------------------------------------------------------------------------
// compileExtension
// ---------------------------------------------------------------------------

describe("compileExtension", () => {
	it("compiles valid TypeScript tool code", () => {
		const result = compileExtension(`const x: string = "hello"; return x;`, "tool");
		expect("fn" in result).toBe(true);
		if ("fn" in result) {
			expect(typeof result.fn).toBe("function");
		}
	});

	it("compiles valid TypeScript automation code", () => {
		const result = compileExtension(`const x: number = 42; return x;`, "automation");
		expect("fn" in result).toBe(true);
	});

	it("returns error for Sucrase syntax error", () => {
		const result = compileExtension(`const x: = ;`, "tool");
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toContain("TypeScript transform failed");
		}
	});

	it("returns error for AsyncFunction constructor syntax error", () => {
		// Code that passes type stripping but has a JS syntax error
		const result = compileExtension(`function { broken`, "tool");
		expect("error" in result).toBe(true);
		if ("error" in result) {
			expect(result.error).toBeTruthy();
		}
	});

	it("compiled tool function works end-to-end", async () => {
		const result = compileExtension(
			`const msg: string = "typed"; return msg;`,
			"tool",
		);
		expect("fn" in result).toBe(true);
		if ("fn" in result) {
			const output = await result.fn(null, null, null, null, null, null, {});
			expect(output).toBe("typed");
		}
	});

	it("compiled automation function works end-to-end", async () => {
		const result = compileExtension(
			`const event: string = context.hookEvent; return event;`,
			"automation",
		);
		expect("fn" in result).toBe(true);
		if ("fn" in result) {
			const output = await result.fn(null, null, null, null, null, null, { hookEvent: "pre_send" });
			expect(output).toBe("pre_send");
		}
	});
});
