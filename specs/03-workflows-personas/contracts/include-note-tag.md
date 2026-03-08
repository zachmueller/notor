# Contract: `<include_note>` Tag Resolution

**Created:** 2026-08-03
**Plan:** [specs/03-workflows-personas/plan.md](../plan.md)
**Specification:** [specs/03-workflows-personas/spec.md](../spec.md) — FR-46

This contract defines the syntax, parsing rules, resolution algorithm, and error handling for the `<include_note>` tag system.

---

## Tag Syntax

The `<include_note>` tag is a self-closing XML-style tag that injects the contents of a vault note (or a section of a note) into the surrounding text at resolution time.

```xml
<!-- Vault-relative path -->
<include_note path="Research/Topic A.md" section="Summary" mode="inline" strip_frontmatter="true" />

<!-- Wikilink (recommended — rename-safe) -->
<include_note path="[[Topic A]]" section="Summary" mode="inline" />

<!-- Minimal (path only, all defaults) -->
<include_note path="[[Topic A]]" />
```

### Supported Attributes

| Attribute | Required | Type | Default | Description |
|---|---|---|---|---|
| `path` | yes | string | — | Reference to the target note. Vault-relative path (`"Research/Topic A.md"`) or wikilink (`"[[Topic A]]"`). |
| `section` | no | string | null | Heading text to extract. Content runs from this heading to the next heading of equal or higher level (or end of file). |
| `mode` | no | `"inline"` \| `"attached"` | `"inline"` | `inline`: paste content directly into surrounding text. `attached`: include as a separate attached file in context. |
| `strip_frontmatter` | no | `"true"` \| `"false"` | `"true"` | When `"true"`, strip YAML frontmatter before injection. When `"false"`, include frontmatter as-is. |

All other attributes are silently ignored.

---

## Parsing Algorithm

### Step 1: Find Tags

Scan the input text for all `<include_note ... />` tags using the regex pattern:

```
/<include_note\s+([^>]*?)\s*\/>/g
```

This matches:
- The opening `<include_note` literal
- One or more whitespace characters
- A non-greedy capture group for attribute content (`[^>]*?`)
- Optional trailing whitespace
- The self-closing `/>` literal

### Step 2: Extract Attributes

For each matched tag, extract attributes from the captured group using:

```
/(\w+)\s*=\s*"([^"]*)"/g
```

This matches key-value pairs where values are double-quoted strings. Single-quoted values are not supported.

### Step 3: Validate Required Attributes

- If `path` is missing or empty → leave the tag as-is in the output (do not resolve).
- Parse `path_type`: if value contains `[[` → `"wikilink"`, otherwise → `"vault_relative"`.
- Parse `section`: use value if present, otherwise null.
- Parse `mode`: use value if `"inline"` or `"attached"`, otherwise default to `"inline"`.
- Parse `strip_frontmatter`: `"false"` → false, anything else → true.

---

## Resolution Algorithm

### Step 1: Resolve Path to File

**Vault-relative path** (path does not contain `[[`):
```typescript
const file = app.vault.getAbstractFileByPath(path);
if (!(file instanceof TFile)) → error: note not found
```

**Wikilink** (path contains `[[`):
```typescript
const linkPath = path.replace(/^\[\[|\]\]$/g, ""); // strip [[ and ]]
const file = app.metadataCache.getFirstLinkpathDest(linkPath, sourceFilePath);
if (!file) → error: note not found
```

Where `sourceFilePath` is the vault-relative path of the file containing the `<include_note>` tag (provides disambiguation context for the link resolver).

**Vault-scoping security check:**
- After resolution, verify the file is within the vault. Paths that resolve outside the vault are treated as "note not found".

### Step 2: Read Note Content

```typescript
const content = await app.vault.read(file);
```

### Step 3: Strip Frontmatter (if enabled)

If `strip_frontmatter` is `true` (default):
```typescript
const fmInfo = getFrontMatterInfo(content);
const body = content.slice(fmInfo.contentStart);
```

If `strip_frontmatter` is `false`:
- Use the full `content` as-is (including YAML frontmatter block).

### Step 4: Extract Section (if specified)

