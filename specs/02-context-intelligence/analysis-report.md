# Cross-Artifact Analysis Report

**Generated:** 2026-07-03T18:08:00+13:00
**Feature:** Phase 3 — Context & Intelligence
**Branch:** feature/02-context-intelligence
**Artifacts:** spec.md, plan.md, tasks.md (+ data-model.md)

## Executive Summary

- **Total Findings:** 11 (Critical: 1, High: 2, Medium: 5, Low: 3)
- **Coverage:** 100% of functional requirements (FR-1 through FR-13) mapped to tasks
- **Readiness:** NEEDS ATTENTION — one critical and two high-severity issues should be resolved before implementation

The three core artifacts (spec.md, plan.md, tasks.md) are well-aligned overall. The specification is thorough with extensive clarifications. The plan faithfully translates the spec into technical architecture, and the task breakdown provides granular coverage of all functional requirements. One critical finding relates to FR/NFR/task ID numbering collisions with the prior MVP spec (`specs/01-mvp/`). Two high-severity findings relate to missing task coverage for specific acceptance criteria and a terminology inconsistency in task phasing. Five medium-severity findings involve minor gaps and inconsistencies. Three low-severity findings are cosmetic or documentation improvements.

---

## Findings Summary

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| N1 | Inconsistency | CRITICAL | All 02-context-intelligence docs vs 01-mvp docs | FR-1–13, NFR-1–4, ENV-001, and TOOL-001–008 collide with identically numbered items in 01-mvp | Renumber: FRs→FR-24–36, NFRs→NFR-6–9, ENV-001→ENV-005, TOOL-001–008→TOOL-010–017 |
| C1 | Coverage | HIGH | spec.md FR-1, tasks.md | `[[` shortcut in chat input not covered by a dedicated acceptance criterion in ATT-005 | Add explicit AC to ATT-005 for `[[` trigger behavior |
| I1 | Inconsistency | HIGH | tasks.md phase numbering vs plan.md feature groups | tasks.md phases 2–5 do not match plan.md feature group labels (A–F); tasks.md "Phase 3" = Attachments but plan.md "Feature Group A" = Attachments | Align phase labels or add cross-reference mapping |
| C2 | Coverage | MEDIUM | spec.md FR-6, tasks.md | Manual compaction trigger (button/command) mentioned in FR-6 AC but only noted parenthetically in COMP-002/COMP-004; no standalone task for command registration | Add explicit AC or subtask for command palette registration |
| I2 | Inconsistency | MEDIUM | spec.md NFR-2, tasks.md | NFR-2 states hook shell commands use same working directory restrictions as `execute_command`; no task or AC covers enforcing path restrictions on hooks | Add AC to HOOK-002 requiring working directory validation for hook shell commands |
| U1 | Underspecification | MEDIUM | spec.md FR-9, plan.md, tasks.md | `execute_command` working directory resolution for relative paths is not specified in spec.md; only tasks.md TOOL-005 mentions "relative → resolve from vault root" | Add clarification to spec.md or data-model.md for working directory resolution semantics |
| C3 | Coverage | MEDIUM | spec.md key entities § Hook, tasks.md HOOK-002 | Spec states hook shell commands use same runtime and path restrictions as `execute_command`; HOOK-002 engine does not mention working directory allow-list enforcement | Add AC to HOOK-002 for working directory allow-list check |
| D1 | Duplication | MEDIUM | spec.md FR-1 AC + Clarifications | The attachment chip-only display rule appears in FR-1 AC ("Attachments are shown in the sent message…") and again in the Clarifications section as a Q&A; minor redundancy | No action needed; redundancy is acceptable for clarification tracking |
| I3 | Inconsistency | MEDIUM | data-model.md § Attachment, spec.md FR-2 | data-model.md stores `path` as "original absolute file path at attach time" for external files, but spec.md FR-2 says "External files are labeled as such… so the user can distinguish them from vault notes." The `display_name` field covers this, but `path` exposes absolute paths in JSONL logs | Document that absolute paths in JSONL are expected and not exposed in UI |
| A1 | Ambiguity | LOW | spec.md FR-7, plan.md | `fetch_webpage` uses "neutral `Notor/1.0` User-Agent header" — minor ambiguity on whether this is the full header value or includes additional info (e.g., version number) | Clarify exact User-Agent string (e.g., `Notor/1.0` as the complete value) |
| L1 | Low-priority | LOW | tasks.md | Task count summary says "42 tasks" but actual enumerated tasks total 42 (including RES/ENV/FOUND/CTX/ATT/TOOL/HOOK/COMP/TEST/DOC/POLISH/VAL); count is accurate | No action needed |
| L2 | Low-priority | LOW | plan.md § Risk Assessment | Risk "Turndown produces poor quality output" rated likelihood "Medium" but impact "Low" — the impact may be higher for research-heavy use cases where web content quality matters | Consider bumping impact to "Medium" or adding a mitigation note for future readability filtering |

