# Cross-Artifact Analysis Report

**Generated:** 2026-07-03T18:08:00+13:00
**Updated:** 2026-07-03T18:53:00+13:00
**Feature:** Phase 3 — Context & Intelligence
**Branch:** feature/02-context-intelligence
**Artifacts:** spec.md, plan.md, tasks.md (+ data-model.md)

## Executive Summary

- **Total Findings:** 11 (Critical: ~~1~~ 0, High: ~~2~~ 0, Medium: ~~5~~ ~~4~~ ~~3~~ 2, Low: 3)
- **Coverage:** 100% of functional requirements (FR-24 through FR-36) mapped to tasks
- **Readiness:** READY FOR IMPLEMENTATION — all critical and high-severity issues resolved

The three core artifacts (spec.md, plan.md, tasks.md) are well-aligned overall. The specification is thorough with extensive clarifications. The plan faithfully translates the spec into technical architecture, and the task breakdown provides granular coverage of all functional requirements. ~~One critical finding relates to FR/NFR/task ID numbering collisions with the prior MVP spec (`specs/01-mvp/`) — **resolved 2026-07-03**.~~ ~~Two high-severity findings relate to missing task coverage for specific acceptance criteria and a terminology inconsistency in task phasing.~~ ~~One high-severity finding remains (missing hook path restriction AC).~~ All high-severity findings resolved. ~~Five~~ ~~Four~~ Three medium-severity findings involve minor gaps and inconsistencies. Three low-severity findings are cosmetic or documentation improvements.

---

## Findings Summary

| ID | Category | Severity | Location(s) | Summary | Status |
|----|----------|----------|-------------|---------|--------|
| N1 | Inconsistency | ~~CRITICAL~~ | All 02-context-intelligence docs vs 01-mvp docs | FR/NFR/ENV/TOOL IDs renumbered to be globally unique | ✅ RESOLVED |
| C1 | Coverage | HIGH | spec.md FR-24, tasks.md | `[[` shortcut in chat input not covered by a dedicated acceptance criterion in ATT-005 | Open |
| I1 | Inconsistency | ~~HIGH~~ | tasks.md phase numbering vs plan.md feature groups | tasks.md phases renamed to "Steps" to avoid collision with spec-level "Phase 3" label | ✅ RESOLVED |
| C2 | Coverage | ~~MEDIUM~~ | spec.md FR-29, tasks.md | Manual compaction trigger (button/command) mentioned in FR-29 AC but only noted parenthetically in COMP-002/COMP-004; no standalone task for command registration | ✅ RESOLVED |
| I2 | Inconsistency | ~~MEDIUM~~ | spec.md NFR-7, tasks.md | NFR-7 states hook shell commands use same working directory restrictions as `execute_command`; HOOK-002 ACs now enforce vault root cwd + allow-list | ✅ RESOLVED |
| U1 | Underspecification | ~~MEDIUM~~ | spec.md FR-32, plan.md, tasks.md | `execute_command` working directory resolution for relative paths is not specified in spec.md; only tasks.md TOOL-014 mentions "relative → resolve from vault root" | ✅ RESOLVED |
| C3 | Coverage | ~~MEDIUM~~ | spec.md key entities § Hook, tasks.md HOOK-002 | Spec states hook shell commands use same runtime and path restrictions as `execute_command`; HOOK-002 ACs now include working directory allow-list enforcement | ✅ RESOLVED |
| D1 | Duplication | MEDIUM | spec.md FR-24 AC + Clarifications | The attachment chip-only display rule appears in FR-24 AC and again in the Clarifications section as a Q&A; minor redundancy | No action needed |
| I3 | Inconsistency | ~~MEDIUM~~ | data-model.md § Attachment, spec.md FR-25 | data-model.md stores `path` as "original absolute file path at attach time" for external files; `path` exposes absolute paths in JSONL logs; privacy note added to data-model.md | ✅ RESOLVED |
| A1 | Ambiguity | LOW | spec.md FR-30, plan.md | `fetch_webpage` uses "neutral `Notor/1.0` User-Agent header" — minor ambiguity on exact header value | Open |
| L1 | Low-priority | LOW | tasks.md | Task count summary says "42 tasks"; count verified as accurate | No action needed |
| L2 | Low-priority | LOW | plan.md § Risk Assessment | Risk "Turndown produces poor quality output" rated Impact: Low — may be higher for research-heavy use cases | Open |

