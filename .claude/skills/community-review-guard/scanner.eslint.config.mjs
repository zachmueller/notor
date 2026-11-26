/**
 * Scanner-equivalent lint config for community-review-guard.
 *
 * Deliberately NOT our eslint.config.mts: Obsidian's scanner ignores repo config
 * (it linted e2e/, which we ignore, and didn't apply our sentence-case errors), so
 * this is eslint-plugin-obsidianmd's plain `recommended` plus the type information
 * it needs. The file list (src/ + e2e/, minus tests) comes from lib/scope.ts.
 * preflight copies this file into a cached toolchain dir holding the latest plugin,
 * so its imports resolve there; with --offline it runs from the repo's node_modules.
 */

import obsidianmd from "eslint-plugin-obsidianmd";

const root = process.env.GUARD_TARGET_ROOT ?? process.cwd();

export default [
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.{ts,tsx,mts,cts}"],
		languageOptions: {
			parserOptions: { projectService: true, tsconfigRootDir: root },
		},
		rules: {
			// Plugin 0.6.0 turns this off, but the 0.12.3 scorecard still reported it at
			// 13 require() lines: the scanner's ruleset lags the plugin's latest.
			"@typescript-eslint/no-require-imports": "error",
		},
	},
];
