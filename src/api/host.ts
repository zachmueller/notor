/**
 * The plugin capabilities the external API delegates to. `NotorPlugin`
 * satisfies it structurally; tests can supply a narrow fake.
 */

import type { CircuitHost } from "../circuits/host";
import type { ChatOrchestrator } from "../chat/orchestrator";
import type { ToolDispatcher } from "../chat/dispatcher";
import type { HistoryManager } from "../chat/history";

export interface NotorApiHost extends CircuitHost {
	getToolDispatcher(): ToolDispatcher;
	getHistoryManager(): HistoryManager;
	createHeadlessOrchestrator(): ChatOrchestrator;
	openMainChatOrchestrator(): Promise<ChatOrchestrator | null>;
	openChatTabOrchestrator(): Promise<ChatOrchestrator | null>;
	openRunTreeView(root: { sessionId?: string; conversationId?: string }): Promise<void>;
}
