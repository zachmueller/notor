/**
 * Which files Obsidian's scanner lints, as inferred from the 0.12.0 scorecard:
 * TypeScript under the tsconfig-covered `src/` and `e2e/` trees, excluding tests,
 * mocks and `scripts/` directories. It flagged `e2e/lib/**` and `e2e/run-and-collect.ts`
 * (which our eslint config ignores) but nothing in `*.test.ts`, `__mocks__/`,
 * `e2e/scripts/` (including the non-test `setup-vault.ts`), `.claude/` or the root
 * build scripts, though all of them contain flagged patterns. `calibrate.ts`
 * re-checks this against a live scorecard.
 */

const SCANNED_ROOTS = ["src/", "e2e/"];
const TS_FILE = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE = [/[.-](test|spec)\.[cm]?[jt]sx?$/, /(^|\/)__tests__\//, /(^|\/)__mocks__\//, /(^|\/)scripts\//];
/** e2e trees that exist only locally (never committed), excluded by e2e/tsconfig.json. */
const NEVER_SCANNED = [/^e2e\/(dist|results|test-vault|test-user-data)\//, /\.d\.ts$/];

export const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export function inScannerScope(path: string): boolean {
	return (
		SCANNED_ROOTS.some((r) => path.startsWith(r)) &&
		TS_FILE.test(path) &&
		!TEST_FILE.some((p) => p.test(path)) &&
		!NEVER_SCANNED.some((p) => p.test(path))
	);
}
