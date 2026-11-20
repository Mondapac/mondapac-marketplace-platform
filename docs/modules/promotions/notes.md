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

Package T2 (below) marks a code used on redemption and counts flash units sold. Still open: checking a
flash limit lowered below the units already sold. There is no re-download of generated codes.

## Phase 3 discount types

Four types on top of phase 2 (migration `20261031140000_promotions_phase3_types`). The Market switch stays
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

Credits (`credit_issuances`): one real row (PENDING, GRANTED, FAILED) per (kind, source), unique, and a unique
idempotency key `promotions:<kind>:<source id>` that the wallet also honours; a RECORDED note has a slot of its
own (partial unique indexes, see the review fixes below). Order of work per delivery: read, order facts
(another module, outside any unit), reserve the credit PENDING in a unit with the promotion row locked, call
`wallet.grantCredit` (source `promo`, reason `promotion`) outside any unit, then settle GRANTED or FAILED and
record the event in the inbox in one `runOnce`. A crash repeats the delivery and carries on from the wallet call.
The same event twice, or a new event for the same order, makes one credit. A final wallet refusal (account not
active, cap exceeded) is FAILED and not retried; any other refusal retries the delivery. The module never
touches wallet tables. PENDING and GRANTED credits hold budget and count against limits; a FAILED one releases.

GST test mode: a test-mode promotion only records the intended credit (status RECORDED, no wallet call, no
budget held, no use counted, not part of the per-order cap). A RECORDED note is made only when no real promotion
applies to the order, and a test-mode referral is left PENDING (not counted toward the referrer cap), so a real
program can still reward the referee later. A real platform promotion in a Market whose `gstRulingConfirmed` is false earns
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

## Phase 3 review fixes (PR #601)

Changes after review, all in the `20261031140000_promotions_phase3_types` migration (not yet merged, edited in
place) and the promotions module.

- **Reserved credits are always finished.** A delivery first looks up the credits that already exist for its
  source (cashback: by seller order; referral: the referral that seller order qualified, and its two credits) and
  calls the wallet for every PENDING one, whatever the Market switch or the programs say now. Only a NEW
  reservation is gated on the switch and on a live program. A credit that is already FAILED is reported as
  `failed`, never `issued`.
- **Test mode never displaces real credit.** Cashback picks among REAL candidates first and makes a RECORDED note
  only when none applies; the per-order cap, `maxTotalUses`, `maxUsesPerCustomer` and the budget count PENDING
  and GRANTED credits only. Uniqueness is two pairs of partial unique indexes: one for real rows
  (`status <> 'RECORDED'`) and one for RECORDED rows, per (market, kind, source) and per (market, idempotency
  key). A note therefore never keeps the real credit from being made later.
- **Test-mode referral decides nothing.** In RECORD mode the intended credits are noted, the referral stays
  PENDING and is not counted toward the referrer cap (no `QUALIFIED`, no `CAP_REACHED`/`BUDGET_EXHAUSTED`
  rejection). Once the program is real, the referee's next delivered order rewards both people for real.
  The referral stays bound to the program it was applied under, so "a later real program" means that program
  leaving test mode, not a second program taking over.
- **Market limits are applied at issue time.** The referral rewards are clamped to `referral.maxRewardMinor`,
  the cashback percent to `cashback.maxBps` and its cap to `cashback.maxCapMinor`, whatever the promotion says.
  A Market whose config has since dropped `referral` or `cashback` issues nothing new.
- **Apply order.** `POST /promotions/referral/apply` checks the order history and the already-referred state
  before it looks the code up, so an ineligible customer cannot probe whether a code exists.
- **Wallet refusals.** `wallet.customer-not-found` and `wallet.not-found` are final (FAILED, budget released),
  with the other final codes.
- **Database guard.** `BEFORE UPDATE` triggers allow only `credit_issuances` PENDING to GRANTED or FAILED and
  `referrals` PENDING to QUALIFIED, REJECTED or EXPIRED, for every role (the owner too).
