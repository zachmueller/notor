/**
 * Extension compilation pipeline.
 *
 * Strips TypeScript types via Sucrase, then compiles the resulting
 * JavaScript into an AsyncFunction with injected context arguments.
 */

import { transform } from "sucrase";
import type { CompiledExtensionFn } from "./types";

// ---------------------------------------------------------------------------
// AsyncFunction constructor
// ---------------------------------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
	...args: string[]
) => CompiledExtensionFn;

// ---------------------------------------------------------------------------
// Type stripping
// ---------------------------------------------------------------------------

/**
 * Strip TypeScript type annotations from extension code using Sucrase.
 *
 * Handles: type annotations, interfaces, generics, `as` casts,
 * type-only imports (stripped to empty).
 *
 * @throws Error with descriptive message if Sucrase encounters a syntax error
 */
export function stripTypes(code: string): string {
	try {
		const result = transform(code, {
			transforms: ["typescript"],
		});
		return result.code;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`TypeScript transform failed: ${message}`);
	}
}

/**
 * Strip TypeScript types AND convert ES module exports to CJS-style assignments.
 *
 * Block code fences use `export function render(...)` syntax. The `"imports"`
 * transform converts these to `exports.render = function render(...)`, which
 * populates the `exports` object injected by `compileBlockModule`.
 */
function stripTypesForBlock(code: string): string {
	try {
		const result = transform(code, {
			transforms: ["typescript", "imports"],
		});
		return result.code;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`TypeScript+imports transform failed: ${message}`);
	}
}

// ---------------------------------------------------------------------------
// AsyncFunction compilation
// ---------------------------------------------------------------------------

/** Tool argument names — injected as function parameters at runtime. */
const TOOL_ARG_NAMES = ["app", "obsidian", "utils", "libs", "settings", "shared", "params"] as const;

/** Automation argument names — `context` replaces `params`. */
const AUTOMATION_ARG_NAMES = ["app", "obsidian", "utils", "libs", "settings", "shared", "context"] as const;

/**
 * Compile stripped JavaScript into an async function for user tools.
 * Parameters: `app`, `obsidian`, `utils`, `libs`, `settings`, `shared`, `params`.
 */
export function compileToolFunction(strippedCode: string): CompiledExtensionFn {
	return new AsyncFunction(...TOOL_ARG_NAMES, strippedCode);
}

/**
 * Compile stripped JavaScript into an async function for user automations.
 * Parameters: `app`, `obsidian`, `utils`, `libs`, `settings`, `shared`, `context`.
 */
export function compileAutomationFunction(strippedCode: string): CompiledExtensionFn {
	return new AsyncFunction(...AUTOMATION_ARG_NAMES, strippedCode);
}

// ---------------------------------------------------------------------------
// Block module compilation
// ---------------------------------------------------------------------------

/**
 * Compile a block extension code fence into a module-like object by executing
 * it with an `exports` object injected, then returning that object.
 *
 * Block code fences use ES module `export function` syntax. Sucrase's
 * `"imports"` transform converts these to CJS-style `exports.X = ...`
 * assignments, which populate the `exports` object passed as a parameter.
 *
 * @param rawCode - Raw TypeScript/JavaScript code from the extension code fence
 * @returns The populated exports object on success, or a descriptive error string
 */
export function compileBlockModule(
	rawCode: string,
): { exports: Record<string, unknown> } | { error: string } {
	let strippedCode: string;
	try {
		strippedCode = stripTypesForBlock(rawCode);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return { error: message };
	}

	try {
		const fn = new AsyncFunction("exports", strippedCode);
		const exports: Record<string, unknown> = {};
		// Execute synchronously — block modules should not contain top-level await
		const result = fn(exports);
		// If the function returned a promise (due to async wrapper), swallow it;
		// exports will have been populated synchronously before any awaits.
		result.catch(() => { /* ignore top-level async errors in block module init */ });
		return { exports };
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return { error: `Compilation failed: ${message}` };
	}
}

// ---------------------------------------------------------------------------
// Full compilation pipeline
// ---------------------------------------------------------------------------

/**
 * Full compilation pipeline: strip TypeScript types → compile to AsyncFunction.
 *
 * @param rawCode - Raw TypeScript/JavaScript code from the extension code fence
 * @param type    - Whether this is a tool or automation (determines argument names)
 * @returns Compiled function on success, or descriptive error string on failure
 */
export function compileExtension(
	rawCode: string,
	type: "tool" | "automation",
): { fn: CompiledExtensionFn } | { error: string } {
	// Step 1: Strip TypeScript types
	let strippedCode: string;
	try {
		strippedCode = stripTypes(rawCode);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return { error: message };
	}

	// Step 2: Compile to AsyncFunction
	try {
		const fn = type === "tool"
			? compileToolFunction(strippedCode)
			: compileAutomationFunction(strippedCode);
		return { fn };
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return { error: `Compilation failed: ${message}` };
	}
}
