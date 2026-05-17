import type { BuilderContext, ExtensionUtils } from "./types";
import { isDomainBlocked } from "../../utils/domain-denylist";
import { normalizedIndexOf } from "../../utils/unicode-normalize";

export function buildWebUtils(ctx: BuilderContext): Pick<ExtensionUtils,
	"webSearch" | "isDomainBlocked" | "normalizedIndexOf"
> {
	const { plugin } = ctx;

	return {
		isDomainBlocked,

		normalizedIndexOf,

		webSearch: {
			search: (query, numResults, timeoutMs, signal?) =>
				plugin.getWebSearchQueue().search(query, numResults, timeoutMs, signal),
			searchWithConfig: (query, numResults, timeoutMs, config, signal?) =>
				plugin.getWebSearchQueue().searchWithConfig(query, numResults, timeoutMs, config, signal),
			buildConfig: (settings) =>
				plugin.getWebSearchQueue().buildConfig(settings),
		},
	};
}
