# ADR-0044: Restaurant Vertical (Menu Items, Opening Hours, Order Sub-states)

**Status:** Accepted — 2026-11-04, owner decisions on the restaurants plan (Q2 10:14Z one
restaurant per cart; Q3 10:12Z one seller account per store; Q6 10:21Z no tips in version 1;
Q7 10:38Z same-day order-ahead, no catering; Q8 10:39Z build after the multi-culture work, only
this package earlier; Q9 10:39Z no switching between stores with one email in version 1) and the
owner's answers to the R0 review questions (15:40Z to 15:48Z: hold the payment until the
restaurant accepts; commission through the existing rates; a restaurant account has no other
activity; switching `Eat` off lets placed orders finish; out-of-radius restaurants are listed for
pickup; a missed accept deadline counts as a seller cancellation). Sources in the Project folder:
`design/restaurants/restaurants-one-account-plan-fa.html` and
`reviews/2026-11-04-pr678-owner-answers.md`.
**Builds on:** ADR-0001 decisions 1 and 5 (extension points, no vertical name in core),
ADR-0043 (the `Eat` section of the buyer site and the section key in core).
**Relates to:** ADR-0012 (PREPARED offers always need a seller certificate), ADR-0018 decision 3
(a seller-side account is a member of one seller), ADR-0040 (business activities), ADR-0005
(time zones, ServiceArea), the multi-culture plan (Project folder
`design/culture-sections/`; not yet accepted as an ADR, and a dependency of decision 7).

## Context
Hot food from restaurants of many cultures is the second vertical. The extension points of
ADR-0001 were designed with it as the first example (horizontal-extensibility architecture,
section 5, example A). Part of the order flow already exists in core: a seller order has
`fulfilment: to-ship | shipped | delivered` and a `readyAt` time, the seller marks an order ready
(`ordering.seller-mark-order-ready`), the shipping module books a same-day courier on
`ordering.seller-order-ready.v1`, and a 4-digit pickup code exists
(`ordering/domain/pickup-code.ts`). Missing are a menu model, opening hours, preparation time,
an accept step and the first implementation of `OrderWorkflowExtension` (declared in the
architecture, not implemented).

## Decision
1. **A restaurant is a seller.** It is a seller account with the business activity `Restaurant`
   (admin data, ADR-0040) and one or more cuisine tags (search tags, not cultures). No new
   seller population and no change to `sellers` ownership: a business with a grocery and a
   restaurant has two seller accounts, two reviews and two payouts (Q3). Each account has its
   own email (Q9). A seller account with the `Restaurant` activity holds no other activity;
   `sellers` enforces this when activities are assigned, through a per-activity "exclusive"
   flag in the activity data, not a literal.
2. **Menu item is a product type.** `menu_item` registers on `catalog.product-type`
   (`ProductTypeHandler`) from `apps/api/src/verticals/restaurant/` (ADR-0008); core never names
   it. Menu items are SELLER-scoped content (ADR-0010) and sell through Offers like any product.
   It uses `variantModel: 'single'`; choices are modifier groups, not variants: a group has a
   name, a minimum and maximum number of choices, and options with an optional price delta.
   Modifier groups and menu sections (display only) are owned by `verticals/restaurant/`;
   their storage is designed in R2 with database-designer sign-off. `ProductTypeHandler`
   validates data only, so the core changes are named here and built in R2 and R4:
   - the cart line key includes the chosen options (the same item with other options is a
     separate line), as an opaque options value the extension validates;
   - the order line keeps a snapshot of the chosen options and their price deltas;
   - the line's unit price is the base price plus the deltas, and that price is the base for
     tax and commission.
3. **Availability without stock counts.** A menu item or modifier option is either available or
   "sold out today". It is stored as the trading date it was sold out for, in the restaurant's
   time zone (ADR-0005), and compared at read time through the injected Clock: it is sold out
   while the current trading day is that date. A trading day is the opening period it started
   in, so a restaurant open past midnight is not reset mid-service. No reset job is needed.
4. **Opening hours and preparation time** are restaurant data owned by the restaurant vertical,
   never columns in the core seller table. The architecture names seller custom attributes
   (SEL-20) for this; SEL-20 is P2 and not built, so package R3 decides between SEL-20 and a
   table owned by `verticals/restaurant/`, with a database-designer sign-off. The data is:
   weekly hours, closed days, a one-click "closed now", the last order time before closing, a
   default preparation time and a temporary "busy" extra time. Outside opening hours a buyer
   may only order ahead for a time later the same day (Q7). Catering and multi-day orders are
   out of scope. The preparation time feeds the seller-health late-ready metric (HLT-06).
