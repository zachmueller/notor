import type { BuilderContext, ExtensionUtils } from "./types";
import { detectMediaFormat } from "../../media/format-detector";
import { processImage } from "../../media/image-processor";
import { processPdf } from "../../media/pdf-processor";
import { resolveImageForDocx } from "../../tools/docx-image-utils";
import { graftIntoTemplate } from "../../tools/docx-template-graft";
import {
	parseCommentsXml,
	parseCommentsExtendedXml,
	extractQuotedText,
	parsePeopleXml,
	buildCommentThreads,
	formatCommentsAsMarkdown,
	extractExistingCommentIds,
} from "../../tools/docx-comment-parser";

export function buildMediaUtils(ctx: BuilderContext): Pick<ExtensionUtils,
	"detectMediaFormat" | "processImage" | "processPdf" |
	"resolveImageForDocx" | "graftDocxIntoTemplate" | "docxComments"
> {
	const { plugin, vaultRootPath } = ctx;

	return {
		detectMediaFormat,

		processImage,

		processPdf: (buffer, options) =>
			processPdf(buffer, {
				...options,
				providerType: plugin.getProviderRegistry().getActiveType(),
				maxNativeSizeBytes: plugin.settings.pdf_native_max_size_mb * 1024 * 1024,
			}),

		resolveImageForDocx: (href, allowedPaths?) =>
			resolveImageForDocx(href, vaultRootPath, allowedPaths ?? (plugin.settings.user_shared_settings?.["read_file_allowed_paths"] as string[] | undefined) ?? []),

		graftDocxIntoTemplate: graftIntoTemplate,

		docxComments: {
			parseCommentsXml,
			parseCommentsExtendedXml,
			extractQuotedText,
			parsePeopleXml,
			buildCommentThreads,
			formatCommentsAsMarkdown,
			extractExistingCommentIds,
		},
	};
}
