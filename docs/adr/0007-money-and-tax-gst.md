# ADR-0007: Money Representation and Tax (Australian GST as the First TaxStrategy)

**Status:** Accepted — 2026-09-30. Open item: the GST rules below must be confirmed by a
registered tax agent before Phase 5 (payments); this ADR is architecture, not tax advice.
**Relates to:** ADR-0002 (Money, TaxStrategy), ADR-0005 (invoice dates in seller zone),
COM-04 (commission frozen at order time)

## Context
Money errors in a marketplace compound across customers, sellers, commission, tax and
refunds. Australia is the first TaxStrategy but must not be hardcoded. Checked against ATO
guidance (2026-09-30):
- Domestic sellers are the supplier of their goods and account for their own GST; the
  platform (electronic distribution platform) rules make the operator liable only for
  imported low-value goods and imported services/digital products — out of scope, since
  cross-market selling is excluded (ADR-0002).
- Only GST-registered sellers charge GST; registration is compulsory above a turnover
  threshold (currently $75,000), optional below.
- Much basic food is GST-free, while other food is taxable — critical for a halal grocery
  marketplace.
- Tax invoices must be provided within 28 days on request (not required at $82.50 incl.
  GST or less) and contain the seller's identity and ABN, date, items, GST and the extent
  each sale is taxable; $1,000+ also needs the buyer's identity or ABN.
- GST fractions of a cent round to the nearest cent, 0.5 up; per-invoice or per-line
  rounding are both permitted.
- The Sharing Economy Reporting Regime excludes sales of goods (ownership transfer).

## Decision
1. **Money value object** (shared kernel): `{ amount: bigint (minor units), currency:
   ISO 4217 }`; minor-unit exponent from ISO 4217 (not assumed 2). No floating point
   anywhere in money paths. Arithmetic across currencies throws. Splits (commission,
   multi-seller orders, partial refunds) use largest-remainder allocation so parts always
   sum exactly to the whole.
2. **Rates are decimals, results are Money.** Tax and commission rates are exact decimals
   (decimal library, stored as `numeric`), never floats; every conversion to Money
   states its rounding mode explicitly (default half-up).
3. **TaxStrategy per Market**, configured not hardcoded. Input: order lines, the seller's
   tax profile, the product's tax category, ship-to address, market. Output: a
   `TaxBreakdown` per line and per invoice. The AU strategy is config-driven (rate,
   threshold, inclusive pricing); no `if (market == 'AU')` in core.
4. **Tax-inclusive pricing is a Market setting.** AU prices are entered and displayed
   GST-inclusive (total price shown to consumers); GST is extracted per line
   (price × rate / (1 + rate)), rounded half-up to the cent. A future US-style market sets
   `prices_include_tax = false`.
5. **Product tax category is mandatory** on the market-scoped Product (`taxable`,
   `gst_free`, extensible per market); offers inherit it, so two sellers of the same
   product (CRT-02) cannot classify it differently. Chosen at listing with a link to the
   market's official guidance (AU: ATO food guidance); admins can override; changes are
   audited.
6. **Seller tax profile.** `TaxRegistration { scheme, number, registered_for_indirect_tax,
   effective_from }`, captured at onboarding; scheme and number validator come from the
   Market config (AU: ABN with checksum, GST registration). Non-registered sellers charge no GST and receive a plain invoice, not a tax
   invoice. The platform warns (does not decide) when a seller's platform sales approach
   the configured threshold.
7. **Who supplies what.** The seller supplies goods to the customer; the platform issues
   the customer invoice on the seller's behalf with the seller's name and tax number, one or
   more invoices per seller sub-order (ORD-05 partial invoicing), dated in the seller's
   timezone (ADR-0005). The platform's commission is a separate supply from
   `Market.legal_entity` (ADR-0002) to the seller, with GST on the commission, shown on
   the seller's payout statement / tax invoice.
8. **Frozen at order time.** Prices, tax breakdown, tax category and commission rate are
   snapshotted on the order line; later catalog or rate changes never alter placed orders.
   The commission *rate* is frozen (COM-04); the commission *amount* is recomputed on the
   net invoiced amount (COM-05).
9. **Market tax configuration** holds the rate(s), registration threshold, tax-invoice
   thresholds (AU: $82.50 / $1,000) and rounding mode — none of these are constants in code.
10. **Libraries and wire format.** Rates use `decimal.js` (the library behind
    `Prisma.Decimal`). API DTOs carry `amount` as a string of minor units (bigint does not
    survive `JSON.stringify`).
11. **Refunds** reverse the original line's snapshot proportionally with the same
   allocation rules and produce adjustment documents; they never recompute from current
   prices.

## Consequences
- Correct GST for mixed baskets (GST-free meat + taxable snacks) from the first order.
- Sellers carry the classification burden; the platform must make it easy and auditable.
- Needs tax-agent confirmation of: invoicing on the seller's behalf, commission GST
  treatment, refund/adjustment documents, platform-funded coupons and shipping discounts
  (CRT-06), GST on delivery fees, and any product category needing special handling.
- Open owner decisions for Phase 5 (not blocking Phase 1): commission base (GST-inclusive
  or exclusive, before/after discount, on shipping or not) and the Stripe Connect charge
  model (destination vs direct charges), which affects invoicing and RET-06 refunds.
- Other markets (NZ GST 15%, MY SST, EU VAT via third party per ADR-0002) plug in as new
  TaxStrategy configurations or adapters.

## Alternatives considered
- Floats or `Decimal` for money amounts: floats are inexact; integer minor units are
  simpler and exact.
- Platform charges GST on all sales as the supplier: not how domestic marketplace GST
  works in Australia; would mis-tax non-registered sellers.
- Invoice-level GST rounding: permitted, but per-line makes refunds and multi-seller splits
  exact and auditable.
