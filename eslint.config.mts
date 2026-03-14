import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		files: ["src/**/*.ts"],
		plugins: {
			"@typescript-eslint": tseslint.plugin,
		},
		languageOptions: {
			parser: tseslint.parser,
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": ["error", {
				varsIgnorePattern: "^_",
				argsIgnorePattern: "^_",
			}],
			"@typescript-eslint/no-require-imports": "error",
			"no-restricted-globals": ["error", {
				name: "fetch",
				message: "Use Obsidian's requestUrl instead of fetch for cross-platform compatibility. Only disable this rule when fetch is strictly required (e.g. streaming responses).",
			}],
		},
	},
	{
		files: ["src/**/*.ts"],
		plugins: { obsidianmd },
		rules: {
			...obsidianmd.configs.recommended,
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
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