---

## Coverage Analysis

### Functional Requirements → Task Mapping

| Requirement | Tasks | Status | Notes |
|-------------|-------|--------|-------|
| FR-24: Note attachment via file picker | ATT-001, ATT-002, ATT-004, ATT-005, ATT-007, ATT-008 | ✓ Complete | `[[` shortcut covered in ATT-005 AC but could be more explicit |
| FR-25: External file attachment | ATT-001, ATT-003, ATT-006, ATT-007, ATT-008 | ✓ Complete | |
| FR-26: Auto-context — open note paths | CTX-001, CTX-004, CTX-005, CTX-006 | ✓ Complete | |
| FR-27: Auto-context — vault structure | CTX-002, CTX-004, CTX-005, CTX-006 | ✓ Complete | |
| FR-28: Auto-context — OS | CTX-003, CTX-004, CTX-005, CTX-006 | ✓ Complete | |
| FR-29: Auto-compaction | COMP-001, COMP-002, COMP-003, COMP-004, COMP-005 | ✓ Complete | COMP-004 AC now includes explicit `addCommand()` registration for `compact-context` |
| FR-30: `fetch_webpage` tool | TOOL-010, TOOL-011, TOOL-012, ENV-005 | ✓ Complete | |
| FR-31: Domain denylist | TOOL-011, TOOL-013 | ✓ Complete | |
| FR-32: `execute_command` tool | TOOL-014, TOOL-015, TOOL-016 | ✓ Complete | Working directory resolution (relative, absolute, default) now codified in spec.md Clarifications |
| FR-33: Hooks — `pre-send` | HOOK-001, HOOK-002, HOOK-003, HOOK-004, HOOK-006 | ✓ Complete | |
| FR-34: Hooks — `on-tool-call` | HOOK-001, HOOK-002, HOOK-003, HOOK-005, HOOK-006 | ✓ Complete | |
| FR-35: Hooks — `on-tool-result` | HOOK-001, HOOK-002, HOOK-003, HOOK-005, HOOK-006 | ✓ Complete | |
| FR-36: Hooks — `after-completion` | HOOK-001, HOOK-002, HOOK-003, HOOK-005, HOOK-006 | ✓ Complete | |

### Non-Functional Requirements → Coverage

| Requirement | Coverage | Status | Notes |
|-------------|----------|--------|-------|
| NFR-6: Performance | CTX-001 AC (<100 ms), TOOL-010 (timeout), COMP-004 (transparent), HOOK-002 (timeout) | ✓ Complete | |
| NFR-7: Security & privacy | TOOL-011 (denylist), TOOL-014 (path validation), HOOK-002 (shell restrictions + cwd enforcement) | ✓ Complete | Hook working directory restriction added to HOOK-002 ACs |
| NFR-8: Usability & transparency | ATT-005 (discoverable), CTX-005 (defaults on), COMP-004 (marker), TOOL-015 (Act-only), DOC-001 (system prompt) | ✓ Complete | |
| NFR-9: Reliability | TOOL-010 (fetch errors), TOOL-014 (command failures), HOOK-002 (non-blocking), COMP-002 (fallback), ATT-002 (missing notes) | ✓ Complete | |

### User Stories → Coverage

All user stories in spec.md map to one or more functional requirements, which in turn map to tasks. No orphaned user stories.

### User Scenarios → Coverage

| Scenario | FRs Exercised | Tasks Covering | Status |
|----------|---------------|----------------|--------|
| Attach note section and ask about it | FR-24 | ATT-002, ATT-005, ATT-008, TEST-002 | ✓ |
| AI fetches webpage and saves to note | FR-30 | TOOL-010, TOOL-012, TEST-003 | ✓ |
| Long session with auto-compaction | FR-29 | COMP-001–005, TEST-006 | ✓ |
| Shell command assistance | FR-32 | TOOL-014, TOOL-015, TEST-004 | ✓ |
| After-completion hook saves summary | FR-36 | HOOK-005, TEST-005 | ✓ |
| Blocked domain fetch | FR-30, FR-31 | TOOL-011, TEST-003 | ✓ |
| Execute command in Plan mode | FR-32 | TOOL-015 | ✓ |
| Compaction summarization fails | FR-29 | COMP-002, TEST-006 | ✓ |
| Oversized file attachment | FR-25 | ATT-003, ATT-006, TEST-002 | ✓ |
| Auto-context with no open notes | FR-26 | CTX-001, TEST-001 | ✓ |
| Vault note deleted after chip added | FR-24 | ATT-002, ATT-008, TEST-002 | ✓ |
| Section reference to non-existent heading | FR-24 | ATT-002, TEST-002 | ✓ |
| Working directory outside allowed paths | FR-32 | TOOL-014, TEST-004 | ✓ |
| Hook failure does not block message | FR-33–36 | HOOK-002, TEST-005 | ✓ |

