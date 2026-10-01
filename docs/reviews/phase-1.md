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

## Closing conditions (status on 2026-10-01)

"Reported by the owner" means the owner ran it and told the session the result; the session
cannot see GitHub or the owner's Docker and did not see the output itself.

| Condition | Status |
|---|---|
| First green GitHub Actions run of `.github/workflows/ci.yml` (PostgreSQL 17) | Reported green by the owner, on `main` after PR #5 |
| `docker compose up -d` with the three services running | Reported by the owner on their Windows machine. A first attempt failed with Prisma error P1001 because PostgreSQL was not running yet |
| `pnpm install`, `pnpm db:migrate`, `pnpm verify` and `pnpm dev` on Windows | Reported by the owner: all commands ran correctly; `/health`, `/health/ready`, `/docs` and the mail catcher UI open |
| Owner decision on ADR-0015 | Confirmed (owner decision 2026-10-01) |
| Owner decision on ADR-0016 | Confirmed (owner decision 2026-10-01) |
| Owner decision on `helmet` | Approved; to be added before the first authenticated endpoint (ADR-0015) |
| QC re-run on the final commit | See "Closing gate" below |
| Scrum-master's end-of-phase assessment | See `docs/project/process-health/` |

## Findings and what happened to them

| Finding | Source | Outcome |
|---|---|---|
| Any layer could import `PrismaService` and query any model | CTO M1, QC D3 | Fixed: `persistence-internals-are-private` and `database-driver-only-in-infrastructure` rules with fixtures; health uses `DatabaseProbe` |
| Application database role is a superuser and table owner, so it can disable the append-only triggers on `platform.audit_log` | Security M1 | Open by decision: ADR-0015 decision 2 makes the role split a gate before the first audit row and before any shared environment |
| Audit hash chain not in Phase 1 although ADR-0009 decision 8 says so | Database-designer, CTO | ADR-0015 decision 1, confirmed by the owner |
| `/docs` was served whenever `NODE_ENV` was not `production` | Security L2 | Fixed: `API_DOCS_ENABLED`, off by default |
| `X-Powered-By: Express` header | Security L1, CTO | Fixed and tested. Other security headers are deferred (ADR-0015); `helmet` approved by the owner |
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

## Phase 2 readiness check (2026-10-01)

See `docs/reviews/phase-2-readiness-fa.md` for the full result. Defects found and fixed on
branch `fix/phase-2-readiness`: the `minio/minio` image does not exist any more, so
`docker compose up -d` could not start (ADR-0016); `pnpm db:migrate:dev` left the Prisma
client stale, so the next typecheck failed; `pnpm audit` reported two high and one moderate
advisory in transitive dependencies of the Prisma CLI (overridden in `pnpm-workspace.yaml`).
