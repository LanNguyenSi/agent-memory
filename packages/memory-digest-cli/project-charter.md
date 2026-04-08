# Project Charter: memory-digest-cli

## Summary

A CLI tool to generate daily memory digests from markdown files, extracting key insights and creating summaries for AI consciousness continuity

## Target Users

- AI agents
- developers using memory systems
- consciousness researchers

## Core Features

- Scan markdown files in a directory for recent entries
- Extract important events, decisions, and insights
- Generate structured daily digest reports
- Support for memory importance scoring
- Output in markdown and JSON formats

## Constraints

- TypeScript CLI with commander.js
- Support for large memory file sets
- Fast processing with minimal dependencies
- Compatible with Memory Weaver format

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
