/**
 * Notices for the `on_daily_start` trigger: one per target run (with an
 * **Open** button that jumps to the run's conversation) and a single
 * persistent pre-flight failure Notice with **Retry now**.
 */

import { ButtonComponent, Notice } from "obsidian";
import type { DailyStartFailureReport, DailyStartUi } from "../hooks/daily-start/daily-start-detector";
import type { DailyRunRecord, DailyRunStatus } from "../hooks/daily-start/daily-start-state";

/** How long the "started" Notice stays up; terminal Notices persist until dismissed. */
const STARTED_NOTICE_MS = 10_000;

export interface DailyStartNoticeDeps {
	openRecord: (record: DailyRunRecord) => void;
	retryNow: () => void;
}

/** Statuses that get their own Notice (others are covered by the failure Notice). */
const ANNOUNCED: ReadonlySet<DailyRunStatus> = new Set(["running", "waiting_approval", "completed", "failed"]);

export class DailyStartNotices implements DailyStartUi {
	private readonly runNotices = new Map<string, { status: DailyRunStatus; notice: Notice }>();
	private failureNotice: Notice | null = null;

	constructor(private readonly deps: DailyStartNoticeDeps) {}

	runChanged(record: DailyRunRecord): void {
		if (!ANNOUNCED.has(record.status)) return;
		const previous = this.runNotices.get(record.key);
		if (previous?.status === record.status) return;
		previous?.notice.hide();

		const message = runMessage(record);
		const duration = record.status === "running" ? STARTED_NOTICE_MS : 0;
		const notice = this.showWithButtons(message, duration, [
			{ text: "Open", cta: true, onClick: () => this.deps.openRecord(record) },
			...(duration === 0 ? [{ text: "Dismiss", onClick: () => undefined }] : []),
		]);
		this.runNotices.set(record.key, { status: record.status, notice });
	}

	preflightFailed(report: DailyStartFailureReport): void {
		this.preflightCleared();
		const targets = report.labels.map((l) => `'${l}'`).join(", ");
		if (report.retryAt === null) {
			const attempts = report.attempt > 0 ? ` after ${report.attempt + 1} attempts` : "";
			this.failureNotice = this.showWithButtons(
				`Daily start gave up${attempts}: couldn't reach ${report.failure.providerLabel} (${report.reason}) for ${targets}. Use 'Run daily start now' to retry.`,
				0,
				[{ text: "Dismiss", onClick: () => undefined }],
			);
			return;
		}
		const minutes = Math.max(1, Math.round((report.retryAt - Date.now()) / 60_000));
		this.failureNotice = this.showWithButtons(
			`Daily start: couldn't reach ${report.failure.providerLabel} (${report.reason}) for ${targets}. Retrying in ${minutes} min (retry ${report.attempt} of ${report.maxAttempts}).`,
			0,
			[
				{ text: "Retry now", cta: true, onClick: () => this.deps.retryNow() },
				{ text: "Dismiss", onClick: () => undefined },
			],
		);
	}

	preflightCleared(): void {
		this.failureNotice?.hide();
		this.failureNotice = null;
	}

	/** Hide every Notice this class shows (plugin unload). */
	destroy(): void {
		this.preflightCleared();
		for (const { notice } of this.runNotices.values()) notice.hide();
		this.runNotices.clear();
	}

	private showWithButtons(
		message: string,
		duration: number,
		buttons: Array<{ text: string; cta?: boolean; onClick: () => void }>,
	): Notice {
		const fragment = document.createDocumentFragment();
		const wrapper = fragment.createDiv({ cls: "notor-daily-start-notice" });
		wrapper.createDiv({ text: message });
		const row = wrapper.createDiv({ cls: "notor-daily-start-notice-actions" });
		const notice = new Notice(fragment, duration);
		for (const b of buttons) {
			const button = new ButtonComponent(row).setButtonText(b.text).onClick(() => {
				notice.hide();
				b.onClick();
			});
			if (b.cta) button.setCta();
		}
		return notice;
	}
}

function runMessage(record: DailyRunRecord): string {
	const name = `'${record.label}'`;
	switch (record.status) {
		case "waiting_approval":
			return `Daily start: ${name} is waiting for your approval.`;
		case "completed":
			return `Daily start: ${name} finished.`;
		case "failed":
			return `Daily start: ${name} failed${record.error ? `: ${record.error}` : "."}`;
		default:
			return `Daily start: ${name} started.`;
	}
}
