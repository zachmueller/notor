/**
 * Template grafting utility for DOCX generation.
 *
 * Extracted from `src/tools/write-docx.ts` so it can be shared via
 * `ExtensionUtils` without coupling to the `WriteDocxTool` class.
 *
 * Grafts generated DOCX body content into a template, preserving the
 * template's styles, margins, headers, footers, and section properties.
 * Handles media file copying with collision avoidance, rId conflict
 * resolution, and Content_Types merging.
 */

import PizZip from "pizzip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

/**
 * Graft generated DOCX body content into a template, preserving the
 * template's styles, margins, headers, footers, and section properties.
 *
 * Uses @xmldom/xmldom for XML manipulation. Handles image relationship
 * merging with rId conflict resolution.
 */
export async function graftIntoTemplate(
	generatedZip: PizZip,
	templateZip: PizZip,
): Promise<void> {
	const parser = new DOMParser();
	const serializer = new XMLSerializer();

	// --- Step 1: Parse body DOMs ---

	const generatedDocXml = generatedZip.files["word/document.xml"];
	if (!generatedDocXml) {
		throw new Error("Generated document.xml is malformed — could not locate word/document.xml.");
	}
	const genDoc = parser.parseFromString(generatedDocXml.asText(), "text/xml");
	const genBodyList = genDoc.getElementsByTagName("w:body");
	const genBody = genBodyList.item(0);
	if (!genBody) {
		throw new Error("Generated document.xml is malformed — could not locate <w:body>.");
	}

	const templateDocXml = templateZip.files["word/document.xml"];
	if (!templateDocXml) {
		throw new Error("Template document.xml is malformed — could not locate word/document.xml.");
	}
	const tmplDoc = parser.parseFromString(templateDocXml.asText(), "text/xml");
	const tmplBodyList = tmplDoc.getElementsByTagName("w:body");
	const tmplBody = tmplBodyList.item(0);
	if (!tmplBody) {
		throw new Error("Template document.xml is malformed — could not locate <w:body>.");
	}

	// Collect generated body children (excluding <w:sectPr>)
	const generatedBodyNodes: Node[] = [];
	for (let i = 0; i < genBody.childNodes.length; i++) {
		const child = genBody.childNodes.item(i);
		if (!child) continue;
		if (child.nodeType === 1 && (child as Element).tagName === "w:sectPr") continue;
		generatedBodyNodes.push(child);
	}

	// Remove all non-<w:sectPr> children from template body
	const tmplNodesToRemove: Node[] = [];
	for (let i = 0; i < tmplBody.childNodes.length; i++) {
		const child = tmplBody.childNodes.item(i);
		if (!child) continue;
		if (child.nodeType === 1 && (child as Element).tagName === "w:sectPr") continue;
		tmplNodesToRemove.push(child);
	}
	for (const node of tmplNodesToRemove) {
		tmplBody.removeChild(node);
	}

	// Find template's <w:sectPr> (insert point for generated content)
	let tmplSectPr: Element | null = null;
	for (let i = 0; i < tmplBody.childNodes.length; i++) {
		const child = tmplBody.childNodes.item(i);
		if (!child) continue;
		if (child.nodeType === 1 && (child as Element).tagName === "w:sectPr") {
			tmplSectPr = child as Element;
			break;
		}
	}

	// Capture as const for use in nested functions (TypeScript narrows the non-null check)
	const tmplBodyEl: Element = tmplBody;

	// Helper: append body nodes into template body (before sectPr if present)
	function appendBodyNodesToTemplate(nodes: Node[]): void {
		for (const bodyNode of nodes) {
			const imported = tmplDoc.importNode(bodyNode, true);
			if (tmplSectPr) {
				tmplBodyEl.insertBefore(imported, tmplSectPr);
			} else {
				tmplBodyEl.appendChild(imported);
			}
		}
	}

	// --- Step 2: Copy word/media/* image files ---

	const genMediaFiles: string[] = [];
	for (const filename of Object.keys(generatedZip.files)) {
		const entry = generatedZip.files[filename];
		if (entry && filename.startsWith("word/media/") && !entry.dir) {
			genMediaFiles.push(filename);
		}
	}

	// Handle duplicate media filenames
	const mediaRenameMap = new Map<string, string>(); // old filename → new filename
	for (const genMediaPath of genMediaFiles) {
		let targetPath = genMediaPath;
		if (templateZip.files[targetPath]) {
			// Rename with numeric suffix to avoid collision
			const lastDot = genMediaPath.lastIndexOf(".");
			const baseName = lastDot > 0 ? genMediaPath.substring(0, lastDot) : genMediaPath;
			const ext = lastDot > 0 ? genMediaPath.substring(lastDot) : "";
			let counter = 1;
			while (templateZip.files[`${baseName}_${counter}${ext}`]) {
				counter++;
			}
			targetPath = `${baseName}_${counter}${ext}`;
		}
		mediaRenameMap.set(genMediaPath, targetPath);
		const mediaFile = generatedZip.files[genMediaPath];
		if (mediaFile) {
			templateZip.file(targetPath, mediaFile.asUint8Array());
		}
	}

	// --- Step 3: Merge word/_rels/document.xml.rels with rId conflict resolution ---

	const tmplRelsFile = templateZip.files["word/_rels/document.xml.rels"];
	const genRelsFile = generatedZip.files["word/_rels/document.xml.rels"];

	if (tmplRelsFile && genRelsFile) {
		const tmplRelsDoc = parser.parseFromString(tmplRelsFile.asText(), "text/xml");
		const genRelsDoc = parser.parseFromString(genRelsFile.asText(), "text/xml");

		// Find highest rId in template
		let maxRId = 0;
		const tmplRelElements = tmplRelsDoc.getElementsByTagName("Relationship");
		for (let i = 0; i < tmplRelElements.length; i++) {
			const el = tmplRelElements.item(i);
			if (!el) continue;
			const id = el.getAttribute("Id") ?? "";
			const match = id.match(/^rId(\d+)$/);
			if (match) {
				maxRId = Math.max(maxRId, parseInt(match[1]!, 10));
			}
		}

		// Build rId remap table for generated relationships
		const rIdRemapTable = new Map<string, string>();
		const genRelElements = genRelsDoc.getElementsByTagName("Relationship");
		for (let i = 0; i < genRelElements.length; i++) {
			const el = genRelElements.item(i);
			if (!el) continue;
			const oldId = el.getAttribute("Id") ?? "";
			const newId = `rId${maxRId + i + 1}`;
			rIdRemapTable.set(oldId, newId);
		}

		// Remap rId references in the generated body DOM nodes
		const rIdAttrs = ["r:embed", "r:id", "r:link"];
		function walkAndRemapElements(node: Node): void {
			if (node.nodeType === 1) {
				const el = node as Element;
				for (const attr of rIdAttrs) {
					const val = el.getAttribute(attr);
					if (val && rIdRemapTable.has(val)) {
						el.setAttribute(attr, rIdRemapTable.get(val)!);
					}
				}
			}
			for (let i = 0; i < node.childNodes.length; i++) {
				const child = node.childNodes.item(i);
				if (child) walkAndRemapElements(child);
			}
		}
		for (const bodyNode of generatedBodyNodes) {
			walkAndRemapElements(bodyNode);
		}

		// Append remapped generated body children into template body
		appendBodyNodesToTemplate(generatedBodyNodes);

		// Append remapped <Relationship> elements to template .rels DOM
		const tmplRelsRoot = tmplRelsDoc.documentElement;
		for (let i = 0; i < genRelElements.length; i++) {
			const genRel = genRelElements.item(i);
			if (!genRel) continue;
			const newRel = tmplRelsDoc.createElement("Relationship");
			newRel.setAttribute("Id", rIdRemapTable.get(genRel.getAttribute("Id") ?? "") ?? "");
			newRel.setAttribute("Type", genRel.getAttribute("Type") ?? "");

			// Remap Target if it references a renamed media file
			let target = genRel.getAttribute("Target") ?? "";
			// Generated rels use paths like "media/image1.png" (relative to word/)
			const fullMediaPath = target.startsWith("media/") ? `word/${target}` : null;
			if (fullMediaPath && mediaRenameMap.has(fullMediaPath)) {
				const renamedFull = mediaRenameMap.get(fullMediaPath)!;
				target = renamedFull.replace(/^word\//, "");
			}
			newRel.setAttribute("Target", target);

			const targetMode = genRel.getAttribute("TargetMode");
			if (targetMode) {
				newRel.setAttribute("TargetMode", targetMode);
			}
			tmplRelsRoot.appendChild(newRel);
		}

		// Serialize updated .rels back to template zip
		templateZip.file("word/_rels/document.xml.rels", serializer.serializeToString(tmplRelsDoc));
	} else {
		// No rels merging needed — just append body nodes
		appendBodyNodesToTemplate(generatedBodyNodes);
	}

	// --- Step 4: Merge [Content_Types].xml ---

	if (genMediaFiles.length > 0) {
		const tmplCtFile = templateZip.files["[Content_Types].xml"];
		if (tmplCtFile) {
			const tmplCtDoc = parser.parseFromString(tmplCtFile.asText(), "text/xml");
			const typesRoot = tmplCtDoc.documentElement;

			// Collect existing extension defaults
			const existingExtensions = new Set<string>();
			const defaultElements = tmplCtDoc.getElementsByTagName("Default");
			for (let i = 0; i < defaultElements.length; i++) {
				const el = defaultElements.item(i);
				if (!el) continue;
				const ext = el.getAttribute("Extension");
				if (ext) existingExtensions.add(ext.toLowerCase());
			}

			// Map of image extensions to content types
			const extContentTypes: Record<string, string> = {
				png: "image/png",
				jpeg: "image/jpeg",
				gif: "image/gif",
				bmp: "image/bmp",
			};

			// Scan generated media filenames for extensions
			const neededExtensions = new Set<string>();
			for (const genMediaPath of genMediaFiles) {
				const renamedPath = mediaRenameMap.get(genMediaPath) ?? genMediaPath;
				const lastDot = renamedPath.lastIndexOf(".");
				if (lastDot > 0) {
					const ext = renamedPath.substring(lastDot + 1).toLowerCase();
					neededExtensions.add(ext);
				}
			}

			// Add missing Default entries
			for (const ext of neededExtensions) {
				const contentType = extContentTypes[ext];
				if (!existingExtensions.has(ext) && contentType) {
					const defaultEl = tmplCtDoc.createElement("Default");
					defaultEl.setAttribute("Extension", ext);
					defaultEl.setAttribute("ContentType", contentType);
					typesRoot.appendChild(defaultEl);
				}
			}

			templateZip.file("[Content_Types].xml", serializer.serializeToString(tmplCtDoc));
		}
	}

	// Serialize updated document.xml back to template zip
	templateZip.file("word/document.xml", serializer.serializeToString(tmplDoc));
}
