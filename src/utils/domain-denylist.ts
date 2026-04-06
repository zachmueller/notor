/**
 * Domain denylist checking utility.
 *
 * Extracted from `src/tools/fetch-webpage.ts` so it can be shared across
 * tools (`fetch_webpage`, `web_search`), the dispatcher, and the extension
 * runtime without coupling to any single tool class.
 */

/**
 * Check whether a URL's hostname matches any pattern in the deny list.
 *
 * Supports two pattern forms:
 *   - Exact match: `"example.com"` blocks exactly `example.com`
 *   - Wildcard: `"*.example.com"` blocks `sub.example.com` but not `example.com`
 *
 * @param url      - The URL to check.
 * @param denylist - Array of domain patterns from settings.
 * @returns `{ blocked: true, pattern: string }` if blocked, or
 *          `{ blocked: false }` if allowed.
 */
export function isDomainBlocked(
	url: string,
	denylist: string[]
): { blocked: true; pattern: string } | { blocked: false } {
	if (!denylist || denylist.length === 0) {
		return { blocked: false };
	}

	let hostname: string;
	try {
		const parsed = new URL(url);
		hostname = parsed.hostname.toLowerCase();
	} catch {
		// If URL can't be parsed, let the fetch itself fail later
		return { blocked: false };
	}

	for (const pattern of denylist) {
		const p = pattern.trim().toLowerCase();
		if (!p) continue;

		if (p.startsWith("*.")) {
			// Wildcard: *.example.com blocks sub.example.com but not example.com
			const baseDomain = p.slice(2);
			if (hostname.endsWith("." + baseDomain)) {
				return { blocked: true, pattern };
			}
		} else {
			// Exact match
			if (hostname === p) {
				return { blocked: true, pattern };
			}
		}
	}

	return { blocked: false };
}
