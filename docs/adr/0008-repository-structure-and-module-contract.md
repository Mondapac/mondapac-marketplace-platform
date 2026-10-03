# ADR-0008: Repository Structure and Module Communication Contract

**Status:** Accepted — 2026-09-30
**Relates to:** ADR-0001 (core vs verticals), ADR-0003/0005 (market and time context),
ADR-0004 (persistence), ADR-0006 (events)

## Context
Module boundaries are the whole point of the modular monolith; if they are only a
convention they erode within weeks. The layout must make DDD layering, the
core/vertical split and the market/time rules visible and machine-checked.

## Decision
1. **pnpm workspace monorepo**
   *(Amended by ADR-0020: `packages/shared-kernel/` also holds `ActorContext` (ADR-0018
   decision 6), `CorrelationId` and `CallContext`.)*
   ```
   apps/api/                 NestJS modular monolith (roles: api | worker)
   apps/web/                 first vertical storefront + its BFF (Next.js route handlers,
                             ADR-0001 decision 4) — added when frontend work starts
   packages/shared-kernel/   Money, Clock, Id (UUIDv7), MarketContext, DomainEvent,
                             Result — framework-free, used by api and web
   prisma/schema/            one .prisma file per module (ADR-0004)
   config/markets/           Market configuration as code (ADR-0003)
   config/service-areas/     ServiceArea postcode sets (ADR-0005)
   config/holidays/          HolidayCalendar data (ADR-0005)
   docs/                     spec, features, architecture, adr, stories, design
   test/fixtures/markets/    AU + a synthetic second market (ADR-0003 decision 9)
   infra/                    IaC region module (added in Phase 1/7)
   ```
2. **Module layout** (`apps/api/src/modules/<module>/`)
   *(Amended by ADR-0018: `contracts/` also holds the module's permission declarations.)*
   *(Amended by ADR-0019: `contracts/` also holds the module's AI tool declarations, kinds
   READ and DRAFT only; `platform/ai` joins the cross-cutting runtime and is the only code
   that calls a model.)*
   ```
   domain/          aggregates, value objects, domain events, domain services
                    (no NestJS, no Prisma, no I/O)
   application/     use cases (commands/queries), ports (repository interfaces)
   infrastructure/  Prisma repositories, external adapters, outbox writer
   presentation/    controllers, DTOs, validation, OpenAPI
   contracts/       public event types + public facade interface
   index.ts         exports only contracts/ and the Nest module
   ```
   Cross-cutting runtime lives in `apps/api/src/platform/` (market-config and market
   context resolution, Clock, persistence/UnitOfWork, audit log, outbox relay, event bus, scheduler,
   extension-point registry, logging with correlation id, auth guards). Market is
   configuration, not a bounded context (spec §1.4). Vertical implementations of extension points live in
   `apps/api/src/verticals/<vertical>/`.
3. **Initial core modules (bounded contexts):** P0: `identity`, `sellers`,
   `certification`, `catalog`, `inventory`, `pricing`, `cart`, `ordering`, `payments`,
   `commission-payouts` (COM-*, PAY-*), `tax`, `shipping` (SHP-01); audit logging
   (CERT-32, IMP-10) is platform infrastructure (`platform/audit`, ADR-0004); P1: `returns` (refund execution stays in `payments`, RET-06), `notifications`,
   `search`. Created empty in Phase 1, filled slice by slice. *(Amended by ADR-0019: P1
   also `assistant` (buyer conversation and tool selection), created with its first
   slice.)*
4. **Time library.** The Temporal API (via polyfill until native in the Node LTS in use)
   backs `Clock` and the local date/time types in `shared-kernel` (ADR-0005 decision 5).
5. **Communication contract**
   *(Amended by ADR-0018: facade calls also carry the caller's `ActorContext`; events
   carry no actor and their handlers run as the system actor; no module keeps a read
   model of `identity`'s role, assignment or membership data.)*
   *(Amended by ADR-0019: an AI tool is a facade method: it carries the caller's
   `CallContext` unchanged and reaches a wrapped use case; the actor and the Market never
   come from model output.)*
   - Queries across modules: call the other module's public facade (in-process interface
     from its `contracts/`). No cross-module joins, no reading another module's tables.
   - Reactions/commands across modules: domain events via the outbox (ADR-0006).
   - Every facade call and event carries `MarketContext` (market, tenant) and correlation
     id; there is no ambient default market.
   - When a module needs another module's data often, it builds its own read model from
     events rather than calling synchronously in a loop.
6. **Enforced in CI (dependency-cruiser + ESLint)** — created in Phase 1 together with the
   region-matrix CI workflow (ADR-0003 decision 8)
   *(Amended by ADR-0015: the per-model access rule and the items without a consumer yet
   are deferred, each with a trigger.)*
   - `modules/X` may import `modules/Y` only through `modules/Y/index.ts`.
   - `domain/` may not import `application/`, `infrastructure/`, `presentation/`,
     `@nestjs/*` or `@prisma/*`; no `new Date()` in `domain/` (use Clock).
   - Core (`modules/`, `platform/`, `shared-kernel`) may not import `verticals/`.
   - Prisma client only in `infrastructure/`; model access limited to the owning module.
   - A literal check flags vertical or market identifiers (e.g. `'AU'`, `'halal'`) in core
     code outside config and tests (ADR-0001 decision 5, ADR-0003 decision 2).

## Consequences
- New contributors (human or agent) can tell from the path what a file may depend on.
- Boundary violations fail CI instead of being caught in review.
- Slightly more files per module than a flat NestJS app; accepted for extractability.
- The web app and api share `shared-kernel`, so money and date formatting cannot diverge.

## Alternatives considered
- Nx or Turborepo from day one: useful later for build caching; pnpm workspaces suffice now.
- Flat NestJS feature folders: no enforceable layering; boundaries erode.
- One package per module: stronger isolation, much more build/config overhead for a small
  team; revisit if a module is extracted.
