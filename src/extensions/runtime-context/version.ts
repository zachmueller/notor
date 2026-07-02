/**
 * Runtime API contract version.
 *
 * Bumped on any breaking change to the `utils`/`libs`/`obsidian` surface handed
 * to extension code. Extensions may declare `notor-min-api: N` in frontmatter to
 * require at least version N; the parser refuses to load an extension whose
 * required version exceeds the version this build provides.
 *
 * Kept in its own tiny module so the parser can import it without pulling in the
 * runtime-context builder graph (which would create an import cycle).
 */
export const RUNTIME_API_VERSION = 1;