---

## Coverage Analysis

### Functional Requirements → Task Mapping

| Requirement | Tasks | Status | Notes |
|-------------|-------|--------|-------|
| FR-1: Note attachment via file picker | ATT-001, ATT-002, ATT-004, ATT-005, ATT-007, ATT-008 | ✓ Complete | `[[` shortcut covered in ATT-005 AC but could be more explicit |
| FR-2: External file attachment | ATT-001, ATT-003, ATT-006, ATT-007, ATT-008 | ✓ Complete | |
| FR-3: Auto-context — open note paths | CTX-001, CTX-004, CTX-005, CTX-006 | ✓ Complete | |
| FR-4: Auto-context — vault structure | CTX-002, CTX-004, CTX-005, CTX-006 | ✓ Complete | |
| FR-5: Auto-context — OS | CTX-003, CTX-004, CTX-005, CTX-006 | ✓ Complete | |
| FR-6: Auto-compaction | COMP-001, COMP-002, COMP-003, COMP-004, COMP-005 | ✓ Adequate | Manual trigger mentioned but no dedicated command registration task |
| FR-7: `fetch_webpage` tool | TOOL-001, TOOL-002, TOOL-003, ENV-001 | ✓ Complete | |
| FR-8: Domain denylist | TOOL-002, TOOL-004 | ✓ Complete | |
| FR-9: `execute_command` tool | TOOL-005, TOOL-006, TOOL-007 | ✓ Complete | Relative working directory resolution only in tasks, not spec |
| FR-10: Hooks — `pre-send` | HOOK-001, HOOK-002, HOOK-003, HOOK-004, HOOK-006 | ✓ Complete | |
| FR-11: Hooks — `on-tool-call` | HOOK-001, HOOK-002, HOOK-003, HOOK-005, HOOK-006 | ✓ Complete | |
| FR-12: Hooks — `on-tool-result` | HOOK-001, HOOK-002, HOOK-003, HOOK-005, HOOK-006 | ✓ Complete | |
| FR-13: Hooks — `after-completion` | HOOK-001, HOOK-002, HOOK-003, HOOK-005, HOOK-006 | ✓ Complete | |

### Non-Functional Requirements → Coverage

| Requirement | Coverage | Status | Notes |
|-------------|----------|--------|-------|
| NFR-1: Performance | CTX-001 AC (<100 ms), TOOL-001 (timeout), COMP-004 (transparent), HOOK-002 (timeout) | ✓ Complete | |
| NFR-2: Security & privacy | TOOL-002 (denylist), TOOL-005 (path validation), HOOK-002 (shell restrictions) | ⚠ Partial | Hook working directory restriction not explicitly tasked (see C3) |
| NFR-3: Usability & transparency | ATT-005 (discoverable), CTX-005 (defaults on), COMP-004 (marker), TOOL-006 (Act-only), DOC-001 (system prompt) | ✓ Complete | |
| NFR-4: Reliability | TOOL-001 (fetch errors), TOOL-005 (command failures), HOOK-002 (non-blocking), COMP-002 (fallback), ATT-002 (missing notes) | ✓ Complete | |

### User Stories → Coverage

All user stories in spec.md map to one or more functional requirements, which in turn map to tasks. No orphaned user stories.

### User Scenarios → Coverage

