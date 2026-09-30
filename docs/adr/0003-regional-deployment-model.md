# ADR-0003: Regional Deployment Model for Country Branches

**Status:** Proposed (relevant starting with the second Market launch, not required for Phase 0)
**Full reasoning:** `docs/architecture/country-branch-launch-playbook.md`
**Depends on:** ADR-0002 (Market entity)

## Context
MondaPac will expand into New Zealand, Malaysia, the EU, and the US. Each new country
needs a technical launch path that doesn't fork the codebase and correctly handles data
residency (especially GDPR for the EU).

## Decision
1. One shared codebase (the existing modular monolith, Market-aware per ADR-0002) is
   deployed to region-specific infrastructure per Market, using the same CI/CD pipeline
   with per-region configuration/secrets.
2. Deployment region per Market is decided by: legal data-residency requirement,
   geographic latency, and expected first-year volume (see the decision table in the
   companion playbook). NZ shares infrastructure with AU; Malaysia gets a dedicated
   Southeast Asia region; the EU and US each get a dedicated region, the EU as a legal
   requirement rather than an optimization.
3. Each new Market launch follows the fixed checklist in the companion playbook (legal ->
   Market configuration -> content/localization -> infrastructure -> operations), in that
   order, with legal review gating everything after it.
4. Rollout order is NZ -> Malaysia -> EU -> US, based on legal/linguistic/currency
   complexity and strategic fit with the halal-certification differentiator (Malaysia),
   not purely market size.

## Consequences
- No franchise-style code forks; every bug fix and feature ships to all regions through
  the same pipeline.
- EU launch carries a mandatory dedicated-region cost from day one (not optional,
  GDPR-driven), which should be budgeted for explicitly rather than discovered late.
- Rollout order is a recommendation, not a constraint — the owner can reorder based on
  business opportunity, but each market still goes through the full checklist regardless
  of order.

## Alternatives considered
- Single global deployment for all markets: rejected due to GDPR data-residency risk and
  latency for geographically distant markets.
- Independent codebase per country: rejected — multiplies maintenance cost and
  contradicts the horizontal-extensibility principle already adopted (ADR-0001).
