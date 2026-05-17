export type { BuiltinAutomationScaffold } from "../types";

import type { BuiltinAutomationScaffold } from "../types";
import { TITLE_GENERATION } from "./title-generation";
import { MEMORY_SEARCH } from "./memory-search";
import { MEMORY_CAPTURE } from "./memory-capture";
import { MEMORY_DREAM } from "./memory-dream";

/**
 * Built-in automation scaffolds keyed by internal name.
 */
export const BUILTIN_AUTOMATION_SCAFFOLDS: ReadonlyMap<string, BuiltinAutomationScaffold> = new Map([
	["title-generation", TITLE_GENERATION],
	["memory-search", MEMORY_SEARCH],
	["memory-capture", MEMORY_CAPTURE],
	["memory-dream", MEMORY_DREAM],
]);
