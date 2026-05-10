import { describe, it, expect } from "vitest";
import { extractPopoverTags, stripPopoverTags } from "./popover-refs";

describe("extractPopoverTags", () => {
	it("extracts a single note reference", () => {
		const input = `Some text <popover note="My Note" title="Title">Annotation here.</popover> more text.`;
		const { cleaned, refs } = extractPopoverTags(input);

		expect(refs).toHaveLength(1);
		expect(refs[0]!.index).toBe(1);
		expect(refs[0]!.note).toBe("My Note");
		expect(refs[0]!.title).toBe("Title");
		expect(refs[0]!.annotation).toBe("Annotation here.");
		expect(cleaned).not.toContain("<popover");
		expect(cleaned).toContain("Some text");
		expect(cleaned).toContain("more text.");
	});

	it("extracts a single href reference", () => {
		const input = `Check this <popover href="https://example.com" title="Example">Good resource.</popover> out.`;
		const { refs } = extractPopoverTags(input);

		expect(refs).toHaveLength(1);
		expect(refs[0]!.href).toBe("https://example.com");
		expect(refs[0]!.title).toBe("Example");
		expect(refs[0]!.note).toBeUndefined();
	});

	it("extracts multiple references with correct numbering", () => {
		const input = `First<popover note="A">Ann1.</popover> second<popover note="B">Ann2.</popover> third.`;
		const { refs } = extractPopoverTags(input);

		expect(refs).toHaveLength(2);
		expect(refs[0]!.index).toBe(1);
		expect(refs[0]!.note).toBe("A");
		expect(refs[1]!.index).toBe(2);
		expect(refs[1]!.note).toBe("B");
	});

	it("handles missing optional title attribute", () => {
		const input = `<popover note="Note Path">Body text.</popover>`;
		const { refs } = extractPopoverTags(input);

		expect(refs[0]!.title).toBeUndefined();
		expect(refs[0]!.note).toBe("Note Path");
		expect(refs[0]!.annotation).toBe("Body text.");
	});

	it("handles empty annotation body", () => {
		const input = `<popover note="Note" title="Title"></popover>`;
		const { refs } = extractPopoverTags(input);

		expect(refs[0]!.annotation).toBe("");
	});

	it("leaves malformed tags as raw text", () => {
		const input = `Text <popover note="Unclosed">no closing tag here.`;
		const { cleaned, refs } = extractPopoverTags(input);

		expect(refs).toHaveLength(0);
		expect(cleaned).toBe(input);
	});

	it("returns content unchanged when no tags present", () => {
		const input = "Just regular text with [[wikilinks]].";
		const { cleaned, refs } = extractPopoverTags(input);

		expect(refs).toHaveLength(0);
		expect(cleaned).toBe(input);
	});

	it("handles multiline annotation body", () => {
		const input = `<popover note="Note" title="T">Line one.
Line two.</popover>`;
		const { refs } = extractPopoverTags(input);

		expect(refs[0]!.annotation).toBe("Line one.\nLine two.");
	});
});

describe("stripPopoverTags", () => {
	it("removes tags and their inner text", () => {
		const input = `Before <popover note="X">annotation</popover> after.`;
		expect(stripPopoverTags(input)).toBe("Before  after.");
	});

	it("removes multiple tags", () => {
		const input = `A<popover note="X">1</popover>B<popover href="u">2</popover>C`;
		expect(stripPopoverTags(input)).toBe("ABC");
	});

	it("returns unchanged text when no tags", () => {
		const input = "No tags here.";
		expect(stripPopoverTags(input)).toBe(input);
	});
});
