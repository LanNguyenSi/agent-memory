# Project Charter: ice-reflection-engine

## Summary

A TypeScript CLI that analyzes an AI agent's daily memory logs and distills them into structured long-term memory entries. Reads YYYY-MM-DD.md files, identifies patterns and decisions, and writes curated summaries to MEMORY.md using semantic scoring.

## Target Users

- AI agents running on OpenClaw
- developers managing agent memory

## Core Features

- scan daily memory files in configurable directory
- extract decisions, lessons, and key events using heuristic analysis
- score entries by significance and recency
- write distilled summaries to MEMORY.md without overwriting existing content
- dry-run mode to preview changes before writing
- configurable significance threshold

## Constraints

- TypeScript only
- no external databases or APIs
- must work offline
- reads and writes plain markdown files

## Non-Functional Requirements

- None

## Delivery Context

- Planner profile: product
- Intake completeness: partial
- Phase: phase_1
- Path: core
- Data sensitivity: low

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

## Missing Information

- Non-functional requirements are not defined.

## Follow-Up Questions

- What non-functional expectations matter most: performance, availability, security, auditability, or scalability?
- Are there external integrations, identity providers, or messaging systems the product must rely on?

## Open Questions

- None
