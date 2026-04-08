# Project Charter: agent-memory-sync

## Summary

A CLI tool that syncs agent memory files across multiple OpenClaw instances via a central Git repository. Agents can push/pull their MEMORY.md and daily logs to stay in sync.

## Target Users

- AI agents running on multiple machines
- developers managing multiple OpenClaw instances

## Core Features

- push local memory files to remote git repo
- pull and merge memory from remote
- conflict resolution for concurrent agent writes
- configurable sync interval (cron-compatible)
- dry-run mode to preview changes before sync

## Constraints

- TypeScript only
- no external databases, git is the source of truth
- must work offline (queue syncs until connection restored)
- lightweight CLI, no heavy frameworks

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
