import { describe, expect, it, vi } from "vitest";
import { interopDefault, once } from "../../utils/lazy-modules";
import { buildLibs } from "./index";

describe("lazy-modules helpers", () => {
	it("interopDefault unwraps __esModule defaults and passes CommonJS exports through", () => {
		const fn = () => 1;
		expect(interopDefault({ __esModule: true, default: fn })).toBe(fn);
		expect(interopDefault(fn)).toBe(fn);
		const ns = { __esModule: true, Document: class {} };
		expect(interopDefault(ns)).toBe(ns);
	});

	it("once runs the loader a single time", () => {
		const load = vi.fn(() => ({ v: 1 }));
		const get = once(load);
		expect(get()).toBe(get());
		expect(load).toHaveBeenCalledTimes(1);
	});
});

describe("buildLibs — lazily loaded document libraries keep their synchronous API", () => {
	const libs = buildLibs();

	it("exposes working mammoth, Turndown, docx, PizZip and xmldom", () => {
		expect(typeof libs.mammoth.extractRawText).toBe("function");
		const turndown = new libs.Turndown();
		expect(turndown.turndown("<p><strong>bold</strong></p>")).toBe("**bold**");
		expect(typeof libs.docx.Document).toBe("function");
		const zip = new libs.PizZip();
		zip.file("a.txt", "hi");
		expect(zip.file("a.txt")?.asText()).toBe("hi");
		const doc = new libs.xmldom.DOMParser().parseFromString("<a><b/></a>", "text/xml");
		expect(doc.documentElement?.nodeName).toBe("a");
	});

	it("returns the same module object on every access", () => {
		expect(libs.docx).toBe(libs.docx);
		expect(libs.mammoth).toBe(buildLibs().mammoth);
	});

	it("keeps the eager members and async thunks unchanged", () => {
		expect(typeof libs.marked).toBe("function");
		expect(typeof libs.turndownGfm.gfm).toBe("function");
		expect(typeof libs.unpdf).toBe("function");
		expect(typeof libs.exceljs).toBe("function");
	});
});

describe("buildMediaUtils — docx helpers load on first call", () => {
	it("docxComments and graftDocxIntoTemplate delegate to the lazily loaded modules", async () => {
		const { buildMediaUtils } = await import("./media-utils");
		const utils = buildMediaUtils({ plugin: {}, vaultRootPath: "" } as never);
		const xml =
			'<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
			'<w:comment w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z"><w:p><w:r><w:t>Note</w:t></w:r></w:p></w:comment>' +
			"</w:comments>";
		const parsed = utils.docxComments.parseCommentsXml(xml);
		expect(parsed).toHaveLength(1);
		expect(typeof utils.graftDocxIntoTemplate).toBe("function");
	});
});
