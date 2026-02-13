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
import { platform, homedir } from "node:os";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ObsidianProcess {
	process: ChildProcess;
	wsEndpoint: string;
	cdpPort: number;
	/** Path to the backup of obsidian.json (if vault config was modified) */
	configBackupPath?: string;
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
 * Resolve the path to Obsidian's global config file (obsidian.json).
 * This file controls which vaults are open on launch.
 */
function getObsidianConfigPath(): string {
	const os = platform();
	switch (os) {
		case "darwin":
			return path.join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
		case "win32":
			return path.join(process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"), "obsidian", "obsidian.json");
		case "linux":
			return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "obsidian", "obsidian.json");
		default:
			throw new Error(`Unsupported platform: ${os}`);
	}
}

/**
 * Modify Obsidian's global config so only the specified vault opens on launch.
 * Backs up the original config and returns the backup path for later restoration.
 */
function setOpenVault(vaultPath: string): string | undefined {
	const configPath = getObsidianConfigPath();
	if (!fs.existsSync(configPath)) {
		console.log("[launcher] obsidian.json not found — skipping vault config override");
		return undefined;
	}

	const backupPath = configPath + ".e2e-backup";
	const raw = fs.readFileSync(configPath, "utf8");
	fs.writeFileSync(backupPath, raw);
	console.log(`[launcher] Backed up obsidian.json → ${backupPath}`);

	const config = JSON.parse(raw) as {
		vaults: Record<string, { path: string; ts?: number; open?: boolean }>;
		[key: string]: unknown;
	};

	const resolvedVaultPath = path.resolve(vaultPath);
	let foundTestVault = false;

	for (const [id, vault] of Object.entries(config.vaults)) {
		if (path.resolve(vault.path) === resolvedVaultPath) {
			// Mark the test vault as open
			config.vaults[id] = { ...vault, open: true, ts: Date.now() };
			foundTestVault = true;
		} else {
			// Close all other vaults
			const { open, ...rest } = vault;
			config.vaults[id] = rest;
		}
	}

	// If the test vault isn't registered yet, add it
	if (!foundTestVault) {
		const id = Math.random().toString(16).slice(2, 18);
		config.vaults[id] = { path: resolvedVaultPath, ts: Date.now(), open: true };
		console.log(`[launcher] Registered test vault in obsidian.json (id: ${id})`);
	}

	fs.writeFileSync(configPath, JSON.stringify(config));
	console.log(`[launcher] Set only vault "${resolvedVaultPath}" to open`);

	return backupPath;
}

/**
 * Restore the original obsidian.json from backup.
 */
function restoreObsidianConfig(backupPath: string): void {
	const configPath = getObsidianConfigPath();
	if (fs.existsSync(backupPath)) {
		fs.copyFileSync(backupPath, configPath);
		fs.unlinkSync(backupPath);
		console.log("[launcher] Restored original obsidian.json");
	}
}

/**
 * Launch Obsidian with remote debugging enabled and wait for CDP to be ready.
 */
export async function launchObsidian(options: LaunchOptions): Promise<ObsidianProcess> {
	const obsidianPath = process.env.OBSIDIAN_PATH || resolveObsidianPath();
	const cdpPort = options.cdpPort ?? 9222;
	const timeout = options.timeout ?? 30_000;

	// Configure Obsidian to open only the test vault
	const configBackupPath = setOpenVault(options.vaultPath);

	const args = [
		`--remote-debugging-port=${cdpPort}`,
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
		configBackupPath,
	};
}

/**
 * Gracefully shut down an Obsidian process.
 */
export async function closeObsidian(obsidian: ObsidianProcess): Promise<void> {
	if (obsidian.process.killed) {
		// Still restore config even if process was already killed
		if (obsidian.configBackupPath) {
			restoreObsidianConfig(obsidian.configBackupPath);
		}
		return;
	}

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

	// Restore the original vault config
	if (obsidian.configBackupPath) {
		restoreObsidianConfig(obsidian.configBackupPath);
	}

	console.log("[launcher] Obsidian shut down");
}
