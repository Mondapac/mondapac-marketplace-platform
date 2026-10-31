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

## Phase 2 discount types

Six types on top of the core (migration `20261031090000_promotions_phase2_types`). Rules as built:

- **Tiered cart** (platform, cart layer): tiers are rows (`promotion_tiers`); the highest tier whose
  threshold the goods amount (after the earlier layers) reaches applies. Thresholds strictly increase,
  rewards increase, one kind per promotion, a FIXED amount stays below its threshold.
- **Buy X get Y** (seller): of every `buyQty + getQty` qualifying units the `getQty` cheapest get the
  reward (PERCENT or FIXED per unit); `maxRepeatsPerOrder` limits the groups. For the seller maximum
  and the approval threshold the headline share is `floor(getQty * bps / (buyQty + getQty))`.
- **Multi-buy** (seller): every `groupQty` units, cheapest first, cost the group price together
  (stored as a FIXED reward; API `groupPriceMinor`); never more than their own price.
- **Bundle** (seller): items `{productId, quantity}` (at least two); each complete set takes the FIXED
  amount off, spread over the lines by value. The items are also the promotion's product targets.
- **Flash sale** (seller or platform): `flash:{unitLimit, timeZone, startsLocal?, endsLocal?}`; local
  wall-clock times in the stated IANA zone become UTC (nonexistent or ambiguous DST times are refused),
  or plain `startsAt`/`endsAt` instants; mixing both is refused. An end is required. The unit limit is
  checked against the `FlashSales.soldUnits` port; unknown counts as 0 only in test mode, otherwise the
  flash sale is left out of the quote. The production adapter returns unknown until package T2 counts sales.
- **Batch codes** (platform, cart layer): an admin generates N codes (`POST .../batch-codes`, CSV, shown
  once); only the HMAC-SHA256 hash (keyed by PROMOTIONS_CODE_PEPPER) is stored (`promotion_batch_codes`, unique per Market). Length and alphabet
  come from Market config `promotions.batchCodes` (absent means unavailable, fail closed; entropy at least
  60 bits). Step-up is needed for each generating call when the platform budget is above the Market
  threshold; the audit action records the count and batch id, never a code. One code per order still holds;
  a used code quotes as `NOT_APPLIED`, an unknown one as `UNKNOWN`.
- Multi-unit offers are worked out over the whole pool of qualifying units and become per-line candidates;
  a line is then covered by one offer or none (best for the buyer). One item discount per line, the line
  cap, the caps and the GST test-mode rule are unchanged. A stored row without the terms its type needs
  (no tiers, fewer than two bundle items) is left out of the quote.

- **Qualifying units are paid at full price (owner decision 2026-10-28).** A line that another
  item-level offer wins does not count toward a buy X get Y, multi-buy or bundle: the pools are rebuilt
  without such lines and the per-line competition is run again until no pooled line is won by another
  offer. The batch-code hash is HMAC-SHA256 keyed by `PROMOTIONS_CODE_PEPPER` (without it no code is
  generated or matched); a public code and a single-use code cannot share text (checked on both
  sides; the single-use code wins a quote); a malformed stored row is skipped in a quote and logged.

Open for package T2: marking a code used on redemption (the app has SELECT and INSERT only on the codes),
counting flash units sold, and checking a flash limit lowered below the units already sold. There is no
re-download of generated codes.

## Phase 3 discount types

Four types on top of phase 2 (migration `20261031120000_promotions_phase3_types`). The Market switch stays
off by default. Every amount and threshold is Market config (`promotions.customerGroup`,
`promotions.referral`, `promotions.cashback`; absent means the type is unavailable, fail closed) or
promotion data; nothing is hardcoded.

