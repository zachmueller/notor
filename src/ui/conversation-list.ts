/**
 * Conversation list panel extracted from chat-view.ts.
 *
 * Manages the sidebar conversation list, search/filter, context menus,
 * header title display, and inline rename.
 */

import { Menu, Notice, setIcon } from "obsidian";
import type { ConversationListEntry } from "../chat/history";
import type { ActiveConversationMeta } from "./chat-view";
import { formatRelativeTime } from "../utils/format-time";
import { logger } from "../utils/logger";

const log = logger("ConversationList");

export interface ConversationListDeps {
	messageListEl: HTMLElement;
	headerTitleEl?: HTMLSpanElement;
	headerFavoriteEl?: HTMLSpanElement;

	getActiveConversationId: () => string | null;
	getShowConversationList: () => boolean;
	setShowConversationList: (v: boolean) => void;

	onOpenConversationList?: () => Promise<ConversationListEntry[]>;
	onSearchConversations?: (query: string) => Promise<ConversationListEntry[]>;
	onSwitchConversation?: (filename: string) => void;
	onToggleFavorite?: (filename: string) => Promise<void>;
	onRenameConversation?: (filename: string, currentTitle: string) => void;
	onExportConversation?: (filename: string) => void;
	onDeleteConversation?: (filename: string) => void;
	onImportConversation?: (htmlContent: string) => Promise<void>;
	onNewConversation?: () => void;
	onOpenInNewTab?: (filename: string) => void;
	onDirectRename?: (filename: string, newTitle: string) => Promise<void>;
	getActiveConversationMeta?: () => ActiveConversationMeta | null;
	openChatInNewTab: (conv?: unknown, newPanel?: boolean) => void;
	focusInput: () => void;
}

export class ConversationList {
	private listEl!: HTMLElement;
	private searchInputEl!: HTMLInputElement;
	private favFilterBtnEl?: HTMLElement;
	private headerTitleInputEl?: HTMLInputElement;
	private favFilterActive = false;

	constructor(private container: HTMLElement, public deps: ConversationListDeps) {}

