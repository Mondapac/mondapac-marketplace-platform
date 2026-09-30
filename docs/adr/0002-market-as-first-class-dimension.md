# ADR-0002: Market as a First-Class Dimension (i18n, Multi-Currency, Multi-Region Compliance)

**Status:** Proposed (needs owner/CTO sign-off before Phase 0 work starts)
**Full reasoning:** `docs/architecture/internationalization-architecture.md`
**Depends on:** ADR-0001 (extension-point registry)
**Amended by:** ADR-0005 — `Market.timezone` is only a fallback default; time zones come from sellers, locations and addresses.

## Context
MondaPac plans to expand from Australia into New Zealand, Malaysia, EU countries, and the
US. The core must not hardcode any country, currency, or language. Cross-market shopping
is explicitly NOT on the roadmap (confirmed by the owner) — each Market's catalog and
sellers stay independent of every other Market.

## Decision
1. Introduce a `Market` entity (country code, locales, currency, tax strategy, legal
   entity, timezone, certification issuer set, payment providers, carriers, data
   residency requirement) as a first-class dimension alongside the existing `Vertical`
   dimension (ADR-0001).
2. Every Seller, Product Offer, and Order carries a `market_id`. Because cross-market
   shopping is out of scope, every order is always in a single currency (the Market's
   currency) — no FX conversion or FX-rate snapshot is needed anywhere in the system.
3. Add two new extension points to the registry established in ADR-0001: `TaxStrategy`
   and `PaymentProviderAdapter`, implemented per market.
4. Money is always `{ amount: integer minor units, currency: ISO 4217 }`.
5. For EU and US tax calculation, integrate a third-party tax compliance service rather
   than building VAT-OSS/US economic-nexus logic in-house.
6. Infrastructure moves from a single cloud region to a region-per-market topology where
   a Market's `data_residency_requirement` demands it (notably the EU, for GDPR).

## Consequences
- Adds a market-configuration layer to Seller/Product/Order from day one; low cost now
  (Australia is simply the first Market), high cost avoided later (no schema rewrite).
- EU and US tax/compliance complexity is deliberately pushed to specialized third parties
  instead of in-house logic, trading a recurring vendor cost for correctness and reduced
  legal risk.
- Requires legal review per market before launch (privacy law, consumer law, tax
  registration) — this ADR does not substitute for that review.
- Because cross-market shopping is out of scope, the system carries no currency-conversion
  logic at all — this is a deliberate scope reduction, not an oversight, and should not be
  quietly re-added without revisiting this ADR.

## Alternatives considered
- Hardcode Australia-only assumptions and rewrite per country when expansion happens:
  rejected — repeats the exact mistake corrected for certifications (HAL -> CERT) and for
  business lines (ADR-0001); the cost of generalizing now is small compared to a schema
  rewrite later.
- Build tax calculation in-house for all markets: rejected for EU/US specifically, given
  the scale of ongoing regulatory maintenance required (VAT rate changes, US nexus
  threshold changes).
- Support cross-market shopping with live FX conversion: rejected by the owner — adds
  significant legal/tax/financial complexity (cross-border VAT, FX risk) with no current
  business requirement.
