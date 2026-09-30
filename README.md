# Mondapac Marketplace Platform

Multi-vendor marketplace platform (halal-certified launch market: Australia), built as a modular monolith. See `CLAUDE.md` and `docs/spec/technical-spec.md`.

## Getting started

1. Clone the repository:
   ```bash
   git clone https://github.com/Mondapac/mondapac-marketplace-platform.git
   ```
2. Setup and run instructions will be added as the project takes shape.

## Repository layout

```
CLAUDE.md              Project rules read by Claude Code every session
.claude/agents/        Specialized Claude Code subagents (cto, architect, dev, QA, ...)
docs/spec/             Technical specification (source of truth)
docs/features/         Feature specs with unique IDs (SEL-*, CAT-*, CERT-*, INTL-*, ...)
docs/architecture/     Extensibility, internationalization and regional-deployment design
docs/adr/              Architecture Decision Records
PLAYBOOK-fa.md         Phased build plan (Persian)
TEAM-PLAYBOOK-fa.md    How to coordinate the subagent team (Persian)
MIGRATION-fa.md        Getting started with Claude Code and Phase 0 (Persian)
```

## Contributing

Open a pull request against `main` with a short description of the change.
