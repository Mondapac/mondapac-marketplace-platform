# ADR-0015: Phase 1 Scope and Deferred Platform Foundations

**Status:** Accepted — 2026-10-01 (CTO at the Phase 1 review; owner decision 2026-10-01
confirming the change to the timing set in ADR-0009).
**Amends:** ADR-0009 decision 8 (last sentence), ADR-0008 decision 6 (the "created in
Phase 1" wording, for the per-model rule only)
**Relates to:** ADR-0003, ADR-0004, ADR-0006, ADR-0013, ADR-0014,
`docs/design/data/platform.md`

## Context
Phase 1 is a technical skeleton with no business logic. Several platform building blocks
that earlier ADRs place "in Phase 1" or "from day one" have no consumer yet; building
them now would mean designing them without the code that uses them. This ADR records what
the skeleton contains, what is deferred, and the event that forces each deferred item.

## Decision
1. **Audit log: table now, hash chain with the writer.** The Phase 1 baseline migration
   contains only the append-only `platform.audit_log` table. The audit writer
   (`platform/audit`), the separate append-only seal table that carries the hash chain,
   and the sealer ship together as one slice set, before any slice writes an audit row,
   with mandatory security-tester review. ADR-0009 decision 8 now reads: the value types
   and the audit hash chain arrive with the first slice that needs them, not in Phase 1.
2. **Database roles before the first audit row.** Today the application connects as the
   table owner and a superuser, so it can disable the append-only triggers. Before the
   first slice that writes an audit row, and before any shared or deployed environment,
   migrations and the application get separate roles: the application role is not a
   superuser, does not own the schema, and has only `INSERT` and `SELECT` on
   `platform.audit_log`; a database test proves it cannot disable the triggers.
3. **Deferred items and their triggers.** *(Amended by ADR-0023: "in the same change as"
   reads "no later than, never after"; identity's slice 1 is delivered as slices 1a to 1d,
   one branch and one PR each.)*

   | Deferred | Must land |
   |---|---|
   | Shared-kernel types (Id, Clock, MarketContext, Result, DomainEvent) and the ADR-0009 value types *(Amended by ADR-0018: plus `ActorContext`.)* *(Amended by ADR-0020: plus `CorrelationId` and `CallContext`; the ADR-0009 value types are designed in the approved design of each type's first consumer instead; the fields of `ActorContext` are completed in identity's G2 design.)* | As a "platform foundations" design by the software-architect, approved by the CTO, before the first identity domain code |
   | Money | Before the first slice that handles a price |
   | Temporal polyfill | With Clock (already approved as a dependency by ADR-0008 decision 4) |
   | Request-level market context | Before the first non-platform endpoint; health and docs are explicitly exempt; never a default market |
   | UnitOfWork, outbox relay, event bus, scheduler, `APP_ROLE` *(Amended by ADR-0023: the delivery side of the event bus lands with the first subscription.)* | With the first slice that emits an event or an audit row |
   | `market_id` Prisma query guard | In the same change as the first repository on a market-scoped model (`audit_log` counts) |
   | Per-model "model to owning module" lint rule | In the same change as the first module-owned Prisma model |
   | Market configuration seeded to the database | When something needs to read Markets from the database; configuration as code stays the source of truth |
   | `config/service-areas/` and `config/holidays/` (ADR-0005) | With the first slice that evaluates a ServiceArea or a business-day rule |
   | Extension-point registry and `verticals/<vertical>/` content (ADR-0001) | With the first extension point a module defines |
   | Auth guards | With the identity module (Phase 2), after its gates |
   | Baseline HTTP hardening beyond removing `X-Powered-By` (security headers, explicit body limits, logging before body parsing, CORS, trust proxy, rate limiting) | Before the first authenticated endpoint. The owner approved adding `helmet` for the security headers (owner decision 2026-10-01) |
   | `infra/` infrastructure as code | Phase 7 |
   | Redis and object-storage clients | When code first uses them; no environment variables before that. The local object-storage server is chosen then (ADR-0016) |
   | `SubjectKeyService` (ADR-0009 decision 8) *(Amended by ADR-0018: row added.)* | In the same change as the first migration whose data design declares a personal-data column |
   | Permission registry in `platform/` *(Amended by ADR-0018: row added.)* | In the same change as the first use case that declares a permission key |
   | CI check that every use case declares its access rule *(Amended by ADR-0018: row added.)* | At the slice named in identity's approved G2 design, no later than the first use case that declares a permission key |
   | Runtime meaning of the Market `status` values *(Amended by ADR-0020: row added.)* | Before the first deployed environment the public can reach; until then "hosted" (`HOSTED_MARKETS`) is the only gate and `status` has no runtime effect |
   | `platform/ai` (model entry point and provider adapter, switch evaluation, usage budget; each further part with its first consumer) *(Amended by ADR-0019: row added.)* | In the same change set as the first slice that calls a model; not in Phase 2 and not merged during Phase 5; each part of its design approved by the CTO, with security-tester review, before the first slice that consumes it; the per-seller AI switch slice of `sellers` lands before or with it |
   | CI rules of ADR-0019 R2 and R7 (allow-list of the files that may import the model entry point, checked by `pnpm boundaries`; provider SDK imports only inside `platform/ai`) *(Amended by ADR-0019: row added.)* | In the same change as the model entry point of `platform/ai` |

4. **`domain-is-pure` is a whitelist.** `domain/` may import only its own `domain/` and the
   shared kernel. This is how "no I/O" in ADR-0008 decision 2 is enforced. Libraries reach
   the domain through the shared kernel; any exception is a named CTO decision, not a
   relaxed rule.
5. **PrismaService counts as the Prisma client.** Outside `modules/<m>/infrastructure/` and
   `platform/persistence/`, code may import only `PersistenceModule` and `DatabaseProbe` from
   `platform/persistence/`; the PostgreSQL driver is restricted the same way.
6. **Phase gate register.** CTO approval of a phase is recorded in the "Phase gates" table
   of `docs/modules/README.md`.

## Consequences
- The skeleton stays small, and each foundation is designed next to its first consumer.
- Until decision 2 is done the append-only guarantee holds against application bugs, not
  against a compromised application. No audit rows exist before then.
- The deferred items are obligations with triggers. QC rejects a slice that hits a trigger
  without delivering the item.

## Alternatives considered
- Build all foundations in Phase 1: front-loads design with no consumer and delays the
  first verifiable module.
- Defer silently: leaves Accepted ADRs contradicting the code.
