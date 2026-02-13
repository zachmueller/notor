# Plan Workflow

Execute the implementation planning workflow using the plan template to generate design artifacts.

## Description

This workflow creates comprehensive implementation plans from feature specifications. It handles technical architecture decisions, data modeling, API contract generation, and creates the foundation for task breakdown and implementation.

## Usage

Run this workflow to:

- Generate technical implementation plans from specifications
- Create data models and API contracts
- Set up research and design artifacts
- Prepare for task breakdown and implementation

## Workflow Steps

### Step 1: Setup and Validation

Determine the spec directory location and validate prerequisites:

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

**Verify required files exist:**

```bash
# Verify spec.md exists
test -f "{spec-dir}/spec.md" && echo "Found spec" || echo "ERROR: spec.md not found"

# Check for existing plan
test -f "{spec-dir}/plan.md" && echo "Plan exists" || echo "Plan will be created"
```

**Establish {spec-dir} Reference:**
Throughout this workflow, `{spec-dir}` refers to the spec directory determined above based on your branch type. All file operations will use this as the base path.

Validate that specification is complete and ready for planning.

### Step 2: Load Implementation Plan Template

Create or load the implementation plan template structure:

```markdown
# Implementation Plan: [FEATURE NAME]

**Created:** [DATE]
**Specification:** [Link to spec.md]
**Status:** Planning

## Technical Context

### Architecture Decisions
- **Frontend Framework:** [NEEDS CLARIFICATION: React/Vue/Angular/Vanilla]
- **Backend Technology:** [NEEDS CLARIFICATION: Node.js/Python/Java/etc]
- **Database:** [NEEDS CLARIFICATION: PostgreSQL/MySQL/MongoDB/etc]
- **Hosting/Deployment:** [NEEDS CLARIFICATION: Cloud provider and services]
- **Authentication:** [NEEDS CLARIFICATION: Strategy and implementation]

### Technology Stack Rationale
For each technology choice, document:
- **Decision:** What was chosen
- **Rationale:** Why it was chosen
- **Alternatives Considered:** What else was evaluated
- **Trade-offs:** Pros and cons of the decision

### Integration Points
- External services and APIs
- Third-party libraries and dependencies
- Platform-specific considerations
- Security and compliance requirements

## Phase 0: Research & Architecture

### Technology Research Tasks
For each NEEDS CLARIFICATION item above:
- **Research Task:** [Description]
- **Questions to Answer:** [Specific information needed]
- **Success Criteria:** [How to evaluate options]
- **Deadline:** [When decision needed]

### Architecture Investigation
- **Performance Requirements:** [Investigate scaling and performance needs]
- **Security Analysis:** [Research security patterns and requirements]
- **Integration Patterns:** [Evaluate API design and data flow]
- **Deployment Strategy:** [Research hosting and deployment options]

### Research Deliverables
- `research.md` - Consolidated research findings with decisions and rationale
- Technology choice documentation with alternatives considered
- Architecture decision records (ADRs) for major choices

## Phase 1: Design & Contracts

**Prerequisites:** `research.md` complete with all NEEDS CLARIFICATION resolved

### Data Model Design
Extract entities from feature specification and design data layer:

**Entity Analysis:**
- Review functional requirements for data entities
- Identify relationships between entities
- Define validation rules and constraints
- Model state transitions and lifecycle

**Data Model Deliverables:**
- `data-model.md` - Entity definitions, relationships, validation rules
- Database schema design (tables, indexes, constraints)
- State transition diagrams where applicable
- Data validation and business rules

### API Contract Generation
Generate API specifications from functional requirements:

**Contract Design Process:**
1. **Extract User Actions:** Each functional requirement → potential endpoint
2. **Apply REST/GraphQL Patterns:** Standard patterns for CRUD operations
3. **Define Request/Response:** Data formats and validation rules
4. **Error Handling:** Standard error codes and messages
5. **Authentication/Authorization:** Security requirements per endpoint

**Contract Deliverables:**
- `contracts/` directory with API specifications
- OpenAPI/Swagger documentation (REST APIs)
- GraphQL schema definitions (GraphQL APIs)
- Authentication and authorization specifications
- Error handling and status code documentation

### Development Environment Setup
- `quickstart.md` - Developer onboarding and setup instructions
- Development environment configuration
- Build and deployment scripts
- Testing framework setup
- CI/CD pipeline configuration

## Implementation Readiness Validation

### Technical Completeness Check
- [ ] All technology choices made and documented
- [ ] Data model covers all functional requirements
- [ ] API contracts support all user scenarios
- [ ] Security requirements addressed
- [ ] Performance considerations documented
- [ ] Integration points defined
- [ ] Development environment specified

### Quality Validation
- [ ] Architecture supports scalability requirements
- [ ] Security model matches threat analysis
- [ ] Data model supports all business rules
- [ ] API design follows established patterns
- [ ] Documentation covers all major decisions

## Risk Assessment

### Technical Risks
- **High Risk:** [Critical technical challenges]
- **Medium Risk:** [Moderate technical concerns]
- **Low Risk:** [Minor technical considerations]

### Mitigation Strategies
For each identified risk:
- **Risk:** [Description]
- **Impact:** [Consequences if occurs]
- **Likelihood:** [Probability of occurrence]
- **Mitigation:** [Prevention and response strategies]
- **Contingency:** [Alternative approaches if needed]

### Dependencies and Assumptions
- **External Dependencies:** [Third-party services, libraries, team dependencies]
- **Technical Assumptions:** [Environment, performance, security assumptions]
- **Business Assumptions:** [User behavior, usage patterns, business rules]

## Next Phase Preparation

### Task Breakdown Readiness
Ensure plan provides sufficient detail for task generation:
- [ ] Clear technology choices and architecture
- [ ] Complete data model and API specifications
- [ ] Development environment and tooling defined
- [ ] Quality standards and testing approach specified
- [ ] Integration requirements and dependencies clear

### Implementation Prerequisites
- [ ] All research completed and documented
- [ ] Technical architecture validated
- [ ] Development environment requirements specified
- [ ] Third-party integrations planned
- [ ] Quality assurance approach defined
```

