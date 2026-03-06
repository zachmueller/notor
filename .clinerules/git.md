# Git Workflow Standards

## Automated Commit Requirements

**MANDATORY:** After completing ANY task that modifies files, Cline must immediately commit the changes before responding to the user.

### Commit Process

> **⚠️ CRITICAL: Each git step below MUST be its own separate `execute_command` call.**
> Never chain git commands together with `&&` or `;`. In particular, **`git commit` must ALWAYS run as its own standalone command**, never combined with `git add`, `git status`, or any other command. Chaining causes multi-line commit messages to be truncated or mis-parsed.

1. **Check status first:** `git status --porcelain` (separate command) to identify what changed and ensure only intended changes are staged
2. **Add AI-modified files using appropriate method:** (separate command)
   - **For modifications/additions only:** `git add <specific-files>`
   - **For deletions:** `git rm <deleted-files>` or `git rm -r <deleted-directories>`
   - **For mixed operations:** Use both approaches - `git add` for modifications/additions, `git rm` for deletions
3. **Commit with descriptive message (separate command — never chained):** `git commit -m "{commit_message}"`
4. **Include in commit message:**
   - Brief summary of what was accomplished
   - Key changes made to each file (explicitly listing deletions, modifications, and additions)
   - Context for why changes were needed
   - Input provided by the human that led to the changes

### Commit Message Format

**When explicit instructions/workflow file is attached:**
```
[Cline] <Action>: <Brief summary>

- <Specific change 1>
- <Specific change 2>
- <Context or rationale if helpful>

---

Workflow: {explicit_instruction_type}
{human_input}
```

**When NO explicit instructions/workflow file is attached:**
```
[Cline] <Action>: <Brief summary>

- <Specific change 1>
- <Specific change 2>
- <Context or rationale if helpful>

---

{human_input}
```

**Important Requirements:**
- **ALWAYS prepend** commit messages with `[Cline]` to indicate AI-generated commits
- **When an explicit instruction/workflow file is attached:** Include `Workflow: {explicit_instruction_type}` line before human input
  - Extract the workflow name from the `type` attribute of the `<explicit_instructions>` tag
  - Example: `Workflow: version-bump.md`
  - This identifies which workflow guided the AI's actions
- **ALWAYS append** the human input that led to the commit after a `---` separator
  - If the human's prompt is short (~255 words or less), include the full raw prompt text
  - If the human's prompt is long, summarize it to approximately one paragraph in length
- This structure ensures commit provenance and context are preserved in the git history

### When to Commit
- ✅ After creating/updating any files
- ✅ After completing spec documents (requirements, design, tasks)
- ✅ After implementing code changes
- ✅ After updating configuration files
- ✅ Before asking user for feedback on completed work

### What NOT to Include
- ❌ Files modified by user or other processes
- ❌ Unrelated changes from previous work
- ❌ Files that were only read (not modified)

## Branch Management
- Work should be committed to the current branch unless otherwise specified
- Ensure commits are atomic and represent logical units of work
- Use meaningful commit messages that explain the "what" and "why"

## Quality Standards
- Commits should only include files that were intentionally modified as part of the task
- Review changes before committing to ensure no unintended modifications are included
- Maintain clean commit history with focused, purposeful commits