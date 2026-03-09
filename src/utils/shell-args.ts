/**
 * Shell-style argument string parsing and serialization utilities.
 *
 * Provides POSIX-style tokenization of a command argument string so that
 * arguments containing spaces can be expressed using single or double quotes,
 * or by escaping individual characters with a backslash.
 *
 * Examples:
 *   parseShellArgs('-y server "/my vault/path"')
 *   // → ['-y', 'server', '/my vault/path']
 *
 *   parseShellArgs("--name 'hello world' --flag")
 *   // → ['--name', 'hello world', '--flag']
 *
 *   serializeShellArgs(['-y', 'server', '/my vault/path'])
 *   // → "-y server \"/my vault/path\""
 */

/**
 * Parse a shell-style argument string into an array of individual argument
 * tokens.
 *
 * Supported quoting rules (subset of POSIX sh):
 * - Double quotes: `"foo bar"` → token `foo bar`
 * - Single quotes: `'foo bar'` → token `foo bar` (no escape processing inside)
 * - Backslash escape: `foo\ bar` → token `foo bar`
 * - Unquoted tokens are delimited by whitespace
 *
 * @param input - Raw argument string (e.g. the text from a settings text field)
 * @returns Array of parsed argument tokens. Returns an empty array for blank input.
 */
export function parseShellArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let i = 0;

	while (i < input.length) {
		const ch = input[i];

		// Skip leading / between-token whitespace
		if (/\s/.test(ch!) && current === "" && !tokens.length && current.length === 0) {
			// We haven't started a token yet — skip
			i++;
			continue;
		}

		if (/\s/.test(ch!)) {
			// Whitespace outside quotes — end of token
			if (current.length > 0 || i > 0) {
				tokens.push(current);
				current = "";
			}
			i++;
			continue;
		}

		if (ch === "\\") {
			// Backslash escape — take next character literally
			i++;
			if (i < input.length) {
				current += input[i];
				i++;
			}
			continue;
		}

		if (ch === '"') {
			// Double-quoted section — process until matching closing quote
			i++;
			while (i < input.length && input[i] !== '"') {
				if (input[i] === "\\") {
					// Inside double quotes, backslash escapes the next char
					i++;
					if (i < input.length) {
						current += input[i];
						i++;
					}
				} else {
					current += input[i];
					i++;
				}
			}
			// Skip the closing "
			if (i < input.length) i++;
			continue;
		}

		if (ch === "'") {
			// Single-quoted section — everything is literal until closing '
			i++;
			while (i < input.length && input[i] !== "'") {
				current += input[i];
				i++;
			}
			// Skip the closing '
			if (i < input.length) i++;
			continue;
		}

		// Normal character
		current += ch;
		i++;
	}

	// Flush any remaining token
	if (current.length > 0) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * Serialize an array of argument tokens back into a shell-style string
 * suitable for display in the Arguments text field.
 *
 * Tokens that contain whitespace or the characters `"`, `'`, or `\` are
 * wrapped in double quotes (with internal double-quotes and backslashes
 * escaped). Plain tokens are emitted as-is.
 *
 * @param args - Array of argument tokens
 * @returns A single string that {@link parseShellArgs} will round-trip back to `args`
 */
export function serializeShellArgs(args: string[]): string {
	return args
		.map((arg) => {
			// If the token contains whitespace, quotes, or backslashes, wrap it
			if (/[\s"'\\]/.test(arg)) {
				const escaped = arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
				return `"${escaped}"`;
			}
			return arg;
		})
		.join(" ");
}
