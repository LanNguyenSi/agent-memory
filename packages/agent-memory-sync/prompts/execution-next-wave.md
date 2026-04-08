# Prompt: Delivery Execution

You are working on `agent-memory-sync`.

## Objective

Turn the current plan into an implementation strategy for the next delivery wave.
Use a spec/context/eval lens:

- spec: keep the objective, scope, dependencies, and acceptance criteria explicit
- context: use the architecture, constraints, and applicable playbooks to guide decisions
- eval: define the tests, review points, and rollout checks needed before delivery is considered done

## Context

- Planner profile: product
- Phase: phase_1
- Current wave: wave-1
- Wave goal: Lock scope, assumptions, and engineering baseline.
- Critical path: 001 -> 002 -> 003 -> 008

## Tasks In Scope

- 001 Write project charter and architecture baseline (P0)
  Depends on: none
- 002 Set up repository and delivery baseline (P0)
  Depends on: 001

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

## Constraints And Questions

Constraints:
- TypeScript only
- no external databases, git is the source of truth
- must work offline (queue syncs until connection restored)
- lightweight CLI, no heavy frameworks

Open questions:
- None

## Expected Output

- proposed execution order inside the wave
- risks or blockers
- test and verification approach
- whether any task should be split further