	build(): void {
		const searchWrapper = this.container.createDiv({
			cls: "notor-conversation-search notor-hidden",
		});
		this.searchInputEl = searchWrapper.createEl("input", {
			type: "text",
			placeholder: "Search conversations…",
			cls: "notor-conversation-search-input",
		});
		this.searchInputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				const query = this.searchInputEl.value.trim();
				const applyFavFilter = (entries: ConversationListEntry[]) =>
					this.favFilterActive ? entries.filter((en) => en.is_favorite) : entries;
				if (!query) {
					this.deps.onOpenConversationList?.().then((entries) => {
						this.render(applyFavFilter(entries));
					}).catch((err) => {
						log.error("Failed to load conversation list", { error: String(err) });
					});
				} else {
					this.deps.onSearchConversations?.(query).then((entries) => {
						this.render(applyFavFilter(entries));
					}).catch((err) => {
						log.error("Failed to search conversations", { error: String(err) });
					});
				}
			}
		});

		const importBtn = searchWrapper.createDiv({
			cls: "notor-conversation-import-btn",
			attr: { "aria-label": "Import conversation from HTML" },
		});
		setIcon(importBtn, "upload");
		importBtn.addEventListener("click", () => {
			this.openImportFilePicker();
		});

		this.favFilterBtnEl = searchWrapper.createDiv({
			cls: "notor-conversation-fav-filter-btn",
			attr: { "aria-label": "Show favorites only" },
		});
		setIcon(this.favFilterBtnEl, "star");
		this.favFilterBtnEl.addEventListener("click", () => {
			this.favFilterActive = !this.favFilterActive;
			this.favFilterBtnEl?.toggleClass("is-active", this.favFilterActive);
			this.favFilterBtnEl?.setAttribute(
				"aria-label",
				this.favFilterActive ? "Show all conversations" : "Show favorites only"
			);
			const query = this.searchInputEl.value.trim();
			const fetcher = query
				? this.deps.onSearchConversations?.(query)
				: this.deps.onOpenConversationList?.();
			void fetcher?.then((entries) => {
				if (this.favFilterActive) {
					entries = entries.filter((e) => e.is_favorite);
				}
				this.render(entries);
			});
		});

		this.listEl = this.container.createDiv({
			cls: "notor-conversation-list notor-hidden",
		});
	}

	toggle(): void {
		const show = !this.deps.getShowConversationList();
		this.deps.setShowConversationList(show);
		const searchWrapper = this.searchInputEl.parentElement;
		if (show) {
			searchWrapper?.removeClass("notor-hidden");
			this.listEl.removeClass("notor-hidden");
			this.deps.messageListEl.addClass("notor-hidden");
			this.searchInputEl.value = "";
			this.searchInputEl.focus();
			if (this.deps.onOpenConversationList) {
				this.deps.onOpenConversationList().then((entries) => {
					this.render(entries);
				}).catch((e) => {
					log.error("Failed to load conversation list", { error: String(e) });
				});
			}
		} else {
			searchWrapper?.addClass("notor-hidden");
			this.listEl.addClass("notor-hidden");
			this.deps.messageListEl.removeClass("notor-hidden");
		}
	}

	render(entries: ConversationListEntry[]): void {
		this.listEl.empty();

		if (entries.length === 0) {
			this.listEl.createDiv({
				cls: "notor-conversation-list-empty",
				text: "No conversations yet",
			});
			return;
		}

		for (const entry of entries) {
			const isActive = entry.id === this.deps.getActiveConversationId();
			const item = this.listEl.createDiv({
				cls: `notor-conversation-list-item${isActive ? " is-active" : ""}`,
			});
			item.setAttribute("data-conversation-id", entry.id);

			const contentCol = item.createDiv({ cls: "notor-conversation-list-content" });

			const titleEl = contentCol.createDiv({ cls: "notor-conversation-list-title" });
			titleEl.textContent = entry.title ?? "Untitled";

			if (entry.forked_from_conversation_id) {
				const parentEntry = entries.find(
					(e) => e.id === entry.forked_from_conversation_id
				);
				if (parentEntry) {
					const badge = titleEl.createSpan({ cls: "notor-fork-badge" });
					setIcon(badge, "git-branch-plus");
					badge.setAttribute("aria-label", "Go to parent conversation");
					badge.addEventListener("click", (e) => {
						e.stopPropagation();
						this.deps.onSwitchConversation?.(parentEntry.filename);
						this.toggle();
					});
				}
			}

			const metaEl = contentCol.createDiv({ cls: "notor-conversation-list-meta" });
			const date = new Date(entry.updated_at);
			metaEl.textContent = formatRelativeTime(date);

			if (entry.preview) {
				const previewEl = contentCol.createDiv({ cls: "notor-conversation-list-preview" });
				previewEl.textContent = entry.preview;
			}

			const actionsCol = item.createDiv({ cls: "notor-conversation-item-actions" });

			const menuBtn = actionsCol.createDiv({ cls: "notor-conversation-menu-btn" });
			setIcon(menuBtn, "more-vertical");
			menuBtn.setAttribute("aria-label", "More options");
			menuBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.showContextMenu(e, entry);
			});

			if (entry.is_favorite) {
				const starEl = actionsCol.createDiv({ cls: "notor-conversation-favorite-indicator" });
				setIcon(starEl, "star");
			}

			item.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.showContextMenu(e, entry);
			});

			item.addEventListener("click", () => {
				this.deps.onSwitchConversation?.(entry.filename);
				this.toggle();
			});
		}
	}

	updateTitleInList(conversationId: string, title: string): void {
		const items = this.listEl.querySelectorAll(".notor-conversation-list-item");
		for (const item of items) {
			if (item.getAttribute("data-conversation-id") !== conversationId) continue;
			const titleEl = item.querySelector(".notor-conversation-list-title");
			if (titleEl) {
				titleEl.textContent = title;
			}
			return;
		}
	}

	updateHeaderTitle(conversationId: string, title: string | null): void {
		const headerTitleEl = this.deps.headerTitleEl;
		if (!headerTitleEl) return;
		if (conversationId !== this.deps.getActiveConversationId()) return;

		if (title) {
			headerTitleEl.textContent = title;
			headerTitleEl.removeClass("notor-hidden");
		} else {
			headerTitleEl.textContent = "";
			headerTitleEl.addClass("notor-hidden");
		}
	}

	updateHeaderFavorite(conversationId: string, isFavorite: boolean): void {
		const headerFavoriteEl = this.deps.headerFavoriteEl;
		if (!headerFavoriteEl) return;
		if (conversationId !== this.deps.getActiveConversationId()) return;

		if (isFavorite) {
			headerFavoriteEl.removeClass("notor-hidden");
		} else {
			headerFavoriteEl.addClass("notor-hidden");
		}
	}

	showHeaderTitleContextMenu(evt: MouseEvent): void {
		const meta = this.deps.getActiveConversationMeta?.();
		if (!meta) return;

		const entry: ConversationListEntry = {
			id: meta.id,
			title: meta.title,
			filename: meta.filename,
			is_favorite: meta.is_favorite,
			updated_at: "",
			created_at: "",
			provider_id: "",
			model_id: "",
		};

		this.showContextMenu(evt, entry);
	}

	startHeaderTitleEdit(): void {
		const meta = this.deps.getActiveConversationMeta?.();
		const headerTitleEl = this.deps.headerTitleEl;
		if (!meta || !headerTitleEl) return;

		if (this.headerTitleInputEl) return;

		const currentTitle = meta.title ?? "Untitled";

		headerTitleEl.addClass("notor-hidden");

		const input = document.createElement("input");
		input.type = "text";
		input.value = currentTitle;
		input.className = "notor-header-title-input";
		headerTitleEl.parentElement!.insertBefore(input, headerTitleEl.nextSibling);
		this.headerTitleInputEl = input;

		input.select();
		input.focus();

		const commit = () => {
			const newTitle = input.value.trim();
			cleanup();
			if (newTitle && newTitle !== currentTitle) {
				void this.deps.onDirectRename?.(meta.filename, newTitle);
			}
		};

		const cancel = () => {
			cleanup();
		};

		const cleanup = () => {
			input.removeEventListener("blur", onBlur);
			input.remove();
			this.headerTitleInputEl = undefined;
			headerTitleEl.removeClass("notor-hidden");
		};

		const onBlur = () => cancel();

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			} else if (e.key === "Escape") {
				e.preventDefault();
				cancel();
			}
		});

		input.addEventListener("blur", onBlur);
	}

	showNewConversationMenu(evt: MouseEvent): void {
		const menu = new Menu();

		menu.addItem((item) => {
			item.setTitle("New conversation")
				.setIcon("message-square-plus")
				.onClick(() => {
					if (this.deps.getShowConversationList()) {
						this.toggle();
					}
					this.deps.onNewConversation?.();
					this.deps.focusInput();
				});
		});

		menu.addItem((item) => {
			item.setTitle("New conversation in new panel")
				.setIcon("layout-dashboard")
				.onClick(() => {
					this.deps.openChatInNewTab(undefined, true);
				});
		});

		menu.showAtMouseEvent(evt);
	}

	isFavFilterActive(): boolean {
		return this.favFilterActive;
	}

	getSearchInputEl(): HTMLInputElement {
		return this.searchInputEl;
	}

	getListEl(): HTMLElement {
		return this.listEl;
	}

	destroy(): void {
		this.listEl?.remove();
		this.searchInputEl?.parentElement?.remove();
	}

	private showContextMenu(evt: MouseEvent, entry: ConversationListEntry): void {
		const menu = new Menu();

		menu.addItem((item) => {
			item.setTitle(entry.is_favorite ? "Remove from favorites" : "Add to favorites")
				.setIcon(entry.is_favorite ? "star-off" : "star")
				.onClick(() => {
					void this.deps.onToggleFavorite?.(entry.filename);
				});
		});

		menu.addItem((item) => {
			item.setTitle("Rename")
				.setIcon("pencil")
				.onClick(() => {
					this.deps.onRenameConversation?.(entry.filename, entry.title ?? "Untitled");
				});
		});

		menu.addSeparator();

		menu.addItem((item) => {
			item.setTitle("Open in new tab")
				.setIcon("blocks")
				.onClick(() => {
					this.deps.onOpenInNewTab?.(entry.filename);
				});
		});

		menu.addItem((item) => {
			item.setTitle("Export conversation")
				.setIcon("download")
				.onClick(() => {
					this.deps.onExportConversation?.(entry.filename);
				});
		});

		menu.addItem((item) => {
			item.setTitle("Copy conversation link")
				.setIcon("link")
				.onClick(async () => {
					const uri = `obsidian://notor?id=${encodeURIComponent(entry.id)}`;
					await navigator.clipboard.writeText(uri);
					new Notice("Conversation link copied to clipboard");
				});
		});

		menu.addItem((item) => {
			item.setTitle("Copy conversation ID")
				.setIcon("hash")
				.onClick(async () => {
					await navigator.clipboard.writeText(entry.id);
					new Notice("Conversation ID copied");
				});
		});

		menu.addItem((item) => {
			item.setTitle("Delete conversation")
				.setIcon("trash-2")
				.onClick(() => {
					this.deps.onDeleteConversation?.(entry.filename);
				});
		});

		menu.showAtMouseEvent(evt);
	}

	private openImportFilePicker(): void {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".html";
		input.addClass("notor-hidden");
		document.body.appendChild(input);

		input.addEventListener("change", () => {
			const file = input.files?.[0];
			if (!file) {
				input.remove();
				return;
			}

			const reader = new FileReader();
			reader.onload = () => {
				const htmlContent = reader.result as string;
				this.deps.onImportConversation?.(htmlContent)?.catch((err) => {
					log.error("Failed to import conversation", { error: String(err) });
				});
				input.remove();
			};
			reader.onerror = () => {
				log.error("Failed to read imported file", { error: reader.error?.message ?? "unknown error" });
				input.remove();
			};
			reader.readAsText(file);
		});

		input.click();
	}
}
