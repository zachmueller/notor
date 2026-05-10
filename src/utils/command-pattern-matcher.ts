import picomatch from "picomatch";

export interface CommandPatternMatch {
	matched: boolean;
	pattern?: string;
}

export function matchCommandPattern(
	command: string,
	patterns: string[],
): CommandPatternMatch {
	if (patterns.length === 0) return { matched: false };

	for (const pattern of patterns) {
		if (picomatch.isMatch(command, pattern, { bash: true })) {
			return { matched: true, pattern };
		}
	}

	return { matched: false };
}
