import type { BuilderContext, ExtensionUtils, WebviewElement } from "./types";
import { logger } from "../../utils/logger";
import { Notice, Platform, normalizePath } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";

function getAvailableKeys(root: unknown, pathParts: string[]): string {
	let target: unknown = root;
	for (const part of pathParts) {
		if (target === undefined || target === null || typeof target !== "object") return "";
		const index = /^\d+$/.test(part) ? Number(part) : part;
		target = (target as Record<string | number, unknown>)[index];
	}
	if (target === undefined || target === null || typeof target !== "object") return "";
	return Object.keys(target).slice(0, 30).join(", ");
}

export function buildPluginUtils(ctx: BuilderContext): Pick<ExtensionUtils,
	"staleTracker" | "checkpointManager" | "noteOpener" | "logger" |
	"queue" | "readPluginSettings" | "editPluginSetting" | "notify" | "webview"
> {
	const { plugin, conversationId } = ctx;

	const webview: ExtensionUtils["webview"] = (() => {
		if (!Platform.isDesktopApp) return null;

		const WEB_VIEWER_TYPE_CANDIDATES = ["web-viewer", "web-browser", "webviewer", "browser-view"];
		const WEBVIEW_PROP_CANDIDATES = ["webview", "webviewEl", "frame", "browser"];
		const webviewLog = logger("ext:webview");
		const leafCache = plugin.getWebviewLeafCache();

		function resolveWebViewerType(): string | null {
			const registry = plugin.app.viewRegistry?.viewByType;
			if (!registry) return null;
			for (const candidate of WEB_VIEWER_TYPE_CANDIDATES) {
				if (candidate in registry) return candidate;
			}
			return null;
		}

		function hasExecuteJavaScript(candidate: unknown): candidate is WebviewElement {
			return (
				typeof candidate === "object" &&
				candidate !== null &&
				typeof (candidate as { executeJavaScript?: unknown }).executeJavaScript === "function"
			);
		}

		function findWebviewEl(leaf: WorkspaceLeaf): WebviewElement | null {
			const view = leaf.view as unknown as Record<string, unknown>;
			for (const prop of WEBVIEW_PROP_CANDIDATES) {
				const candidate = view[prop];
				if (hasExecuteJavaScript(candidate)) return candidate;
			}
			const el = leaf.view.containerEl.querySelector("webview");
			if (hasExecuteJavaScript(el)) return el;
			return null;
		}

		const wv: NonNullable<ExtensionUtils["webview"]> = {
			getConversationId: () => conversationId ?? null,

			getActiveWebview: () => {
				const viewType = resolveWebViewerType();
				if (!viewType) return null;
				const leaves = plugin.app.workspace.getLeavesOfType(viewType);
				const activeLeaf = plugin.app.workspace.getMostRecentLeaf();
				const targetLeaf = leaves.find((l) => l === activeLeaf) ?? null;
				if (!targetLeaf) return null;
				const webviewEl = findWebviewEl(targetLeaf);
				if (!webviewEl) return null;
				return { leaf: targetLeaf, webviewEl };
			},

			getConversationWebview: async () => {
				const convId = conversationId;
				if (!convId) return null;

				const viewType = resolveWebViewerType();
				if (!viewType) {
					webviewLog.warn("No Web Viewer view type found in registry");
					return null;
				}

				let leaf = leafCache.get(convId);
				const allLeaves = plugin.app.workspace.getLeavesOfType(viewType);

				if (leaf && !allLeaves.includes(leaf)) {
					leafCache.delete(convId);
					leaf = undefined;
				}

				if (!leaf) {
					const persistedUrl = await wv.readPersistedUrl(convId);

					leaf = plugin.app.workspace.getLeaf("tab");
					await leaf.setViewState({
						type: viewType,
						active: true,
						state: persistedUrl ? { url: persistedUrl } : {},
					});
					leafCache.set(convId, leaf);
				}

				let webviewEl: WebviewElement | null = null;
				for (let attempt = 0; attempt < 10; attempt++) {
					webviewEl = findWebviewEl(leaf);
					if (webviewEl) break;
					await new Promise(r => setTimeout(r, 300));
				}

				if (!webviewEl) {
					webviewLog.warn("Could not find webview element on leaf after retries");
					return null;
				}

				if (typeof webviewEl.getWebContentsId === "function") {
					try {
						webviewEl.getWebContentsId();
					} catch {
						const el = webviewEl;
						await Promise.race([
							new Promise<void>(resolve => {
								el.addEventListener("dom-ready", () => resolve(), { once: true });
							}),
							new Promise<void>(resolve => setTimeout(resolve, 5000)),
						]);
					}
				}

				return { leaf, webviewEl };
			},

			waitForReady: async (webviewEl: WebviewElement, revealLeaf = false, leaf?: WorkspaceLeaf) => {
				if (revealLeaf && leaf) {
					void plugin.app.workspace.revealLeaf(leaf);
				}

				if (typeof webviewEl.isLoading === "function" && webviewEl.isLoading()) {
					await Promise.race([
						new Promise<void>(resolve => {
							webviewEl.addEventListener("did-finish-load", () => resolve(), { once: true });
						}),
						new Promise<void>(resolve => setTimeout(resolve, 10000)),
					]);
				}

				for (let i = 0; i < 3; i++) {
					try {
						const state = await webviewEl.executeJavaScript("document.readyState");
						if (state === "complete") break;
					} catch { /* ignore */ }
					await new Promise(r => setTimeout(r, 500));
				}

				await new Promise(r => setTimeout(r, 300));
			},

			persistUrl: async (cId: string, url: string) => {
				const sidecarPath = normalizePath(
					`${plugin.settings.history_path}${cId}.webview.json`,
				);
				const data = JSON.stringify({ url, timestamp: new Date().toISOString() });
				await plugin.app.vault.adapter.write(sidecarPath, data);
			},

			readPersistedUrl: async (cId: string) => {
				const sidecarPath = normalizePath(
					`${plugin.settings.history_path}${cId}.webview.json`,
				);
				try {
					const raw = await plugin.app.vault.adapter.read(sidecarPath);
					const parsed = JSON.parse(raw) as { url?: unknown };
					return typeof parsed.url === "string" ? parsed.url : null;
				} catch {
					return null;
				}
			},
		};

		return wv;
	})();

	return {
		staleTracker: plugin.getStaleTracker(),

		checkpointManager: plugin.getSharedCheckpointManager(),

		noteOpener: plugin.getNoteOpener(),

		logger: (name: string) => logger(`ext:${name}`),

		queue: (() => {
			const tlq = plugin.getTaskLaneQueue();
			return {
				enqueue: <T>(lane: string, fn: () => Promise<T>, delayMs?: number) => tlq.enqueue(lane, fn, delayMs),
				pending: (lane: string) => tlq.pending(lane),
			};
		})(),

		readPluginSettings: () => {
			const clone = JSON.parse(JSON.stringify(plugin.settings)) as Record<string, unknown>;

			const mcpServers = clone.mcp_servers as Record<string, Record<string, unknown>> | undefined;
			if (mcpServers && typeof mcpServers === "object") {
				for (const server of Object.values(mcpServers)) {
					if (Array.isArray(server.env)) {
						for (const entry of server.env as Array<Record<string, unknown>>) {
							if (entry && typeof entry === "object") {
								entry.value = "[REDACTED]";
							}
						}
					}
					if (Array.isArray(server.headers)) {
						for (const header of server.headers as Array<Record<string, unknown>>) {
							if (header && typeof header === "object" && header.sensitive) {
								header.value = "[REDACTED]";
							}
						}
					}
				}
			}

			const providers = clone.providers as Array<Record<string, unknown>> | undefined;
			if (Array.isArray(providers)) {
				for (const p of providers) {
					delete p.model_cache;
					delete p.model_cache_timestamp;
				}
			}

			return clone;
		},

		editPluginSetting: (() => {
			const editLog = logger("ext:editPluginSetting");

			const BLOCKED_PATTERNS = [
				/^mcp_servers\.[^.]+\.env/,
				/^mcp_servers\.[^.]+\.headers/,
				/^providers\.\d+\.model_cache/,
				/^providers\.\d+\.model_cache_timestamp/,
			];

			return async (keyPath: string, value: unknown): Promise<{
				success: boolean;
				oldValue?: unknown;
				newValue?: unknown;
				error?: string;
			}> => {
				for (const pattern of BLOCKED_PATTERNS) {
					if (pattern.test(keyPath)) {
						return { success: false, error: `Path "${keyPath}" is blocked for security reasons.` };
					}
				}

				const parts = keyPath.split(".");
				let target: unknown = plugin.settings as unknown;
				for (let i = 0; i < parts.length - 1; i++) {
					const key = parts[i]!;
					const index = /^\d+$/.test(key) ? Number(key) : key;
					if (target === undefined || target === null || typeof target !== "object") {
						const availableKeys = getAvailableKeys(plugin.settings, parts.slice(0, i));
						return {
							success: false,
							error: `Invalid path: "${keyPath}" — "${parts.slice(0, i + 1).join(".")}" does not exist.${availableKeys ? ` Available keys at "${parts.slice(0, i).join(".") || "(root)"}": ${availableKeys}` : ""}`,
						};
					}
					target = (target as Record<string | number, unknown>)[index];
				}

				if (target === undefined || target === null || typeof target !== "object") {
					return { success: false, error: `Invalid path: "${keyPath}" — parent is not an object.` };
				}

				const lastKey = parts[parts.length - 1]!;
				const finalIndex = /^\d+$/.test(lastKey) ? Number(lastKey) : lastKey;
				const targetObj = target as Record<string | number, unknown>;

				if (!(finalIndex in targetObj)) {
					const parentPath = parts.slice(0, -1).join(".");
					const availableKeys = Object.keys(targetObj).slice(0, 30).join(", ");
					return {
						success: false,
						error: `Key "${lastKey}" does not exist at "${parentPath || "(root)"}". Available keys: ${availableKeys}`,
					};
				}

				const oldValue: unknown = targetObj[finalIndex];

				if (oldValue !== null && oldValue !== undefined && value !== null && value !== undefined) {
					const oldType = Array.isArray(oldValue) ? "array" : typeof oldValue;
					const newType = Array.isArray(value) ? "array" : typeof value;
					if (oldType !== newType) {
						return {
							success: false,
							error: `Type mismatch: "${keyPath}" is ${oldType} but got ${newType}.`,
						};
					}
				}

				targetObj[finalIndex] = value;

				try {
					await plugin.saveSettings();
					editLog.info("Setting edited", { keyPath, oldValue, newValue: value });
					return { success: true, oldValue, newValue: value };
				} catch (e) {
					targetObj[finalIndex] = oldValue;
					const msg = e instanceof Error ? e.message : String(e);
					editLog.error("Failed to save settings after edit", { keyPath, error: msg });
					return { success: false, error: `Failed to save: ${msg}` };
				}
			};
		})(),

		notify: (message: string, options?: {
			duration?: number;
			onClick?: () => void;
			onRightClick?: () => void;
		}) => {
			const duration = options?.duration ?? 5000;
			const notice = new Notice(message, duration);

			if (options?.onClick) {
				notice.messageEl.addEventListener("click", () => {
					notice.hide();
					options.onClick!();
				});
			}

			if (options?.onRightClick && Platform.isDesktop) {
				notice.messageEl.oncontextmenu = (e) => {
					e.preventDefault();
					notice.hide();
					options.onRightClick!();
				};
			}
		},

		webview,
	};
}