5. **Accept step and sub-states.** They attach to the seller order while
   `fulfilment = to-ship` and `readyAt` is empty, through a first implementation of
   `OrderWorkflowExtension`:
   - The extension adds only `Accepted` and `Preparing`. `Ready` is the core `readyAt` (existing
     mark-ready use case), `Out for delivery` is `shipped` and the end is `delivered`. The
     order status and the fulfilment values of core do not change.
   - The extension may refuse one core transition: mark ready before `Accepted`.
   - **Money (owner, 15:40Z):** for a seller order in a section whose policy says "accept
     first", the payment is authorised at checkout and captured only when the restaurant
     accepts. If the restaurant rejects (with a reason) or the accept deadline passes, the
     authorisation is voided; no refund is needed. Capture and void use the existing payment
     states (`authorised`, `captured`, `voided`) and run once per order with a key derived
     from the order.
   - **Order state while the payment is only held.** Core keeps its rule that `confirmed`
     means captured (`confirmOrder`). Until the restaurant accepts, the order stays
     `pending-payment` with payment state `authorised`. For an "accept first" section the
     pending order's expiry is the accept deadline, and the restaurant sees the seller order in
     Needs action while it is in this state; the buyer sees "Placed, waiting for the
     restaurant". There is no stock commit (menu items have no stock counts). On accept the
     payment is captured and the order becomes `confirmed`, with `confirmedAt` = the accept
     time, so the preparation promise and the seller ledger start then. If the capture fails,
     the order is cancelled with the existing payment reasons and the restaurant is told. On
     reject or timeout the hold is voided and the order is cancelled with a new reason,
     restaurant rejected or not accepted in time; these two count in seller health, `expired`
     does not.
   - **Deadline:** an admin sets it per Market. A job running as the system actor, with the
     Clock, voids and cancels orders past the deadline; the accept use case also refuses an
     accept after the deadline, so a late accept cannot capture.
   - A missed deadline or a rejection counts as a seller cancellation in seller health
     (HLT-06; owner, 15:48Z).
6. **Cart and delivery.** The `Eat` cart policy allows one restaurant only (Q2; enforced in the
   `Cart` aggregate, ADR-0043 decision 5); adding from a second restaurant asks the buyer to
   empty the cart first. Delivery uses the existing same-day flow: the courier job is booked
   when the restaurant marks the order ready (`ordering.seller-order-ready.v1`), or the buyer
   collects it with the existing 4-digit code. A delivery radius goes beyond ServiceArea
   postcode sets (ADR-0005 decision 7); package R5 designs it as an extension of ADR-0005.
   Restaurants outside the buyer's delivery range are listed after the others, for pickup
   only (owner, 15:47Z). No tips in version 1 (Q6).
7. **Certification and cultures are unchanged.** Restaurant offers are PREPARED, so a halal claim
   always needs the restaurant's own halal certificate (ADR-0012), checked through
   `evaluateClaim`. A restaurant joins a culture like any seller; under the multi-culture plan
   (decision Q3 there), a menu with any non-halal item keeps a restaurant out of the halal
   culture. The `Eat` section uses the multi-culture switch; it has no switch of its own for
   cultures. This decision depends on the multi-culture work being accepted first.
8. **Switches and settings.** The `Eat` section is off by default per Market (ADR-0043 decision
   1). Switching it off stops new orders and locks `Eat` carts; orders already placed continue
   to delivery (owner, 15:46Z). Admin settings: section on or off, accept deadline, and the
   default delivery radius (R5). Restaurant commission uses the existing rates: the Market rate
   (COM-01) and a per-seller rate set by an admin (COM-02); there is no rate per business
   activity (owner, 15:44Z).
9. **Build order.** This ADR and the screens document are package R0. Packages R2 to R8 (catalog,
   hours, ordering, delivery, seller panel, buyer site, admin panel) start only after the
   categories, attributes, variants and multi-culture work, each as one PR, backend before
   frontend (owner rule of 1 November 2026, recorded in the project chat).

## Consequences
- No change to identity, to the core order status values or to the fulfilment values.
- Core changes, each in its package: `cart` (section key, cart policy, options in the line key;
  R4), `ordering` (accept step, deadline job, capture on accept for "accept first" sections,
  option snapshot; R4), `payments` (capture and void at a later step through the existing
  states; R4), pricing, tax and commission bases include option deltas (R2 and R4).
- `OrderWorkflowExtension` gets its first real contract; its design is reviewed by the
  architect and CTO in package R4. security-tester reviews in R4: the deadline job, the
  void and capture path, the accept guard, and the pickup code (attempt limits and expiry).
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
- Capture at checkout and refund on timeout: rejected by the owner (15:40Z); it needs a new
  system-initiated refund path, while a void releases the hold with no money moved.
- A commission rate per business activity: rejected by the owner for version 1 (15:44Z).