### Step 3: Fill Technical Context

Analyze the specification and fill in technical decisions:

**Architecture Analysis:**

1. **Extract Technical Requirements:** Review spec for technology hints and constraints
2. **Assess Complexity:** Determine appropriate architecture scale
3. **Identify Integration Needs:** External services, APIs, data sources
4. **Security Requirements:** Authentication, authorization, data protection
5. **Performance Needs:** Scalability, response time, throughput requirements

**Decision Process:**

- Make informed technology choices based on requirements
- Document rationale for each major decision
- Consider team skills, project constraints, and maintenance
- Mark genuinely ambiguous choices as NEEDS CLARIFICATION

### Step 4: Phase 0 - Research Tasks

Generate research tasks for unresolved technical decisions:

**Research Generation:**

- For each NEEDS CLARIFICATION → create research task
- For each major technology choice → create best practices task
- For each integration → create patterns research task
- For each security requirement → create security analysis task

**Research Coordination:**

```markdown
# Research Plan

## Technology Decisions Needed
1. **[Technology Area]**
   - **Question:** [What needs to be decided]
   - **Options:** [Alternatives to evaluate]
   - **Criteria:** [How to choose between options]
   - **Timeline:** [When decision is needed]

2. **[Integration Pattern]**
   - **Question:** [Integration approach needed]
   - **Research Areas:** [What to investigate]
   - **Success Criteria:** [How to evaluate approaches]
   - **Dependencies:** [What this decision affects]
```

**Create Research File:** Generate `research.md` in the spec directory with consolidated research plan and findings template.

### Step 5: Phase 1 - Design Artifacts

**Prerequisites:** All research completed and NEEDS CLARIFICATION resolved

**Data Model Generation:**

1. **Entity Extraction:** Scan functional requirements for nouns and data objects
2. **Relationship Mapping:** Identify connections between entities
3. **Validation Rules:** Extract business rules from acceptance criteria
4. **State Modeling:** Identify entity lifecycles and state transitions

**API Contract Creation:**

1. **Endpoint Design:** Map each user action to API operations
2. **Request/Response Modeling:** Define data formats and validation
3. **Error Handling:** Standard error responses and codes
4. **Security Integration:** Authentication and authorization per endpoint

**Environment Setup:**

1. **Quickstart Guide:** Developer onboarding instructions
2. **Build Configuration:** Development and deployment setup
3. **Testing Framework:** Unit, integration, and e2e testing setup
4. **CI/CD Pipeline:** Automated build, test, and deployment

### Step 6: Validation and Finalization

Perform comprehensive validation before completion:

**Technical Validation:**

- All technology choices documented with rationale
- Data model supports all functional requirements
- API contracts cover all user scenarios
- Security architecture addresses all requirements
- Performance considerations documented
- Integration points clearly defined

**Quality Validation:**

- Architecture supports scalability needs
- Security model matches threat analysis
- Documentation complete and consistent
- Best practices followed throughout

### Step 7: Plan Completion and Handoff

Finalize implementation plan and prepare for task breakdown:

**Commit Changes:**

Follow the commit standards defined in `.clinerules/git.md` to commit all planning artifacts including plan.md, research.md, data-model.md, contracts/, and quickstart.md files.

**Completion Report:**

- Branch name and plan file path
- Generated artifacts summary
- Readiness for task breakdown (`speckit-05-tasks.md` workflow)
- Any remaining dependencies or assumptions

## Quality Guidelines

### Architecture Decision Documentation

Each major technical decision should include:

1. **Context:** What situation led to this decision
2. **Options:** Alternatives that were considered
3. **Decision:** What was chosen and why
4. **Consequences:** Expected positive and negative outcomes
5. **Reversibility:** How difficult it would be to change this decision

### Data Model Best Practices

- **Normalize appropriately:** Balance normalization vs. performance
- **Plan for scale:** Consider future growth and performance needs
- **Validate early:** Ensure model supports all business rules
- **Document assumptions:** Make implicit rules explicit
- **Consider privacy:** Address data protection and compliance needs

### API Design Principles

- **RESTful patterns:** Follow standard REST conventions where applicable
- **Consistent naming:** Use clear, consistent naming throughout
- **Version planning:** Design for API evolution and backward compatibility
- **Security first:** Integrate security into API design, not as afterthought
- **Error handling:** Provide clear, actionable error messages

## Dependencies

- Completed and validated specification (`speckit-01-specify.md` and `speckit-02-clarify.md` workflows)
- Optional: Existing architecture documentation or standards

## Outputs

- `plan.md` in spec directory - Complete implementation plan
- `research.md` in spec directory - Technology research and decisions
- `data-model.md` in spec directory - Data model and entity design
- `contracts/` in spec directory - API specifications and contracts
- `quickstart.md` in spec directory - Development setup guide

## Next Steps

After running this workflow:

- Run `speckit-05-tasks.md` workflow to break down implementation into specific tasks
- Set up development environment using quickstart guide
- Begin implementation following the documented architecture