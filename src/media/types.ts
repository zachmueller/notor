export type ImageMediaType =
	| "image/png"
	| "image/jpeg"
	| "image/gif"
	| "image/webp";

export type ContentBlock =
	| { type: "text"; text: string }
	| {
			type: "image";
			media_type: ImageMediaType;
			data: string;
			width?: number;
			height?: number;
	  }
	| {
			type: "document";
			media_type: "application/pdf";
			data: string;
			page_count?: number;
	  }
	| {
			type: "custom_block";
			/** Registered block kind → resolved to renderer via ChatBlockRegistry. */
			kind: string;
			/** Block-specific structured payload, opaque to core. */
			data: Record<string, unknown>;
			/** Rendered when renderer unavailable; wire fallback text. */
			fallback_text?: string;
			/** Pre-computed from toLLMText output length; avoids registry lookups in estimation. */
			estimated_wire_tokens?: number;
			/** True during blocking automation placeholder phase. */
			loading?: boolean;
	  };

/**
 * The image processor pipeline's maximum output size (bytes of base64).
 * Used as the target in the compression cascade.
 */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

/**
 * Extract text from content that may be a string or ContentBlock[].
 * For string input, returns it as-is.
 * For ContentBlock[], filters to text blocks and joins with "\n".
 * Returns "" for empty arrays or arrays with no text blocks.
 */
export function getTextContent(content: string | ContentBlock[]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}
