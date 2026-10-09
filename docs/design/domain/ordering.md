# Ordering — G2 domain design

**Author:** Mohammad (software-architect) — 2026-10-08
**Status:** **G2 approved with conditions 2026-10-08** (Ali, Ali G2 review 2026-10-08 section 7; Hassan accepted with changes, Hassan review 2026-10-08). Conditions: (1) **O-1**: Hassan re-checks the elevation text (5.6) before slice 2 code, once the elevation ADR (ADR-0038, ADR-0038 draft) is Accepted; (2) **O-2, O-3, O-7**: Hassan re-checks them in one pass before slice 7 code (O-2 also needs the payments G2 to land the fenced `abandonRefund`, P-7); (3) **O-4, O-5, O-6, O-9, O-10**: checked at code time; (4) **Reza's UI for brief s12 is pending** (Jafar follows). Mojtaba's data design (`docs/design/data/ordering.md`, cited "OD-data") is reviewed; his changes still owed are in Mojtaba change list 2026-10-08. All reviews are applied here (section 17). Tier A: Hassan's review is mandatory for every slice. The checkout Saga is ADR-0035 (ADR-0035 draft, **Accepted** 2026-10-08 after Hassan's review of decisions 3, 5 and 7); the tax-agent timing is ADR-0036 (accepted). Numbers 0035 and 0036 are claimed on the board (rev 134); 0038 is reserved there. Open items: section 15. Review record: section 17.
**Ground truth:** `docs/modules/ordering/brief.md` (G1 approved by the owner on 2026-10-08). Brief sections, owner answers and acceptance criteria are cited as "brief s5", "Q6" and "AC n", where n counts the bullets of brief s10 from 1. Also used:
- ADR-0001 to 0010, 0012, 0013, 0018, 0019, 0020, 0022, 0024, 0025, 0026, 0028 and 0031;
- the Phase 5 rulings outside the repo: Ali Phase 5 review 2026-10-08 ("Ali r1..r9"), Ali G1 review 2026-10-08 ("Ali G1-r1..r8"), Hadi G1 review 2026-10-08, Phase 5 owner questions 2026-10-08, and Ali G2 review 2026-10-08 ("Ali G2", binding: items 1 to 6, rulings T1 to T6);
- Mojtaba's data design `docs/design/data/ordering.md` ("OD-data"; findings F1 to F12, M1, M2) and `docs/design/data/tax.md` ("TD");
- the Phase 5 briefs of `payments`, `commission-payouts` ("C-P"), `tax` and `shipping` (SHP-01, tier B);
- the approved designs `cart.md` ("CRT"), `inventory.md` ("INV"), `pricing.md` ("PRC"), `catalog.md` ("CAT"), `sellers.md` ("SL"), `identity.md` ("ID"), `platform-foundations.md` ("PF") and `platform-persistence-and-events.md` ("PE");
- sellers mini-review 2026-10-08 ("SMR").

**Core never branches on a country.** Every number below that differs by Market comes from Market configuration or a module policy. AU values are examples.

## 1. Scope

This is a design, not an implementation. A signature appears only where the signature is the contract.

- **Decided here:** domain model (2), state machines and the checkout Saga (3), ordering rules (4), authorisation (5), boundary, facades and events (6), data ownership (7), audit (8), idempotency and concurrency (9), where each hard rule is enforced (10), jobs (11), AI (12), slices and tests (13), deferred items (14).
- **In Mojtaba's data design** (`docs/design/data/ordering.md`, written from this model): tables, columns, constraints, indexes, grants, encryption columns and the migration plan. Section 7 only names the data each aggregate holds, plus inputs PD1 to PD18.
- **In Reza's and Jafar's documents:** the brief s12 screens. These are the checkout review, the payment state and retry, line refusal messages, customer order history and detail, the seller order list and detail with the invoice, cancel and delivered actions, and the admin order and refund screens. The server answers with codes (5.5).
- **In the cross-module ADR:** checkout as an orchestrated process manager in `ordering` (Ali r4). The ADR is drafted beside this file.
- **Left open, with the reason:** section 15. Each open item is a business value, another module's G2 decision, or a security call that this design must not invent.

### 1.1 Brief slices and where they are covered
| Slice (brief s11) | Covered in |
|---|---|
| 1 Domain model, state machine and history, snapshot types (test first, two Markets) | 2, 3.1, 3.2, 4.1 |
| 2 Placement: cart hand-off, re-validation, `evaluateClaims`, `tax`, commission rate, snapshot, idempotency, typed address (no address book, Ali G2 item 5), reservation | 3.3 steps P0–P5, 4.1–4.4, 6.1 |
| Address book (Ali T6 A): its own slice after slice 3, own repository | 2.1 `SavedAddress`, 2.4 T6 |
| 3 Saga with `payments`: result events, commit, compensations, expiry and reconciliation jobs, cart clearing | 3.3, 3.4, 6.4, 11 |
| 4 Customer, seller and admin lists and detail, with the customer-data rules (ORD-02..04) | 5.2, 6.2, 7 |
| 5 Partial invoice (ORD-05) with `tax`, event for COM-05 (**blocked until the tax agent confirms in writing**) | 2.1, 3.2, 4.6 |
| 6 Shipment command from `shipping`, delivered mark (SHP-01, Q5) | 3.2, 4.7, 6.3 |
| 7 Line cancel (ORD-06) and admin refund (RET-06) (**blocked until the tax agent confirms in writing**) | 3.5, 4.8 |
| 8 Delivered mark and its correction, flat shipping fee (with slice 2), four emails, admin shipment reversal | 4.5, 4.7, 4.9, 6.4 |
| 9 P1: `allowedActions`, tabs (ORD-07, ORD-08); later the READ tool for AIC-03 | 14, 12 |

## 2. Domain model

### 2.1 Aggregates
Every aggregate root carries `marketId`, `tenantId` (ADR-0003 decision 3, ADR-0020 decision 6), an `Id` from the injected generator (UUIDv7) and a `version` (PE 10). Time comes from `Clock` only (ADR-0005 decision 5). References to other modules are ids only. Money is the kernel `Money` (ADR-0007 decision 1). Rates are exact decimals (ADR-0007 decision 2).

```
Checkout (the Saga's stored state; one per placement attempt)          <- process manager
Order (one per paid-or-pending customer order)
  '-- OrderSnapshotHeader (value: currency, totals, delivery address copy, zone, ServiceArea, locale, fingerprint)
SellerOrder (one per seller in an Order)                                 <- the unit sellers act on
  |-- OrderLine (1..n; snapshot + quantity counters)
  |-- SellerOrderCharge (0..n; Phase 5: one `flat-shipping` charge with its frozen tax; OD-data F6)
  |-- SellerOrderSnapshot (value: store name, tax registration flag + period id, zone, minimum)
  '-- DeliveryMark (0..n)   ShipmentApplication (0..n)   ShipmentReversal (0..n)   LineCancellation (0..n)
Invoice (0..n per SellerOrder; immutable once issued; adjustment notes too)
RefundRequest (0..n per SellerOrder)
InvoiceSequence (one per (Market, seller, series); gap-free counter)
SavedAddress (customer's own; Ali T6 A, its own slice after slice 3)
StatusHistory rows (append-only, V4) for Order, SellerOrder and Checkout
```

