declare module "mammoth" {
	/** Opaque image converter type — pass to `convertToHtml` options. */
	type ImageConverter = { __brand: "ImageConverter" };

	/** An embedded image encountered during DOCX conversion. */
	interface Image {
		contentType: string;
		readAsBuffer(): Promise<Buffer>;
		readAsArrayBuffer(): Promise<ArrayBuffer>;
		readAsBase64String(): Promise<string>;
	}

	/** Attributes for the generated `<img>` element. */
	interface ImageAttributes {
		src: string;
		alt?: string;
	}

	/** Options for `convertToHtml`. */
	interface Options {
		convertImage?: ImageConverter;
		[key: string]: unknown;
	}

	/** Image conversion helpers. */
	const images: {
		/** Default handler: embeds images as data URIs. */
		dataUri: ImageConverter;
		/** Custom handler: receives each image, returns `<img>` attributes. */
		imgElement(
			fn: (image: Image) => Promise<ImageAttributes>,
		): ImageConverter;
	};

	function convertToHtml(
		input: { buffer: Buffer },
		options?: Options,
	): Promise<{ value: string; messages: unknown[] }>;

	function extractRawText(
		input: { buffer: Buffer },
	): Promise<{ value: string }>;

	const _default: {
		images: typeof images;
		convertToHtml: typeof convertToHtml;
		extractRawText: typeof extractRawText;
	};
	export default _default;
	export { convertToHtml, extractRawText, images };
	export type { Options, ImageConverter, Image, ImageAttributes };
}
