import { Modal, type App } from "obsidian";
import type { PendingMemoryManager } from "../memory/pending-memory-manager";
import type { PendingMemoryNote } from "../memory/note-format";
import { computeDiff } from "./diff-engine";

type PendingEntry = PendingMemoryNote & { filePath: string };

export class MemoryApprovalModal extends Modal {
	constructor(
		app: App,
		private readonly manager: PendingMemoryManager,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("notor-memory-approval-modal");
		await this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();

		const entries = await this.manager.listPending(50);

		contentEl.createEl("h2", { text: "Pending memory approvals" });

		if (entries.length === 0) {
			contentEl.createEl("p", {
				text: "No pending memory notes.",
				cls: "notor-memory-approval-empty",
			});
			return;
		}

		// Global actions bar
		const globalBar = contentEl.createDiv({ cls: "notor-memory-approval-global-bar" });
		globalBar.createSpan({
			text: `${entries.length} pending`,
			cls: "notor-memory-approval-count",
		});
		const approveAllBtn = globalBar.createEl("button", {
			cls: "notor-approve-btn",
			text: "Approve all",
		});
		const rejectAllBtn = globalBar.createEl("button", {
			cls: "notor-reject-btn mod-warning",
			text: "Reject all",
		});

		const listEl = contentEl.createDiv({ cls: "notor-memory-approval-list" });

		const renderCards = (items: PendingEntry[]): void => {
			listEl.empty();
			for (const entry of items) {
				this.renderCard(listEl, entry, () => {
					const remaining = items.filter((e) => e.filePath !== entry.filePath);
					renderCards(remaining);
					this.updateCount(contentEl, remaining.length);
				});
			}
		};

		renderCards(entries);

		approveAllBtn.addEventListener("click", () => {
			void (async () => {
				await this.manager.approveAll(entries.map((e) => e.filePath));
				await this.render();
			})();
		});

		rejectAllBtn.addEventListener("click", () => {
			void (async () => {
				await this.manager.rejectAll(entries.map((e) => e.filePath));
				await this.render();
			})();
		});
	}

	private renderCard(
		container: HTMLElement,
		entry: PendingEntry,
		onActioned: () => void,
	): void {
		const card = container.createDiv({ cls: "notor-memory-approval-card" });

		// Card header
		const header = card.createDiv({ cls: "notor-memory-approval-card-header" });
		header.createSpan({ cls: "notor-memory-approval-title", text: entry.title });
		const isUpdate = entry.originalAction === "update";
		const badge = isUpdate ? "UPDATE" : "NEW";
		const badgeCls = isUpdate ? "notor-memory-badge--updated" : "notor-memory-badge--created";
		header.createSpan({ cls: `notor-memory-badge ${badgeCls}`, text: badge });

		// Open-note button
		const openPath = isUpdate && entry.targetPath ? entry.targetPath : entry.filePath;
		const openBtn = header.createEl("button", {
			cls: "notor-memory-approval-open clickable-icon",
			text: "Open note",
		});
		openBtn.addEventListener("click", () => {
			void this.app.workspace.openLinkText(openPath, "", false);
		});

		// Body: diff for updates, preview for creates
		const body = card.createDiv({ cls: "notor-memory-approval-card-body" });
		if (isUpdate && entry.targetPath) {
			this.renderDiff(body, entry);
		} else {
			body.createEl("pre", {
				cls: "notor-memory-approval-preview",
				text: entry.body,
			});
		}

		// Action buttons
		const actions = card.createDiv({ cls: "notor-memory-approval-card-actions" });
		const approveBtn = actions.createEl("button", {
			cls: "notor-approve-btn",
			text: "Approve",
		});
		const rejectBtn = actions.createEl("button", {
			cls: "notor-reject-btn",
			text: "Reject",
		});

		const disable = (): void => {
			approveBtn.disabled = true;
			rejectBtn.disabled = true;
		};

		approveBtn.addEventListener("click", () => {
			void (async () => {
				disable();
				await this.manager.approveSingle(entry.filePath).catch(() => {});
				card.addClass("notor-memory-approval-card--done");
				actions.empty();
				actions.createSpan({ cls: "notor-memory-approval-accepted", text: "✓ Approved" });
				onActioned();
			})();
		});

		rejectBtn.addEventListener("click", () => {
			void (async () => {
				disable();
				await this.manager.rejectSingle(entry.filePath).catch(() => {});
				card.addClass("notor-memory-approval-card--done");
				actions.empty();
				actions.createSpan({ cls: "notor-memory-approval-rejected", text: "✗ Rejected" });
				onActioned();
			})();
		});
	}

	private renderDiff(container: HTMLElement, entry: PendingEntry): void {
		// Fetch live note content asynchronously and render diff once loaded.
		const placeholder = container.createDiv({ cls: "notor-memory-approval-diff-loading", text: "Loading diff…" });

		void this.manager.getLiveNoteContent(entry.targetPath!).then((liveRaw) => {
			placeholder.remove();

			if (!liveRaw) {
				container.createEl("pre", { cls: "notor-memory-approval-preview", text: entry.body });
				return;
			}

			// Parse the live note body (strip frontmatter + heading)
			const liveBodyMatch = liveRaw.match(/^---[\s\S]*?---\n(?:# .+\n\n)?([\s\S]*)$/);
			const liveBody = liveBodyMatch ? liveBodyMatch[1]!.trimEnd() : liveRaw;

			const diffResult = computeDiff(liveBody, entry.body);
			const diffEl = container.createDiv({ cls: "notor-memory-approval-diff" });
			const table = diffEl.createEl("table", { cls: "notor-diff-table" });
			const tbody = table.createEl("tbody");

			for (const line of diffResult.lines) {
				const tr = tbody.createEl("tr", { cls: `notor-diff-line notor-diff-line-${line.type}` });
				const markerTd = tr.createEl("td", { cls: "notor-diff-line-gutter" });
				markerTd.textContent =
					line.type === "added" ? "+" : line.type === "deleted" ? "−" : " ";
				const contentTd = tr.createEl("td", { cls: "notor-diff-line-content" });
				contentTd.createEl("code", { text: line.content });
			}
		});
	}

	private updateCount(contentEl: HTMLElement, count: number): void {
		const countEl = contentEl.querySelector<HTMLElement>(".notor-memory-approval-count");
		if (countEl) {
			countEl.textContent = `${count} pending`;
		}
	}
}