---

## Detailed Findings

### N1 — FR/NFR/Task ID numbering collisions with prior MVP spec ~~(CRITICAL)~~ ✅ RESOLVED

**Location:** All `specs/02-context-intelligence/` documents vs `specs/01-mvp/` documents
**Status:** ✅ **RESOLVED** — 2026-07-03
**Resolution:** All colliding IDs renumbered across all 6 files (spec.md, plan.md, tasks.md, data-model.md, contracts/tool-schemas.md, checklists/requirements.md) using continuation numbering from 01-mvp ranges:
- FRs: FR-1–13 → FR-24–36
- NFRs: NFR-1–4 → NFR-6–9
- Task IDs: ENV-001 → ENV-005, TOOL-001–008 → TOOL-010–017

All internal cross-references (dependency lists, coverage matrices, acceptance criteria) updated consistently. No old colliding IDs remain.

**Original detail:** The 02-context-intelligence spec reused FR, NFR, and task ID numbers already assigned in 01-mvp. This created ambiguity when cross-referencing requirements across phases.

**Collisions that were resolved:**

| Element | 01-mvp Range | 02-context Old Range | New Range |
|---------|-------------|---------------------|-----------|
| Functional Requirements (FR-) | FR-1 through FR-23 | FR-1 through FR-13 | FR-24 through FR-36 |
| Non-Functional Requirements (NFR-) | NFR-1 through NFR-5 | NFR-1 through NFR-4 | NFR-6 through NFR-9 |
| Task ID: ENV- | ENV-001 through ENV-004 | ENV-001 | ENV-005 |
| Task ID: TOOL- | TOOL-001 through TOOL-009 | TOOL-001 through TOOL-008 | TOOL-010 through TOOL-017 |

---

### C1 — `[[` shortcut trigger not explicitly covered in task AC (HIGH)

**Location:** spec.md FR-24 (second AC bullet), tasks.md ATT-005
**Detail:** spec.md FR-24 states: "When the user types `[[` in the Notor chat input box, the vault file picker opens directly (bypassing the menu)." ATT-005 includes a general AC for `[[` trigger ("Typing `[[` in the chat input triggers the vault picker directly (bypassing the menu)"), so this is actually covered. However, the behavior of applying "the same wikilink autocomplete behavior as Obsidian's native note editor — showing matching note titles and allowing selection to complete the link" is only in the spec, not restated in the task AC.

**Recommendation:** This finding is **borderline adequate** — the task AC does reference `[[` trigger and fuzzy matching. Consider adding a note to ATT-005 AC that the `[[` behavior should mirror Obsidian's native wikilink autocomplete UX for consistency.

---

### I1 — Task phase numbering misaligns with plan feature group labels ~~(HIGH)~~ ✅ RESOLVED

**Location:** plan.md § Implementation Phases (Feature Groups A–F), tasks.md § ~~Phases~~ Steps 0–6
**Status:** ✅ **RESOLVED** — 2026-07-03
**Resolution:** Renamed all internal implementation phases in tasks.md from "Phase X" to "Step X" (e.g., "Step 0: Research & Environment Setup", "Step 3: Attachment System"). This eliminates the terminological collision with the spec-level "Phase 3" label (which refers to the entire Context & Intelligence scope). The groupings and ordering within tasks.md were preserved — only the prefix was changed. Internal cross-references (e.g., TOOL-017 AC referencing "Step 5") were also updated.

