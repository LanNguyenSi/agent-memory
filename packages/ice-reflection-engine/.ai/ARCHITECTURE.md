# ARCHITECTURE

## Summary

A TypeScript CLI that analyzes an AI agent's daily memory logs and distills them into structured long-term memory entries. Reads YYYY-MM-DD.md files, identifies patterns and decisions, and writes curated summaries to MEMORY.md using semantic scoring.

## Recommended Shape

- Start with modular monolith as the default architecture.
- Tech stack hint: TypeScript CLI tool
- Phase: phase_1
- Path: core

## Key Modules

- user-facing application surface
- domain and business logic modules
- persistence and integration boundary

## Integrations

- None

## Risks

- None

## Playbook References

- /tools/agent-planforge/playbooks/planning-and-scoping.md
- agent-engineering-playbook/playbooks/01-project-setup.md
- agent-engineering-playbook/playbooks/02-architecture.md
- agent-engineering-playbook/playbooks/03-team-roles.md
- agent-engineering-playbook/playbooks/04-design-principles.md
- agent-engineering-playbook/playbooks/05-development-workflow.md
- agent-engineering-playbook/playbooks/06-testing-strategy.md
- agent-engineering-playbook/playbooks/07-quality-assurance.md
- agent-engineering-playbook/playbooks/08-documentation.md
