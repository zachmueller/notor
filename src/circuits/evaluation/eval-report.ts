/**
 * Evaluation report notes — one note per evaluated session per pass, under
 * `{notor_dir}/{data root}/evals/{circuit-slug}-{session_id}-{pass_id}.md`.
 *
 * The frontmatter is FLAT on purpose: one `notor-score-{evaluator}-{dimension}`
 * key per score, so Dataview / Bases can compare runs of a circuit with no
 * extra tooling. The body repeats the scores as a table and carries the
 * rationales, failures, edited notes, and raw-data pointers.
 *
 * Discriminator `notor-type: circuit-eval-report` — deliberately NOT `circuit`
 * / `circuit-step` / `circuit-evaluator`, so circuit discovery ignores it.
 * Mirrors `failure-report.ts`.
 */

import { circuitDataRootPath, type CircuitDataRootName } from "../data-root";
import { codeFence, mdCell, slugifyFlowName, yamlString } from "../failure-report";
import { logger } from "../../utils/logger";
import type { SessionFs } from "../session-manager";
import type { EvalPassResult, EvalSessionResult } from "./types";

const log = logger("CircuitEvalReport");

function trimSlash(p: string): string {
	return p.replace(/\/+$/, "");
}

/** Vault-relative path of a session's report note for one pass. */
export function evalReportPath(
	notorDir: string,
	rootName: CircuitDataRootName,
	flowName: string,
	sessionId: string,
	passId: string,
): string {
	return `${circuitDataRootPath(trimSlash(notorDir), rootName)}/evals/${slugifyFlowName(flowName)}-${sessionId}-${passId}.md`;
}

/** `notor-score-{evaluator-slug}-{dimension-slug}`. */
export function scoreKey(evaluatorName: string, dimension: string): string {
	return `notor-score-${slugifyFlowName(evaluatorName)}-${slugifyFlowName(dimension)}`;
}

/** `notor-overall-{evaluator-slug}`. */
export function overallKey(evaluatorName: string): string {
	return `notor-overall-${slugifyFlowName(evaluatorName)}`;
}

export interface WriteEvalReportArgs {
	notorDir: string;
	fs: SessionFs;
	rootName: CircuitDataRootName;
	pass: Pick<EvalPassResult, "passId" | "circuit" | "trigger" | "fingerprint" | "finishedAt">;
	session: EvalSessionResult;
}

function yamlScalar(value: number | boolean | string | null): string {
	if (value === null) return "null";
	if (typeof value === "string") return yamlString(value);
	return String(value);
}

function yamlList(items: readonly string[]): string {
	return items.length === 0 ? "[]" : `[${items.map(yamlString).join(", ")}]`;
}

