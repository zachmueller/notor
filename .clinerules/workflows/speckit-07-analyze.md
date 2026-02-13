# Analyze Workflow

Perform a non-destructive cross-artifact consistency and quality analysis across spec.md, plan.md, and tasks.md after task generation.

## Description

This workflow identifies inconsistencies, duplications, ambiguities, and underspecified items across the three core artifacts (spec.md, plan.md, tasks.md) before or after implementation. It provides structured analysis with remediation recommendations.

## Usage

Run this workflow to:

- Validate consistency across specification, plan, and task artifacts
- Identify gaps, duplications, and conflicts between documents
- Generate actionable remediation recommendations
- Validate readiness for implementation or deployment

**Note:** This workflow assumes complete task breakdown exists in tasks.md. Run after `speckit-05-tasks.md` workflow completion.

## Workflow Steps

### Step 1: Prerequisites Validation and Context Loading

Determine the spec directory location and validate required artifacts exist:

**Determine Spec Directory:**

Based on your current branch type (see `.clinerules/workflows/git-branching.md` for branch patterns):

```bash
# Get current branch
BRANCH=$(git branch --show-current)

# Extract spec directory based on branch pattern:
# - src/{library}/{feature} → specs/{library}/{feature}/
# - scripts/{subdir}/{feature} → scripts/{subdir}/specs/{feature}/
# - sci/{workstream-id} → sci/{category}/{workstream-id}/specs/
```

**Verify all required artifacts exist:**

```bash
# Verify required files
test -f "{spec-dir}/spec.md" && echo "Found spec" || echo "ERROR: spec.md not found"
test -f "{spec-dir}/plan.md" && echo "Found plan" || echo "ERROR: plan.md not found"
test -f "{spec-dir}/tasks.md" && echo "Found tasks" || echo "ERROR: tasks.md not found"
```

**Establish {spec-dir} Reference:**
Throughout this workflow, `{spec-dir}` refers to the spec directory determined above based on your branch type. All file operations will use this as the base path.

**Abort Conditions:** If any required file is missing, instruct user to run prerequisite workflows:

- Missing `spec.md` → Run `speckit-01-specify.md` workflow
- Missing `plan.md` → Run `speckit-03-plan.md` workflow
- Missing `tasks.md` → Run `speckit-05-tasks.md` workflow

### Step 2: Load Artifacts with Progressive Disclosure

Load only minimal necessary context from each artifact to maintain efficiency:

**From spec.md - Requirements Context:**

- Overview and feature context
- Functional requirements with acceptance criteria
- Non-functional requirements and constraints
- User stories and scenarios
- Success criteria and validation points
- Edge cases and error conditions

**From plan.md - Technical Context:**

- Architecture and technology stack decisions
- Data model references and entity relationships
- Technical constraints and assumptions
- Phase breakdown and implementation approach
- Integration points and external dependencies

**From tasks.md - Implementation Context:**

- Task IDs and descriptions
- Phase grouping and organization
- Parallel execution markers `[P]`
- Referenced file paths and components
- Acceptance criteria and validation points

### Step 3: Build Semantic Models

Create internal representations for analysis:

**Requirements Inventory:**

- Extract each functional + non-functional requirement with stable key
- Generate slug-based identifiers (e.g., "User can upload file" → `user-can-upload-file`)
- Map acceptance criteria to requirements
- Categorize by priority and complexity

**User Story/Action Inventory:**

- Discrete user actions with acceptance criteria
- Map user scenarios to implementation components
- Identify workflow and interaction patterns

**Task Coverage Mapping:**

- Map each task to one or more requirements or stories
- Use keyword matching and explicit reference patterns
- Identify task-to-requirement relationships
- Flag unmapped tasks and requirements

### Step 4: Detection Analysis Passes

Focus on high-signal findings (limit to 50 findings total):

#### A. Duplication Detection

Identify near-duplicate requirements and redundant specifications:

- Requirements with similar intent but different phrasing
- Duplicate acceptance criteria across different requirements
- Repeated technical specifications in plan and tasks
- Flag lower-quality phrasing for consolidation

#### B. Ambiguity Detection

Flag vague language and unresolved placeholders:

- Vague adjectives: "fast", "scalable", "secure", "intuitive", "robust"
- Unresolved placeholders: TODO, TKTK, ???, `<placeholder>`, `[NEEDS CLARIFICATION]`
- Ambiguous quantifiers: "many", "few", "several", "some"
- Unclear success criteria without objective measures

#### C. Underspecification Detection

Requirements lacking sufficient detail for implementation:

- Requirements with verbs but missing objects or measurable outcomes
- User stories missing acceptance criteria alignment
- Tasks referencing undefined files or components
- Non-functional requirements without quantified targets

#### D. Coverage Gap Analysis

Identify missing mappings between artifacts:

- Requirements with zero associated tasks
- Tasks with no mapped requirement or user story
- User scenarios not covered by task workflows
- Non-functional requirements not reflected in implementation

