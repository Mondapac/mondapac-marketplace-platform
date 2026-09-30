# Phase 1 review record (technical skeleton)

Branch `feat/phase-1-skeleton`, reviewed 2026-10-01. This file keeps the outcome of the
Phase 1 reviews so that decisions and follow-ups are not lost. Verified here means: run in
the build environment (Linux, Node 24.21, PostgreSQL 16).

## Verdicts

| Reviewer | Verdict | Notes |
|---|---|---|
| Mojtaba (database-designer) | Approved with conditions | Baseline migration; conditions tracked in `docs/design/data/platform.md` section 9 |
| Ali (cto) | Approved with conditions | ADR-0014 accepted with amendments, ADR-0015 written; phase gate row in `docs/modules/README.md` |
| Hassan (security-tester) | No critical or high finding | One medium (database roles), seven low |
| Bagher (qc-release-manager) | Pass with open items | Two medium defects found and fixed after the gate; the gate has to be re-run on the final commit |

## Open before Phase 1 can be closed

1. First green GitHub Actions run of `.github/workflows/ci.yml` (never run; tests ran on
   PostgreSQL 16 locally, CI and compose use 17).
2. `docker compose up -d` with all four services healthy. Never run anywhere: only
   `docker compose config` was checked. The MinIO image tag and its healthcheck are unverified.
3. `pnpm install`, `pnpm verify` and `pnpm dev` on the owner's Windows machine. Nothing has
   run on Windows.
4. Owner confirms or rejects ADR-0015 (it changes the timing in ADR-0009 decision 8).
5. Owner decides whether to add `helmet` (a new dependency) for security headers.
6. Scrum-master's end-of-phase assessment, and a QC re-run on the final commit.

## Findings and what happened to them

| Finding | Source | Outcome |
|---|---|---|
| Any layer could import `PrismaService` and query any model | CTO M1, QC D3 | Fixed: `persistence-internals-are-private` and `database-driver-only-in-infrastructure` rules with fixtures; health uses `DatabaseProbe` |
| Application database role is a superuser and table owner, so it can disable the append-only triggers on `platform.audit_log` | Security M1 | Open by decision: ADR-0015 decision 2 makes the role split a gate before the first audit row and before any shared environment |
| Audit hash chain not in Phase 1 although ADR-0009 decision 8 says so | Database-designer, CTO | ADR-0015 decision 1; needs the owner's confirmation |
| `/docs` was served whenever `NODE_ENV` was not `production` | Security L2 | Fixed: `API_DOCS_ENABLED`, off by default |
| `X-Powered-By: Express` header | Security L1, CTO | Fixed and tested. Other security headers are deferred (ADR-0015); `helmet` awaits the owner |
| Compose published every port on all interfaces | Security L3 | Fixed: `127.0.0.1` only |
| Query string was logged | Security L5 | Fixed and tested: path only |
| API did not read `.env`, so the README quickstart failed | QC D1 | Fixed: `load-env-file.ts`; checked with `node dist/main` and `pnpm dev` |
| A unit test assumed POSIX paths | QC D2 | Fixed by reading; not run on Windows |
| No schema drift check after migrations | CTO | Fixed: `pnpm db:check-reversible` also runs `prisma migrate diff --exit-code` |
| Node version not enforced at install | CTO | Fixed: `engine-strict=true` in `.npmrc` |
| No test for the `main.ts` HTTP setup | QC D4 | Fixed: setup moved to `configure-app.ts`, used by both the server and the HTTP tests |
| `.gitignore` had a BOM and mixed line endings | QC D7 | Fixed |
| ADR-0008 items neither built nor listed as deferred | QC D8 | Added to the ADR-0015 table; ADR-0008 and ADR-0009 point to ADR-0015 |

## Follow-ups not done in Phase 1

- Body parser runs before the logging middleware, so rejected bodies have no correlation id
  (Security L4). Before the first endpoint that accepts a body.
- `/health/ready` does one database round trip per request and is unauthenticated
  (Security L6). Cache briefly and keep it off the public ingress before deployment.
- CI actions are pinned by tag, not by commit SHA, and checkout keeps its token
  (Security L7). Before the workflow gains a secret or a deploy step.
- `audit_log_market_id_check` only checks for a non-empty value; consider the market-code
  pattern (database-designer to decide with the audit writer slice).
- The lint rules are guard rails: the wall-clock rule catches only `new Date()` and
  `Date.now()`, and the market/vertical literal list in `eslint.config.mjs` is maintained by
  hand. Derive the list from `config/markets/` when a second market is added.
- Startup failures are printed by the framework as coloured text with a stack, not JSON.
- No positive fixture for domain importing the shared kernel, none for `no-circular`.
- The synthetic market fixture has no tax rate yet; add it when the tax module defines one.
- Production `DATABASE_URL` should require TLS (`sslmode=verify-full`) once deployment
  configuration exists.
- Commit scopes `p1-sN` proposed by the scrum-master were not adopted; the owner has not
  decided on the process proposals yet.
