/**
 * Type declarations for turndown-plugin-gfm.
 *
 * The package does not ship its own type definitions and no
 * @types/turndown-plugin-gfm package exists on DefinitelyTyped.
 */

declare module "turndown-plugin-gfm" {
	import type TurndownService from "turndown";

	/** GFM plugin — enables tables, strikethrough, and task lists. */
	export function gfm(service: TurndownService): void;
	/** Tables-only plugin. */
	export function tables(service: TurndownService): void;
	/** Strikethrough-only plugin. */
	export function strikethrough(service: TurndownService): void;
	/** Task-list-only plugin. */
	export function taskListItems(service: TurndownService): void;
}