export function buildEvalReportMarkdown(args: Omit<WriteEvalReportArgs, "fs" | "notorDir" | "rootName">): string {
	const { pass, session } = args;
	const meta = session.meta;
	const outcome = session.outcome;
	const scored = session.outcomes.filter((o) => o.ok);
	const failed = session.outcomes.filter((o) => !o.ok);
	const evalCost = session.outcomes.reduce((sum, o) => sum + o.costUsd, 0);
	const models = [...new Set(session.outcomes.map((o) => o.modelId).filter((m): m is string => !!m))];

	const fm: string[] = [
		"---",
		"notor-type: circuit-eval-report",
		`notor-circuit: ${yamlString(pass.circuit)}`,
		`notor-session-id: ${yamlString(session.sessionId)}`,
		`notor-eval-pass-id: ${yamlString(pass.passId)}`,
		`notor-eval-trigger: ${yamlString(pass.trigger)}`,
		`notor-eval-fingerprint: ${yamlString(pass.fingerprint)}`,
		`notor-eval-evaluated-at: ${yamlString(pass.finishedAt)}`,
		`notor-eval-evaluators: ${yamlList(session.outcomes.map((o) => o.evaluator))}`,
		`notor-eval-failed: ${yamlList(failed.map((o) => o.evaluator))}`,
		`notor-eval-models: ${yamlList(models)}`,
		`notor-eval-cost-usd: ${evalCost.toFixed(4)}`,
		`notor-run-status: ${yamlScalar(outcome?.status ?? null)}`,
		`notor-run-terminal-topic: ${yamlScalar(outcome?.terminalTopic ?? null)}`,
		`notor-run-origin: ${yamlScalar(meta?.origin ?? null)}`,
		`notor-run-started-at: ${yamlScalar(meta?.started_at ?? null)}`,
		`notor-run-iterations: ${yamlScalar(outcome?.iterations ?? null)}`,
		`notor-run-cost-usd: ${outcome ? outcome.costUsd.toFixed(4) : "null"}`,
	];
	for (const o of scored) {
		for (const [dim, value] of Object.entries(o.scores)) {
			fm.push(`${scoreKey(o.evaluator, dim)}: ${yamlScalar(value)}`);
		}
		if (o.overall !== null) fm.push(`${overallKey(o.evaluator)}: ${o.overall}`);
	}
	fm.push("---");

	const sections: string[] = [fm.join("\n")];
	sections.push(`# Circuit evaluation: ${pass.circuit}`);
	sections.push(
		[
			`**Session:** \`${session.sessionId}\``,
			`**Pass:** \`${pass.passId}\` (${pass.trigger}, evaluator set \`${pass.fingerprint}\`)`,
			`**Evaluated:** ${pass.finishedAt}`,
			`**Evaluation cost:** $${evalCost.toFixed(4)}` + (models.length ? ` · models: ${models.map((m) => `\`${m}\``).join(", ")}` : ""),
		].join("  \n"),
	);

	sections.push(`## Objective\n\n${meta?.prompt?.trim() || "_(none recorded)_"}`);

	if (outcome) {
		const lines = [
			`**Status:** ${outcome.status} (terminal event \`${outcome.terminalTopic}\`)`,
			`**Started:** ${meta?.started_at ?? "unknown"} · **Origin:** ${meta?.origin ?? "unknown"}`,
			`**Step-turns:** ${outcome.iterations} · **Run cost:** $${outcome.costUsd.toFixed(4)}`,
		];
		if (outcome.source === "fallback") lines.push(`_This session predates the run.result record; the structured return is unavailable._`);
		let block = `## Run outcome\n\n${lines.join("  \n")}\n\n**Closing text:**\n\n${codeFence(outcome.text || "(empty)")}`;
		if (outcome.structured !== null && outcome.structured !== undefined) {
			let json: string;
			try {
				json = JSON.stringify(outcome.structured, null, 2) ?? "null";
			} catch {
				json = "(unserializable)";
			}
			block += `\n\n**Structured return:**\n\n${codeFence(json)}`;
		}
		sections.push(block);
	}

	if (scored.length > 0) {
		const rows = scored.flatMap((o) =>
			Object.entries(o.scores).map(([dim, value]) => `| ${mdCell(o.evaluator)} | ${mdCell(dim)} | ${String(value)} |`),
		);
		const overallRows = scored
			.filter((o) => o.overall !== null)
			.map((o) => `| ${mdCell(o.evaluator)} | _overall_ | ${o.overall} |`);
		sections.push(
			`## Scores\n\n` + ["| Evaluator | Dimension | Score |", "|---|---|---|", ...rows, ...overallRows].join("\n"),
		);
		sections.push(
			`## Rationales\n\n` +
				scored
					.map((o) => `### ${o.evaluator}${o.modelId ? ` (\`${o.modelId}\`)` : ""}\n\n${o.rationale.trim() || "_(none)_"}`)
					.join("\n\n"),
		);
	} else {
		sections.push(`## Scores\n\n_(no evaluator produced a score)_`);
	}

	if (failed.length > 0) {
		sections.push(
			`## Failures\n\n` +
				["| Evaluator | Reason | Detail |", "|---|---|---|", ...failed.map((o) => `| ${mdCell(o.evaluator)} | \`${o.reason}\` | ${mdCell(o.detail)} |`)].join("\n"),
		);
	}

	const sessionDir = session.meta ? `sessions/${session.sessionId}` : null;
	if (sessionDir) {
		sections.push(
			`## Raw data\n\n` +
				`- Scores log: \`${sessionDir}/evals.jsonl\`\n` +
				`- Session metadata: \`${sessionDir}/session.json\`\n` +
				`- Full event log: \`${sessionDir}/session-log.jsonl\``,
		);
	}

	return sections.join("\n\n") + "\n";
}

/** Compose and write one session's report note. Returns the written path. */
export async function writeEvalReport(args: WriteEvalReportArgs): Promise<string> {
	const path = evalReportPath(args.notorDir, args.rootName, args.pass.circuit, args.session.sessionId, args.pass.passId);
	const content = buildEvalReportMarkdown({ pass: args.pass, session: args.session });
	await args.fs.write(path, content);
	log.info("Wrote circuit evaluation report", { path, session: args.session.sessionId, pass: args.pass.passId });
	return path;
}
