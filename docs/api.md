# Scripting API

Notor exposes a small, versioned API that other plugins and your own scripts can call to run [circuits](circuits.md), [workflows](workflows.md), and individual tools. The main use is [Templater](https://silentvoid13.github.io/Templater/) scripts, for example a meeting template that sends the finished note to a circuit to propose follow-up edits. Anything that can reach Obsidian's `app` object can use it: QuickAdd macros, other plugins, or the developer console.

Runs started through the API follow the same rules as runs you start yourself: your Plan/Act mode, tool settings, path rules, and approval prompts all apply. See [Approval and safety](#approval-and-safety).

## Getting the API

```js
const notor = app.plugins.plugins.notor?.api;
if (!notor) throw new Error("Notor isn't installed or enabled.");
```

`notor.version` is `1`. It only changes when a release breaks this API.

You don't need to wait for Notor to finish loading. Every method waits for `notor.ready` (tools registered, workflows and circuits discovered) before it runs, so a script that fires at startup won't fail. You can also `await notor.ready` yourself.

The API is on by default. To turn it off, go to **Settings → Notor → Automation → External API** and turn off **Enable external API**. While it's off, every call fails with `api_disabled`.

## Running a circuit

```js
const run = await notor.runCircuit("Meeting wrap-up", {
  prompt: "Process [[2026-10-18 Planning sync]] into proposed edits.",
});
console.log(run.status, run.text);
```

`runCircuit(nameOrPath, options)` accepts a circuit's `notor-flow-name` or its directory path. Circuits must be turned on (**Settings → Notor → Circuits**), or the call fails with `circuits_disabled`.

By default a circuit runs headless and the call resolves when the run finishes. With `display: "main"` or `display: "new-panel"`, Notor opens the [run-tree view](circuits.md#the-run-tree-view) when the first step finishes. It also loads each step's conversation into the chosen chat panel as that step finishes. Each step's conversation appears once the step is complete. It isn't streamed while the step runs.

If the circuit is already running, the result has `status: "failed"` and `errorCode: "already_running"`. Pass `allowConcurrent: true` to start another run anyway.

When a circuit pauses to ask you something, Notor opens the usual input dialog. Pass `interactive: false` to cancel the run instead, which suits unattended scripts.

## Running a workflow

```js
const run = await notor.runWorkflow("daily/review", {
  prompt: "Focus on [[Projects/Alpha]].",
  display: "new-panel",
});
```

`runWorkflow(nameOrPath, options)` accepts a workflow's display name (`daily/review`), one of its `aliases`, its file name, or its vault path. A name that matches more than one workflow fails with `ambiguous`; pass the vault path instead.

- `display: "headless"` (the default) runs the workflow in a background conversation. The conversation is saved to your history, and `conversationId` identifies it.
- `display: "main"` runs it in the main Notor chat panel as a new conversation. The main panel must be idle; if it's responding, the call fails with `panel_busy`.
- `display: "new-panel"` opens a new chat tab and runs it there.

## Calling a tool

```js
const note = await notor.runTool("read_note", { path: "Projects/Alpha.md" });
if (note.success) console.log(note.result);
```

`runTool(name, params, options)` calls one tool directly, outside any conversation, with the same checks as a chat tool call. It returns `{ toolName, success, result, error?, durationMs? }`. A failed or rejected call resolves with `success: false` rather than throwing. Legacy tool names work, and `toolName` reports the current name.

Tools that only make sense inside a conversation or circuit (`ask_user`, `submit_plan`, `use_subagent`, `run_circuit`, and internal tools) fail with `unsupported_tool`. Write tools are blocked in Plan mode unless you pass `mode: "act"`.

## Options

| Option | Applies to | Default | Description |
|---|---|---|---|
| `prompt` | circuits, workflows | none | Text processed like the chat input. Links to Markdown notes (`[[Note]]`, `[[Note#Section]]`, `[[Note\|alias]]`) attach those notes' contents. Unresolved links and links to images or PDFs stay as plain text. |
| `display` | circuits, workflows | `"headless"` | `"headless"`, `"main"`, or `"new-panel"`. |
| `wait` | circuits, workflows | `true` | `false` resolves immediately with `status: "running"`. Await `run.done` later for the final result. |
| `mode` | all | your setting | `"plan"` or `"act"`. For workflows, the default is the workflow's `notor-conversation-mode`, falling back to your setting. |
| `approval` | all | `"inherit"` | `"inherit"`, `"auto"`, or `"prompt"`. See [Approval and safety](#approval-and-safety). |
| `interactive` | circuits | `true` | `false` cancels the run instead of asking you for input. |
| `allowConcurrent` | circuits | `false` | Start even if this circuit is already running. |
| `include` | circuits, workflows | `["conversation", "text", "cost"]` | Which result details to return. Add `"notes"` for `notesRead` and `notesEdited`. |
| `signal` | all | none | An `AbortSignal`. Aborting it cancels the run. |

## Results

`runCircuit` and `runWorkflow` resolve with a run result:

| Field | Description |
|---|---|
| `runId` | Pass to `getRun` or `cancelRun`. For circuits, this is the session id. |
| `kind` | `"circuit"` or `"workflow"`. |
| `name` | The circuit or workflow name. |
| `status` | `"running"`, `"completed"`, `"failed"`, or `"cancelled"`. |
| `done` | A promise for the final result. Present even with `wait: false`; it never rejects. |
| `sessionId` | Circuits: the session, which roots the run-tree view. |
| `conversationId` | Workflows: the run's conversation. Circuits: the most recent step conversation. |
| `text` | The final response. For circuits, this is the terminal event's payload. |
| `structured` | Circuits: the typed value a terminal code step emitted, if any. |
| `costUsd` | Estimated cost of the run. |
| `notesRead`, `notesEdited` | Vault paths the run read or changed (only with `include: ["notes"]`). For circuits, this covers the circuit's own steps, not circuits it called. |
| `error`, `errorCode` | Why the run failed or was cancelled. |

`notor.getRun(runId)` returns the current snapshot of a running run, or of one of the last 50 finished runs. `notor.cancelRun(runId)` cancels a running run and returns `false` if it isn't running.

`notor.listCircuits()` returns `{ name, description?, path, invocable }[]`, and `notor.listWorkflows()` returns `{ name, path, aliases }[]`.

## Approval and safety

The `approval` option decides when you're asked to approve a tool call:

| `approval` | Behavior |
|---|---|
| `"inherit"` | Your normal rules: tools with **Auto-approve** on and paths under **auto-approve paths** run without asking; everything else asks. |
| `"auto"` | Every allowed call runs without asking, except **never auto-approve** paths and blocked command patterns, which still ask. Requires **Allow scripts to auto-approve** (see below). A notice appears whenever a run auto-approves. |
| `"prompt"` | Every call asks, even ones you normally auto-approve. |

No option lifts a block. Disabled tools, write tools in Plan mode, blocked and out-of-scope paths, and the domain denylist always apply.

Runs shown in a chat panel ask for approval in the panel. Headless runs and circuits open an **Approve tool call** dialog instead. See [Runs with no chat panel](safety.md#runs-with-no-chat-panel) for ways to keep unattended runs from waiting on you.

`approval: "auto"` is refused (`auto_approve_not_allowed`) until you turn on **Settings → Notor → Automation → External API → Allow scripts to auto-approve**. Only turn it on if you trust every script and plugin that calls Notor. The AI can't change either External API setting.

> Like any plugin, a script with access to `app` can reach Notor's internals directly. These settings protect you from mistakes in scripts you trust; they don't sandbox scripts you don't.

## Errors

Mistakes in a call throw a `NotorApiError` with a `code`. Problems during a run are reported in the result instead (`status: "failed"` or `"cancelled"`).

| `code` | Meaning |
|---|---|
| `api_disabled` | **Enable external API** is off. |
| `unloaded` | Notor was disabled or reloaded. |
| `circuits_disabled` | Circuits are turned off. |
| `not_found` | No circuit, workflow, or tool has that name. |
| `ambiguous` | The name matches more than one circuit or workflow. Pass a path. |
| `auto_approve_not_allowed` | `approval: "auto"` without the opt-in setting. |
| `invalid_option` | An option has an invalid value. |
| `unsupported_tool` | The tool only works inside a conversation or circuit. |
| `panel_unavailable` | Notor couldn't open a chat panel. |
| `panel_busy` | The main chat panel is responding. |

In the result, `errorCode` is `already_running` for a circuit that's already running, or `run_failed` for a run that ended in an error.

## Example: process a meeting with Templater

This template is meant to run at the end of a meeting note. Once Templater has finished writing the note, it sends the note to a "Meeting wrap-up" circuit and shows the run in a new chat tab. `wait: false` lets the template finish without waiting for the circuit.

```js
<%*
tp.hooks.on_all_templates_executed(async () => {
  const notor = app.plugins.plugins.notor?.api;
  if (!notor) return;
  await notor.runCircuit("Meeting wrap-up", {
    prompt: `Process [[${tp.file.title}]] and propose edits to the notes it mentions.`,
    display: "new-panel",
    wait: false,
  });
});
%>
```

The prompt's link attaches the meeting note's contents when the call runs. That's why the example waits for `on_all_templates_executed`: text the template is still inserting isn't in the attachment until it's written.

## Example: summarize a note and use the result

```js
<%*
const notor = app.plugins.plugins.notor.api;
const run = await notor.runWorkflow("summarize", {
  prompt: `Summarize [[${tp.file.title}]] in three bullet points.`,
  include: ["text", "notes"],
});
if (run.status === "completed") tR += run.text;
else new Notice(`Summary failed: ${run.error}`);
%>
```

## Types

These declarations describe the v1 API. You can paste them into your own TypeScript code:

```ts
type NotorApproval = "inherit" | "auto" | "prompt";

interface NotorRunOptions {
  prompt?: string;
  display?: "headless" | "main" | "new-panel";
  wait?: boolean;
  mode?: "plan" | "act";
  approval?: NotorApproval;
  interactive?: boolean;
  allowConcurrent?: boolean;
  include?: Array<"conversation" | "text" | "cost" | "notes">;
  signal?: AbortSignal;
}

interface NotorRunInfo {
  runId: string;
  kind: "circuit" | "workflow";
  name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  sessionId?: string;
  conversationId?: string;
  text?: string;
  structured?: unknown;
  costUsd?: number;
  notesRead?: string[];
  notesEdited?: string[];
  error?: string;
  errorCode?: string;
}

interface NotorRunResult extends NotorRunInfo {
  done: Promise<NotorRunInfo>;
}

interface NotorApi {
  readonly version: 1;
  readonly ready: Promise<void>;
  listCircuits(): Promise<{ name: string; description?: string; path: string; invocable: boolean }[]>;
  listWorkflows(): Promise<{ name: string; path: string; aliases: string[] }[]>;
  runCircuit(nameOrPath: string, opts?: NotorRunOptions): Promise<NotorRunResult>;
  runWorkflow(nameOrPath: string, opts?: NotorRunOptions): Promise<NotorRunResult>;
  runTool(
    name: string,
    params: Record<string, unknown>,
    opts?: { mode?: "plan" | "act"; approval?: NotorApproval; signal?: AbortSignal },
  ): Promise<{ toolName: string; success: boolean; result: unknown; error?: string; durationMs?: number }>;
  getRun(runId: string): NotorRunInfo | undefined;
  cancelRun(runId: string): boolean;
}
```

## Notes

- A circuit started through the API is recorded with origin `api`. If Obsidian quits during the run, [crash recovery](circuits.md#crash-recovery) can resume it under your current settings. The script's `mode` and `approval` options aren't saved, and the original promise won't resolve.
- `notesRead` and `notesEdited` are rebuilt from the run's saved tool calls after it finishes. Notes attached through `prompt` count as read.
- Run handles are kept in memory only, so `getRun` forgets runs when Obsidian restarts.
