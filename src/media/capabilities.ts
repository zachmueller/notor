/**
 * Media capability definitions per LLM provider.
 *
 * Used to determine what media types a provider supports and
 * what size limits apply at message assembly time.
 *
 * @see specs/ZZ-misc/pdf-and-image-handling-design.md — Section 4
 */

/** Media capabilities for a specific LLM provider. */
export interface MediaCapabilities {
	/** Whether the provider accepts image content blocks. */
	supportsImages: boolean;
	/** Whether the provider accepts native PDF document blocks. */
	supportsNativePdf: boolean;
	/** Maximum image size in bytes (base64-encoded). */
	maxImageSizeBytes: number;
	/** Maximum document size in bytes (base64-encoded). N/A if supportsNativePdf is false. */
	maxDocumentSizeBytes: number;
	/** Maximum number of media items per conversation turn. */
	maxMediaItems: number;
}

const CAPABILITIES: Record<string, MediaCapabilities> = {
	anthropic: {
		supportsImages: true,
		supportsNativePdf: true,
		maxImageSizeBytes: 5 * 1024 * 1024,
		maxDocumentSizeBytes: 32 * 1024 * 1024,
		maxMediaItems: 100,
	},
	openai: {
		supportsImages: true,
		supportsNativePdf: false,
		maxImageSizeBytes: 20 * 1024 * 1024,
		maxDocumentSizeBytes: 0,
		maxMediaItems: 50,
	},
	bedrock: {
		supportsImages: true,
		supportsNativePdf: true,
		maxImageSizeBytes: 3.75 * 1024 * 1024,
		maxDocumentSizeBytes: 4.5 * 1024 * 1024,
		maxMediaItems: 20,
	},
	// Actual image support depends on the backend model — true means
	// "send images, but do not error if the model ignores them"
	local: {
		supportsImages: true,
		supportsNativePdf: false,
		maxImageSizeBytes: 5 * 1024 * 1024,
		maxDocumentSizeBytes: 0,
		maxMediaItems: 10,
	},
};

/**
 * Get media capabilities for a provider type.
 *
 * Falls back to conservative defaults (images only, no PDF) for
 * unknown provider types.
 */
export function getMediaCapabilities(providerType: string): MediaCapabilities {
	return CAPABILITIES[providerType] ?? CAPABILITIES["local"]!;
}
