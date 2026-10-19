/**
 * Trigger-phrase matching for voice commands.
 *
 * Whisper transcripts vary ("voice command,", "Voice Commands", "Voice-command:"),
 * so matching is case-insensitive, ignores punctuation and hyphenation, and
 * tolerates a plural/singular mismatch on each trigger word. The command text
 * that follows the phrase keeps its original casing and punctuation, because
 * free-text answers need them.
 */

export interface VoiceCommandMatch {
	/** Text after the trigger phrase, original casing, trimmed ("" when only the phrase was said). */
	command: string;
}

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeSpoken(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function sameWord(a: string, b: string): boolean {
	return a === b || `${a}s` === b || a === `${b}s`;
}

/**
 * Match `transcript` against `triggerPhrase`. Returns the command that follows
 * the phrase, or null when the utterance does not start with it.
 */
export function matchVoiceCommand(transcript: string, triggerPhrase: string): VoiceCommandMatch | null {
	const triggerWords = normalizeSpoken(triggerPhrase).split(" ").filter(Boolean);
	if (triggerWords.length === 0) return null;

	// Walk the transcript word by word (letters/digits only) so punctuation and
	// hyphens between trigger words do not matter, while remembering where the
	// phrase ends in the original text.
	const wordRe = /[\p{L}\p{N}]+/gu;
	let matched = 0;
	let phraseEnd = 0;
	let token: RegExpExecArray | null;
	while (matched < triggerWords.length && (token = wordRe.exec(transcript)) !== null) {
		if (!sameWord(token[0].toLowerCase(), triggerWords[matched]!)) return null;
		matched++;
		phraseEnd = token.index + token[0].length;
	}
	if (matched < triggerWords.length) return null;

	// Drop separators left over from the phrase itself ("voice command, approve").
	return { command: transcript.slice(phraseEnd).replace(/^[\s\p{P}]+/u, "").trim() };
}