| Scenario | FRs Exercised | Tasks Covering | Status |
|----------|---------------|----------------|--------|
| Attach note section and ask about it | FR-1 | ATT-002, ATT-005, ATT-008, TEST-002 | ✓ |
| AI fetches webpage and saves to note | FR-7 | TOOL-001, TOOL-003, TEST-003 | ✓ |
| Long session with auto-compaction | FR-6 | COMP-001–005, TEST-006 | ✓ |
| Shell command assistance | FR-9 | TOOL-005, TOOL-006, TEST-004 | ✓ |
| After-completion hook saves summary | FR-13 | HOOK-005, TEST-005 | ✓ |
| Blocked domain fetch | FR-7, FR-8 | TOOL-002, TEST-003 | ✓ |
| Execute command in Plan mode | FR-9 | TOOL-006 | ✓ |
| Compaction summarization fails | FR-6 | COMP-002, TEST-006 | ✓ |
| Oversized file attachment | FR-2 | ATT-003, ATT-006, TEST-002 | ✓ |
| Auto-context with no open notes | FR-3 | CTX-001, TEST-001 | ✓ |
| Vault note deleted after chip added | FR-1 | ATT-002, ATT-008, TEST-002 | ✓ |
| Section reference to non-existent heading | FR-1 | ATT-002, TEST-002 | ✓ |
| Working directory outside allowed paths | FR-9 | TOOL-005, TEST-004 | ✓ |
| Hook failure does not block message | FR-10–13 | HOOK-002, TEST-005 | ✓ |

---

## Detailed Findings

### N1 — FR/NFR/Task ID numbering collisions with prior MVP spec (CRITICAL)

**Location:** All `specs/02-context-intelligence/` documents vs `specs/01-mvp/` documents
**Detail:** The 02-context-intelligence spec reuses FR, NFR, and task ID numbers that are already assigned in the prior 01-mvp spec. This creates ambiguity when cross-referencing requirements across phases — "FR-1" could mean either "LLM provider integration" (01-mvp) or "Note attachment via file picker" (02-context-intelligence).

**Collisions identified:**

| Element | 01-mvp Range | 02-context Range | Collision |
|---------|-------------|------------------|-----------|
| Functional Requirements (FR-) | FR-1 through FR-23 | FR-1 through FR-13 | FR-1 to FR-13 collide |
| Non-Functional Requirements (NFR-) | NFR-1 through NFR-5 | NFR-1 through NFR-4 | NFR-1 to NFR-4 collide |
| Task ID: ENV- | ENV-001 through ENV-004 | ENV-001 | ENV-001 collides |
| Task ID: TOOL- | TOOL-001 through TOOL-009 | TOOL-001 through TOOL-008 | TOOL-001 to TOOL-008 collide |

**Renumbering plan:**

| Current (02-context) | New ID | Description |
|---------------------|--------|-------------|
| **Functional Requirements** | | |
| FR-1 | FR-24 | Note attachment via file picker |
| FR-2 | FR-25 | External file attachment |
| FR-3 | FR-26 | Auto-context — open note paths |
| FR-4 | FR-27 | Auto-context — vault structure |
| FR-5 | FR-28 | Auto-context — operating system |
| FR-6 | FR-29 | Auto-compaction |
| FR-7 | FR-30 | `fetch_webpage` tool |
| FR-8 | FR-31 | Domain denylist for `fetch_webpage` |
| FR-9 | FR-32 | `execute_command` tool |
| FR-10 | FR-33 | LLM interaction hooks — `pre-send` |
| FR-11 | FR-34 | LLM interaction hooks — `on-tool-call` |
| FR-12 | FR-35 | LLM interaction hooks — `on-tool-result` |
| FR-13 | FR-36 | LLM interaction hooks — `after-completion` |
| **Non-Functional Requirements** | | |
| NFR-1 | NFR-6 | Performance |
| NFR-2 | NFR-7 | Security and privacy |
| NFR-3 | NFR-8 | Usability and transparency |
| NFR-4 | NFR-9 | Reliability |
| **Task IDs** | | |
| ENV-001 | ENV-005 | Install Turndown dependency |
| TOOL-001 | TOOL-010 | `fetch_webpage` tool implementation |
| TOOL-002 | TOOL-011 | Domain denylist matching |
| TOOL-003 | TOOL-012 | `fetch_webpage` tool registration |
| TOOL-004 | TOOL-013 | Domain denylist settings UI |
| TOOL-005 | TOOL-014 | `execute_command` tool implementation |
| TOOL-006 | TOOL-015 | `execute_command` tool registration |
| TOOL-007 | TOOL-016 | `execute_command` settings UI |
| TOOL-008 | TOOL-017 | Tool dispatch flow updates |

