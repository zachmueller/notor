# Git Workflow Standards

## Automated Commit Requirements

**MANDATORY:** After completing ANY task that modifies files, commit changes before responding to the user.

### Commit Process

Use the Git MCP tools — **not** raw `git` CLI commands — for all git operations:

1. **Check status:** `mcp__git__status` to identify what changed and ensure only intended files are modified
2. **Commit:** `mcp__git__commit` with:
   - `files` — only files intentionally modified as part of the task
   - `summary` — concise action summary (e.g., "Add retry logic to API client")
   - `change_details` — each entry is a plain string (the tool prepends `- ` automatically)
   - `human_input` — the user's prompt (full text if ≤255 words, otherwise summarized to ~1 paragraph)
   - `workflow` — (if an explicit instruction/workflow file is attached) the workflow name from the `type` attribute of the `<explicit_instructions>` tag

### When to Commit
- After creating/updating any files
- After completing spec documents, code changes, or config updates
- Before asking user for feedback on completed work

### What NOT to Commit
- Files modified by user or other processes
- Unrelated changes from previous work
- Files that were only read, not modified

## Branch Management

Use `mcp__git__create_branch` and `mcp__git__switch_branch` for branch operations.

- Commit to the current branch unless otherwise specified
- Keep commits atomic — one logical unit of work per commit

## Quality Standards
- Maintain clean, focused commit history
