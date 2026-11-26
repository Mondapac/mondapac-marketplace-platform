# Mondapac Marketplace Platform

Multi-vendor marketplace platform (halal-certified launch market: Australia), built as a modular monolith. See `CLAUDE.md` and `docs/spec/technical-spec.md`.

## Getting started

1. Clone the repository:
   ```bash
   git clone https://github.com/Mondapac/mondapac-marketplace-platform.git
   ```
2. Install Node.js 24.20.0 or later, pnpm 10 and Docker, then:
   ```bash
   cp .env.example .env        # local settings; never commit .env
   docker compose up -d        # Postgres, Redis, mail catcher
   pnpm install
   pnpm db:migrate             # apply database migrations
   ```
   On Windows run these in PowerShell or Git Bash (in cmd.exe use `copy` instead of `cp`).
3. Check everything and start the API in watch mode:
   ```bash
   pnpm verify                 # typecheck, lint, boundaries, tests, migration check
   pnpm dev
   ```
   The API listens on http://localhost:3000: `GET /health` (liveness), `GET /health/ready`
   (readiness, checks the database) and Swagger UI at `/docs`.

### Database roles

The API connects as `mondapac_api` (`DATABASE_URL`) and may only insert and read what the
migrations grant; migrations and database tests run as `mondapac_migrator`
(`MIGRATION_DATABASE_URL`). `docker compose up -d` creates both on a fresh volume from
`scripts/db/bootstrap-dev.sql`; `pnpm db:bootstrap` runs it again on an existing volume. See
`docs/design/data/platform.md` section 10.

**After pulling the change that added these roles**, recreate your local database once (it
deletes only your empty local database):

```bash
docker compose down -v
cp .env.example .env          # both database URLs changed
docker compose up -d
pnpm db:migrate
```

Troubleshooting: `role "mondapac_migrator" does not exist`, `role "postgres" does not exist`
or a bootstrap error about objects "not owned by mondapac_migrator" means the volume predates
the roles: run the four commands above. The API exiting with "The database role was refused
by the start-up self-check" means `DATABASE_URL` names a role other than the application login.

### Buyer site and panels locally: the signed client address (ADR-0037)

The buyer site (`pnpm dev:web`, http://storefront.localhost:3003) and the panels read the API
from their own server. Without a signing key (`BFF_CLIENT_ADDRESS_KEY_ID` and
`BFF_CLIENT_ADDRESS_SECRET` both empty, the default in each app's `.env.example`) they send no
`x-client-address`, and the API rate-limits by the socket, which is the app's server: every page
read shares one per-origin counter. This is accepted only on `*.localhost` hosts; a real host
refuses to start without a key.

On one machine the default is what you want. Signing does not spread the load there, because the
browser is `127.0.0.1` too, so every read still counts against one origin. Turn it on only to try
the production path:

1. Make one secret per app (`openssl rand -base64 32`). Never commit one.
2. API `.env` (root): `TRUSTED_BFF_CIDRS=127.0.0.1/32,::1/128` and
   `CLIENT_ADDRESS_KEYS=storefront:127.0.0.1/32,::1/128:<web secret>;panel:127.0.0.1/32,::1/128:<panel secret>`.
3. `apps/web/.env`: `BFF_CLIENT_ADDRESS_KEY_ID=storefront`, `BFF_CLIENT_ADDRESS_SECRET=<web secret>`.
   The buyer site's key id must be `storefront` or `storefront-<suffix>`.
4. `apps/seller/.env` and `apps/admin/.env`: `BFF_CLIENT_ADDRESS_KEY_ID=panel` and
   `BFF_CLIENT_ADDRESS_SECRET=<panel secret>`.
5. Restart the API and every app.

Once the API trusts `127.0.0.1`, every request from this machine must be signed, apart from
`/health` and `/health/ready`. An app or a `curl` without the key gets `400 client-address.untrusted`. To go back, empty
both API variables and every app's key, then restart.

When a page section shows "This section didn't load", look for `rate-limit.unavailable` in the
API log. Its `stage` (`market`, `origin` or `counter`) and `err` (the error type, Prisma code and
SQLSTATE, for example `55P03` when a counter lock wait ran past `lock_timeout`) say why the
limiter answered `503 access.unavailable`.

## Repository layout

```
CLAUDE.md              Project rules read by Claude Code every session
.claude/agents/        Specialized Claude Code subagents (cto, architect, dev, QA, ...)
apps/api/              NestJS modular monolith: src/modules (bounded contexts), src/platform (runtime)
packages/shared-kernel Framework-free types shared by api and web
prisma/                Prisma schema (one file per module) and migrations with down.sql
config/markets/        Market configuration as code, validated at startup
config/service-areas/  ServiceArea postcode sets per Market, validated at startup
test/fixtures/markets/ Synthetic second market used by tests
scripts/               Migration reversibility and Prisma boundary checks
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
