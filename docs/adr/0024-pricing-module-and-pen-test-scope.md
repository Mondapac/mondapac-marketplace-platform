# ADR-0024: The `pricing` Module and the Penetration-Test Scope, from Catalog G1

**Status:** Accepted — 2026-10-03 (owner decision: option A, "accept as written"). Drafted
by the CTO; reviewed by Mohammad (software-architect), Hassan (security-tester) and Hadi
(product-owner), all "accept with changes", applied (not re-read by them). It amends
owner-accepted ADRs (ADR-0009, ADR-0013's tier list, ADR-0018 decision 7), so only the
owner accepts it. The owner had already answered `catalog` G1 question 7 ("yes",
2026-10-03); this ADR records that answer and did not reopen it.
**Amends:** ADR-0009 decision 3 (price-jump hold), ADR-0013 decision 2 (tier B), ADR-0018
decision 7 (scope of the penetration test), `CLAUDE.md` (ADR list; mandatory security
review)
**Supersedes:** the dependency line of module 3 in `docs/spec/technical-spec.md` §2.1
("وابستگی: Inventory, Pricing")
**Relates to:** ADR-0001 decision 1, ADR-0007 decisions 1, 4 and 8, ADR-0008 decisions 3,
5 and 6, ADR-0009 decision 2, ADR-0010 decisions 2 and 3, ADR-0013 decisions 1, 3, 4 and
6, ADR-0018 decision 10, ADR-0019 decision 9, ADR-0022 decision 6, CAT-16, CAT-17,
VER-03, VER-09, `docs/modules/catalog/brief.md` (sections 3, 5, 7, 8, 10 and 11)

## Context
- `pricing` is already a P0 module (ADR-0008 decision 3) and owns price, keyed by
  `offer_id` (ADR-0010 decision 2). ADR-0013 decision 2 gives it no tier, and
  `docs/modules/README.md` has no row for it (catalog brief, section 8, conflict 2).
- At the `catalog` G1 (approved by the owner, 2026-10-03) the CTO ruled: `catalog` neither
  holds nor reads price or stock; `pricing` is tier B in Phase 4 with its own brief; the
  price-jump hold belongs to `pricing` (brief sections 3 and 11). ADR-0009 decision 3
  gives the hold to "the offer's owning module", which is `catalog` (ADR-0010 decision 2),
  and VER-03 says "in the Offer itself" (conflict 13).
- Constraints. A fixed price is a Money value (ADR-0007 decision 1) per unit of sale,
  effective-dated (V2, ADR-0009 decision 2), plus Cost, hidden from buyers (CAT-16). Order
  lines freeze it (ADR-0007 decision 8); `tax` (tier A) computes tax. Special price, the
  hold (an admin review) and a non-fixed PricingStrategy each add rules where a mistake
  changes what a buyer pays. CAT-16 (P0) includes special price; VER-03 (P0) the hold.
- Question 7 of the `catalog` G1: the independent test covers sign-in, access control and
  the AI surfaces switched on at launch. The owner agreed that it also covers three paths
  an outside attacker tries first (brief section 7).

## Decision
1. **`pricing` is its own module, with its own brief and gates.** It holds price, special
   price and Cost, keyed by `offer_id` (ADR-0010 decision 2) plus the product's stable
   Variant id: the unit priced is (Offer, Variant) (catalog brief section 5). This refines
   ADR-0010 decision 2 without changing it. It also takes CAT-17 (P2) and the Offer price
   history of VER-09 (P1) (catalog brief section 3). This ADR requires
   `docs/modules/pricing/brief.md` and its gate. ADR-0007 decisions 1 and 4 bind it.
2. **Tier B, PLAYBOOK Phase 4, with a security review of price writes.** `pricing` joins
   tier B (one combined gate); this amends ADR-0013 decision 2. Whatever its tier,
   security-tester review is mandatory before merging a `pricing` use case that sets or
   changes a price or Cost, and any `pricing` facade, event or response that carries Cost.
   Every way of writing a price or Cost (form, Import or any other entry point) goes
   through those use cases.
3. **Tier A on condition.** `pricing`'s gate settles scope first, with the G1 approvers
   (ADR-0013 decision 1). If the approved launch scope keeps special price (part of
   CAT-16), the price-jump hold (part of VER-03) or a PricingStrategy other than a fixed
   price (ADR-0001 decision 1), that approval is its G1 and a G2 with security review
   follows; otherwise the combined tier B gate continues. The gate also states whether a
   future-dated price counts as special price. A deferred item returns only through
   ADR-0013 decision 4, with the same effect. The CTO records the tier with the gate
   approval, in the brief and its register row. No new ADR is needed: this is the rule.
4. **The price-jump hold belongs to `pricing`.** An Offer price jump above the threshold
   is held for review by `pricing` as a pending V2 record, not by the offer's owning
   module; this amends ADR-0009 decision 3. The threshold stays as VER-03 sets it
   (Market/Vertical configuration). VER-03's text is corrected in `docs/features/`.
5. **Dependency direction.** `pricing` and `inventory` depend one way on `catalog`'s
   facade and events (ADR-0008 decision 5). `catalog` imports neither and holds or reads
   no price or stock; no `catalog` facade, event or response carries price, stock or
   "sellable now". `catalog` still answers for the Offer's own state, off sale included
   (ADR-0010 decision 3). Which modules compose "sellable now" (the Offer's state, the
   may-sell contract of ADR-0022 decision 6, price, stock), and whether one keeps a read
   model of it, is decided at the gates of cart, `ordering`, `search` and the storefront;
   read-time composition by cart and `ordering` (catalog G1) is their input. ADR-0010
   decision 2 settles only ownership. The boundary check (ADR-0008 decision 6) gains a
   named rule, landing with `catalog`'s first slice: `modules/catalog` imports neither
   `modules/pricing` nor `modules/inventory` (catalog brief section 10, criterion 6).
6. **Penetration-test scope** (owner decision 2026-10-03, catalog G1 question 7). The
   independent human penetration test (ADR-0018 decision 7) also covers: the upload of
   product photos and their public serving; the parsing of bulk Import files, if Import is
   in the launch-candidate build (if it ships later, what it needs joins the open point of
   ADR-0018 decision 7); and attempts to bypass CERT-21 and the refusal of
   certification-claim words (every type defined in the Market, in every text a customer
   or search engine sees; catalog G1 question 1) by calling the API directly instead of
   using the UI. Unchanged: decision 7's pass criterion and timing (no open Critical or
   High finding after retest; passed before public launch and any real account) and
   decision 10's dates (quote approved when Phase 5 starts, test contracted when Phase 7
   starts). Those dates refer to the quote for this wider scope; none exists yet (owner
   action queue item 10).

