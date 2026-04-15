# Agent Memory

**Persistent Memory · Sync, weave, and digest agent memories across sessions and environments.**

Agents lose state the moment a session ends. Context windows truncate, processes restart, and the model that felt "caught up" five minutes ago is a blank slate on the next run. Agent Memory is the persistence layer that closes that gap — so an agent can pick up where it left off, across sessions, machines, and platforms.

## Packages

| Package | Description |
|---------|-------------|
| [agent-memory-sync](packages/agent-memory-sync) | Sync agent memories across sessions and environments |
| [mw-cli](packages/mw-cli) | Memory Weaver CLI - frictionless memory storage |
| [openclaw-skill-memory-weaver](packages/openclaw-skill-memory-weaver) | Native Memory Weaver Cloud integration for OpenClaw agents |
| [memory-digest-cli](packages/memory-digest-cli) | Generate daily memory digests from markdown files |
| [ice-reflection-engine](packages/ice-reflection-engine) | Analyze daily memory logs, distill into structured long-term entries |
| [lava-sprint-timer](packages/lava-sprint-timer) | Session timer that auto-commits memory logs per sprint |

## Status

Experimental - tools for managing persistent agent memory across different platforms and workflows.
