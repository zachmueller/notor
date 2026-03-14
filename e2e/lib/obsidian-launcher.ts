/**
 * Obsidian Launcher
 *
 * Starts Obsidian with Chrome DevTools Protocol (CDP) remote debugging enabled.
 * This allows Playwright to attach to the running Obsidian Electron process and
 * interact with it — capturing console logs, clicking UI elements, etc.
 *
 * The launcher:
 *  1. Resolves the Obsidian executable path based on the OS
 *  2. Prepares an isolated user data directory so the test instance never
 *     conflicts with a running main Obsidian vault (via --user-data-dir)
 *  3. Launches Obsidian with --remote-debugging-port=<port>
 *  4. Waits for the CDP endpoint to become available
 *  5. Returns the child process and WebSocket debugger URL
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ObsidianProcess {
	process: ChildProcess;
	wsEndpoint: string;
	cdpPort: number;
}

export interface LaunchOptions {
	/** Path to the Obsidian vault to open */
	vaultPath: string;
	/** CDP remote debugging port (default: 9222) */
	cdpPort?: number;
	/** Maximum time to wait for CDP endpoint (ms, default: 30000) */
	timeout?: number;
	/**
	 * Path to an isolated Electron user-data directory for the test instance.
	 * Defaults to `e2e/test-user-data/`. Using a separate directory prevents
	 * conflicts when the user's main Obsidian vault is already open.
	 */
	userDataDir?: string;
	/** Additional CLI arguments for Obsidian */
	extraArgs?: string[];
}

/**
 * Resolve the Obsidian executable path for the current platform.
 * Supports macOS, Windows, and Linux.
 */
function resolveObsidianPath(): string {
	const os = platform();
	switch (os) {
		case "darwin":
			return "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
		case "win32":
			return `${process.env.LOCALAPPDATA}\\Obsidian\\Obsidian.exe`;
		case "linux":
			// Common locations; try to find via which first
			try {
				return execSync("which obsidian", { encoding: "utf8" }).trim();
			} catch {
				// Fallback to common paths
				const paths = [
					"/usr/bin/obsidian",
					"/usr/local/bin/obsidian",
					"/snap/bin/obsidian",
					`${process.env.HOME}/.local/bin/obsidian`,
				];
				for (const p of paths) {
					try {
						execSync(`test -f "${p}"`);
						return p;
					} catch {
						continue;
					}
				}
				throw new Error(
					"Could not find Obsidian executable on Linux. " +
					"Set OBSIDIAN_PATH environment variable to the Obsidian binary."
				);
			}
		default:
			throw new Error(`Unsupported platform: ${os}`);
	}
}

/**
 * Wait for the CDP /json/version endpoint to respond, then return
 * the WebSocket debugger URL.
 */
async function waitForCDP(port: number, timeout: number): Promise<string> {
	const start = Date.now();
	const url = `http://127.0.0.1:${port}/json/version`;

	while (Date.now() - start < timeout) {
		try {
			const data = await new Promise<string>((resolve, reject) => {
				const req = http.get(url, (res) => {
					let body = "";
					res.on("data", (chunk) => (body += chunk));
					res.on("end", () => resolve(body));
				});
				req.on("error", reject);
				req.setTimeout(2000, () => {
					req.destroy();
					reject(new Error("timeout"));
				});
			});

			const json = JSON.parse(data);
			if (json.webSocketDebuggerUrl) {
				return json.webSocketDebuggerUrl;
			}
		} catch {
			// Not ready yet — wait and retry
		}

		await new Promise((r) => setTimeout(r, 500));
	}

	throw new Error(
		`Timed out waiting for Obsidian CDP endpoint on port ${port} after ${timeout}ms. ` +
		`Make sure Obsidian is installed and can launch.`
	);
}

/**
 * Prepare an isolated Electron user-data directory for the test Obsidian instance.
 *
 * By pointing Obsidian at a separate --user-data-dir, the test process is fully
 * isolated from any already-running Obsidian instance. Electron's single-instance
 * lock is per user-data-dir, so both instances can coexist without conflict.
 *
 * The directory is persistent across test runs (not a temp dir) so that Obsidian
 * skips its first-run setup UI on subsequent invocations.
 */
