/**
 * Evaluation command UI — the picker surfaces behind "Notor: Evaluate circuit
 * sessions": choose a circuit that declares evaluators, multi-select its
 * finished sessions, run the pass with a live progress Notice. Kept ui→logic
 * like `circuit-modals.ts`: imports the evaluation logic, never the reverse.
 */

import { ButtonComponent, FuzzySuggestModal, Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import { CircuitDefinitionParser } from "../circuits/circuit-parser";
import { circuitDataRootOf, circuitDataRootPath } from "../circuits/data-root";
import { evaluateSessions, loadRubricBodies } from "../circuits/evaluation/evaluate-sessions";
import { evaluatorSetFingerprint } from "../circuits/evaluation/evaluator-fingerprint";
import { estimateEvalCeiling, listEvaluableSessions, type EvaluableSession } from "../circuits/evaluation/session-listing";
import type { EvalPassResult } from "../circuits/evaluation/types";
import type { CircuitHost } from "../circuits/host";
import { VaultSessionFs } from "../circuits/launch-wiring";
import { makeRecoveryFs } from "../circuits/recovery-boot";
import { CircuitSessionManager } from "../circuits/session-manager";
import type { Circuit } from "../circuits/types";
import { logger } from "../utils/logger";

const log = logger("CircuitEvaluation");

class EvalCircuitPickerModal extends FuzzySuggestModal<Circuit> {
	constructor(
		app: App,
		private readonly circuits: Circuit[],
		private readonly onSelect: (circuit: Circuit) => void,
		private readonly emptyMessage: string,
	) {
		super(app);
		this.setPlaceholder("Select a circuit to evaluate…");
	}

	getItems(): Circuit[] {
		return this.circuits;
	}

	getItemText(circuit: Circuit): string {
		const judges = circuit.evaluators.map((e) => e.name).join(", ");
		return `${circuit.name} — ${judges}`;
	}

	onChooseItem(circuit: Circuit): void {
		this.onSelect(circuit);
	}

	onNoSuggestion(): void {
		if (this.circuits.length === 0) {
			this.resultContainerEl.empty();
			const msg = this.resultContainerEl.createDiv({ cls: "notor-orchestration-picker-empty" });
			msg.textContent = this.emptyMessage;
		}
	}
}

function formatWhen(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Multi-select over a circuit's finished sessions (checkbox-button rows). */
class SessionChecklistModal extends Modal {
	private readonly checked = new Set<string>();
	private footerEl: HTMLElement | null = null;
	private evaluateButton: ButtonComponent | null = null;
	private readonly rows = new Map<string, HTMLButtonElement>();

	constructor(
		app: App,
		private readonly circuit: Circuit,
		private readonly sessions: EvaluableSession[],
		private readonly onEvaluate: (sessionIds: string[]) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("notor-circuit-eval-modal");
		contentEl.createEl("h2", { text: `Evaluate "${this.circuit.name}"` });
		const estimate = estimateEvalCeiling(this.circuit, 1);
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text:
				`Evaluators: ${this.circuit.evaluators.map((e) => e.name).join(", ")} ` +
				`(${estimate.llmJudges} LLM, ${estimate.codeEvaluators} code). ` +
				`Each pass is capped at $${estimate.maxCostUsdPerPass.toFixed(2)}. ` +
				`Sessions already scored by the current evaluators are marked "evaluated"; re-scoring records a new pass.`,
		});

		if (this.sessions.length === 0) {
			contentEl.createEl("p", { text: "No finished sessions of this circuit yet." });
			const row = contentEl.createDiv({ cls: "modal-button-container" });
			new ButtonComponent(row).setButtonText("Close").onClick(() => this.close());
			return;
		}

		const selectRow = contentEl.createDiv({ cls: "notor-circuit-eval-select-row" });
		new ButtonComponent(selectRow).setButtonText("Select un-evaluated").onClick(() => {
			this.setChecked(this.sessions.filter((s) => !s.alreadyEvaluated).map((s) => s.sessionId));
		});
		new ButtonComponent(selectRow).setButtonText("Select all").onClick(() => {
			this.setChecked(this.sessions.map((s) => s.sessionId));
		});
		new ButtonComponent(selectRow).setButtonText("Clear").onClick(() => this.setChecked([]));

		const list = contentEl.createDiv({ cls: "notor-circuit-eval-sessions" });
		for (const s of this.sessions) {
			const row = list.createEl("button", { cls: "notor-circuit-eval-session" });
			row.setAttribute("data-session-id", s.sessionId);
			row.createSpan({ cls: `notor-circuit-eval-status notor-circuit-eval-status--${s.status}`, text: s.status });
			row.createSpan({ cls: "notor-circuit-eval-when", text: formatWhen(s.startedAt) });
			row.createSpan({ cls: "notor-circuit-eval-cost", text: s.costUsd === null ? "cost ?" : `$${s.costUsd.toFixed(2)}` });
			if (s.alreadyEvaluated) {
				row.createSpan({ cls: "notor-circuit-eval-badge", text: "evaluated" });
			} else if (s.passCount > 0) {
				row.createSpan({ cls: "notor-circuit-eval-badge notor-circuit-eval-badge--stale", text: "older evaluators" });
			}
			row.createSpan({ cls: "notor-circuit-eval-objective", text: truncate(s.objective, 90) || s.sessionId });
			row.title = `${s.sessionId} · ${s.origin}${s.lastEvaluatedAt ? ` · last evaluated ${formatWhen(s.lastEvaluatedAt)}` : ""}`;
			row.addEventListener("click", () => this.toggle(s.sessionId));
			this.rows.set(s.sessionId, row);
		}

		this.footerEl = contentEl.createEl("p", { cls: "setting-item-description notor-circuit-eval-footer" });
		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttonRow).setButtonText("Cancel").onClick(() => this.close());
		this.evaluateButton = new ButtonComponent(buttonRow)
			.setButtonText("Evaluate")
			.setCta()
			.onClick(() => {
				if (this.checked.size === 0) return;
				const ids = this.sessions.map((s) => s.sessionId).filter((id) => this.checked.has(id));
				this.close();
				this.onEvaluate(ids);
			});

		// Default selection: everything the current evaluators have not scored yet.
		this.setChecked(this.sessions.filter((s) => !s.alreadyEvaluated).map((s) => s.sessionId));
	}

	private toggle(sessionId: string): void {
		if (this.checked.has(sessionId)) this.checked.delete(sessionId);
		else this.checked.add(sessionId);
		this.refresh();
	}

	private setChecked(ids: string[]): void {
		this.checked.clear();
		for (const id of ids) this.checked.add(id);
		this.refresh();
	}

	private refresh(): void {
		for (const [id, row] of this.rows) row.toggleClass("notor-circuit-eval-session--checked", this.checked.has(id));
		const estimate = estimateEvalCeiling(this.circuit, this.checked.size);
		if (this.footerEl) {
			this.footerEl.textContent =
				`${this.checked.size} selected · ${estimate.judgeRuns} LLM judge run${estimate.judgeRuns === 1 ? "" : "s"} · ` +
				`${estimate.codeEvaluators * this.checked.size} code check${estimate.codeEvaluators * this.checked.size === 1 ? "" : "s"} · ` +
				`ceiling $${estimate.maxCostUsdPerPass.toFixed(2)} for the pass`;
		}
		this.evaluateButton?.setDisabled(this.checked.size === 0);
	}
}