| Aggregate | Holds (logical; the physical design is Mojtaba's) | Invariants it owns |
|---|---|---|
| `Checkout` | `customerAccountId`; the client's `idempotencyKey` and a **keyed** hash of the request (HMAC under the customer's subject key, Hassan O-4; the request holds the delivery address) (placement idempotency lives here: unique per (Market, account, key); no separate key table, OD-data F2); `orderId` (generated in step P2, before the Order exists); `reservationId` and `expiresAt` (copied from `inventory`; **stored only here**, OD-data F3); `paymentId`; the Saga `state` (3.3) and, in `REVIEW`, `reviewFromState`; the `cause` of a cancellation; the `rejectCode` of a refused reservation; the current step's `attempts`, `nextAttemptAt` and `lastErrorCode` (a code, never a message, PE 12.3); `stateChangedAt`; a `compensation` sub-record (`kind`: `void` or `refund`, the payments refund id, its status) | **One slot-holding Checkout per (Market, customer account)** (OD-data F1, a measured bug fixed here). Slot-holding states: `STARTED`, `RESERVED`, `AWAITING_PAYMENT`, `COMMITTING`, `CAPTURING`, and `REVIEW` entered from `COMMITTING` or `CAPTURING` (money may be authorised). `VOIDING`, `RELEASING_STOCK`, `CANCELLED`, `COMPENSATING`, the other `REVIEW` rows and the terminal states do **not** hold the slot, so a late compensation (`CANCELLED` → `COMPENSATING`) can never collide with the customer's new checkout, and cleanup never blocks buying (partial unique key, PD3). `REVIEW` entered from `AWAITING_PAYMENT` holds no slot, so a new placement **cancels its payment intent first** (3.3 P2, Hassan O-9). A state moves only along 3.3. `orderId`, `reservationId`, `expiresAt` and `paymentId` are written once each |
| `Order` | `customerAccountId`; `status` (3.1); `placedAt`; `paidAt`; `paymentId`; the snapshot header: currency (the Market's), item total, fee total, tax total and payable total (all `Money`), the delivery address copy (recipient name, address lines, postcode, region, phone as one **encrypted** value, 7), the delivery IANA zone, the `serviceAreaId`, the order locale, and the quote fingerprint (4.2). No region in clear (Ali G2 item 3: `tax` no longer takes it). No `expiresAt` (read from its `Checkout`, OD-data F3) | Exactly one currency, equal to the Market currency. Payable total = Σ SellerOrder payable totals. Its fields never change after creation; only `status`, `cancelCause`, `paidAt` and `paymentId` change, each written once, along 3.1 |
| `SellerOrder` | `orderId`, `sellerId`, `customerAccountId` (a copy, for ownership reads). The snapshot: the seller's public store name; its **tax registration as of placement: the registered flag and the registration period id only** (from `tax`'s answer; **no tax number, no legal identity**: Ali G2 item 2; those are read at invoice issue, 4.6); its approved IANA zone (display; the invoice uses the zone `tax` returns, 4.6); the seller minimum applied. Its `OrderLine`s and `SellerOrderCharge`s. The child records `DeliveryMark`, `ShipmentApplication` (one per `shipping` shipment id, with lines and quantities), `ShipmentReversal`, and `LineCancellation` (line, quantity, reason code from a closed list, actor, `refundRequired`; **no free-text note**, Hassan O-5). Derived fields kept in the same unit as the counters: `displayStatus`, `displayPartial`, `paidAt` (copy of the Order's), `lastDeliveredAt` (OD-data F4) and `refundRequiredSince` (OD-data F7). `version` | Quantity invariants of 4.5 on every line, checked in the aggregate and backed by database CHECKs (PD5). Every quantity change goes through this root and raises its version (PE 10). The derived fields follow 3.2. Snapshot fields never change. Owned by `sellerId`; nothing in it is read across sellers. Every line's frozen `sellerRegistered` equals the sub-order's |
| `SellerOrderCharge` (entity; OD-data F6) | `kind` (`flat-shipping` in Phase 5; Phase 6 adds real shipping kinds, not columns), the amount (`Money`; an explicit zero is valid, AC 14), the sellers-settings version it came from, the price basis sent to `tax` (`taxInclusive`), and its frozen `TaxBreakdown` | One charge of a kind per sub-order. Never in the commission base (Q7). Invoice and refund lines reference a line or a charge uniformly. **A zero charge is never a document line** (its range would be empty): nothing is invoiced or refunded for it, and a document that shows "shipping 0" reads the charge row (OD-data F15; Reza and the tax agent, AG-16, note it). The repository may map it to the `SellerOrderSnapshot` value where the domain reads "the fee" |
| `OrderLine` (entity) | Snapshot (4.1): `offerId`, `variantId`, `productId`, `productRevisionId` (also the revision the tax category was read from: one id, OD-data M1), `contentHash`, the display copy (product name and variant label in the order locale), `unitPrice: Money`, `priceRecordId`, `priceBasis` (`pricing`'s `regular`/`special`), `taxInclusive` (the tax price basis sent to `tax`), `quantity` (ordered), `lineTotal: Money` (= unitPrice × quantity, exact), `TaxBreakdown` (2.2), `taxCategoryCode`, `commissionRate` (decimal), `commissionRateRecordId`, `commissionRateSource` (`seller` or `market`), and the `claims`: one full `ClaimDecision` copy per tag shown (ADR-0028 decisions 2 and 12). Counters: `cancelled`, `invoiced`, `shipped`, `delivered`, `refunded`, `refundLocked`. `reservationLineId` | Counters are non-negative integers. `cancelled + invoiced ≤ quantity`; `shipped ≤ invoiced`; `delivered ≤ shipped`; `refunded + refundLocked ≤ quantity` (4.5). A snapshot field never changes |
| `Invoice` | `sellerOrderId`, `sellerId`, `series` and sequence number (from `InvoiceSequence`), the printed `documentNumber` (format frozen), `kind` (`tax-document`, `plain-document`, `tax-adjustment-document`, `plain-adjustment-document`; from `tax`, labels from Market config), `labelKey`, `issuedAt` (instant), `issueDate` (a local date) and **the zone `tax` returned** (Ali G2 tax verdict), the lines (`orderLineId` with its unit-position range and quantity, or `chargeId` with its cumulative range; the amounts for this document from `tax`; the treatment marker), totals, `requiredFields`, `taxDocumentMandatory`, `buyerIdentityRequired`, the seller legal identity and tax number **read at issue** (`sellers.taxProfileOf` and the S-3 invoice-identity read) and the buyer identity when required, both **encrypted under a per-invoice subject** (Mojtaba option B, accepted by Hassan: a namespaced subject kind, outside customer erasure, destroyed only by the AG-12 retention job), the `tax` rule set id and strategy code, the content hash (**HMAC under the per-invoice subject key**, never an unkeyed SHA-256 over personal fields; Hassan O-4), the seller's `clientKey`, and for an adjustment note the invoice it adjusts and the `RefundRequest` id | Immutable once issued (V3; no update grant, PD7). The number is unique per (Market, seller, series) and gap-free (PD6). The quantities it invoices were reserved in the same unit on the `SellerOrder` (4.6). No unit position of a line is on two invoices, or on two adjustment notes (OD-data F8, EXCLUDE) |
| `RefundRequest` | `orderId` (copy, for the per-Order cap), `sellerOrderId`, `paymentId`, the lines (`orderLineId`, quantity, unit-position range, `kind`: `cancel-and-refund` or `refund`) and the charge share (cumulative range), the goods amount, the shipping-fee share, the total (`Money`; 4.8), `lossBearer` (`seller` default, or `platform`, which needs a reason code), the reason code (closed list; **no free-text note**, Hassan O-5), the requesting admin, `state` (3.5), the payments refund id, `idempotencyKey` (= its id), `version` | Quantities are locked on the `SellerOrder` (`refundLocked`) in the creating unit, which **locks the Order first** (OD-data F11). The amount is computed only from the snapshot (ADR-0007 decision 11). The total ≤ paid minus refunded and minus locked for the **Order**, across its sub-orders (`payments` enforces the same cap again, Ali r5). Content never changes; only state fields change |
| `InvoiceSequence` | (Market, seller, series) → last number. `series`: `invoice`, `adjustment` (one or two series is the agent's AG-11; both run without a migration) | Incremented only inside an invoice-issuing unit, so a rolled-back unit leaves no gap (PD6; measured) |
| `SavedAddress` (Ali T6 A; own slice after slice 3) | `customerAccountId`, a slot, the address (**encrypted**), a label, `lastUsedAt` | At most `ordering.maxSavedAddresses` per account (Market policy; AU 10, proposal), held by a slot key. Removed on the customer-account erasure event (6.4). Own repository; slice 2 never reads it |

### 2.2 Value objects and domain services
| Name | What it is |
|---|---|
| `Money` (kernel) | `{ amount: bigint minor units, currency }`, with largest-remainder `allocate` (ADR-0007 decision 1; Ali's Phase 5 prerequisite: the allocation is in the kernel before slice 1) |
| `Quantity` | A positive integer no larger than the Market line ceiling (`MarketConfig.maxLineQuantity`, AU 99) |
| `TaxBreakdown` | **Exactly the frozen `LineTaxAnswer` of `tax`** (tax G2 6.2, PD7; Ali G2 item 1): `{ gross, tax, net: Money; taxCategoryCode; treatment: 'rated' \| 'free' \| 'seller-not-registered'; rate: decimal string ("0" unless rated); sellerRegistered; registrationPeriodId \| null; ruleSetId; strategyCode; evaluatedAt }`. No `configVersion`, no `taxable` flag. `ordering` never builds one and never does GST arithmetic (brief s5, Ali r3); rates are compared by numeric value, never by text (TD M1). It only sums `gross` amounts, so it stays independent of the tax-inclusive convention (4.3) |
| `ClaimDecisionCopy` | The full `ClaimDecision` of ADR-0028 decision 2, frozen as data. It is never an authorisation afterwards (CERT-21; ADR-0028 decision 2) |
| `QuoteFingerprint` | SHA-256 over the canonical JSON (RFC 8785, the platform-audit `canonicalJson`) of the priced snapshot: lines, price record ids, amounts, tax amounts, fees and the payable total. It carries no secret, because the server always recomputes and only compares (4.2) |
| `LineQuantities` | The six counters plus `quantity`, with the guarded operations `cancel`, `invoice`, `ship`, `deliver`, `lockRefund`, `settleRefund`, `releaseRefundLock`, `reverseShipment` and `correctDelivery`. It is a pure domain service, and the only code that changes a counter (4.5) |
| `SellerOrderStatusDeriver` | A pure function: counters plus terminal facts → display status (3.2). Lists, detail, events and `allowedActions` (P1) all call it |
| `CheckoutStateMachine` | A pure function: (state, input) → (next state, commands to issue). The Saga's only transition rule (3.3) |
| `RefundCalculator` | A pure function: (snapshot, the lines and quantities already refunded or locked, the request) → goods amount, unit-position ranges, shipping-fee share (cumulative largest remainder) with its cumulative range, and total (4.8) |
| `OrderWorkflowExtension` (seam) | Declared in `ordering/domain` with no registry and no implementation (ADR-0001 decision 1; the `PricingStrategy` precedent, PRC A3). It moves to `contracts/` when a Vertical needs sub-states (14) |

### 2.3 Modelling choices that need a reason
| Choice | Reason | Cost |
|---|---|---|
| `Checkout` separate from `Order` | The Saga has states the order does not (reserving, committing, capturing, voiding, compensating). A failed reservation creates no `Order` at all, so a customer's history never shows a dead order. Ali r4 asks for "persisted state" of the process manager | Two rows for one checkout; both are written in the same unit wherever both change |
| `SellerOrder` as its own root, not a child of `Order` | Sellers act on their own sub-order only (ORD-01). One root per seller keeps optimistic locking narrow, so two sellers' invoices never conflict. The `Order` changes only through payment events | `Order` and its `SellerOrder`s are created, and moved to `PAID`, in one unit (same module, same transaction) |
| Quantity counters on `OrderLine`, with the display status derived | Brief s5: the status is derived from quantities, and moving back from a terminal state is forbidden. Counters make the invariants checkable as CHECK constraints (PD5) | A status filter in lists needs a stored derived column, which is updated in the same unit (PD11) |
| Commission rate frozen through a port that `commission-payouts` implements | Avoids an `ordering`↔`commission-payouts` contracts cycle: C-P consumes ordering's events, so `ordering` must not import C-P (T2, 2.4; the pattern of ADR-0028 decision 9) | One port with one implementation, bound at the composition root |
| Event payloads carry no amount | The PE 5.3 vocabulary has no money kind. Consumers read amounts through `ordering.financialFactsOf` (6.2), and those facts never change after they are written | One facade read per consumed event in C-P |
| Side effects after a commit run from ordering's own handlers of its own events | The cart A-1 and inventory Q-A1 pattern. It is durable through the outbox, retried with back-off, and needs no extra intent table. `sellers.recordFirstSale` is one of them, not a Saga step (ADR-0035 decision 2; Ali T3) | Up to the relay latency (< 1 s target) before the stock ledger, the cart, the first-sale mark or an email follows |
| Placement idempotency on `Checkout`, no key table (OD-data F2) | The client key and request hash are already on the Checkout; a second table duplicates them | A client key is a replay only while its Checkout exists: rejected and abandoned Checkouts are pruned after 30 days (11; approved by Ali, A1: replay window ≤ 30 days) |
| `CLOSED` derived, never stored (OD-data F4) | `CLOSED` depends on `Clock` (`closeAfter` since the last delivery); a stored value would be stale | `lastDeliveredAt` stored; `CLOSED` is a read-time predicate in lists and detail |
| No customer cancel button; no seller refund path | Brief s5 and Q12: customers use support, and only an admin runs RET-06 | — |

### 2.4 Toss-ups (ruled by Ali G2, 2026-10-08; kept for the record)
| # | Ruling |
|---|---|
| T1 | **A** (authorise, commit, capture), **only if** the payments G2 confirms manual capture for cards and Apple/Google Pay through Stripe AU and an authorisation life well above the step budget; otherwise ADR-0035 is revised. No quiet fallback (ADR-0035 decision 4) |
| T2 | **A** (`CommissionRateSource` port implemented by C-P) |
| T3 | **A**, amending ordering G1 ruling 4: `sellers.recordFirstSale` is an idempotent command called from ordering's own `order-paid` handler, `at = paidAt`; not a Saga step. `firstSaleAt` is **set once, may only move earlier, never null, never later** (sellers mini-review, Ali ruling 1, 2026-10-08); `sellers` consumes no `ordering` event; an ordering-owned reconciliation job re-sends each seller's earliest `paidAt` (11) |
| T4 | **A** (stock held until expiry after a decline). Hadi adds the brief change-log row; owner informed |
| T5 | **A** (`inventory.reverseShipment`) |
| T6 | **A** (`ordering` owns `SavedAddress`), as its own slice after slice 3 with its own repository; slice 2 takes a typed address only |
| Also | Inventory R1 = 120 days, R2 = UUIDv7; `cartClearWindow` 7 days; the four import-cycle fixes (T2, T3, TX-4, P-6) are binding under `no-circular`, and the payments and C-P G2s inherit them; IP-1 partial quantities approved (lifts inventory Q-A5); checkout NFR as in 13 |
**T1. Capture model** (inventory Q-A2 input from Ali: "commit before capturing payment, so a refusal is a void, not a refund").
| Option | Rule | For | Against |
|---|---|---|---|
| **A (recommended)** | Authorise only (`payments` creates the payment with manual capture). On `payment-authorized`, ordering re-checks may-sell, commits the reservation, then asks `payments` to capture. A refusal before capture is a **void** | Stock-lost and seller-suspended cases cost no refund and no fee; matches Q-A2 | Needs `payments` to support authorise, capture and cancel (requests P-1, P-2, 6.1). One more provider call per order. An authorisation lapses after a provider-defined time, so capture is immediate (3.3) |
| B | Automatic capture; commit after `payment-succeeded`; a refused commit means an automatic full refund | One fewer provider call | Every stock race becomes a refund (fees, and the customer sees a charge and a refund). Contradicts Q-A2 |

**T2. Commission rate without a contracts cycle.** C-P consumes `ordering` events (C-P brief s6; Ali r5: "ordering is the only source of the order lifecycle"), so `ordering` must not import C-P's `contracts/`.
| Option | Rule | For | Against |
|---|---|---|---|
| **A (recommended)** | `ordering/contracts` declares `CommissionRateSource.ratesFor(ctx, sellerIds, at)`; C-P implements it and binds it at the composition root (the ADR-0028 decision 9 `CatalogReferences` pattern). C-P consumes ordering's events and reads amounts through `ordering.financialFactsOf` | One-way C-P → ordering. The ledger stays event-driven, as C-P's brief and Ali r5 want | One port, and a boundary rule naming its only implementer |
| B | `ordering` imports C-P's facade for rates. Its own handlers push ledger commands to C-P (`recordOrderPaid`, …), and C-P consumes nothing from ordering | No inversion | `ordering` must know C-P's ledger commands; this contradicts C-P's brief and Ali's data rule; ordering becomes the ledger's scheduler |

**T3. `firstSaleAt` without an `ordering`↔`sellers` cycle** (Ali G1-r4: "Mohammad checks no ordering↔sellers contract cycle, else shared contracts"). **Finding: there is a cycle.** `ordering` imports `sellers` (`sellingEligibility`, `sellerSummaries`, `approvedSellerZones`, `taxProfileOf`), and SMR 3 has `sellers` consuming `ordering.order-paid.v1`.
| Option | Rule | For | Against |
|---|---|---|---|
| **A (recommended)** | `sellers` consumes no `ordering` event. Ordering's own `order-paid` handler calls `sellers.recordFirstSale(system, { sellerIds, at: paidAt, orderId })`, declared in the restricted contract file `sellers.first-sale.ts` that only `modules/ordering/` may import. The command is idempotent; `firstSaleAt` is **set once, may only move earlier, never null, never later** (amended by the sellers mini-review, Ali ruling 1: an out-of-order delivery may lower it to an earlier `paidAt`) | The cart A-1 pattern; one-way; `at` is the paid instant, as Ali G1-r4 rules | SMR's handler becomes a facade command, so the sellers mini-review text changes (one row) |
| B | Shared contracts: ordering's event definitions move to a shared contracts package that both import | Matches SMR as written | A new kind of shared package, and a precedent for every later cycle. The boundary rules need a new exception |

**T4. Payment declined: release the stock at once, or hold it until expiry?** Brief flow 3(a) says "reservation released (`payment-failed`)", and also "retry until the reservation deadline". `inventory` treats a `payment-failed` release as final (INV 3.1), so a retry after that release could never commit.
| Option | Rule | For | Against |
|---|---|---|---|
| **A (recommended)** | Keep the reservation through a decline. The order goes to `PAYMENT_FAILED`, the customer may retry until `expiresAt`, and the release with cause `payment-failed` happens only when the order is cancelled at the deadline | Retry works; one hold per checkout | Stock stays held up to 15 minutes after a decline (it would expire anyway) |
| B | Release at the first decline; a retry reserves again under a new `checkoutRef` | Stock freed sooner | A retry can fail on stock the customer just held; more calls; more states |

Option A reads brief flow 3(a) as "released when the order is finally cancelled". Hadi confirms that reading, or a brief change-log row records it (15).

**T5. Inventory effect of the admin shipment reversal** (Ali G1-r8: "G2 defines the inventory effect").
| Option | Rule | For | Against |
|---|---|---|---|
| **A (recommended)** | New ordering-port method `reverseShipment(ctx, {orderLineId, quantity, reversalId})`: the units go back from fulfilled to committed, `onHand` + quantity with a movement reason `shipment-reversed` | The stock ledger stays true; the units are pending again for the corrected shipment | An inventory mini-review (port change; request IP-3) |
| B | No inventory effect; the seller corrects stock by hand | No change to `inventory` | The ledger is wrong until the seller notices; a later re-shipment double-decrements |

**T6. Customer address book** (brief s6: no owner today; team proposal: `ordering`, slice 2; "final decision G2/Ali").
| Option | Rule | For | Against |
|---|---|---|---|
| **A (recommended)** | `ordering` owns `SavedAddress`: the customer's own list, encrypted, at most N entries, deleted on account erasure | Checkout is the only consumer; no new module; brief proposal | When Phase 6 `shipping` needs addresses for rates, it reads them through an ordering facade or the address moves (a migration) |
| B | No address book at launch; the address is typed each time (browser autofill), with "use the last order's address" read from the last order | Least scope | Weaker checkout experience; still needs the last order's address read |

## 3. State machines

Every transition is one use case with one read-write unit of work (PE 3.1). It takes its instant from `Clock` and appends one status-history row (V4). A transition that is not listed is forbidden. A call to another module never happens inside a unit (ADR-0004 decision 5): the unit records what was decided, and the call happens before or after it with an idempotency key (3.4).

### 3.1 Order
| From → to | Trigger and guard | Effects |
|---|---|---|
| (none) → `PENDING_PAYMENT` | Placement step P4 (3.3): the reservation is held | `Order` and its `SellerOrder`s are created with the full snapshot (4.1) |
| `PENDING_PAYMENT` → `PAYMENT_FAILED` | `payments.payment-failed.v1` for this order's payment, Checkout in `AWAITING_PAYMENT` | The customer sees "declined, try again"; the reservation is kept (T4 A) |
| `PAYMENT_FAILED` → `PENDING_PAYMENT` | Customer `ordering.retry-payment`, `now < expiresAt` (the Checkout's, read through the 1:1 order → checkout key; OD-data F3) | Returns the same payment's client data (6.1 P-1 is idempotent by `orderId`) |
| `PENDING_PAYMENT`/`PAYMENT_FAILED` → `PAID` | `payments.payment-succeeded.v1` (captured) with Checkout in `CAPTURING`, and the captured amount and currency equal the payable total (read through `payments.paymentOf`) | `paidAt` = the event's `occurred_at`; every `SellerOrder` becomes active (3.2); event `ordering.order-paid.v1`; Checkout → `COMPLETED` |
| `PENDING_PAYMENT`/`PAYMENT_FAILED` → `CANCELLED` | A Saga cancellation (3.3) with a `cause`: `expired`, `superseded`, `stock-lost`, `seller-unavailable`, `capture-failed`, `payment-mismatch`, `payment-start-failed`, `review-closed` (admin, O-7) | The reservation is released or the committed lines are cancelled, as the cause requires (3.3); no event (no consumer before `PAID`; 6.3) |

`PAID` and `CANCELLED` are terminal for the stored status. After `PAID`, the order's display status is derived from its `SellerOrder`s (brief s5, "per seller, as in Bagisto"): all `CANCELLED`/`REFUNDED` → `CANCELLED`/`REFUNDED`; all `CLOSED` → `CLOSED`; otherwise `IN_PROGRESS`. Forbidden: any change from a client claim (AC 10); `CANCELLED` → anything; `PAID` → `CANCELLED` (after payment, money only moves back through RET-06 per line).

### 3.2 Seller order (display status derived from counters)
A `SellerOrder` stores no status column of its own; the status is derived (`SellerOrderStatusDeriver`) and kept in a derived column for list filters (PD11). Quantity names are those of 2.1. Let `open = quantity − cancelled` per line, summed over the sub-order.

| Display status | Derived when (in this precedence order) |
|---|---|
| `PENDING` (stored; never shown to a seller) | The Order is not `PAID` yet (OD-data F4) |
| `VOID` (stored; never shown to a seller) | The Order was cancelled before payment (OD-data F4) |
| `CANCELLED` | Every unit is cancelled (`cancelled = quantity` on every line) and no refund is pending (refund required is shown as a flag, below) |
| `REFUNDED` | Every unit is refunded (`refunded = quantity` on every line) |
| `CLOSED` (**never stored**; OD-data F4) | Stored status `DELIVERED`, no `refundLocked`, and `closeAfter` (Market policy, AU 30 days; owner informed, Ali G2 section 5; `returns` may redefine it with RET-02) has passed since `lastDeliveredAt`. A read-time predicate against `Clock`; no job. An admin refund stays possible after `CLOSED` |
| `DELIVERED` | Every open, unrefunded unit is delivered |
| `SHIPPED` (`partial` flag when some open units are not shipped) | Some units shipped |
| `INVOICED` (`partial` flag when some open units are not invoiced) | Some units invoiced |
| `PROCESSING` | Order `PAID`, nothing invoiced |

Flags shown beside the status: `refundRequired` (cancelled units not yet refunded or locked; held as `refundRequiredSince` on the sub-order, set and cleared in the same unit as the counters, because an append-only `LineCancellation` cannot know that a later refund covered it: OD-data F7), `partiallyRefunded` (0 < refunded < quantity), `refundInProgress` (`refundLocked > 0`).

The stored derived status (`displayStatus`, `displayPartial`) and `lastDeliveredAt` are written by `SellerOrderStatusDeriver` in the unit of every operation; `CLOSED` is computed from them at read time.

Transitions are the counter operations of 4.5, each a use case:

| Operation | Actor and guard | Effect |
|---|---|---|
| `invoice` (ORD-05) | Seller, `ordering.invoice.create`; quantity ≤ `quantity − cancelled − invoiced` per line | Issues an `Invoice` (4.6); event `seller-order-invoiced.v1` |
| `cancel` (ORD-06) | Seller, `ordering.seller-order.cancel-line`, a reason code (mandatory); quantity ≤ `quantity − cancelled − invoiced` (uninvoiced units only) | `LineCancellation` with `refundRequired`; event `order-line-cancelled.v1`; own handler → `inventory.cancelCommittedLine` (IP-1) |
| `ship` (SHP-01) | `shipping`'s command (6.3); quantity ≤ `invoiced − shipped` | `ShipmentApplication`; event `seller-order-shipped.v1`; own handler → `inventory.recordShipment` (IP-1) |
| `deliver` (Q5) | Seller, `ordering.seller-order.mark-delivered`; shipped > delivered on some line | `DeliveryMark` covering every shipped, undelivered unit; event `seller-order-delivered.v1` |
| `correctDelivery` (Q5) | Admin, `ordering.delivery.correct` (protected), reason code, the mark id | The mark is voided (counters go back); event `seller-order-delivery-corrected.v1` |
| `reverseShipment` (Ali G1-r8) | Admin, `ordering.shipment.reverse` (protected), reason code, the shipment application id; **refused when it would make `shipped < delivered`** (`ordering.shipment.delivered-first`: correct the delivery first); **refused when `now − appliedAt > shipmentReversalWindow`** (explicit ordering policy, AU 90 days, Ali G2 item 4; `ordering.shipment.reversal-window-passed`). Boot check: `inventory`'s committed-reservation retention (R1, 120 days) ≥ `shipmentReversalWindow` + 30 days for every hosted Market, otherwise start-up fails | `ShipmentReversal`; counters go back; event `shipment-reversed.v1`; own handler → `inventory.reverseShipment` (T5 A) |
| `lockRefund` / `settleRefund` / `releaseRefundLock` | RET-06 (3.5) | Counters as in 4.5 |

Forbidden: any operation on a `SellerOrder` of an Order that is not `PAID`, and any seller read of it (a seller never lists or opens a `PENDING` or `VOID` sub-order: the seller list keys on `paidAt`, and detail answers `ordering.order-not-found`; OD-data F5); any counter above its bound; invoicing, shipping or cancelling a unit that is refunded or locked for refund beyond the bounds of 4.5; a seller acting on another seller's sub-order (answered as not found, 5.2); un-cancelling a cancellation.

### 3.3 Checkout Saga (process manager; ADR draft)
The Saga is orchestrated by `ordering` (Ali r4). Its state is stored on `Checkout`. Commands go out synchronously through one-way ports (`inventory` ordering port, `cart`, `payments` facade). Payment outcomes come back as `payments` outbox events. Every step is idempotent by a key that is stored before the call (3.4).

```
            P1-P2                 P3                 P4               P5
STARTED ──reserve ok──▶ RESERVED ──payment created──▶ AWAITING_PAYMENT
   │ reserve refused                                  │  ▲ declined / retry (Order PAYMENT_FAILED <-> PENDING_PAYMENT)
   ▼                                                  │ authorized (amount ok)
REJECTED                                              ▼
                                                 COMMITTING ──may-sell ok + commit ok──▶ CAPTURING ──captured──▶ COMPLETED
                                                      │ may-sell no / commit refused / amount mismatch     │ capture failed
   AWAITING_PAYMENT ──expired / superseded──▶ VOIDING ◀──────────────────────────┘                          ▼
                                                 │ cancelled at provider                          RELEASING_STOCK
                                                 ▼                                                         │
                                             CANCELLED ◀─────────────────────────────────────────────────────┘
                                                 │ late capture / success seen for a cancelled order
                                                 ▼
                                            COMPENSATING ──refund succeeded──▶ COMPENSATED
   any open state ──no progress after the step budget, or an unexpected fact──▶ REVIEW (admin queue + alert)
   STARTED ──no reservation answer, 2 × reservation duration──▶ ABANDONED
```

**Placement, in the customer's request** (`ordering.place-order`, `own-resources`, customer population only, refused in an acting-as session):

| Step | What happens | On failure |
|---|---|---|
| P0 | Rate limit (5.4). Validate input: idempotency key (client UUID), a typed delivery address (slice 2; a saved address id only once the address-book slice lands, Ali T6), quote fingerprint. A replay of the same key and the same request hash returns the current view of that Checkout (found by its unique (Market, account, key), OD-data F2). The same key with another hash → `idempotency.key-reused` | Refused; nothing written |
| P1 | Re-validate and price everything from scratch (4.2, 4.3): `cart.getCheckoutLines` → batch reads of `catalog`, `sellers`, `pricing`, `certification.evaluateClaims`, the commission port and `tax`; `catalog.productsForOrder` and the commission port are `system`-only, so they are elevated calls (5.6, entries E1 and E2), after the use case's rule passed and with keys and seller ids from the actor's own cart only. Build the snapshot in memory. Compare the fingerprint | A per-line or per-seller refusal code (5.5), or `ordering.checkout.total-changed` with the new quote. Nothing written; no money taken |
| P2 | Look up the account's **slot-holding** Checkout (2.1; OD-data F1). `COMMITTING`, `CAPTURING`, or `REVIEW` from either → refuse with `ordering.checkout.payment-in-progress`. `RESERVED` or `AWAITING_PAYMENT` → the step "supersede" runs first (below); so does a non-slot `REVIEW` Checkout entered from `AWAITING_PAYMENT` (Hassan O-9: its intent is cancelled before a new one is created). `STARTED` younger than `startedStaleAfter` (Market configuration in the ordering policy section, **no core default**, AU 30 s, above the placement deadline; both fixtures carry a value; Ali A3) → `conflict.retry`; older → its request is dead, so it moves to `ABANDONED` (cause `superseded`) in unit 1. A Checkout that is `VOIDING`, `RELEASING_STOCK`, `CANCELLED`, `COMPENSATING` or in `REVIEW` from another state does not block (its cleanup goes on beside the new checkout; Hassan H6). Unit 1: the old Checkout's state change first, then create `Checkout(STARTED)` with a new `orderId` and the key (OD-data 6.1 order: the slot key is immediate) | `conflict.retry` on the slot key (PD3), e.g. two concurrent placements |
| P3 | `inventory.reserve(customer ctx, {checkoutRef: checkout.id, lines})`; at most 50 lines (INV 4.2) | Unit: Checkout → `REJECTED` with the code (`inventory.insufficient` with its reason codes `out`, `not-enough`, `over-limit`, `retired`; never a number). The customer edits the cart |
| P4 | Unit 2: create the `Order` (`PENDING_PAYMENT`), its `SellerOrder`s and lines with the snapshot, `expiresAt` = the reservation's; Checkout → `RESERVED` | A crash leaves `STARTED`: the client's retry with the same key re-runs P1 and P3, and `inventory` returns the same reservation (same `checkoutRef` and lines, INV 10); otherwise `ABANDONED` (11) and the hold expires |
| P5 | `payments.createPayment(ctx, {orderId, amount: payable total, captureMethod: manual, expiresAt, idempotencyKey: orderId})` (P-1). Unit 3: store `paymentId`; Checkout → `AWAITING_PAYMENT` | The order stays `PENDING_PAYMENT` and the answer is `payments.unavailable`. A retry with the same key, or `ordering.retry-payment`, calls P5 again (idempotent by `orderId`). At expiry the order is cancelled with `payment-start-failed` |

The answer is the order id, the payable total and the provider's client data, never card data. The customer confirms the payment in the provider's form.

**Placement deadline (Hassan O-10).** The placement request has a hard deadline (`placementDeadline`, Market configuration, no core default) enforced in code: past it, the request stops before its next external call and answers `conflict.retry`. Boot refuses a Market whose `placementDeadline` is not strictly below `startedStaleAfter`, so a `STARTED` Checkout abandoned by P2 never belongs to a request that is still running.

**Supersede (one active checkout per customer, brief s5).** When a new placement finds a slot-holding Checkout in `AWAITING_PAYMENT` or `RESERVED`, or a `REVIEW` Checkout entered from `AWAITING_PAYMENT` (O-9): with a payment, before unit 1, `payments.cancelPayment(system, {paymentId, key: cancel:<orderId>})`; `RESERVED` has no payment yet. `cancelPayment` is `system`-only and this call runs in the customer's request, so it is an **elevated call** under ADR-0038 (entry E3 of 5.6), made only after the use case's own rule and the ownership check (the old Checkout is found by the actor's account in the context's Market).
- `cancelled` (or `RESERVED`) → in unit 1 the old Checkout → `CANCELLED` and its order → `CANCELLED(superseded)`, which frees the slot. Its reservation is superseded by the new `reserve` (INV 3.1), so no release call is needed. A late authorisation or capture for the old order takes the `CANCELLED` rows of the handler table (void or compensation); since `CANCELLED` and `COMPENSATING` hold no slot, that path never collides with the new Checkout (the F1 bug). A `REVIEW` Checkout keeps its state (it held no slot) and records the answer for the admin.
- `already-captured` → in unit 1 the old order → `CANCELLED(superseded)` and the old Checkout → **`COMPENSATING` directly** (Hassan O-3), then `refundCompensation` with an alert; the new placement continues.
- `already-authorized`/`processing` → the new placement is refused with `ordering.checkout.payment-in-progress`, so one payment is never left running beside a new one.

**Payment outcome handlers** (system actor, Market from the envelope, inbox `runOnce`; any external call happens before `runOnce`, PE 6.4). **Identity check first (ADR-0035 decision 7):** the event's `paymentId` must equal the Checkout's stored `paymentId` (found through the event's order id); otherwise the event changes nothing on that Checkout: an **orphan payment fact** (event type, payment id, order id, no amount) is stored for the `REVIEW` queue with an alert, and no money is moved automatically.

| Event (names: `payments` G2) | Checkout state | Steps |
|---|---|---|
| `payment-failed` | `AWAITING_PAYMENT` | Unit: Order → `PAYMENT_FAILED`. In any other state: no effect, logged (no money moved) |
| `payment-authorized` (P-2) | `AWAITING_PAYMENT` (order `PENDING_PAYMENT` or `PAYMENT_FAILED`), also after `expiresAt` while not yet cancelled | (1) `payments.paymentOf(paymentId)`: `orderId`, amount, currency and Market must equal the order's, the capture method must be **manual** and the status **authorised, not captured** (ADR-0035 decision 7, Hassan). Otherwise: not captured → `VOIDING(payment-mismatch)` and a `REVIEW` alert; captured → Order `CANCELLED(payment-mismatch)` and Checkout `COMPENSATING`, with an alert. (2) Unit: Checkout → `COMMITTING`. (3) `sellers.sellingEligibility(system, sellerIds)`: any "no" or error → `VOIDING(seller-unavailable)`. (4) `inventory.commitReservation(system, {reservationId, checkoutRef, lines: reservationLineId → orderLineId})`. An expired but unreleased hold is re-taken when the stock fits (INV 3.1). `inventory.insufficient` → `VOIDING(stock-lost)`. (5) Unit: Checkout → `CAPTURING`. (6) `payments.capturePayment(system, {paymentId, key: capture:<orderId>})` (P-2) |
| `payment-authorized` | `CANCELLED` | Late authorisation: `payments.cancelPayment` (void); log. An `already-captured` answer → Checkout `COMPENSATING` directly (O-3) |
| `payment-authorized` | `VOIDING` | Expected race with the void: re-issue `cancelPayment` with the same key; `already-captured` → Order `CANCELLED(cause)` and Checkout `COMPENSATING` directly (O-3) |
| `payment-authorized` | `COMMITTING`, `CAPTURING`, `COMPLETED` (same `paymentId`) | A redelivery under another event id: no effect, logged |
| `payment-authorized` | `REVIEW` | Fact recorded on the review item; alert; stays `REVIEW` (Hassan O-3) |
| `payment-succeeded` | `AWAITING_PAYMENT` or `COMMITTING` (captured before ordering asked: impossible under manual capture) | Unit: Checkout → `REVIEW` (from that state) with an alert; nothing is committed or released automatically, because the admin decides between completing and compensating (Hassan O-3) |
| `payment-succeeded` | `VOIDING` (the void lost the race) | Unit: Order → `CANCELLED(cause)`; Checkout → `COMPENSATING`; then `refundCompensation`; alert (O-3) |
| `payment-succeeded` | `RELEASING_STOCK` | The release continues; when the Order is `CANCELLED(capture-failed)`, the Checkout goes to `COMPENSATING` instead of `CANCELLED`; alert (O-3) |
| `payment-succeeded` | `REVIEW` | Fact recorded on the review item; alert; stays `REVIEW` (O-3). The admin's "close as handled" is then refused until the money is refunded (O-7) |
| `payment-succeeded` | `COMPENSATING`, `COMPENSATED`, `COMPLETED` | A redelivery: no effect, logged |
| `payment-succeeded` (captured) | `CAPTURING` | Unit: amount check again; Order → `PAID`; Checkout → `COMPLETED`; event `ordering.order-paid.v1` |
| `payment-succeeded` | `CANCELLED` (money captured for a cancelled order) | Unit: Checkout → `COMPENSATING`. `payments.refundCompensation(system, {paymentId, key: compensation:<paymentId>})` (P-4), full captured amount. Not RET-06 (Q6 rule 1; Ali r3a) |
| `payment-capture-failed` (P-2) | `CAPTURING` | Unit: Checkout → `RELEASING_STOCK`. Own handler: `inventory.cancelCommittedLine` for each line (IP-1). Then Order → `CANCELLED(capture-failed)` and an alert |
| `payment-cancelled` / `payment-expired` | `VOIDING` or `AWAITING_PAYMENT` | Unit: Order → `CANCELLED(cause)`; Checkout → `CANCELLED`. Own handler: `inventory.releaseReservation(system, {reservationId, cause})` with `cancelled` (expiry, supersede, mismatch, seller-unavailable) or `payment-failed` (declined until the deadline); none for `stock-lost` (the hold is already gone) |
| `refund-succeeded` / `refund-failed` for a compensation key | `COMPENSATING` | Succeeded → `COMPENSATED`. Failed → `REVIEW` and an alert ("money held without an order", payments brief s5: no silent compensation) |
| Any money event (`payment-authorized`, `payment-succeeded`, `payment-capture-failed`, `payment-cancelled`/`payment-expired`, a compensation-key refund event) not listed above as a redelivery | A terminal state: `COMPLETED`, `COMPENSATED`, `REJECTED`, `ABANDONED` (OD-data F14) | The Checkout **never moves** (terminal states are final in the guard trigger). An orphan fact with cause `event-after-terminal` and an alert; no money moves automatically; the admin closes it like any orphan fact (`REVIEW` resolution). `REJECTED` and `ABANDONED` hold no payment id (no payment is created before `RESERVED`), so any event naming them lands here. The redeliveries listed above (`payment-authorized` in `COMPLETED`; `payment-succeeded` in `COMPLETED`, `COMPENSATED`; `payment-failed` anywhere; plus a repeated `refund-succeeded` for the compensation key in `COMPENSATED`, also a redelivery) are "no effect, logged" |

`VOIDING` means `payments.cancelPayment(system, {paymentId, key: cancel:<orderId>})` was issued: a void after authorisation, or a cancel of an unconfirmed intent. If `cancelPayment` answers `already-captured`, the Order → `CANCELLED(cause)` and the Checkout → **`COMPENSATING` directly**, in one unit, without waiting for a `payment-succeeded` event (Hassan O-3; ADR-0035 decision 7). **No money event is ever "ignored" in a state the table does not list:** a `payment-authorized` or `payment-succeeded` in an unlisted **non-terminal** state sends the Checkout to `REVIEW` with an alert; in a terminal state it becomes an orphan fact `event-after-terminal` and the Checkout stays (OD-data F14); a Checkout with no stored `paymentId` (`STARTED`, `RESERVED`) fails the identity check first, so the event is an orphan fact (a test enumerates every state × money event).

**Compensation guard (ADR-0035 decision 5, Hassan).** Ordering calls `payments.refundCompensation` only for a Checkout in `COMPENSATING` whose Order is `CANCELLED` and **was never `PAID`** (`paidAt` null); any other case refuses in the domain and alerts. Every call is audited (`ordering.compensation.started`) and raises an alert. `payments` refuses a compensation refund on a payment that has any RET-06 refund, and a RET-06 refund on a payment that has a compensation refund (mutually exclusive per payment).

**Timeouts** (Market values; AU examples):
- **Payment window** = the reservation duration of `inventory` (AU 15 min, INV Q2). `ordering` never sets its own. The expiry job (11) acts after `expiresAt + expiryGrace` (ordering policy, AU 60 s), so a payment confirmed in the last seconds can still be authorised.
- **Step budget:** a Checkout in `RESERVED`, `COMMITTING`, `CAPTURING`, `VOIDING`, `RELEASING_STOCK` or `COMPENSATING` that has not moved for `stepRetryAfter` (AU 2 min) is re-driven by `ordering.advance-checkouts` (11) with the same keys. After `stepMaxAttempts` (AU 10) or `stepMaxAge` (AU 1 h; `CAPTURING`: well inside the provider's authorisation life, which `payments` G2 states) it goes to `REVIEW`.
- **Abandoned:** `STARTED` older than twice the reservation duration → `ABANDONED` by the job (the hold has expired by then); or older than `startedStaleAfter` when the same customer places again (P2).

**`REVIEW` resolution (Hassan O-7).** An admin with `ordering.checkout-review.resolve` (protected) has two actions, each with a reason code:
- **Re-drive:** sets the step's `nextAttemptAt` to now; the `ordering.advance-checkouts` job (system actor) re-issues the stored command with the stored key. The admin request itself calls no `payments` method, so no elevation is needed.
- **Close as handled:** first reads the provider's final state through `payments.paymentOf` (an elevated read, ADR-0038 entry E4, 5.6). It is **refused** (`ordering.checkout-review.payment-not-final`) while the payment is authorised, or captured and not fully refunded. Otherwise the Checkout → `CANCELLED` (or `COMPENSATED` when a full refund is confirmed) and the Order → `CANCELLED(review-closed)` if it is still `PENDING_PAYMENT`/`PAYMENT_FAILED`. Closing **never sets `PAID`**: only a `payment-succeeded` event in `CAPTURING` does (ADR-0035 decision 7). Orphan payment facts and orphan refund facts (3.5) are closed the same way, after the same `paymentOf` check.

**Compensation table** (one test per row, C1 to C12; brief flow 3, AC 8, AC 9):

| # | Situation | Compensation | Money |
|---|---|---|---|
| C1 | Validation or reservation refused | None (no order) | None taken |
| C2 | Payment start fails | Retry with the same key; at expiry `CANCELLED(payment-start-failed)` + release | None taken |
| C3 | Declined | `PAYMENT_FAILED`; retry until expiry; then cancel + release `payment-failed` | None taken |
| C4 | No payment before the deadline | Cancel the intent; `CANCELLED(expired)`; release `cancelled` | None taken |
| C5 | Authorised, seller no longer may-sell | Void; `CANCELLED(seller-unavailable)`; release | Void |
| C6 | Authorised, stock no longer committable | Void; `CANCELLED(stock-lost)` | Void |
| C7 | Committed, capture fails | Cancel committed lines; `CANCELLED(capture-failed)`; alert | None captured |
| C8 | Captured for a cancelled order (late) | Automatic full refund by the system actor (not RET-06); `COMPENSATED` | Refund |
| C9 | Authorised amount, currency, Market or order id differs, or the capture method is not manual, or it is already captured | Void (captured: compensation); `CANCELLED(payment-mismatch)`; `REVIEW` alert | Void or refund |
| C11 | A money event in a state that does not expect it (O-3) | `VOIDING` or `RELEASING_STOCK` + captured → compensation; `AWAITING_PAYMENT`, `COMMITTING`, `REVIEW` → `REVIEW` + alert; a `paymentId` other than the Checkout's → orphan fact + alert | Refund or admin decision |
| C12 | `cancelPayment` answers `already-captured` (void, supersede or late authorisation) | `COMPENSATING` directly (O-3) | Refund |
| C10 | Crash between any two steps | Re-driven by the reconciliation job with the stored keys | — |

### 3.4 Idempotency keys of the Saga
| Call | Key | Stored before the call in |
|---|---|---|
| Placement | (Market, account, client key) + request hash, unique on `Checkout` (no key table, OD-data F2) | `Checkout` (P2) |
| `inventory.reserve` | (holder, `checkoutRef` = `Checkout.id`) | `Checkout` |
| `payments.createPayment` | `orderId` | `Order` (P4) |
| `payments.capturePayment` | `capture:<orderId>` | Checkout `CAPTURING` |
| `payments.cancelPayment` | `cancel:<orderId>` | Checkout `VOIDING` (or the supersede step) |
| `payments.refundCompensation` | `compensation:<paymentId>` | Checkout `COMPENSATING` |
| `inventory.commitReservation` | `reservationId` + `checkoutRef` + the line mapping (INV 10) | Checkout `COMMITTING` |
| `inventory.releaseReservation` | `reservationId` | Order `CANCELLED` |
| `cart.clearPurchasedLines` | `orderId` (CRT 7.2) | Order `PAID` |
| `sellers.recordFirstSale` (T3 A; post-commit side effect, **not a Saga step**, ADR-0035 decision 2; restricted file `sellers.first-sale.ts`) | Per seller: `firstSaleAt` is **set once, may only move earlier, never null, never later**, so a repeat or a later `at` is a no-op; `at = paidAt`, with `orderId`. Re-sent by `ordering.reconcile-first-sales` (11) | Order `PAID` |

### 3.5 Refund request (RET-06)
| From → to | Trigger and guard | Effects |
|---|---|---|
| (none) → `REQUESTED` | Admin `ordering.refund.execute` (protected; second factor; refused in acting-as). Lines and quantities; kind `cancel-and-refund` (uninvoiced units: they are cancelled in the same unit, and stock is released by the own handler) or `refund`; loss bearer (`platform` needs a reason code from Hadi's closed list `platform-error`, `carrier-loss`, `seller-unrecoverable`, `fraud-loss`, `goodwill`, `other`; none for `seller`; Hadi payments and commission-payouts decisions 2026-10-08 (c) 1); the order is `PAID` | The unit **raises the Order's version first** (serialises refunds across the Order's sub-orders for the per-Order cap; OD-data F11), then the sub-order's; amount computed (4.8); quantities and unit positions locked (`refundLocked`); audit. Then, **in the same admin request, after the unit**: `payments.refund(admin ctx, {paymentId, amount, key: <refundRequest.id>, reason})` (P-3), where `payments` re-checks the admin `ActorContext` (Ali r5) |
| `REQUESTED` → `SUBMITTED` | `payments` accepted the command (sync answer) | Payments refund id stored |
| `REQUESTED` → `SUBMITTED` | Reconciliation: `payments.refundByKey(key)` (P-5) finds one that was accepted but not recorded (a crash) | As above |
| `REQUESTED` → `NOT_SENT` | `payments` **refused** the command synchronously (a definite refusal code, so nothing was sent); or, after `refundSendTimeout` (AU 10 min) with no record at `payments`, the fenced **`payments.abandonRefund(system, key)`** (P-7, Hassan O-2) answers `abandoned`. `abandoned` is a fence: `payments` guarantees that this key is never sent to the provider afterwards and refuses any later command with it. A timeout or `payments.unavailable` never leads to `NOT_SENT` by itself: the request stays `REQUESTED` and the job (11) asks again | Locks released; admin alert; the admin may press again, which creates a new request with a new key. Never re-sent by the system actor, because `payments` refuses a non-admin refund (Ali r5) |
| `REQUESTED` → `SUBMITTED` | `abandonRefund` answers `already-sent` (with the refund id) | As for the sync answer |
| `NOT_SENT` → `REVIEW` | `payments.refund-succeeded.v1` (or `refund-failed`) for the key of a `NOT_SENT` request: the fence failed | No counter changes automatically; alert ("refund outside the record"); the admin resolves it (below) (Hassan O-2) |
| `SUBMITTED` → `SUCCEEDED` | `payments.refund-succeeded.v1` | Before the unit: `tax.reverseRefundTax` (TX-3) and the seller identity reads for the adjustment note. Unit: `refundLocked` → `refunded`; the **adjustment note is issued here**, with its number (series per AG-11), because the amount is final and a failed refund leaves no document (OD-data F12); event `ordering.order-line-refunded.v1`; own handler → refund email (Q10) |
| `SUBMITTED` → `FAILED` | `payments.refund-failed.v1` | Locks released; admin alert |
| `REVIEW` → `SUCCEEDED` | Admin `ordering.refund.execute` (protected, second factor) with a reason code from the refund-resolution list for `SUCCEEDED` (`refund-confirmed-at-provider`, `matched-manually`; Hadi (c) 2), once the `ordering.watch-refunds` job (system actor) has confirmed through `payments.refundByKey` that the refund succeeded and stored that confirmation on the request (so the admin request makes no elevated call), and only if the request's unit positions are still free (not refunded and not locked by a later request) | As `SUBMITTED` → `SUCCEEDED` (counters, adjustment note, event). If the positions are taken, the request stays `REVIEW` and Finance is alerted: the customer was refunded twice, which is handled outside the system (payments' per-Order cap makes this a fence failure, not a normal path) |
| `REVIEW` → `FAILED` | Admin `ordering.refund.execute` (protected, second factor, refused in acting-as) with a reason code from the refund-resolution list for `FAILED` (`refund-failed-at-provider`, `no-refund-found`; Hadi (c) 2; each list tied to its final state by CHECK, OD-data O6a), once the `ordering.watch-refunds` job has confirmed through `payments.refundByKey` that **no refund exists or the provider's refund failed** for the key, and stored that confirmation on the request (OD-data F13; the exit for a `REVIEW` reached by `refund-failed`) | No counter changes (the locks were already released at `NOT_SENT`); the resolution columns are written as for `SUCCEEDED`; audit. Refused while the stored confirmation is missing or says the refund succeeded (then only `REVIEW` → `SUCCEEDED` applies). `FAILED` is terminal |

A `refund-succeeded`/`refund-failed` event whose key matches **no** `RefundRequest` and no compensation key is stored as an **orphan refund fact** (payment id, key, no amount) for the `REVIEW` queue, with an alert and an audit row (`ordering.refund.orphan-seen`); nothing else changes (Hassan O-2).

Forbidden: any seller or customer path (AC 13); a refund computed from current prices; a refund above paid minus refunded minus locked; changing an amount after `REQUESTED`; `NOT_SENT` without a definite refusal or an `abandoned` answer (O-2). `payments` refuses the same key with a different amount or currency (ADR-0035 decision 3).

## 4. Ordering rules

### 4.1 The snapshot (VER-06, ADR-0007 decision 8, ADR-0009 V3, ADR-0028 decision 12)
Taken once, in P1, and written in P4. A later catalog, price, tax, rate or certification change never alters a placed order (AC 4). The snapshot is never an authorisation for anything (CERT-21).

| Per | Frozen | Source |
|---|---|---|
| Line | Product id, revision id, `contentHash`, display copy (name, variant label in the order locale) | `catalog.productsForOrder` (CF1) |
| Line | Unit price, `priceRecordId`, basis, `taxInclusive` | `pricing.getEffectivePrices` (system) |
| Line | Tax category code (read from `productRevisionId`, one id: OD-data M1); `taxInclusive`; `TaxBreakdown` (= the frozen `LineTaxAnswer`) | `catalog` (same CF1 call), `pricing`, `tax.calculateOrderTax` (TX-1) |
| Line | Commission rate, record id, source | `CommissionRateSource` (T2 A) |
| Line | Every displayed tag's full `ClaimDecision` | `certification.evaluateClaims` in the same request (ADR-0028 decision 4) |
| Seller order (charge) | Flat shipping fee as a `SellerOrderCharge`, the settings version, `taxInclusive`, its `TaxBreakdown` | `sellers.sellerSummaries.flatShippingFee` (Ali G1-r7), `tax` |
| Seller order | Store name; **tax registration flag and period id** as of placement (from `tax`'s answer; no number, no legal identity: Ali G2 item 2); approved zone (display); the minimum applied | `sellerSummaries`, `tax.calculateOrderTax`, `approvedSellerZones`, `sellerSummaries.minimumOrder` |
| Order | Currency, totals, delivery address copy (encrypted, region inside it), delivery zone, ServiceArea, locale, fingerprint | Market config, the customer's input |

**Never in the snapshot, a DTO, an event or a log: pricing Cost** (ADR-0024; brief s5). `pricing/contracts` exports no Cost type (PRC 6.5), and a type test plus the contracts snapshot test check `ordering` (AC 18).

### 4.2 "The customer pays what they saw"
- `ordering.quote-checkout` (customer, read-only, no write) runs P1 and returns the lines, the per-seller subtotals and fees, the tax, the payable total, any refusal codes, and the `QuoteFingerprint`.
- `place-order` recomputes and refuses with `ordering.checkout.total-changed` (plus the new quote) when the fingerprint differs (AC 3).
- No price, tax, fee, rate or total is accepted from the client (AC 3; the input DTO has no such field).

### 4.3 Re-validation at placement (fail closed; ADR-0022 decision 6)
For each line of `cart.getCheckoutLines` (CRT 6.6; never trusted):
1. The Offer and Variant are present in the context's Market, the Offer is `published` and `listed`, and the Variant is published on the published revision (CF1). Otherwise `ordering.line.offer-unavailable`.
2. `sellingEligibility` is yes for the line's seller (a "no" or an error refuses that seller's lines: `ordering.line.seller-unavailable`).
3. The price is `priced` in the Market currency. `no-valid-price` or a mismatched currency → `ordering.line.no-price`.
4. Quantity ≤ the line ceiling (`MarketConfig.maxLineQuantity`).
5. For every tag on the Offer: `evaluateClaims` (at most 100 queries per call; one call when lines × tags ≤ 100, otherwise more calls) with inputs taken from the CF1 answer, never from the request (ADR-0028 decision 1). Not allowed, unavailable, an error, or returned inputs that differ from the CF1 state → the line is refused (`ordering.line.claim-not-allowed`). **Never sold silently without the tag** (brief s5, AC 6).
6. Per seller: `flatShippingFee` set (an explicit zero is valid). Absent → that seller's lines are refused (`ordering.seller.shipping-fee-missing`) and an admin alert is logged, at most one per seller per hour (Ali G1-r7, AC 14).
7. Per seller: the subtotal of line totals (the Market's display convention, CRT A-2) ≥ `minimumOrder` when set; otherwise `ordering.seller.below-minimum` with the public minimum.
8. The delivery address: its postcode is in a ServiceArea with `delivery_enabled` (ADR-0005 decision 7), otherwise `ordering.address.outside-service-area`. Its zone comes from the Market's region → zone map (the rule `sellers` uses for `addressZone`, SL 7.1a; it moves to `platform/` if it lives in `sellers` today, request PL-2). The region is used here only; it is not sent to `tax` (Ali G2 item 3) and not stored in clear.
9. Commission rate present for every seller; `tax` answered for every line and fee. Otherwise `ordering.checkout.unavailable` (no default rate, no default tax).

Any refusal refuses the whole placement with every code found, so the customer fixes the cart once. No partial order is ever created.

### 4.4 Money
- One currency per order: the Market currency. Every amount is `Money` (ADR-0007 decision 1). DTOs carry amounts as strings of minor units (decision 10).
- Line total = unit price × quantity (exact; no allocation).
- Sub-order payable total = Σ line `gross` + fee `gross` (from `tax`). Order payable total = Σ sub-orders. **`ordering` computes no GST** (brief s5; PLAYBOOK:137 is superseded by ADR-0007 decision 3). Because `tax` returns `gross` for each line and fee, ordering is independent of `pricesIncludeTax` (AU true; ZZ false).
- Allocation (shipping-fee refunds, 4.8) uses the kernel's largest remainder, with no floating point.
- Commission: the rate is stored only; amounts and recomputation belong to C-P (COM-04, COM-05).

### 4.5 Quantities (brief s5 "Quantities")
Per line, all integers ≥ 0:
- `cancelled + invoiced ≤ quantity` (only uninvoiced units can be cancelled);
- `shipped ≤ invoiced`; `delivered ≤ shipped`;
- `refunded + refundLocked ≤ quantity`;
- a `cancel-and-refund` request takes only units that are uninvoiced and not cancelled; a `refund` may take any unit not yet refunded or locked, and the cancelled units are taken first. A refund of a cancelled unit has no stock effect, because its stock was released at cancellation.

Every operation loads the `SellerOrder`, applies `LineQuantities` and saves with the version check (9), so two concurrent invoices or shipments for the same sub-order cannot both pass (AC 11).

### 4.6 Invoice (ORD-05; slice 5, gated on the tax agent)
- Seller input: lines and quantities, and an idempotency key.
- Before the unit: `tax.decideInvoiceDocument` (TX-2) with the frozen line snapshots, the quantities, the units already invoiced, the fee portion (cumulative gross before and after) and `issuedAt` (= `now`, accepted by `tax` only within `[now − 5 min, now]`; tax reads the seller zone itself, never from input). It answers the kind, the required fields, the GST per line for this document, the issue date with **the zone, which `ordering` stores on the invoice** (not its placement-time zone; Ali G2), and the rule version. Partial documents use tax's **per-unit largest-remainder split** of the frozen line breakdown: the k-th invoiced unit's share is fixed by the snapshot, so partial invoices sum exactly to the line and the calculation is stateless (Ali G2 T7). The frozen snapshot governs the document (tax AG-9, working rule, for the tax agent).
- **Seller identity is read at issue time, not at placement** (Ali G2 item 2): before the unit, `sellers.taxProfileOf` (system, the number) and the S-3 invoice-identity read (legal and trading name as of `issuedAt`); `tax` never sees them. Both are `system`-only and run in the seller's request, so they are **elevated calls** under ADR-0038 (entries E5 and E6, 5.6), made only after the `ordering.invoice.create` rule and the sub-order ownership check passed, for the sub-order's own `sellerId` only. They are stored **encrypted under the invoice's own subject** (PD10; per-invoice subject accepted by Hassan). If the sub-order's frozen registration says registered but no tax number exists at issue, the invoice is refused with `ordering.invoice.seller-tax-number-missing`, nothing is written, and an admin alert is logged (at most one per seller per hour). A frozen "not registered" sub-order gets a plain document and needs no number.
- **Flat shipping fee:** the first invoice of a sub-order carries the whole fee (proposal; tax agent AG-16), as an invoice line on the charge with the cumulative range `[0, fee gross)`; the database refuses a second invoice of the same range (OD-data, charge EXCLUDE).
- Unit: `LineQuantities.invoice`; `InvoiceSequence` + 1; the `Invoice` row; history; event `seller-order-invoiced.v1`. COM-05 reads the net invoiced amounts through `financialFactsOf` (AC 12).
- The issue date is the local date of `issuedAt` in the seller's approved zone, as `tax` returns it (ADR-0005; brief s5). Each invoice line stores its unit-position range `[invoiced before, + quantity)`, taken from the counter under the sub-order lock; no position is invoiced twice (OD-data F8).
- The document is an inert HTML page rendered from the record (no PDF dependency in Phase 5; 14), downloadable from the customer's order page and the seller's panel. It is labelled by `kind`.

### 4.7 Shipment, delivery, reversal
- **Shipment (SHP-01):** applied only through the `shipping` command (6.3); `ordering` never calls `shipping` (Ali G1-r8).
- **Delivered (Q5):** seller only, for shipped units only, audited (who, when). An admin corrects with a reason (AC 17). The event starts C-P's hold. "Not received" holds are C-P's (brief s5).
- **Reversal:** admin only, refused after delivery unless the delivery mark is corrected first (AC 15).

### 4.8 Refund amount (Ali r5; ADR-0007 decision 11)
For one `RefundRequest` on sub-order S with lines L and quantities q (revised 2026-10-08: the earlier "unitPrice × q" was the net, not the amount paid, in an exclusive-price Market such as ZZ):
- unit positions: for each line, `[p, p + q)` where `p` = units already refunded or locked (cancelled units first, 4.5); taken under the Order and sub-order locks;
- before the unit, `tax.reverseRefundTax` (TX-3) with the frozen line answers and those positions returns per line `{gross, tax, net}` of exactly those units (per-unit largest remainder). It is a pure answer on frozen values, so the amounts are fixed at `REQUESTED`. `ordering` still does no GST arithmetic;
- goods = Σ line `gross` of those positions. In an inclusive Market this equals `unitPrice × q` exactly; in an exclusive one it adds the units' tax shares;
- fee share: let G = S's goods value (Σ line gross) and R = S's cumulative goods gross refunded or locked including this request. The fee gross refunded so far must equal `allocate(feeGross, [R, G − R])[0]`, and this request's share is that value minus what earlier requests already took; its cumulative range `[before, after)` of the fee gross is stored, and `tax` reverses its tax from that range (cumulative allocation). So the full fee is refunded exactly when all goods are, and parts always sum to the whole;
- total = goods + fee share (the gross amounts the customer paid, in the payment's currency);
- the adjustment note is issued at `SUCCEEDED` (3.5, OD-data F12) with the amounts stored at `REQUESTED`. `tax` is asked again then, with the same frozen inputs and `issuedAt`, for the date, zone, kind and required fields; its amounts must equal the stored ones (deterministic), otherwise no note is issued and the request goes to an admin alert.

`payments` executes this exact `Money` and only enforces the cap (Ali r5).

### 4.9 Emails (Q10, four; brief s5)
Sent from ordering's own handlers through `platform/mail` (outside `runOnce`, PE 6.4). A send failure never affects the order; the delivery retries and dead-letters with an alert.

| Email | Trigger | Recipient (resolved at send time; never in an event or a log) | Content |
|---|---|---|---|
| Order confirmation (label "Order confirmation", not "Tax invoice"; the tax agent confirms) | `order-paid` | The customer's verified email: `identity.customerContactOf` (ID-1) | Order reference, totals, an authenticated link with only the order id (no personal data in the URL) |
| New order (seller) | `order-paid`, per seller | `identity.sellerOrderRecipients(sellerId)` (ID-2): the Seller Owner plus holders of `ordering.seller-order.view` with a verified email | Order reference and a panel link only. **No customer personal data in the mail** (stricter than brief s5; owner informed, Ali G2 section 5) |
| Refund | `order-line-refunded` | Customer (ID-1) | Amount refunded, order reference, link |
| Shipped | — | Sent by `shipping` after `ordering` accepts its command (Ali G1-r8) | — |

User-entered text (names, notes) is escaped in templates (ADR-0019 R9 posture).

## 5. Authorisation (ADR-0018 decision 4; PF 6.2)

### 5.1 Permission catalogue (`modules/ordering/contracts/permissions.ts`, `registerPermissions('ordering', ORDERING_PERMISSIONS)` in `ordering.module.ts`)
| Key | Scope | Protected | Allows |
|---|---|---|---|
| `ordering.seller-order.view` | seller | no | List and detail of the seller's own **paid** sub-orders, **without** recipient data (lists never carry it: 0 decryptions per list page, OD-data F10); never the email |
| `ordering.seller-order.recipient.view` | seller | no | **Recipient data on the detail** (Hassan O-6): the recipient's name, delivery address and phone of the seller's own paid sub-order, needed to ship. Separate from `seller-order.view`, so a role can see orders without the customer's address. Not protected (seller keys cannot be, ID 5.4 R11) |
| `ordering.invoice.create` | seller | no | Issue a (partial) invoice (ORD-05) |
| `ordering.seller-order.cancel-line` | seller | no | Cancel uninvoiced units with a reason (ORD-06). Seller keys cannot be protected (ID 5.4 R11, PRC 5.1); the Seller Owner decides who holds it |
| `ordering.seller-order.ship` | seller | no | Record a shipment. Declared here because `ordering` owns the quantities; `shipping`'s record use case declares this key (request SH-1) |
| `ordering.seller-order.mark-delivered` | seller | no | Mark shipped units delivered (Q5) |
| `ordering.order.view` | platform | no | Admin list and detail (ORD-03); every view of customer personal data writes an audit row (8) |
| `ordering.refund.execute` | platform | **yes** | RET-06: refund or cancel-and-refund a line |
| `ordering.delivery.correct` | platform | **yes** | Void a delivery mark with a reason |
| `ordering.shipment.reverse` | platform | **yes** | Reverse a shipment application with a reason (Ali G1-r8) |
| `ordering.checkout-review.view` | platform | no | See the `REVIEW` queue (3.3) |
| `ordering.checkout-review.resolve` | platform | **yes** | Re-drive a step (the job re-issues the stored command), or close a reviewed Checkout, orphan payment fact or orphan refund fact as "handled at the provider" with a reason, only after `paymentOf` shows a final state: refused while authorised or captured-not-refunded; never sets `PAID` (3.3, Hassan O-7). Never moves money itself |

Customers hold no keys (PF R2): their use cases are `own-resources` (PF C6).

### 5.2 Use cases
**Ownership** runs in `handle` before the unit opens. The order is looked up by id **in the context's Market** with `customerAccountId = ActorContext.accountId` (customer), or the sub-order with `sellerId = ActorContext.sellerId` (seller). Any miss, whether another owner, another Market, or absent, returns `ordering.order-not-found`, byte-identical, and logged (ID 5.2; AC 13).

| Use case | Access rule | Seller not approved | Notes |
|---|---|---|---|
| `ordering.quote-checkout`, `ordering.place-order`, `ordering.retry-payment` | `own-resources` (customer population) | — | Refused in an acting-as session; rate limited (5.4) |
| `ordering.list-my-orders`, `ordering.view-my-order`, `ordering.download-my-invoice` | `own-resources` | — | The customer's own account only |
| `ordering.list-saved-addresses`, `.save-address`, `.delete-address` (T6 A) | `own-resources` | — | |
| `ordering.list-seller-orders`, `ordering.view-seller-order`, `ordering.download-seller-invoice` | `permissions [ordering.seller-order.view]` | allow (read-only on existing orders; a suspended seller still sees its orders) | Seller from `ActorContext`. Only sub-orders with `paidAt` set, listed by `paidAt` (OD-data F5); an unpaid or pre-payment-cancelled sub-order answers `ordering.order-not-found`. Lists carry no recipient field (F10) |
| `ordering.view-seller-order-recipient` (Hassan O-6) | `permissions [ordering.seller-order.view, ordering.seller-order.recipient.view]` | allow (a suspended seller may still have to ship or cancel) | The **only** seller path that unwraps the customer's subject key. Runs after the ownership check (sub-order of `ActorContext.sellerId` in the context's Market) and only for a **paid** sub-order; refused (`ordering.order.recipient-unavailable`) once the sub-order is `CLOSED` and `recipientVisibleFor` (Market policy, no core default; proposal AU 30 days, Hadi decides) has passed since closing, and for a `VOID`/`PENDING` sub-order (answered as not found). Every decryption writes one audit row `ordering.recipient-data.read` and one log line, **without any value** (actor, sub-order id, correlation id). Refused in an acting-as session |
| `ordering.issue-invoice` | `permissions [ordering.invoice.create]` | deny | Version from the client (9) |
| `ordering.cancel-line` | `permissions [ordering.seller-order.cancel-line]` | allow (a suspended seller must still be able to cancel what it cannot ship) | |
| `ordering.mark-delivered` | `permissions [ordering.seller-order.mark-delivered]` | allow | |
| `ordering.apply-shipment` (port for `shipping`, 6.3) | `permissions [ordering.seller-order.ship]` | allow | Named boundary rule: only `modules/shipping` imports the port |
| `ordering.shipment-status` (port for `shipping` reconciliation) | `system` | — | |
| `ordering.admin-list-orders`, `ordering.admin-view-order` | `permissions [ordering.order.view]` | — | Personal-data read audited |
| `ordering.request-refund` | `permissions [ordering.refund.execute]` | — | Second factor (always for admins); refused in acting-as |
| `ordering.correct-delivery`, `ordering.reverse-shipment` | `permissions [ordering.delivery.correct]` / `[ordering.shipment.reverse]` | — | Reason code required; expected version |
| `ordering.list-checkout-reviews`, `ordering.resolve-checkout-review` | `permissions [ordering.checkout-review.view]` / `[.resolve]` | — | |
| Payment outcome handlers, own-event handlers, jobs, `financialFactsOf` | `system` | — | Market from the envelope or the job |

No ordering use case joins the allow-list of ID 5.2.

### 5.3 Default roles (confirmed by Hadi, owner informed; Ali G2 item 6; ID 5.6 R10)
- **Seller:** Store Manager: all six seller keys. Order Fulfilment: `seller-order.view`, `seller-order.recipient.view`, `.ship`, `.mark-delivered`, `invoice.create`. Customer Service: `seller-order.view`. Bookkeeper: `seller-order.view`. `cancel-line`: Store Manager only by default. **`seller-order.recipient.view` defaults to Store Manager and Order Fulfilment only; Bookkeeper and Customer Service never get it by default** (Hassan O-6; Ali: default roles are seed data, Hadi decides, owner informed); a custom role may grant it.
- **Admin:** Operations and Support: `order.view`, `checkout-review.view`. Finance: `order.view`. Viewer: the unprotected view keys. The protected keys (`refund.execute`, `delivery.correct`, `shipment.reverse`, `checkout-review.resolve`) are granted by the Platform Administrator, since a protected key cannot be seeded (ID 5.6).

### 5.4 Abuse controls (for Hassan)
- `place-order` and `quote-checkout`: per (Market, account) 10 per 15 minutes; per (Market, origin, IPv4 or IPv6 /64) 30 per 15 minutes (proposal). A replay of the same key is not counted. A limiter failure fails closed (`access.unavailable`). These sit beside `inventory.reserve`'s own limits (INV 5.4).
- `retry-payment` (card testing, Hassan O-8): per (Market, account) 5 per 15 minutes and per order 5 in total (proposal), fail closed. `payments` also caps declines per intent and then cancels the intent (P-8, payments G2); the cancellation reaches ordering as `payment-cancelled` (3.3).
- Placement and `retry-payment` limits also run per (Market, client address) and fail closed; a per-Market alert fires on the rate of `decline-cap` cancellations (`PaymentsPolicy.declineCapAlertRate`). The pen test checks velocity in our code, not in Radar (Hassan HP-18, payments G2 review Hassan payments and commission-payouts review 2026-10-08).
- Answers never carry stock numbers (INV 5.4), Cost, or another customer's data.
- Acting-as (SEL-08): customer use cases are refused. Seller writes and `view-seller-order-recipient` are refused until the SEL-08 mini-review decides (the PRC 5.4 posture). **Every use case that needs a protected admin key** (`refund.execute`, `delivery.correct`, `shipment.reverse`, `checkout-review.resolve`) is refused in an acting-as session (Hassan O-10), enforced by one check at the gate for protected keys, with a test per use case.
- Elevated calls (5.6) are refused on any AI-tool call path (ADR-0038; R3); `ordering` has no AI tool in Phase 5.

### 5.5 Answer codes
`ordering.order-not-found`, `ordering.checkout.total-changed`, `ordering.checkout.payment-in-progress`, `ordering.checkout.unavailable`, `ordering.checkout.expired`, `ordering.line.offer-unavailable`, `ordering.line.seller-unavailable`, `ordering.line.no-price`, `ordering.line.claim-not-allowed`, `ordering.line.quantity-out-of-range`, `ordering.seller.below-minimum`, `ordering.seller.shipping-fee-missing`, `ordering.address.outside-service-area`, `ordering.quantity.exceeds-available` (invoice, ship, cancel, refund), `ordering.shipment.delivered-first`, `ordering.shipment.reversal-window-passed` (Ali G2 item 4), `ordering.invoice.seller-tax-number-missing` (Ali G2 item 2), `ordering.refund.exceeds-paid`, `ordering.refund.order-not-paid`, `ordering.order.recipient-unavailable` (O-6), `ordering.checkout-review.payment-not-final` (O-7), `ordering.refund.positions-taken` (O-2 resolution), `idempotency.key-reused`, plus `inventory.insufficient` (passed through with its reason codes), `payments.unavailable`, `conflict.stale`, `conflict.retry`, `validation.failed`, `request.throttled`.

### 5.6 Elevated calls (ADR-0038, ADR-0038 draft; Hassan O-1)
Four `system`-only facade methods are needed inside customer, seller or admin requests. PF 3.7 lets only `platform/` entry adapters mint a system actor, so these calls use the elevation of ADR-0038: `platform/authz` hands the use case a system `CallContext` for **one named target method**, only after the use case's own access rule passed, in the same Market and with the same correlation id; the originating actor is recorded and never used for authorisation. The checked-in allow-list holds exactly these entries (no wildcard; one entry per (use case, target method)):

| Entry | Calling use case (its own rule) | Target (`system`) | Ownership checked before the call | Why the target is `system`-only |
|---|---|---|---|---|
| E1 | `ordering.place-order` (`own-resources`, customer) | `catalog.productsForOrder` | Cart lines read through the actor's own cart (`cart.getCheckoutLines`); keys come from those lines only | Returns revision and claim inputs for snapshotting; CF-1 may instead make it an `anonymous`/`system` pair, which removes E1 and E7 (catalog mini-review) |
| E2 | `ordering.place-order` | `CommissionRateSource.ratesFor` (C-P) | Seller ids from the actor's own cart lines only | Commercial terms of sellers; never shown to customers |
| E3 | `ordering.place-order` (supersede, 3.3) | `payments.cancelPayment` | The old Checkout is the actor's own (account + Market), found by the slot or the `REVIEW`-from-`AWAITING_PAYMENT` rule | A payment command; only `ordering` decides when to cancel |
| E4 | `ordering.resolve-checkout-review` (`permissions [ordering.checkout-review.resolve]`, protected) | `payments.paymentOf` | The Checkout (or orphan fact) is in the admin's Market | Payment facts for reconciliation |
| E5 | `ordering.issue-invoice` (`permissions [ordering.invoice.create]`) | `sellers.taxProfileOf` | The sub-order belongs to `ActorContext.sellerId`; the call names only that seller | The tax number is personal data (SEL 7.1) |
| E6 | `ordering.issue-invoice` | `sellers` invoice identity as of an instant (S-3; name set in the SMR thread) | As E5 | Legal name of a sole trader is personal data |
| E7 | `ordering.quote-checkout` (`own-resources`, customer) | `catalog.productsForOrder` | As E1 | As E1 |

- `quote-checkout` does not read commission rates (the customer never sees them); only `place-order` does.
- Every other cross-module call of `ordering` from a request uses the caller's own context against an `anonymous`/`system` pair or a method that accepts that actor (`sellingEligibility`, `sellerSummaries`, `approvedSellerZones`, `getEffectivePrices`, `evaluateClaims`, `tax.calculateOrderTax`, `decideInvoiceDocument`, `reverseRefundTax`, `payments.createPayment`, `payments.refund`); handlers and jobs run as the system actor and need no entry.
- `refundCompensation`, `capturePayment`, `abandonRefund`, `refundByKey`, `financialFactsOf` and the `SellerTurnoverSource` methods are **never** elevated: no entry names them (re-drive of a step goes through the job, 3.3).
- Tests per entry (Hassan re-checks the entries before slice 2 code): a non-owner or other-Market request is answered `ordering.order-not-found` (byte-identical) and the fake target records **zero** calls; the elevated context passes `isMinted`, carries the same Market and correlation id, and its system actor is refused by any target not named in the entry; the audit and log rows carry the originating actor.

## 6. Boundary

`ordering` imports only `contracts/` of `cart`, `inventory` (ordering port), `catalog`, `certification`, `pricing`, `sellers`, `identity`, `tax` and `payments`, plus the kernel and `platform/`. **It imports neither `commission-payouts` nor `shipping`.** Those two import `ordering`. No module reads ordering's tables.

```
cart, inventory, catalog, certification, pricing, sellers, identity, tax, payments
                         ▲ (facades; payments also by events)
                     ordering   ── declares CommissionRateSource (implemented by C-P), and implements tax's SellerTurnoverSource (P1, TX-4)
                         ▲ (events + facade + ports)
          commission-payouts            shipping (sync command)
```
Cycle checks (the `no-circular` rule): T2 removes ordering↔C-P; T3 removes ordering↔sellers; TX-4 removes ordering↔tax; P-6 removes ordering↔payments (payments must not consume ordering events, contrary to its brief s6); cart and inventory already import nothing of ordering (CRT A-1, INV Q-A1).

### 6.1 What `ordering` needs from others
| # | From | Need | Status |
|---|---|---|---|
| CR-1 | `cart` | `getCheckoutLines` (own-resources) and `clearPurchasedLines` (system, idempotent per `orderId`) as designed (CRT 6.6, 7.2): **re-confirmed** by this G2. `order_clearances` retention: ordering's handler never calls `clearPurchasedLines` more than `cartClearWindow` (7 days, ordering policy) after `paidAt`; it skips and logs instead. Cart's 30-day retention is therefore ≥ ordering's maximum redelivery window (closes CRT M-1). `cartClearWindow` = 7 days ruled by Ali (G2) | Mini-review cart |
| IP-1 | `inventory` ordering port | `reserve`, `commitReservation`, `releaseReservation`, `releaseOwnReservation` as designed (INV 7.2). **Change:** `cancelCommittedLine` and `recordShipment` take `quantity` and a command id (`cancellationId`, `shipmentApplicationId`) for partial operations, since ORD-05 makes partial shipment P0 (AC 11, "4 then 6"). This lifts INV Q-A5 at this gate, as Q-A5 allows; **approved by Ali (G2)** | Mini-review inventory |
| IP-2 | `inventory` | `getSellableExact` is **not needed**; drop it (INV 6, 7.2) | — |
| IP-3 | `inventory` | `reverseShipment(ctx, {orderLineId, quantity, reversalId})` (T5 A) | Mini-review inventory |
| IP-4 | `inventory` | R1: keep committed reservations until 120 days after the last line change (≥ ordering's `shipmentReversalWindow` of 90 days + 30). R2: `checkoutRef` and `orderLineId` are UUIDv7 (`uuid`). Boot check: R1 ≥ `shipmentReversalWindow` + 30 days (3.2) | **Ruled by Ali (G2): R1 120 days, R2 UUIDv7**; inventory mini-review records it |
| CF-1 | `catalog` | `productsForOrder(system, keys ≤ 200)` (O-1, shape set here): per key `{offerId, variantId}` → `sellerId`, `productId`, `offerStatus`, `listed`, `variantPublished` (on the published revision), `publishedRevisionId`, `contentHash`, display name and variant label in the request locale (INTL-13 fallback), `taxCategoryCode` (of that revision; one call replaces `offerTaxCategories` for ordering), and per tag of the Offer: `typeCode`, `handling`, `attestationRecorded`, plus the product's platform category paths (root first) on that revision, which are the `evaluateClaims` inputs (ADR-0028 decision 1). Unknown, other-Market or deleted → absent. Advisory (ADR-0025): ordering re-checks the claim with the returned inputs (4.3 step 5) | Catalog mini-review (O-1) |
| CE-1 | `certification` | `evaluateClaims` (system), with the full `ClaimDecision` content to copy (ADR-0028 decision 12) | Confirmed by a certification mini-review |
| PR-1 | `pricing` | `getEffectivePrices` (system), ≤ 200 keys (PRC 6.2) | As designed |
| S-1 | `sellers` | `sellingEligibility` (≤ 100), `sellerSummaries` with `minimumOrder` and `flatShippingFee` (Ali G1-r7; SMR), `approvedSellerZones` (≤ 100), `taxProfileOf` (system, batch; read **at invoice issue only**, never at placement: Ali G2 item 2) | SMR |
| S-2 | `sellers` | `recordFirstSale(ctx, {sellerIds, at: paidAt, orderId})` (system actor; Ali T3 A), in the restricted contract file `sellers.first-sale.ts` that only `modules/ordering/` may import (named `pnpm boundaries` rule with a failing fixture; sellers mini-review, Ali ruling 4). Idempotent; `firstSaleAt` is **set once, may only move earlier, never null, never later** (Ali ruling 1; not "first write wins"). Called from ordering's own `order-paid` handler (not a Saga step); `sellers.unavailable` is retried with back-off. **`sellers` consumes no `ordering` event**; this replaces SMR's event handler and amends ordering G1 ruling 4. Missed writes (Hassan SMR H1) are repaired by the ordering-owned job `ordering.reconcile-first-sales` (11), which must exist **before `sellers` slice S-d merges** | SMR **approved with conditions 2026-10-08** (sellers mini-review 2026-10-08 sections 8 to 11); `sellers` slice S-a before ordering's `order-paid` handler slice |
| S-3 | `sellers` (with `tax`) | The seller's invoice identity (legal name, trading name) as of an instant, read at issue (4.6); the tax number from `taxProfileOf`. `tax` itself uses a new `sellers.taxRegistrationOf` (no number; tax G2 ST1) | SMR thread (Hadi → Mohammad → Mojtaba → Hassan → Ali), before slice 2 |
| ID-1 | `identity` | `customerContactOf(system, accountId)` → verified email only, for the two customer emails | Identity mini-review |
| ID-2 | `identity` | `sellerOrderRecipients(system, sellerId)`: the reviewer-notice recipient mechanism (ID 8.7 E) for the key `ordering.seller-order.view`, capped | Identity mini-review |
| ID-3 | `identity` | The customer-account erasure event (consumed: saved addresses; order data retention is CUS-03, 14) | Existing |
| TX-1 | `tax` | `calculateOrderTax` (anonymous and system pair; tax G2 6.2): per seller order the lines with unit price, quantity, price basis (from `taxInclusive`), `taxCategoryCode` and `catalogRevisionId` (= `productRevisionId` from CF-1, echoed back; tax does not read `catalog`), and the flat fee as a charge with its basis. **No instant, no zone, no address region** (Ali G2 item 3, T7): tax uses its own `Clock` and reads the seller zone and registration itself (`approvedSellerZones`, `sellers.taxRegistrationOf`). Answer per line and charge: the `LineTaxAnswer` frozen as `TaxBreakdown` (2.2) | **Settled** (Ali G2 T7) |
| TX-2 | `tax` | `decideInvoiceDocument` (4.6): `issuedAt` from ordering, accepted by tax only within `[now − 5 min, now]`, so the date matches the invoice record; the answer's zone is stored on the invoice. Kinds are neutral codes `tax-document`, `plain-document`, `tax-adjustment-document`, `plain-adjustment-document`; Market labels come from config | Settled (T7) |
| TX-3 | `tax` | `reverseRefundTax` (4.8): at `REQUESTED` for the amounts, at `SUCCEEDED` for the adjustment note | Tax G2 |
| TX-4 | `tax` | **tax consumes no ordering event.** The 12-month turnover (P1 warning) reads through a port `tax` declares and `ordering` implements (`system` only): `SellerTurnoverSource.turnoverOf(ctx, sellerIds ≤ 100, from, to)` → net invoiced minus adjusted per seller over [from, to) of the documents' issue instants, and `sellersWithSupplies(ctx, from, to, after, limit ≤ 100)` → seller ids with any document in the window (tax T8, approved by Ali 2026-10-08); both methods on the `system`-only list (tax H6) | Ruled by Ali (tax T3 option D, T8). With tax slice 6 (P1) |
| P-1 | `payments` | `createPayment(ctx, {orderId, customerAccountId, amount, captureMethod: 'manual', expiresAt, idempotencyKey})` → `paymentId` + provider client data; idempotent by `orderId` | Payments G2 |
| P-2 | `payments` | `capturePayment(system, {paymentId, key})`, `cancelPayment(system, {paymentId, key})` → `cancelled` / `already-authorized` / `already-captured`; events `payment-authorized`, `payment-capture-failed`, `payment-cancelled` in addition to the brief's list. Apple and Google Pay with manual capture are verified in test mode (Q13) | Payments G2 |
| P-3 | `payments` | `refund(admin ctx, {paymentId, amount, key, reason})`; the cap and the ActorContext re-check stay in payments (Ali r5) | Payments brief s5 |
| P-4 | `payments` | `refundCompensation(system, {paymentId, key})`: full captured amount only; `system` only and never an elevation target; importable only by `ordering` (named boundary rule); refused when the payment has any RET-06 refund; audited; alert (ADR-0035 decision 5) | Payments G2, Hassan |
| P-5 | `payments` | `paymentOf(system, paymentId)` (order id, amount authorised and captured, currency, status) and `refundByKey(system, key)` | Payments G2 |
| P-6 | `payments` | **payments consumes no ordering event** (its brief s6 lists "checkout cancelled"): `cancelPayment` replaces it | Payments G2 |
| P-7 | `payments` | **Fenced `abandonRefund(system, key)`** → `abandoned` (the key is never sent to the provider afterwards; later commands with it are refused) or `already-sent` (with the refund id). `payments` also refuses the same refund key with a different amount or currency (ADR-0035 decision 3). **The payments G2 cannot pass without it, and ordering slice 7 is blocked until it lands** (Ali, Hassan O-2) | Payments G2 |
| P-8 | `payments` | Cap declines per intent, then cancel the intent; this reaches ordering as `payment-cancelled` (Hassan O-8, card testing) | Payments G2 |
| P-9 | `payments` | `paymentOf` returns the capture method, the status (authorised / captured / refunded amounts) and the Market, so ordering can check decision 7 of ADR-0035; `refundCompensation` and RET-06 `refund` are mutually exclusive per payment (ADR-0035 decision 5) | Payments G2 |
| CP-1 | `commission-payouts` | Implements `CommissionRateSource.ratesFor(system, sellerIds ≤ 100, at)` → per seller `{ rate: decimal string, rateRecordId, source }`; a missing seller is an error (fail closed). Consumes ordering events and `financialFactsOf` | C-P G2 |
| PL-1 | `platform` | Kernel `Money.allocate` (largest remainder); rate limiter; scheduler; outbox/inbox; `SubjectKeyService`; audit writer; `platform/mail` | Ali's prerequisites |
| PL-2 | `platform` | Region → zone (`TimezoneResolver`) and ServiceArea lookup by postcode as platform functions over Market config | Small shared-file PR |
| PL-3 | `platform` | A keyed hash per subject on `SubjectKeyService` (HMAC under a key derived from the subject's key), for `checkouts.request_hash` (customer subject) and `invoices.content_hash` (per-invoice subject) (Hassan O-4); a per-invoice subject kind, namespaced, outside customer erasure, destroyed only by the AG-12 retention job | Platform change, Hassan and Mojtaba |
| PL-4 | `platform/authz` | The elevation mechanism and allow-list of ADR-0038 (5.6), built by Hossein as its own small PR on the backend track; Hassan reviews design and code | Before slice 2 code |

ADR-0031: no placeholder is allowed for any `payments` or `commission-payouts` call, nor for `evaluateClaims` (decision 5). The slices that need them wait for the real facades (13).

### 6.2 Public facade (`modules/ordering/contracts/ordering.facade.ts`)
```ts
interface OrderingFacade {
  // C-P (and tax later): immutable money facts by id; system rule; <= 100 ids
  financialFactsOf(ctx: CallContext, q:
      | { kind: 'order-paid'; orderIds: readonly Id<'Order'>[] }
      | { kind: 'invoice'; invoiceIds: readonly Id<'Invoice'>[] }
      | { kind: 'cancellation'; cancellationIds: readonly Id<'LineCancellation'>[] }
      | { kind: 'refund'; refundRequestIds: readonly Id<'RefundRequest'>[] }):
    Promise<Result<readonly FinancialFact[], OrderingReadError>>;
  // per line: sellerId, sellerOrderId, orderLineId, quantity, gross/net/tax Money,
  // commission rate (decimal string) and its record id, the shipping fee where relevant,
  // lossBearer for refunds. No personal data, no Cost.
}
interface CommissionRateSource {          // declared here, implemented by commission-payouts (T2 A)
  ratesFor(ctx: CallContext, sellerIds: readonly Id<'Seller'>[], at: Instant):
    Promise<Result<ReadonlyMap<Id<'Seller'>, { rate: string; rateRecordId: Id; source: 'seller' | 'market' }>, RateUnavailable>>;
}
```
- Facts never change once written, so a read outside a transaction is exact (ADR-0025 is not a concern here).
- `financialFactsOf` is on the checked-in `system`-only list and is never an elevation target (tax H6, accepted by Hassan; 5.6).
- The read lists for the panels (ORD-02..04) are HTTP use cases, not facade methods. The commission and payout columns (ORD-02/03) and the shipment details on the customer page are composed by the BFF from C-P's and shipping's own reads (Ali G1-r8; C-P brief s6). `ordering` calls neither.

### 6.3 The shipping port (`contracts/shipping-port.ts`; only `modules/shipping` imports it)
- `applyShipment(ctx seller, {shipmentId, sellerOrderId, lines: {orderLineId, quantity}[]})` → `accepted` (with the new quantities) or a refusal (`ordering.order-not-found`, `ordering.quantity.exceeds-available`, `conflict.stale`). Idempotent by `shipmentId`: a repeat returns the first answer (AC 15). One unit; ownership from `ActorContext.sellerId`.
- `shipmentStatus(system, shipmentIds)` → `accepted` / `unknown`, for shipping's reconciliation of its stored intent (Ali G1-r8; shipping brief s6). A refusal writes nothing, so it cannot be answered later (OD-data F9): `shipping` re-sends an `unknown` intent, which is refused again or applied once (idempotent by `shipmentId`). No refusal table. To confirm in the shipping G2.
- `sellerOrderShippable(ctx seller, sellerOrderId)` → per line, shippable quantity, for shipping's form.
- `shipping` sends the "shipped" email only after `accepted` (Ali G1-r8).

### 6.4 Events published (outbox `ordering.outbox`; ids, enums, integers, instants only, PE 5.3)
| Type | Aggregate | Payload | Consumers |
|---|---|---|---|
| `ordering.order-paid.v1` | order | `orderId`, `customerAccountId`, `sellerOrderIds[]`, `sellerIds[]`, `paidAt` | C-P (ledger start), own handlers (cart clear, first sale, two emails) |
| `ordering.seller-order-invoiced.v1` | seller-order | `sellerOrderId`, `sellerId`, `invoiceId` | C-P (COM-05) |
| `ordering.seller-order-shipped.v1` | seller-order | `sellerOrderId`, `sellerId`, `shipmentId` | Own handler (inventory); C-P if its G2 needs it |
| `ordering.seller-order-delivered.v1` | seller-order | `sellerOrderId`, `sellerId`, `deliveryMarkId`, `deliveredAt` | C-P (hold start) |
| `ordering.seller-order-delivery-corrected.v1` | seller-order | `sellerOrderId`, `sellerId`, `deliveryMarkId` | C-P |
| `ordering.shipment-reversed.v1` | seller-order | `sellerOrderId`, `sellerId`, `reversalId` | Own handler (inventory); C-P |
| `ordering.order-line-cancelled.v1` | seller-order | `sellerOrderId`, `sellerId`, `cancellationId`, `orderLineId`, `quantity`, `by` (`seller`, `admin`) | C-P; own handler (inventory) |
| `ordering.order-line-refunded.v1` | refund-request | `refundRequestId`, `sellerOrderId`, `sellerId`, `orderLineIds[]`, `lossBearer` | C-P (proportional reversal, Ali r5), own handler (refund email) |

- **Changes from brief s6:** `order-cancelled.v1` is not published, because a pre-payment cancellation has no consumer (ADR-0015) and post-payment cancellation is per line. `seller-order-delivery-corrected.v1` and `shipment-reversed.v1` are added. Both changes need a brief change-log row (15).
- No amount, no actor, no personal data. A contracts snapshot test is **mandatory**, as in PRC 13.
- Version: each event's `aggregateVersion` is the root's new version (PE 10). Consumers drop stale ones.

### 6.5 Events consumed (inbox `ordering.inbox`, `runOnce`)
`payments.payment-authorized`, `-failed`, `-succeeded`, `-capture-failed`, `-cancelled`, `-expired`, `refund-succeeded`, `refund-failed` (names from payments G2; 3.3, 3.5). Ordering's own events as listed. The `identity` customer-account erasure event (saved addresses). **None from `shipping`, `commission-payouts`, `tax` or `sellers`.**

## 7. Data ownership (for Mojtaba)
`ordering` owns, in its own schema: `checkouts`, `orders`, `seller_orders`, `seller_order_charges` (OD-data F6), `order_lines`, `line_cancellations`, `shipment_applications` (+ lines), `shipment_reversals`, `delivery_marks` (+ lines, corrections), `invoices` (+ lines), `invoice_sequences`, `refund_requests` (+ lines), the three status-history tables, `saved_addresses` (T6 A, own slice), `ordering.outbox` and `ordering.inbox`. No `idempotency_keys` table (OD-data F2); throttle counters belong to the platform limiter. Every row carries `market_id` and `tenant_id`, and indexes lead with `market_id`. Money is `BigInt` + `char(3)`, rates `numeric` (compared numerically), instants `timestamptz` UTC (ADR-0004). Nothing joins another module's tables. Mojtaba's `docs/design/data/ordering.md` answers PD1 to PD18; the rows below are the inputs as revised after it.

| # | Input |
|---|---|
| PD1 | Snapshot columns of 2.1 and 4.1, including the frozen `LineTaxAnswer` per line and per charge (tax PD7). Display copies and `ClaimDecisionCopy` as `jsonb` (written once); everything that is summed or filtered as typed columns |
| PD2 | Status history: append-only (INSERT, SELECT); one row per transition with actor kind, actor id, cause or reason code, `occurredAt` (V4) |
| PD3 | One **slot-holding** checkout per (Market, account): a partial unique key over `STARTED`, `RESERVED`, `AWAITING_PAYMENT`, `COMMITTING`, `CAPTURING`, and `REVIEW` from `COMMITTING`/`CAPTURING` (OD-data F1) |
| PD4 | Placement idempotency: unique (Market, account, client key) on `checkouts` with the request hash (OD-data F2); `REJECTED`/`ABANDONED` checkouts pruned after 30 days (11) |
| PD5 | `order_lines` CHECKs for the 4.5 bounds; counters `integer ≥ 0`; the update grant covers counter columns only |
| PD6 | `invoice_sequences` (Market, seller, series) counter, incremented in the issuing unit; unique (Market, seller, series, number); gap-free under rollback (measured) |
| PD7 | `invoices`: INSERT and SELECT only (immutable); the same for adjustment notes. Per line the unit-position range with an EXCLUDE (no position invoiced or refunded twice); per charge portion the cumulative range with an EXCLUDE (tax PD7) |
| PD8 | `refund_requests`: the content is written once; the update grant covers state fields only; unique key = id; `order_id` copy for the per-Order cap. States add `review` (from `not_sent`, O-2) and the stored provider confirmation the admin's resolution needs (3.5) |
| PD9 | `shipment_applications` unique (Market, `shipment_id`) (shipping's id is the idempotency key) |
| PD10 | Encrypted personal fields (`SubjectKeyService`, ADR-0009 decision 6): the delivery address copy, recipient name and phone (customer subject); the invoice's seller identity and number and buyer identity under a **per-invoice subject** (option B, accepted by Hassan: namespaced subject kind, outside customer erasure, destroyed only by the AG-12 retention job). **No seller tax number on `seller_orders`** (Ali G2 item 2). **No unkeyed hash over personal fields** (Hassan O-4): `checkouts.request_hash` is an HMAC under the customer subject; `invoices.content_hash` an HMAC under the invoice subject (PL-3); `quote_fingerprint` covers no personal field and stays SHA-256. **No free-text notes** on cancellations or refunds: reason codes only (Hassan O-5). Customer erasure waits until the customer has no unshipped sub-order (Ali A2, a CUS-03 design rule; tax-record retention still applies) |
| PD11 | Indexes: seller list (Market, `seller_id`, `paid_at` desc, id) where paid (OD-data F5); customer list (Market, `customer_account_id`, `placed_at` desc); admin list (Market, `placed_at` desc) plus stored status; expiry (Market, `expires_at`) on checkouts; Saga reconciliation (Market, `next_attempt_at`); `REVIEW` queue; refund-required queue |
| PD12 | The derived columns of `seller_orders` (`display_status` with `pending` and `void`, `display_partial`, `paid_at`, `last_delivered_at`, `refund_required_since`), updated in the same unit as the counters (3.2). `CLOSED` is never stored (OD-data F4) |
| PD13 | No DELETE grant except `checkouts` (prune of rejected and abandoned, from M7) and `saved_addresses` (customer delete, erasure) |
| PD14 | `checkouts`: state, `review_from_state`, `reject_code`, step attempts, `next_attempt_at`, `last_error_code`, `state_changed_at`; `order_id`, `reservation_id`, `expires_at` and `payment_id` are write-once; `expires_at` only here (OD-data F3) |
| PD15 | `saved_addresses` (T6 A): at most N per account by a slot key (OD-data 3.13) |
| PD16 | `line_cancellations` keep `refund_required` as the per-cancellation fact; the queue reads `seller_orders.refund_required_since` (OD-data F7) |
| PD17 | `checkoutRef` and `orderLineId` as `uuid`, UUIDv7 (INV R2, ruled) |
| PD18 | Volume estimate for the first year (beta) and an archive plan; orders are never deleted (legal retention from the tax agent) |
| PD19 | **Orphan payment and refund facts** (3.3, 3.5; O-2, O-3): a payment event whose `paymentId` is not the Checkout's, or a refund event whose key matches no request: event type, payment id, key or order id, `seen_at`, resolution (O-7); ids and codes only, no amount; feeds the `REVIEW` queue |
| PD20 | **Recipient data window** (O-6): the seller detail decrypts only for a paid sub-order until `recipientVisibleFor` after `CLOSED`; a read-time predicate on `last_delivered_at` (no new column expected) |

## 8. Audit (brief s9; IMP-10)
| Action | Target | Before/after (no personal data in values, ADR-0009 decision 6) |
|---|---|---|
| `ordering.order.paid`, `.cancelled` (system) | order | Status, cause |
| `ordering.invoice.issued` | invoice | Number, kind, quantities |
| `ordering.line.cancelled` | cancellation | Line, quantity, reason code |
| `ordering.delivery.marked`, `.corrected` | delivery mark | Quantities; reason code on correction |
| `ordering.shipment.applied`, `.reversed` | shipment application | Quantities; reason code on reversal |
| `ordering.refund.requested`, `.submitted`, `.succeeded`, `.failed`, `.not-sent`, `.review`, `.review-resolved` | refund request | Amounts, quantities, loss bearer, reason code |
| `ordering.refund.orphan-seen`, `ordering.payment.orphan-seen` (system, alert) | orphan fact | Event type, ids (O-2, O-3) |
| `ordering.compensation.started`, `.completed`, `.failed` (system) | checkout | Kind, cause |
| `ordering.checkout-review.resolved` | checkout | Action and reason code |
| `ordering.customer-data.read` | order | Who read which order's personal data (admin, ID posture); no value |
| `ordering.recipient-data.read` | seller order | One row per seller decryption of recipient data (O-6): actor, sub-order; **no value** |
| `ordering.seller.shipping-fee-missing` (system, alert) | seller | Counted per hour |

Rows record the actor and, once SEL-08 exists, `acting_as_id`. A row written inside an elevated call (5.6) has the system actor and the **originating actor** (ADR-0038; the column is Mojtaba's sign-off on `platform.audit_log`).

## 9. Idempotency and concurrency
- **Placement:** client key plus request hash, unique on `Checkout` (3.3 P0; OD-data F2); the slot key over slot-holding states only (PD3; OD-data F1). A concurrent second placement gets `conflict.retry`.
- **Saga steps:** the keys of 3.4. Every handler is idempotent through the inbox and the state check (a non-money event in an unexpected state has no effect and is logged; a money event in an unlisted state goes to `REVIEW` with an alert, 3.3, Hassan O-3). Payment events arrive in no guaranteed order (PE 6.2): the state machine, not arrival order, decides.
- **Seller operations:** the client sends the `SellerOrder` version it displayed; a mismatch → `conflict.stale` (PE 10). Invoices also carry a client key (unique per sub-order), so a double submit returns the same invoice.
- **Shipping command:** `shipmentId` (PD9). On a stale version, `shipping` retries the command (the stored intent).
- **Refund:** `RefundRequest.id` is the key to `payments`. The amount and the unit positions are locked in the creating unit, which **raises the Order's version first**, then the sub-order's (OD-data F11): two concurrent requests on two sub-orders of one Order serialise on the Order row, so the per-Order cap (paid − refunded − locked) cannot be passed twice. Lock order for every unit: Checkout → Order → SellerOrder (ascending id) → lines → `InvoiceSequence` → inserts (OD-data 6.1).
- **Invoice numbering:** row lock on `invoice_sequences` inside the issuing unit (one seller's invoices serialise; sellers never contend).
- **Own-event side effects** (inventory, cart, sellers, mail): delivery retries with back-off. Every target is idempotent by its key (3.4, IP-1).
- **Units:** READ COMMITTED (ADR-0025), with optimistic versions. No serializable unit is needed: no unit creates a row that a retirement could race (the PRC M3 case does not arise), and the creation races are decided by unique keys (PE 10).

## 10. Where each hard rule is enforced
| Rule (brief s5) | Enforcement point | Test |
|---|---|---|
| Snapshot frozen; never re-read for a placed order | `Order`/`SellerOrder`/`OrderLine` factories (no setters); grants (PD1, PD5) | AC 4 |
| Claim at the purchase moment; refuse, never sell without the tag | `place-order` step P1 (4.3 step 5); the CF1 inputs compared with the returned inputs | AC 6 |
| Customer pays what they saw; no client money | Input DTO without money fields; `QuoteFingerprint` compare in P1 | AC 3 |
| Idempotent placement; one active checkout | P0 key; PD3 | AC 2 |
| Money from the snapshot only; no GST in ordering | `RefundCalculator`; `tax` facade for every breakdown; a boundary rule: no `tax/domain` import, and no decimal arithmetic on tax outside `tax` (code review plus a lint rule on `TaxBreakdown` construction) | AC 5, AC 13 |
| Quantities bounded | `LineQuantities` (domain) + CHECKs (PD5) + version | AC 11, AC 12 |
| Only admins refund; payments re-checks | `request-refund` access rule; P-3 re-check; no seller or customer route | AC 13 |
| Saga: no money without an order, no order without stock | `CheckoutStateMachine`; reconciliation job; `REVIEW` | AC 8, AC 9 |
| No state change from a client claim | Only payment events (signed webhooks at `payments`) move the Order to `PAID`; the amount check against `paymentOf` | AC 10 |
| Fail closed on other modules | Every facade error in P1 refuses the placement; may-sell re-checked before commit | AC 7 |
| Flat fee present or refuse | 4.3 step 6 | AC 14 |
| Delivered: seller, shipped units, audited; admin correction | `mark-delivered`/`correct-delivery` use cases | AC 17 |
| Reversal refused after delivery | `LineQuantities.reverseShipment` guard | AC 15 |
| No Cost anywhere | Contracts snapshot and type test; log redaction test | AC 16 |
| Ownership and IDOR | `handle` of each use case; byte-identical not-found | AC 13 |
| Market isolation | Repositories take `MarketContext`; the guard (PE 4) | AC 21 |
| No country branch | Values from Market configuration and policies; both fixtures | All |

## 11. Jobs
All in the `worker` role, per hosted Market, system actor, bounded batches, safe to run twice (PE 7).

| Job | Every | Does |
|---|---|---|
| `ordering.expire-checkouts` | 1 min | Orders `PENDING_PAYMENT`/`PAYMENT_FAILED` with Checkout `AWAITING_PAYMENT`/`RESERVED` past `expiresAt + expiryGrace` → `VOIDING` (C2, C3, C4) |
| `ordering.advance-checkouts` | 1 min | Re-drives the steps of 3.3 past `stepRetryAfter` with the stored keys; `paymentOf`/`refundByKey` to learn what happened; `REVIEW` after the budget; `STARTED` → `ABANDONED` |
| `ordering.watch-refunds` | 5 min | `REQUESTED` past `refundSendTimeout` → `refundByKey`; found → `SUBMITTED`; not found → the fenced `abandonRefund` (P-7): `abandoned` → `NOT_SENT`, `already-sent` → `SUBMITTED`, unavailable → stays `REQUESTED` (O-2). For `REVIEW` requests, `refundByKey` again and store the provider confirmation (succeeded, or failed / not found) the admin's resolution needs (3.5; `SUCCEEDED` or, OD-data F13, `FAILED`); alert on sub-orders whose `refundRequiredSince` is older than `refundTargetTime` (AU 24 h, proposal; brief flow 5 "with a target time") |
| `ordering.prune-checkouts` | 1 h | Deletes `REJECTED` and `ABANDONED` Checkouts older than 30 days (they have no Order); replaces the key prune (OD-data F2, 9.2). **Approved by Ali (A1)**: the client idempotency-key replay window is therefore at most 30 days, and a boundary test proves a key at 30 days minus one second replays and a pruned one does not |
| `ordering.shred-invoice-identities` | 1 day | With slice 5; active once AG-12 sets the Market's invoice retention period (no core default; until then it destroys nothing and logs that the period is unset). Destroys the per-invoice subject key (PD10, Hassan option B) of each invoice and adjustment note issued before `now − retention`, in batches of ≤ 100, one audit row per destroyed subject (ids only). Safe to run twice (OD-data 9.3) |
| `ordering.reconcile-first-sales` | 1 h | **Sellers mini-review, Hassan H1(b), Ali ruling 2.** One Market per run, system actor. Lists the sellers with any paid sub-order, keyset by seller id, batches of ≤ 100, and for each the **earliest** `paidAt` and that sub-order's order id; calls `sellers.recordFirstSale(system, {sellerIds: [seller], at, orderId})` (one call per distinct `(at, orderId)`). Since `firstSaleAt` only moves earlier, a re-send is a no-op and a missed or late write is repaired. Reads only ordering's own tables, **never `sellers`' tables**. `sellers.unavailable` → the batch is retried next run and an alert after two failed runs; a refusal (unknown seller, `at` refused by `sellers`) → error metric and alert, never silent. **Must be merged before `sellers` slice S-d** (the cap condition; release-gate line for Bagher). Query plan on `seller_orders_market_id_seller_id_paid_at_idx` to be confirmed by Mojtaba (OD-data) |

Correctness of expiry and `CLOSED` never depends on a job: both are evaluated against `Clock` at read and decision time.

## 12. AI (ADR-0019)
- None in Phase 5 (decision 8, brief s3). No ordering file is on the `platform/ai` allow-list.
- The Saga, the snapshot, refunds, invoices, delivered marks and corrections are deterministic or decision paths (decision 10). No model output feeds them (R2).
- Later: the AIC-03 READ tool "where is my order" in `assistant`, Phase 6, after this facade is merged. Signed-in customer's own orders only, no address, phone or payment data (R3, R9).

## 13. Slices, prerequisites and tests
- **Prerequisites:** identity customer session, permission registry, email verification, the mail recipient methods (ID-1, ID-2); the platform items (PL-1, PL-2); `sellers` slice 9 (`sellingEligibility`), slice 20 (`minimumOrder`), `flatShippingFee` and `recordFirstSale` (SMR); catalog `productsForOrder` (CF-1); `certification.evaluateClaims`; pricing slice 2; inventory slices 1–5 with IP-1/IP-3; cart slices 1–5; the `tax`, `payments` and C-P facades (ADR-0031 decision 5: no placeholders for payments, C-P or claims). The tax agent's written confirmation before slices 5 and 7 (ADR-0036; Q1, Ali G1-r2). The payments G2 confirmation of ADR-0035 decision 4 before slice 3. The mini-reviews of Ali G2 section 4 (sellers SMR thread before slice 2; inventory IP-1 to IP-4; cart CR-1; catalog CF-1; certification CE-1; identity ID-1, ID-2). **ADR-0038 Accepted and the elevation PR (PL-4) merged, and Hassan's re-check of 5.6, before slice 2 code** (O-1). **The fenced `abandonRefund` (P-7) in the payments G2 and Hassan's one-pass re-check of O-2, O-3 and O-7 before slice 7 code.** `SubjectKeyService` keyed hash (PL-3) before the first slice that writes `request_hash` (slice 2).
- **Order:** as brief s11. Slice 2 merges its use cases and domain without the HTTP route. The route arrives with slice 3, when the real `payments` facade exists. Every slice gets Hassan's review (Q2). Slices 2, 3, 5 and 7 are also in the independent pen-test scope (webhook path, refunds, invoice access).
- **Tests:**
  - every domain and integration test on AU and `ZZ.json` (JPY, exponent 0, `pricesIncludeTax = false`, a different tax rate and reservation duration);
  - one test per compensation row C1–C12, and the supersede path (including `already-captured` → `COMPENSATING`, and a `REVIEW`-from-`AWAITING_PAYMENT` intent cancelled first, O-9);
  - every Checkout state × money event (`payment-authorized`, `payment-succeeded`) has a defined row; none is ignored silently (O-3); an event with another `paymentId` creates an orphan fact; `paymentOf` with automatic capture, captured status or another Market refuses the commit (ADR-0035 d7);
  - refunds (O-2): a timeout never yields `NOT_SENT`; `NOT_SENT` only after a definite refusal or `abandoned`; `refund-succeeded` for a `NOT_SENT` key → `REVIEW` + alert; an unknown key → orphan fact; the admin resolution refuses taken positions; `REVIEW` → `FAILED` only with a stored failed / not-found confirmation, never with a succeeded one (F13);
  - a money event for a Checkout in each terminal state → orphan fact `event-after-terminal`, the Checkout unchanged (F14);
  - first sale (SMR): the `order-paid` handler calls `recordFirstSale` with `at = paidAt` and `orderId`; `ordering.reconcile-first-sales` re-sends each seller's earliest `paidAt` in batches of ≤ 100 and reads no `sellers` table; a `pnpm boundaries` fixture importing `sellers.first-sale.ts` from outside `modules/ordering/` fails; both Market fixtures;
  - `refundCompensation` refused unless the Order is `CANCELLED` and never `PAID` (ADR-0035 d5);
  - `REVIEW` close refused while authorised or captured-not-refunded, never sets `PAID` (O-7);
  - elevation (5.6): one test per entry E1–E7 (non-owner → zero target calls; same Market and correlation id; originating actor in audit and log); a `pnpm boundaries` fixture with an unlisted elevation fails;
  - recipient data (O-6): list pages decrypt nothing; detail without `seller-order.recipient.view` shows no recipient field; refused after `CLOSED` + `recipientVisibleFor`; one audit row per decryption, without values; default roles of 5.3 (Bookkeeper, Customer Service lack the key);
  - acting-as refuses every protected-key use case (O-10); boot refuses `placementDeadline ≥ startedStaleAfter`; `startedStaleAfter` absent from a Market fails boot (no core default, A3);
  - hashes: `request_hash` and `content_hash` are HMACs (a test proves the same request under two customers gives two values); no note column exists (O-4, O-5);
  - client key replay at 30 days minus one second, none after the prune (A1);
  - out-of-order and duplicate payment events (AC 10);
  - a crash injected between every pair of Saga steps (C10);
  - concurrency: two invoices, two shipments, an invoice against a cancellation, two refunds on one sub-order (AC 11);
  - largest-remainder fee refunds that sum exactly over many partial refunds (property test);
  - the contracts snapshot of events (mandatory) and the type test that no Cost type is reachable (AC 16);
  - log redaction of personal data;
  - IDOR across sellers, customers and Markets (byte-identical answers);
  - the four emails with no address in events or logs, and a mail failure that does not affect the order (AC 19);
  - the fee-missing refusal and the explicit-zero acceptance (AC 14);
  - the `pnpm boundaries` fixtures: ordering imports neither C-P nor shipping; `sellers` imports no `ordering` contract (no event consumer); only shipping imports the shipping port; only C-P implements `CommissionRateSource`;
  - one test per AC of brief s10;
  - NFR (brief s9; ruled by Ali G2): place-order with 20 lines and 5 sellers, fake providers in process, p95 ≤ 800 ms excluding the provider call. The baseline is measured from slice 2 and **not** run in `pnpm verify`; a regression above 20 % against the baseline blocks the release. The **fixed number of facade calls (11)**, independent of the line count, is a deterministic test that **is** in `pnpm verify` (the eleven: cart lines, catalog, eligibility, summaries, zones, prices, claims, commission rates, tax, reserve, create payment; it holds while lines × tags ≤ 100 and lines ≤ 50, the batch limits of `evaluateClaims` and `reserve`).

## 14. Deferred
| Item | When |
|---|---|
| ORD-07 `allowedActions`, ORD-08 tabs | P1, slice 9 |
| ORD-09 manual order by admin | P2 |
| RET-01..05, 07..10 (`returns`), RMA, restock | Phase 7; public launch condition (Q12) |
| Real shipping rates, carriers, labels (SHP-02..06) | Phase 6 `shipping`; the flat fee is removed then |
| PDF invoice (a new dependency, ADR-0029 libraries) | When asked; HTML document at launch |
| Customer erasure versus invoice retention (CUS-03) | Designed with `sellers` and the tax agent's retention answer |
| `OrderWorkflowExtension` implementations | When a Vertical needs sub-states |
| Seller-side acting-as writes | SEL-08 mini-review |
| AIC-03 READ tool | Phase 6, `assistant` |
| Tax turnover port implementation (TX-4) | With tax's P1 threshold warning |

## 15. Open questions
**Owner, through Hadi** — no decisions open (Ali G2 section 5). Informed: `CLOSED` = 30 days after the last delivery (Market policy; `returns` may redefine it); the seller new-order email carries a link only, no customer data; default roles (5.3) set by Hadi; the change-log rows below. Owner action: book the tax agent now (ADR-0036).
- Brief change-log rows (Hadi with Ali): T4 reading of flow 3(a); events changed (6.4); `getSellableExact` dropped; address book owner and slice (T6); **the `ordering.reconcile-first-sales` job** (sellers mini-review, Ali ruling 2; open for Hadi).

**Ali (cto)** — T1 to T6, IP-4, NFR and `cartClearWindow` ruled (2.4, 13). Follow-ups ruled 2026-10-08 (Ali G2 review 2026-10-08 sections 6 and 7), applied; nothing open:
- A1 approved: prune `REJECTED`/`ABANDONED` Checkouts after 30 days; client key replay window ≤ 30 days; boundary test (2.3, 11, 13).
- A2 approved as a CUS-03 design rule (Hadi confirms wording): customer erasure waits until no unshipped sub-order; tax-record retention still applies (PD10, 14).
- A3 approved: `startedStaleAfter` is Market configuration, no core default, both fixtures (3.3 P2, 13).
- A4 approved: refund gross of the refunded units from the frozen tax answer (4.8); Hassan reviews before merge.
- D-1 accepted as proposed: no `price_basis` column; `tax_inclusive` on lines and on `seller_order_charges` (17).
- O-1 elevation needs an ADR: ADR-0038 drafted (ADR-0038 draft, Proposed; Hassan reviews); entries in 5.6. O-2: P-7 is payments G2 input and ADR-0035 d3 text. O-6: default roles are seed data, Hadi decides, owner informed; Bookkeeper and Customer Service never get recipient data by default. No overrules.

**Hassan (security-tester)** — reviewed 2026-10-08 (Hassan review 2026-10-08): **accept with changes**. Applied: O-1 (5.6, ADR-0038), O-2 (3.5, 11, P-7), O-3 (3.3 handler table, C11, C12), O-4 (2.1, PD10, PL-3), O-5 (2.1, PD10), O-6 (5.1, 5.2, 5.3, 8), O-7 (3.3 `REVIEW` resolution, 5.1), O-8 (5.4, P-8), O-9 (2.1, 3.3 P2 and supersede), O-10 (3.3 placement deadline, 5.4); Mojtaba's points (per-invoice subject accepted; H2 → O-6; H3 → O-5; H4, H5 accepted except the hashes → O-4; F1 accepted with O-9); ADR-0035 d3, d5, d7. Still owed by Hassan (conditions in the status line): the O-1 re-check before slice 2; O-2, O-3, O-7 in one pass before slice 7; O-4, O-5, O-6, O-9, O-10 at code time; and the code-time list of his review (allow-list and `isMinted`; byte-identical not-found for orders, invoices and adjustment notes; event contract snapshots and log redaction incl. the client secret; F11, F8 concurrency; C1–C12 and out-of-order or duplicate payment events; the `refundCompensation` boundary fixture; grants and guard functions `SECURITY INVOKER` with pinned `search_path`; `issuedAt` bound across inbox retries; the rate limiter failing closed; emails with links only).

**Other G2s and mini-reviews** (Ali G2 section 4)
- Payments G2: P-1 to P-9 (P-7 the fenced `abandonRefund`, without which the payments G2 cannot pass; P-8 decline cap) and the condition of ADR-0035 decision 4 (manual capture for cards and Apple/Google Pay in Stripe AU; authorisation life well above the step budget). OD-data P1: whether outcome events carry `orderId`.
- C-P G2: CP-1 and the T2 shape; `financialFactsOf`; `commissionTax`, `reverseCommissionTax`, PD8; unknown-registration behaviour; whether it needs `seller-order-shipped`.
- Shipping G2 (tier B): SH-1, the port of 6.3 with `accepted`/`unknown` only (F9), the stored intent.
- Tax agent items: AG-16 (which invoice carries the flat fee), AG-9 (placement-time versus invoice-time registration), AG-11 (one or two number series; OD-data X4), AG-12 (retention), the "Order confirmation" label.
- Mini-reviews: sellers SMR thread (S-2, S-3, ST1, batch `taxProfileOf`) before slice 2; inventory (IP-1 to IP-4); cart (CR-1); catalog (CF-1); certification (CE-1, Hassan required); identity (ID-1, ID-2, Hassan required); platform (PL-1 `legalEntity` and the reserved tax key with tax PL1; PL-2 region → zone and ServiceArea; PL-3 keyed hash per subject; PL-4 the elevation PR under ADR-0038).

## 16. Follow-ups (none in this document's PR)
- ADR-0035 (**Accepted** 2026-10-08): a shared-file PR changing `CLAUDE.md` "Checkout = Saga (...)" to "Checkout = orchestrated Saga in `ordering` (ADR-0035): reserve → authorise → commit → capture", announced on the board (Kazem or Mohammad).
- Shared-docs PR (Ali r9): `technical-spec.md` §1.6 note pointing to ADR-0035; "Amended by ADR-0035" on ADR-0006's consequence line; "Amended by ADR-0036" on ADR-0007's status.
- Config shared-file PR before slice 2: the ordering policy keys (`expiryGrace`, step budget, `startedStaleAfter`, `closeAfter`, `refundSendTimeout`, `refundTargetTime`, `cartClearWindow` 7 days, `shipmentReversalWindow` 90 days, `maxSavedAddresses`) and the boot check R1 ≥ window + 30 days.
- The brief change-log rows of section 15, through a Hadi and Ali mini-review.
- ADR-0038 (elevation; Proposed): Hassan reviews; once Accepted, Hossein's `platform/authz` PR with the allow-list (PL-4) and the CODEOWNERS entry (its own board-announced shared-file PR); PF 3.7 and 6 amended in the same docs PR as the ADR.
- Config keys added by Hassan's review: `placementDeadline` (< `startedStaleAfter`, boot check), `recipientVisibleFor`, the `retry-payment` limits.

## 17. Review record

| Date | Reviewer | Outcome | Applied in this revision |
|---|---|---|---|
| 2026-10-08 | Mojtaba (database-designer), data design `docs/design/data/ordering.md` | Data design written from this model (PD1 to PD18), measured on PostgreSQL 16; findings F1 to F12, M1, M2; open points for Ali, Hassan and other G2s | **All accepted.** F1 (measured bug): the one-open-checkout rule now covers slot-holding states only (2.1, 3.3 P2, supersede, PD3), plus a stale-`STARTED` rule (A3). F2 no key table (2.1, 2.3, 3.4, 9, 11, PD4). F3 `expiresAt` on Checkout only (2.1, 3.1). F4 `CLOSED` derived from `lastDeliveredAt`; stored `PENDING`/`VOID` (2.3, 3.2, PD12). F5 seller list by `paidAt`; sellers never see unpaid sub-orders (3.2, 5.2). F6 `SellerOrderCharge` (2.1, 4.1). F7 `refundRequiredSince` (3.2, 11, PD16). F8 unit-position EXCLUDE (2.1, 4.6, PD7). F9 `shipmentStatus` answers `accepted`/`unknown` (6.3). F10 no recipient field in lists (5.1, 5.2). F11 refund locks the Order first (2.1, 3.5, 9). F12 adjustment note at `SUCCEEDED` (3.5, 4.8). M1 one revision id (4.1). M2 fields (2.1). Answers: X1 a charge always has a category code; X2 period id present when registered, may be present when not, null only without a period; X3 the base CHECK holds for `configured-rate` while discount is 0 (include the discount with promotions); X4 is the agent's AG-11 |
| 2026-10-08 | Ali (cto), Ali G2 review 2026-10-08 | **Approve with changes** (needs Mojtaba, Hassan, Reza for s12). Items 1 to 6; rulings T1 A (conditional), T2 A, T3 A, T4 A, T5 A, T6 A; R1 120 days, R2 UUIDv7; NFR; `cartClearWindow` 7 days; cycle fixes binding; IP-1 approved; ADR-0035 accepted with changes | Item 1 `TaxBreakdown` = frozen `LineTaxAnswer` (2.2). Item 2 no placement-time number; identity read at issue, encrypted, refusal code + alert (2.1, 4.1, 4.6, 5.5). Item 3 no region to `tax` (4.3, TX-1). Item 4 `shipmentReversalWindow` policy, code, boot check (3.2, 6.1). Item 5 typed address in slice 2 (1.1, 3.3 P0). Item 6 roles confirmed (5.3). Rulings in 2.4, 6.1, 13; open questions rewritten (15); ADR-0035 revised (title, d2, d4 condition, d5 boundary rule, status) |
| 2026-10-08 | Mohammad (self, while applying the reviews) | Correction | 4.8: refund goods are the gross of the refunded units (from `tax`), not `unitPrice × q`, which is the net in an exclusive-price Market (A4) |
| 2026-10-08 | Hassan (security-tester), Hassan review 2026-10-08 | **Accept with changes.** O-1 High (blocks slice 2): system-only facades called from requests need a reviewed elevation with a checked-in allow-list. O-2 High (blocks slice 7 and the payments G2): fenced `abandonRefund`. O-3 to O-7 Medium, O-8 Medium (payments G2), O-9, O-10 Low. Mojtaba's points: per-invoice subject accepted; F1 accepted with O-9. ADR-0035 d3, d5, d7 accepted with changes | O-1: 3.3 supersede, 3.3 `REVIEW` resolution, 4.6, 5.6, PL-4, ADR-0038 drafted. O-2: 3.5, 11, P-7, ADR-0035 d3. O-3: 3.3 handler table, VOIDING, C11, C12, ADR-0035 d7. O-4: 2.1, PD10, PL-3. O-5: 2.1, PD10. O-6: 5.1, 5.2, 5.3, 5.4, 8, PD20. O-7: 3.3, 5.1, 5.5. O-8: 5.4, P-8. O-9: 2.1, 3.3. O-10: 3.3, 5.4. d5: 3.3 compensation guard, P-4, P-9. Tests: 13. Open lists of 15 rewritten |
| 2026-10-08 | Ali (cto), follow-ups Ali G2 review 2026-10-08 sections 6 and 7 | D-1 accepted as proposed; T8 approved; A1 to A4 approved; M3 Hadi's call. O-1 needs an ADR (Mohammad designs, Hossein builds in `platform/authz`, Hassan reviews design and code, Mojtaba signs off an audit column); O-2 is payments G2 input P-7; O-6 default roles are seed data. **Recording: ordering G2 approved with conditions** (O-1 re-check before slice 2 once the elevation ADR is Accepted; O-2, O-3, O-7 re-check before slice 7; O-4, O-5, O-6, O-9, O-10 at code time); ADR-0035 Accepted once d3, d5, d7 are written as Hassan specified | Status line; 2.3, 11, 13 (A1); PD10 (A2); 3.3 P2, 13 (A3); 15; ADR-0035 set to Accepted with d3, d5, d7 written; ADR-0038 drafted |
| 2026-10-08 | Sellers mini-review (sellers mini-review 2026-10-08 sections 8 to 11, Ali ruling 1, 2, 4; relayed in sellers mini-review inputs 2026-10-08 item 3) | `firstSaleAt` set once, may only move earlier, never null, never later; restricted file `sellers.first-sale.ts`; `sellers` consumes no `ordering` event; ordering-owned reconciliation job before `sellers` S-d | 2.4 T3 (ruling and option A), 3.4, 6 S-2, 11 `ordering.reconcile-first-sales`, 13 tests, 15 (Hadi's change-log row); ADR-0035 decision 2 |
| 2026-10-08 | Mojtaba (database-designer), `docs/design/data/ordering.md` revision (11.1 F13 to F16) | F13 to F16 raised | **F13 accepted:** refund `REVIEW` → `FAILED` (admin, reason code, protected, second factor, after the job's stored failed / not-found confirmation; no counter change) (3.5, 11, 13); Mojtaba adds the transition to M4's trigger and resolution CHECK and the refund-resolution reason list (11.5 Q1) gains its codes. **F14 accepted:** a money event in a terminal state is an orphan fact `event-after-terminal`, the Checkout never moves; listed redeliveries unchanged (3.3 handler table and the "never ignored" rule, 13). **F15 noted** (2.1 `SellerOrderCharge`). **F16:** no change. Data still to add (for Mojtaba): the plan of `ordering.reconcile-first-sales` (earliest `paid_at` per seller, keyset by seller id, on `seller_orders_market_id_seller_id_paid_at_idx`) in data 6 and 9. Consistency check of the revised data design: D 11 lacked the AG-12 job `ordering.shred-invoice-identities` (OD-data 9.3), added | 2.1, 3.3, 3.5, 11, 13 |
| — | Reza (ui-ux-designer) | **Pending** for brief s12 (screens of 1, with F10 and O-6: recipient data on detail only and only with `seller-order.recipient.view`; the new refusal codes of 5.5; the `REVIEW` queue with orphan facts) | — |

**Disagreement D-1:** ruled by Ali (2026-10-08) as proposed: no `price_basis` column; `tax_inclusive` stays on `order_lines` and is added to `seller_order_charges`; `tax_price_basis` only if a text form is needed later.

**Data-design changes Mojtaba must make:** collected, with Hassan's and Ali's new items, in Mojtaba change list 2026-10-08 (2026-10-08). I do not edit `docs/design/data/ordering.md`.
