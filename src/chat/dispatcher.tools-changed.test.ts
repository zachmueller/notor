import { describe, it, expect, vi } from "vitest";
import { ToolDispatcher, type DispatchableTool } from "./dispatcher";

function makeTool(name: string): DispatchableTool {
	return {
		name,
		mode: "read",
		execute: vi.fn(async () => ({ tool_name: name, success: true, result: "ok" })),
	};
}

describe("ToolDispatcher — onToolsChanged", () => {
	it("fires on register and on unregistering a known tool", () => {
		const d = new ToolDispatcher();
		const onChanged = vi.fn();
		d.setOnToolsChanged(onChanged);

		d.registerTool(makeTool("read_note"));
		expect(onChanged).toHaveBeenCalledTimes(1);

		expect(d.unregisterTool("read_note")).toBe(true);
		expect(onChanged).toHaveBeenCalledTimes(2);
	});

	it("does not fire when unregistering an unknown tool", () => {
		const d = new ToolDispatcher();
		const onChanged = vi.fn();
		d.setOnToolsChanged(onChanged);

		expect(d.unregisterTool("missing")).toBe(false);
		expect(onChanged).not.toHaveBeenCalled();
	});
});
