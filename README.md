# Mondapac Marketplace Platform

Multi-vendor marketplace platform (halal-certified launch market: Australia), built as a modular monolith. See `CLAUDE.md` and `docs/spec/technical-spec.md`.

## Getting started

1. Clone the repository:
   ```bash
   git clone https://github.com/Mondapac/mondapac-marketplace-platform.git
   ```
2. Install Node.js 24.9 or later and pnpm 10, then install dependencies:
   ```bash
   pnpm install
   ```
3. Check everything (typecheck, lint, tests) and start the API in watch mode:
   ```bash
   pnpm verify
   pnpm dev
   ```
   Copy `.env.example` to `.env` to change local settings.

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
