/**
 * Check 5 — dependency advisories. The scorecard lists these as a warning
 * ("Dependency has a potential vulnerability advisory"), so they never block;
 * new high/critical ones are called out first.
 */

import { run } from "./exec";
import type { CheckContext, CheckOutput, Finding } from "./types";

interface AuditVia {
	source?: number;
	url?: string;
	severity?: string;
	title?: string;
}

interface AuditReport {
	vulnerabilities?: Record<string, { severity: string; via: Array<AuditVia | string> }>;
}

export function checkAudit(ctx: CheckContext): CheckOutput {
	if (ctx.offline) {
		return { findings: [{ check: "audit", id: "offline", severity: "WARN", title: "--offline: skipped npm audit" }] };
	}
	const r = run("npm", ["audit", "--json"], ctx.root);
	const report = JSON.parse(r.stdout || "{}") as AuditReport;
	const advisories = new Map<string, { pkg: string; severity: string; title: string }>();
	for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
		for (const via of v.via) {
			if (typeof via === "string" || !via.url) continue;
			advisories.set(via.url, { pkg, severity: via.severity ?? v.severity, title: via.title ?? "" });
		}
	}
	const known = new Set(ctx.baseline?.advisories ?? []);
	const fresh = [...advisories].filter(([url]) => !known.has(url));
	const findings: Finding[] = [];
	const serious = fresh.filter(([, a]) => a.severity === "high" || a.severity === "critical");
	if (serious.length > 0) {
		findings.push({
			check: "audit",
			id: "new-high-advisories",
			severity: "WARN",
			title: "New high/critical advisories since the baseline",
			count: serious.length,
			locations: serious.map(([url, a]) => `${a.pkg} (${a.severity}): ${a.title} ${url}`),
		});
	}
	const other = fresh.filter(([, a]) => a.severity !== "high" && a.severity !== "critical");
	if (other.length > 0) {
		findings.push({
			check: "audit",
			id: "new-advisories",
			severity: "WARN",
			title: "New advisories since the baseline",
			count: other.length,
			locations: other.map(([url, a]) => `${a.pkg} (${a.severity}): ${url}`),
		});
	}
	findings.push({
		check: "audit",
		id: "advisories",
		severity: "INFO",
		title: `${advisories.size} advisories across ${Object.keys(report.vulnerabilities ?? {}).length} packages (npm audit)`,
		count: advisories.size,
		baseline: ctx.baseline?.advisories.length,
	});
	return { findings, measured: { advisories: [...advisories.keys()].sort() } };
}