#### E. Inconsistency Detection

Conflicting information across artifacts:

- Terminology drift (same concept, different names)
- Technical conflicts between plan and tasks
- Task ordering contradictions without dependency justification
- Conflicting requirements preventing implementation

### Step 5: Severity Assignment

Use systematic heuristic for finding prioritization:

**CRITICAL Severity:**

- Missing core specification artifacts
- Requirements with zero coverage blocking functionality
- Conflicting requirements preventing implementation

**HIGH Severity:**

- Duplicate or conflicting requirements affecting implementation
- Ambiguous security/performance attributes
- Untestable acceptance criteria
- Major terminology drift causing confusion

**MEDIUM Severity:**

- Minor terminology drift not affecting implementation
- Missing non-functional task coverage
- Underspecified edge cases with workarounds
- Documentation gaps not blocking implementation

**LOW Severity:**

- Style/wording improvements without functional impact
- Minor redundancy not affecting execution
- Optional optimization opportunities

### Step 6: Generate Analysis Report

Produce comprehensive analysis report:

```markdown
# Cross-Artifact Analysis Report

**Generated:** [TIMESTAMP]
**Feature:** [FEATURE NAME]
**Branch:** [BRANCH NAME]
**Artifacts:** spec.md, plan.md, tasks.md

## Executive Summary
- **Total Findings:** [N] (Critical: X, High: Y, Medium: Z, Low: W)
- **Coverage:** [X]% requirements mapped to tasks
- **Readiness:** [READY/NEEDS ATTENTION/BLOCKED]

## Findings Summary

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A1 | Duplication | HIGH | spec.md:L120-134 | Similar requirements | Merge; keep clearer version |
| C1 | Coverage | CRITICAL | spec.md:FR-5 | No implementation tasks | Add tasks in Phase 3 |
| I1 | Inconsistency | MEDIUM | Multiple | Naming conflicts | Standardize terminology |

## Coverage Analysis

| Requirement | Tasks | Status | Notes |
|-------------|-------|--------|-------|
| user-auth | SEC-001, SEC-002 | ✓ Complete | Good coverage |
| data-validation | DATA-001, TEST-001 | ✓ Adequate | |
| performance | ✗ None | ✗ Missing | **Needs tasks** |

## Metrics
- **Requirements:** [N] total, [X]% covered by tasks
- **Tasks:** [N] total, [Y]% mapped to requirements
- **Ambiguities:** [N] unresolved
- **Duplications:** [N] consolidation opportunities
- **Critical Issues:** [N] blocking implementation

## Next Actions

**Immediate (Critical/High):**
1. [Specific action with file reference]
2. [Another critical action]

**Recommended (Medium/Low):**
1. [Improvement suggestion]
2. [Enhancement opportunity]

**Readiness Assessment:**
- Critical issues present: Must resolve before implementation
- High issues only: Recommended to resolve, can proceed with caution
- Medium/Low only: Safe to proceed, address in parallel
- No issues: Ready for immediate implementation
```

### Step 7: Remediation Recommendations

Provide actionable guidance:

**Issue-Specific Remediation:**

- Root cause analysis for each major finding
- Step-by-step resolution guidance
- Validation methods to verify fixes
- Impact assessment if not addressed

**Process Improvements:**

- Workflow modifications to prevent similar issues
- Quality gate enhancements
- Template improvements for future features

**Ask for Remediation Permission:** "Would you like me to suggest concrete remediation edits for the top [N] issues?"

### Step 8: Final Validation and Next Steps

Complete analysis with clear guidance:

**Analysis Quality Check:**

- All artifacts reviewed systematically
- Findings prioritized by impact
- Recommendations are actionable
- Cross-references accurate

**Next Steps Guidance:**

Follow the commit standards defined in `.clinerules/git.md` to commit any fixes or updates made based on the analysis findings.

## Quality Guidelines

### Analysis Effectiveness

**Focus Areas:**

- High-impact findings over exhaustive documentation
- Actionable issues over theoretical concerns
- Implementation readiness over perfection

**Communication Standards:**

- Use specific artifact references (files, sections, line numbers)
- Provide concrete examples rather than abstract descriptions
- Link findings to remediation actions
- Balance thoroughness with clarity

### Token Efficiency

**Progressive Disclosure:**

- Load minimal context for analysis
- Focus on cross-references and conflicts
- Summarize rather than duplicate content
- Prioritize findings by severity and impact

## Dependencies

- Completed specification (`speckit-01-specify.md` workflow)
- Implementation plan (`speckit-03-plan.md` workflow)
- Task breakdown (`speckit-05-tasks.md` workflow)

## Outputs

- Cross-artifact analysis report
- Findings table with severity and recommendations
- Coverage analysis matrix
- Remediation guidance and next steps

## Next Steps

After running this workflow:

- Address critical and high-severity findings
- Update artifacts based on recommendations
- Re-run analysis to validate fixes
- Proceed to implementation with confidence
- Use lessons learned to improve future workflows