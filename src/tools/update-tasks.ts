import type { Tool, JSONSchema, ToolExecuteOptions, ToolResult } from "./tool";
import type { TaskItem } from "../types";

export const UPDATE_TASKS_TOOL_NAME = "update_tasks";

const VALID_STATUSES = new Set(["pending", "in_progress", "completed"]);

export class UpdateTasksTool implements Tool {
	readonly name = UPDATE_TASKS_TOOL_NAME;
	readonly description =
		"Update the task checklist for the current conversation. " +
		"Pass the complete list of tasks each time — this replaces any previous task list. " +
		"Use to track multi-step plans and progress.";
	readonly input_schema: JSONSchema = {
		type: "object",
		properties: {
			tasks: {
				type: "array",
				description: "Complete list of tasks. Each call replaces the entire list.",
				items: {
					type: "object",
					properties: {
						content: {
							type: "string",
							description: "Task description (imperative form, e.g. 'Run the tests')",
						},
						status: {
							type: "string",
							enum: ["pending", "in_progress", "completed"],
							description: "Current task state",
						},
					},
					required: ["content", "status"],
				},
			},
		},
		required: ["tasks"],
	};
	readonly mode = "read" as const;
	readonly internal = true;

	async execute(
		params: Record<string, unknown>,
		options?: ToolExecuteOptions,
	): Promise<ToolResult> {
		const tasks = params.tasks as unknown[];

		if (!Array.isArray(tasks) || tasks.length === 0) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "tasks must be a non-empty array",
			};
		}

		const validated: TaskItem[] = [];
		for (let i = 0; i < tasks.length; i++) {
			const t = tasks[i] as Record<string, unknown>;
			if (!t || typeof t.content !== "string" || !t.content.trim()) {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: `tasks[${i}].content must be a non-empty string`,
				};
			}
			if (!VALID_STATUSES.has(t.status as string)) {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: `tasks[${i}].status must be one of: pending, in_progress, completed`,
				};
			}
			validated.push({
				content: t.content.trim(),
				status: t.status as TaskItem["status"],
			});
		}

		const sessionContext = options?.sessionContext;
		if (!sessionContext?.setConversationTasks) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "No active conversation session",
			};
		}

		sessionContext.setConversationTasks(validated);

		const completed = validated.filter((t) => t.status === "completed").length;
		const inProgress = validated.filter((t) => t.status === "in_progress").length;
		return {
			tool_name: this.name,
			success: true,
			result: `Tasks updated. Progress: ${completed}/${validated.length} completed.${inProgress > 0 ? ` ${inProgress} in progress.` : ""}`,
		};
	}
}
