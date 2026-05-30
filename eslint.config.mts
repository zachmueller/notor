import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	// Spread the plugin's recommended config (includes js recommended,
	// typescript-eslint recommendedTypeChecked, @microsoft/sdl, import,
	// depend, no-console, no-restricted-globals, and all obsidianmd rules)
	...obsidianmd.configs.recommended,

	// Enable type-checked linting and browser globals for TS files
	{
		files: ["**/*.ts", "**/*.tsx"],
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
				// Obsidian globals (injected at runtime)
				activeDocument: "readonly",
				activeWindow: "readonly",
				createDiv: "readonly",
				createSpan: "readonly",
				createEl: "readonly",
				createFragment: "readonly",
				createSvg: "readonly",
				// TypeScript built-in types that no-undef doesn't know about
				AsyncIterable: "readonly",
				NodeJS: "readonly",
				BufferEncoding: "readonly",
			},
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},

	// Allow fetch in provider files — requestUrl does not support streaming;
	// fetch is required for SSE/chunked inference responses
	{
		files: ["src/providers/**/*.ts"],
		rules: {
			"no-restricted-globals": [
				"error",
				{
					name: "app",
					message: "Avoid using the global app object. Instead use the reference provided by your plugin instance.",
				},
				{
					name: "localStorage",
					message: "Prefer `App#saveLocalStorage` / `App#loadLocalStorage` functions to write / read localStorage data that's unique to a vault.",
				},
			],
		},
	},

	// Project-specific rule overrides for src/**/*.ts
	{
		files: ["src/**/*.ts"],
		rules: {
			"@typescript-eslint/no-unused-vars": ["error", {
				varsIgnorePattern: "^_",
				argsIgnorePattern: "^_",
			}],
			"obsidianmd/ui/sentence-case": ["error", {
				enforceCamelCaseLower: true,
				brands: [
					// DEFAULT_BRANDS (must list explicitly since array replaces defaults)
					"iOS", "iPadOS", "macOS", "Windows", "Android", "Linux",
					"Obsidian", "Obsidian Sync", "Obsidian Publish",
					"Google Drive", "Dropbox", "OneDrive", "iCloud Drive",
					"YouTube", "Slack", "Discord", "Telegram", "WhatsApp", "Twitter", "X",
					"Readwise", "Zotero", "Excalidraw", "Mermaid",
					"Markdown", "LaTeX", "JavaScript", "TypeScript", "Node.js",
					"npm", "pnpm", "Yarn", "Git", "GitHub",
					"GitLab", "Notion", "Evernote", "Roam Research", "Logseq", "Anki",
					"Reddit", "VS Code", "Visual Studio Code", "IntelliJ IDEA", "WebStorm", "PyCharm",
					// Project-specific brands
					"Anthropic", "Bedrock", "OpenAI", "LM Studio", "Notor", "Azure", "Ollama",
				],
				acronyms: [
					// DEFAULT_ACRONYMS (must list explicitly since array replaces defaults)
					"API", "HTTP", "HTTPS", "URL", "DNS", "TCP", "IP", "SSH", "TLS", "SSL",
					"FTP", "SFTP", "SMTP", "JSON", "XML", "HTML", "CSS", "PDF", "CSV", "YAML",
					"SQL", "PNG", "JPG", "JPEG", "GIF", "SVG", "2FA", "MFA", "OAuth", "JWT",
					"LDAP", "SAML", "SDK", "IDE", "CLI", "GUI", "CRUD", "REST", "SOAP",
					"CPU", "GPU", "RAM", "SSD", "USB", "UI", "OK", "RSS", "S3", "WebDAV",
					"ID", "UUID", "GUID", "SHA", "MD5", "ASCII", "UTF-8", "UTF-16",
					"DOM", "CDN", "FAQ", "AI", "ML",
					// Project-specific acronyms
					"LLM", "OS", "MB", "MCP", "SSE", "STS", "AWS", "GB", "KB",
				],
				ignoreRegex: ["^https?://"],
			}],
		},
	},

	globalIgnores([
		"node_modules",
		"build",
		"dist",
		"specs",
		"e2e",
		"**/*.test.ts",        // sibling test files
		"src/**/__tests__/**", // test files + fixtures (excluded from tsconfig)
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		"vitest.config.ts",
	]),
);