**Files requiring updates:** This renumbering affects the following files:
- `specs/02-context-intelligence/spec.md` — all FR-N and NFR-N references
- `specs/02-context-intelligence/plan.md` — all FR-N, NFR-N, and task ID references
- `specs/02-context-intelligence/tasks.md` — ENV-001, TOOL-001–008 task IDs and all cross-references
- `specs/02-context-intelligence/data-model.md` — any FR/NFR references
- `specs/02-context-intelligence/contracts/tool-schemas.md` — any FR references
- `specs/02-context-intelligence/checklists/requirements.md` — any FR/NFR references

**Recommendation:** Renumber all colliding IDs across all 02-context-intelligence documents using the mapping above. Update all internal cross-references (dependency lists, coverage matrices, acceptance criteria referencing FR numbers). This should be done before implementation begins to avoid confusion in code comments, commit messages, and task tracking.

---

### C1 — `[[` shortcut trigger not explicitly covered in task AC (HIGH)

**Location:** spec.md FR-1 (second AC bullet), tasks.md ATT-005
**Detail:** spec.md FR-1 states: "When the user types `[[` in the Notor chat input box, the vault file picker opens directly (bypassing the menu)." ATT-005 includes a general AC for `[[` trigger ("Typing `[[` in the chat input triggers the vault picker directly (bypassing the menu)"), so this is actually covered. However, the behavior of applying "the same wikilink autocomplete behavior as Obsidian's native note editor — showing matching note titles and allowing selection to complete the link" is only in the spec, not restated in the task AC.

**Recommendation:** This finding is **borderline adequate** — the task AC does reference `[[` trigger and fuzzy matching. Consider adding a note to ATT-005 AC that the `[[` behavior should mirror Obsidian's native wikilink autocomplete UX for consistency.

---

### I1 — Task phase numbering misaligns with plan feature group labels (HIGH)

