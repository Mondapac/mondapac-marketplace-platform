# Pricing — G2 domain design

**Author:** Mohammad (software-architect) — 2026-10-07
**Status:** G2 approved with conditions 2026-10-07 (Ali, cto, final verdict; Bagher, QC, final check; 17). Ali (cto) approve with changes and Hassan (security-tester) accept with changes applied 2026-10-07; catalog G2 is merged (PR #54), so Ali's A4 is met. Mojtaba's data design (docs/design/data/pricing.md) reviewed by Hassan 2026-10-07 (approved with conditions; H-D1 and M7 decided, 15, 17). Revised 2026-10-07 for catalog's G2 (draft 25cbf3a, merged as PR #54), whose 9.7 and 18 accept CF1–CF4 with refinements as ruled, applied here as Ali's ruling P-1 (6.1, 6.4, 17). Follow-up: Reza (ui-ux-designer) pending, UI condition; Jafar for the wording of brief s12's screens (J1). Open: section 15; review record: section 17.
**Ground truth:** `docs/modules/pricing/brief.md` (G1 approved by the owner 2026-10-07; sections, owner answers and acceptance criteria are cited as "brief s5", "Q8", "AC 10"; the role-review table as "G1 review"); ADR-0024 (pricing is its own module; mandatory security review of price and Cost writes; `catalog` imports neither `pricing` nor `inventory`); ADR-0001, 0002, 0003, 0004, 0005, 0006, 0007 (decisions 1, 2, 4, 8, 10), 0008, 0009 (decision 2, V2), 0013, 0018, 0019, 0020, 0022, 0023; `docs/features/02-catalog-inventory.md` (CAT-16, CAT-17), `docs/features/10-versioning.md` (VER-03, VER-06, VER-09); `docs/modules/catalog/brief.md` (s3, s5, s11 "inputs for the `pricing` brief"); `docs/modules/cart/brief.md` (the first consumer); `docs/modules/inventory/brief.md` (sibling patterns); `docs/design/domain/identity.md` ("ID 5.2"), `platform-foundations.md` ("PF") and `platform-persistence-and-events.md` ("PE"); `apps/api/src/platform/market-config/market-config.ts` (today's `MarketConfig`).
**Catalog G2:** approved and merged (PR #54, 0bad228; `docs/design/domain/catalog.md`, cited "catalog G2 9.1"). Its 9.7 and 18 accept CF1 to CF4 of 6.1 with the refinements of P-1 as ruled; the merged text differs from the draft 25cbf3a only by additions this design already follows, so no mini-review is needed (A4 met).

## 1. Scope

A design, not an implementation. Signatures appear only where the signature is the contract.

- **Decided here:** domain model (2), state machines (3), pricing rules (4), authorisation (5), boundary, facade and events (6), data ownership (7), audit (8), idempotency and concurrency (9), where each hard rule is enforced (10), jobs (11), AI (12), slices and tests (13), what is deferred (14).
- **In Mojtaba's data design** (`docs/design/data/pricing.md`, written from this model): tables, columns, constraints (including the V2 `EXCLUDE` no-overlap of ADR-0009 decision 2), indexes, grants, and the migration plan. Section 7 only names the data each aggregate holds, plus inputs PD1 to PD6.
- **In Reza's and Jafar's documents:** the price, special-price and Cost section of the Offer form; the "awaiting review" state in the seller panel; the admin review queue; storefront and cart display of price, special price and "no valid price" (brief s12). The server answers with codes (5.5).
- **Left open, with the reason:** the questions in 15. Each one is a business value, a dependency change or a security call this design must not invent.

### 1.1 Brief slices and where they are covered
| Slice (brief s11) | Covered in |
|---|---|
| 1 `Money` type, regular price record written by the seller, limits (security review) | 2.1, 3.1, 4.4, 4.5, 5.2, 9, 10 |
| 2 Effective-price read facade (single and batch, with record id) and "no valid price"; pending state modelled from this slice | 4.1, 6.2 |
| 3 Cost: own stream, type and permission (security review) | 2.1, 6.5, 5.1 |
| 4 Price-jump hold and admin review queue, with audit and seller-panel status (security review) | 3.1, 4.2, 5.2, 8 |
| 5 Special price with a time window, and boundary events (security review) | 3.2, 4.3, 11 |
| 6 P1: "price at date X" (VER-09) | 14 |

## 2. Domain model

### 2.1 Aggregates
Every aggregate root carries `marketId`, `tenantId` (ADR-0003 decision 3, ADR-0020 decision 6), an `Id` from the injected generator and a `version` (PE 10). Time comes from `Clock` only (ADR-0005 decision 5). The priced unit is (Offer, Variant) (ADR-0024 decision 1). References to other modules are ids only.

```
PriceSeries  (one per marketId + offerId + variantId)
  |-- RegularPriceRecord (1..n, append-only)      status: ACCEPTED | PENDING_REVIEW | APPROVED | REJECTED | SUPERSEDED
  |-- SpecialPriceRecord (0..n, append-only)      status: ACCEPTED | PENDING_REVIEW | APPROVED | REJECTED | SUPERSEDED | WITHDRAWN
  '-- BoundaryMarker     (0..2 per special record: start, end; set once, 11)
CostSeries   (one per marketId + offerId + variantId; separate root, separate repository)
  '-- CostRecord (0..n, append-only)              amount or "cleared"
```

| Aggregate | Holds (logical; physical design is Mojtaba's) | Invariants it owns |
|---|---|---|
| `PriceSeries` | `offerId`, `variantId`, `productId` and `sellerId` as copies taken from the `catalog` facade when the series is created (2.3), `retiredAt` and a retirement cause, the regular and special records, and boundary markers | One series per (Market, Offer, Variant). At most one `PENDING_REVIEW` regular record, and at most one `PENDING_REVIEW` special record (brief s5). Regular effective periods do not overlap, and their starts are strictly increasing (brief s5). No record is ever written for a retired series, and no series is created for an Offer or a (Product, Variant) that has a retirement tombstone (6.4; Hassan finding 3; keyed by Product because Variant-removed carries no Offer id, M5). The Variant id and the `productId` copy change only through the CF4 re-key, together and on a series that is not retired (6.4). Record content never changes; only status fields change, each written once (brief s5: "never deleted or rewritten") |
| `RegularPriceRecord` (entity) | `amount: Money`; `taxInclusive` (the Market's `pricesIncludeTax` at write time, 4.5); `status`; `submittedAt`; `submittedBy` (account id, plus the acting-as account when SEL-08 exists, 5.4); `effectiveFrom`, set at acceptance or approval; the end of its effective period, closed when the next record becomes effective; for a measured record, the anchor record id and anchor amount it was measured against, and the direction (`up` or `down`) if it was held; `decidedAt`, `decidedBy`, reason code and optional note on a decision; `supersededBy` (a record id) or a system cause | Amount greater than 0 and no more than the Market maximum, in the Market currency (4.4). `effectiveFrom` is never earlier than the acceptance or approval instant, and is never set by input (Q5: "from now" only). The first record of a series is never held (brief s4 flow 2) |
| `SpecialPriceRecord` (entity) | `amount: Money`; `startsAt` and `endsAt` as UTC instants, plus the seller's IANA `zone` stored on the record (brief s5; ADR-0005; a later change of the seller's zone does not move an existing window, Ali); the regular record id and amount, and the anchor record id and amount (2.4), it was measured against (Hassan finding 1); `status`; submitted, decided and withdrawn instants and actors; reason code | Amount strictly below the regular price in effect at submission, and again at approval (4.3). `endsAt > startsAt`, and `startsAt` is not before the submission instant (4.3). One special at a time (Q3, owner 2026-10-07; a new one replaces the current one): at most one `PENDING_REVIEW` special per series, and the effective periods of specials, `[effective start, min(endsAt, withdrawnAt))`, never overlap (M4) |
| `CostSeries` | `offerId`, `variantId`, `sellerId`, the cost records; each record stores `submittedBy` and, once SEL-08 exists, the acting-as account (Hassan finding 4, H2) | Amount `Money` in the Market currency and greater than 0, or a "cleared" record (Cost is optional, Q7). It never creates a hold (brief s5). Append-only |

### 2.2 Value objects and domain services
| Name | What it is |
|---|---|
| `Money` (shared kernel, ADR-0007 decision 1) | `{ amount: bigint minor units, currency: ISO 4217 }`; minor-unit exponent from ISO 4217; arithmetic across currencies throws. Arrives with slice 1 (ADR-0015 decision 3) |
| `PriceAmount` | A `Money` that passed `PriceLimits`: currency equals the Market currency, amount > 0, amount ≤ the Market maximum. Its only factory takes the policy. Every record amount is a `PriceAmount` |
| `CostAmount` | Opaque: holds a `Money` behind a module-private symbol; `toJSON()` and `toString()` throw `CostSerializationError` (6.5) |
| `SpecialWindow` | `{ startsAt: Instant, endsAt: Instant, zone: IanaZone }`, built from two local date-times and the seller's zone through the kernel's Temporal re-export. A local time that does not exist (DST gap) or is ambiguous (DST overlap) is refused, never shifted silently (`pricing.special-window.local-time-invalid`) |
| `PricingPolicy` | Per Market: the maximum unit price (`Money`), the jump threshold as an exact decimal fraction (ADR-0007 decision 2; AU 0.5), the jump directions (`up`, `down`, `both`; AU `both`, Q9), and the jump window `W` (an ISO duration; AU `P7D`, owner 2026-10-07, Q1). Resolved by `PricingPolicyProvider.forOffer(market, offer)`, which returns the Market policy today; a Vertical override plugs in there later (4.6) |
| `EffectivePriceResolver` | Pure domain service: (series, instant) → effective price or "no valid price" (4.1). The only place the rule exists; the facade, the seller view and the boundary job all call it |
| `JumpPolicy` | Pure domain service: (anchor, candidate, policy) → `within` or `held(direction)`; for specials: (regular, anchor, special, policy) → `within` or `held(down)`, measured against both the regular price and the anchor (4.2, 4.3; Hassan finding 1). Exact integer cross-multiplication; no floating point |
| `PricingStrategy` | Declared now in `pricing/domain` (ADR-0001 decision 1; decided by Ali, A3). No registry and no `requiresNegotiation`. It moves to `contracts/` only when a second implementation is in scope |
| `FixedPriceStrategy` | The single implementation of `PricingStrategy`, chosen by `PricingPolicyProvider`: unit price = effective fixed price. No other implementation is in scope (Q3) |

### 2.3 Modelling choices that need a reason
| Choice | Reason | Cost |
|---|---|---|
| Regular and special prices in **one** root (`PriceSeries`) | "Special < regular" and "the hold is measured against the last approved price" span both streams. One root gives one version, so writes in one series are serialised by optimistic concurrency (brief s5) | A seller editing the regular price and the special price of one Variant at the same time gets `conflict.stale` on the second write |
| Cost in its **own** root, repository and type | Brief s5: a separate stream and a DTO the read facades cannot serialise. A separate root means no `PriceSeries` load can bring Cost into memory | Two writes when the form saves price and Cost together; they are independent, and either may fail alone (the form shows which) |
| `ACCEPTED` and `APPROVED` as separate statuses | The brief says "approved/accepted" (s5): one passed without review, the other passed review. The approval instant resets the jump anchor (4.2); an acceptance does not | One more status |
| `sellerId` and `productId` copied onto the series | `sellerId` lets the series be scoped to a seller (seller lists, queue display). `productId` lets a "Variant removed" event (keyed by product) find its series. **Ownership is never decided from the copy:** every write asks the `catalog` facade (5.2) | A copy that could go stale if `catalog` ever moves an Offer between sellers. No such flow exists: an Offer never changes seller (catalog G2 2.1); CAT-45 changes only the product, and the CF4 re-key updates the `productId` copy with the Variant id (6.4) |
| Status changes as write-once fields, not new rows | ADR-0009 V2 plus brief s5 ("append-only"): content is immutable; a decision is recorded once. Same pattern as identity's `AccessDecision` | Mojtaba's grants must allow `UPDATE` on status columns only (PD3) |
| No admin path that writes a price | Brief s2: the admin approves or rejects; only the seller sets prices | Support cannot fix a typo for a seller; the seller resubmits |
| No "remove the regular price" use case | Brief s4 has no such flow; taking an Offer off sale belongs to `catalog` (ADR-0024 decision 5). Supersede pending changes by resubmitting the current price (3.1) | — |

### 2.4 Toss-up T1: the jump anchor (brief s5, AC 11)
The brief requires that several small changes in a row whose sum exceeds T are caught, so the anchor cannot be "the previous record". Decided by Ali 2026-10-07: option A; confirmed by the owner 2026-10-07 together with W = `P7D` for AU (Q1).

| Option | Rule | For | Against |
|---|---|---|---|
| **A (decided by Ali; confirmed by the owner, Q1)** | Anchor = the later of: (a) the regular record in effect at `now − W`, or the first accepted record if the series is younger; (b) the latest `APPROVED` regular record. A candidate is held if it differs from the anchor by more than T in a configured direction | One number the seller and the admin can be shown ("compared with $X, in effect on <date>"). An admin approval resets the baseline, so an approved jump does not hold every later small edit | Changes up and then down inside W are measured only against the anchor |
| B | Held if the candidate differs by more than T from **any** accepted or approved regular price in effect during `[max(now − W, last approval), now]` | Catches more oscillation | Several reference prices; harder to explain; more data per check |

W is a business number: `P7D` for AU (owner, Q1), held in pricing's per-Market policy (4.6).

## 3. State machines

Every transition is one use case with one read-write unit of work (PE 3.1, T1 option A) and takes its instant from `Clock`. A transition that is not listed is forbidden.

### 3.1 Regular price record
| From → to | Trigger and guard | Effects | Serves |
|---|---|---|---|
| (none) → `ACCEPTED` | Seller sets a price. Guards: 5.2 ownership, `PriceAmount`, the amount is strictly above any running or scheduled special (`ACCEPTED` or `APPROVED`, not ended, not withdrawn; Q2, owner 2026-10-07: otherwise `pricing.regular-not-above-special`, and the seller edits or ends the special first), and either no accepted or approved record exists yet (first price, never held) or `JumpPolicy` says `within`. Any existing pending regular record becomes `SUPERSEDED` in the same unit | `effectiveFrom = max(now, previous effectiveFrom + 1 ms)` (9); the previous effective period closes there; event `effective-price-changed` | CAT-16, brief s4 flows 2–3, AC 9 |
| (none) → `PENDING_REVIEW` | Seller sets a price that `JumpPolicy` holds (the other guards of the row above apply, Q2 included). Any existing pending regular record → `SUPERSEDED` | Anchor id, amount and direction stored; the previous price stays effective; event `price-hold-opened`; audit | VER-03, Q2, Q9, AC 10, 11 |
| `PENDING_REVIEW` → `APPROVED` | Admin with `pricing.price-hold.decide`, naming this record id (the record the screen showed). The decider is never the account that submitted the record (H4). Re-checked: still pending, series not retired, `PriceLimits` under the **current** policy, still strictly above any running or scheduled special (Q2 applied when the price would take effect; otherwise `pricing.regular-not-above-special`, and the admin rejects instead) | `effectiveFrom = max(now, previous + 1 ms)`, so it is effective from **approval**, not submission (brief s5); becomes the new jump anchor; events `price-hold-decided` (approved) and `effective-price-changed`; audit | AC 10 |
| `PENDING_REVIEW` → `REJECTED` | Same permission and the same decider rule (H4); a reason code is required (brief s9) | The previous price is untouched; the seller sees the reason code and the optional note (Q4, owner 2026-10-07; Jafar writes the wording); event `price-hold-decided` (rejected); audit | AC 10 |
| `PENDING_REVIEW` → `SUPERSEDED` | (a) A new seller write to the same series, which is then measured again from scratch (brief s4 flow 3); (b) a write equal to the current effective regular price, which supersedes the pending record and creates nothing ("cancel my change"); (c) system: the Offer is deleted or the Variant removed (6.4) | Event `price-hold-decided` (superseded, with cause); audit | AC 12 |

Forbidden: a regular price at or below a running or scheduled special (Q2); a pending record becoming effective; a future `effectiveFrom` supplied by input (AC 5); approving or rejecting a non-pending record; deciding a record of another Market; any change to amount, anchor or submitted fields; deleting a record; a second pending regular record; any write to a retired series; AI as decision-maker (12).

### 3.2 Special price record
| From → to | Trigger and guard | Effects | Serves |
|---|---|---|---|
| (none) → `ACCEPTED` | Seller sets a special price. Guards: ownership; `PriceAmount`; an effective regular price exists; amount strictly below it; a valid `SpecialWindow` with `startsAt ≥ now` (or "start now"); `JumpPolicy` for specials says `within` | Effective inside `[startsAt, endsAt)`; any current special: a pending one → `SUPERSEDED`, an accepted or approved one → `WITHDRAWN` at the new one's start (Q3); event `effective-price-changed` if the window is already open, otherwise at its start (11) | CAT-16, Q1, AC 13, 14 |
| (none) → `PENDING_REVIEW` | Same, but the discount from the regular price, or from the anchor (2.4), exceeds T (Q8; Hassan finding 1) | Does not take effect; the current special (if any) stays as it is until approval; event `price-hold-opened` (kind `special`); audit | Q8, AC 15 |
| `PENDING_REVIEW` → `APPROVED` | Admin, as in 3.1 (decider never the submitter); the seller sees a rejection's reason code and optional note (Q4). Re-checked: still strictly below the **current** effective regular price; `endsAt > now` (otherwise refused with `pricing.special-window.ended`; the admin rejects instead; owner 2026-10-07, Q3) | Effective from `max(startsAt, approval instant)` until `endsAt`; the previous special is withdrawn at that instant; events; audit | Q8, brief s5 |
| `PENDING_REVIEW` → `REJECTED` / `SUPERSEDED` | As in 3.1 | As in 3.1 | — |
| `ACCEPTED` or `APPROVED` → `WITHDRAWN` | Seller ends or cancels it (brief s5 "delete"); a replacement becomes effective; the series is retired | `withdrawnAt = now`, or the replacement's start (a record withdrawn at a future instant stays in effect until `withdrawnAt`, M4); event `effective-price-changed` if it was active; audit | brief s5 |

"Ended" is derived (`endsAt ≤ now`), never stored, so validity never depends on a job (PE 7). Forbidden: special ≥ regular at write or approval; a window without an end; editing a window (withdraw and set a new one); a pending special being effective.

### 3.3 Cost record
No state machine. Each write appends a record (an amount, or "cleared"); the latest record is the current Cost. Never held, never reviewed (brief s5).

## 4. Pricing rules

### 4.1 Effective price (read time, `EffectivePriceResolver`)
For a series S and the instant t = `Clock.now()`:
1. If S does not exist, is retired, or has no `ACCEPTED`/`APPROVED` regular record with `effectiveFrom ≤ t`: **no valid price** (brief s4 flow 1; AC 3, never zero).
2. R = the regular record whose effective period contains t.
3. Sp = the special record with status `ACCEPTED` or `APPROVED` whose effective start is ≤ t, whose `endsAt` is > t, and which was not withdrawn at or before t (a `WITHDRAWN` record counts until its `withdrawnAt`, M4). At most one exists, by invariant.
4. If Sp exists and `Sp.amount < R.amount`: the effective price is Sp (basis `special`). Otherwise it is R (basis `regular`). The strict comparison is repeated at read time as a fail-safe: a buyer never pays more than the regular price, although Q2 already refuses such a regular price at write and approval time.
5. `PENDING_REVIEW`, `REJECTED` and `SUPERSEDED` records are never considered, and a `WITHDRAWN` record only before its `withdrawnAt` (step 3; M4) (brief s5; AC 16).

Cart and storefront always show this value (brief s5; cart brief s4 flow 3).

### 4.2 Jump measurement (`JumpPolicy`, regular price)
- **Anchor:** option A of T1 (2.4).
- **Threshold T = N/D** (an exact decimal; AU 1/2). With anchor a and candidate c, both minor units of the same currency:
  - held `up` if `c·D > a·(D+N)`;
  - held `down` if `c·D < a·(D−N)`.
  - Only the directions the policy enables apply (AU: both, Q9). "More than T" is strict, so exactly 50% is not held.
- The first price is never measured (brief s4 flow 2); this is also why the maximum price applies to it (Q10).

### 4.3 Special price
- The window is entered as local date-times in the **seller's operating zone** (ADR-0005; the catalog brief s11 team proposal, shown explicitly). It is stored as two UTC instants plus the IANA zone (brief s5). The zone comes from the `sellers` facade (A1): `sellerSummaries(ctx, [sellerId]).operatingTimezone` (sellers 7.1, merged in PR #46), never from input. Only a zone from the seller's approved revision is used; a `provisional` zone (draft revision only) counts as missing, because a seller without an approved revision cannot sell and the draft zone can still change. When the seller's zone is missing, the write is refused with `pricing.seller-zone-unavailable`; it never falls back to the Market timezone. The zone is stored on the record, so a later change of the seller's zone does not move existing windows (Ali).
- **Discount hold (Q8):** with R the effective regular price at submission and `anchor` the anchor of 2.4, the special is held if `s·D < R·(D−N)` or `s·D < anchor·(D−N)`, with the same T. The anchor test (Hassan finding 1) stops a seller from alternating regular and special cuts to drop the effective price by more than T within W without review. The `up` direction does not apply, because a special is always below R.
- The boundary tests of AC 14 use the zone fixtures of ADR-0005 decision 8: Brisbane, Sydney (DST), Adelaide (half-hour offset plus DST), Perth, and DST-transition days.

### 4.4 Money, currency and limits
- Input is `{ amount: string of minor units, currency }` (ADR-0007 decision 10). It is parsed to a `bigint` only after the string has matched digits only, with no sign, no leading zeros and at most 16 digits. Then the domain checks it.
- The currency must equal the Market's currency (ADR-0002 decision 4): `MarketConfig.defaultCurrency` today, the only currency of a Market (INTL-21). Otherwise `pricing.currency-mismatch` (AC 1). A currency is never assumed.
- `0 < amount ≤ maxUnitPrice` (AU 500 000 minor units AUD = $5,000, Q10). Otherwise `pricing.amount-out-of-range` (AC 4). At boot the policy is validated: the maximum is in the Market currency and ≤ 2^53 − 1, so no amount ever exceeds the safe-integer limit (brief s5).
- The minor-unit exponent comes from ISO 4217 (ADR-0007 decision 1). The synthetic second Market is `test/fixtures/markets/ZZ.json` (JPY, minor-unit exponent 0; Ali) (AC 2).

### 4.5 Tax-inclusive storage and the TaxStrategy
- A price is the amount the buyer pays per unit, as the Market's convention says: GST-inclusive in AU (`pricesIncludeTax = true`, Q6, ADR-0007 decision 4).
- Each record stores the `taxInclusive` flag in force when it was written, so a later change to Market configuration cannot silently reinterpret old records. A change of that flag for a Market with existing prices needs a migration plan of its own (out of scope).
- `pricing` never computes tax and never calls a TaxStrategy. `tax` (Phase 5) receives the frozen unit price and its flag from the `ordering` snapshot and extracts GST per line (ADR-0007 decisions 3, 4, 8). The facade returns the flag with each price.

### 4.6 Market and Vertical configuration
- No `if (country == 'AU')` and no vertical name in `pricing` (ADR-0001 decision 5). Every number comes from `PricingPolicy`, resolved per Market.
- VER-03 puts the threshold in "Market/Vertical configuration". `PricingPolicyProvider.forOffer(market, offer)` is the seam. A Vertical override is added there when `catalog` exposes an Offer's vertical (no trigger today), without changing callers.
- **Where the values live (decided by Ali, A2, as a general rule):** a value that more than one module reads (currency, `pricesIncludeTax`, the line ceiling) lives in platform `MarketConfig`. A value only one module reads lives in that module's per-Market policy, checked at boot for every hosted Market, with no default (fail closed). So `pricesIncludeTax` is in `MarketConfig` (tax, storefront and invoices read it too); the threshold, directions, window and maximum are in pricing's per-Market policy. Each value has one owner, and platform code does not learn pricing's policy shape.

Until the ADR "Market settings editable by an admin" exists, the values are configuration as code (brief s11).

## 5. Authorisation (ADR-0018, ID 5.2)

### 5.1 Permission catalogue (`modules/pricing/contracts/permissions.ts`)
| Key | Scope | Protected | Allows |
|---|---|---|---|
| `pricing.price.view` | seller | no | See regular price, special price and hold status of the seller's own Offers |
| `pricing.price.edit` | seller | no | Set the regular price; set or withdraw a special price |
| `pricing.cost.view` | seller | **no** | See Cost. Default: Seller Owner only (Q11). Not protected, because the identity Phase 2 narrowing makes protected seller keys ungrantable (ID 5.4 R11), and Q11 lets the Seller Owner grant it to other roles |
| `pricing.price-hold.view` | platform | no | See the review queue and a held record with its anchor |
| `pricing.price-hold.decide` | platform | **yes** (H4) | Approve or reject a held record. Protected because approving a hold has money impact; in admin scope the Platform Administrator can still grant it |
| `pricing.price-history.view` | platform | no | Read price history (brief s2); the list arrives with VER-09 (P1, 14) |

There is no admin key for Cost: no admin path reads Cost (brief s5: not in the queue, not in history).

### 5.2 Use cases
"Ownership" runs in `handle`, before the unit opens: one batched call to the `catalog` facade `offerSellUnits` (CF1) for the Offer. The Offer must be present (catalog answers only for the context's Market, so another Market's Offer is absent) with a `status` other than `deleted` (a deleted Offer is present with `status: deleted` and no sell units), its `sellerId` must equal `ActorContext.sellerId`, and the Variant must be one of its `sellUnits`: the product's non-retired Variants, `proposed` included, so a seller can price before the first publish (brief s4 flow 2; G1 review, Hassan; P-1). Any failure returns `pricing.offer-not-found`, byte-identical for "not yours", "other Market", "absent", "deleted" and "Variant not priceable" (ID 5.2). The answer is advisory (ADR-0025 decision 1: read outside the write unit, so it can be stale by commit): a deletion or removal that lands after it is closed by the tombstones, the retirement version bump and the serializable units (6.4, 9), never by the read. Every `pricing.offer-not-found` on a write is recorded, with its cause kept inside the audit row and never in the answer, so every cause takes the same path and the timing does not reveal that an Offer exists (Hassan finding 2, H3); at most 1 audit row per (actor, Offer) per minute (H3) and, because the Offer id comes from the caller, at most 20 such rows per actor per minute across all Offers, after which one `pricing.offer-write-refused.suppressed` summary row is written for that minute and nothing more (Hassan, pricing-data review, M7). The counters live in PostgreSQL (pricing-data 3.8) and are updated in the same unit as the audit row, so a counter never advances without its row; Redis is not used (Hassan: PostgreSQL keeps the counter atomic with the audit row and fails closed). The pricing write routes also sit behind the platform's general per-account rate limit (ID 6.8); slice 1 proves it with a test (Hassan). Inside the unit, a series is not created when a retirement tombstone exists for the Offer or the (Product, Variant) (6.4; M5); the answer is `pricing.offer-not-found` (Hassan finding 3).

| Use case | Access rule | When the seller is not approved | Ownership |
|---|---|---|---|
| `pricing.set-regular-price` | `permissions: [pricing.price.edit]` | deny | As above |
| `pricing.set-special-price`, `pricing.withdraw-special-price` | `permissions: [pricing.price.edit]` | deny | As above |
| `pricing.view-offer-pricing` (seller panel) | `permissions: [pricing.price.view]` | deny | As above; batch for the Offer list, at most 200 Offer ids per `offerSellUnits` call (a larger call is refused whole, so a page is never larger) |
| `pricing.set-cost` | `allOf: [pricing.price.edit, pricing.cost.view]` (decided by Hassan, H1: nobody overwrites a Cost they cannot see; no new key) | deny | As above |
| `pricing.view-cost` | `permissions: [pricing.cost.view]` | deny | As above |
| `pricing.list-price-holds`, `pricing.view-price-hold` | `permissions: [pricing.price-hold.view]` | — | Market from context; queue oldest first |
| `pricing.approve-price-hold`, `pricing.reject-price-hold` | `permissions: [pricing.price-hold.decide]` | — | The record id from input is looked up in the context's Market only |
| `pricing.read-effective-prices` | `anonymous` (cart and storefront; customers and guests) | — | None for the in-process facade: unknown or foreign keys answer "no valid price" (accepted by Hassan, H5). Any HTTP route that takes raw ids must filter through catalog's published state, so draft prices are not readable through a public route (H5) |
| `pricing.read-effective-prices-for-system` | `system` (ordering saga, event handlers, jobs) | — | Market from the envelope |
| `pricing.retire-series-for-removed-offer`, `pricing.retire-series-for-removed-variant`, `pricing.rekey-series-for-moved-offer` | `system` (event) | — | Market from the envelope |
| `pricing.publish-special-price-boundaries` | `system` (job) | — | Per hosted Market |

"Deny when not approved" follows the catalog brief: every seller action comes after approval. No pricing use case joins the allow-list of ID 5.2.

### 5.3 Default roles (decided by the owner 2026-10-07 as proposed; Q5)
Identity's design leaves each module to say which default roles receive its keys (ID 5.6, R10).
- **Seller side:** Store Manager and Catalogue and Stock get `pricing.price.view` and `pricing.price.edit`. No default role gets `pricing.cost.view`; the Seller Owner holds it by definition (Q11).
- **Admin side:** Catalogue Moderator gets `pricing.price-hold.view`, `.decide` (protected, H4; granted by the Platform Administrator) and `pricing.price-history.view`. Viewer gets the unprotected view keys.

### 5.4 Acting-as (Login as Seller, SEL-08)
SEL-08 is not built; `actingAs` is reserved on `ActorContext` (ID 4 row 6). `pricing` adds nothing to the context. When SEL-08 lands:
- every record stores `submittedBy` as the real admin plus the acting-as account;
- every audit row has `actor_id` = admin and `acting_as_id` = the seller account (`docs/design/data/platform.md`), satisfying "both actors" (brief s9);
- cost records store `submittedBy` and the acting-as account too (Hassan finding 4);
- the decide use cases refuse an admin who submitted the held record, in an acting-as session or otherwise (H4).

Until the SEL-08 mini-review decides whether acting-as may touch prices, price, special-price and Cost writes and Cost reads are refused in an acting-as session (fail closed; Hassan finding 6).

### 5.5 Answer codes (minimum body of ID 5.2)
`pricing.offer-not-found`, `pricing.currency-mismatch`, `pricing.amount-out-of-range`, `pricing.special-not-below-regular`, `pricing.regular-not-above-special` (Q2), `pricing.no-regular-price`, `pricing.special-window.invalid`, `pricing.special-window.local-time-invalid`, `pricing.special-window.start-in-past`, `pricing.special-window.ended`, `pricing.seller-zone-unavailable`, `pricing.hold.not-pending`, `pricing.series-retired`, and `pricing.batch.too-large`. The platform codes `conflict.stale`, `conflict.retry` and `validation.failed` also apply. A held write is a success with `status: pending-review`, not an error.

## 6. Boundary

`pricing` imports only `contracts/` of `catalog`, `identity` (through the gate) and `sellers` (A1), plus the kernel and `platform/`. `catalog` never imports `pricing` (ADR-0024 decision 5). No other module reads `pricing`'s tables.

### 6.1 What `pricing` needs from others
| # | From | Need |
|---|---|---|
| CF1 | `catalog` facade (catalog G2 9.1, slice 7; accepted, P-1) | `offerSellUnits(ctx, offerIds)`, 1 to 200 ids (a larger call is refused whole), `anonymous` and `system` pair, in-process → per Offer: `sellerId`, `productId`, `status` (`draft`, `pending-first-publish`, `changes-needed`, `published`, `deleted`), `listed`, and `sellUnits`: the product's non-retired Variants (`proposed` and `published`), the Variants that may be priced. Unknown and other-Market ids are absent; a `deleted` Offer is present with `status: deleted` and no sell units (5.2). Advisory (ADR-0025 decision 1); pricing never reads `listed` for a write |
| CF2 | `catalog` events (catalog G2 9.4; accepted) | `catalog.offer-deleted.v1` (`offerId`, `productId`, `sellerId`; pricing uses `offerId`); `catalog.variant-removed.v1` (`productId`, `variantId`), sent once per Variant in the unit that retires it, including the working-copy save that deletes a `proposed` Variant, and never followed by an add of the same id. Ids only. Offer created is not needed: creating an Offer creates no price (brief s4 flow 1); this is a brief s6 change-log row |
| CF3 | `catalog` | The `Offer`, `Variant` and `Product` id types exported from `contracts/` (branded `Id<…>`; accepted) |
| CF4 | `catalog` (P1, with CAT-45; catalog G2 9.4; accepted) | `catalog.offer-moved.v1` (`offerId`, `fromProductId`, `toProductId`, `variantMapping: {from, to}[]`, ids only), so `pricing` re-keys its series (6.4). No `variant-removed` is sent for the matched duplicate's Variants (catalog G2 9.7) |
| — | `catalog` facade `offerListings` (catalog G2 9.1, slice 11) | The published-state filter of H5 for any HTTP route that takes raw ids (5.2, 6.2); ≤ 200 keys, advisory |
| — | `sellers` facade | The seller's operating IANA zone for special windows (A1, approved by Ali): `sellerSummaries(ctx, sellerIds)` → `operatingTimezone` with a `provisional` flag, `anonymous` for request actors and `system` for handlers, ≤ 100 ids (sellers G2, merged in PR #46, 7.1). Missing or provisional zone: the write is refused with `pricing.seller-zone-unavailable`, never the Market timezone (4.3) |
| — | `identity` | The gate and `ActorContext` only |
| — | `platform/` | `MarketRegistry`, `MarketContextFactory`, `Clock`, `IdGenerator`, UnitOfWork, outbox, inbox (`runOnce`), scheduler, audit writer, permission registry |

### 6.2 Public facade (`modules/pricing/contracts/pricing.facade.ts`)
```ts
interface PricingFacade {
  // 1..200 distinct keys; three statements per call, whatever the number of keys (M2)
  getEffectivePrices(ctx: CallContext, keys: readonly PriceKey[]):
    Promise<Result<readonly PriceAnswer[], PricingReadError>>;
}
type PriceKey = { offerId: Id<'Offer'>; variantId: Id<'Variant'> };
type PriceAnswer =
  | { key: PriceKey; status: 'priced'; unitPrice: Money; basis: 'regular' | 'special';
      effectiveRecordId: Id<'RegularPriceRecord'> | Id<'SpecialPriceRecord'>;
      regularPrice: Money; regularRecordId: Id<'RegularPriceRecord'>;
      specialEndsAt: Instant | null; taxInclusive: boolean; evaluatedAt: Instant }
  | { key: PriceKey; status: 'no-valid-price' };
```
- One method, two use cases behind it (`anonymous` and `system`), chosen by actor kind, as identity's `sellerAccessOf` does (ID 8.1).
- `ordering` freezes `effectiveRecordId`, the amount and the flag (ADR-0007 decision 8, VER-06); `pricing` stores nothing about orders.
- The caller supplies no instant: "now" is `pricing`'s `Clock`.
- The batch limit is 200 keys; above it the whole call is refused with `pricing.batch.too-large`, never answered in part (inventory's and catalog's facades use the same limit, Ali). An HTTP route over this facade that takes raw ids filters through catalog's `offerListings` (H5).
- The answer is advisory (ADR-0025 decision 1: a read-only unit opens no transaction): it is true at `evaluatedAt`, and `ordering` re-checks and freezes the record id at purchase (VER-06). The same holds for every batch facade read pricing makes.
- No Cost type is reachable from this file (6.5).

### 6.3 Events published (ids, enums and instants only; PE 5.3)
| Type | Aggregate | Payload |
|---|---|---|
| `pricing.effective-price-changed.v1` | price-series | `offerId`, `variantId`, `cause` (`regular-accepted`, `hold-approved`, `special-started`, `special-ended`, `special-withdrawn`, `series-retired`, `series-rekeyed`), `effectiveFrom`, and `previousProductId`, `previousVariantId`: required when `cause` is `series-rekeyed`, absent otherwise (Ali). For `series-rekeyed`, `offerId` and `variantId` are the new key and the `previous*` ids the old one; the old key now answers "no valid price" |
| `pricing.price-hold-opened.v1` | price-series | `offerId`, `variantId`, `recordId`, `kind` (`regular`, `special`), `direction` (`up`, `down`) |
| `pricing.price-hold-decided.v1` | price-series | `offerId`, `variantId`, `recordId`, `kind`, `outcome` (`approved`, `rejected`, `superseded`) |

- The `cause` list is frozen once the first consumer of `effective-price-changed` is merged: a cause added after that is a new event version (`.v2`), never a new value in `.v1` (Ali).
- No amount is in any event. The vocabulary has no money kind, and consumers (search in Phase 6, notifications) read the facade. If a consumer later needs amounts, a `money` kind is a kernel change with Hassan's review.
- Cost changes publish no event.
- No actor in any payload (ADR-0018 decision 4).

### 6.4 Events consumed
| Event | Handler | Effect |
|---|---|---|
| `catalog.offer-deleted.v1` (CF2) | `pricing.retire-series-for-removed-offer` | Every series of the Offer is retired; pending records → `SUPERSEDED` (cause `offer-removed`); active special → `WITHDRAWN`; events. The Cost series is retired too |
| `catalog.variant-removed.v1` (CF2) | `pricing.retire-series-for-removed-variant` | The same, for series with that (`productId`, `variantId`). It arrives at a draft save too, so a `proposed` Variant that was priced and then deleted has its series retired (P-1) |
| `catalog.offer-moved.v1` (CF4; P1, before catalog's CAT-45 slice) | `pricing.rekey-series-for-moved-offer` | Validated, then applied whole or not at all (steps below). Each non-retired price and Cost series of the Offer with `productId = fromProductId` keeps its id, records, pending holds and specials, and gets `variantId` = its pair's `to` and `productId` = `toProductId`; event `effective-price-changed` (`series-rekeyed`, with the old key); audit. A series that cannot move is retired as for a removed Variant (cause `variant-removed`): fail closed, the seller prices the new Variant again. A tombstone (`fromProductId`, `from`) is recorded for every old key of the Offer, so no series is created under an old key afterwards |

**The re-key handler, step by step (Ali C1; Hassan, High, fixed).**
1. **Read before the unit.** `offerSellUnits(system, [offerId])` (CF1). If the call fails or times out, the handler throws and the delivery is retried with the platform back-off (PE 6.4); a transient error never retires anything.
2. **Refuse the whole event** when the mapping has more than the Market's `catalog.maxVariantsPerProduct` pairs (AU 100, ZZ 3; catalog G2, merged PR #54), a `from` or a `to` appears twice, an id is both a `from` and a `to`, `fromProductId = toProductId`, or the Offer is present and not `deleted` and its `productId` ≠ `toProductId`. A refusal applies nothing: one unit writes only the audit row `pricing.series.rekey-refused` (an `ok` outcome, PE PN1; no `runOnce`, so no inbox row), then the handler dead-letters its delivery at once with code `pricing.rekey.mapping-refused` and logs one error-level line marked for alerting (PE 6.4 dead letter; requeue is the operator routine). Prices stay on the old key until an operator acts; the old key is then served by no published Variant, so no wrong price is reachable.
3. **Offer absent or `deleted`:** every series of the Offer is retired with cause `offer-removed` and the Offer tombstone is recorded, exactly as `pricing.retire-series-for-removed-offer` does.
4. **Otherwise, one `serializable` unit for the whole mapping** (no chunking; Ali): at most 100 Variants per Product (`catalog.maxVariantsPerProduct`, AU 100 and ZZ 3, set by catalog G2 (merged PR #54), the same value inventory relies on, 16), so at most 200 series (price and Cost). A series moves when its Variant is a `from`, the pair's `to` is in the Offer's `sellUnits`, no series exists for (Offer, `to`) and (`toProductId`, `to`) has no tombstone. A `to` outside `sellUnits`, an unmapped Variant, a target series already present or a tombstoned target retires that series only.
5. **Reviewer queue (Hassan, Low).** A pending hold or special carried over by the re-key shows "re-keyed" with the old and the new Variant in the admin queue; the series keeps the old key it was moved from (pricing-data 3.2.1).

**C1 is closed by catalog G2 4.5:** the `product.match` guard requires a total, injective mapping, every non-retired Variant of the seller's product (`proposed` included) to a distinct published Variant of the target, though not necessarily covering every target Variant. With that guard the "cannot move" branch of step 4 is only a backstop; it stays, fail closed. Step 2 does not trust the guard: the event is input and is checked again here.

**No `variant-removed` for a moved Offer (catalog G2 9.7), and why a stray one is harmless.** Catalog sends none for the matched duplicate's Variants; pricing re-keys on `offer-moved` only. If one arrives anyway: after the re-key, the Variant-removed handler looks up series by (`productId`, `variantId`) = the old pair, which no re-keyed series carries any more (it carries `toProductId`), so it only records a tombstone that already exists. Before the re-key (out-of-order delivery), it retires the old series; the re-key handler leaves a retired series as it is, so no price is carried to the new key and the seller prices again. Neither order serves a wrong price, and a stray event can never retire a re-keyed series.

All three use `UnitOfWork.runOnce` with the inbox (ADR-0006 decision 5; PE 6.4), so a repeat is a no-op; only the re-key's refusal (step 2) writes its audit row outside `runOnce` and dead-letters the delivery. The Market comes from the envelope. Retiring an already retired series is a no-op. The two retirement handlers also record a retirement tombstone (Offer, or Product + Variant: Variant-removed carries no Offer id; M5), even when no series exists yet, so a price written after the event never creates a new, never-retired series (Hassan finding 3; the pattern of inventory's 3.5). Both retirement handlers ship in slice 1, because slice 1 creates series (M5); the re-key handler ships before catalog's CAT-45 slice (14). A tombstone is permanent: a removed Variant id never returns (catalog G2 M-1, answering M5 (c)).

### 6.5 Keeping Cost inside (brief s5, ADR-0024 decision 2)
| Layer | Mechanism |
|---|---|
| Model | Separate root, repository and models. A pricing-internal boundary rule: only `infrastructure/cost/` references the Cost models (`PricingCost*`), and only `application/use-cases/*cost*` imports the Cost repository. **Enforced by `pnpm boundaries` in CI**, not by naming convention (H-D1 condition 1) |
| Database (H-D1, decided by Hassan 2026-10-07: option A) | Same group `mondapac_app`; Cost lives only in `cost_series` and `cost_records`, which no price statement touches (pricing-data 7). Conditions: (1) the boundary rule above runs in CI; (2) when the worker gets its own login and group, its access to `cost_records` is revoked in that same PR (it only retires `cost_series`); (3) the design moves to option B (a separate group, login and client for Cost) if raw SQL, a reporting replica or an export ever reads the `pricing` schema. Reason: option B would not stop the real risk (seller A reading seller B's Cost through the Cost repository, which only the ownership check stops) and would split the Cost write from its audit row |
| Raw SQL | None in `pricing`: `$queryRaw`, `$queryRawUnsafe`, `$executeRaw` and `$executeRawUnsafe` are banned under `modules/pricing` by lint or `pnpm boundaries`; spike S1 confirms the ban is active (Hassan, pricing-data review, Low). This also keeps H-D1 condition 3 from triggering |
| Type | `CostAmount` throws on `toJSON`/`toString`. The only reader is `CostPresenter` in `presentation/http/cost/`, which builds the wire DTO `{ amount: string, currency }` |
| Contracts | `contracts/` exports no Cost type; a type-level test asserts that no exported type reaches `CostAmount` |
| Transport | Cost has its own routes (separate from price routes) with `Cache-Control: no-store`. A validation error on them carries in `details` only path and code, never the value (Hassan finding 5) |
| Events, queue, history | None carry Cost (6.3; brief s5) |
| Logs and audit | Log redaction of the Cost DTO, proven by a log-redaction test (Hassan finding 5); audit rows for Cost carry no amount (H2), and the cost record names the actor (Hassan finding 4) |
| AI | None (12) |

## 7. Data ownership (for Mojtaba)
`pricing` owns, in its own schema: price series; regular records; special records; boundary markers; retirement tombstones; cost series; cost records; `pricing.outbox`; `pricing.inbox`. Every row carries `market_id` and `tenant_id`; money is `BigInt` + `char(3)` (ADR-0004). Nothing joins another module's tables. Offer, Variant and seller names on admin and seller screens are composed through the `catalog` and `sellers` facades.

| # | Input |
|---|---|
| PD1 | Regular effective periods: V2 `EXCLUDE USING gist` no-overlap per series (ADR-0009 decision 2). This requires a stored period end, closed in the same unit as the next record's acceptance or approval (M1) |
| PD2 | One pending regular record and one pending special record per series (partial unique indexes); specials in effect never overlap, a `WITHDRAWN` record counting until `withdrawnAt` (exclusion constraint; M4) |
| PD3 | Grants: `INSERT` and `SELECT` on records; `UPDATE` only on status and decision columns and on the period end; no `DELETE` (append-only, brief s5) |
| PD4 | The batch read of 6.2: latest effective regular and active special for up to 200 (offer, variant) keys in one query (M2) |
| PD5 | Queue read: pending records by Market, oldest first |
| PD6 | Boundary markers: unique (special record, boundary) |
| PD7 | Retirement tombstones (Offer, or Product + Variant; M5), read in the unit that creates a series (6.4; Hassan finding 3) |
| PD8 | The CF4 re-key (6.4): `variantId` and the `productId` copy of a price or Cost series change together, only while it is not retired; the series id, Offer, seller, currency and every record stay; one series per (Market, Offer, Variant) still holds after the change; both ids change (never a move inside one product); the series keeps the key it was moved from, for the reviewer queue (6.4 step 5) |

## 8. Audit (brief s9; IMP-10)
The audit writer runs in the caller's unit (PE 3.3). It needs its own design and build before slice 1 (13).

| Action | Target | Before/after |
|---|---|---|
| `pricing.regular-price.accepted`, `.held`, `.superseded` | series, record | Amounts (regular), anchor amount, direction |
| `pricing.price-hold.approved`, `.rejected` | record | Reason code; the optional note stays on the record |
| `pricing.special-price.accepted`, `.held`, `.withdrawn` | record | Amount, window instants and zone |
| `pricing.cost.set`, `.cleared` | cost record | **No amount** (H2); the actor is on the cost record itself (Hassan finding 4) |
| `pricing.offer-write-refused` | offer id | The cause (`absent`, `not-yours`, `other-market`, `deleted`, `variant-not-priceable`) inside the row only; every `offer-not-found` on a write; at most 1 row per (actor, Offer) per minute (H3, Hassan finding 2) and at most 20 per actor per minute (M7) |
| `pricing.series.rekeyed` | series | Old and new (`productId`, `variantId`); no amount (system actor, 6.4) |
| `pricing.series.rekey-refused` | offer id | The event id and the refusal reason (`too-many-pairs`, `duplicate-id`, `from-is-to`, `same-product`, `product-mismatch`); no amount (system actor, 6.4 step 2) |
| `pricing.offer-write-refused.suppressed` | actor | One summary row per actor per minute once the per-actor cap is reached: the count of refusals not recorded, no Offer ids (M7) |

Rows record the actor and, once SEL-08 exists, `acting_as_id`. System transitions (6.4) record the system actor.

## 9. Idempotency and concurrency
- **Writes:** the client sends the series version it displayed. A mismatch returns `conflict.stale` (409), so a double submit or a stale tab never overwrites an unseen change (brief s5: optimistic version). The aggregate version check of PE 10 backs this up.
- **Same value:** setting a regular price equal to the current effective one creates no record. It supersedes a pending one if present (3.1).
- **Strictly increasing starts:** `effectiveFrom = max(now, previous + 1 ms)`, which holds even when API nodes' clocks differ slightly.
- **Approve or reject:** names the record id. If the record is no longer pending, the answer is `pricing.hold.not-pending`.
- **Serializable units (M3):** the unit that creates a series, the two retirement handlers and the re-key handler (6.4) run `serializable`, which closes the write skew between a first price and a retirement or a re-key.
- **Consumed events:** inbox `runOnce` (6.4).
- **Boundary job:** markers make each (record, boundary) publish once (11).

## 10. Where each hard rule is enforced
| Rule (brief s5) | Enforcement point | Test |
|---|---|---|
| Money, Market currency, no assumption | `PriceAmount` factory (domain); the currency comes from `MarketRegistry`, never from a constant | AC 1, 2 |
| > 0, ≤ Market maximum, safe integer | `PriceLimits` in `PriceAmount`; re-checked on approval; boot validation of the policy | AC 4 |
| "From now" only | No input field for a start; `PriceSeries.acceptRegular` sets it from `Clock` | AC 5 |
| Effective-price rule | `EffectivePriceResolver` (single pure service) | AC 3, 14, 16 |
| Hold, anchor, directions | `PriceSeries.proposeRegular(amount, now, policy)` calling `JumpPolicy` | AC 10, 11 |
| One pending per series | Aggregate invariant plus a partial unique index (PD2) | AC 12 |
| Effective from approval; reject leaves the previous price | `PriceSeries.approveHold` / `rejectHold` | AC 10 |
| Special < regular; window in the seller's zone; special discount hold | `PriceSeries.proposeSpecial` and `SpecialWindow`; re-checked in `approveHold`; read-time guard in the resolver | AC 13–15 |
| Every write path goes through the use cases | Repositories are importable only by pricing use cases (ID 5.2 boundary rule 9); a future Import calls the same use cases (ADR-0024 decision 2) | Boundary fixtures |
| Ownership, Variant, Market | Application layer via `offerSellUnits` (CF1, 5.2), advisory, backed by tombstones and serializable units; never from input or the stored copy | AC 7 |
| Cost separate, never leaves | 6.5 | AC 6, 8 |
| Append-only | Aggregate (no content setters), repository (no update of content), grants (PD3) | AC 9 |
| `catalog` never imports `pricing` | Named boundary rule (ADR-0024 decision 5, catalog's slice 1) | Boundary fixtures |
| Freeze only in `ordering` | The facade returns record ids; `pricing` keeps no order data | ordering's tests |

## 11. Jobs
`pricing.publish-special-price-boundaries`, every minute (proposal), per hosted Market. It finds specials whose effective start or end is ≤ now, within the horizon H, and has no marker; accepted, approved and withdrawn specials count as in effect until `min(endsAt, withdrawnAt)` (M4). H = 7 days (M4; an operational value, not a business rule): a boundary older than H is never announced, prices stay correct (4.1), and a daily check counts such boundaries and alerts. In bounded batches, one unit per series, it writes the marker, raises the version and appends `effective-price-changed` (`special-started` or `special-ended`). It is safe to run twice or concurrently (markers; PE 7). Prices are correct without it (4.1); it only tells consumers.

## 12. AI (ADR-0019)
- The brief lists no AI use at launch.
- `pricing` publishes no AI tool, and Cost never reaches a model.
- The approve and reject use cases are decision use cases: AI never approves or rejects a hold (R2, and `pricing` is not on the AI import allow-list). No ADR just for this (decided by Ali, A5): "add price-hold approve/reject to decision 10" is queued for the next ADR that amends ADR-0019, which the owner accepts.
- Dynamic pricing stays P3 with no code (decision 10).

## 13. Slices, prerequisites and tests
- **Prerequisites:**
  - kernel `Money` (slice 1);
  - the audit writer and seal design (before slice 1; identity slice 6);
  - event delivery and inbox (built with identity slice 3);
  - scheduler (slice 5);
  - `catalog` facade `offerSellUnits` (CF1, catalog slice 7) and events CF2 (catalog G2 and slices); `catalog.offer-moved.v1` (CF4) before catalog's CAT-45 slice;
  - sellers: `sellerSummaries` with the time zone (sellers slices 1 and 2; accepted at sellers G2, PR #46) (slice 5);
  - platform `MarketConfig`: `pricesIncludeTax` (and inventory's `maxLineQuantity`), in a small shared-file PR announced on the board first (slice 1; A2);
  - identity's permission registry and default-role seed change (slices 1, 3, 4).
- **Order:** as in brief s11. Slices 1, 3, 4 and 5 need Hassan's review before merge.
- **Tests:**
  - every domain test runs against AU and the second Market `test/fixtures/markets/ZZ.json` (JPY, minor-unit exponent 0, `pricesIncludeTax = false`, different threshold and maximum; Ali);
  - the special-price hold against the anchor (alternating regular and special cuts within W are held; Hassan finding 1);
  - a series is not created after a retirement tombstone (Hassan finding 3); a deleted Offer (present with `status: deleted`) and a Variant outside `sellUnits` answer `pricing.offer-not-found`; a `proposed` Variant can be priced, and its series is retired by a draft-save `variant-removed`; an `offerSellUnits` call never exceeds 200 ids;
  - the re-key (P1): mapped series keep their records under the new key; unmapped, colliding or tombstoned targets and a `to` outside `sellUnits` are retired, that series only; the event carries `previousProductId` and `previousVariantId`; each refusal of 6.4 step 2 (more than 100 pairs, a repeated `from`, a repeated `to`, an id both `from` and `to`, `fromProductId = toProductId`, the Offer's `productId` ≠ `toProductId`) applies nothing, writes one audit row, alerts and dead-letters the delivery; an absent or `deleted` Offer retires every series with `offer-removed` and records the Offer tombstone; an `offerSellUnits` failure or timeout retires nothing and the event is retried; a carried-over hold shows "re-keyed" in the queue; both Market fixtures; a `variant-removed` for the old pair, delivered before or after `offer-moved`, never retires a re-keyed series; old keys answer "no valid price"; the decider is never the submitter (H4); acting-as writes and Cost reads are refused (Hassan finding 6);
  - the Cost log-redaction test and validation `details` without values (Hassan finding 5);
  - the ADR-0005 zone fixtures and DST days for windows;
  - a contracts snapshot of events and the Cost type test; the snapshot test is **mandatory**, as it is the only check of the outbox "no amount" rule (Hassan, pricing-data review);
  - the copies `regular_amount_minor` and `anchor_amount_minor` equal the rows they reference, in `pnpm test:db` or an integration test (Hassan, pricing-data review, Low: no database rule ties them);
  - the refusal throttle: the per-(actor, Offer) cap, the per-actor cap of 20 a minute with one suppressed-summary row, and that the counter and the audit row commit or roll back together (M7);
  - `pnpm boundaries` fixtures: a `PricingCost*` reference outside `infrastructure/cost/` and a raw-SQL call under `modules/pricing` both fail (H-D1);
  - the trigger functions are `SECURITY INVOKER`, checked by the platform.md 10.8 self-check (Hassan, informational);
  - boundary fixtures;
  - one test per AC of brief s10.

## 14. Deferred
| Item | When |
|---|---|
| VER-09 "price at date X" and admin history list (`pricing.price-history.view`) | P1, slice 6; the V2 records already hold everything needed |
| CAT-17 customer-group and tiered prices | P2 |
| Non-fixed `PricingStrategy` (the interface then moves to `contracts/`, A3), sale by actual weight, future-dated regular price | Out of scope (Q3, Q4, Q5) |
| Import of prices (OFR-10..12) | Later; must call the same use cases |
| Re-keying series on CAT-45 Variant mapping (`catalog.offer-moved.v1`, designed in 6.4; one unit, at most 100 pairs) | P1, merged before catalog's CAT-45 slice (CF4); migration 7 and its trigger test in the same PR (pricing-data 8.1, M8) |
| INV-06 bulk price edit; promotions and coupons | P2 |
| Vertical override of `PricingPolicy` | When `catalog` exposes a vertical |
| Notifications of hold outcomes | Phase 6, from the events of 6.3 |

## 15. Open questions
**Owner, through Hadi**
- None. Q1 to Q5 were decided by the owner on 2026-10-07 (table below).

**Jafar**
- J1. The closed list of rejection reason codes and their wording for the seller (Q4).

**Catalog G2 (condition from Ali, A4; met)**
- CF1 to CF4 (6.1) are accepted as ruled by catalog's merged G2 (PR #54, 9.7 and 18) with the refinements of P-1, applied here. A later change to any of them means a mini-review.
- M5 (c). **Closed:** a removed Variant id never comes back (catalog G2 M-1, merged); the (Product, Variant) tombstone stays permanent.
- C1 (Ali, with catalog). **Closed 2026-10-07:** catalog G2 4.5's `product.match` guard maps every non-retired Variant (`proposed` included) one-to-one to a distinct published target Variant, not necessarily covering every target Variant. The "cannot move" branch of 6.4 stays as a fail-closed backstop.

**Still open in Mojtaba's data design (pricing-data 11.2)**
- Mojtaba: fold M7's per-actor counter into pricing-data 3.8, 7 and 8.1 (physical shape is his).
- K1. `btree_gist` available and creatable by the migration role (Kazem).
- S1. Prisma spike (Hossein, with Mojtaba, in slice 1's PR).

**Decided 2026-10-07**
| # | Decided by | Decision |
|---|---|---|
| T1 | Ali | Option A (2.4); confirmed by the owner with W (Q1) |
| Q1 | Owner | W = `P7D` for AU; anchor option A confirmed, an admin approval resetting the anchor (2.2, 2.4) |
| Q2 | Owner | A regular price at or below a running or scheduled special is refused (`pricing.regular-not-above-special`); the seller edits or ends the special first. Re-checked when a held regular price is approved (3.1, 5.5) |
| Q3 | Owner | One special at a time per (Offer, Variant), a new one replacing the current one; approving a held special whose window has ended is refused, the admin rejects instead (2.1, 3.2) |
| Q4 | Owner | The seller sees the rejection's reason code and the optional note; Jafar writes the wording (3.1, 3.2; J1) |
| Q5 | Owner | Default roles as proposed in 5.3: Store Manager and Catalogue and Stock view and edit prices; Cost only with the Seller Owner; Catalogue Moderator views and decides holds (protected) and views history; Viewer gets the view keys |
| M1–M3 | Mojtaba | pricing-data 11.1: a stored period end with column-level `UPDATE` grants; three statements and two partial live indexes for the batch read (6.2); two insert-only tombstone tables, with the creating unit and both handlers `serializable` (9) |
| M4 | Mohammad | (a) PD2 is "one pending special plus no overlap among specials in effect", not "one non-final special" (2.1, 7). (b) A `WITHDRAWN` special is in effect until `withdrawnAt` (3.2, 4.1, 11). (c) Job horizon H = 7 days with a daily alert for older unmarked boundaries (11) |
| M5 | Mohammad | (a) The Variant tombstone is keyed by (Product, Variant) (2.1, 5.2, 6.4, 7). (b) Both retirement handlers ship in slice 1 (6.4). (c) answered by catalog G2 (merged PR #54): a removed Variant id never returns (M-1) |
| M6 | Mohammad | Accepted as proposed: `supersede_cause` (`replaced`, `cancelled`, `offer-removed`, `variant-removed`), `withdraw_cause` (`seller`, `replaced`, `offer-removed`, `variant-removed`), `retire_cause` (`offer-removed`, `variant-removed`); `decision_note` 1 to 1,000 characters (Jafar's wording of J1 does not change the limit); `currency` on the series tables (P2) |
| A1 | Ali | Approved: the one-way dependency on `sellers` (ADR-0005 needs the seller's zone), and dropping the Offer-created subscription. Recorded as a brief change-log row through a mini-review signed by Hadi and Ali (16) |
| A2 | Ali | Option A made a general rule (4.6): values read by more than one module in `MarketConfig`; values read by one module in its own per-Market policy, checked at boot, no default |
| A3 | Ali | Declare `PricingStrategy` now in `pricing/domain`, one `fixed` implementation, no registry (2.2) |
| A4 | Ali | Confirmed: both G2s reviewed now; approval recorded only after catalog G2 accepts CF1–CF4. Met 2026-10-07: catalog G2 merged (PR #54) with CF1–CF4 accepted as ruled |
| A5 | Ali | No ADR just for this; queued for the next ADR that amends ADR-0019 (12) |
| P-1 | Ali | Catalog's G2 (draft 25cbf3a; merged unchanged on these points, PR #54) accepted with refinements: the facade is `offerSellUnits`; priceable = non-retired Variants including `proposed`; a deleted Offer is present with `status: deleted` and no sell units, and a write to it answers `pricing.offer-not-found`; re-key on `catalog.offer-moved.v1`, with no `variant-removed` for a moved Offer's old Variants; `variant-removed` consumed at every retirement, a draft save included; facade reads advisory (ADR-0025 decision 1), ordering re-checks; batches ≤ 200, a larger call refused whole (5.2, 6.1 to 6.4, 9, 13, 14) |
| H1 | Hassan | `allOf(price.edit, cost.view)` (5.2) |
| H2 | Hassan | Accept, with `submittedBy` and the acting-as account on `CostRecord` (finding 4) |
| H3 | Hassan | Accept, with finding 2 (every `offer-not-found` recorded, cause inside the row) and at most 1 audit row per (actor, Offer) per minute (5.2, 8) |
| H4 | Hassan | `pricing.price-hold.decide` protected; the decider is never the submitter (3.1, 5.1) |
| H5 | Hassan | Accept for the in-process facade; an HTTP route taking raw ids filters through catalog's published state (5.2, 6.2) |
| H-D1 | Hassan (pricing-data review) | Option A with three conditions: `pnpm boundaries` enforces the Cost boundary in CI; the worker's access to `cost_records` is revoked in the PR that gives it its own group; move to option B if raw SQL, a reporting replica or an export ever reads the `pricing` schema (6.5) |
| C1 | Ali | Closed by catalog G2 4.5 (see above). `series-rekeyed` carries `previousProductId` and `previousVariantId`; the `cause` list is frozen from the first merged consumer (6.3). No chunking: one `serializable` unit, at most 100 pairs (`catalog.maxVariantsPerProduct` = 100), a larger mapping refused and parked; an `offerSellUnits` failure is retried, never a retirement (6.4) |
| H-R1 | Hassan (High, blocked G2; fixed) | The re-key validates the mapping against `offerSellUnits` and refuses the whole event on a malformed mapping or a product mismatch; an absent or deleted Offer is retired; a `to` outside `sellUnits` retires that series only (6.4 steps 1 to 4, 8, 13) |
| M8 | Hassan | (a) accepted with conditions: the guard requires both columns to change (no move inside one product); only the re-key repository method writes them (`pnpm boundaries`); `down.sql` revokes before dropping triggers; the trigger test, the owner role included, ships in the P1 PR (pricing-data 3.2.1, 8.1) |
| M7 | Mohammad, security half by Hassan | The H3 counter is the PostgreSQL table of pricing-data 3.8, updated in the same unit as the audit row; plus a per-actor cap of 20 rows a minute, then one `pricing.offer-write-refused.suppressed` row; Redis rejected; the general per-account rate limit covers the write routes (5.2, 8) |

## 16. Follow-ups (none in this document's PR)
- Pricing brief change log, through a mini-review signed by Hadi and Ali (A1): `sellers` dependency; no Offer-created subscription; permission keys; the special-price hold also measured against the anchor (Hassan finding 1). Done 2026-10-07: five rows and the matching brief edits (flow 1, s6, three acceptance criteria) are in this PR after all; the owner was informed of the anchor rule. Q2 at hold approval: the approval is refused with `pricing.regular-not-above-special`, the record stays `PENDING_REVIEW` and the admin rejects it with a reason code (Jafar adds the code to J1).
- Identity: seed the default roles as decided (Q5, 5.3).
- Platform: a small shared-file PR, announced on the board first: `pricesIncludeTax` (and inventory's `maxLineQuantity`) in `MarketConfig` (A2).
- Sellers G2: seller zone in the sellers facade (A1, 4.3). Done: sellers G2 merged 2026-10-07 (PR #46) with `operatingTimezone` in `sellerSummaries`.
- `docs/features`: VER-03 wording (ADR-0024).
- ADR-0019 decision 10: queued for the next ADR that amends ADR-0019; the owner accepts that ADR (A5; no ADR just for this).
- Catalog G2: CF1 to CF4. Done: accepted as ruled in catalog's merged G2 (PR #54, 9.7 and 18) with P-1's refinements, applied here.
- Pricing brief change log: s6 adds the consumed event `catalog.offer-moved.v1` (CF4 re-key), through a mini-review signed by Hadi and Ali (row added in this PR).
- Catalog G2: `catalog.maxVariantsPerProduct` = 100 (Ali; the value inventory also relies on). Done: set in catalog G2 7.1 (AU 100, ZZ 3; merged PR #54), so a re-key is one unit of at most 200 series and a mapping of more than 100 pairs is refused and parked, never applied in part (6.4).
- Platform (PE 6.4): a handler can dead-letter its own delivery at once with an error code (today only the entry adapter does); confirmed or added in the re-key's P1 PR.

## 17. Review record

Reviewed 2026-10-07 by Ali (cto, approve with changes) and Hassan (security-tester, accept with changes); both sets of changes are applied in sections 2 to 16. Catalog's G2 is approved and merged (PR #54), meeting Ali's A4; it accepts CF1–CF4 with refinements as ruled (9.7, 18), applied 2026-10-07 under Ali's ruling P-1 (6.1, 6.4). Mojtaba's data design answered M1–M3; his M4–M6 are answered in 15. The screens of brief s12 are still to come (Reza pending, UI condition).

**Ali's decisions**
- Required changes 1–5: `PricingStrategy` declared (2.2, 14); missing seller zone refused with `pricing.seller-zone-unavailable`, zone stored on the record (4.3, 5.5, 6.1, 13, 16); T2 replaced by the A2 rule (4.6, 16); second Market on `ZZ.json`, JPY, exponent 0, `pricesIncludeTax = false` (4.4, 13); A1 and A5 recorded (15, 16).
- T1: option A; confirmed by the owner with W = `P7D` (Q1, 2026-10-07).
- A1: `sellers` dependency and dropped Offer-created subscription approved; brief change-log row through a Hadi and Ali mini-review.
- A2: shared values in `MarketConfig`, single-reader values in the module's policy.
- A3: declare `PricingStrategy` now.
- A4: approval waits for catalog G2. Met: catalog G2 merged (PR #54).
- A5: no ADR; queued for the next ADR-0019 amendment.
- P-1 (2026-10-07, on catalog's G2 draft 25cbf3a, merged as PR #54): `offerSellUnits`; `proposed` Variants priceable; deleted Offer present and refused with `pricing.offer-not-found`; re-key on `offer-moved`; `variant-removed` at every retirement; advisory facade reads; batches ≤ 200, refused whole (5.2, 6.1 to 6.4, 8, 9, 13 to 16).
- No ADR conflict, no new ADR, no import cycle.

**Hassan's findings and answers**
- Finding 1: a special is also measured against the anchor (4.3, 3.2, 2.2). This tightens the hold, which the brief allows (it applies to large price drops, Q8, Q9); it goes into the pricing brief's change log (16).
- Finding 2: every `offer-not-found` on a write is recorded with its cause inside the row (5.2, 8).
- Finding 3: retirement tombstones; no series created after one (2.1, 5.2, 6.4, PD7).
- Finding 4: `CostRecord` stores `submittedBy` and the acting-as account (2.1, 5.4, 8).
- Finding 5: Cost validation `details` carry only path and code; log-redaction test (6.5, 13).
- Finding 6: price, special-price and Cost writes and Cost reads refused in acting-as until the SEL-08 mini-review (5.4).
- H1: `allOf(price.edit, cost.view)`.
- H2: accepted with finding 4.
- H3: accepted with finding 2 and 1 audit row per (actor, Offer) per minute.
- H4: `pricing.price-hold.decide` protected; decider never the submitter.
- H5: accepted for the in-process facade; HTTP routes with raw ids filter through catalog's published state.

**Re-key review (2026-10-07)**
- Ali (cto), accept with changes: C1 closed by catalog G2 4.5, the "cannot move" branch kept as a backstop (6.4, 15); `previousProductId` and `previousVariantId` on `series-rekeyed`, `cause` list frozen from the first merged consumer (6.3); one `serializable` unit, at most 100 pairs (`catalog.maxVariantsPerProduct` = 100), a larger mapping parked, never partial (6.4, 16); `offerSellUnits` failure or timeout retried, never a retirement (6.4); tests (13).
- Hassan (security-tester), **High, blocked G2: fixed by these changes**: the mapping is validated against `offerSellUnits` before the unit; malformed mappings and a product mismatch are refused whole with an audit row, an alert and a dead-lettered delivery; an absent or deleted Offer is retired with `offer-removed`; a `to` outside `sellUnits` retires that series only; a test for each (6.4, 8, 13).
- Hassan, Medium (fixed): the guard trigger requires `NEW.product_id IS DISTINCT FROM OLD.product_id AND NEW.variant_id <> OLD.variant_id`; a `pnpm boundaries` rule lets only the re-key repository method write the two columns; a `test:db` case proves the owner role also gets `23001` (pricing-data 3.2.1).
- Hassan, Low (fixed): a carried-over pending hold or special shows "re-keyed" with the old and new Variant in the reviewer queue (6.4 step 5).
- Hassan, M8 (a) accepted on conditions, all met in pricing-data: the High and Medium changes; migration 7's `down.sql` revokes the grant before dropping the triggers; the trigger test ships in the P1 PR (pricing-data 8.1, 11.2).

**Hassan's review of docs/design/data/pricing.md (2026-10-07; approved with conditions, no Critical or High)**, applied by Mohammad:
- H-D1: option A with its three conditions (6.5, 13, 15).
- M7: PostgreSQL throttle table in the same unit as the audit row; per-actor cap of 20 a minute plus one suppressed-summary row; per-account rate limit on the write routes (5.2, 8, 13, 15).
- Low: a test that `regular_amount_minor` and `anchor_amount_minor` equal the referenced rows (13).
- Low: raw SQL banned under `modules/pricing`, confirmed by spike S1 (6.5, 13).
- Informational: trigger functions stay `SECURITY INVOKER` (platform.md 10.8 self-check); the contract snapshot test is mandatory (13).

**Final G2 verdict, 2026-10-07:** Ali (cto): **approve with conditions** (tier A). Conditions: (1) Hassan reviews every price or Cost write and every facade, event or response that carries Cost before it merges (ADR-0024); (2) Kazem settles pricing-data 8.3 (`btree_gist`, K1); (3) Mojtaba signs off each migration; (4) no UI slice before Reza's `ux.md` and the Figma-first design-system update (ADR-0017, brief s12). Approvers: Mohammad (software-architect), Ali (cto), Mojtaba (database-designer), Hassan (security-tester). **Bagher (qc-release-manager), final check 2026-10-07:** merges cleanly with main, touches only this module's files, no blocking open finding. Follow-up: Reza (ui-ux-designer) pending, UI condition.

## 18. As built in slice 1, part 1 (pure domain)
Slice 1 is built in parts (as inventory's slice 1). Part 1 is the pure domain, with no table, route or permission, so it needs no migration. It adds `PricingPolicy` (`createPricingPolicy` refuses a bad policy at boot: maximum above 0 and at most 2^53 - 1, threshold N/D with 0 < N <= D, window of days, hours and minutes between one hour and 90 days), `PriceAmount` (`pricing.currency-mismatch` before `pricing.amount-out-of-range`), `measureJump` (design 4.2, exact cross-multiplication), `effectiveRegular` (design 4.1 steps 1 and 2; specials join in slice 5), `jumpAnchor` (design 2.4, option A) and the `PriceSeries` aggregate with `setRegularPrice` (design 3.1 rows 1 to 3 and the "equal to the price in force" cancel) and `retire`. Not in part 1: the Q2 special-price guard (it needs the special stream, slice 5), approve and reject (slice 4), persistence, tombstones, the retirement handlers, the permission catalogue, the policy loader from Market files and the audit and refusal-throttle rows. After the part 1 reviews: `setRegularPrice` re-checks the amount against the policy of the write (currency, range) and refuses another Market's policy (`pricing.policy-market-mismatch`); the policy is branded and holds the window as whole milliseconds; `PriceSeries.restore` freezes every record and refuses a stored state that breaks the invariants of 2.1. Tests run on the two Market fixtures through `apps/api/test/support/pricing-fixtures.ts` (AU: AUD, T = 1/2 both ways, W = P7D; the synthetic Market: JPY, T = 1/4 upward only, W = P3D).
