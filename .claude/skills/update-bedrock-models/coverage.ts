#!/usr/bin/env npx tsx
/**
 * Bedrock model-metadata coverage driver for the update-bedrock-models skill.
 *
 * Enumerates the live Bedrock catalog via the AWS CLI, applies the SAME filters
 * the plugin ships (NON_CHAT_ID_PATTERNS + ACTIVE status), and diffs the
 * chat-eligible set against the keys already in `MODEL_METADATA`
 * (via the plugin's real `getKnownModelIds`). It then joins the plugin's real
 * thinking classifier onto each id, so one run tells you exactly which
 * profiles are missing metadata and how each thinking-capable one classifies.
 *
 * Read-only: it shells out to `aws bedrock list-inference-profiles` and reads
 * the plugin source. It writes nothing and edits nothing.
 *
 * Usage (from repo root):
 *   npx tsx .claude/skills/update-bedrock-models/coverage.ts --profile <p> --region <r>
 *   AWS_PROFILE=zmueller npx tsx .claude/skills/update-bedrock-models/coverage.ts
 *
 * Flags:
 *   --profile <name>   AWS CLI profile (default: $AWS_PROFILE or "default")
 *   --region <name>    AWS region       (default: $AWS_REGION or "us-east-1")
 *   --json             Emit the full result as one JSON object instead of text
 *
 * The plugin lists Bedrock models from ListInferenceProfiles (SYSTEM_DEFINED),
 * keeps status === "ACTIVE", and drops NON_CHAT_ID_PATTERNS — this driver mirrors
 * that exactly so its "missing" set matches what the picker would actually show.
 * Keep the NON_CHAT_ID_PATTERNS copy below in sync with bedrock-provider.ts.
 */

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// .claude/skills/update-bedrock-models/ -> repo root is three levels up.
const repoRoot = resolve(here, "..", "..", "..");

const { getKnownModelIds, supportsThinking, getThinkingMode } = await import(
	resolve(repoRoot, "src/providers/model-metadata.ts")
);

// Mirror of bedrock-provider.ts NON_CHAT_ID_PATTERNS. If that list changes,
// update this copy (the SKILL.md notes this is the one thing to keep in sync).
const NON_CHAT_ID_PATTERNS: RegExp[] = [
	/^[^.]+\.stability\./,
	/^[^.]+\.twelvelabs\./,
	/^[^.]+\.cohere\.embed/,
	/^amazon\.titan-embed/,
	/^stability\./,
	/^twelvelabs\./,
	/^cohere\.embed/,
];

function arg(flag: string, fallback: string): string {
	const i = process.argv.indexOf(flag);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const profile = arg("--profile", process.env.AWS_PROFILE ?? "default");
const region = arg("--region", process.env.AWS_REGION ?? "us-east-1");
const asJson = process.argv.includes("--json");

// --- Enumerate live SYSTEM_DEFINED inference profiles (paginates via nextToken). ---
interface ProfileSummary {
	inferenceProfileId: string;
	status?: string;
}

function listProfiles(): ProfileSummary[] {
	const out: ProfileSummary[] = [];
	let nextToken: string | undefined;
	do {
		const args = [
			"bedrock",
			"list-inference-profiles",
			"--type-equals",
			"SYSTEM_DEFINED",
			"--profile",
			profile,
			"--region",
			region,
			"--max-results",
			"200",
			"--output",
			"json",
		];
		if (nextToken) args.push("--next-token", nextToken);
		let stdout: string;
		try {
			stdout = execFileSync("aws", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/ExpiredToken|security token.*expired/i.test(msg)) {
				console.error(`AWS credentials expired for profile "${profile}". Refresh (e.g. aws sso login --profile ${profile}) and retry.`);
			} else if (/AccessDenied|not authorized/i.test(msg)) {
				console.error(`Access denied — the "${profile}" role needs bedrock:ListInferenceProfiles.`);
			} else {
				console.error(`aws list-inference-profiles failed: ${msg}`);
			}
			process.exit(1);
		}
		const page = JSON.parse(stdout) as {
			inferenceProfileSummaries?: ProfileSummary[];
			nextToken?: string;
		};
		out.push(...(page.inferenceProfileSummaries ?? []));
		nextToken = page.nextToken;
	} while (nextToken);
	return out;
}

const profiles = listProfiles();
const active = profiles.filter((p) => p.status === "ACTIVE").map((p) => p.inferenceProfileId);
const chatEligible = active
	.filter((id) => !NON_CHAT_ID_PATTERNS.some((re) => re.test(id)))
	.sort();

const known = new Set<string>(getKnownModelIds());
const missing = chatEligible.filter((id) => !known.has(id));

// Join the plugin's real classifier onto every chat-eligible Anthropic id.
const classified = chatEligible
	.filter((id) => id.includes("anthropic"))
	.map((id) => {
		const canThink = supportsThinking(id);
		const mode = canThink ? getThinkingMode(id) : null;
		return { id, supportsThinking: canThink, thinkingMode: mode, missing: !known.has(id) };
	});

if (asJson) {
	console.log(
		JSON.stringify(
			{ profile, region, counts: { profiles: profiles.length, active: active.length, chatEligible: chatEligible.length, missing: missing.length }, missing, classified },
			null,
			2,
		),
	);
} else {
	console.log(`profile=${profile} region=${region}`);
	console.log(`profiles=${profiles.length} active=${active.length} chat-eligible=${chatEligible.length} missing=${missing.length}`);
	console.log("");
	if (missing.length === 0) {
		console.log("✅ Full coverage — every chat-eligible profile has metadata.");
	} else {
		console.log("❌ Chat-eligible profiles MISSING from MODEL_METADATA:");
		for (const id of missing) console.log(`   ${id}`);
	}
	console.log("");
	console.log("Anthropic thinking classification (missing? / supportsThinking / mode):");
	for (const c of classified) {
		const flag = c.missing ? "MISSING" : "  ok   ";
		console.log(`  [${flag}] ${c.id.padEnd(52)} think=${String(c.supportsThinking).padEnd(5)} mode=${c.thinkingMode ?? "-"}`);
	}
}
