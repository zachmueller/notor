import { describe, it, expect } from "vitest";
import { EMIT_EVENT } from "../builtin-tool-scaffolds/emit-event";
import { extractCodeFence } from "../parser";
import { compileExtension } from "../compiler";
import { TOPIC_ALIASES } from "../../circuits/types";

// Compile the real emit_event scaffold body and run it against a fake carriage.
// Invocation order: fn(app, obsidian, utils, libs, settings, shared, params).

function compileScaffold() {
	const fence = extractCodeFence(EMIT_EVENT.scaffoldContent);
	if (!fence) throw new Error("No code fence found in scaffold");
	const compiled = compileExtension(fence.code, "tool");
	if ("error" in compiled) throw new Error(compiled.error);
	return compiled.fn;
}

interface Carriage {
	pendingEmission?: { topic: string; payload: string };
	emissionOverwrites: Array<{ prev_topic: string; new_topic: string }>;
}

async function emit(ctx: Carriage, topic: string, payload = "p"): Promise<unknown> {
	const fn = compileScaffold();
	return fn({}, {}, { orchestrationContext: ctx }, {}, {}, {}, { topic, payload });
}

describe("emit_event scaffold — circuit topic aliases", () => {
	it.each([
		["CIRCUIT_COMPLETE", "FLOW_COMPLETE"],
		["CIRCUIT_CANCELLED", "FLOW_CANCELLED"],
		["  CIRCUIT_ERROR  ", "FLOW_ERROR"],
		["circuit.tasks_remaining", "flow.tasks_remaining"],
		["FLOW_COMPLETE", "FLOW_COMPLETE"],
		["review.passed", "review.passed"],
	])("records %j as %j", async (raw, expected) => {
		const ctx: Carriage = { emissionOverwrites: [] };
		await emit(ctx, raw);
		expect(ctx.pendingEmission?.topic).toBe(expected);
	});

	it("latches a CIRCUIT_* terminal exactly like its FLOW_* equivalent", async () => {
		const ctx: Carriage = { emissionOverwrites: [] };
		await emit(ctx, "CIRCUIT_COMPLETE");
		const second = await emit(ctx, "work.more");
		expect(second).toMatchObject({ __toolError: true });
		expect(ctx.pendingEmission?.topic).toBe("FLOW_COMPLETE");
		expect(ctx.emissionOverwrites).toEqual([{ prev_topic: "FLOW_COMPLETE", new_topic: "work.more" }]);
	});

	it("inlined alias table matches TOPIC_ALIASES in circuits/types.ts", () => {
		for (const [alias, canonical] of Object.entries(TOPIC_ALIASES)) {
			expect(EMIT_EVENT.scaffoldContent).toContain(`${JSON.stringify(alias).replace(/^"([A-Z_]+)"$/, "$1")}: "${canonical}"`);
		}
	});
});
