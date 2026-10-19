/**
 * Minimal multipart/form-data encoder.
 *
 * Obsidian's `requestUrl` takes a raw `ArrayBuffer` body and bypasses CORS,
 * which the renderer's `fetch` cannot do for the local whisper server — so the
 * form body is assembled by hand here.
 */

export type MultipartPart =
	| { name: string; value: string }
	| { name: string; filename: string; contentType: string; data: ArrayBuffer | Uint8Array };

export interface MultipartBody {
	body: ArrayBuffer;
	contentType: string;
}

function defaultBoundary(): string {
	return `----NotorVoice${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/** Encode `parts` as a multipart/form-data body with the matching content type. */
export function encodeMultipart(parts: MultipartPart[], boundary: string = defaultBoundary()): MultipartBody {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];

	for (const part of parts) {
		chunks.push(encoder.encode(`--${boundary}\r\n`));
		if ("filename" in part) {
			chunks.push(
				encoder.encode(
					`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
					`Content-Type: ${part.contentType}\r\n\r\n`,
				),
			);
			chunks.push(part.data instanceof Uint8Array ? part.data : new Uint8Array(part.data));
		} else {
			chunks.push(encoder.encode(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}`));
		}
		chunks.push(encoder.encode("\r\n"));
	}
	chunks.push(encoder.encode(`--${boundary}--\r\n`));

	const total = chunks.reduce((n, c) => n + c.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}
