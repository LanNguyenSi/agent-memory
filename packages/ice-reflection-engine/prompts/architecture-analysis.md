# Prompt: Architecture Analysis

You are working on `ice-reflection-engine`.

## Objective

Validate and refine the recommended architecture for this project.
Use a spec/context/eval lens:

- spec: check that the architecture matches the intended scope and constraints
- context: use the project domain, integrations, security posture, and operating assumptions directly
- eval: call out the evidence and checks needed to validate the recommendation later

## Context

- Summary: A TypeScript CLI that analyzes an AI agent's daily memory logs and distills them into structured long-term memory entries. Reads YYYY-MM-DD.md files, identifies patterns and decisions, and writes curated summaries to MEMORY.md using semantic scoring.
- Planner profile: product
- Phase: phase_1
- Path: core
- Recommended architecture: Start with modular monolith as the default architecture.

## Architecture Options

- option-a: Lean Modular Monolith (modular monolith)
  Summary: One deployable application with explicit domain modules and a single primary data store.
  Scores: delivery=5, ops=5, scale=4, governance=4
- option-b: Modular Monolith With Background Jobs (modular monolith with background jobs)
  Summary: Single primary deployable unit with explicit modules plus a worker path for async workflows and integrations.
  Scores: delivery=3, ops=3, scale=4, governance=4
- option-c: Early Service Separation (small service-oriented split)
  Summary: Separate user-facing application, workflow engine, and integration boundary early for stronger isolation.
  Scores: delivery=2, ops=2, scale=5, governance=3

## Applicable Playbooks

- /tools/agent-planforge/playbooks/planning-and-scoping.md
- agent-engineering-playbook/playbooks/01-project-setup.md
- agent-engineering-playbook/playbooks/02-architecture.md
- agent-engineering-playbook/playbooks/03-team-roles.md
- agent-engineering-playbook/playbooks/04-design-principles.md
- agent-engineering-playbook/playbooks/05-development-workflow.md
- agent-engineering-playbook/playbooks/06-testing-strategy.md
- agent-engineering-playbook/playbooks/07-quality-assurance.md
- agent-engineering-playbook/playbooks/08-documentation.md

## Risks And Open Questions

Risks:
- None

Open questions:
- None

## Expected Output

- Refined architecture recommendation
- Key module boundaries
- Biggest architectural risks
- ADR updates or new ADR proposals