/** Run a manual pass with a live progress Notice and a summary Notice at the end. */
export async function runEvaluationWithNotices(host: CircuitHost, circuit: Circuit, sessionIds: string[]): Promise<EvalPassResult> {
	const progress = new Notice(`Evaluating '${circuit.name}'…`, 0);
	let result: EvalPassResult;
	try {
		result = await evaluateSessions(host, circuit, sessionIds, {
			trigger: "manual",
			onProgress: (p) => {
				const where = `session ${p.sessionIndex + 1}/${p.sessionCount}`;
				const what = p.evaluator ? ` · ${p.evaluator} (${p.evaluatorIndex + 1}/${p.evaluatorCount})` : "";
				progress.setMessage(`Evaluating '${circuit.name}': ${where}${what} — ${p.phase}`);
			},
		});
	} finally {
		progress.hide();
	}

	const evaluated = result.sessions.filter((s) => !s.skipped);
	const scored = evaluated.reduce((n, s) => n + s.outcomes.filter((o) => o.ok).length, 0);
	const failed = evaluated.reduce((n, s) => n + s.outcomes.filter((o) => !o.ok).length, 0);
	const skipped = result.sessions.length - evaluated.length;
	const reports = evaluated.map((s) => s.reportPath).filter((p): p is string => !!p);
	const evalsDir = `${circuitDataRootPath(host.settings.notor_dir.replace(/\/+$/, ""), circuitDataRootOf(host))}/evals/`;
	const parts = [
		`Evaluated ${evaluated.length} session${evaluated.length === 1 ? "" : "s"} of '${circuit.name}': ${scored} scored, ${failed} failed`,
		`$${result.totalCostUsd.toFixed(4)}`,
	];
	if (skipped > 0) parts.push(`${skipped} skipped`);
	if (reports.length > 0) parts.push(`reports in ${evalsDir}`);
	new Notice(parts.join(" · "), 10_000);

	if (reports.length === 1) {
		void host.app.workspace.openLinkText(reports[0]!, "", true);
	}
	return result;
}

