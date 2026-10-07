# ADR-0003: Multi-Market Architecture and Regional Deployment Model

**Status:** Accepted — owner decision 2026-09-30: multi-market applies from Phase 0,
not from the second Market launch.
**Full reasoning:** `docs/architecture/country-branch-launch-playbook.md`
**Depends on:** ADR-0002 (Market entity)

## Context
MondaPac will expand into NZ, Malaysia, the EU and the US. Retrofitting market scoping,
region-aware configuration and data-residency guards after the AU launch would touch
every module and require migrating live data. The owner therefore requires the platform
to be multi-market by construction from the first line of code, even though only one
Market (AU) is live at launch.

## Decision
1. **Region Stack deployment unit.** One codebase is deployed as Region Stacks: a full,
   independent deployment (app + PostgreSQL + Redis + object storage) in one cloud region,
   hosting one or more Markets. Launch = one stack in ap-southeast-2 hosting AU (NZ joins
   it later); MY, EU and US get dedicated stacks per the playbook decision table.
2. **Mandatory market context.** Every inbound request, background job and consumed event
   resolves to exactly one `market_id` (host/domain mapping; explicit header for API
   clients). Core code has no implicit default market. A stack rejects any Market not in
   its `HOSTED_MARKETS` configuration (residency guard). *(Amended by ADR-0020: the API
   takes the Market only from the explicit `x-market-id` header; host/domain mapping is
   done by the tier in front of the API, which overwrites any client-supplied header.)*
3. **Market-scoped data.** Every market-scoped aggregate carries `market_id` — not only
   Seller/Offer/Order but also Customer account, Cart, Payment, Payout, certification
   issuer registry and tax records. Repositories take a `MarketContext`; unscoped queries
   fail in tests. Indexes lead with `market_id`.
4. **Market-scoped identity.** A customer/seller account belongs to one Market and lives
   in that Market's Region Stack; there is no global cross-region user table. *(Amended
   by ADR-0018: admin accounts too; every account, of any type, belongs to exactly one
   Market.)*
5. **Market configuration as code.** `config/markets/<code>` is versioned in the repo,
   validated at boot and seeded to the database; secrets are per Region Stack. *(Amended by
   ADR-0026: settings an owning module declares editable are seeded once from here into a
   platform store, which is then their source of truth; admins change them through the owning
   module's use case.)*
6. **Region-portable data.** IDs are globally unique (UUIDv7); timestamps stored in UTC;
   market timezone/locale applied only at the edges. *(Amended by ADR-0005: time zones
   come from each seller, location and address, not from the Market.)*
7. **Events.** The event envelope carries `market_id`; topic/event names never contain a
   market; events never cross Region Stacks.
8. **One pipeline, region matrix.** CI/CD and IaC are parameterised by region from day one
   (the matrix has a single entry today).
9. **Proof by tests.** Domain and integration tests run against at least two market
   fixtures — AU and a synthetic second market with a different currency, tax rate and
   locale — so any AU hardcoding fails CI.
10. **Launch process.** Each new Market follows the playbook checklist (legal → Market
    configuration → content/localisation → infrastructure → operations); legal review
    gates everything after it. Rollout order NZ → MY → EU → US is a recommendation.

## Consequences
- Small ongoing cost: market context propagation (request-scoped context), more explicit
  repositories, a second test fixture. Large later cost avoided: no schema rewrite, no
  data migration when NZ/MY launch.
- No cross-region features (global admin view, cross-market reporting) without a new ADR;
  platform-wide reporting later means aggregated exports, not shared tables.
- The same person may hold separate accounts in two Markets — deliberate, residency-driven.
- The EU stack is a mandatory cost from EU launch day (GDPR) and must be budgeted.

## Alternatives considered
- Defer multi-market until the second launch (previous draft): rejected by the owner.
- Single global deployment with only `market_id`: rejected — GDPR residency, latency.
- Global identity shared across regions: rejected for now — conflicts with residency;
  revisit only if cross-market shopping is ever approved (would supersede ADR-0002).
- Codebase per country: rejected — contradicts ADR-0001.
