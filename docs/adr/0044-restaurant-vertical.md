# ADR-0044: Restaurant Vertical (Menu Items, Opening Hours, Order Sub-states)

**Status:** Accepted — 2026-11-04, owner decisions on the restaurants plan (Q2 10:14Z one
restaurant per cart; Q3 10:12Z one seller account per store; Q6 10:21Z no tips in version 1;
Q7 10:38Z same-day order-ahead, no catering; Q8 10:39Z build after the multi-culture work, only
this package earlier; Q9 10:39Z no switching between stores with one email in version 1).
**Builds on:** ADR-0001 decisions 1 and 5 (extension points, no vertical name in core),
ADR-0043 (the `Eat` section of the buyer site).
**Relates to:** ADR-0012 (PREPARED offers always need a seller certificate), ADR-0018 decision 3
(a seller-side account is a member of one seller), ADR-0040 (business activities), ADR-0005
(time zones), the multi-culture plan (culture membership and the halal view).

## Context
Hot food from restaurants of many cultures is the second vertical. The extension points of
ADR-0001 were designed with it as the first example (horizontal-extensibility architecture,
section 5, example A), but none of its pieces exist yet: there is no menu model, no opening
hours, no preparation time and no order sub-states (`OrderWorkflowExtension` is declared in the
architecture but not implemented).

## Decision
1. **A restaurant is a seller.** It is a seller account with the business activity `Restaurant`
   (admin data, ADR-0040) and one or more cuisine tags (search tags, not cultures). No new
   seller population and no change to `sellers` ownership: a business with a grocery and a
   restaurant has two seller accounts, two reviews and two payouts (Q3). Each account has its
   own email (Q9).
2. **Menu item is a product type.** `menu_item` registers on `catalog.product-type`
   (`ProductTypeHandler`) from `apps/api/src/verticals/restaurant/` (ADR-0008); core never names
   it. Menu items are SELLER-scoped content (ADR-0010) and sell through Offers like any product.
   It uses `variantModel: 'single'`; choices are modifier groups, not variants: a group has a
   name, a minimum and maximum number of choices, and options with an optional price delta.
   Menu sections (starters, mains, drinks) group items for display only.
3. **Availability without stock counts.** A menu item or modifier option is either available or
   "sold out today". "Sold out today" resets at midnight in the restaurant's time zone
   (ADR-0005), through the injected Clock.
4. **Opening hours and preparation time** are restaurant data owned by the restaurant vertical,
   never columns in the core seller table. The architecture names seller custom attributes
   (SEL-20) for this; SEL-20 is P2 and not built, so package R3 decides between SEL-20 and a
   table owned by `verticals/restaurant/`, with a database-designer sign-off. The data is: weekly hours, closed days, a
   one-click "closed now", the last order time before closing, a default preparation time and a
   temporary "busy" extra time. Outside opening hours a buyer may only order ahead for a time
   later the same day (Q7). Catering and multi-day orders are out of scope. The preparation time
   feeds the seller-health preparation metric.
5. **Order sub-states** run inside the fixed `Fulfilling` state through a first implementation
   of `OrderWorkflowExtension`: `Accepted → Preparing → Ready → Out for delivery` (or
   `Ready for pickup`) and then the core `Completed`. The core order state machine does not
   change. A restaurant must accept within an admin-set deadline; past it the order is
   cancelled and refunded automatically.
6. **Cart and delivery.** The `Eat` cart holds lines from one restaurant only (Q2); adding from a
   second restaurant asks the buyer to empty the cart first. Delivery is immediate: the courier
   job is booked when the restaurant marks the order Ready (delivery decision of 25 October
   2026), or the buyer collects it with a 4-digit code. The restaurant delivery radius is set
   per restaurant or service area by an admin. No tips in version 1 (Q6).
7. **Certification and cultures are unchanged.** Restaurant offers are PREPARED, so a halal claim
   always needs the restaurant's own halal certificate (ADR-0012), checked through
   `evaluateClaim`. A restaurant joins a culture like any seller; under multi-culture decision
   Q3, a menu with any non-halal item keeps a restaurant out of the halal culture. The `Eat`
   section uses the multi-culture switch; it has no switch of its own for cultures.
8. **Switches and settings.** The `Eat` section is off by default per Market (ADR-0043 decision
   1). Admin settings: section on or off, accept deadline, default delivery radius and the
   restaurant commission rate (commission per business activity; the rate is a business
   decision for the owner).
9. **Build order.** This ADR and the screens document are package R0. Packages R2 to R8 (catalog,
   hours, ordering, delivery, seller panel, buyer site, admin panel) start only after the
   categories, attributes, variants and multi-culture work, each as one PR, backend before
   frontend (owner rule of 1 November 2026).

## Consequences
- No change to identity, payments or the core order state machine.
- `OrderWorkflowExtension` gets its first real contract; its design is reviewed by the
  architect and CTO in package R4, and security-tester reviews the auto-cancel and refund path.
- Australian legal and tax questions stay open for a lawyer and an AU tax advisor before launch:
  food business registration, allergen information online, food safety and temperature in
  delivery, alcohol (proposed: none in version 1), GST on hot food and its delivery fee, and
  tips if they are ever added. This ADR does not answer them.

## Alternatives considered
- One seller account for several stores: rejected by the owner (Q3).
- Menu choices as catalog variants: rejected; variants model packaged goods with option
  combinations and stock, while menu choices are add-ons with min/max rules and price deltas.
- Carts mixing restaurants: rejected (Q2); hot food from two kitchens does not arrive hot with
  one courier.
