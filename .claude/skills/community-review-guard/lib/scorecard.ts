/**
 * Parse the public Scorecard tab of a community.obsidian.md plugin page.
 *
 * The page is a Next.js RSC stream: `self.__next_f.push([1,"…"])` chunks whose rows
 * (`5d:[…]`) reference each other lazily (`"$L5d"`). Each scorecard finding is an
 * element keyed `<severity>:<n>:<title>`; its subtree holds GitHub blob links
 * (file:line locations) and list items (package names, counts).
 */

export type ScorecardSeverity = "high" | "medium" | "low" | "info" | "pass";

export interface ScorecardFinding {
	severity: ScorecardSeverity;
	title: string;
	/** `path:line` from GitHub blob links. */
	locations: string[];
	/** Other list items (package names, "70 network calls", …). */
	items: string[];
}

export interface Scorecard {
	/** Commit the scan ran against, taken from the blob links (null if none). */
	commit: string | null;
	findings: ScorecardFinding[];
}

type Node = unknown;

export function parseScorecard(html: string): Scorecard {
	const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)<\/script>/g)].map(
		(m) => JSON.parse(`"${m[1]!}"`) as string,
	);
	const rows = new Map<string, string>();
	for (const line of chunks.join("").split("\n")) {
		const m = /^([0-9a-f]+):(.*)$/.exec(line);
		if (m) rows.set(m[1]!, m[2]!);
	}
	const root = [...rows].find(([, v]) => v.startsWith('["$","div",null,{"id":"scorecard"'))?.[0];
	if (!root) throw new Error("scorecard row not found; the page structure changed");

	const parsed = new Map<string, Node>();
	const row = (id: string): Node => {
		if (!parsed.has(id)) {
			try {
				parsed.set(id, JSON.parse(rows.get(id)!) as Node);
			} catch {
				parsed.set(id, rows.get(id)!);
			}
		}
		return parsed.get(id);
	};

	const findings: ScorecardFinding[] = [];
	let commit: string | null = null;

	const walk = (n: Node, current: ScorecardFinding | null, seen: Set<string>): void => {
		if (typeof n === "string") {
			const ref = /^\$L?([0-9a-f]+)$/.exec(n);
			if (ref && rows.has(ref[1]!) && !seen.has(ref[1]!)) walk(row(ref[1]!), current, new Set(seen).add(ref[1]!));
			return;
		}
		if (!Array.isArray(n)) return;
		if (n[0] === "$" && typeof n[1] === "string" && n[3] && typeof n[3] === "object") {
			const [, tag, key, props] = n as [string, string, unknown, { children?: Node; href?: string }];
			let target = current;
			const m = typeof key === "string" ? /^(high|medium|low|info|pass):\d+:(.*)$/s.exec(key) : null;
			if (m) {
				target = { severity: m[1] as ScorecardSeverity, title: m[2]!.replace(/\*\*/g, ""), locations: [], items: [] };
				findings.push(target);
			}
			if (target && tag === "a" && props.href) {
				const blob = /github\.com\/[^/]+\/[^/]+\/blob\/([0-9a-f]{40})\/(.+?)#L(\d+)/.exec(props.href);
				if (blob) {
					commit ??= blob[1]!;
					target.locations.push(`${decodeURIComponent(blob[2]!)}:${blob[3]!}`);
					return;
				}
			}
			if (target && tag === "li" && typeof props.children === "string") target.items.push(props.children);
			walk(props.children, target, seen);
			return;
		}
		for (const c of n) walk(c, current, seen);
	};
	walk(row(root), null, new Set([root]));
	return { commit, findings };
}

export async function fetchScorecard(pluginId: string): Promise<string> {
	const res = await fetch(`https://community.obsidian.md/plugins/${pluginId}`);
	if (!res.ok) throw new Error(`community.obsidian.md returned ${res.status}`);
	return res.text();
}
