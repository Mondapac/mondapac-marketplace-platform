# ADR-0001: Horizontal Extensibility via Core + Vertical Extension Points

**Status:** Proposed (needs owner/CTO sign-off before Phase 0 work starts)
**Full reasoning:** `docs/architecture/horizontal-extensibility-architecture.md`

## Context
MondaPac launches with a halal-retail vertical but intends to expand into unrelated
business lines (food & restaurant, trade/tools marketplace) without rewriting the core
platform. The core must not encode knowledge of any specific vertical.

## Decision
1. The platform core exposes five extension points as first-class interfaces:
   ProductTypeHandler, FulfillmentStrategy, PricingStrategy, OrderWorkflowExtension
   (sub-states only — the top-level order state machine stays fixed), and the existing
   dynamic AttributeSchema mechanism (already used for SEL-20/CERT-01).
2. Every table in the core schema (Seller, Product, Order) carries a `tenant_id` column
   from day one, defaulting to a single value today, to avoid a schema rewrite if true
   multi-tenant SaaS becomes a business requirement later.
3. Full data isolation (schema-per-tenant/DB-per-tenant) is explicitly OUT of scope until
   a real SaaS customer requirement exists — this ADR only reserves the seam, it does not
   implement isolation.
4. Each vertical ships as a separate headless storefront (Next.js app) consuming the same
   Core API through a vertical-specific BFF; the Core API itself remains vertical-agnostic.
5. No vertical name may appear in core module code, event topic names, or core schema.
   A CI/review check (enforced via the qc-release-manager and security-tester subagents)
   flags any conditional branching on a vertical identifier inside core modules.

## Consequences
- Slightly more upfront design cost in Phase 0/1 (interface design, tenant_id column).
- New verticals (food, trade) are added as new modules implementing existing interfaces,
  without touching Order/Payment/Commission core logic.
- Full SaaS multi-tenancy, if ever needed, requires additional work (data isolation,
  billing separation) but not a schema rewrite.

## Alternatives considered
- Full multi-tenant architecture now (schema-per-tenant): rejected — no current SaaS
  customer, premature operational cost.
- Vertical-specific forks/branches of the codebase: rejected — defeats the "buildable once,
  extensible many times" goal and duplicates core bug fixes across branches.
