import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
			obsidian: resolve(__dirname, "src/__mocks__/obsidian.ts"),
		},
	},
	test: {
		// Plugin/product tests live beside their sources in src/. The esbuild/
		// build-tooling tests are plain ESM (.mjs) outside the TypeScript program.
		include: ["src/**/*.test.ts", "esbuild/**/*.test.mjs"],
	},
});
