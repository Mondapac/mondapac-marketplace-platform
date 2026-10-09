# Cart — design part of the combined gate (tier B)

**Author:** Mohammad (software-architect) — 2026-10-07
**Status:** Design part of the combined gate: Ali (cto) approve with changes, Hassan (security-tester) approve with conditions, Mojtaba (database-designer) approve with changes, Hadi (product-owner) decisions — all applied 2026-10-07. **Approved with conditions 2026-10-07** (Ali, cto, final verdict after Hadi's brief edits; Bagher, QC, final check; 16). Sellers G2 (PR #46) and its minimum-order mini-review (PR #47) are merged and accept SC1–SC3 (7.1); catalog G2 is merged (PR #54) and accepts CC1–CC3 as ruled with two refinements, applied here (K-1, 7.1). Follow-up: Reza (ui-ux-designer) pending, UI condition.
**Ground truth:** `docs/modules/cart/brief.md` (domain part of the combined gate approved by the owner 2026-10-07; sections, owner answers and acceptance criteria are cited as "brief s5", "Q3", "AC"; Hassan's rewrite of the guest-cart rules as "brief s5 guest"); `docs/features/03-cart-orders-returns.md` section 1 (CRT-01..09; CRT-09 is the guest cart); ADR-0001, 0002, 0003, 0004 (decision 1: carts in PostgreSQL, `cart` schema, Redis never the source of truth), 0005, 0006, 0007, 0008, 0010, 0013, 0018, 0019, 0020, 0022, 0024 (decision 5: read-time composition decided at this gate); `docs/design/domain/identity.md` ("ID 6.4"), `platform-foundations.md` ("PF 6.2"), `platform-persistence-and-events.md` ("PE 3.1"); `docs/design/domain/inventory.md` ("INV 7.1") and `docs/design/domain/pricing.md` ("PRC 6.2"), as in PRs #43 and #44 (2026-10-07, Ali's and Hassan's reviews applied).
**Catalog G2:** approved and merged (PR #54, 0bad228; `docs/design/domain/catalog.md`). What cart needs from it is listed as named dependencies (7.1) and taken from that design ("CAT 9.1", "CAT 9.7", "CAT 18 K-1"), with Hassan's L3 (anonymous callers get badge data only for `active` tags; other tags left out); its 9.7 and 18 accept CC1–CC3 as ruled, and the merged text differs from the draft 25cbf3a only by additions this design already follows, so no mini-review is needed. The `sellers` contracts SC1–SC3 are taken from `docs/design/domain/sellers.md` 7.1 and 18 (merged, PRs #46 and #47).

## 1. Scope

A design, not an implementation. Signatures appear only where the signature is the contract.

- **Decided here:** domain model (2), states (3), guest identity and cookie (4), authorisation (5), the use-case rules (6), boundary, facade and events (7), dimensions (8), enforcement points (9), idempotency and concurrency (10), the physical data model for Mojtaba (11), jobs (12), slices (13), dependencies (14).
- **Not here:** checkout, shipping method, payment and tax (`ordering`, Phase 5; brief s3); reservation (`inventory`'s ordering port); coupons (CRT-06); CRT-04 "other sellers" (P1, with the storefront).
- **AI:** none at launch (brief s3). Cart publishes no AI tool and imports nothing from `platform/ai`.

### 1.1 Brief slices and where they are covered
| Brief s11 slice | Sections |
|---|---|
| 1. Signed-in cart: add, change quantity, remove, line ceiling (CRT-01, CRT-02) | 2, 6.1, 9 |
| 2. Grouped view, "Sold by", read-time sellable state, price-change notice (CRT-03) | 6.2, 6.3 |
| 3. Guest cart and merge (CRT-09, CRT-08), security review | 4, 6.5 |
| 4. Optional minimum order per seller (CRT-05) | 6.4 |
| 5. Hand-off to `ordering`, 90/7-day purge, order-placed and account-erased handling (with Phase 5) | 6.6, 6.7, 12 |
| 6. P1: CRT-04 | Deferred (13) |

## 2. Domain model

### 2.1 Aggregates
**`Cart` (root)** — one aggregate per cart; lines change only through the root.

| Field | Meaning |
|---|---|
| `id` | UUIDv7 |
| `marketId`, `tenantId` | One Market per cart (brief s5); tenant is the platform seam (ADR-0001) |
| `owner` | Exactly one of `{ kind: 'account', accountId }` or `{ kind: 'guest', tokenHash }` (brief s5). The raw guest token is never held by the aggregate after creation |
| `status` | `ACTIVE` or `MERGED` (3.1) |
| `lastChangedAt` | Instant of the last change made by the cart's owner (6.1, 6.5); drives retention (Q3) |
| `mergedIntoCartId`, `mergedAt` | Set only when `MERGED` |
| `version` | PE 10 |
| `lines` | `CartLine[]`, unique on (`offerId`, `variantId`) |

**`CartLine` (entity inside `Cart`)**

| Field | Meaning |
|---|---|
| `id` | UUIDv7; addressed by the client for change and remove |
| `offerId`, `variantId` | The sell unit. The Offer fixes the seller, so "a separate line per (seller, Offer, Variant)" (CRT-02) is the uniqueness on (Offer, Variant) |
| `quantity` | `LineQuantity` value object: integer, 1 ≤ q ≤ the Market ceiling (brief s5; Q6) |
| `priceAtAdd` | `Money`. Only for detecting a price change (Q4); never a price source, never handed to `ordering` (brief s5) |
| `addedAt` | Instant; decides "the older price at add" in a merge (6.5) |

**Value objects and domain services (all in `cart/domain`, pure, no I/O)**
- `LineQuantity`, `GuestTokenHash` (32 bytes), `Money` (kernel).
- `LineCeilingPolicy`: `limit(ceiling, availability)` = `min(ceiling, onlyLeft)` when the status is `LOW`, else `ceiling` (6.1).
- `LineEvaluator`: turns the facade answers for one line into a line state and reason (6.2).
- `CartEvaluator`: groups lines by seller, sums buyable lines per seller, applies the minimum order (6.4) and answers "ready for checkout" (6.6).
- `MergePolicy`: the line rules of 6.5.

### 2.2 What is deliberately not stored
- **Sellable state, seller, display name, effective price, availability, badges.** Composed at read time (brief s5; ADR-0024 decision 5). No read model at launch (brief s5). Confirmed at G2 (Ali, A-3). Revisit only with a measured view latency over budget, as its own reviewed design.
- **Seller id on the line.** Derived from the Offer through `catalog`; storing it would be a second copy of catalog's data.
- **No Redis cache** at launch. ADR-0004 allows Redis only as a cache; a cached may-sell answer would let a suspended seller sell until it expires (ADR-0022 consequences), so any cache is its own reviewed design. Confirmed at G2 (Ali, A-3).
- **No reservation, no frozen price, no tax** (brief s3, s5; ADR-0007 decision 8).

### 2.3 Modelling choices that need a reason
| Choice | Reason |
|---|---|
| One aggregate holds header and lines | The line limit, the uniqueness per (Offer, Variant) and `lastChangedAt` are cart-wide invariants; one version column guards them (PE 10) |
| A guest cart and an account cart are the same aggregate with a different `owner` | Merge and ownership transfer (6.5) become a change of `owner` or `status`, not a copy between two models |
| A guest cart is created on the first add, never on a view | No row for a visitor who only looks; bounds database growth together with the rate limit (brief s8 risk) |
| An add is refused when the line would be unbuyable at that moment, including "no valid price" | Brief s4 flow 1 checks the Offer, the seller and the stock at add; `priceAtAdd` needs a price, and a line without one would arrive unbuyable. Confirmed (Hadi, Q-H3) |

## 3. States

### 3.1 Cart status: `ACTIVE` → `MERGED`
| From | To | Trigger | Rule |
|---|---|---|---|
| (new) | `ACTIVE` | First add by a signed-in customer without a cart, or by a guest | One `ACTIVE` account cart per (Market, account) (unique, 11) |
| `ACTIVE` guest | `ACTIVE` account | `mergeGuestCart` when the account has no cart (6.5) | Ownership transfer: `owner` becomes the account, the token hash is removed; the old cookie stops working |
| `ACTIVE` guest | `MERGED` | `mergeGuestCart` when the account has a cart (6.5) | Lines copied into the account cart under 6.5; terminal |
| any | (deleted) | Purge (12), account erasure (6.7) | — |

Forbidden: `MERGED` → anything; an account cart → `MERGED`; a guest cart that is `MERGED` or expired is never read or written as a cart (it answers "no cart").

**Expiry is decided at read time** (PE 7, "validity never depends on a job"): a cart whose `lastChangedAt + retention ≤ Clock.now()` is treated as having no lines. The next write by its owner starts again: an account cart keeps its row and loses its lines in that unit; a guest gets a new cart and a new token (the expired token never regains a cart). The purge job (12) only deletes what is already invalid.

### 3.2 Line state (derived on every read, never stored)
`BUYABLE`, or `UNBUYABLE` with one reason, by this precedence (first match wins, so the client shows one cause):
1. `offer-unavailable` — `catalog.offerListings` (CC1) leaves the key out of a successful answer, or answers it with `listed: false` or `variantBelongs: false`. One reason, no cause shown: `listed` carries no reason code (CAT 9.7 refinement a), and cart infers nothing else from an absent key (unknown, other Market, deleted, never published and unpublished product all look the same, by design).
2. `seller-cannot-sell` — the may-sell contract says no or failed (ADR-0022 decision 6, fail closed).
3. `no-valid-price` — `pricing` answers `no-valid-price` (PRC 6.2).
4. `out-of-stock` — `inventory` status `OUT`.
5. `reduce-quantity` — status `LOW` and `quantity > onlyLeft`; `onlyLeft` is public (INV 5.4), so it may be shown.
6. `check-unavailable` — a facade call for this line failed or answered outside its contract (for example a currency that is not the Market's). Fail closed: not in totals, blocks checkout.

A failed catalog call or a batch refusal (`batch.too-large` from catalog, `*.batch.too-large` from the others; an oversized batch is refused whole) → `check-unavailable` for every affected line. `offer-unavailable` only when a key is absent from a successful answer or answered `listed: false` or `variantBelongs: false` (Ali, change 4; K-1).

`listed: true` is never permission to buy (Ali, K-1): `BUYABLE` still needs `variantBelongs: true`, may-sell (2), a price (3) and availability (4, 5), and `ordering` re-checks everything at checkout. Every batch facade read here, `offerListings` included, is advisory (ADR-0025 decision 1).

`reduce-quantity` is the only reason the customer clears by changing the quantity; it is the brief's "reduce the quantity" message (brief s4 flow 2). With `IN_STOCK` cart cannot know that a quantity exceeds the stock, because `getAvailability` takes no quantity and answers no exact number (Hassan, Q-S1, INV 7.1). That case is caught by `inventory.reserve` at checkout (`not-enough`, no number) and shown by `ordering`. Decided (Hadi, Q-H3): cart shows "reduce the quantity" only when the status is `LOW`; otherwise `ordering` shows it at reservation.

## 4. Guest identity and cookie (brief s5 guest; Hassan)

| Topic | Design |
|---|---|
| Token | 32 bytes from the platform CSPRNG (256 bits; brief floor 128), base64url in the cookie. Minted inside the create unit; the raw value goes only into `Set-Cookie` |
| Stored | SHA-256 of the token only (`GuestTokenHash`; the session-token convention, identity data C6). Lookup by equality on (Market, hash) |
| Cookie | `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain` (ID 6.4 pattern). The name ends with the Market code, so carts of two Markets never share a cookie. Decided (Hassan, H-2): name `__Host-cart-guest-<market>`, `Secure; HttpOnly; SameSite=Lax; Path=/`, no `Domain`, `Max-Age=604800` renewed on each change; cleared with the same attributes and `Max-Age=0`. The `__Host-` prefix is required: it stops a sibling subdomain from planting a guest cart (cart fixation) |
| Never | In a URL, a request body, a response body, a log line, an event or an audit row. The request `Cookie` header and the response `Set-Cookie` header are redacted by the platform logger, in request and response logs and in traces (Hassan, Low finding) |
| Server-side expiry | 7 days after `lastChangedAt` (Q3), decided at read time from `Clock` (3.1), independent of the cookie's `Max-Age` |
| Invalid cookie | Malformed, unknown, expired, `MERGED`, or the name repeated in one request (the HF7 rule): treated as "no guest cart" and the cookie is cleared. No distinct answer, so a probe learns nothing |
| CSRF | Guest writes are unsafe requests without a session. The platform origin check of ID 6.4 already applies to every unsafe request ("with or without a session"); plus `SameSite=Lax`. Decided (Hassan, H-2): no separate token for guest writes, which holds only under three **requirements** on every cart route: (1) **strict content type**: only `application/json` is accepted, checked before the body is parsed; `text/plain`, form content types or no content type are refused (this stops cross-site form posts; slice-3 test: a `text/plain` request with a JSON body gets `request.csrf` or 415); (2) **no state change on a safe method**: viewing never creates a cart or sets a cookie; (3) **no CORS with credentials** on cart routes. The merge carries a session cookie and therefore `x-csrf-token` (6.5) |
| Rate limits | Through the platform rate limiter, per Market; origin = IPv4 address or IPv6 /64. Counters are kept **in PostgreSQL with HMAC keys and fixed windows**, the same way as ID 6.8, never in memory per instance (which would multiply the limits by the instance count and could never be "unavailable"); the trust-proxy setting is a dependency of slice 3 (Hassan, Medium finding). Decided numbers (Hassan, H-1): guest-cart creation 30 per 60 minutes per (Market, origin) (CGNAT; cost bounded by 30 carts × 50 lines); guest line writes 120 per 15 minutes per (Market, origin) and 60 per 15 minutes per guest cart (the client debounces the quantity stepper); merge, guest view and account-cart writes: the generic limiter (20 or 300 per minute). Fixed windows, refused until the window ends, no longer lockout; only writes are throttled, viewing never. Over the limit: `request.throttled` with `retryAfterSeconds`. Limiter unavailable: `access.unavailable`, nothing written (fail closed, INV 5.4 pattern) |
| Personal data | None in a guest cart (brief s9). No origin address is stored outside the keyed counters |

## 5. Authorisation (ADR-0018 decision 4; ID 5.2; PF 6.2)

Every use case extends the platform `UseCase` with one access declaration. Cart declares no permission key: a customer's own cart is `own-resources` (PF 6.2 row 2: customer resources join this kind at their module's gate, C6), and a guest cart is `anonymous`. Every declaration goes into the checked-in list of non-permission rules (PF 6.2 row 5). Signed-in use cases are for the `customer` population only: `handle` refuses another population with `access.denied`. `whenSellerNotApproved: 'deny'` is declared where the mechanism requires it (it never applies to a customer).

Under `anonymous` the gate passes the anonymous actor (ID 5.1), so the guest use cases never see an account; the cart is selected **only** by the token hash from the cookie of the same request. A signed-in request uses the account cart and ignores any guest cookie except in `mergeGuestCart`.

| Use case | Entry | Rule | Ownership check in `handle` |
|---|---|---|---|
| `cart.view-cart`, `cart.add-line`, `cart.change-line-quantity`, `cart.remove-line` | HTTP (storefront, customer session) | `own-resources` | The cart is the actor's account cart in this Market; a `lineId` not in it answers `cart.line-not-found`, identical to an unknown id, and the denial is logged (AC "customer A, customer B") |
| `cart.guest-view-cart`, `cart.guest-add-line`, `cart.guest-change-line-quantity`, `cart.guest-remove-line` | HTTP (no session) | `anonymous` | The cart is the one whose hash matches the cookie; a `lineId` not in it answers `cart.line-not-found` |
| `cart.merge-guest-cart` | HTTP, called by the client right after sign-in or sign-up (brief s4 flow 4) | `own-resources` | Guest cart by the cookie of this request only, in this Market; target is the actor's account cart |
| `cart.get-checkout-lines` | Facade, called by `ordering` in the customer's request | `own-resources` | The actor's account cart only. A guest gets `access.unauthenticated`, which the client turns into the sign-in prompt (Q1) |
| `cart.clear-purchased-lines` | Facade, called only by `ordering` (7.2; A-1 option A) | `system` | `accountId` and `cartId` from the call, Market from the context; refused when the cart's account ≠ `accountId` |
| `cart.delete-account-cart` | Event handler (6.7) | `system` | Account from the envelope payload |
| `cart.purge-inactive` | Job (12) | `system` | — |

Acting-as (SEL-08) concerns seller sessions only; no cart use case runs under it. There is no admin use case at launch (brief s2).

**Answer codes** (minimum body of ID 5.2): `cart.offer-not-purchasable` (`details.reason`: the codes of 3.2 except `reduce-quantity`), `cart.line-not-found`, `cart.too-many-lines` (Q-H1, decided), `cart.not-ready` (`details.lines: [{lineId, reason}]`, `details.sellers: [{sellerId, reason: 'below-minimum', minimum}]`), plus `validation.failed`, `access.unauthenticated`, `access.denied`, `access.unavailable`, `request.throttled`, `request.csrf`, `conflict.stale`, `conflict.retry`. Messages are codes; wording is Jafar's and Reza's (brief s9: text, not colour only).

## 6. Use-case rules

### 6.1 Add, change quantity, remove (CRT-01, CRT-02; brief s4 flow 1)
Input of add: `{offerId, variantId, quantity}`. Any price or currency field is never read (brief s5); the DTO has no such field. `quantity` is an integer ≥ 1 with at most 9 digits (`validation.failed` otherwise).

Add, in order (PE 3.1 row 5: facade reads first, then one short write unit):
1. Guest only: if no valid guest cart exists, reserve a creation count (4); always reserve a line-write count. Over the limit → `request.throttled`. The creation count is used even when the add is then refused (for example `offer-unavailable`); this is deliberate for stopping abuse and must not be moved after the write (Hassan, Low finding).
2. Read the cart (read-only unit).
3. Facade reads for the one key (7.1): `catalog.offerListings` first; if it answers the key present with `listed: true` and `variantBelongs: true`, then `sellers.sellingEligibility` for its seller, `pricing` and `inventory` in parallel (pricing's H5: raw ids reach `pricing` only after `catalog` answered them as published).
4. `LineEvaluator`: any reason 1–4 or 6 of 3.2 → `cart.offer-not-purchasable` with that reason; nothing is written. An Offer of another Market is absent from catalog's answer → `offer-unavailable` (AC "Offer of another Market"); so are an unknown, deleted or never-published Offer and an unpublished product, and `listed: false` (3.2 reason 1).
5. Target = existing quantity (0 if no line) + requested, then `min(target, LineCeilingPolicy.limit)`, where the ceiling is `MarketConfig.maxLineQuantity` (AU 99, Ali). If the limited target is not above the existing quantity, the line is left as it is. The answer says `clamped: 'market-ceiling' | 'only-left'` when it limited the request (AC "ceiling 99, stock 200, 120 → 99").
6. Open the write unit: reload the cart by version; check the line limit (Q-H1: the per-Market limit, AU 50; a new line over it → `cart.too-many-lines`); create the cart if none (guest: mint the token, 4); create or update the line; a new line takes `priceAtAdd` = the effective `unitPrice` and `addedAt` = now; set `lastChangedAt`; save.

Change quantity: absolute value, the same limit as step 5 (needs the `inventory` read of that key only), no purchasability refusal (an unbuyable line can still be lowered). Remove: no facade read. Both set `lastChangedAt`. Quantity 0 is not accepted; the client calls remove. A change that actually changes the line's quantity, and a re-add of an existing line, set `priceAtAdd` to the current effective price (Q-H2, 6.3).

### 6.2 Read-time composition (brief s4 flow 2; brief s5 "sellable")
`cart.view-cart` / `cart.guest-view-cart`:
1. Read the cart (read-only unit). No cart, or expired (3.1) → an empty cart.
2. One `catalog.offerListings` batch for all keys (≤ 200, the batch limit of catalog, pricing and inventory; the line limit of ≤ 50 keeps a view under it, 8).
3. In parallel, for the keys `catalog` answered present with `listed: true` and `variantBelongs: true`: `sellers.sellingEligibility` and `sellers.sellerSummaries` for the distinct seller ids (may-sell and "Sold by" name, 7.1; at most 50 ids, under the facade's 100), one `pricing.getEffectivePrices`, one `inventory.getAvailability`.
4. `LineEvaluator` per line (3.2), then `CartEvaluator` (6.4).

So one view makes five facade calls in two rounds, whatever the number of lines (brief s9: 20 lines from 5 sellers in one request). A facade error marks the affected lines `check-unavailable` (a failed catalog call or `*.batch.too-large` → `check-unavailable` for every affected line; `offer-unavailable` only when a key is absent from a successful answer); the view still answers (fail closed for buying, not for seeing). The answer per seller group: `sellerId`, "Sold by" display name (CRT-03), lines, subtotal of buyable lines, minimum-order state. Per line: ids, display data (product name, Variant label, primary image key) and, per tag, the badge data exactly as `catalog` returns it; `offerListings` returns only `active` tags with their badge data and leaves suspended and rechecking tags out (Hassan, L3), and cart shows a certification chip only when badge data is present and builds no claim text (brief s5); quantity, state and reason, `unitPrice` and line amount when priced, `taxInclusive` as `pricing` returns it, the price-change notice (6.3), and `onlyLeft` when `LOW`. Totals: per seller and for the cart, over buyable lines only, in the Market currency (ADR-0007 decision 1; arithmetic across currencies throws, which 3.2 reason 6 prevents). A key absent from catalog's answer has no display data and no chip; the line shows its state only.

### 6.3 Price-change notice (Q4)
When a line is priced and `unitPrice ≠ priceAtAdd` (amount or currency), the line carries `priceChanged: { previous: priceAtAdd }` beside the current `unitPrice`. The current effective price is always the one shown and summed; a price pending review is never shown, because `pricing` never answers one (PRC 4.1 step 5). Decided (Hadi, Q-H2): the notice clears when a write actually changes that line (quantity change, or re-add; remove and re-add counts as a change); `priceAtAdd` then becomes the current effective price. A merge does not clear it; a refused or no-op add does not clear it.

### 6.4 Minimum order per seller (CRT-05; Q5)
- Data: `sellers` holds an optional minimum per seller on its store profile, `Money` in the Market currency, > 0 and at most the Market's `minimumOrderMax`; none = any amount (default). Cart reads it as `minimumOrder` in the same `sellerSummaries` call as the "Sold by" name (sellers 18, merged in PR #47; 7.1 SC3): none or `Money` for an approved seller; the field is **absent** for a seller without an approved revision and when the stored currency differs from the Market's (sellers logs the error).
- Rule (`CartEvaluator`): for a seller group with at least one buyable line, if the subtotal of its buyable lines is below the minimum, the group is `below-minimum` with the minimum (public) and checkout is blocked with a message for that seller only. Adding more from that seller clears it (AC CRT-05). The subtotal uses the effective unit prices, which in AU are GST-inclusive, without shipping (brief s5). Decided (Ali, A-2): the minimum is compared with the subtotal of effective unit prices in the Market's display convention (`MarketConfig.pricesIncludeTax`); the seller's minimum is entered and labelled in that same convention, and cart computes no tax (ADR-0007 decision 4). Mixed `taxInclusive` flags within one seller group → `check-unavailable`.
- Fail closed: for a seller group with a buyable line, an absent `minimumOrder`, a `Money` in another currency, or a `sellers` failure makes the group `check-unavailable`. "None" and "absent" are never confused: only an explicit none means any amount. A change applies to open carts on their next read; `sellers` publishes no event for it (sellers 18 decision 7).
- `ordering` re-applies the minimum on the server (brief s5).

### 6.5 Merge (CRT-08; brief s4 flow 4, s5 merge)
`cart.merge-guest-cart`, synchronous, in the signed-in request, from the cookie of that same request only (never from a sign-in event; `identity` does not know carts). The request carries a session cookie, so it must also carry `x-csrf-token` (ID 6.4; Hassan, H-2); it is limited by the generic limiter (4):
1. Hash the cookie token; read the guest cart by (this Market, hash). None, expired, or `MERGED` → `ok` with nothing merged (idempotent replay). "Same Market" is structural: the lookup and the actor's Market are both this request's Market (the gate compares them, ID 5.2), and the cookie name carries the Market.
2. Read the account cart. For keys present in both, one `inventory.getAvailability` batch.
3. One write unit, reloading both carts by version:
   - **Account has no cart:** transfer ownership: `owner` becomes the account, the token hash is removed, `lastChangedAt` = now (the account retention applies from here).
   - **Account has a cart:** for each guest line, if the account cart has the same (Offer, Variant): quantity = `min(sum, LineCeilingPolicy.limit)` and the line keeps the `priceAtAdd` and `addedAt` of whichever line was added earlier (brief s5); otherwise the guest line is added as it is (its quantity is already ≤ the ceiling). Line limit (Hadi, Q-H1): account lines stay; new guest lines are added oldest first (`addedAt`) until the limit; the rest are reported. A merge does not clear a price-change notice (Q-H2). The guest cart becomes `MERGED` with `mergedIntoCartId` and `mergedAt`; its lines are deleted in the same unit; its hash stays until the purge so a replay is recognised in step 1. The account cart's `lastChangedAt` = now.
4. Every outcome clears the guest cookie (`Max-Age=0`); a later guest cart gets a new token (brief s5 "cleared and rotated").
5. Concurrency: two merges of the same cookie (two tabs) serialise on the version; the loser re-reads once and finds `MERGED` or transferred → `ok`. Two transfers to one account collide on the unique "one account cart" key (`P2002`) → re-run as a merge.
Answer: counts, the lines that were limited (`clamped`) and the guest lines not added because of the line limit. No facade other than `inventory` is needed: the merged cart's sellable state is composed on the next view.

### 6.6 Hand-off to `ordering` (brief s4 flow 5)
`get-checkout-lines(ctx)` re-runs 6.2 for the actor's account cart. Ready when every line is `BUYABLE` and no seller is `below-minimum`; otherwise `cart.not-ready` with the per-line and per-seller codes. Ready → `{ cartId, lines: [{offerId, variantId, quantity}] }`: no price, no `priceAtAdd`, no seller id, no badge (brief s5). `ordering` re-checks every line, the ceiling and the minimum, and freezes prices itself (ADR-0007 decision 8, VER-06); it never trusts cart. Cart does not reserve stock (brief s3).

### 6.7 Order placed and account erased
- **Order placed:** removes from the customer's account cart the lines whose (Offer, Variant) were bought (brief s6), idempotent per order. It does not change `lastChangedAt` (a system change, not the owner's). Decided (Ali, A-1 option A): `ordering`, from its own handler of its own order-placed event, calls `cart.clearPurchasedLines` (7.2); cart consumes no `ordering` event and imports no `ordering` contract.
- **Account erased:** handler on `identity`'s erasure event (name at the identity mini-review; 14), `runOnce` with the inbox, deletes the account's cart and lines. Erasure of customer accounts is CUS-03 (P2), so until that event exists the 90-day purge is the bound (brief s5).
- **Offer deleted, seller suspended, price or stock changed:** no event needed; the next read marks the line (brief s6).

## 7. Boundary

`cart` imports only `contracts/` of `catalog`, `sellers`, `pricing`, `inventory` and `identity` (the gate and `ActorContext`; its erasure event), plus the kernel and `platform/`. Nothing imports cart except `ordering` (7.2); cart imports no `ordering` contract, so there is no cycle (A-1). No other module reads cart's tables, and cart reads no other module's tables (ADR-0008 decision 5).

### 7.1 What cart needs from others
| # | From | Need | Status |
|---|---|---|---|
| CC1 | `catalog` facade (catalog G2) | Batch, ≤ 200 (Offer, Variant) keys, `anonymous`, published state only: per key `sellerId`, sale state (on sale, or not, from catalog's own Offer state: ADR-0010 decision 3), whether the Variant belongs to the Offer's product, display data (product title, Variant label, primary image reference), and the certification badge structure as catalog shows it (built from `evaluateClaim`). Unknown, foreign-Market and deleted keys are absent | Accepted by catalog G2 (merged PR #54; CAT 9.1, 9.7; K-1, ruled) with two refinements: `offerListings(ctx, keys: {offerId, variantId}[])`, ≤ 200, `anonymous` and `system`, published state only; per key `sellerId`, `productId`, (a) `listed: boolean` with no reason code, `variantBelongs`, display data (product name, Variant label, primary image key), `publishedRevisionId`, and tags: (b) only `active` tags, each with its badge data; suspended and rechecking tags are left out (Hassan, L3, in the merged catalog G2). Keys whose Offer is unknown, of another Market, deleted or never published, or whose product is not published, are absent. Advisory (ADR-0025 decision 1); an oversized call is refused whole with `batch.too-large` |
| CC2 | `catalog` | Every sell unit has a stable Variant id (a Simple product has exactly one), the assumption of INV 13 | Match in catalog G2 (merged PR #54; CAT 9.7, M-1): a Variant id is never reused or revived |
| CC3 | `catalog` | `Offer` and `Variant` id types from `contracts/` | Match in catalog G2 (merged PR #54; CAT 9.7): branded `Id<'Offer'>`, `Id<'Variant'>` from `catalog/contracts/` |
| SC1 | `sellers` facade (sellers G2) | The may-sell contract for a set of seller ids, fail closed (ADR-0022 decision 6) | Accepted at sellers G2 (merged, PR #46): `sellingEligibility(ctx, sellerIds)` → `{ eligible }` per id, ≤ 100 ids, `anonymous` and `system`, no reason code, unknown id or error = not eligible (sellers 7.1, 7.2) |
| SC2 | `sellers` | Public display name per seller ("Sold by", CRT-03), batch | Accepted at sellers G2: `sellerSummaries(ctx, sellerIds)`, the public store name once approved, ≤ 100 ids, `anonymous` (sellers 7.1). An eligible seller always has an approved revision, so a buyable line always has a name; a missing name shows the line's group without one and changes no line state |
| SC3 | `sellers` (mini-review; brief s8, s11) | Optional minimum order per seller: `Money` in the Market currency, > 0, or none (default) | Accepted by the sellers mini-review (sellers 18, merged in PR #47): `minimumOrder` on `sellerSummaries`, none or `Money` for an approved seller, absent otherwise and on a currency mismatch; set under `sellers.store-settings.edit` (or an admin under `sellers.seller.edit`), version-checked, audited, no event. Built in sellers slice 20, before cart slice 4 |
| PC1 | `pricing` | `getEffectivePrices` (PRC 6.2), ≤ 200 keys, `anonymous` | Designed |
| IC1 | `inventory` | `getAvailability` (INV 7.1), ≤ 200 keys, `anonymous`, no quantity, no exact number | Designed |
| ID1 | `identity` | Customer sessions and `ActorContext`; the origin check for unsafe anonymous requests (ID 6.4); an event when a customer account is erased (CUS-03) | Event: identity mini-review when CUS-03 is designed |
| PL1 | `platform/` | `MarketConfig.maxLineQuantity` (the shared-file PR announced on the board, Ali A2); the rate limiter; scheduler; inbox and `runOnce`; `Clock`, `IdGenerator`, UnitOfWork | `maxLineQuantity` shared with inventory's follow-up |

The sellers G2 serves SC1 and SC2 as two batch methods, so a view makes two `sellers` calls in the same round (6.2); SC3 rides on `sellerSummaries`, so it adds no call. Ali ruled this within ADR-0022 decision 6, which forbids a call per seller, not one batched call to each of two contracts, under three conditions: each contract is called once per request with the deduplicated seller ids, in parallel, and a test asserts the call counts; may-sell is never derived from `sellerSummaries`; the cart's line limit (≤ 50, 8) keeps distinct sellers at or under the facade's 100, so the call is never split into chunks.

### 7.2 Public facade (`modules/cart/contracts/cart.facade.ts`)
| Method | Rule | Notes |
|---|---|---|
| `getCheckoutLines(ctx)` | `own-resources` | 6.6 |
| `clearPurchasedLines(ctx, {orderId, cartId, accountId, lines})` | `system` | A-1 option A (Ali). `orderId` is cart's own `uuid` type; cart never imports `ordering` contracts. Refused when the cart's account ≠ `accountId`. Idempotent per `orderId` (clearance row, 11) |

Named boundary rule: only `modules/ordering` imports `cart.facade` (the pattern of INV 7.2). This G2 approves slices 1–4. `getCheckoutLines`, `clearPurchasedLines` and slice 5 are re-confirmed by a mini-review at ordering's G2.

### 7.3 Events
- **Published:** none at launch (brief s6). No `cart.outbox` table until a consumer appears.
- **Consumed:** `identity`'s customer-account erasure event (6.7). No `ordering` event (A-1 option A).

## 8. Market, tenant and time
- `market_id` and `tenant_id` on every row; every repository takes `MarketContext`; the guard enforces equality with the unit's Market (PE 4.1). The Market comes from the request (`x-market-id`, ADR-0020 decision 3), the envelope or the job; never a default.
- Per-Market values, none hardcoded: the line ceiling from `MarketConfig.maxLineQuantity` (shared, Ali A2); guest and account retention (`P7D`, `P90D` for AU; Q3) and the line limit (Q-H1) in cart's own per-Market policy, read by cart only, checked at boot for every hosted Market, with no default (Ali A2).
- Retention is an exact duration from `lastChangedAt` (a UTC instant from `Clock`), not a local calendar day, so no zone is needed (ADR-0005 decision 1). No raw `Date` arithmetic in `domain/`.
- A per-Market line limit is mandatory, ≤ 50 (the `inventory.reserve` limit, which also keeps a view under the 200-key facade batch) (Ali, change 5). Hadi sets the value only: 50 for AU (Q-H1).
- Money: `{amount: bigint, currency}`; minor-unit exponent from ISO 4217; the currency is never assumed (ADR-0007 decision 1).
- Second Market fixture `test/fixtures/markets/ZZ.json` (JPY, exponent 0, `pricesIncludeTax = false`; PRC 4.4), with a different ceiling and retention: every domain and integration test runs on AU and ZZ (brief AC; CLAUDE.md).

## 9. Where each hard rule is enforced
| Rule (brief s5) | Enforcement point | Test |
|---|---|---|
| One owner, one Market per cart | `Cart` constructor (owner union); DB CHECK on owner kind (11); unique account cart per (Market, account) | Unit; two-Market DB test |
| No Offer from another Market | `catalog` answers only this Market's keys (CC1); add refuses `offer-unavailable` (6.1) | AC "Offer of another Market" |
| An absent key or `listed: false` is `offer-unavailable`, nothing more; `listed: true` alone never makes a line buyable (K-1) | `LineEvaluator` (3.2); `ordering` re-checks at checkout | Unit: absent key, `listed: false`, `variantBelongs: false`, `listed: true` with may-sell no / no price / `OUT` |
| Lines unique on (Offer, Variant); quantity integer 1..ceiling | `Cart.addLine` / `changeQuantity`; `LineQuantity`; DB unique and CHECK ≥ 1 | AC CRT-02; AC "120 → 99" |
| Ceiling = Market ceiling (AU 99), or `onlyLeft` when the stock is low (Q-H3) | `LineCeilingPolicy` in add, change and merge | AC ceiling; merge AC |
| At most the per-Market line limit (≤ 50; AU 50) distinct lines per cart (Q-H1) | Write unit of add (6.1 step 6) and merge (6.5 step 3) | Unit; merge over the limit |
| Price never trusted from client; read from `pricing` each time | The DTO has no price field; `priceAtAdd` written only from `pricing`'s answer; checkout DTO has no price (6.6) | AC "client price ignored"; contracts snapshot test |
| No pending-review price shown | `pricing`'s facade (PRC 4.1) | AC price change |
| Sellable composed at read time, never stored | No column for it (11); `LineEvaluator` | AC OUT, suspended seller |
| Minimum order per seller | `CartEvaluator`; re-applied by `ordering` | AC CRT-05 |
| Guest token: ≥ 128 bits, cookie only, hash only, 7-day server expiry, rate limits | Guest presentation adapter (cookie in and out); `GuestTokenHash`; read-time expiry (3.1); rate limiter (PostgreSQL counters) before any facade or write (6.1 step 1) | Security tests in slice 3 (13) |
| Guest CSRF without a token: JSON only before parsing, no state change on a safe method, no CORS with credentials (H-2) | Cart presentation layer (4) | `text/plain` with JSON body → `request.csrf` or 415 (slice 3) |
| Merge: synchronous, idempotent, same Market, sum to limit, older price at add, `MERGED`, cookie cleared | `cart.merge-guest-cart` + `MergePolicy` (6.5) | Merge AC; replay and two-tab tests |
| Ownership (IDOR) | `handle` of every customer and guest use case (5) | AC "customer A, customer B"; a guest-to-guest test |
| No claim words of its own | Cart passes catalog's badge data unchanged and shows a chip only when badge data is present (only `active` tags carry it, L3); no claim text in cart's contracts | Contracts test; a line whose tags are absent shows no chip |
| No exact stock shown | Cart has only `getAvailability` (status, `onlyLeft` when LOW) | Inventory AC 8 reused |
| Purge 90/7 days; on account erasure | Read-time expiry (3.1); job (12); erasure handler (6.7) | AC retention |
| Boundaries | Dependency rules: cart imports only `contracts/` of the five modules; only `ordering` imports `cart.facade` | `pnpm boundaries` |
| No cycle: cart imports no `ordering` contract (A-1) | Dependency rule | `pnpm boundaries` |

## 10. Idempotency and concurrency
| Command | Behaviour |
|---|---|
| Add | Increment; not idempotent by itself. Bounded by the ceiling. A stale version answers `conflict.stale` (409) and nothing is written; the client re-sends |
| Change quantity | Absolute value; a repeat is a no-op |
| Remove | A repeat answers `cart.line-not-found` |
| Merge | 6.5 steps 1 and 5 |
| Create (account) | Unique account cart (`P2002` → reload and apply) |
| Create (guest) | A new id and token each time; no natural key |
| Clear purchased lines | Per `orderId`: a clearance row (11; A-1 option A) |
| Erasure handler | Inbox `(event_id, handler)`; deleting a missing cart is a no-op |
| Purge | `deleteMany` with the expiry condition in `where`; safe to run twice and concurrently (PE 7) |

Every write is one READ COMMITTED unit guarded by the cart's version (PE 10). No row lock and no raw SQL.

## 11. Physical data (`cart` schema; for Mojtaba)
Conventions of `docs/design/data/identity.md` C1–C11 apply (Market and tenant columns with their CHECKs, UUIDv7 ids, `timestamptz(6)` from `Clock`, no defaults, no enum types, `(market_id, id)` unique on parents, foreign keys inside the schema only, indexes leading with `market_id`, Prisma model names starting with `Cart`). Mojtaba writes the column-level design (`docs/design/data/cart.md`); this is the input.

**`cart.carts`**
| Column | Notes |
|---|---|
| `id` | PK; unique `(market_id, id)` (C3) |
| `owner_kind` | `text`, CHECK in (`account`, `guest`) |
| `account_id` | `uuid`, null for guest; plain id, no FK (owned by `identity`) |
| `guest_token_hash` | `bytea`, CHECK `octet_length = 32`; NOT NULL for every guest row, including `MERGED` (kept until the purge so a replay is recognised, 6.5 step 1; Mojtaba, M-1); NULL for an account cart, including after an ownership transfer |
| `status` | `text`, CHECK in (`ACTIVE`, `MERGED`) |
| `merged_into_cart_id`, `merged_at` | `merged_into_cart_id` a plain id (no FK, so erasing the account cart is not blocked) |
| `last_changed_at`, `created_at` | `timestamptz(6)` |
| `version` | C5 |

Table CHECKs (Mojtaba, change 2; they replace the per-column owner and status notes):
- `carts_owner_check`: `(owner_kind='account' AND account_id IS NOT NULL AND guest_token_hash IS NULL AND status='ACTIVE') OR (owner_kind='guest' AND account_id IS NULL AND guest_token_hash IS NOT NULL)`.
- `carts_merged_check`: `(status='MERGED') = (merged_into_cart_id IS NOT NULL) AND (merged_into_cart_id IS NULL) = (merged_at IS NULL)`.
- `carts_last_changed_at_check`: `last_changed_at >= created_at`.

Indexes: unique `(market_id, account_id)` where `account_id IS NOT NULL`; unique `(market_id, guest_token_hash)` where not null (the per-request guest lookup); `(market_id, owner_kind, last_changed_at)` for the purge, in that order (Mojtaba, M-1: both purge predicates are equality on Market and kind, then a range plus ORDER BY on `last_changed_at`; no split into partial indexes, no `INCLUDE`).

**`cart.cart_lines`**
| Column | Notes |
|---|---|
| `id` | PK |
| `cart_id` | FK `(market_id, cart_id)` → `carts (market_id, id)`, `ON DELETE CASCADE` (a line has no meaning without its cart, C8) |
| `offer_id`, `variant_id` | `uuid`, plain ids (owned by `catalog`) |
| `quantity` | `integer`, CHECK `>= 1`; the Market ceiling is a domain rule (it is configuration) |
| `price_at_add_minor` | `bigint`, CHECK `> 0 AND <= 9007199254740991` (pricing.md P1; Mojtaba) |
| `price_at_add_currency` | `char(3)`, CHECK `^[A-Z]{3}$` |
| `added_at` | `timestamptz(6)` |

Unique `(market_id, cart_id, offer_id, variant_id)`. The unique `(market_id, cart_id, offer_id, variant_id)` also serves the cascade FK and the per-cart line read; no separate `cart_id` index. No version: lines change only through the root (PE 10).

**Other tables:** `cart.inbox` (platform pattern) with the first consumed event; `cart.order_clearances (market_id, tenant_id, order_id, cleared_at)` (A-1 option A): `tenant_id` per C1, `cleared_at timestamptz(6)`, PK `(market_id, order_id)`, index `(market_id, cleared_at)` for the prune. Retention is not tied to account retention: a clearance row only has to outlive the window in which `ordering` can re-send the call, since re-running a clearance after that would delete lines the customer added back. Proposed 30 days after `cleared_at` as a per-Market policy value (Mojtaba, M-1); **open: must be confirmed as at least `ordering`'s maximum redelivery window → ordering G2 (Ali, Mohammad)**. Rate-limit counters are the platform limiter's, not cart's. No `cart.outbox` at launch.

**Never stored:** the raw guest token; prices other than `priceAtAdd`; seller ids, names, badges, stock, sellable state; origin addresses.

**Retention and volume:** guest and `MERGED` carts are deleted 7 days after `last_changed_at` (a `MERGED` cart's merge set it); account carts 90 days after; account carts at erasure. Guest volume is bounded by the creation limit (H-1) times the line limit (Q-H1). Mojtaba's AU launch estimate (M-1): about 2,000 guest carts and about 500 account-cart changes per day, 3 lines on average; steady state under 20,000 guest carts and up to 10^5 account carts; hourly purge runs delete fewer than 100 carts each, within one batch.

**Grants:** API and worker both use `mondapac_app` (platform.md 10); grants are hand-written per 10.2 (Mojtaba, change 4). `mondapac_app` holds `SELECT, INSERT, UPDATE, DELETE` on both tables (line removal), which also covers the purge and the erasure handler in the worker, so Ali's change 8 (worker grants) is satisfied by the shared role; no separate worker grant. **Migrations:** reversible with `down.sql`; Phase 4 shares the one-open-migration-PR rule with `inventory` and `pricing` (pricing-data 8.1), announced on the board.

## 12. Jobs
`cart.purge-inactive`, every hour (worker, `mondapac_app`, per hosted Market, system actor, PE 7). Batches of 200 carts (at most 10,000 lines under Q-H1's 50-line limit): select the ids ordered by `last_changed_at` with `take: 200`, then `deleteMany` with the id list AND the expiry condition repeated in `where`; one unit per batch; deletes carts (lines by cascade) whose `last_changed_at + retention ≤ now` for their kind. `order_clearances` rows are pruned by `(market_id, cleared_at)` after the clearance retention (open, 11). Correctness never depends on it (3.1).

## 13. Slices, design system, deferred
**Slices** (brief s11; every slice: AU and ZZ fixtures, OpenAPI, structured logs with correlation id, `pnpm verify`):
1. Signed-in cart: add, change, remove, ceiling (needs CC1 `offerListings`, built in catalog slice 11; SC1, PC1, IC1, PL1 `maxLineQuantity`).
2. Grouped view, "Sold by", read-time state, price-change notice (SC2).
3. Guest cart and merge — **security-tester review mandatory**: token entropy and hash-only storage, cookie attributes, IDOR across guests and accounts, CSRF and origin, rate limits fail closed, merge replay and two-tab race, cookie cleared. Depends on the trust-proxy setting and PostgreSQL-backed limiter counters (4). Tests add (Hassan): a `text/plain` request with a JSON body → `request.csrf` or 415; a duplicate cookie name; a cookie from another Market; a merge without `x-csrf-token`; the limiter unavailable → `access.unavailable` with nothing written.
4. Optional minimum order (SC3 accepted in sellers 18; needs sellers slice 20 first; wording O-4 with Jafar and Reza).
5. Hand-off to `ordering`, purge job, order-placed and erasure handling — with Phase 5; **security review mandatory** for the hand-off and `clearPurchasedLines`; `getCheckoutLines`, `clearPurchasedLines` and this slice are re-confirmed by a mini-review at ordering's G2 (the INV 7.2 pattern; Ali, change 2).

**Design system (brief s12; Reza, Figma first, ADR-0017):** cart page grouped by seller with "Sold by" and subtotal; mini-cart drawer; unbuyable-line state per reason of 3.2; "reduce the quantity" with "only N left"; price-change notice; minimum-order message per seller; sign-in prompt for a guest at checkout; the minimum-order field in seller settings (sellers' screen). All text, not colour only (brief s9).

**Deferred:** CRT-04 (P1, with the storefront); CRT-06; saved carts, wish lists, abandoned-cart reports and reminders (brief s3); a Redis cache or a read model (each its own reviewed design).

## 14. Dependencies
- **catalog G2 (merged, PR #54):** CC1–CC3 accepted as ruled (CAT 9.7, 18), so Ali's A4 condition is met, as for inventory and pricing. A later change to them means a mini-review.
- **sellers G2 (merged, PR #46) and mini-review (merged, PR #47):** SC1, SC2 and SC3 accepted (7.1); sellers slice 20 before cart slice 4.
- **identity:** the erasure event (with CUS-03); the checked-in list of non-permission rules gains cart's entries.
- **platform:** `maxLineQuantity` in `MarketConfig` (the shared-file PR announced on the board); rate limiter with PostgreSQL counters (HMAC keys, fixed windows) and the trust-proxy setting, before slice 3 (Hassan); scheduler; inbox.
- **ordering G2:** mini-review re-confirming `getCheckoutLines`, `clearPurchasedLines` and slice 5 (A-1 decided: option A); `order_clearances` retention ≥ ordering's maximum redelivery window (open); re-applying ceiling and minimum; showing `inventory.insufficient` (`not-enough`, `over-limit`) at checkout, since cart cannot see a quantity above the threshold or the per-customer cap (INV 5.1, 5.4).

## 15. Questions (decided 2026-10-07 unless tagged open)
**Ali**
- **A-1. How `ordering` clears purchased lines without an import cycle.** **Decided (Ali): option A** — one-way `ordering → cart`, as inventory Q-A1; applied in 5, 6.7, 7.2, 7.3, 9, 10. Brief s6 change-log row through a Hadi+Ali mini-review (17). `ordering` imports `cart.facade` (6.6). If cart also subscribes to `ordering`'s order-placed event (brief s6), the two modules import each other's `contracts/`, the cycle Ali refused for inventory (Q-A1).
  | Option | For | Against |
  |---|---|---|
  | A (recommended). One-way `ordering → cart`: after an order is placed, `ordering` (from its own handler of its own event) calls `cart.clearPurchasedLines` (`system`, idempotent per `orderId`) | No cycle; same shape as INV 7.2; idempotent | Changes brief s6 "consumes the order-placed event": a change-log row (Hadi) |
  | B. Cart subscribes to order-placed; `ordering` gets the lines another way (the client carries them) | Matches brief s6 wording | The client becomes the carrier of the hand-off; or a cycle if `ordering` still imports cart |
- **A-2.** **Decided (Ali):** the Market's display convention (`MarketConfig.pricesIncludeTax`); applied in 6.4. Original question: minimum order in a Market whose prices exclude tax (ZZ): cart computes no tax, so recommend "compared with the subtotal of the effective unit prices as the Market displays them" (GST-inclusive in AU, as brief s5 says).
- **A-3.** **Decided (Ali): confirmed** — no read model and no Redis cache for sellable state at launch (ADR-0024 decision 5; brief s5); applied in 2.2.

**Hassan**
- **H-1.** **Decided (Hassan):** creation 30 per 60 minutes per (Market, origin); the other numbers as proposed; generic limiter for merge, view and account writes; applied in 4. Original proposal: guest-cart creation 20 per hour per (Market, origin); guest line writes 120 per 15 minutes per (Market, origin) and 60 per 15 minutes per guest cart.
- **H-2.** **Decided (Hassan):** no separate token under three written conditions (strict JSON, no state change on a safe method, no CORS with credentials); merge carries `x-csrf-token`; cookie `__Host-cart-guest-<market>`; applied in 4, 6.5.

**Mojtaba**
- **M-1.** **Decided (Mojtaba):** keep the purge index as is; keep the hash on `MERGED` rows; volume estimated; applied in 11, 12. `order_clearances` retention: proposed 30 days per Market, **open → ordering G2 (Ali, Mohammad)**.

**Hadi**
- **Q-H1.** **Decided (Hadi): accepted as recommended** (50 for AU, a Market setting; Ali: mandatory, ≤ 50); applied in 6.1, 6.5, 8, 9. Original recommendation: 50 per Market (AU), equal to `inventory.reserve`'s 50-line limit (Hassan finding 3), so every ready cart can be reserved in one call; this also bounds guest rows. In a merge over the limit, account lines stay and guest lines are added oldest first until the limit, the rest reported.
- **Q-H2.** **Decided (Hadi): accepted as recommended**; remove and re-add counts as a change, a refused or no-op add does not clear; applied in 6.1, 6.3, 6.5. Original recommendation: when the customer changes that line (quantity change or re-add), `priceAtAdd` becomes the current price; a merge does not clear it.
- **Q-H3.** **Decided (Hadi): accepted**, including that an add without a valid price is refused; applied in 2.3, 3.2, 9. Original question: "up to min(sellable, 99)" becomes "up to the Market ceiling, and to 'only N left' when the stock is low"; AC "quantity 5, stock 3" is shown by cart when the stock is within the low-stock threshold and otherwise at reservation by `ordering`. Also confirm that an add without a valid price is refused (2.3).

**Owner:** none (Hadi: none of Q-H1..Q-H3 needs the owner). The owner was informed of three points (the 50-line limit, no exact stock number in the cart, the guest-cookie protections) and accepted them on 2026-10-07.

**Still open**
- `order_clearances` retention vs `ordering`'s maximum redelivery window → ordering G2 (Ali, Mohammad).
- Erasure event name → identity mini-review with CUS-03 (14).
- Reza (ui-ux-designer) review of 13 / brief s12: pending (UI condition); he also checks the reason codes of 3.2 before slice 1's API is frozen.

**Closed 2026-10-07**
- Catalog G2 (CC1–CC3, Ali): merged (PR #54) and accepts them with refinements (a) `listed` boolean and (b) badge data only for `active` tags (K-1, applied in 3.2, 6.1, 6.2, 7.1, 9); sellers G2 (SC1–SC2) and the SC3 mini-review are merged.
- Brief edits for the brief editor (Hadi): done 2026-10-07; the merge cap in brief s5 and the "Offer deleted" and "reduce quantity" lines in flow 2 now follow the Q-H3 change-log row, as do the other places that row names (brief s5 line ceiling, flow 1, the "quantity 5, stock 3" AC). The A-1 row was confirmed by Hadi on 2026-10-07 (only the mechanism of brief s6 changes; ordering G2 re-confirms it).

## 16. Review record
| Date | Reviewer | Verdict | Applied |
|---|---|---|---|
| 2026-10-07 | Ali (cto) | Approve with changes; A-1 option A, A-2, A-3 decided | Changes 1–7 in 2.2, 3.2, 5, 6.2, 6.4, 6.7, 7, 7.2, 7.3, 8, 9, 10, 13; change 8 (worker grants) satisfied by Mojtaba's change 4 (API and worker share `mondapac_app`, 11) |
| 2026-10-07 | Hassan (security-tester) | Approve with conditions; no Critical or High; H-1, H-2 decided | Conditions and findings (2 Medium, 2 Low, 1 Info) in 4, 6.1, 6.5, 9, 13, 14 |
| 2026-10-07 | Mojtaba (database-designer) | Approve with changes; M-1 answered | Changes 1–6 in 11, 12; `order_clearances` retention open → ordering G2 |
| 2026-10-07 | Hadi (product-owner) | Q-H1, Q-H2, Q-H3 accepted; no owner question | 2.3, 3.2, 6.1, 6.3, 6.5, 8, 9; brief rows in 17 |
| 2026-10-07 | Ali (cto), on the catalog G2 draft 25cbf3a, merged as PR #54 (K-1; Hassan's L3) | CC1 accepted as `offerListings` with (a) `listed` boolean, no reason codes, (b) only `active` tags with badge data; absent key = `offer-unavailable`; `listed: true` is not permission to buy; batch reads advisory (ADR-0025 decision 1); CC2, CC3 match. No brief rule changes (brief flow 2 already shows one "Offer out of sale" reason; brief s5 badge rule unchanged) | 3.2, 6.1, 6.2, 7.1, 9, 13, 15. Catalog G2 merged (PR #54) with CC1–CC3 accepted as ruled |
| 2026-10-07 | Hadi (product-owner), brief editor | Brief edits of 15 made (brief s5 merge cap; flow 2 "Offer deleted" and "reduce quantity"; also the s5 line ceiling, flow 1 and the "quantity 5, stock 3" AC that the Q-H3 row names); no new rule | `docs/modules/cart/brief.md` |
| 2026-10-07 | Ali (cto), final verdict | **Approve with conditions** (tier B, design part of the combined gate): (1) Hassan reviews slices 3 and 5 before merge; (2) slice 4 waits for sellers slice 20; (3) `order_clearances` retention settled at ordering's G2; (4) Reza checks the reason codes of 3.2 before slice 1's API is frozen; (5) no UI slice before Reza's `ux.md` and the Figma-first design-system update (ADR-0017, brief s12). Approvers: Mohammad (software-architect), Ali (cto), Mojtaba (database-designer), Hassan (security-tester), Hadi (product-owner, decisions) | Brief approvals table |
| 2026-10-07 | Bagher (qc-release-manager), final check | Merges cleanly with main, touches only this module's files, no blocking open finding | — |
| — | Reza (ui-ux-designer) | Pending, UI condition (13, brief s12; reason codes of 3.2 before slice 1's API is frozen) | — |

Security bar (Ali, unchanged): Hassan reviews slice 3 and slice 5 before merge.

## 17. Brief change-log rows
The four rows this design causes (Hadi's Q-H1, Q-H2, Q-H3 and Ali's A-1) are recorded in the change log of `docs/modules/cart/brief.md` in the same PR.

## 18. As built (speed mode, 2026-10-09)
The first cart build (`feat/cart-core`) follows the speed plan: one PR, no new design documents. This section is the whole delta from sections 1 to 17; where they disagree, the code wins.

**Built:** `cart.carts` and `cart.cart_lines` (one migration, `cart_core`); account and guest carts; add, change quantity, remove, view grouped by seller with the price-change notice; guest cart token as a `__Host-cart-guest-<market>` cookie (7 days, stored only as SHA-256); merge on sign-in (`POST /cart/merge`), transfer when the account has no cart; a line ceiling of `min(maxLineQuantity, onlyLeft when low)`; checks against `catalog`, `sellers`, `pricing` and `inventory` on every read and add, failing closed to `check-unavailable`.

**Left out for now:** the 15-minute hold and the reservation (inventory slice 4, with checkout); the minimum order per seller; cart events and the outbox; the order-clearance table; a per-account write limit (the platform's per-origin limit applies); the cart facade for `ordering`; the purge job for expired guest carts (an expired cart is ignored at read time); the guest-cart cap per origin.

**Simplified:** one use case per operation and caller kind (nine classes), all calling `cart-operations.ts`; the maximum of 50 lines and the 7-day guest lifetime are constants of `ConfigCartPolicy`, not Market settings; `GET /cart` makes at most two rounds of facade calls, never one per line.