- **Customer-group discount** (platform, cart layer, admin only): a segment, either a returning customer
  whose last order was at least N whole days ago (N is the promotion's own or the Market default
  `customerGroup.defaultReturningDays`, filled in at create and edit) or a delivery zone (the promotion's
  zones; the cart's shipping charges carry the zone). Evaluated on the server: the quote takes
  `customerAccountId` (never the browser) and reads the last-order fact from the `CustomerOrderHistory`
  port only when a returning-customer promotion is live. Unknown (no customer, port says unknown, port
  throws, customer never ordered) is not eligible. The engine has an `audience` filter that fails closed.
  The admin preview takes a stated `customer` (`daysSinceLastOrder`, `followedSellerIds`) so a segment can
  be tried without any module; it reads nothing.
- **Store-follower offer** (seller, seller-funded, seller cart layer): applies to the followed seller's lines
  only; the follow comes from the `StoreFollows` port.
- **Refer a friend** (platform, admin only, wallet credit, not a discount, never in the quote): terms are a
  FIXED reward for the referrer, `refereeRewardMinor` for the new customer, `maxUsesPerCustomer` as the cap of
  rewarded referrals per referrer, a platform budget. Market limits cap each reward, the per-referrer cap and
  the qualifying window. A customer's code (`GET /promotions/referral/me`) is HMAC-SHA256 of the account under
  `PROMOTIONS_CODE_PEPPER` (Market alphabet and length, at least 60 bits), derived on demand so it can be shown
  again; only its hash is stored (`referral_codes`). Rotating the pepper invalidates every code and hash (the
  same consequence as for batch codes). `POST /promotions/referral/apply` records a PENDING referral for a
  customer who has never ordered (asked of `CustomerOrderHistory`; unknown refuses). Own code, repeat referral,
  prior orders and unreadable history all answer `promotions.referral-not-eligible` (409); an unknown or
  malformed code answers `promotions.not-found`, so the answer does not reveal which codes exist.
  After the referred customer's qualifying seller order is delivered (`ordering.seller-order-delivered.v1`,
  handler `promotions.qualify-referral-on-delivery`) the abuse check runs (`ReferralSignals`: same household,
  same payment; unknown leaves the referral pending until it expires), then the per-referrer cap and the
  budget (a referral the budget cannot cover whole is rejected `BUDGET_EXHAUSTED`), then both credits are
  reserved in one unit and paid through the wallet facade.
- **Cashback to wallet** (platform, admin only): X percent of the goods the delivered seller order was paid
  with (floored), within the promotion's per-order cap (shared across the seller orders of one order), minimum
  spend, budget, `maxTotalUses` and `maxUsesPerCustomer`; the larger of several live cashbacks wins, never both.
  Handler `promotions.cashback-on-delivery`. Cashback is per seller order because the delivery event is.

Credits (`credit_issuances`): one row per (kind, source), unique, and a unique idempotency key
`promotions:<kind>:<source id>` that the wallet also honours. Order of work per delivery: read, order facts
(another module, outside any unit), reserve the credit PENDING in a unit with the promotion row locked, call
`wallet.grantCredit` (source `promo`, reason `promotion`) outside any unit, then settle GRANTED or FAILED and
record the event in the inbox in one `runOnce`. A crash repeats the delivery and carries on from the wallet call.
The same event twice, or a new event for the same order, makes one credit. A final wallet refusal (account not
active, cap exceeded) is FAILED and not retried; any other refusal retries the delivery. The module never
touches wallet tables. PENDING and GRANTED credits hold budget and count against limits; a FAILED one releases.

GST test mode: a test-mode promotion only records the intended credit (status RECORDED, no wallet call, no
budget held, no use counted). A real platform promotion in a Market whose `gstRulingConfirmed` is false earns
nothing (skipped, nothing recorded); creation already requires test mode there. A test order never earns real
credit.

Fail-closed ports (no module publishes these yet; the adapters in `unknown-customer-facts.ts` answer
"unknown"): `CustomerOrderHistory` (last order, ever ordered), `StoreFollows`, `DeliveredOrderFacts` (customer,
goods paid, placed time, test flag of a delivered seller order) and `ReferralSignals`. Consequences while they
stay unknown: no customer-group or follower discount is ever offered, no referral can be applied, and the
delivery handlers retry a delivery whose facts are unknown (dead-lettered with an alert after the last
attempt) when a live promotion needs them, so turning the switch on before the owning modules publish these
reads is loud, not silent. With the switch off, or no live promotion of the type, a delivery is recorded as
handled without reading anything.

Not built here: refund or clawback of cashback and referral credit when an order is returned or refunded (T3,
out of scope: nothing is reversed today), a sweep that retries credits left PENDING (the delivery retry and the
dead-letter alert cover them for now), listing a customer's own credits (the wallet history shows them), and any
panel or buyer UI.

## Open points

- The identity role seed gains one key: the Viewer (seed version 21 on top of blog's 20, with its append-only snapshot entry
  and pin) receives the unprotected `promotions.promotion.view`. No default role receives the manage
  keys yet; the Platform Administrator grants them in a custom role.
- Permission keys have three segments (`promotions.promotion.manage`, `promotions.promotion.view`,
  `promotions.own-promotion.manage`, `promotions.settings.view`, `promotions.settings.manage`).
- The first-order monthly budget is read as a ceiling here; reserving and spending it is package T2.
