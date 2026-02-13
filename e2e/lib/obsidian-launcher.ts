/**
 * Obsidian Launcher
 *
 * Starts Obsidian with Chrome DevTools Protocol (CDP) remote debugging enabled.
 * This allows Playwright to attach to the running Obsidian Electron process and
 * interact with it — capturing console logs, clicking UI elements, etc.
 *
 * The launcher:
 *  1. Resolves the Obsidian executable path based on the OS
 *  2. Launches Obsidian with --remote-debugging-port=<port>
 *  3. Waits for the CDP endpoint to become available
 *  4. Returns the child process and WebSocket debugger URL
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import * as http from "node:http";

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
 * Launch Obsidian with remote debugging enabled and wait for CDP to be ready.
 */
export async function launchObsidian(options: LaunchOptions): Promise<ObsidianProcess> {
	const obsidianPath = process.env.OBSIDIAN_PATH || resolveObsidianPath();
	const cdpPort = options.cdpPort ?? 9222;
	const timeout = options.timeout ?? 30_000;

	const args = [
		`--remote-debugging-port=${cdpPort}`,
		`--vault=${options.vaultPath}`,  // Obsidian CLI flag to open specific vault
		...(options.extraArgs ?? []),
	];

	console.log(`[launcher] Starting Obsidian: ${obsidianPath}`);
	console.log(`[launcher] Args: ${args.join(" ")}`);
	console.log(`[launcher] CDP port: ${cdpPort}`);

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
		console.log(`[obsidian:stdout] ${data.toString().trim()}`);
	});

	child.stderr?.on("data", (data) => {
		console.log(`[obsidian:stderr] ${data.toString().trim()}`);
	});

	child.on("error", (err) => {
		console.error(`[launcher] Failed to start Obsidian: ${err.message}`);
	});

	child.on("exit", (code, signal) => {
		console.log(`[launcher] Obsidian exited: code=${code}, signal=${signal}`);
	});

	console.log(`[launcher] Waiting for CDP endpoint on port ${cdpPort}...`);
	const wsEndpoint = await waitForCDP(cdpPort, timeout);
	console.log(`[launcher] CDP ready: ${wsEndpoint}`);

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
	if (obsidian.process.killed) return;

	console.log("[launcher] Shutting down Obsidian...");

	// Try graceful shutdown first
	obsidian.process.kill("SIGTERM");

	// Wait up to 5s for graceful exit
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			if (!obsidian.process.killed) {
				console.log("[launcher] Force-killing Obsidian");
				obsidian.process.kill("SIGKILL");
			}
			resolve();
		}, 5000);

		obsidian.process.on("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});

	console.log("[launcher] Obsidian shut down");
}