/**
 * Open the circuit picker (filtered to circuits with evaluators) → session
 * checklist → run the pass. Surfaced by the "Notor: Evaluate circuit sessions"
 * command (gated on `circuits_enabled`).
 */
export async function showEvaluationPicker(host: CircuitHost): Promise<void> {
	const parser = new CircuitDefinitionParser(host.app.vault, host.app.metadataCache, host.settings.notor_dir);
	let parsed;
	try {
		parsed = await parser.discoverCircuits();
	} catch (e) {
		log.error("Circuit discovery failed", { error: String(e) });
		new Notice(`Circuit discovery failed: ${e instanceof Error ? e.message : String(e)}`);
		return;
	}
	const circuits = parsed.map((p) => p.flow).filter((c) => c.evaluators.length > 0);
	const emptyMessage = "No circuits declare notor-evaluators. Add evaluator notes under a circuit's evals/ folder first.";

	new EvalCircuitPickerModal(
		host.app,
		circuits,
		(circuit) => {
			void (async () => {
				const fs = new VaultSessionFs(host.app);
				const sessionManager = new CircuitSessionManager(host.settings.notor_dir, fs, circuitDataRootOf(host));
				const fingerprint = evaluatorSetFingerprint(circuit.evaluators, await loadRubricBodies(fs, circuit.evaluators));
				const sessions = await listEvaluableSessions(makeRecoveryFs(host, sessionManager), circuit.name, fingerprint);
				new SessionChecklistModal(host.app, circuit, sessions, (ids) => {
					runEvaluationWithNotices(host, circuit, ids).catch((e) => {
						log.error("Evaluation pass failed", { circuit: circuit.name, error: String(e) });
						new Notice(`Evaluation of '${circuit.name}' failed: ${e instanceof Error ? e.message : String(e)}`);
					});
				}).open();
			})().catch((e) => {
				log.error("Could not list sessions for evaluation", { circuit: circuit.name, error: String(e) });
				new Notice(`Could not list sessions for '${circuit.name}': ${e instanceof Error ? e.message : String(e)}`);
			});
		},
		emptyMessage,
	).open();
}