- **Indexes.** `referrals (market_id, promotion_id, status)` and `(market_id, qualifying_seller_order_id)`;
  `credit_issuances (market_id, promotion_id, created_at DESC, id DESC)` for the list; the status index carries
  `amount_minor` as a trailing key column (the design's INCLUDE) so the budget sum is an index-only scan.
- **Credit list.** `GET /promotions/admin/promotions/:id/credits` pages by keyset: `limit` and `cursor` in, `items`
  and `nextCursor` out (an opaque cursor over `created_at, id`). It reads while the Market switch is off.
- **`viewMyReferral`** counts a referral as pending only while `expires_at > now` (the injected clock).
- **The engine refuses** a CUSTOMER_GROUP or STORE_FOLLOWER promotion that has no audience (it would apply to
  everybody).
- **Change log (no `brief.md` exists for this module).** New dependency: the `wallet` module's public facade
  (`grantCredit`, source `promo`, reason `promotion`); new tables `promotions.referral_codes`,
  `promotions.referrals`, `promotions.credit_issuances` and `promotions.inbox`.

### Operating notes and carry-forward

- **Do NOT turn the switch on in any Market that has a cashback or referral program configured until refund
  reversal (T3) is merged.** Until then nothing claws a credit back when an order is returned or refunded.
- **Switch-on order:** wallet on, then the fact ports published (`CustomerOrderHistory`, `StoreFollows`,
  `DeliveredOrderFacts`, `ReferralSignals`), then promotions. Otherwise the delivery handlers retry and the
  deliveries dead-letter (alert after the last attempt).
- `GET /promotions/referral/me` creates the customer's code row on first ask (a write behind a GET).
- `wholeDaysBetween` counts elapsed UTC 24-hour blocks, not calendar days or the customer's local days.
- Cashback `maxUsesPerCustomer` counts seller orders (one credit per delivered seller order), not orders.
- For REFERRAL, `maxUsesPerCustomer` is the per-referrer cap of rewarded referrals, and it is per program.
- Ordering must pass the session's own `customerAccountId` to the quote; it is not wired yet, so the
  customer-group and store-follower discounts are not offered until it is.
- Inbox retention (how long `promotions.inbox` rows are kept) is still to be decided.
- T2 carry-forward: a per-account rate limit on `POST /promotions/referral/apply`. The repo's rate counters
  (`catalog.rate_counters`, sellers' counters) are module-owned tables; there is no platform-wide limiter that
  promotions may use without importing another module, so the route has none yet. The apply route answers
  uniformly for ineligible customers, which limits what a probe learns, but it is not a limiter.
- Follow-ups: running counters on the promotion row for cashback volume (today `countLive` and `reservedTotal`
  aggregate the credit rows under the promotion lock), and a per-account code version so one customer's code can
  be revoked without rotating the pepper.

### Seller campaigns and payout preview (PB2)

- Two seller reads: `GET /promotions/seller/campaigns` (open co-funded campaigns split into `joined` and
  `available`; never the platform budget or spend) and `GET /promotions/seller/payout-preview` (what the shopper
  pays and what the seller gets for one unit; optionally whether the was-price may show).
- A seller may leave a co-funded campaign **only before it starts** (owner decision, 12 Nov 2026); after
  `startsAt`, `PUT .../opt-in` with `optIn: false` answers `promotions.invalid-state`. Joining stays possible
  while the campaign runs.
- Commission rule in the preview: commission is taken on the price **after the seller-funded part of the
  discount**; the platform-funded part never lowers the seller share. The rate comes from commission-payouts'
  seller-only `ownCommissionOn` facade read (own rate, else the Market default); no readable rate means
  `promotions.unavailable`, never a guess.
- The preview is an estimate **before delivery**: tax uses the provisional rate, and the commission ledger is not
  yet discount-aware. `minSpend` is ignored for item-layer campaigns, as the engine does. A campaign in test mode
  is listed to sellers with `testMode: true`.
- The preview calculates as if the campaign had no budget, so a very large price cannot reveal what is left of the platform
  budget. For a test-mode campaign it may show platform money that a real order would not get until the tax ruling.
- `listOpenCampaigns` is capped at 200 rows (safety). `setOptIn` still accepts a paused campaign; the list hides it.

## Admin list reads (panels package PB1)

- `GET /promotions/admin/promotions` (Viewer, usage counts only) and `/promotions/admin/promotions/costs` (manager) take
  `q` (name contains, or code starts with), `type` (comma-separated), `owner` (`PLATFORM` or `SELLER`), `funding`,
  `status` or `view` (not both), `sort` (`CREATED`, `STARTS`, `ENDS`, `NAME`, `USES`), `order`, `page` and `limit`
  (1 to 100, default 25). The answer is `{ items, total, page, limit, counts }`; every item has a `displayStatus`.
  Before this package the answer was `{ items }` and `status` was the stored status; `status=ACTIVE` now means live at
  this moment.
- Display status (`domain/display-status.ts`): the stored `PENDING_APPROVAL` and `REJECTED` show as they are. Otherwise a
  promotion whose end has passed is `ENDED` (live or paused), a paused one is `PAUSED`, and a live one is `SCHEDULED`
  before its start, `BUDGET_USED_UP` once its spend reaches its budget, and `ACTIVE` in between. Credit types
  (referral, cashback) keep their spend in the credits, so they are never `BUDGET_USED_UP`.
- `counts` holds `ALL` and every status plus `NEEDS_REVIEW` (promotions with an open review entry), for the same text,
  type, owner and funding filters but not the tab or status, so the tabs keep their numbers while one is open.
  The query is built in `prisma-promotion.repository.ts` and is checked against the stored rows by the database spec.
  No raw SQL: the budget compare reads the few promotions that have a budget with their spend and compares them in code.
- `GET /promotions/admin/promotions/:id/activity` (manager): create, edit, pause, resume and budget changes from the
  promotion's own audit rows, newest first, with who (named as identity allows) and each term's before and after (scalars
  and money only; a step-up proof is never shown). Keyset paging with `after` and `limit` (1 to 50, default 20).
- `GET /promotions/admin/promotions/:id/sellers` (manager): the opt-ins of a co-funded campaign, withdrawn ones kept.
  No seller names and no per-seller product count or cost share: sellers gives an admin no name through its facade, and
  the engine records spend per promotion, not per seller.
- `GET /promotions/admin/reviews/count` (manager): the number of open review entries.

## Open points

- The identity role seed gains one key: the Viewer (seed version 21 on top of blog's 20, with its append-only snapshot entry
  and pin) receives the unprotected `promotions.promotion.view`. No default role receives the manage
  keys yet; the Platform Administrator grants them in a custom role.
- Permission keys have three segments (`promotions.promotion.manage`, `promotions.promotion.view`,
  `promotions.own-promotion.manage`, `promotions.settings.view`, `promotions.settings.manage`).
- The first-order monthly budget is spent by package T2 (below).

## Package T2: redemption at checkout (part A, promotions side)

Migration `20261116120000_promotions_redemptions`. Ordering's checkout calls it in part B.

- **`promotions.redemptions`**: one row per order and promotion (unique `(market, order, promotion_key)`). The
  key is the promotion's id, `first-order` or `free-shipping:<zone>` (`kind` PROMOTION, FIRST_ORDER,
  FREE_SHIPPING). Amount with its seller and platform shares, the customer, the hash of a redeemed single-use
  code, the units of a flash sale, and for first-order rows the budget month (`YYYY-MM` in the Market zone,
  Market config `timezone`). Status RESERVED, then CONFIRMED (paid) or RELEASED (`ORDER_CANCELLED`, or
  `ORDER_REFUNDED` per the owner's refund rule). Never deleted; a trigger allows only RESERVED to CONFIRMED,
  RESERVED to RELEASED and CONFIRMED to RELEASED, with every other column unchanged, for every role; a row is
  inserted RESERVED (trigger). Each redeemed order also has a **head row** (`kind` ORDER, key `order`, zero
  amounts). A cancellation writes that row RELEASED when the order has none, so a cancellation and a redemption
  of one order always meet on the same unique key: whichever comes second sees the first, in either order.
  Backstop unique indexes: one live first-order row per customer, one live row per single-use code hash.
  Every cancelled order leaves one RELEASED head row, even without a discount (small, accepted growth); a
  reader of a customer's redemptions (the customer page) filters out `kind = 'ORDER'`. A repeat is compared
  with the stored rows per promotion (amount and shares); the per-line and per-shipping split is not stored
  here, it is ordering's.
- **`promotion_batch_codes.redeemed_order_id`**: set with `used_at` (CHECK both or neither); a trigger allows
  only claim (unused to used) and give back (used to unused). The app may now UPDATE those two columns and the
  `promotion_usage` counters (the core CHECK keeps them at zero or above).
- **Facade `redeem`** (rule `system`, use case `promotions.redeem-discounts`): ordering stores the order with the
  discounts of a `quote`, then asks to redeem them, sending the quote request and `discountSummaryOf(quote)`.
  In one unit: the order's rows are looked up (a repeat with the same discounts answers `already-redeemed`,
  with other discounts `validation.failed`; a released order `promotions.redemption-released`); the usage rows of the promotions the order took are locked in id order (and
  the Market's switch row when it took the first-order discount); everything is read again under the locks and
  the same calculation runs (`loadCart` + `priceCart`, shared with the quote). Equal to what the order holds: the
  code is claimed in one conditional update, the rows are written RESERVED and the counters move. Not equal (a
  budget, a total or per-customer use limit, the flash units or the code was taken meanwhile): nothing is
  written and the answer is `promotions.quote-changed` with the fresh quote, so the buyer confirms the new total.
  A lock that cannot be taken in time is `conflict.retry`. Off since the order was priced: `quote-changed` with
  the bare cart. The first-order discount is once per customer: a live first-order row of the customer on any
  order (two checkouts at once, an unpaid earlier order) prices the order as not the first. The fresh quote of a
  `quote-changed` was made with the order's old commission: ordering quotes again before it stores anything.
- **Subscribers**: `ordering.order-paid.v1` confirms the order's rows (`promotions.confirm-redemptions`);
  the new `ordering.order-cancelled.v1` (defined here, emitted by ordering in part B) releases them and gives
  back what they took: counters, budget, first-order money (the month's sum leaves the row out), the code
  (`promotions.release-cancelled-redemptions`). Both whatever the switch says now; both idempotent through
  the inbox. Confirm and release take the rows one at a time in key order (no deadlock between a payment and a
  cancellation of one order); a release re-checks the status under the lock, so a row confirmed meanwhile is
  still released and a row released already is never given back twice.
- **Quote changes**: `maxUsesPerCustomer` is now enforced, counting the customer's rows that hold; a quote
  without a customer gets no promotion that has the limit (fail closed), and the admin preview ignores it.
  The first-order discount takes what is left of the month's budget. The flash-sale counter
  (`RedemptionFlashSales`) sums the units of the rows that hold, so flash sales now apply to real orders.
- Not here yet: ordering's side (part B: the code at checkout, the discounts stored per line, the event, tax,
  Stripe, the ledger and refunds on the net amounts), the refund release (owner's decision pending), and a sweep
  of reservations whose order never settles (the order is stored before the redemption, so every row has an
  order that ordering cancels or confirms; the sweep covers a crash between them).

## Customers phase 4a, PR 4a-2: the seller's exclusive-customer discount (2026-11-17)

- New segment `SELLER_EXCLUSIVE` of the `CUSTOMER_GROUP` type: a seller's own discount for the
  customers who joined through its invite link (customers 4a-1). Seller-funded, on the seller's
  own lines (layer `SELLER_CART`), held to the Market's seller maximum like any seller promotion,
  and reviewed after publish like the store-follower offer. No days, group or zones.
- A seller may make `CUSTOMER_GROUP` only with this segment (any other: `segment.kind`
  not-allowed); an admin may not use this segment.
- The quote asks `customers.exclusiveSellerOf` (port `ExclusiveCustomers`, system actor only) once
  per quote, only when such a discount is live; unknown or failing answers fail closed (no
  discount). The admin preview takes `customer.exclusiveSellerId` and reads nothing.
- Migration `20261117060000_promotions_seller_exclusive_segment`: `promotions_type_funding_check`
  lets the seller pay a customer-group discount exactly for this segment; `promotions_phase3_check`
  accepts the segment with no days and no group. `down.sql` refuses while such rows exist.

## Customers phase 4c-1: the seller's cashback (2026-11-17)

- `CASHBACK` takes the segment `SELLER_EXCLUSIVE`: seller-funded, seller-owned, for its exclusive
  customers on its own seller orders. Market setting `promotions.cashback.sellerMinBps` (optional)
  is the least such a cashback may credit (`reward.bps` `below-market-minimum`).
- The order facts port now reads ordering's `deliveredSellerOrderFacts` (adapter
  `FacadeDeliveredOrderFacts`, system actor only; failures are unknown), so cashback runs for real.
  The facts carry the seller.
- New port `SellerCashbackLedger` (adapter on commission-payouts' `recordSellerCashback`): after
  the wallet grant of a seller-funded credit; `false` keeps the credit pending (retry).
- A real cashback waits for the payout release: `credit_issuances.grant_after` (migration
  `20261117120000_promotions_credit_grant_after`), port `PayoutAnchors` on commission-payouts,
  job `promotions.grant-due-credits` (use case of the same name, system). The guard trigger gains
  one move (PENDING to PENDING: end the wait, amount kept or lowered) and grants GRANTED only after
  the wait; the app role may update `amount_minor` and `grant_after`. A cashback PENDING with no
  wait for an hour is finished by the job as it is (its amount is final).
- A payout hold and a lost chargeback stop the cashback (Hassan M-2): the anchor also answers
  `onHold` (an active hold on the seller order or the whole seller) and `disputeLost` (dispute
  debits above what was reinstated). A held credit is put back for 6 hours, one whose facts cannot
  be read for an hour (`postpone`: the wait only grows, migration
  `20261117140000_promotions_credit_postpone`), so a credit the job cannot finish never keeps newer
  ones out of a run (Hassan L-4). A lost chargeback fails the credit `order-disputed`, and none is
  reserved for a seller order already lost; a currency that no longer matches fails it
  `currency-changed`.
- A refund claws back unused cashback (customers phase 4c-2): `promotions.claw-back-on-refund`
  (system) listens to `refund-succeeded.v1`. For a GRANTED cashback of that order it works out the
  share the refund takes (the cashback the remaining goods would still earn is kept), records it in
  `promotions_credit_clawbacks` (one row per credit and refund, and per credit and `seq`: two refunds
  racing on one credit cannot both take the same share), asks the wallet to take it back from that
  grant's unused lot (`wallet.claw-back-credit`, so spent credit is never taken), and for a
  seller-funded cashback returns what was taken to the seller's ledger
  (`refund-cashback-seller`). A row is settled DONE once, with what was actually taken. A credit
  still waiting is lowered by the job instead; one whose wait ended but is not yet granted makes the
  refund retry. A credit the grant job throws on is put back an hour (Hassan L-7).
- What a cashback keeps is pro rata to what it was earned on (Hassan H-2): `reserved_minor` (the
  amount reserved at delivery) and `goods_minor` (the goods it was earned on) are stored with the
  cashback and never change (no UPDATE grant, and the guard refuses it for any role; migration
  `20261117150003_promotions_credit_earned_basis`). The grant job and the clawback keep
  `ceil(reserved × goods kept / goods)` and never read the promotion's rate or the Market's limit
  again, so a seller who lowers its rate cannot cut or take back what was earned. A cashback with
  no basis (made before) is granted as reserved and never clawed back. The clawback counts only
  refunds that succeeded (`succeededRefundedGoods` from ordering, Hassan L-9); the grant job still
  counts pending ones too (conservative: a pending refund that later fails leaves the customer
  that part short, never the platform out of pocket).
- Known limits, accepted for now: credit held by an open checkout when the clawback runs is not
  taken later (Hassan L-10, small; the seller has paid it); a lasting seller-ledger failure after
  the wallet took the credit leaves the row PENDING and the event dead-lettered with an alert, for
  an operator to finish (L-11); a cashback PENDING with no wait that keeps failing stays at the
  front of the grant batch (L-13; availability only). The anchor's `disputeLost` reads the
  seller's dispute decisions and filters by seller order (L-12, fails closed). Migration
  `20261117150002_promotions_credit_clawbacks`: insert-only identity, PENDING to DONE only, no
  delete; `down.sql` refuses while rows exist.
- Migration `20261117100001_promotions_seller_cashback`: `promotions_type_funding_check` makes a
  cashback the seller's money exactly with the segment; `promotions_phase3_check` lets a cashback
  carry no segment or this one. `down.sql` refuses while such rows exist.
- The delivered seller order's facts come from ordering's facade, which promotions cannot import
  (ordering imports promotions for checkout): `DELIVERED_ORDER_FACTS` is a
  `BoundDeliveredOrderFacts` that `PromotionsOrderEventsModule` binds to ordering's facade at
  start-up; unbound or failing, it answers unknown and the handlers retry.
- The line "cashback X will be credited on date Y" (owner decision, 2026-11-17: credit after the
  payout release, plus a display-only line). `promotions.view-my-upcoming-cashback` (rule
  `own-resources`, `GET /promotions/cashback/upcoming?orderId=`, `no-store`) answers the signed-in
  customer's PENDING cashback, newest first (at most 20), optionally of one order: amount, currency
  and `creditOn` (the payout release; null once that has passed and it is on its way). It never
  touches a balance; promotions off answers an empty list. The storefront's order page shows one
  note per item under the summary. The storefront has no wallet page yet, so the wallet side of the
  line waits for one.

## Package T2: discounts at checkout (part B, ordering side)

Migration `20261117040000_ordering_discounts`: `order_lines` gains `discount_amount` with its seller and platform
shares (CHECK: shares at zero or above, they add up to the discount, the discount at most the line);
`seller_orders` gains `discount_amount` and `shipping_discount_amount` (within the goods and the delivery; the
total covers what is left); the cancel reason `discount-changed`. Existing rows read zero.

- **Checkout** (`start-checkout`, card `pay`): takes an optional `code` (trimmed, printable, at most 64; empty is
  none). Ordering quotes promotions under the customer's own `CallContext` (new own-session use cases
  `promotions.quote-own-discounts` and `promotions.redeem-own-discounts`, rule `own-resources`: a customer, not
  acting-as, only their own account, `testMode` always false; the facade picks the system or own use case by the
  actor). The quote carries each line's product (catalog), the delivery charges with the address's ServiceArea
  code as the zone, whether this is the customer's first paid order, and the order's commission; when the
  platform's share moves the commission, the quote is asked again (at most 3 times). A code that does not apply
  answers `ordering.discount-code-not-applied` (422) before anything is reserved.
- **Prices**: the discounts are stored per line and per seller order; tax is worked out on what the buyer pays
  (line minus discount, delivery minus its discount); the Stripe packages are the net goods, the net delivery
  and the added tax; the commission ledger gets each line minus its seller share; refunds are per unit of the
  net line (the shares floored cumulatively) and of the net delivery.
- **Redeem** runs after the order is stored, up to 3 times on `conflict.retry`. Any other failure cancels the
  order with `discount-changed` (stock released, `OrderCancelled` emitted): a changed quote or a released order
  re-prices and answers `ordering.price-changed` with the new total; nothing is charged.
- **`ordering.order-cancelled.v1`** is emitted whenever an unpaid order is cancelled (expiry, payment
  failure, superseded, a failed checkout). promotions subscribes to ordering's events from `PromotionsOrderEventsModule`, a
  binding module: ordering imports promotions, so `PromotionsModule` holds no ordering import (no file cycle).
- **Safety sweep** `ordering.settle-stale-redemptions` (worker, every 15 minutes, rule `system`), two passes:
  (1) ordering's own orders still waiting for payment with no money moved, whose payment page expired over an
  hour ago, are cancelled as `expired` (never voiding or stopping a payment; an order with a payment held is
  left to its payment events); (2) promotions lists, in pages by order id (`promotions.list-stale-redemptions`,
  at most 100 a page, read only), the orders still holding RESERVED rows written before the payment window plus
  one hour; confirmed confirms them, cancelled or unknown releases them (`promotions.settle-redemptions`), and an
  order still waiting is passed over (paging by id, so it never blocks the rest) and logged as a warning. It
  lives in ordering because promotions cannot read ordering without a cycle.
- **Limits**: a checkout with a code is counted per account (10 per 10-minute window of the `checkout-payment`
  counter, applied or not), so the code answer is no guessing oracle. An order the discounts make free is
  refused (`ordering.check-unavailable`) before anything is reserved; a seller part at no cost sends no Stripe
  line.
- Follow-ups: orders at no cost (a 100% voucher) need an owner decision; manual-group audiences do not match under the customer's context yet (customers' group check is
  system-only); the web checkout's code box still checks the sample codes, because the storefront's Pay is not
  wired to `POST /orders/pay` yet (the live checkout sends the code once it is); the refund release waits for the
  owner's decision.
- **Part C (panels)**: the admin and seller order pages and the admin order document show each line's discount
  and the seller order's goods and delivery discounts (rows only when above zero); the admin names the cancel
  reason `discount-changed`. The buyer's account orders read the same fields and total what the buyer paid.
- **A customer's usages** (customers management phase 2b, item e; 17 Nov 2026):
  `GET promotions/admin/customers/:customerAccountId/usages` (`promotions.list-customer-promotion-usages`,
  `promotions.promotion.view` and `customers.customers.view`, like every customer-page tab; admin only, refused in
  an acting-as session). One row per discount an order of the
  customer took (stored promotion with its name, first-order offer or zone free delivery; never an order's head
  row), newest reservation first then id, keyset pages of 1 to 100 (default 50) through
  `redemptions_customer_newest_idx`. A row carries the order, the discount (minor units and currency), whether a
  single-use code was used (the code is never kept), the status (RESERVED can still be released; only CONFIRMED
  counts as used), the release reason and the three instants; never the seller or platform share. Works while the
  Market switch is off. No migration. `usedAt` is the reservation instant (when checkout took the discount);
  `confirmedAt` and `releasedAt` say how it ended. There is no total: the tab pages with "Load more", like the
  other per-customer histories. It is a plain table, not a super list (rule 14): one customer's discounts rarely
  pass 50 rows; if the product wants a super list here, filters and a count are a follow-up.