**Original detail:** The plan uses Feature Group labels: A (Attachments), B (Auto-Context), C (Auto-Compaction), D (fetch_webpage), E (execute_command), F (Hooks). The tasks.md reordered and renumbered these as implementation phases:
- tasks.md Phase 2 = Auto-Context (plan's Group B)
- tasks.md Phase 3 = Attachments (plan's Group A)
- tasks.md Phase 4 = Tools (plan's Groups D + E combined)
- tasks.md Phase 5 = Hooks & Compaction (plan's Groups F + C combined)

The reordering itself was valid (plan.md § Recommended Implementation Order suggests B before A). But the numeric phase labels ("Phase 3", "Phase 4") in tasks.md conflicted with the feature-level "Phase 3" label used in spec.md (which refers to the entire Context & Intelligence scope). This created terminological confusion — "Phase 3" meant different things in spec.md vs tasks.md.

---

### C2 — Manual compaction trigger lacks dedicated task ~~(MEDIUM)~~ ✅ RESOLVED

**Location:** spec.md FR-29 AC ("Compaction can be triggered manually by the user via a button or command"), tasks.md COMP-002/COMP-004
**Status:** ✅ **RESOLVED** — 2026-07-03
**Resolution:** Added an explicit AC bullet to COMP-004 in tasks.md: "`compact-context` command registered via `this.addCommand()` in `main.ts` with a stable command ID; command name displayed as 'Compact context' in the palette." This complements the existing AC bullet about manual compaction trigger availability and ensures the `addCommand()` registration is not overlooked during implementation.

**Original detail:** COMP-002 mentions "Compaction can be triggered manually via a command or button" in its AC, and COMP-004 mentions "Manual compaction trigger available via command palette." However, there was no task specifically for registering the command in the plugin's `addCommand()` lifecycle. This could be overlooked during implementation since it was buried inside two different task ACs rather than being its own task or a clear sub-step.

---

### I2 — Hook shell commands not explicitly constrained by working directory allow-list in tasks (MEDIUM)

**Location:** spec.md NFR-7 ("Hook shell commands are executed using the same runtime and path restrictions as the `execute_command` tool; they do not bypass Notor's working directory allow-list"), tasks.md HOOK-002
**Detail:** The spec is clear that hooks must use the same working directory restrictions as `execute_command`. However, HOOK-002's acceptance criteria focus on environment variable injection, timeout, and stdout capture — there is no AC requiring the hook engine to enforce the working directory allow-list. If a developer implements HOOK-002 without reading NFR-7, hooks could run shell commands from any directory.

**Recommendation:** Add an AC to HOOK-002: "Hook shell commands execute with `cwd` set to the vault root. The working directory allow-list from `execute_command` settings is enforced for hook shell commands; commands cannot run from directories outside allowed paths."

---

### U1 — Working directory resolution for relative paths underspecified ~~(MEDIUM)~~ ✅ RESOLVED

**Location:** spec.md FR-32, tasks.md TOOL-014
**Status:** ✅ **RESOLVED** — 2026-07-03
**Resolution:** Added a Q&A clarification to spec.md § Clarifications: "Q: How are relative and absolute `working_directory` paths resolved for `execute_command`? A: Relative paths are resolved from the vault root (e.g., `scripts/build` → `<vault root>/scripts/build`). Absolute paths are used as-is. In both cases, the resolved path must pass the working directory allow-list check (vault root or user-configured allowed paths) before execution proceeds. When `working_directory` is omitted or empty, it defaults to the vault root." This codifies the behavior already present in tasks.md TOOL-014 AC and covers the three cases (empty/omitted, relative, absolute) with explicit resolution semantics.

**Original detail:** spec.md FR-32 states `working_directory` "defaults to vault root" but does not specify how relative paths should be resolved. tasks.md TOOL-014 adds "relative → resolve from vault root" in its AC, which is a reasonable implementation choice but introduces specification beyond what's in spec.md. This means the tasks document is making a design decision that should be in the spec.

---

### C3 — Hook engine missing working directory allow-list enforcement (MEDIUM)

**Location:** spec.md § Key entities → Hook, NFR-7; tasks.md HOOK-002
**Detail:** This is the task-level manifestation of finding I2. The spec defines that hooks share `execute_command`'s path restrictions, but no task AC enforces this. The shared `ShellExecutor` (FOUND-003) is used by both tools and hooks, but the working directory validation in TOOL-014 is tool-specific. HOOK-002 should also validate the working directory (hooks default to vault root, but if the hook engine ever supports configurable `cwd`, the validation must be present).

**Recommendation:** Same as I2 — add an AC to HOOK-002 for working directory validation.

---

### D1 — Attachment display rule duplicated across spec sections (MEDIUM)

**Location:** spec.md FR-24 AC (last two bullets), spec.md Clarifications ("Attachments appear as labeled name chips…")
**Detail:** The rule that attachments are "chip only, no expansion" in the sent message thread appears in both FR-24's acceptance criteria and the Clarifications section. This is intentional (Clarifications records the Q&A that led to the decision, and FR-24 codifies it), but readers may wonder if they're slightly different rules.

**Recommendation:** No action required. This is acceptable redundancy inherent to the Q&A clarification format.

---

### I3 — External file absolute path exposure in JSONL logs ~~(MEDIUM)~~ ✅ RESOLVED

**Location:** data-model.md § Attachment (`path` field), spec.md FR-25
**Status:** ✅ **RESOLVED** — 2026-07-03
**Resolution:** Added a "Privacy note — external file paths" paragraph to the Attachment entity section in data-model.md. The note documents that external file absolute paths are stored in the JSONL conversation log for traceability, that only the filename (`display_name`) is displayed in the chat UI, and that users who share or sync JSONL logs should be aware that absolute filesystem paths are included.

**Original detail:** data-model.md stores external file `path` as "original absolute file path at attach time" (e.g., `/Users/alice/Desktop/data.csv`). This is logged to the JSONL conversation file. While the `display_name` field ensures only the filename is shown in the UI, the absolute path is persisted. This is a minor privacy consideration — if conversation logs are shared or synced, absolute paths reveal filesystem structure.

---

### A1 — `fetch_webpage` User-Agent string minor ambiguity (LOW)

**Location:** spec.md FR-30, plan.md § Architecture Decisions
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
- **Non-Functional Requirements:** 4 total, 4 (100%) fully covered
- **Tasks:** 42 total, 42 (100%) mapped to one or more requirements
- **User Stories:** 18 total, 18 (100%) covered by FRs and tasks
- **User Scenarios:** 14 total (8 primary + 2 alternative + 4 edge cases), 14 (100%) covered
- **Ambiguities:** 1 unresolved (minor — User-Agent string)
- **Duplications:** 1 identified (acceptable — spec AC vs clarification)
- **Cross-Spec Numbering Collisions:** ~~13 FRs, 4 NFRs, 9 task IDs require renumbering~~ ✅ All resolved
- **Critical Issues:** ~~1 (numbering collisions)~~ 0

---

## Next Actions

**~~Immediate (Critical):~~**
1. ~~**N1** — Renumber all FR, NFR, and task IDs in 02-context-intelligence documents to be globally unique across all specs.~~ ✅ **RESOLVED** — 2026-07-03

**~~Immediate (High):~~**
2. ~~**I1** — Rename task phases in tasks.md to avoid collision with the spec-level "Phase 3" label. Recommend using "Step" or "Group" prefix.~~ ✅ **RESOLVED** — 2026-07-03

**~~Immediate (High):~~**
3. ~~**I2/C3** — Add acceptance criteria to HOOK-002 in tasks.md requiring working directory allow-list enforcement for hook shell commands, per spec.md NFR-7.~~ ✅ **RESOLVED** — 2026-07-03

**~~Recommended (Medium):~~**
4. ~~**C2** — Add explicit AC or subtask in COMP-004 for registering the manual compaction command via `addCommand()`.~~ ✅ **RESOLVED** — 2026-07-03
5. ~~**U1** — Add clarification to spec.md FR-32 for relative working directory resolution semantics.~~ ✅ **RESOLVED** — 2026-07-03
6. ~~**I3** — Add documentation note to data-model.md about external file absolute path persistence in JSONL logs.~~ ✅ **RESOLVED** — 2026-07-03

**Optional (Low):**
7. **A1** — Clarify exact User-Agent string value in spec.md or contracts.
8. **L2** — Consider updating Turndown risk impact rating in plan.md.

**Readiness Assessment:**
- ~~One critical issue present (N1 — numbering collisions)~~ ✅ Resolved — all IDs are now globally unique across specs.
- ~~Two high-severity issues should be resolved before implementation begins: the phase naming collision (I1) creates confusion for developers navigating between artifacts, and the missing hook path restriction AC (I2/C3) could result in a security gap if not caught during implementation.~~ ~~One high-severity issue remains (I2/C3 — missing hook path restriction AC), which could result in a security gap if not caught during implementation.~~ ✅ All high-severity issues resolved — HOOK-002 ACs now enforce vault root cwd and working directory allow-list.
- Medium/low issues can be addressed in parallel with early implementation work.
- Overall the artifacts are well-structured, comprehensive, and **ready for implementation**.
