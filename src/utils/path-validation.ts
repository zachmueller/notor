/**
 * Shared path resolution and validation utilities.
 *
 * Provides boundary-checked path resolution used by `read_file`, `read_docx`,
 * `write_docx`, and `execute_command` to ensure all filesystem operations stay
 * within the vault root or a user-configured allow-list of paths.
 *
 * @see specs/04c-docx/spec.md — FR-74
 */

import { normalize, resolve, isAbsolute } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// isPathWithin
// ---------------------------------------------------------------------------

/**
 * Check whether `target` is within (or equal to) `base`.
 *
 * Uses normalized path prefix comparison with a separator boundary check so
 * that `/foo/bar` is not falsely considered a prefix of `/foo/baz`.
 *
 * @param target - The path to test.
 * @param base   - The ancestor directory to test against.
 * @returns `true` if `target` equals `base` or is a descendant of `base`.
 */
export function isPathWithin(target: string, base: string): boolean {
	const normalTarget = normalize(target);
	const normalBase = normalize(base);

	if (normalTarget === normalBase) return true;

	// Ensure base ends with a separator before doing the prefix check so that
	// `/foo/bar` does not match `/foo/baz`.
	const baseWithSep =
		normalBase.endsWith("/") || normalBase.endsWith("\\")
			? normalBase
			: normalBase + "/";

	return normalTarget.startsWith(baseWithSep);
}

// ---------------------------------------------------------------------------
// expandTilde
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` to the user's home directory.
 *
 * Only a bare `~` or `~/…` is expanded; `~username/…` style paths are left
 * unchanged (Node has no portable way to resolve another user's home dir).
 *
 * @param inputPath - Raw path string (may start with `~`).
 * @returns Path with leading tilde expanded, or the original string unchanged.
 */
export function expandTilde(inputPath: string): string {
	if (inputPath === "~") return homedir();
	if (inputPath.startsWith("~/")) return homedir() + inputPath.slice(1);
	return inputPath;
}

// ---------------------------------------------------------------------------
// resolveAndValidatePath
// ---------------------------------------------------------------------------

/**
 * Resolve `inputPath` to an absolute path and validate that it falls within
 * `vaultRoot` or one of the entries in `allowedPaths`.
 *
 * Resolution rules:
 * - Empty / undefined / whitespace-only → resolved to `vaultRoot`
 * - Absolute path → used as-is (after `normalize`)
 * - Relative path → resolved from `vaultRoot` then `normalize`d
 *
 * @param inputPath    - Raw path string from the tool parameter (may be
 *                       empty, relative, or absolute).
 * @param vaultRoot    - Absolute path to the vault root directory.
 * @param allowedPaths - Additional allowed directory paths from settings.
 * @returns Discriminated union: `{ valid: true; resolvedPath }` on success or
 *          `{ valid: false; error }` when the path is outside all allowed
 *          boundaries.
 */
export function resolveAndValidatePath(
	inputPath: string | undefined,
	vaultRoot: string,
	allowedPaths: string[]
): { valid: true; resolvedPath: string } | { valid: false; error: string } {
	let resolved: string;

	if (!inputPath || inputPath.trim() === "") {
		resolved = vaultRoot;
	} else {
		const expanded = expandTilde(inputPath);
		if (isAbsolute(expanded)) {
			resolved = normalize(expanded);
		} else {
			resolved = normalize(resolve(vaultRoot, expanded));
		}
	}

	const normalizedVaultRoot = normalize(vaultRoot);

	// Check vault root first (always implicitly allowed)
	if (isPathWithin(resolved, normalizedVaultRoot)) {
		return { valid: true, resolvedPath: resolved };
	}

	// Check each user-configured allowed path
	for (const allowed of allowedPaths) {
		const trimmed = allowed.trim();
		if (!trimmed) continue;
		const normalizedAllowed = normalize(expandTilde(trimmed));
		if (isPathWithin(resolved, normalizedAllowed)) {
			return { valid: true, resolvedPath: resolved };
		}
	}

	return {
		valid: false,
		error: `Path '${inputPath}' is outside the allowed paths.`,
	};
}
