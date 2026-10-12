/**
 * User-facing suggestion text for transient provider failures, shared by the
 * chat orchestrator's thrown-error and yielded-error paths so both explain a
 * dropped connection the same way.
 */

import type { ProviderErrorCode } from "../providers/provider";

/**
 * Suggestion appended to a transient failure's message, or "" for codes
 * this helper doesn't cover. `providerType` tailors the connection hint
 * (a local server may simply not be running; a cloud API means the
 * network dropped). `retries` notes how many automatic retries ran.
 */
export function transientFailureSuggestion(
	code: ProviderErrorCode | undefined,
	providerType: string | undefined,
	retries: number,
): string {
	const retried = retries > 0 ? ` (Retried ${retries} time${retries === 1 ? "" : "s"}.)` : "";
	switch (code) {
		case "CONNECTION_FAILED":
			return providerType === "local"
				? ` Check that your provider is running and accessible.${retried}`
				: ` Network connection lost — check your internet connection.${retried}`;
		case "RATE_LIMITED":
			return ` Wait a moment and try again.${retried}`;
		case "SERVICE_UNAVAILABLE":
			return ` The provider is temporarily unavailable — try again shortly.${retried}`;
		default:
			return "";
	}
}
