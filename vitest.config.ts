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
		include: ["src/**/*.test.ts"],
	},
});
