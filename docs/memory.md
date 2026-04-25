# Knowledge memory

Notor can build persistent memory across conversations. It automatically recalls relevant context at the start of each conversation, captures durable insights after each turn, and consolidates memories on a schedule. Memory notes are stored as standard Obsidian notes in your vault — fully visible, searchable, and editable.

## How it works

Three automatic pipelines plus one manual tool:

### Memory search (conversation start)

At the start of every new conversation, a blocking automation spawns the `memory-search` sub-agent to find memory notes relevant to the user's first message. Matched notes appear as a collapsible **Memories Recalled** card in the chat with clickable note links and a short reason for each match. The full note bodies are sent to the LLM as `<notor-memory>` context so the AI can draw on them in its first response.

If no memory notes exist yet (cold start), the search is silently skipped.

### Memory capture (after each turn)

After each AI response, a detached automation spawns the `memory-capture` sub-agent to extract up to 3 durable insights from the conversation turn. Each insight goes through a pipeline:

1. **Fingerprint and dedup** — the insight is hashed (SHA256) and checked against a dedup cache. Duplicate insights within the configurable dedup window (default: 7 days) are silently dropped.
2. **Concept resolution** — the `memory-resolver` sub-agent decides whether to create a new memory note or update an existing one. It searches the memory folder for related notes, reads candidates in full, and returns a structured directive.
3. **Write** — the note is created or updated in the memory folder.

Results appear as a collapsible **Memories Captured** card showing each note with a "created" or "updated" badge. This card is purely informational — it consumes zero LLM tokens.

### Memory dream (scheduled consolidation)

On a cron schedule (default: every 3 hours), the dream pipeline reviews conversations that occurred since its last run:

1. Loads recent conversation history using a progressive cursor (only processes new conversations each run).
2. Chunks conversations into manageable batches.
3. Spawns the `memory-dream` sub-agent for each chunk to produce consolidation directives: create, update, merge, or remove notes.
4. Applies directives to the memory folder — merging near-duplicates, removing stale claims, splitting fused concepts.

If a note grows too large during consolidation, overflow handling splits or compacts it automatically.

### `capture_memory` tool (manual)

When you explicitly ask the AI to remember something, it can invoke the `capture_memory` tool. This routes the content through the same dedup and concept resolver pipeline as automatic capture.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `content` | Yes | The insight or piece of knowledge to save. |

- Write tool — available in Act mode only. Auto-approved by default.
- Only available when memory is enabled.

## Evergreen note format

Memory notes follow Evergreen note principles: each note captures a single concept, is standalone (readable without the originating conversation), and links organically to related notes via `[[wikilinks]]`.

Notes are stored in `{notor_dir}/memory/` (configurable) with YAML frontmatter:

| Field | Description |
|-------|-------------|
| `notor-type` | Always `memory` |
| `notor-created-at` | ISO 8601 timestamp of when the note was first created |
| `notor-memory-updated-at` | ISO 8601 timestamp of the last time the note body was updated |
| `notor-last-recalled-at` | ISO 8601 timestamp of the last time this note was surfaced in a conversation |
| `notor-last-useful-at` | ISO 8601 timestamp of the last time this note was acted on or deemed relevant |
| `notor-last-linked-to-at` | ISO 8601 timestamp of the last time this note was referenced via wikilinks from another memory note |
| `notor-sources` | Array of provenance tags (e.g., `[chat]`, `[chat, dream]`) |

The last three timestamp fields (`notor-last-recalled-at`, `notor-last-useful-at`, `notor-last-linked-to-at`) are updated in-place without bumping `notor-memory-updated-at`, so the body-update timestamp stays accurate.

The body starts with an H1 title followed by the note content. Filenames are kebab-case slugs derived from the title (e.g., `user-prefers-explicit-error-handling.md`).

## Enabling memory

1. Configure the **tiny** and **large** model presets in **Settings → Notor → Models**. See [model-presets.md](model-presets.md).
2. Open **Settings → Notor → Memory** and toggle **Enable memory**.
   - Notor validates that the required presets are configured. If either is missing, the toggle reverts with an error message listing what needs to be set up.
   - The memory folder is created automatically if it doesn't exist.
   - The `capture_memory` tool is enabled.
3. Start a conversation — the AI automatically searches for relevant memories and captures new insights.

> Memory requires two preset tiers because the sub-agents use different model sizes: lightweight models (`tiny`) for search, capture, and resolution tasks, and a capable model (`large`) for the Dream consolidation pipeline.

## Settings

Configure memory under **Settings → Notor → Memory**:

| Setting | Default | Description |
|---------|---------|-------------|
| Enable memory | Off | Master toggle for the entire memory subsystem. Requires `tiny` and `large` presets. |
| Memory folder | `memory` | Subfolder under the Notor directory for Evergreen memory notes. Full vault-relative path: `{notor_dir}/{folder}`. |

## Sub-agent profiles

Memory uses four built-in sub-agent profiles:

| Profile | Purpose | Preset | Iteration cap |
|---------|---------|--------|---------------|
| `memory-search` | Search memory notes for context relevant to the current conversation | `tiny` | 6 |
| `memory-resolver` | Decide whether to create a new note or update an existing one for a given insight | `tiny` | 6 |
| `memory-capture` | Extract durable insights from a conversation turn | `tiny` | 5 |
| `memory-dream` | Consolidate and refine memory notes from recent conversations | `large` | 16 |

These profiles appear in **Settings → Notor → Sub-agents** with a "Built-in" badge. They use [template variables](system-prompt.md#template-variables-in-other-contexts) like `{notor_dir}/memory/` in their `<notor_tool_config>` blocks to scope tool access to the memory folder.

## Customization

All memory components are built-in scaffolds that can be customized:

- **Sub-agent profiles** — click **Open** next to a memory profile in **Settings → Notor → Sub-agents** to create a vault file. Edit the system prompt, tool config, or iteration cap. Click **Reset to default** to restore the original.
- **Automations** — each memory automation (search, capture, dream) appears in **Settings → Notor → Extensions** with per-automation settings:

| Automation | Key settings |
|------------|-------------|
| Memory Search | `search_profile` (sub-agent to use), `max_matches` (notes to surface, default: 8) |
| Memory Capture | `capture_profile` (sub-agent to use) |
| Memory Dream | `dream_profile` (sub-agent to use), `schedule` (cron expression, default: `0 */3 * * *`), `chunk_size`, `max_chunks` |

- **Chat blocks** — the `memory_recalled` and `memory_captured` block renderers can be customized by creating vault files in `notor/blocks/`. Edit the `render()` function to change how recalled or captured memories appear in the chat.

## Notes

- Memory is gated as a **feature group**: enabling or disabling the master toggle enables or disables all memory automations, the `capture_memory` tool, and memory chat blocks as a unit.
- Memory notes are regular vault notes — you can read, edit, delete, or reorganize them manually at any time. They are searchable and linkable like any other note.
- The `memory-search` automation is **blocking**: it completes before the first LLM turn, ensuring recalled memories are visible to the AI on its first response.
- Internal state files (`.dedup-cache.json`, `.dream-cursor.json`) are stored as dot-files in the memory folder.
