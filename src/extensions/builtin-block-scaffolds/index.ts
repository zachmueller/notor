export type { BuiltinBlockScaffold } from "../types";
import type { BuiltinBlockScaffold } from "../types";

import { MEMORY_RECALLED } from "./memory-recalled";
import { MEMORY_CAPTURED } from "./memory-captured";
import { MEMORY_PENDING_APPROVAL } from "./memory-pending-approval";

export const BUILTIN_BLOCK_SCAFFOLDS: ReadonlyMap<string, BuiltinBlockScaffold> =
	new Map([
		[MEMORY_RECALLED.kind, MEMORY_RECALLED],
		[MEMORY_CAPTURED.kind, MEMORY_CAPTURED],
		[MEMORY_PENDING_APPROVAL.kind, MEMORY_PENDING_APPROVAL],
	]);
