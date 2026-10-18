/**
 * The plugin capabilities the external API delegates to. `NotorPlugin`
 * satisfies it structurally; tests can supply a narrow fake.
 */

import type { CircuitHost } from "../circuits/host";
import type { Circuit } from "../circuits/types";
import type { ChatOrchestrator } from "../chat/orchestrator";
import type { ToolDispatcher } from "../chat/dispatcher";
import type { HistoryManager } from "../chat/history";
import type { Workflow } from "../types";

export interface NotorApiHost extends CircuitHost {
	getDiscoveredCircuits(): Circuit[];
	getDiscoveredWorkflows(): Workflow[];
	getToolDispatcher(): ToolDispatcher;
	getHistoryManager(): HistoryManager;
	createHeadlessOrchestrator(): ChatOrchestrator;
	openMainChatOrchestrator(): Promise<ChatOrchestrator | null>;
	openChatTabOrchestrator(): Promise<ChatOrchestrator | null>;
	openRunTreeView(root: { sessionId?: string; conversationId?: string }): Promise<void>;
}
