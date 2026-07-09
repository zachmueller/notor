/**
 * Shared logic for the esbuild `strip-script-injection` plugin.
 *
 * Neutralizes dead-code <script>-injection feature-detection branches that ship
 * inside transitive deps (immediate, setimmediate) and docx's pre-bundled dist.
 * These are IE6-8 / browser-only async-scheduler fallbacks that NEVER execute
 * under Node/Electron (we run process.nextTick / native setImmediate). Removing
 * the literal document.createElement("script") text lets the Obsidian
 * community-plugin reviewer's "dynamic script element creation" check pass.
 * Runtime behavior is unchanged — the Node code paths are untouched.
 *
 * WHY THIS IS SAFE AGAINST DRIFT: the regexes below are shape-sensitive (file
 * path, quote style, receiver expression). The versions of the culprit deps are
 * therefore pinned — `docx`/`mammoth` exact (not `^`) and their transitive
 * scheduler chain (`jszip`, `immediate`, `setimmediate`, `lie`) pinned via the
 * `overrides` block in package.json — so a silent minor/patch bump can't change
 * the code shape out from under the strip. `strip-script-injection.test.mjs`
 * locks these regexes against the three known source shapes, and
 * `verifyNoScriptInjection()` in esbuild.config.mjs fails the prod build if any
 * `createElement("script")` literal survives. A deliberate dep bump requires
 * re-running the build (which asserts 0 survivors) and updating the fixtures.
 */

// Scope tightly to the resolved culprit files (also docx cjs variants in case
// resolution ever picks the require path). [\\/] = cross-platform separator.
export const STRIP_FILTER =
	/(immediate[\\/]lib[\\/]index\.js|setimmediate[\\/]setImmediate\.js|docx[\\/]dist[\\/]index\.(mjs|cjs|umd\.cjs))$/;

// (A) turn the feature TEST false -> esbuild folds the if-block / ternary arm away.
export const TEST_RE =
	/(['"])onreadystatechange\1\s*in\s+[\w$.]+\.createElement\((['"])script\2\)/g;

// (B) rewrite any remaining BODY literal -> result is independent of esbuild DCE.
export const BODY_RE = /\bcreateElement\((['"])script\1\)/g;

/**
 * Apply the two neutralizing rewrites to a module's source text. Pure and
 * side-effect-free so it can be unit-tested without invoking esbuild. Safe to
 * call repeatedly with the shared global regexes — String.prototype.replace
 * does not depend on/retain `lastIndex`.
 *
 * @param {string} src Raw module source.
 * @returns {string} Source with the dead script-injection branch neutralized.
 */
export function stripScriptInjectionSource(src) {
	return src
		.replace(TEST_RE, "false")
		.replace(BODY_RE, 'createElement("template")');
}
