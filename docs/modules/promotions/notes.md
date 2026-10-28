# promotions: package T1 (discount engine and domain, backend only)

Speed mode (CLAUDE.md): no G1/G2 or design document. The sources are the hand-off
`promotions-t1-engine.md` and sections 4, 6, 7, 8 and 14 of the Persian plan
`promotions-plan-fa.html` (both in the Project, outside the repo). The feature is switched off in
every Market until an admin turns it on. No checkout, budget reservation, ledger, commission,
refund or panel work is in this package.

## What the package holds

- `promotions` schema (migration `20261028103200_promotions_core`, with `down.sql` and grants):
  promotions with their targets and usage counters, co-funding opt-ins, the seller-promotion
  review queue, the first-order setting, per-zone free-shipping thresholds and the Market switch.
  Promotions, usage, opt-ins, reviews and settings are never deleted (a trigger refuses it for
  every role); only the target list and the zone thresholds may be deleted.
- A pure calculation (`domain/calculation`), tested first, with no Market lookup and no I/O.
- 25 use cases (admin, seller, a system quote for other modules, an anonymous was-price check).
- `PROMOTIONS_FACADE` with `quote` (rule `system`) and `wasPriceEligible` (rule `anonymous`).
  Neither is an HTTP route.
- Market config `promotions` (AU and the ZZ fixture): line discount cap, seller maximum, step-up
  amount, free-shipping default, new-seller days, prior-approval threshold, was-price window,
  tax-ruling flag and the first-order defaults.

## The switch is runtime

No `promotions.enabled` in Market config. The state is the row of `promotions.market_settings`
(no row means `off`), moved by an admin with `promotions.settings.manage` (protected key, audited
`promotions.market-status.changed`, refused in acting-as, idempotent). While off, every write and
admin read answers `promotions.disabled` (404), and a quote is the cart with no discount and
`enabled: false` (checkout must never fail because promotions are off).

## Calculation rules

Four layers in order, each on what the one before left: item, seller cart, platform cart,
shipping. Wallet credit is payment, not a discount, and is not here.

- One item-level discount per line, the best for the buyer; on a tie the seller-funded one, then
  the smaller promotion id.
- One code per order. Only the entered code's promotion is a candidate; a wrong code is
  `NOT_APPLIED`, an unreadable one `UNKNOWN`.
- Automatic offers of different layers stack. A non-combinable promotion is used alone: the engine
  compares the stack of all combinable promotions with each non-combinable one alone and takes
  what is best for the buyer (ties: the stack, then the smaller id).
- The first-order discount does not stack with a platform code: the larger applies.
- All discounts together take at most `lineDiscountCapBps` of a line (AU 80%), never more than what
  is left of the line.
- The platform's share of the goods discounts of one order is capped at the order's commission,
  unless the promotion is a special campaign. Shipping discounts are platform-funded and outside
  that cap.
- Money is integer minor units. Every share is floored; the rounding remainder goes to the largest
  line, ties to the smaller line id. The result never depends on the input order.
- Free shipping applies per zone when the goods net of the order reaches that zone's threshold
  (the Market default until an admin sets one).

## Who may do what

- A seller creates, edits, pauses and resumes its own seller-funded promotions on its own products.
  A seller promotion waits for an admin (`PENDING_APPROVAL` plus a review entry) when the seller has
  been active for fewer than `newSellerDays` (AU 30) or for an unknown time, or when a percent
  discount is above `priorApprovalDiscountBps` (AU 50%). Any other seller promotion is live at
  once and queues a post-publication check. Until an admin has approved a promotion, the
  calculation holds each line's seller-funded discount to the lower of the seller maximum and the
  approval threshold, which also covers fixed amounts (a fixed amount cannot be compared with a
  price when it is written).
- An admin creates platform and co-funded promotions, which need a budget. A fresh two-step code
  (`promotions.platform-funding.approve`, spent inside the use case's own unit) is needed when the
  platform's exposure of a budget is new or has grown past the Market step-up amount (AU 2000.00),
  and to mark a special campaign. The routes carry no `@RequiresStepUp` because the need depends on
  the data.
- Platform money in a Market whose tax ruling is not confirmed (AU: `gstRulingConfirmed: false`)
  stays in test mode: it is refused outside test mode at write time and left out of a real order
  at quote time.
- Every write is refused in an acting-as session.
- A Viewer reads usage counts only (`promotions.promotion.view`); budget, caps and spend need
  `promotions.promotion.manage`.

## Fail-closed adapters (no facade read exists yet)

- `SellerActivity` (since when a seller has been active): `sellers` publishes no such read, so
  the adapter answers "unknown", which the approval rule treats as a new seller. Until a later
  package replaces it, every seller promotion goes to the review queue.
- `PriceHistory` (days a product sold at a price): `pricing` publishes no price-history read, so
  the adapter answers "unknown" and the was-price check answers "not eligible".

## Security review changes

- **Co-funded terms.** An admin edit of a co-funded campaign that changes the reward, the platform
  split, the products or the sellers withdraws every live seller opt-in (one audited
  `promotions.co-funding.changed` row each); the sellers opt in again. The seller's share of a
  co-funded discount (the part the platform does not fund) is held to `sellerMaxDiscountBps` of
  the line: at write time for a percent reward (`reward.bps:exceeds-seller-maximum`) and per line
  in the calculation (`sellerMaxShareBps`, also for a fixed reward). The calculation keeps one
  unit of that limit in reserve on a split campaign, because the platform share is spread over the
  lines with a rounding remainder and a line can receive one unit less than its exact share.
- **Platform share rounding.** The platform share of a promotion is `floor(total x split / 10000)`
  taken once and spread over its lines (remainder to the largest line, ties to the smaller id), so
  the sellers do not absorb every rounding unit.
- **Review versioning.** A seller edit moves the one open review of the promotion to the new
  reason and time. A decision names the promotion version it read (`promotionVersion`, the
  promotion's `updatedAt` from the queue item); a promotion changed since answers
  `promotions.invalid-state`.
- **Quote shape.** The currency and size checks of a quote run before the switch is read, so a
  mixed or foreign currency is `validation.failed` with the switch on or off.
- **Step-up.** A fresh code is also needed for a free-shipping threshold below the Market default
  and for switching the first-order discount back on with a monthly budget above the step-up
  amount. The threshold CHECK is now `>= 1`.
- **Per-seller maximum.** Market config `maxActivePromotionsPerSeller` (AU 50, ZZ 20) bounds the
  promotions a seller has active or pending (ended and paused ones do not count, but must fit
  under the maximum when they come back by resume or edit): `promotions.too-many-active` (409).
  The quote reads only the platform's promotions and those of the cart's sellers, each without a
  product target or aimed at one of the cart's products. The count is not locked, so a burst of
  parallel creates by one seller can pass the maximum by the number of racing requests.
- **Row locks.** Writes that decide on a promotion (edit, budget, pause, resume, review decision,
  opt-in) and the first-order settings read the row with a lock held to the end of the unit. The
  client sends no raw SQL, so the lock is a row update that changes nothing (`updated_at` set to
  itself, guarded by its current value).

## Open points

- The identity role seed gains one key: the Viewer (seed version 21 on top of blog's 20, with its append-only snapshot entry
  and pin) receives the unprotected `promotions.promotion.view`. No default role receives the manage
  keys yet; the Platform Administrator grants them in a custom role.
- Permission keys have three segments (`promotions.promotion.manage`, `promotions.promotion.view`,
  `promotions.own-promotion.manage`, `promotions.settings.view`, `promotions.settings.manage`).
- The first-order monthly budget is read as a ceiling here; reserving and spending it is package T2.
