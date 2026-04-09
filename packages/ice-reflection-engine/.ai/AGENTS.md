# AGENTS

## Engineering Model

- Spec-driven planning: make the intended outcome, scope, constraints, acceptance criteria, and major risks explicit before coding.
- Context-driven execution: use the project architecture, domain constraints, security posture, and operating assumptions when making changes.
- Eval-driven delivery: rely on tests, review findings, rollout readiness, and operational checks before calling work done.

## Roles

- Planning lead: maintains the plan, validates architecture assumptions, and reruns planning when inputs materially change.
- Architecture reviewer: challenges module boundaries, scaling assumptions, and integration risks before implementation expands.
- Implementation lead: executes one reviewable task at a time and updates tests and docs with each change.
- Human owner: remains accountable for review, release, and acceptance of agent-generated work.


## Workflow

1. Read `.ai/ARCHITECTURE.md`, `.ai/TASKS.md`, and the current prompt export before changing code.
2. Follow the applicable playbooks listed below for workflow, testing, documentation, and governance expectations.
3. Keep diffs small, update tests with the change, and avoid bundling unrelated work.
4. Escalate blockers or scope changes instead of silently improvising around them.

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

## Change Rules

- Preserve backward compatibility unless a breaking change is explicitly accepted.
- Update docs and ADRs when architectural assumptions shift.
- Treat prompts and generated artifacts as review inputs, not as permission to skip engineering judgment.

## Project Context

- Project: ice-reflection-engine
- Planner profile: product
- Phase: phase_1
- Path: core
