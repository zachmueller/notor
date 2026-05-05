#!/usr/bin/env npx tsx
/**
 * PDF Image Extraction E2E Test
 *
 * Tests whether readExternalPdfFile extracts images by:
 * 1. Reading the file manually and calling the plugin's internal PDF processing
 * 2. Verifying the attachment object has extracted_images populated
 */

import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import { waitForSelector, newConversation, buildDefaultSettings, E2E_DIR } from "../lib/test-helpers";

const FIXTURES_DIR = path.join(E2E_DIR, "fixtures", "pdf");
const TEST_PDF = path.join(FIXTURES_DIR, "test-pdf-with-images.pdf");

async function testPdfExtractionViaInternalCall(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Test 1: Simulate full attachment flow ─────────────────────");

	await newConversation(page);
	await page.waitForTimeout(1000);

	// Instead of simulating a drop (which requires Electron file handles),
	// we'll exploit the fact that the chat view's drop handler calls:
	//   readExternalPdfFile(absolutePath) → result
	//   createExternalPdfAttachment(path, name, result.base64, result.pageCount, result.extractedText, result.extractedImages)
	//   this.addAttachment(att)
	//
	// The drop handler at line 1771 dispatches into an IIFE that eventually
	// calls these functions. Since they're in the same bundle scope as the view,
	// we can't call them directly. BUT we can trigger the drop handler if we
	// can make getAbsoluteFilePath return the right path.
	//
	// Strategy: Monkey-patch electron.webUtils.getPathForFile to return our path,
	// then dispatch the drop event.

	const result = await page.evaluate(async (pdfPath: string) => {
		try {
			// Monkey-patch the electron webUtils to return our path for any file
			const electron = require("electron");
			const originalGetPath = electron.webUtils?.getPathForFile;
			if (electron.webUtils) {
				electron.webUtils.getPathForFile = () => pdfPath;
			}

			const inputArea = document.querySelector(".notor-input-area");
			if (!inputArea) return { error: "Input area not found" };

			// Create a minimal File object
			const fileName = require("path").basename(pdfPath);
			const file = new File([new ArrayBuffer(0)], fileName, { type: "application/pdf" });

			const dt = new DataTransfer();
			dt.items.add(file);

			const dropEvent = new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				dataTransfer: dt,
			});
			inputArea.dispatchEvent(dropEvent);

			// Wait for async PDF processing (text + image extraction)
			await new Promise(r => setTimeout(r, 15000));

			// Restore original
			if (electron.webUtils && originalGetPath) {
				electron.webUtils.getPathForFile = originalGetPath;
			}

			// Check pending attachments
			const leaves = (window as any).app?.workspace?.getLeavesOfType("notor-chat-view") ?? [];
			const view = leaves[0]?.view;
			if (!view) return { error: "View not found" };

			const attachments = view.pendingAttachments ?? [];
			if (attachments.length === 0) return { error: "No pending attachments after 15s wait" };

			const att = attachments[attachments.length - 1];
			return {
				type: att.type,
				displayName: att.display_name,
				path: att.path,
				status: att.status,
				hasContent: !!att.content,
				contentLen: att.content?.length ?? 0,
				contentPreview: att.content?.substring(0, 200) ?? "",
				hasBinary: !!att.binary_content,
				binaryLen: att.binary_content?.length ?? 0,
				hasImages: !!att.extracted_images && att.extracted_images.length > 0,
				imageCount: att.extracted_images?.length ?? 0,
				images: (att.extracted_images ?? []).slice(0, 5).map((img: any) => ({
					mediaType: img.media_type,
					width: img.width,
					height: img.height,
					dataKB: Math.round((img.data?.length ?? 0) / 1024),
				})),
				errorMessage: att.error_message,
			};
		} catch (e) {
			return { error: `${e instanceof Error ? e.message : String(e)}\n${e instanceof Error ? e.stack?.split('\n').slice(0,3).join('\n') : ''}` };
		}
	}, TEST_PDF);

	const shot = await ctx.screenshot("01-attachment-result");
	console.log("  Result:", JSON.stringify(result, null, 2));

	if ("error" in result) {
		ctx.fail("PDF attachment", result.error, shot);
		return;
	}

	ctx.pass("PDF attached", `type=${result.type}, status=${result.status}, path=${result.path}`, shot);

	if (result.hasContent && result.contentLen > 100) {
		ctx.pass("Text extracted", `${result.contentLen} chars. Preview: "${result.contentPreview.substring(0, 100)}..."`, shot);
	} else if (result.hasContent) {
		ctx.pass("Text extracted (short)", `${result.contentLen} chars`, shot);
	} else {
		ctx.fail("Text extracted", `No text content. status=${result.status}, error=${result.errorMessage}`, shot);
	}

	if (result.hasImages && result.imageCount > 0) {
		const totalKB = result.images.reduce((sum: number, i: any) => sum + i.dataKB, 0);
		const details = result.images.map((i: any) => `${i.width}x${i.height} ${i.mediaType} (${i.dataKB}KB)`).join(", ");
		ctx.pass("Images extracted", `${result.imageCount} images, ~${totalKB}KB total: ${details}`, shot);
	} else {
		ctx.fail("Images extracted", `No images. type=${result.type}, binaryLen=${result.binaryLen}`, shot);
	}
}

async function testCheckLogs(ctx: TestContext): Promise<void> {
	console.log("\n── Test 2: Check logs for errors ─────────────────────────────");

	const allLogs = ctx.collector.getStructuredLogs();
	const errors = ctx.collector.getLogsByLevel("error");

	// Look for any PDF-related errors
	const pdfErrors = errors.filter(e => {
		const combined = `${e.message} ${JSON.stringify(e.data ?? "")}`.toLowerCase();
		return combined.includes("pdf") || combined.includes("extract") || combined.includes("image") || combined.includes("process");
	});

	// Also look for debug/info logs from the PDF processing
	const pdfLogs = allLogs.filter(l => {
		const combined = `${l.message} ${JSON.stringify(l.data ?? "")}`.toLowerCase();
		return combined.includes("pdf") || combined.includes("external") || combined.includes("extract") || combined.includes("image") || combined.includes("attachment");
	});

	console.log(`  Total logs: ${allLogs.length}`);
	console.log(`  PDF/attachment-related logs: ${pdfLogs.length}`);
	for (const l of pdfLogs.slice(0, 20)) {
		console.log(`    [${l.level}][${l.source}] ${l.message} ${l.data ? JSON.stringify(l.data).substring(0, 150) : ""}`);
	}

	const shot = await ctx.screenshot("02-logs");

	if (pdfErrors.length > 0) {
		const details = pdfErrors.map(e => `[${e.source}] ${e.message} ${JSON.stringify(e.data ?? "").substring(0, 100)}`).join("\n    ");
		ctx.fail("No PDF errors", `${pdfErrors.length} error(s):\n    ${details}`, shot);
	} else {
		ctx.pass("No PDF errors", `${pdfLogs.length} PDF-related log entries, no errors`, shot);
	}
}

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);

	const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chat) throw new Error("Chat panel not visible");
	ctx.pass("Chat panel ready", "Plugin loaded");

	await testPdfExtractionViaInternalCall(ctx);
	await testCheckLogs(ctx);
}

runTest(
	{ name: "pdf-image-extraction-test", settings: buildDefaultSettings({}) },
	tests,
);
