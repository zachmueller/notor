import type { App } from "obsidian";

type DedupCache = Record<string, string>;

interface DreamCursor {
	last_run: string;
}

export async function readDedupCache(
	app: App,
	cachePath: string,
	windowHours: number,
): Promise<DedupCache> {
	const exists = await app.vault.adapter.exists(cachePath);
	if (!exists) return {};

	let raw: string;
	try {
		raw = await app.vault.adapter.read(cachePath);
	} catch {
		return {};
	}

	let cache: DedupCache;
	try {
		cache = JSON.parse(raw) as DedupCache;
	} catch {
		return {};
	}

	const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
	const pruned: DedupCache = {};
	for (const [fingerprint, timestamp] of Object.entries(cache)) {
		if (new Date(timestamp).getTime() >= cutoff) {
			pruned[fingerprint] = timestamp;
		}
	}

	return pruned;
}

export async function writeDedupEntry(
	app: App,
	cachePath: string,
	fingerprint: string,
	timestamp: string,
): Promise<void> {
	let cache: DedupCache = {};

	const exists = await app.vault.adapter.exists(cachePath);
	if (exists) {
		try {
			const raw = await app.vault.adapter.read(cachePath);
			cache = JSON.parse(raw) as DedupCache;
		} catch {
			cache = {};
		}
	}

	cache[fingerprint] = timestamp;
	const tmp = cachePath + ".tmp";
	await app.vault.adapter.write(tmp, JSON.stringify(cache));
	if (await app.vault.adapter.exists(cachePath)) {
		await app.vault.adapter.remove(cachePath);
	}
	await app.vault.adapter.rename(tmp, cachePath);
}

export async function readDreamCursor(
	app: App,
	cursorPath: string,
): Promise<string | null> {
	const exists = await app.vault.adapter.exists(cursorPath);
	if (!exists) return null;

	try {
		const raw = await app.vault.adapter.read(cursorPath);
		const cursor = JSON.parse(raw) as DreamCursor;
		return cursor.last_run ?? null;
	} catch {
		return null;
	}
}

export async function advanceDreamCursor(
	app: App,
	cursorPath: string,
	timestamp: string,
): Promise<void> {
	const data: DreamCursor = { last_run: timestamp };
	const tmp = cursorPath + ".tmp";
	await app.vault.adapter.write(tmp, JSON.stringify(data));
	if (await app.vault.adapter.exists(cursorPath)) {
		await app.vault.adapter.remove(cursorPath);
	}
	await app.vault.adapter.rename(tmp, cursorPath);
}