**Location:** plan.md § Implementation Phases (Feature Groups A–F), tasks.md § Phases 0–6
**Detail:** The plan uses Feature Group labels: A (Attachments), B (Auto-Context), C (Auto-Compaction), D (fetch_webpage), E (execute_command), F (Hooks). The tasks.md reorders and renumbers these as implementation phases:
- tasks.md Phase 2 = Auto-Context (plan's Group B)
- tasks.md Phase 3 = Attachments (plan's Group A)
- tasks.md Phase 4 = Tools (plan's Groups D + E combined)
- tasks.md Phase 5 = Hooks & Compaction (plan's Groups F + C combined)

The reordering itself is valid (plan.md § Recommended Implementation Order suggests B before A). But the numeric phase labels ("Phase 3", "Phase 4") in tasks.md conflict with the feature-level "Phase 3" label used in spec.md (which refers to the entire Context & Intelligence scope). This creates terminological confusion — "Phase 3" means different things in spec.md vs tasks.md.

**Recommendation:** Rename tasks.md phases to avoid collision with the spec-level phase number. Options:
1. Use "Implementation Phase" or "Step" (e.g., "Step 2: Auto-Context Injection") instead of "Phase"
2. Use the feature group letter labels from plan.md (e.g., "Group B: Auto-Context Injection")
3. Keep numbered but prefix with "Impl-" (e.g., "Impl-Phase 2: Auto-Context Injection")

---

### C2 — Manual compaction trigger lacks dedicated task (MEDIUM)

**Location:** spec.md FR-6 AC ("Compaction can be triggered manually by the user via a button or command"), tasks.md COMP-002/COMP-004
**Detail:** COMP-002 mentions "Compaction can be triggered manually via a command or button" in its AC, and COMP-004 mentions "Manual compaction trigger available via command palette." However, there is no task specifically for registering the command in the plugin's `addCommand()` lifecycle. This could be overlooked during implementation since it's buried inside two different task ACs rather than being its own task or a clear sub-step.

**Recommendation:** Add an explicit AC to COMP-004 (or a subtask) for: "Register `notor:compact-context` (or similar) via `this.addCommand()` in `main.ts` with a stable command ID."

---

### I2 — Hook shell commands not explicitly constrained by working directory allow-list in tasks (MEDIUM)

**Location:** spec.md NFR-2 ("Hook shell commands are executed using the same runtime and path restrictions as the `execute_command` tool; they do not bypass Notor's working directory allow-list"), tasks.md HOOK-002
**Detail:** The spec is clear that hooks must use the same working directory restrictions as `execute_command`. However, HOOK-002's acceptance criteria focus on environment variable injection, timeout, and stdout capture — there is no AC requiring the hook engine to enforce the working directory allow-list. If a developer implements HOOK-002 without reading NFR-2, hooks could run shell commands from any directory.

**Recommendation:** Add an AC to HOOK-002: "Hook shell commands execute with `cwd` set to the vault root. The working directory allow-list from `execute_command` settings is enforced for hook shell commands; commands cannot run from directories outside allowed paths."

---

### U1 — Working directory resolution for relative paths underspecified (MEDIUM)

**Location:** spec.md FR-9, tasks.md TOOL-005
**Detail:** spec.md FR-9 states `working_directory` "defaults to vault root" but does not specify how relative paths should be resolved. tasks.md TOOL-005 adds "relative → resolve from vault root" in its AC, which is a reasonable implementation choice but introduces specification beyond what's in spec.md. This means the tasks document is making a design decision that should be in the spec.

**Recommendation:** Add a clarification to spec.md FR-9 (or the Clarifications section): "Q: How are relative `working_directory` paths resolved? A: Relative paths are resolved from the vault root."

---

### C3 — Hook engine missing working directory allow-list enforcement (MEDIUM)

**Location:** spec.md § Key entities → Hook, NFR-2; tasks.md HOOK-002
**Detail:** This is the task-level manifestation of finding I2. The spec defines that hooks share `execute_command`'s path restrictions, but no task AC enforces this. The shared `ShellExecutor` (FOUND-003) is used by both tools and hooks, but the working directory validation in TOOL-005 is tool-specific. HOOK-002 should also validate the working directory (hooks default to vault root, but if the hook engine ever supports configurable `cwd`, the validation must be present).

**Recommendation:** Same as I2 — add an AC to HOOK-002 for working directory validation.

---

### D1 — Attachment display rule duplicated across spec sections (MEDIUM)

**Location:** spec.md FR-1 AC (last two bullets), spec.md Clarifications ("Attachments appear as labeled name chips…")
**Detail:** The rule that attachments are "chip only, no expansion" in the sent message thread appears in both FR-1's acceptance criteria and the Clarifications section. This is intentional (Clarifications records the Q&A that led to the decision, and FR-1 codifies it), but readers may wonder if they're slightly different rules.

**Recommendation:** No action required. This is acceptable redundancy inherent to the Q&A clarification format.

---

### I3 — External file absolute path exposure in JSONL logs (MEDIUM)

**Location:** data-model.md § Attachment (`path` field), spec.md FR-2
**Detail:** data-model.md stores external file `path` as "original absolute file path at attach time" (e.g., `/Users/alice/Desktop/data.csv`). This is logged to the JSONL conversation file. While the `display_name` field ensures only the filename is shown in the UI, the absolute path is persisted. This is a minor privacy consideration — if conversation logs are shared or synced, absolute paths reveal filesystem structure.

**Recommendation:** Document this as a known behavior in data-model.md with a note: "External file absolute paths are stored in JSONL for traceability. Only the filename (`display_name`) is displayed in the UI. Users sharing JSONL logs should be aware that absolute paths are included."

---

### A1 — `fetch_webpage` User-Agent string minor ambiguity (LOW)

**Location:** spec.md FR-7, plan.md § Architecture Decisions
**Detail:** spec.md says "neutral `Notor/1.0` User-Agent header" — this is reasonably clear that the value is `Notor/1.0`. However, it could be interpreted as requiring a more standard User-Agent format like `Notor/1.0 (Obsidian Plugin)`. Plan.md repeats the same phrasing without further detail.

**Recommendation:** Minor — clarify in spec.md or contracts that the exact `User-Agent` header value is `Notor/1.0` (no additional tokens).

---

### L1 — Task count verified accurate (LOW)

**Location:** tasks.md § Task Summary
**Detail:** "Total Tasks: 42" matches the actual enumerated tasks (4 RES + 1 ENV + 4 FOUND + 6 CTX + 8 ATT + 8 TOOL + 6 HOOK + 5 COMP + 6 TEST + 2 DOC + 1 POLISH + 1 VAL = 42 — note DOC-002 is listed but DOC category has 2 tasks, and POLISH/VAL have 1 each). Count verified as 42.

**Recommendation:** No action needed.

---

### L2 — Turndown quality risk assessment may understate impact (LOW)

**Location:** plan.md § Risk Assessment
**Detail:** The risk "Turndown produces poor quality output for complex pages" is rated Impact: Low, Likelihood: Medium. For users who rely heavily on `fetch_webpage` for research workflows (a primary use case per the user stories), poor conversion quality could significantly reduce the feature's value.

**Recommendation:** Consider updating to Impact: Medium in plan.md, or add a note that content extraction (Readability.js) is a planned future enhancement that would mitigate this risk.

---

## Metrics

- **Functional Requirements:** 13 total, 13 (100%) covered by tasks
- **Non-Functional Requirements:** 4 total, 3.5 (87.5%) fully covered (NFR-2 partial — hook path restrictions)
- **Tasks:** 42 total, 42 (100%) mapped to one or more requirements
- **User Stories:** 18 total, 18 (100%) covered by FRs and tasks
- **User Scenarios:** 14 total (8 primary + 2 alternative + 4 edge cases), 14 (100%) covered
- **Ambiguities:** 1 unresolved (minor — User-Agent string)
- **Duplications:** 1 identified (acceptable — spec AC vs clarification)
- **Cross-Spec Numbering Collisions:** 13 FRs, 4 NFRs, 9 task IDs require renumbering
- **Critical Issues:** 1 (numbering collisions)

---

## Next Actions

**Immediate (Critical):**
1. **N1** — Renumber all FR, NFR, and task IDs in 02-context-intelligence documents to be globally unique across all specs. Apply the renumbering table from finding N1 to: spec.md, plan.md, tasks.md, data-model.md, contracts/tool-schemas.md, checklists/requirements.md.

**Immediate (High):**
2. **I1** — Rename task phases in tasks.md to avoid collision with the spec-level "Phase 3" label. Recommend using "Step" or "Group" prefix.
3. **I2/C3** — Add acceptance criteria to HOOK-002 in tasks.md requiring working directory allow-list enforcement for hook shell commands, per spec.md NFR-2.

**Recommended (Medium):**
4. **C2** — Add explicit AC or subtask in COMP-004 for registering the manual compaction command via `addCommand()`.
5. **U1** — Add clarification to spec.md FR-9 (will become FR-32) for relative working directory resolution semantics.
6. **I3** — Add documentation note to data-model.md about external file absolute path persistence in JSONL logs.

**Optional (Low):**
7. **A1** — Clarify exact User-Agent string value in spec.md or contracts.
8. **L2** — Consider updating Turndown risk impact rating in plan.md.

**Readiness Assessment:**
- One critical issue present (N1 — numbering collisions): all FR, NFR, and task IDs that collide with the prior MVP spec must be renumbered before implementation to prevent cross-phase ambiguity.
- Two high-severity issues should be resolved before implementation begins: the phase naming collision (I1) creates confusion for developers navigating between artifacts, and the missing hook path restriction AC (I2/C3) could result in a security gap if not caught during implementation.
- Medium/low issues can be addressed in parallel with early implementation work.
- Overall the artifacts are well-structured, comprehensive, and ready for implementation after the critical and high-severity items are addressed.
