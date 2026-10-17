# ADR-0039: Admin-Defined Tax Strategies

**Status:** Accepted — 2026-10-16, on the project owner's decision in the backend panel gaps thread
(tax strategies are optional, set in the admin panel, with a fixed 10 % default). Hassan
(security-tester) reviews the implementation before it merges (tax is on the payments path).
**Amends:** ADR-0007 decision 9 (Market tax configuration is checked-in code), only for the choice
of strategy and its rates; the tax design `docs/design/domain/tax.md` 2.3 and 3.1 row "Tax
configuration as effective-dated code".
**Relates to:** ADR-0001 decision 1 and ADR-0002 decision 3 (`TaxStrategy` extension point),
ADR-0026 decision 6 (dated configuration is a V2 record of its owning module, not a Market
setting), `docs/modules/tax/brief.md` (Q1: the tax agent's written confirmation).

## Context
The tax design wanted every rate and treatment in the Market file, reviewed in a PR, because the
registered tax agent had not yet said which rules apply. The owner wants the opposite: whatever
the agent says must be expressible without a release. The platform starts on one fixed rate
(AU GST 10 %) and an admin adds other models later.

## Decision
1. **Strategies are data owned by `tax`.** An admin defines named strategies in the admin panel;
   they live in `tax.tax_strategies`, one table, scoped by Market. They are module records (as
   ADR-0026 decision 6 says of tax), not Market settings.
2. **Two kinds today, closed list.** `flat-rate` (one rate for every line) and `by-category` (a
   rate per tax category of the Market from `catalog.taxCategories`, with a default for any other
   line). A new kind is a code change and a new value of the `kind` CHECK; rates are whole basis
   points, 0 to 5000.
3. **The built-in strategy stays in Market config** (`tax.defaultRateBps`, AU 1000). With no
   active strategy it applies. Without that section the Market has no tax and calculation fails
   closed (`tax.unavailable`).
4. **At most one strategy is active per Market** (a partial unique index). Changing the active
   one, or editing it, applies to calculations made after the change. A module that places an
   order freezes the answer it was given; a later change never touches a placed order.
5. **Permissions.** `tax.strategy.manage` and `tax.strategy.view` are protected platform keys, held
   only by the Platform Administrator by definition. Every change is audited (ids, enums and whole
   numbers only; the strategy name is never audited).
6. **Calculation.** `TAX_FACADE.calculateTax` takes the signed-in customer's context from checkout,
   works each line to a half-up rounded tax (inclusive or exclusive price as the line says) and
   answers the strategy id with it. It reads no seller registration yet: a seller who is not
   registered for GST is a later slice (tax design 4.4).
7. **Still blocked on the tax agent (Q1).** Official invoices, the invoice thresholds, GST on
   refunds and GST on commission are not built here and need the agent's written confirmation.

## Consequences
- A rate or a rule the tax agent names becomes a strategy an admin creates and activates, with no
  release. The price is that a wrong strategy can be activated; the protected key, the audit row
  and the freeze on placed orders limit the damage to future orders.
- The design's golden list, boot checks and CODEOWNERS control for rate sets (tax design 3.1) do
  not apply to strategies; the protected key and the audit replace them. Hassan confirms this.
- `commission-payouts` still takes its provisional tax rate from its own Market config until a
  later slice moves it onto the frozen tax.
