# Intake Questionnaire: ice-reflection-engine

## Status

- Intake completeness: partial

## Why This Exists

This questionnaire captures the missing or still ambiguous inputs that most affect planning quality.

## Questions

### Q-005 (medium, blocker)

Question: What non-functional expectations matter most: performance, availability, security, auditability, or scalability?

Why it matters:
- Non-functional requirements influence architecture scoring and production readiness.

Affected decisions:
- architecture scoring
- production readiness
- quality tasks

### Q-006 (medium)

Question: Are there external integrations, identity providers, or messaging systems the product must rely on?

Why it matters:
- Integrations change failure modes, security assumptions, and delivery scope.

Affected decisions:
- integration strategy
- risk list
- delivery waves

## Next Step

Answer the high-priority questions first, then rerun the planner before relying on the backlog and architecture recommendation.
