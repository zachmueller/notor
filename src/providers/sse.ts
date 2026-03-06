/**
 * Server-Sent Events (SSE) stream parser.
 *
 * Parses an SSE byte stream from a fetch Response into individual
 * event objects. Used by OpenAI-compatible and Anthropic providers.
 */

/**
 * Parse an SSE stream from a ReadableStream<Uint8Array>.
 *
 * Yields individual `data:` payloads as strings. Handles:
 * - Multi-line data fields
 * - The `[DONE]` sentinel used by OpenAI-compatible APIs
 * - Partial chunks split across stream boundaries
 *
 * @param stream - The readable stream from fetch response.body
 * @param signal - Optional abort signal for cancellation
 */
export async function* parseSSEStream(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal
): AsyncIterable<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				return;
			}

			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			// Process complete lines
			const lines = buffer.split("\n");
			// Keep the last incomplete line in the buffer
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();

				// Skip empty lines and comments
				if (trimmed === "" || trimmed.startsWith(":")) {
					continue;
				}

				// Parse data lines
				if (trimmed.startsWith("data: ")) {
					const data = trimmed.slice(6);

					// OpenAI-compatible APIs send [DONE] as the final event
					if (data === "[DONE]") {
						return;
					}

					yield data;
				}
			}
		}

		// Process any remaining data in the buffer
		if (buffer.trim().startsWith("data: ")) {
			const data = buffer.trim().slice(6);
			if (data !== "[DONE]") {
				yield data;
			}
		}
	} finally {
		reader.releaseLock();
	}
}