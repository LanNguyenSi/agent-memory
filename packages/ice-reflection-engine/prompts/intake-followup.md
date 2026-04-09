# Prompt: Intake Clarification

You are working on `ice-reflection-engine`.

## Objective

Clarify the missing planning inputs before deeper architecture and task execution begins.

## Intake Status

- Completeness: partial

## Questions To Resolve

- Q-005 (medium, blocker): What non-functional expectations matter most: performance, availability, security, auditability, or scalability?
  Why: Non-functional requirements influence architecture scoring and production readiness.
- Q-006 (medium): Are there external integrations, identity providers, or messaging systems the product must rely on?
  Why: Integrations change failure modes, security assumptions, and delivery scope.

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

## Expected Output

- concise answers to each question
- explicit assumptions where answers are still unavailable
- which answers remain blocking for implementation