If `section` is specified:
```typescript
const cache = app.metadataCache.getFileCache(file);
const headings = cache?.headings ?? [];
const targetIdx = headings.findIndex(h => h.heading === section);
if (targetIdx === -1) → error: section not found

const targetHeading = headings[targetIdx];
const targetLevel = targetHeading.level;
const startOffset = targetHeading.position.start.offset;

// Find the next heading of equal or higher level
let endOffset = body.length;
for (let i = targetIdx + 1; i < headings.length; i++) {
  if (headings[i].level <= targetLevel) {
    endOffset = headings[i].position.start.offset;
    break;
  }
}

const sectionContent = body.slice(startOffset, endOffset).trim();
```

If `section` is not specified:
- Use the full body content.

### Step 5: Apply Mode

**Inline mode (`mode="inline"`):**
- Replace the `<include_note ... />` tag with the resolved content directly in the surrounding text.

**Attached mode (`mode="attached"`):**
- Replace the `<include_note ... />` tag with an empty string in the surrounding text.
- Add the resolved content to a separate `<attachments>` block as a `<vault-note>` element:
  ```xml
  <vault-note path="{resolved-path}" section="{section-if-specified}">
  {resolved content}
  </vault-note>
  ```
- If multiple `<include_note>` tags use `attached` mode, all vault-note elements are collected into a single `<attachments>` block.

### Step 6: Handle Nested Tags

If the resolved content itself contains `<include_note>` tags:
- **Do NOT resolve them.** Pass them through as literal text.
- This prevents circular reference loops and keeps the resolution single-pass.

---

## Error Handling

| Condition | Error Marker |
|---|---|
| Note not found (vault-relative path) | `[include_note error: note 'Research/Topic A.md' not found]` |
| Note not found (wikilink) | `[include_note error: note '[[Topic A]]' not found]` |
| Section not found | `[include_note error: section 'Summary' not found in 'Research/Topic A.md']` |
| Path resolves outside vault | `[include_note error: note '{path}' not found]` (same as not found) |

Error markers are inserted inline in the text at the position of the original tag. The rest of the document continues to be processed normally. Error markers are visible to the LLM in the prompt text.

---

## Context-Specific Rules

| Context | Inline Mode | Attached Mode | Notes |
|---|---|---|---|
| Workflow note body | ✓ Supported | ✓ Supported | Both modes work as described |
| Global system prompt | ✓ Supported | ✗ Ignored (always inline) | `mode` attribute ignored |
| Persona system prompt | ✓ Supported | ✗ Ignored (always inline) | `mode` attribute ignored |
| Vault-level rule file | ✓ Supported | ✗ Ignored (always inline) | `mode` attribute ignored |

---

## Resolution Timing

| Context | When Resolved |
|---|---|
| Workflow note body | At workflow execution time (when the workflow is triggered) |
| Global system prompt | Before each LLM API call (system prompt is reassembled per call) |
| Persona system prompt | Before each LLM API call (persona prompt resolved alongside global) |
| Vault-level rule file | Before each LLM API call (rules re-evaluated per call) |

Tags are always resolved with the latest note content — there is no caching of resolved content between calls.

---

## Examples

### Inline resolution (default)

**Input (workflow body):**
```markdown
Analyze the following research and identify connections:

<include_note path="[[Climate Research]]" section="Key Findings" />

<include_note path="Research/Energy.md" section="Conclusions" />

Suggest three new research questions.
```

**Output (after resolution):**
```markdown
Analyze the following research and identify connections:

## Key Findings

Global temperatures have risen by 1.2°C since pre-industrial levels...

## Conclusions

Renewable energy adoption has accelerated dramatically in developing nations...

Suggest three new research questions.
```

### Attached resolution

**Input (workflow body):**
```markdown
Review these notes and create a summary:

<include_note path="[[Meeting Notes]]" mode="attached" />
<include_note path="[[Action Items]]" mode="attached" />
```

**Output (body text after tag removal):**
```markdown
Review these notes and create a summary:


```

**Output (attachments block, appended to message):**
```xml
<attachments>
  <vault-note path="Meetings/Meeting Notes.md">
# Meeting Notes
...full note content...
  </vault-note>
  <vault-note path="Tasks/Action Items.md">
# Action Items
...full note content...
  </vault-note>
</attachments>
```

### Error case

**Input:**
```markdown
<include_note path="Research/Deleted.md" />
```

**Output:**
```markdown
[include_note error: note 'Research/Deleted.md' not found]
```