## Consequences
- Easier: `catalog`'s G2 and slices wait for neither `pricing` nor `inventory`. Price
  rules are decided once, at the `pricing` gate; a fixed price gets the lighter gate, with
  a security review of the code that writes prices.
- Harder: `pricing` is on the path to the first sale (P0). Its gate is approved before its
  first slice, pipelined with `catalog`'s slices (ADR-0013 decisions 3 and 6), and Phase 3
  ends with no buyable Offer (catalog brief section 11). PLAYBOOK Phase 4 now holds three
  modules; nobody has estimated it.
- `catalog` stores no "sellable" flag; consumers get price, stock and may-sell from their
  owners. `catalog` cannot pass an Import's price and stock columns (OFR-10, OFR-11) on,
  by call or event; how they reach `pricing` and `inventory` is for those gates. Import is
  not a launch requirement (catalog G1 question 5).
- Tier B is the default, not the likely result: CAT-16 and VER-03 are P0 today, so
  decision 3 makes the module tier A unless the owner, at the `pricing` gate, takes
  special price and the hold out of launch scope; special price's priority is already in
  question (catalog brief, section 8, conflict 17). Revisit the tier at that gate.
- The penetration test grows again before its price is known; public launch still depends
  on a test with no price and no supplier (ADR-0018, Consequences).
- Follow-ups, none in this ADR's PR. Shared-file PR: `docs/modules/README.md` tier table
  and register row (`pricing`, B, Phase 4; plus `assistant` in A, from ADR-0019). Product
  track: Hadi drafts the `pricing` brief from catalog brief section 11, sale by actual
  weight included (its gate says if that falls under decision 3); `docs/features/` PR:
  VER-03, `00-INDEX.md` section 5 (CAT-16 to the Phase 4 row, CAT-17 out of Phase 3) and
  catalog brief section 8; Javad: risk register R-1 and a penetration-test row. Backend
  track: an identity brief change-log row (its section 11 holds the test scope); the
  boundary rule of decision 5. No owner yet: spec module 3, PLAYBOOK Phase 4,
  `data-and-content-versioning.md` (the hold in the Offer and in Phase 3),
  `horizontal-extensibility-architecture.md` (`computeAvailability`, brief conflict 1),
  `.claude/agents/security-tester.md` (decision 2).

## Alternatives considered
- Price on the Offer in `catalog`: contradicts ADR-0010 decision 2 and puts money rules in
  a module whose G1 is closed.
- Tier A in every case: a G1, a G2 and a design security review for one dated value per
  (Offer, Variant). Tier B in every case: special price, the hold or a computed price
  would reach code without a design gate.
- Tier B with no mandatory security review (the G1 ruling as first given): nobody would
  review how `pricing` checks Offer ownership through `catalog`, the price's currency
  against the Market, or Cost leaving the module.
- The hold in `catalog`, as ADR-0009 decision 3 and VER-03 read: `catalog` would have to
  read price, against decision 5.
- `catalog` answers "sellable now" (stored flag, or calls to `pricing` and `inventory`): a
  two-way dependency. Fixing cart's and `ordering`'s read-time composition here: a
  `catalog` G1 cannot bind later gates, and ADR-0008 decision 5 allows read models.
- Keep the old test scope (option ب of question 7): only the team's own reviewer, not
  independent and testing no running build, would see these paths. The owner chose "yes".
