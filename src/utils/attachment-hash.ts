/**
 * Content hashing for attachment snapshots.
 *
 * Vault images/PDFs are not stored as base64 in the JSONL (see Part 3 of the
 * chat-attachment storage refactor). Instead we persist a hash of the source
 * bytes at send time so that, when the conversation is re-dispatched, we can
 * re-read the file, re-hash it, and detect whether the source drifted since the
 * message was originally sent.
 */

import { createHash } from "crypto";

/**
 * Compute the sha256 hex digest of raw bytes.
 *
 * Accepts an `ArrayBuffer` (as returned by `vault.readBinary`), a Node `Buffer`,
 * or a `Uint8Array`. Uses sha256 for consistency with the memory-note hashing
 * in `src/memory/note-format.ts`.
 */
export function hashBytes(bytes: ArrayBuffer | Buffer | Uint8Array): string {
	const buf =
		bytes instanceof ArrayBuffer ? Buffer.from(new Uint8Array(bytes)) : Buffer.from(bytes);
	return createHash("sha256").update(buf).digest("hex");
}