function ensureTestUserDataDir(userDataDir: string, vaultPath: string): void {
	fs.mkdirSync(userDataDir, { recursive: true });

	const configPath = path.join(userDataDir, "obsidian.json");
	const resolvedVaultPath = path.resolve(vaultPath);

	// Read existing config to reuse the vault ID if this path was already registered.
	// Preserving the ID across runs lets Obsidian retain per-vault state (trust
	// confirmation, window position, etc.) so dialogs don't reappear every run.
	let existingId: string | undefined;
	if (fs.existsSync(configPath)) {
		try {
			const existing = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
				vaults?: Record<string, { path: string }>;
			};
			for (const [id, vault] of Object.entries(existing.vaults ?? {})) {
				if (path.resolve(vault.path) === resolvedVaultPath) {
					existingId = id;
					break;
				}
			}
		} catch {
			// Malformed config — will be overwritten below
		}
	}

	const id = existingId ?? Math.random().toString(16).slice(2, 18);
	const config = {
		vaults: {
			[id]: { path: resolvedVaultPath, ts: Date.now(), open: true },
		},
	};
	fs.writeFileSync(configPath, JSON.stringify(config));
	console.debug(`[launcher] Wrote test obsidian.json → ${configPath}`);
	console.debug(`[launcher] Test vault: ${resolvedVaultPath} (id: ${id})`);
}

/**
 * Launch Obsidian with remote debugging enabled and wait for CDP to be ready.
 */
export async function launchObsidian(options: LaunchOptions): Promise<ObsidianProcess> {
	const obsidianPath = process.env.OBSIDIAN_PATH || resolveObsidianPath();
	const cdpPort = options.cdpPort ?? 9222;
	const timeout = options.timeout ?? 30_000;
	const userDataDir = options.userDataDir ?? path.resolve(__dirname, "..", "test-user-data");

	// Set up an isolated user-data directory so the test instance doesn't
	// conflict with any already-running Obsidian vault
	ensureTestUserDataDir(userDataDir, options.vaultPath);

	const args = [
		`--user-data-dir=${userDataDir}`,
		`--remote-debugging-port=${cdpPort}`,
		...(options.extraArgs ?? []),
	];

	console.debug(`[launcher] Starting Obsidian: ${obsidianPath}`);
	console.debug(`[launcher] Args: ${args.join(" ")}`);
	console.debug(`[launcher] CDP port: ${cdpPort}`);

	const child = spawn(obsidianPath, args, {
		detached: false,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			// Ensure Electron respects the remote debugging port
			ELECTRON_ENABLE_LOGGING: "1",
		},
	});

	child.stdout?.on("data", (data) => {
		console.debug(`[obsidian:stdout] ${data.toString().trim()}`);
	});

	child.stderr?.on("data", (data) => {
		console.debug(`[obsidian:stderr] ${data.toString().trim()}`);
	});

	child.on("error", (err) => {
		console.error(`[launcher] Failed to start Obsidian: ${err.message}`);
	});

	child.on("exit", (code, signal) => {
		console.debug(`[launcher] Obsidian exited: code=${code}, signal=${signal}`);
	});

	console.debug(`[launcher] Waiting for CDP endpoint on port ${cdpPort}...`);
	const wsEndpoint = await waitForCDP(cdpPort, timeout);
	console.debug(`[launcher] CDP ready: ${wsEndpoint}`);

	return {
		process: child,
		wsEndpoint,
		cdpPort,
	};
}

/**
 * Gracefully shut down an Obsidian process.
 */
export async function closeObsidian(obsidian: ObsidianProcess): Promise<void> {
	if (obsidian.process.killed) {
		return;
	}

	console.debug("[launcher] Shutting down Obsidian...");

	// Try graceful shutdown first
	obsidian.process.kill("SIGTERM");

	// Wait up to 5s for graceful exit
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			if (!obsidian.process.killed) {
				console.debug("[launcher] Force-killing Obsidian");
				obsidian.process.kill("SIGKILL");
			}
			resolve();
		}, 5000);

		obsidian.process.on("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});

	console.debug("[launcher] Obsidian shut down");
}
