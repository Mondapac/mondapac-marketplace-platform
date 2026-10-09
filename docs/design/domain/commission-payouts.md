# Commission-payouts — G2 domain design

**Author:** Mohammad (software-architect) — 2026-10-08
**Status:** G2 draft 2026-10-08, reconciled 2026-10-08 with Ali's ruling (Ali payments and commission-payouts review 2026-10-08, "Ali PC": approve with changes), Mojtaba's data design (`docs/design/data/commission-payouts.md`; L3, L11, L13, L14, L15 accepted, L7 ruled by Ali) and `docs/design/domain/payments.md` (6.1 rows P-a to P-i now use `payments`' names). Awaiting Hassan (security-tester, mandatory for tier A) and the owner's answers to Q-O1 to Q-O5 are in (owner, 2026-10-08; 15). Reza and Jafar for the screens of brief s12 (section 13, slice 7). Changes: reconciliation log at the end.
**Ground truth:** `docs/modules/commission-payouts/brief.md` (G1 approved by the owner 2026-10-08; cited as "brief s5", "Q6", "AC n" in the order of brief s10); payout terms review 2026-10-08 ("PT"); Ali G1 review 2026-10-08 ("Ali G1-r1".."r8"); Ali Phase 5 review 2026-10-08 ("Ali r1".."r9"); Phase 5 owner questions 2026-10-08 (answers Q1 to Q14); `docs/design/domain/ordering.md` ("ORD"; T2, 6.2, 6.4); `docs/design/domain/tax.md` ("TX"; 4.9, 6.2, PD8, H1, H2, H6, H7); Ali G2 review 2026-10-08, Hassan review 2026-10-08; ADR-0035 draft (ADR-0035); ADR-0038 draft (ADR-0038); sellers mini-review inputs 2026-10-08 and sellers mini-review 2026-10-08 sections 8 to 11 ("SMR"; M3); ADR-0001, 0002, 0003, 0005, 0006, 0007 (decisions 1, 2, 4, 7, 8, 11), 0008, 0009 (V2, V3, decision 6), 0013, 0015, 0018 (decisions 4, 5, 7), 0019 (decisions 8, 10; R2), 0020, 0022 (decision 6), 0025, 0026 (decision 9), 0031 (decision 5); `docs/design/domain/pricing.md` ("PRC"; the structure of this document follows it), `identity.md` ("ID"), `sellers.md` ("SEL"), `platform-foundations.md` ("PF"), `platform-persistence-and-events.md` ("PE"); `test/fixtures/markets/ZZ.json` (JPY, 0 minor digits, exclusive prices, `Asia/Tokyo`).

## 1. Scope

A design, not an implementation. Signatures appear only where the signature is the contract.

- **Decided here:** domain model (2), state machines (3), money rules: commission, ledger postings, eligibility, payout run, refunds, chargebacks, fees and negative balance (4), authorisation (5), boundary, facades and events (6), data ownership (7), audit (8), idempotency and concurrency (9), where each hard rule is enforced (10), jobs (11), AI (12), slices and tests (13), deferred (14), open questions (15).
- **In Mojtaba's data design** (`docs/design/data/commission-payouts.md`, to be written from this model): tables, columns, constraints (the V2 `EXCLUDE` no-overlap of ADR-0009 decision 2 for rates and terms), the balanced-journal guard, indexes, grants and the migration plan. Section 7 only names the data and lists inputs PD1 to PD16.
- **In Reza's and Jafar's documents:** the admin payout-terms page (Market default and per-seller override, with the seller commission rate on the same page, Hadi's ruling on COM-02), the MANUAL approval list, the hold and release dialogs, the settlement page (PAY-03, PAY-04), the seller "earnings and next payout" view and statement (PAY-08, PAY-09), the seller read-only terms view, the 30-day account banner (brief s8, last risk row), the negative-balance and failed-payout lists. The server answers with codes (5.5); Figma first (ADR-0017).
- **Left open, with the reason:** section 15. Each item is a business value, a legal policy, or a contract with another module that this design must not invent.

### 1.1 Brief slices and where they are covered
| Slice (brief s11) | Covered in |
|---|---|
| 1 Effective-dated Market rate (COM-01, VER-09; 15 % from Market config, not code), audit, `CommissionRateSource` | 2.1, 3.1, 4.1, 6.2 |
| 2 Append-only ledger; postings from order-paid (COM-04) and invoice (COM-05); Stripe fee entries | 2.1, 4.2, 4.3, 4.9 |
| 3 GST on commission from `tax`; statement data (**blocked until the tax agent's written confirmation**, ADR-0036) | 4.3, 4.12 |
| 4 PayoutTerms (PAY-10): V2 records, resolver (seller > plan > Market), code bounds (hold ≥ 7), `payout-terms.edit` | 2.1, 3.2, 4.4 |
| 5 Eligibility (frozen `eligibleAt`), holds (Q5, Q14), held money of a seller without a ready account (Q3), payout run AUTO/MANUAL (`payout.approve`) | 3.3 to 3.5, 4.5 to 4.7 |
| 6 Refunds, chargebacks, negative balance (Q6; refunds **blocked until the agent's confirmation**) | 4.8, 4.10, 4.11 |
| 7 Admin terms page (PAY-11, from launch), settlement page (PAY-03/04), seller view and statement (PAY-08/09) | 5.2, 4.12, 13 |
| 8 COM-02 seller rate (launch-required; UI on the PAY-11 page) and COM-06 (last slice) | 3.1, 4.1, 5.2 |

## 2. Domain model

### 2.1 Aggregates
Every aggregate root carries `marketId`, `tenantId` (ADR-0003 decision 3, ADR-0020 decision 6), an `Id` from the injected generator and a `version` (PE 10). Time comes from `Clock` only (ADR-0005 decision 5). References to other modules are ids only. Every amount is `Money` (`{amount: integer minor units, currency}`), always the Market currency (INTL-21); a rate is an exact decimal string (ADR-0007 decision 2), never a float.

```
CommissionRateSeries (one per (Market, scope, sellerId?))   — V2 effective-dated
  └─ CommissionRateRecord*  rate, validFrom, validTo|null, reasonCode, submittedBy

PayoutTermsSeries (one per (Market, scope, sellerId?))      — V2 effective-dated
  └─ PayoutTermsRecord*     schedule, holdDays, minimumAmount, approvalMode, validFrom, validTo|null

Journal (append-only; not an aggregate root that is ever updated)
  └─ JournalTransaction     kind, sourceRef, occurredAt  ── 2..n JournalEntry (account, side, Money, refs)

CommissionAssessment (one per invoice line; one per invoice charge portion)
SettlementItem       (kind sale: one per CommissionAssessment that pays the seller; kind recall: one per recall reversal, CP-R1; the unit of eligibility)
PayoutHold           (seller-wide or one sub-order)
Payout               (one transfer instruction, its items and its netting)
PayoutScheduleCursor (one per (Market, seller): the last processed schedule slot)
SellerReceivable     (derived view of the receivable account; recovery actions are its records)
DisputeCase          (C-P's view of one payments dispute: attribution and recovery)
PayoutStatement      (one per settled Payout, PAY-09, gated) + StatementSequence (per Market)
```

| Aggregate | Holds | Invariants |
|---|---|---|
| `CommissionRateSeries` | `scope` (`market` or `seller`), `sellerId` (seller scope only), records: `rate` (decimal string), `validFrom` (instant), `validTo` (instant or null), `reasonCode`, `submittedBy` (and the acting-as account, reserved), `createdAt` | Records of one series never overlap (V2; database `EXCLUDE`, open-ended records included: L11). `0 ≤ rate ≤ MAX_COMMISSION_RATE` (a platform-wide bound in the declaration, not a Market value and not an AU branch; `"0.30"`, Ali PC, closes Q-H1; also a database CHECK). A new record starts at `now` or later, never in the past (forward-only, VER-09). A record is never edited or deleted: a change closes the open record at the new `validFrom` and adds a record. A seller record may be ended without a successor (the seller falls back to the Market rate) |
| `PayoutTermsSeries` | Same shape; `scope` `market` or `seller` (the `plan` scope is reserved and has no writer until SUB, PAY-12). Record: `schedule` (a set of ISO weekdays plus one local time `HH:mm`, interpreted in the seller's zone), `holdDays` (integer), `minimumAmount` (`Money`), `approvalMode` (`AUTO` or `MANUAL`) | Four fields only (PT, brief s5). `MIN_HOLD_DAYS = 7 ≤ holdDays ≤ MAX_HOLD_DAYS = 60` (both constants in the `PayoutTerms` declaration, Ali G1-r1: a bound in the declaration, not an AU branch; 60 per Ali PC, closes Q-H3); `0 ≤ minimumAmount ≤ minimumAmountCap` of the Market (config, 4.4); `schedule` has at least one weekday. A seller record is complete (all four fields), so the resolver never mixes sources. No destination account, commission or verification field exists in the type (PT) |
| `JournalTransaction` | `kind` (closed list, 4.2), `sourceRef` (`{kind, id}`: the consumed event id with handler, or the use case and its record id), `occurredAt`, `postedAt`, and 2..n `JournalEntry`: `account` (4.2), `side` (`debit`/`credit`), `amount` (`Money`, > 0), and the refs it touches (`sellerId`, `sellerOrderId`, `orderLineId`, `invoiceId`, `assessmentId`, `settlementItemId`, `payoutId`, `disputeCaseId`, as applicable) | Σ debits = Σ credits per transaction and per currency (enforced by the domain and by the database, PD1). One currency per transaction. Immutable: INSERT and SELECT only. Unique `sourceRef` per kind (idempotency, 9). A correction is a new transaction of a reversing kind that names the transaction it corrects |
| `CommissionAssessment` | `sellerId`, `sellerOrderId`, `invoiceId`, `invoiceLineRef` (`orderLineId` with its invoice unit-position range `[a, b)`, or the charge with its cumulative range), `quantity`, `gross`, `net`, `lineTax` (from `ordering`'s invoice facts), the frozen `commissionRate`, `commissionRateRecordId`, `commissionRateSource` (copied from the order line, never re-resolved), `commission`, and the frozen commission-tax answer (TX PD8: `taxRuleSetId`, `taxRate`, `supplierRegistered`, `legalEntityRegistrationValidFrom`, `taxEvaluatedAt`, `commissionTax`), `sellerShare`, `state` (3.3), cumulative reversals (`unitsReversed`, `commissionReversed`, `commissionTaxReversed`, `sellerShareReversed`, `grossReversed`) | `sellerShare = gross − commission − commissionTax` (brief s5; Q8: no provider fee). For a charge (flat shipping fee): `commission = 0`, `commissionTax = 0`, `sellerShare = gross` (Q7, Q11). Frozen fields never change after `POSTED`. Cumulative reversals only grow and never exceed the originals |
| `SettlementItem` | `kind` (`sale` or `recall`, Ali CP-R1), `sellerId`, `sellerOrderId`, `assessmentId` (both null for `recall`), `recoveryActionId` (`recall` only), `amount` (`sale`: the assessment's seller share minus reversals taken while unpaid; `recall`: the reversed amount), `anchorAt` (instant the hold counts from), `eligibleAt`, `holdDaysApplied`, `termsRecordId`, `state` (3.4), `payoutId` (when taken) | `eligibleAt` is set once from the terms in force when the anchor is known and **may only move earlier** afterwards, never cleared (PT; brief s5; strictly monotonic, L3: a delivery correction places a `DELIVERY_CORRECTED` hold instead of clearing it). An item is in at most one live `Payout`. `amount ≥ 0`. **`recall` (Ali CP-R1 condition 1; C-P slice 6):** created only in the unit that posts `transfer-recalled` (4.2, 4.11), `recoveryActionId` NOT NULL and unique (one item per reversal; idempotent), `anchorAt = eligibleAt` = the posting instant, `holdDaysApplied = 0`, no terms record (the goods behind this money were already delivered, held and paid); `eligibleAt` set once and never moves (PD6 unchanged); the original `sale` items stay `PAID` and are never re-opened. Invariant: `seller-payable` = Σ amounts of the seller's unpaid items (`UNANCHORED`, `MATURING`), checked daily (11) |
| `PayoutHold` | `scope` (`seller` or `seller-order`), `sellerId`, `sellerOrderId` (scope `seller-order`), `reasonCode` (closed list: `NOT_RECEIVED`, `SELLER_SUSPENDED`, `DISPUTE`, `REFUND_PENDING`, `ADMIN_REVIEW`, `DELIVERY_CORRECTED` (L3, system only, with `releaseDueAt`)), `origin` (`admin` or `system`), `sourceRef` (admin use case, or the event that created it, e.g. identity's `decisionId`), `placedAt`, `placedBy`, `state` (3.5), release: `releasedAt`, `releasedBy`, `releaseReasonCode`, `outcome` (`released`, `settled-by-refunds`) | No free text: reason codes only (Hassan O-5 precedent). `SELLER_SUSPENDED` is created only from identity's event and is released only by an admin, never by reinstatement (Ali G1-r5; brief s5). One active `SELLER_SUSPENDED` hold per (seller, `decisionId`) |
| `Payout` | `sellerId`, `items` (`settlementItemId`, amount), `grossAmount` (Σ items), `nettedAmount` (taken from the receivable), `transferAmount` (= gross − netted), `approvalMode` and `termsRecordId` used, `state` (3.6), `approval` (admin id, `approvedAt`, the approved `transferAmount`), `instructionKey` (= its id), payments' transfer id, failure code, `version` | `transferAmount ≥ minimumAmount` of the terms read at run time, or `transferAmount = 0` with `nettedAmount > 0` (settled by netting). `transferAmount > 0` only when every condition of 4.6 held. **At most one live payout per seller** (`PENDING`, `AWAITING_APPROVAL`, `APPROVED`, `INSTRUCTING`; L13, database partial unique): two live payouts would net from the same receivable. Amounts never change after `PENDING`/`AWAITING_APPROVAL`; a changed amount voids the payout and a new one is proposed |
| `PayoutScheduleCursor` | `sellerId`, `lastSlotAt` (the instant of the last processed local slot), `nextSlotAt` (computed, stored for the index), `zone` used | `lastSlotAt` only moves forward |
| `DisputeCase` | `paymentDisputeId` (payments' id), `orderId`, `sellerOrderIds`, `state` (3.7), attribution (`sellerOrderId`, `recoveryAmount`, admin, reason code), `recoveryTransactionId` | One per payments dispute. Recovery only after an admin attribution (Q6 rule 5) |
| `PayoutStatement` | `payoutId`, `sellerId`, `documentNumber` (from `StatementSequence`), `kind` and `requiredFields` (from `tax`, 4.12), issuer copy (`MarketConfig.legalEntity` name and tax number as of the issue instant), `issuedAt`, `issueDate` (local date in the seller's zone, ADR-0005), lines (assessments and reversals in the payout), totals | Immutable once issued (V3). Issued only for a Market whose legal-entity registration is known (4.12). Number unique and gap-free per (Market, series) |

### 2.2 Value objects and domain services
| Name | What it is |
|---|---|
| `CommissionRate` | Exact decimal in `[0, maxCommissionRate]`; parsed from a string; compared numerically |
| `PayoutSchedule` | ISO weekdays + local `HH:mm`; `slotsBetween(zone, from, to)` (pure; DST rules of 4.6) |
| `CommissionRateResolver` | `resolve(seller, at)`: seller record covering `at`, else Market record covering `at`, else `RateUnavailable` (fail closed; no rate in code) |
| `PayoutTermsResolver` | `resolve(seller, at)`: seller record covering `at`, else plan profile (always empty until SUB; the slot exists and returns nothing), else Market record, else `TermsUnavailable` (fail closed) |
| `CommissionCalculator` | Pure: `commission = round_half_up(net × rate)` per assessment (one rounding per entry; tax agent AG-4 also covers commission rounding, 15 Q-T1) |
| `ReversalCalculator` | Pure, cumulative by units: for an assessment of `q` units with commission `C`, after `u` units reversed: `C_rev(u) = round_half_up(C × u / q)`; this reversal = `C_rev(u_after) − C_rev(u_before)` (telescopes to `C` when `u = q`, the same method `tax` uses, TX T2). A partial reversal may reverse **0** commission by rounding (C = 1, q = 3, u = 1) while units and seller share still move; the reversal record is still stored (L14: commission range `before ≤ after`, units and gross strictly increasing; tax-data 10.2 aligned) |
| `PostingFactory` | Builds the balanced `JournalTransaction` for each kind of 4.2; the only place that writes journal entries |
| `EligibilityPolicy` | Pure: given an item, the active holds, `now` → `eligible` or the blocking reason code (4.5) |
| `PayoutPlanner` | Pure: given a seller's eligible items, the receivable balance and the terms → items, gross, netted, transfer amount, or `below-minimum` (4.7) |
| `PayoutAccessMapping` | Pure, exhaustive, default-deny map of `sellers.accessStatesForPayout` answers: only `approved` passes; anything else, a missing or an extra key, `ok: false` or an exception blocks the **whole batch** (SMR M3) |

### 2.3 Modelling choices that need a reason
| Choice | Reason | Cost |
|---|---|---|
| Double-entry journal with a small closed chart of accounts (4.2), balances only by aggregation | Brief s5: append-only; balance from entries, never an editable column; Ali's reconciliation needs "ledger = money received − refunds = payouts + balances" | A derived balance cache may be added by Mojtaba, rebuilt from the journal and compared by the reconciliation job (PD2) |
| `CommissionAssessment` per **invoice line**, not per order line | COM-05: commission is on the net **invoiced** after discount; partial invoices exist (IP-1); `tax` rounds commission GST per entry, and `commissionTax`'s `at` is the invoice's `issuedAt` (TX 4.9, H2) | More rows than lines; sums are exact by construction |
| Eligibility on a separate `SettlementItem`, not on the journal entry | The journal is immutable, but `eligibleAt` may move earlier (PT) and items are taken by payouts. The frozen value is the item's, written in the same unit as the assessment posting or the delivery that anchors it | One more aggregate |
| A seller-side `receivable` account for money the seller owes, separate from `payable` | Refunds and recoveries against money already transferred must be netted against **future** payouts (Q6 rule 4), capped and recovered (Ali G1-r1). A receivable is visible, cappable and recoverable; a negative `payable` would hide which part is debt | Netting is an explicit posting in each payout (4.7) |
| `CommissionRateSource` implemented here, declared in `ordering/contracts` | ORD T2 A (accepted by Ali): C-P consumes ordering's events, so ordering imports nothing of C-P | One port with one implementer (boundary rule, 6) |
| Payout instruction only from the system worker; admin approval and admin recovery only **mark** records | SMR item 2 (Hassan M3); `payments` accepts transfer commands only from C-P's system actor (payments brief s9); avoids any ADR-0038 elevation entry for C-P | MANUAL payouts leave at the next worker pass (minutes), not in the admin request |
| No elevation entries | Every external `system`-only call (tax, ordering facts, sellers access, payments commands) is made by handlers and jobs; HTTP use cases read only C-P's own tables plus `anonymous` pairs | — |

### 2.4 Toss-up T1: where eligibility is anchored
| Option | What | For | Against |
|---|---|---|---|
| **A (recommended)** | One `SettlementItem` per assessment (invoice line or charge portion). It is anchored when the line's cumulative **delivered** count covers the invoice range `[a, b)` (`delivered ≥ b`), at the `deliveredAt` of the delivery mark that made it so. The charge item is anchored at the sub-order's first delivery mark | Exact with partial invoices and partial deliveries (`delivered ≤ shipped ≤ invoiced`, ORD 4.5, so delivered units are always invoiced units in order); each item has one anchor; deterministic from ordering's facts | Needs per-line delivered counts from `ordering` (CP-2) |
| B | One item per `SellerOrder`, anchored at the last delivery | Simple | A partial delivery delays all money of the sub-order; a sub-order with a cancelled remainder never "completes" without extra rules |

Recommendation A. It needs `ordering` to expose delivery facts (CP-2, 6.1).

### 2.5 Toss-up T2: refund pending before it succeeds
`ordering` locks quantities at `REQUESTED` (ORD 3.5) but publishes only at `SUCCEEDED`. Between the two, C-P could pay the seller for units about to be refunded.
| Option | What | For | Against |
|---|---|---|---|
| **A (recommended)** | `ordering` publishes `refund-requested.v1` and `refund-request-closed.v1` (`FAILED`/`NOT_SENT`); C-P places a system `REFUND_PENDING` hold on the sub-order and releases it on close or on `order-line-refunded.v1` | The brief s6 already lists "refund lock / unlock" among consumed events; no money leaves for units being refunded | Two more ordering events (CP-3; ordering change-log row) |
| B | No event; a refund that lands after the payout is netted (Q6 rule 4) | No ordering change | Creates avoidable receivables, the risk Ali G1-r1 asked to bound |

Recommendation A.

## 3. State machines

### 3.1 Commission rate record and terms record (same shape)
| From → to | Trigger | Guard |
|---|---|---|
| (none) → `SCHEDULED` or `ACTIVE` | `set-market-rate`, `set-seller-rate`, `set-market-payout-terms`, `set-seller-payout-terms` (admin, protected key, 5.1); or the boot seed (11) | `validFrom ≥ now` (a value earlier than `now` is refused; "now" is the server's `Clock`); bounds of 2.1; expected series version (`conflict.stale`) |
| `SCHEDULED` → `ACTIVE` | `Clock` passes `validFrom` (derived, not stored) | — |
| `ACTIVE`/`SCHEDULED` → closed | A newer record's `validFrom` sets this record's `validTo`; or `end-seller-rate` / `end-seller-payout-terms` sets `validTo ≥ now` | Only seller scope can be ended without a successor. The Market record can only be superseded, never ended (no gap; fail closed would stop every order) |

Forbidden: editing a record; a `validFrom` in the past; ending the Market record; a plan-scope write (no writer until SUB).

### 3.2 Payout terms change effect on open items
A terms change never touches the journal. When the new record lowers `holdDays` for a seller, the `apply-terms-pull-forward` job (11) recomputes every open item of that seller (scope seller) or of every seller without a seller record (scope Market) as `eligibleAt := min(eligibleAt, anchorAt + newHoldDays)`. An increase changes nothing already frozen; it applies only to items anchored after the new record's `validFrom` (PT: "may bring money forward, never delay it; delaying needs an explicit hold with a reason"). Schedule, minimum and approval mode are read at run time (4.6), so their change applies at the next slot.

### 3.3 CommissionAssessment
| From → to | Trigger | Effects |
|---|---|---|
| (none) → `AWAITING_TAX` | `seller-order-invoiced.v1` handler: invoice facts read, commission computed (4.3) | No journal entry yet; no item. Stored so that nothing is recomputed later |
| `AWAITING_TAX` → `POSTED` | `tax.commissionTax` answers (handler, or the retry job 11) | Unit: frozen tax answer; journal transaction `invoice-posted` (4.2); `SettlementItem` created (`UNANCHORED`, or anchored at once if the units are already delivered) |
| `AWAITING_TAX` stays | `tax.legal-entity-registration-unknown`, `tax.unavailable` | Nothing posted (TX 4.9 fail closed); retried by job; an admin alert after `commissionTaxWaitAlertHours` (Market config) |
| `POSTED` → `PARTLY_REVERSED` → `REVERSED` | Refund facts (4.8) | Reversal transactions; cumulative fields grow; `REVERSED` when `unitsReversed = quantity` |

A charge assessment (flat fee) goes straight to `POSTED` (no commission, no tax call).

### 3.4 SettlementItem
| From → to | Trigger | Guard / effects |
|---|---|---|
| (none) → `UNANCHORED` | Assessment posted, units not yet all delivered | — |
| (none) → `MATURING` (kind `recall`; Ali CP-R1; C-P slice 6) | `transfer-recalled` posted (4.11) | Same unit as the posting, unique `recoveryActionId`; `anchorAt = eligibleAt = ` the posting instant, `holdDaysApplied = 0`; `ELIGIBLE` at once by the read-time rule below, so holds (the report's `ADMIN_REVIEW`) and 4.6 decide when it is paid. Every later row applies unchanged (`IN_PAYOUT`, `PAID`, freed with `eligibleAt` unchanged after `VOIDED`/`NOT_SENT`/`FAILED`); a recall item is never reversed by a refund (it has no assessment) |
| `UNANCHORED` → `MATURING` | Delivery facts show `delivered ≥ b` for the line (charge: first delivery of the sub-order) | `anchorAt = deliveredAt` of that mark; terms resolved **at `anchorAt`'s processing time** (`now`); `eligibleAt = anchorAt + holdDays` (calendar days as an exact duration of 24 h × n from the instant; ADR-0005: an elapsed duration, not a local-date rule, so no zone is needed); `termsRecordId`, `holdDaysApplied` stored |
| `MATURING` stays (L3, replaces the earlier `MATURING → UNANCHORED` row) | `seller-order-delivery-corrected.v1`: delivered count fell below `b` | The item keeps `anchorAt`/`eligibleAt` (strictly "only earlier", database guard PD6). In the same unit (cursor first, 9) the system places a `DELIVERY_CORRECTED` hold on the sub-order. At the re-delivery that covers `b` again, `anchorAt` moves to that mark and the hold gets `releaseDueAt = re-delivery + holdDays` (terms then in force); the system releases it at `releaseDueAt`. The delay is an explicit hold with a reason, as PT requires; `eligibleAt` itself never moves later |
| `MATURING` → `ELIGIBLE` | Derived at read time: `now ≥ eligibleAt` | — |
| `MATURING`/`ELIGIBLE` → `IN_PAYOUT` | Taken by a `Payout` in its creating unit | Item version check; one live payout per item |
| `IN_PAYOUT` → `PAID` | Payout `PAID` or `SETTLED_BY_NETTING` | — |
| `IN_PAYOUT` → `MATURING`/`ELIGIBLE` | Payout voided, `NOT_SENT` or `FAILED` | Item free again; `eligibleAt` unchanged |
| any unpaid → `CLOSED` | All units reversed (amount 0) | — |

Holds never change an item's state; `EligibilityPolicy` reads them (4.5). A delivery correction after `PAID` raises an admin alert and changes nothing paid.

### 3.5 PayoutHold
| From → to | Trigger | Guard / effects |
|---|---|---|
| (none) → `ACTIVE` | Admin `payout-hold.place` (reason code, scope); or system: `identity.seller-access-suspended.v1` → `SELLER_SUSPENDED` (seller scope); `ordering.refund-requested.v1` → `REFUND_PENDING` (CP-3); `payments` dispute opened → `DISPUTE` on each sub-order of the disputed order; `seller-order-delivery-corrected.v1` → `DELIVERY_CORRECTED` (L3); the held-funds job → `ADMIN_REVIEW` (4.11; days: answered, owner, 2026-10-08, Q-O1: 30/60/90); `payments.payout-account-change-reported.v1` → `ADMIN_REVIEW` (seller scope, `sourceRef` = the report id) + admin task (Hassan HP-2 "this wasn't me"; C-P slice 5); released by an admin only | Live payouts of the scope in `PENDING`/`AWAITING_APPROVAL`/`APPROVED` are voided in the same unit; a payout already `INSTRUCTING` or later is not stopped (it left; the alert says so). Event `payout-hold-placed.v1` |
| `ACTIVE` → `RELEASED` | Admin `payout-hold.release` (reason code, `outcome`), any reason; system release only for `REFUND_PENDING` (refund closed or succeeded), `DISPUTE` (dispute closed and, if lost, attributed or waived, 4.10) and `DELIVERY_CORRECTED` (at `releaseDueAt`, L3) | **`SELLER_SUSPENDED` is never released by the system**, including on `identity.seller-access-reinstated.v1`, which only raises an admin notice (Ali G1-r5). Event `payout-hold-released.v1` |

Forbidden: a hold without a reason code; a system release of an admin hold or of `SELLER_SUSPENDED`; editing a hold.

**Release of a report-sourced `ADMIN_REVIEW` hold (Ali CP-R1 condition 6; C-P slice 6):** protected: `payout-hold.release` is already a protected key (5.1: recent confirmation, refused in acting-as) and audited (`hold.released`, 8), for every source, so no change is needed; the system never releases this hold. A test proves the three refusals for this source. Releasing it before the hijacked account is closed does not send recalled money back: `payments` refuses with `payments.transfer.account-under-review` while the report is unresolved (4.6).

### 3.6 Payout
```
PENDING ──(AUTO)──────────────────────────────┐
AWAITING_APPROVAL ──approve (admin)──> APPROVED ┤
                                               ▼
                                         INSTRUCTING ──accepted──> INSTRUCTED ──transfer-executed──> PAID
                                               │                         └──transfer-failed──> FAILED
                                               ├──definite refusal──> NOT_SENT
                                               └──abandoned (fence)──> NOT_SENT
(any of PENDING, AWAITING_APPROVAL, APPROVED) ──hold / changed amount / access fail──> VOIDED
PENDING with transferAmount = 0 ──> SETTLED_BY_NETTING
```
| From → to | Trigger | Effects |
|---|---|---|
| (none) → `PENDING` / `AWAITING_APPROVAL` / `SETTLED_BY_NETTING` | Payout run (4.7), system worker | Items → `IN_PAYOUT`. `SETTLED_BY_NETTING`: journal `payout-netting` posted in the same unit; items `PAID` |
| `AWAITING_APPROVAL` → `APPROVED` | Admin `payout.approve` (protected), on one or many payouts, with the shown `transferAmount` echoed (approval binds the amount) | Marks only; no money moves in the admin request (SMR item 2) |
| `PENDING`/`APPROVED` → `INSTRUCTING` | Worker, after the checks of 4.6 and inside its write unit (4.7 step 4) | Journal `payout-instructed` (payable → in-transit, and netting); intent stored with `instructionKey` |
| `INSTRUCTING` → `INSTRUCTED` | `payments.instructTransfer` accepted (sync), or `transferByKey` finds it (reconciliation, P-c) | Payments' transfer id stored; event `payout-instructed.v1` |
| `INSTRUCTING` → `NOT_SENT` | A definite refusal, with `payments`' codes as given (Ali PC): `payments.transfer.account-not-ready` (a `RESTRICTED` account included), `payments.transfer.cooling-off`, `payments.transfer.insufficient-platform-balance`, `payments.transfer.provider-refused` (a provider 4xx at creation is synchronous, never `transfer-failed`), `payments.transfer.account-under-review` (an unresolved payout-account-change report on the account; Ali CP-R1 condition 5, `docs/design/domain/payments.md` 4.7); or, after `abandonTransfer(instructionKey)` answered `abandoned` (P-d fence), the quarantine pass answers `still-abandoned` (below; Hassan re-check item 5) | Journal `payout-unwound` (reverses the instructed posting); items free; the blocking reason is shown to the seller (AC "reason shown") |
| `INSTRUCTED` → `PAID` | `payments.transfer-executed.v1` | Journal `transfer-settled` (in-transit → cash); items `PAID`; statement job (4.12); event `payout-status-changed.v1` |
| `INSTRUCTED` → `FAILED` | `payments.transfer-failed.v1` (only after the provider created the transfer, Ali PC) | Journal `payout-unwound`; items free; admin alert; next slot (or admin `payout.retry`) proposes a **new** payout with a new key (AC: retry never pays twice) |
| `PENDING`/`AWAITING_APPROVAL`/`APPROVED` → `VOIDED` | A hold on the scope; an item reversed or changed; access check or readiness fails at execution; approval older than `approvalValidityDays` (Market config) | Items free; nothing was posted |

A timeout or `payments.unavailable` never moves `INSTRUCTING` by itself, and `payments` never re-sends (Ali PC): the reconciliation job (11) asks `transferByKey` (≤ 100 keys, P-c) and, after `transferSendTimeout` (> the `payments` lease, Ali PC), the fenced `abandonTransfer` (the O-2 pattern of ORD 3.5, applied to transfers; P-d): `abandoned` → the quarantine below, then `NOT_SENT`; `already-sent` → `INSTRUCTED`; `in-flight` / `payments.unavailable` → ask again later. **Quarantine (Hassan HP-4 fix 5; C-P slice 5):** after `abandoned` the payout stays `INSTRUCTING` (outcome and `payments`' `abandonedAt` noted) and its items are not re-proposed until, at least `TRANSFER_ABANDON_QUARANTINE` (platform-wide code constant, 15 min, a **minimum**, measured with the injected `Clock`; Ali 2026-10-08 (3): boot refuses a Market whose `payments` `transferSendLease` is longer than it, alongside the lease ≥ 3 × `providerCallTimeout` and `transferSendTimeout` ≥ 2 × lease checks) after `abandonedAt`, a second `payments.abandonTransfer(instructionKey)` answers `still-abandoned`. That second call is the quarantine pass: `payments` does a **live provider list lookup** by `transfer_group`, matched on `metadata.mp_key`, destination and amount, outside any unit (Hassan re-check item 5; `docs/design/domain/payments.md` 4.7 P-d); it is never `transferByKey`, which reads `payments`' stored state and would let a transfer whose webhook is late pass. Only `still-abandoned` gives `NOT_SENT` with `payout-unwound`; `already-sent {transferExecutionId}` gives `INSTRUCTED` (the fence breach is `payments`' alert; the ledger follows the normal path to `PAID`); `payments.unavailable` means wait and ask again on the next pass. One more reconcile pass, not a new state; one live payout per seller (L13) keeps the seller's next payout waiting. **Timeouts (HP-4 fix 3):** boot refuses a Market whose `transferSendTimeout` < 2 × `payments`' `transferSendLease`; safety does not depend on it (`payments` answers `in-flight` inside the lease). **Fence breach** (Ali PC): if `payments` later reports a transfer executed for a payout already `NOT_SENT`, C-P posts `transfer-after-abandon` (debit `seller-receivable`, credit `platform-cash`), alerts, and recovers the amount by netting (4.11). One live payout per seller (L13) means no second payout is created while one is `INSTRUCTING`. Bank-payout events (`payments.payout-paid.v1`, `payout-failed.v1`, the connected account's own daily payout, PT Ali) are stored as observations for the seller view and alerts; they do not change a `Payout` (the money already left the platform at `transfer-executed`).

### 3.7 DisputeCase
`OPEN` (payments `dispute-opened.v1`; `disputeOf` read (P-h); holds `DISPUTE`; journal `dispute-debited` **only when `fundsWithdrawn`**, for the disputed amount only; an inquiry posts nothing, Ali PC) → `WON` (`dispute-closed.v1` won: journal `dispute-reinstated` if funds were withdrawn; holds released) | `LOST` → `ATTRIBUTED_TO_SELLER` (admin `dispute.attribute`, protected, reason code, recovery amount ≤ cap of 4.10; journal `dispute-recovered`) or `BORNE_BY_PLATFORM` (admin, reason code; no seller posting). Holds `DISPUTE` released by the system at `WON`, `ATTRIBUTED_TO_SELLER` or `BORNE_BY_PLATFORM`. **Funds withdrawn after opening (Hassan HP-5; C-P slice 6 / payments slice 7):** `payments.dispute-funds-withdrawn.v1` posts `dispute-debited` and `-reinstated.v1` posts `dispute-reinstated` in any state, both keyed by the case (unique source, idempotent); on `dispute-closed.v1` and in the daily reconciliation C-P also re-reads `disputeOf` and posts whatever is missing, so `WON` never relies on a stale view.

## 4. Money rules

### 4.1 Commission rate (COM-01, COM-02, COM-04)
- Market record mandatory for every hosted Market; its first value comes from Market config (`commissionPayouts.initialCommissionRate`, AU `"0.15"`, ZZ another value, e.g. `"0.12"`), seeded once by the boot seed (11) when the series is empty; afterwards only the admin changes it (Q7: "value in a record, not in code").
- Seller override (COM-02, launch-required, Hadi): a seller-scope series; `source: 'seller'` when it answers.
- `CommissionRateSource.ratesFor(system, sellerIds ≤ 100, at)` (ORD 6.2): `at` must be in `[now − 5 min, now]` (the placement instant; same bound as `tax`'s `issuedAt`, so the port cannot be used to read history); per seller `{rate, rateRecordId, source}`; any seller without an answer fails the **whole** call (`commission-payouts.rate-unavailable`; ordering answers `checkout.unavailable`, ORD P1 step 9). Read-only, outside any unit (ADR-0025).
- COM-04 is ordering's freeze; C-P **never re-resolves** a rate for an order: every assessment copies the rate and record id from ordering's facts. A test proves a rate change between placement and invoice does not change the commission (AC 1).

### 4.2 Chart of accounts and posting kinds
Accounts are per Market and currency. Seller accounts carry `sellerId`.
| Account | Nature | Meaning |
|---|---|---|
| `platform-cash` | asset | Customer money on the platform's provider balance (separate charges and transfers, PT Ali) |
| `seller-conditional` (seller) | liability | Gross paid for a sub-order not yet invoiced (or refunded): the "conditional claim" of brief s4 flow 2 |
| `seller-payable` (seller) | liability | Seller share of invoiced units and charges, not yet transferred |
| `seller-in-transit` (seller) | liability | Instructed to `payments`, not yet executed |
| `seller-receivable` (seller) | asset | Money the seller owes the platform (refunds after payout, dispute recoveries); netted against future payouts |
| `commission-revenue` | revenue | Commission (net of reversals) |
| `commission-tax-payable` | liability | GST on commission owed by `Market.legalEntity` |
| `provider-fees` | expense | Stripe fees (Q8): payment, monthly account, payout, dispute fee |
| `refund-loss` | expense | Refunds whose loss bearer is the platform (Q6 rule 3) |
| `dispute-loss` | expense | Disputed amounts lost and not (yet) recovered |
| `bad-debt` | expense | Receivables written off (4.11) |

| Kind | Source | Debit | Credit |
|---|---|---|---|
| `order-paid` | `ordering.order-paid.v1` + facts | `platform-cash` (Σ sub-order gross) | `seller-conditional` per seller (sub-order goods gross + fee gross) |
| `invoice-posted` | assessment `POSTED` | `seller-conditional` (gross) | `seller-payable` (seller share), `commission-revenue` (commission), `commission-tax-payable` (commission tax) |
| `charge-posted` | invoice carrying the flat fee | `seller-conditional` (fee gross) | `seller-payable` (fee gross) |
| `refund-uninvoiced` | refund facts: cancelled/uninvoiced units, fee not yet invoiced | `seller-conditional` | `platform-cash` |
| `refund-reversal` | refund facts: invoiced units, loss bearer seller, item unpaid | `seller-payable` (share), `commission-revenue`, `commission-tax-payable` | `platform-cash` (gross of those units) |
| `refund-reversal-after-payout` | same, item already `IN_PAYOUT`/`PAID` | `seller-receivable` (share), `commission-revenue`, `commission-tax-payable` | `platform-cash` |
| `refund-platform-borne` | loss bearer platform | `refund-loss` (gross) | `platform-cash` |
| `payout-instructed` | payout `INSTRUCTING` | `seller-payable` (gross of items) | `seller-in-transit` (transfer amount), `seller-receivable` (netted) |
| `payout-netting` | payout `SETTLED_BY_NETTING` | `seller-payable` | `seller-receivable` |
| `payout-unwound` | `NOT_SENT` / `FAILED` | `seller-in-transit`, `seller-receivable` | `seller-payable` |
| `transfer-settled` | `transfer-executed.v1` | `seller-in-transit` | `platform-cash` |
| `provider-fee` | `fee-charged.v1` + `feeChargesOf` (P-f); every fee, **the dispute fee included** (its only path, Ali PC) | `provider-fees` | `platform-cash` |
| `dispute-debited` | dispute opened with `fundsWithdrawn` (P-h), or `payments.dispute-funds-withdrawn.v1` later (HP-5); one per case; **disputed amount only** (Ali PC: the fee was counted twice before; it posts only as `provider-fee`); an inquiry posts nothing | `dispute-loss` | `platform-cash` |
| `dispute-reinstated` | dispute won (amount returned; the fee stays, Q6) | `platform-cash` | `dispute-loss` |
| `dispute-recovered` | admin attribution (4.10) | `seller-receivable` (or `seller-payable` up to its unpaid balance) | `dispute-loss` |
| `transfer-reversed` | `payments.transfer-reversed.v1` after `instructTransferReversal` (4.11) | `platform-cash` | `seller-receivable` |
| `receivable-collected-externally` | admin record **after a second admin's confirmation** (4.11, HP-7) | `platform-cash` | `seller-receivable` |
| `receivable-written-off` | admin write-off **after a second admin's confirmation** (4.11, Q-S3) | `bad-debt` | `seller-receivable` |
| `transfer-recalled` | `payments.transfer-reversed.v1` for a reversal with reason `payout-account-compromised` (4.11; Hassan re-check 2(b)): money recovered from a hijacked connected account is still owed to the seller. **Confirmed by Ali CP-R1:** in the same unit C-P creates a `SettlementItem` of kind `recall` for the reversed amount (3.4), so `seller-payable` = Σ unpaid items still holds; `transfer-reversed` would be wrong here (it records a debt the seller does not have) | `platform-cash` | `seller-payable` |
| `transfer-after-abandon` | fence breach: `payments` reports a transfer executed for a payout already `NOT_SENT` (3.6; Ali PC) | `seller-receivable` | `platform-cash` |

Platform net margin = `commission-revenue` − `provider-fees` − `refund-loss` − `dispute-loss` − `bad-debt` (commission tax is a liability, not revenue), reconstructable at any time (brief s5, AC "net profit reconstructable").

### 4.3 Order paid and invoice (COM-04, COM-05)
- `order-paid.v1` (ids only) → `ordering.financialFactsOf({kind: 'order-paid'})` (system, ≤ 100 ids; ORD 6.2) → per line `sellerId`, `sellerOrderId`, `orderLineId`, quantity, gross/net/tax, frozen commission rate and record id, and per sub-order the fee gross → `order-paid` transaction. Nothing is payable yet (brief s4 flow 2). This is also the moment money of a seller without a ready account starts being "held" (Q3): nothing distinguishes it in the ledger; readiness is only a payout condition (4.6).
- `seller-order-invoiced.v1` → `financialFactsOf({kind: 'invoice'})` → per invoice line: `orderLineId`, unit range `[a, b)`, quantity, `net`, `tax`, `gross` of this document (tax's per-unit largest remainder of the frozen line, ORD 4.6), `issuedAt`; and the charge portion if this invoice carries the fee.
- Commission per invoice line: `round_half_up(net × frozenRate)` (Q7: after discount, excluding GST, never on shipping). Then `tax.commissionTax(system, {at: issuedAt, entries})` (TX 6.2; `at` from the immutable invoice, H2). `sellerShare = gross − commission − commissionTax`.
- Worked examples (join the agent's fixed set, TX 13.3):
  - AU (inclusive, AUD, 15 %): line $11.00 (net $10.00, GST $1.00) → commission $1.50; commission GST $0.15 if the entity is registered, $0.00 if not; seller share $9.35 or $9.50; unknown → `AWAITING_TAX`, nothing payable.
  - ZZ (exclusive, JPY, rate `"0.12"`, `zz_standard` 15 %): net ¥1,000, tax ¥150, gross ¥1,150 → commission ¥120, commission tax ¥18 (registered), seller share ¥1,012.
  - Allocation: 3 × $3.35 invoiced as 1 then 2 units (shares 31/30/30 of the line GST, TX 13.3) → assessments sum exactly to the line; commission rounded per assessment (AG-4).
- Conservation: for each sub-order, `seller-conditional` reaches 0 exactly when every unit is invoiced or refunded and the fee is invoiced or refunded (property test, 13).

### 4.4 PayoutTerms (PAY-10, PAY-11, PAY-12)
- Fields and resolver as 2.1 and 2.2. The Market default's first value comes from Market config (`commissionPayouts.initialPayoutTerms`: AU `{weekdays: [TUE], localTime: "10:00", holdDays: 7, minimumAmount: {amount: 5000, currency: "AUD"}, approvalMode: "AUTO"}`, i.e. Tuesday 10:00 in the seller's own zone, hold 7 days, minimum A$50, AUTO (values listed by Ali PC "Values for Hadi"; closes Q-H2 once Hadi's confirmation is recorded, which Hadi G2 decisions 2026-10-08 does not yet contain); ZZ carries its own values in its own currency), seeded like the rate. Values never in code and never an AU branch (brief s6): the same keys exist for every hosted Market, both fixtures carry them, no core default (Ali Q-A4).
- Bounds: `MIN_HOLD_DAYS = 7` (Ali G1-r1), `MAX_HOLD_DAYS = 60` (Ali PC; `payments` G2 found no Stripe limit for funds on the platform balance, 4.6 there, so 60 is our policy), both platform-wide code constants in the declaration and database CHECKs (not Market values); `minimumAmountCap` per Market in Market config (a Money bound cannot be a code constant across currencies). Checked on write **and on read**: a stored record outside the bounds is unreadable, the resolver answers `TermsUnavailable`, nothing is anchored or paid, and an alert fires (SMR M4 precedent).
- Who: admin with `commission-payouts.payout-terms.edit` (protected), both scopes, expected version, reason code, audit with before/after, event `payout-terms-changed.v1`; the seller is told with the reason code through the in-panel notice (until the notifications module, brief s8 risk row). The seller reads only their own effective terms (`earnings.view`).
- Destination account is never a term (owned by `payments`; changed only by the seller through Stripe onboarding and VER-10).
- The plan scope: `PayoutTermsResolver` has the slot; no table rows, no writer, no UI until SUB (PAY-12, P2).

### 4.5 Eligibility (PAY-01 as adapted; brief s5 conditions 1 to 3)
An item is **eligible** when all hold:
1. its assessment is `POSTED` (invoiced, customer money secured, commission tax known);
2. it is anchored (delivered, T1 A) and `now ≥ eligibleAt` (hold ≥ 7 days, frozen);
3. no active hold covers it (seller scope or its sub-order: `NOT_RECEIVED`, `SELLER_SUSPENDED`, `DISPUTE`, `REFUND_PENDING`, `ADMIN_REVIEW`, `DELIVERY_CORRECTED`);
4. `amount > 0` and it is not in a live payout.

Eligibility is computed, never stored as a flag (only `eligibleAt` is stored), so a new hold or a refund takes effect at the next read.

### 4.6 Payout conditions (brief s5 conditions 4 to 9) and the schedule
At the seller's slot, the worker instructs a transfer only when, in addition to 4.5:
| # | Condition | Source | On failure |
|---|---|---|---|
| 4 | The connected account can receive transfers, and the VER-10 waiting period after an account change has passed | `payments.payoutReadiness(system, ids)` (`{ready}` only, SMR item 1; P-e); `payments` refuses an instruction during the waiting period (definite code `payments.transfer.cooling-off`, Ali PC) | No payout; money stays held (Q3); seller sees `payout.blocked.account-not-ready` |
| 5 | The Seller Owner has an active second factor (ADR-0018 decision 5) | `identity` facade (ID-3, new) | `payout.blocked.second-factor-required` |
| 6 | The business identifier re-check before payouts are enabled is done | `sellers` facade (S-e, new). Ruled (Ali Q-A6): a `sellers` fact, not Stripe KYC; a missing answer = `false` (blocks) | `payout.blocked.business-id-recheck` |
| 7 | Transfer amount > 0 and ≥ the terms' `minimumAmount`, else money accumulates (Hadi; AC "minimum") | `PayoutPlanner` | `below-minimum`; cursor advances, items stay |
| 8 | The seller's access state is `approved` (synchronous batch call, no cache, error = do not instruct; Ali G1-r5) and no `SELLER_SUSPENDED` hold, re-checked inside the write unit (SMR M3) | `sellers.accessStatesForPayout` (restricted file `sellers.payout-access.ts`) + own holds | Whole batch not instructed |
| 9 | MANUAL: an admin approved this payout with this amount | `Payout.approval` | Stays `AWAITING_APPROVAL`; alert after `manualApprovalAlertHours` |

**Recall items (Ali CP-R1 conditions 3 and 4; C-P slice 6).** Only the payout run (4.7) pays a `recall` item, under conditions 4 to 9 above and the eligibility of 4.5, and only to the seller's current account; the money never goes back to the account it was recalled from: a replacement account cools off (`payments.transfer.cooling-off`, HP-3) and `payments` refuses any transfer to an account with an unresolved report (`payments.transfer.account-under-review`, `docs/design/domain/payments.md` 4.7). C-P adds no timer of its own. Netting applies as usual (`N = min(E, R)`: the seller still owes a receivable) and so does the minimum. While a payout holding a `recall` item is live, a transfer reversal of that money is refused (`command-transfer-reversal`, `commission-payouts.recovery.payout-live`). After `NOT_SENT` or `FAILED` the item is freed with `eligibleAt` unchanged and proposed again. **Forced approval:** a payout that contains a `recall` item not yet paid (the first payout to pay it, a re-proposal after `VOIDED`, `NOT_SENT` or `FAILED` included) is created `AWAITING_APPROVAL` whatever the seller's `approvalMode` (stored `approval_mode = manual`; data 3.7); approval binds the amount as today; no second approver (Hassan Q-S3). If netting takes the whole gross (`T = 0`) nothing is transferred and the payout settles by netting as today (data: `settled-by-netting` exists only with `transfer = 0`).

**Schedule.** A seller is due when a local slot (weekday + `HH:mm` in the seller's approved operating zone, `sellers.sellerSummaries`, non-provisional) lies in `(lastSlotAt, now]`. A missing or provisional zone skips the seller with an alert, never the Market timezone (PRC 4.3 precedent). DST (ADR-0005): a local time that does not exist is moved forward to the first valid instant; an ambiguous one takes the earlier instant. Several missed slots (downtime) produce **one** payout, not one per slot. Brisbane (no DST) and Perth sellers run at their own local time (AC "Brisbane and Perth").

### 4.7 Payout run (per Market, system worker)
1. Select due cursors (index on `nextSlotAt`), at most 100 sellers per batch, advisory lock per (Market, job) (brief s5 "time").
2. **Outside any unit** (ADR-0025): read own items, holds, receivable balances; resolve terms at `now`; `PayoutPlanner` → gross `E`, netted `N = min(E, R)`, transfer `T = E − N` per seller. Sellers below minimum (with `T > 0`) only advance their cursor.
3. Same phase: `sellers.accessStatesForPayout(system, ids)` → `PayoutAccessMapping` (default deny; any anomaly drops the whole batch, SMR M3); `payments.payoutReadiness`; `identity` second factor (ID-3); `sellers` business-id re-check (S-e). Failures record the blocking reason per seller (seller view), no payout.
4. **One unit per seller** (READ COMMITTED, ADR-0025; L15: the unit's first statement locks the seller's `PayoutScheduleCursor` row, which every hold placement also locks first, so it replaces the `serializable` unit with the same outcome and no serialization retries): re-read holds and **re-check `SELLER_SUSPENDED` in the unit** (M3); no other live payout of the seller (L13); re-validate items (version); create the `Payout`: AUTO → `INSTRUCTING` with journal `payout-instructed`; MANUAL, **or any payout holding an unpaid `recall` item with `T > 0` (Ali CP-R1 condition 4)** → `AWAITING_APPROVAL` (no journal); `T = 0` → `SETTLED_BY_NETTING` with `payout-netting`. An `APPROVED` MANUAL payout is executed by the same pass: re-checks 3 and 4, then `INSTRUCTING` (a changed amount → `VOIDED`, new proposal).
5. **Re-check before instruction (Hassan Q-S2; C-P slice 5):** after the commit of step 4, one more `sellers.accessStatesForPayout` call for the batch's `INSTRUCTING` sellers, through `PayoutAccessMapping`. A seller who is no longer `approved` (or any anomaly, which fails the whole batch) is not instructed: C-P calls `payments.abandonTransfer(instructionKey)` (a tombstone, nothing was sent) and moves the payout to `NOT_SENT` with `payout-unwound` (no quarantine: C-P never called `instructTransfer` for that key). Then, **after commit**, per remaining `INSTRUCTING` payout: `payments.instructTransfer(system, {instructionKey: payout.id, sellerId, amount: T, reference: payout.id})` (P-a; no description field, Ali PC). `accepted {transferExecutionId}` → `INSTRUCTED`; `refused {code}` → `NOT_SENT` with that code; timeout/`payments.unavailable` → stays `INSTRUCTING` for reconciliation (3.6).
6. Advance cursors.

**Residual window (documented for Hassan, M3):** between step 3's access read and step 5's call, a suspension can land. It is closed by: the in-unit `SELLER_SUSPENDED` re-check (step 4) for any event already consumed, serialised with hold placement by the cursor lock (L15); the window left is event latency plus the seconds between commit and call. A suspension landing inside it does not stop that transfer; the hold stops every later one, and the transfer can be reversed (4.11). Measured in the slice-5 test with a fake clock and a delayed event. **Hassan (Q-S2/HL4):** the cursor lock is accepted in place of `serializable`; with the step-5 re-check the remaining window is the milliseconds between that call and `instructTransfer`. The delayed-event test stays.

### 4.8 Refunds and cancellations (Q6 rules 1 to 4; ADR-0007 decision 11)
- Rule 1 (money without an order, Saga compensation): no ledger entry exists (the ledger starts at `order-paid`); C-P does nothing (ADR-0035 decision 5).
- Rule 2 (seller cancels a line): `order-line-cancelled.v1` changes no money; the units' gross stays in `seller-conditional` until the admin's RET-06 refund (they can never be invoiced, ORD 4.5, so never become payable). C-P does not consume the event (ADR-0015: no use).
- Rule 3 (admin refund): `order-line-refunded.v1` → `financialFactsOf({kind: 'refund'})` → per line the **split** (CP-4): uninvoiced quantity with its gross, and the invoiced unit range `[a', b')` in invoice-position space with the gross of exactly those units computed from the same per-unit shares the invoices used; the fee share (cumulative range); `lossBearer`.
  - Uninvoiced units and an uninvoiced fee share → `refund-uninvoiced`.
  - Invoiced units, loss bearer `seller`: for each assessment overlapping `[a', b')`, `ReversalCalculator` gives this reversal's commission; `tax.reverseCommissionTax(system, {original: frozen PD8 values, reversedBefore, reversedAfter})` gives its tax (TX 4.9, H7: originals only from C-P's stored assessment); seller share reversed = gross of those units − commission reversed − tax reversed. Posted as `refund-reversal` if the item is unpaid (the item's `amount` falls), else `refund-reversal-after-payout` (receivable). A reversal whose commission part rounds to 0 is still recorded (units and share move; L14).
  - Fee share of an invoiced fee → the same, without commission.
  - Loss bearer `platform` (reason code in `ordering`) → `refund-platform-borne`; the seller's assessment and item are untouched and commission is kept (no reversal record). **Answered (owner, 2026-10-08, Q-O2): yes, the seller keeps the full share and the platform bears the whole refund (the GST side goes to the tax agent, Q-T2).** The posting above is built to this answer.
  - Property test: refunding every unit of an assessment in any order of partial refunds reverses exactly its commission, its commission tax and its seller share.
- Rule 4 (refund after payout): the receivable; netted from the next payouts (4.7); AC "day 9 after payout → negative balance netted".
- The refund amount itself is `ordering`'s; C-P never computes a customer refund and never initiates one (brief s5 "separation").

### 4.9 Stripe fees (Q8)
`payments.fee-charged.v1` (ids only) → `feeChargesOf` (P-f: `payments`' kind names `payment-processing`, `connect-active-account`, `connect-payout`, `dispute`, `other` (`other` posts and raises an alert); amount; `orderId` when the fee relates to a payment; `sellerId` where attributable) → `provider-fee`. The dispute fee arrives only here (Ali PC). Never deducted from a seller; not reversed on refund (no compensating entry, brief s5). Shown on the admin settlement page and in net margin only.

### 4.10 Chargebacks (Q6 rule 5)
- Dispute opened: `disputeOf` (P-h) → if `fundsWithdrawn`, `dispute-debited` for the disputed amount only (the platform pays first); an inquiry (no withdrawal) posts nothing (Ali PC). `DisputeCase OPEN`, `DISPUTE` holds on the order's sub-orders (unpaid money of all its sellers stops until the case is closed or attributed). The dispute fee posts once, as `provider-fee` from `fee-charged.v1` (4.9).
- Funds withdrawn after opening (an inquiry that became a chargeback; Hassan HP-5): posted from `dispute-funds-withdrawn.v1`, with the re-read of `disputeOf` on close and in the daily reconciliation as backstop (3.7). Tests: inquiry → chargeback → won; inquiry → chargeback → lost.
- Won: `dispute-reinstated` (if funds were withdrawn); the dispute fee stays a platform cost.
- Lost: admin decides per sub-order (one attribution record per sub-order, data L10). `ATTRIBUTED_TO_SELLER` (protected key `dispute.attribute`, reason code): posted `dispute-recovered`, taken first from the seller's unpaid payable (that sub-order's items), the rest to the receivable. **Recovery amount and cap: answered (owner, 2026-10-08, Q-O4): the seller's share only for that sub-order, not the full gross; the platform loses its commission on that sale and bears the fees.** The data design is built to this answer (cap = the seller's unreversed share of the sub-order); the draft's "full gross" alternative is not built. Commission and commission tax are **not** reversed, because no refund document exists (proposal; agent item Q-T3). `BORNE_BY_PLATFORM`: no seller posting.
- A recovery beyond what netting can take is collected by transfer reversal (4.11), commanded by C-P (payments brief s5 flow 7).

### 4.11 Negative balance: cap and recovery path (Ali G1-r1)
- **Cap:** `commissionPayouts.receivableCap` (Money, Market config; no core default, both fixtures). **AU value and effect answered (owner, 2026-10-08, Q-O3): the cap is AU Market config `{amount: 50000, currency: "AUD"}` (A$500); the ZZ fixture value is `{amount: 70000, currency: "JPY"}` (Hadi payments and commission-payouts decisions 2026-10-08); no core default; exceeding it gives an alert to the admin and the admin follow-up list only, with no automatic sales stop.** The receivable above zero raises `seller-balance-negative.v1` (`level: negative`); above the cap, `level: over-cap`, an admin alert, and the seller appears on the admin "negative balances" list. Over-cap does not stop new sales (owner, Q-O3: alert and admin list only); the `receivableOverCap(sellerIds)` read stays available for a later decision.
- **Recovery path, in order:** (1) netting at every payout (automatic); (2) if nothing was netted for `recoveryWindowDays` (Market config) or the seller is not `approved`, the admin may command a **transfer reversal** of recent transfers (`receivable.recover`, protected): marks a `RecoveryAction`; the worker calls `payments.instructTransferReversal(system, {key: recoveryAction.id, sellerId, transferExecutionId, amount, reasonCode})` (P-b; **HP-8**: the use case accepts only a `transferExecutionId` found on one of *that seller's* payouts in the context's Market, from C-P's own `payouts` table, else not-found; `payments` refuses a seller mismatch too; test with two sellers), capped by the transfer's unreversed amount (`transferByKey`, P-c) and by the receivable; an unknown outcome is resolved by key lookup; `transfer-reversed.v1` posts `transfer-reversed`; `transfer-reversal-failed.v1` (consumed, Ali PC) marks the action `FAILED`, posts nothing and leaves the amount to netting; (3) external collection recorded by the admin (`receivable.recover`, reason code) → `receivable-collected-externally`; (4) write-off (`receivable.write-off`, protected, reason code) → `receivable-written-off`. Every step audited.
- **Recall from a hijacked payout account (Hassan re-check 2(b); C-P slice 6):** when `payments` resolves a "this wasn't me" report as `account-closed`, the money still on the connected account must come back before the record closes (`docs/design/domain/payments.md` 4.6 condition 4). The admin uses `command-transfer-reversal` with reason code `payout-account-compromised`: allowed only while the seller has an active `ADMIN_REVIEW` hold whose source is a payout-account-change report (C-P's own `payout_holds`, else `commission-payouts.recovery.no-report-hold`); capped by the transfer's unreversed amount only (not by the receivable, because the money is owed to the seller); HP-8 seller binding unchanged; `transfer-reversed.v1` posts `transfer-recalled` (debit `platform-cash`, credit `seller-payable`), not `transfer-reversed`; `transfer-reversal-failed.v1` marks the action `FAILED` and alerts (the admin sees the remaining balance in `payments`' close refusal). **How the recalled payable is paid again (Ali CP-R1, Ali ruling CP-R1 2026-10-08; C-P slice 6):** `transfer-recalled` is chosen from C-P's own `RecoveryAction.reasonCode = payout-account-compromised`, never from the event payload (the event carries ids only); the posting and a `recall` `SettlementItem` (3.4; amount = the reversed amount) are written in one unit with a unique `sourceRef` and a unique `recoveryActionId`; the amount is at most the transfer's unreversed amount and the HP-8 seller binding is unchanged; several partial reversals give several actions and so several items. The item is then paid by the normal payout run only (4.6 "Recall items", 4.7), never by an admin-commanded payout (2.3) and never by an un-itemised planner amount. Money Stripe already paid from the hijacked account to the attacker's bank is outside CP-R1: nothing is posted for it until the owner decides (Q-O5, 15).
- **Reversal refused while a recall is being paid (Hassan final check, decision 1; C-P slice 6):** `command-transfer-reversal` for seller S is refused with `commission-payouts.recovery.payout-live` while S has a live payout (`PENDING` to `INSTRUCTING`) that holds an unpaid `recall` item. The check runs inside the unit that holds S's `PayoutScheduleCursor` lock, after the lock is taken, so it cannot race the payout run. This applies to the access row of `command-transfer-reversal` in 5.2. Slice 6 test (both Market fixtures): a reversal attempted while such a payout is `INSTRUCTING` is refused and writes nothing; the same reversal after the payout is `PAID` or `NOT_SENT` is accepted.
- **Two-person rule (Hassan Q-S3 accepted, extended by HP-7; C-P slice 6):** a write-off **and an external collection** are recorded as `requested` by one admin and take effect only when a **different** admin confirms through `confirm-recovery-action` (5.2): the confirmer holds the same key (`receivable.write-off` / `receivable.recover`) with a recent confirmation, not in acting-as; confirmation columns are NOT NULL before `recorded`; the journal transaction is posted only in the confirming unit. An external collection's confirmation stores an evidence reference code (bank reference, closed pattern, no free text), because money received outside Stripe is not in `dailyTotalsOf` and the daily reconciliation cannot catch it. Database CHECK `confirmed_by ≠ requested_by` for both kinds (data 3.9). `payout.approve` gets **no** amount-based second approver (Hassan: approval releases only money owed to that seller, to that seller's own account, behind every hold, bound by `payouts_approval_check`).
- **Money held for a seller who never onboards** (open from SMR): the `sellers` grace (default 30 days, Hadi decision 4) stops new sales; existing money stays. Mechanism (Market config keys, no core default, both fixtures): a held-funds age alert at `heldFundsAlertDays` and an admin list; at `heldFundsLimitDays` (code upper bound 90, Ali Q-A4; 90 is our policy pending the lawyer) the affected sub-orders get a system `ADMIN_REVIEW` hold and an admin task. **Answered (owner, 2026-10-08, Q-O1): staged 30/60/90: day 30 new sales stop; day 60 admin outreach and an `ADMIN_REVIEW` hold; day 90 the lawyer decides; the platform never keeps the money; the 90-day bound is our policy pending the lawyer** (Ali's earlier text, kept: customers refunded only for undelivered sub-orders; the owner's answer does not say this, so it stays Ali's ruling.) No automatic customer refund and no automatic forfeiture in any case.

### 4.12 Statements (PAY-09; P0 only if the entity is GST-registered; gated on the tax agent)
- One `PayoutStatement` per `PAID` or `SETTLED_BY_NETTING` payout, issued by the statement job after the payout settles: lines = assessments and reversals in the payout (commission, commission GST, seller share), totals, issuer = `MarketConfig.legalEntity` name and tax number as of `issuedAt`, issue date local to the seller's zone (ADR-0005).
- Document kind, required fields and labels come from `tax` (a commission-document decision method, TX-C1, 6.1). Registration unknown → no statement (and no payout anyway, 3.3). Not registered → a plain statement, not a tax invoice (TX 4.9: "PAY-09's tax statement is then not required").
- **Recall items (Ali CP-R1 condition 8; gated with PAY-09 on the tax agent):** a `recall` item is shown as "recalled transfer re-paid" and points to the original payout; it is not a new supply and creates no new commission tax. The tax agent confirms this wording when PAY-09 is unblocked.
- Inert HTML from the record (PDF P2). Seller sees only their own; byte-identical not-found for another seller's or Market's statement.

## 5. Authorisation (ADR-0018, ID 5.2)

### 5.1 Permission catalogue (`modules/commission-payouts/contracts/permissions.ts`, registered with `registerPermissions('commission-payouts', CATALOGUE)` in `commission-payouts.module.ts`)
| Key | Scope | Protected | Allows |
|---|---|---|---|
| `commission-payouts.earnings.view` | seller | no | Own commission per order (COM-06), balance buckets, transactions (PAY-08), statements, own terms read-only, blocking reasons |
| `commission-payouts.settlement.view` | platform | no | Settlement page, ledger per seller, payouts, holds, statements; every read of a seller's financial history is audited (VER-14) |
| `commission-payouts.commission-rate.edit` | platform | **yes** (proposal; money impact, 15 Q-S1) | Set the Market rate; set or end a seller rate |
| `commission-payouts.payout-terms.edit` | platform | **yes** (brief s5) | Set the Market default and set or end seller terms |
| `commission-payouts.payout-hold.place` | platform | **yes** | Place a hold with a reason code |
| `commission-payouts.payout-hold.release` | platform | **yes** | Release any hold, `SELLER_SUSPENDED` included, with a reason code and outcome |
| `commission-payouts.payout.approve` | platform | **yes** | Approve MANUAL payouts (amount-bound) |
| `commission-payouts.payout.retry` | platform | **yes** (proposal) | Ask the worker to propose a new payout for a seller now, after `FAILED`/`NOT_SENT` |
| `commission-payouts.dispute.attribute` | platform | **yes** (proposal) | Attribute a lost dispute to a seller, or to the platform |
| `commission-payouts.receivable.recover` | platform | **yes** (proposal) | Command a transfer reversal; record an external collection |
| `commission-payouts.receivable.write-off` | platform | **yes** (proposal) | Write off a receivable |

Protected = admin second factor with recent confirmation (`identity.hasRecentConfirmation`), refused in an acting-as session (Hassan O-10), refused on any AI-tool path (no tools exist, 12). The four brief keys keep their names; the five marked "proposal" are new and need Hassan's and Ali's acceptance. **Hassan accepted all five as protected (Q-S1, 2026-10-08)**; **Ali accepted all five as protected (2026-10-08, Ali security follow-up ruling 2026-10-08 (1))**: one shared definition across both modules (HP-6), checked once in the gate, no module-local version; the keys still need the ID-P1 mini-review before payments slice 4 and C-P slice 5, and until then `hasRecentConfirmation` is not proven to mean a second-factor re-confirmation. Hassan adds (Low): `set-seller-rate` raises an admin alert and an audit signal when a seller rate is set below the Market rate in force (collusion signal; with the slice that ships `set-seller-rate`, COM-02). "Protected" is the one gate definition shared with `payments` (key + `hasRecentConfirmation` + not acting-as; payments 4.4, HP-6).

### 5.2 Use cases
| Use case | Access rule | Ownership / scope |
|---|---|---|
| `view-earnings`, `view-seller-order-commission` (batch ≤ 100, BFF for ORD-02/03), `list-transactions`, `view-statement`, `view-own-payout-terms` | `permissions: [earnings.view]` | `sellerId` from `ActorContext` only; ids from input filtered by it; not-found byte-identical for another seller or Market (ID 5.2) |
| `view-settlement`, `view-seller-ledger`, `list-payouts`, `list-holds`, `list-negative-balances`, `list-awaiting-approval` | `permissions: [settlement.view]` | Market from context; reads audited (`commission-payouts.financial-history.viewed`, ids only) |
| `set-market-rate`, `set-seller-rate`, `end-seller-rate` | `permissions: [commission-rate.edit]` | Seller id looked up in the context's Market (`sellers.sellerSummaries`, anonymous pair); unknown → `seller-not-found` |
| `set-market-payout-terms`, `set-seller-payout-terms`, `end-seller-payout-terms` | `permissions: [payout-terms.edit]` | As above |
| `place-hold` / `release-hold` | `permissions: [payout-hold.place]` / `[payout-hold.release]` | Sub-order ids validated against C-P's own assessments of the context's Market |
| `approve-payouts` | `permissions: [payout.approve]` | Payout ids of the context's Market; each with its echoed amount |
| `request-payout-retry` | `permissions: [payout.retry]` | Seller and payout looked up in the context's Market; another Market's id → byte-identical not-found (HP-15; C-P slice 5) |
| `attribute-dispute` | `permissions: [dispute.attribute]` | Case in the context's Market, else byte-identical not-found; only sub-orders on that case's `dispute_case_seller_orders` (HP-15; slice 6) |
| `command-transfer-reversal`, `record-external-collection` / `write-off-receivable` | `permissions: [receivable.recover]` / `[receivable.write-off]` | Seller in the context's Market, else byte-identical not-found (HP-15); reversal: `transferExecutionId` must be on one of that seller's payouts in the Market, else not-found (HP-8); external collection and write-off only record `requested` (HP-7, Q-S3; slice 6); reason `payout-account-compromised` only under an active report-sourced `ADMIN_REVIEW` hold (4.11; Hassan re-check 2(b)); external collection: the requester enters the evidence reference code (Hassan re-check item 4) |
| `confirm-recovery-action` (new; owner C-P; HP-7, Q-S3) | `permissions: [receivable.recover]` for external collection / `[receivable.write-off]` for write-off | Action in the context's Market and `requested`, else not-found; confirmer ≠ requester (`commission-payouts.recovery.same-admin`); evidence reference code required for external collection, **entered again by the confirmer** and equal to the requester's (`commission-payouts.recovery.evidence-mismatch`), validated with the one literal `EVIDENCE_REFERENCE_PATTERN` (`^[A-Z0-9][A-Z0-9-]{3,34}$`; a `test:db` test asserts it equals the CHECK literal), and not already used by another external collection in the Market (`commission-payouts.recovery.evidence-reused`; the partial unique index of data 3.9 is the second lock; Hassan re-check item 4); posts the journal transaction in the same unit; audit `receivable.confirmed` (slice 6) |
| `CommissionRateSource.ratesFor` (port implementation) | `system` | Market from the context; `at` bounded (4.1) |
| All handlers and jobs of 6.4 and 11 | `system` | Market from the envelope or per hosted Market |

No seller write exists in this module. No use case joins the not-approved allow-list (a suspended seller still sees their earnings? **no**: identity ends a suspended seller's sessions; when SEL-08 or a later rule lets a not-approved seller read, that is an allow-list entry for review). Acting-as: reads allowed with both actors in the audit row; every write refused (all writes are protected admin keys).

### 5.3 Default roles (Hadi decides; seed data, owner informed — Ali O-6 precedent)
Proposal: seller side, `earnings.view` to Store Manager and Bookkeeper (Seller Owner holds every seller key). Admin side, a Finance role (or the Platform Administrator until admin roles are named) gets `settlement.view` and the protected keys, granted explicitly; Viewer gets nothing (financial data).

### 5.4 Answer codes
`commission-payouts.seller-not-found`, `.rate-unavailable`, `.rate.out-of-range`, `.terms-unavailable`, `.terms.hold-days-out-of-range`, `.terms.minimum-out-of-range`, `.terms.schedule-invalid`, `.valid-from-in-past`, `.market-record-cannot-end`, `.hold.not-active`, `.hold.reason-required`, `.payout.not-awaiting-approval`, `.payout.amount-changed`, `.dispute.not-lost`, `.recovery.amount-out-of-range`, `.statement-not-found`, `.batch.too-large`; seller-view blocking reasons `payout.blocked.account-not-ready`, `.second-factor-required`, `.business-id-recheck`, `.below-minimum`, `.on-hold` (with the hold's public reason code; **Hassan Q-S4 / HL3:** the exact code is stored, but a seller sees `seller-suspended`, `dispute` and `admin-review` only as a generic `on-hold` (contact support), and `refund-pending`, `not-received` and `delivery-corrected` specifically; one mapping in the read use case, also applied by any consumer of `payout-hold-placed.v1` that reaches a seller; C-P slices 5 and 7), `.awaiting-commission-tax`; `commission-payouts.recovery.same-admin`, `.recovery.evidence-required`, `.recovery.not-requested` (HP-7); `.recovery.evidence-mismatch`, `.recovery.evidence-reused`, `.recovery.no-report-hold` (Hassan re-check items 2(b), 4); `.recovery.payout-live` (a reversal of money held by a live payout with a `recall` item, Ali CP-R1 condition 3); platform `conflict.stale`, `conflict.retry`, `validation.failed`.

## 6. Boundary

`commission-payouts` imports only `contracts/` of `ordering` (facts, events, the `CommissionRateSource` type it implements), `tax`, `payments`, `sellers` (including the restricted `sellers.payout-access.ts`), `identity` (through the gate and ID-3), plus the kernel and `platform/`. **Nothing imports `commission-payouts` except the composition root** (binding the port) and the BFF's HTTP reads. No module reads its tables. `no-circular` holds: C-P → ordering, tax, payments, sellers, identity; none of them imports C-P (ORD T2; payments receives commands, not imports, P-6 inherited).

### 6.1 What commission-payouts needs from others
| # | From | Need | Status |
|---|---|---|---|
| CP-1 | `ordering` | Implement `CommissionRateSource` (ORD 6.2) | This design (4.1) |
| — | `ordering` | `financialFactsOf` kinds `order-paid`, `invoice`, `refund` (ORD 6.2), system-only list (TX H6) | Exists in ORD G2 |
| CP-2 | `ordering` | `financialFactsOf({kind: 'delivery', deliveryMarkIds})` → per line cumulative `delivered` after the mark and `deliveredAt`; the same for a correction id | **New; ordering mini-review** |
| CP-3 | `ordering` | Events `refund-requested.v1` and `refund-request-closed.v1` (ids only) (T2 A) | **New; ordering change-log row** |
| CP-4 | `ordering` | Refund facts split per line into uninvoiced quantity and invoiced range `[a', b')` in invoice-position space, with gross of exactly those units from the invoices' per-unit shares | **New; ordering mini-review (with Mojtaba)** |
| — | `tax` | `commissionTax`, `reverseCommissionTax` (system; TX 6.2), PD8 | Accepted here |
| TX-C1 | `tax` | Commission-statement document decision (kind, required fields, labels) for 4.12 | **New; tax change-log row; gated slice** |
| P-a | `payments` | `instructTransfer(system, {instructionKey, sellerId, amount, reference: payoutId})` → `accepted {transferExecutionId}` / `refused {code}` (payments' codes, Stripe 4xx incl. insufficient platform balance) / `payments.unavailable`; no description field; same key + different amount refused | Ruled, Ali PC; payments 4.7 |
| P-b | `payments` | `instructTransferReversal(system, {key, sellerId, transferExecutionId, amount, reasonCode})` (`sellerId` added, Hassan HP-8; `payments.transfer.seller-mismatch`); unknown outcomes by key lookup | Ruled, Ali PC; payments 4.7 |
| P-c | `payments` | `transferByKey(system, instructionKeys ≤ 100)` → state, ids, amount, reversed amount (replaces `transferResultOf`) | Ruled, Ali PC |
| P-d | `payments` | Fenced `abandonTransfer(system, instructionKey)` → `abandoned` / `already-sent` / `in-flight` / `payments.unavailable` (copy of `abandonRefund`: lease, provider lookup by `transfer_group`/metadata, `ABANDONED` final, tombstone); C-P's `transferSendTimeout` > the `payments` lease | Ruled, Ali PC; Hassan reviews with H-P2 |
| P-e | `payments` | `payoutReadiness(system, sellerIds ≤ 100)` → `{ready}` (SMR item 1); importers `sellers`, C-P, composition root | Ruled, Ali PC |
| P-f | `payments` | `fee-charged.v1` + `feeChargesOf(system, ids ≤ 100)`: payments' kind names (`other` → alert here), amount, `orderId` where the fee relates to a payment; the dispute fee only on this path | Ruled, Ali PC |
| P-g | `payments` | `transfer-executed.v1`, `transfer-failed.v1` (post-creation only), `transfer-reversed.v1`, `transfer-reversal-failed.v1`, `payout-paid.v1`, `payout-failed.v1` (`bankPayoutId`) (ids only) | Ruled, Ali PC |
| P-h | `payments` | `dispute-opened.v1`, `dispute-closed.v1` + `disputeOf(system, ids ≤ 100)` → `orderId`, amount, `fundsWithdrawn`, outcome; **no fee** | Ruled, Ali PC |
| P-j | `payments` | `dispute-funds-withdrawn.v1`, `dispute-funds-reinstated.v1` (ids only; HP-5) and `payout-account-change-reported.v1` (HP-2) | New (Hassan 2026-10-08); owner `payments`, consumer C-P; payments 7.2 |
| P-i | `payments` | `dailyTotalsOf(system, {from, to})`: `payments`' own facts (captured, refunded, transferred, reversed, fees, dispute withdrawals); C-P computes the instants and maps the facts to its chart of accounts | Ruled, Ali PC |
| S-c | `sellers` | `accessStatesForPayout` (restricted file; SMR item 2) | Approved SMR |
| — | `sellers` | `sellerSummaries` (zone, provisional flag; display name for admin lists) | Exists |
| S-e | `sellers` | Business-identifier re-check done before payouts: `payoutPrerequisitesOf(system, ids)` → `{businessIdRechecked: boolean}`; a missing answer = `false` | **New; sellers mini-review** (Ali Q-A6: a `sellers` fact) |
| ID-3 | `identity` | `sellerOwnerSecondFactorActive(system, sellerIds)` → boolean per seller (no personal data) | **New; identity mini-review (Mohammad → Hassan → Ali), before C-P slice 5** |
| — | `identity` | `seller-access-suspended.v1`, `-reinstated.v1` | Exists |
| — | `platform` | `MarketConfig.legalEntity` (PL-1), `commissionPayouts` config section (new key, shared-file PR), `Clock`, outbox/inbox, scheduler, advisory lock, audit writer, permission registry | PL-1 pending; section key new |

ADR-0031 decision 5: no placeholder for any `payments` call; slice 5 waits for the real facade.

### 6.2 Public contract
- `CommissionRateSource` implementation (bound at the composition root; boundary rule: only `modules/commission-payouts` implements it, ORD 13).
- No facade for other modules otherwise: the BFF calls C-P's HTTP use cases (5.2) for ORD-02/03 columns.

### 6.3 Events published (ids, enums and instants only; PE 5.3; contracts snapshot test mandatory)
| Type | Payload |
|---|---|
| `commission-payouts.payout-instructed.v1` | `payoutId`, `sellerId` |
| `commission-payouts.payout-status-changed.v1` | `payoutId`, `sellerId`, `status` |
| `commission-payouts.seller-balance-negative.v1` | `sellerId`, `level` (`negative`, `over-cap`, `cleared`) |
| `commission-payouts.statement-issued.v1` | `statementId`, `sellerId`, `payoutId` |
| `commission-payouts.payout-terms-changed.v1` | `scope`, `sellerId` (seller scope), `recordId`, `reasonCode` |
| `commission-payouts.payout-hold-placed.v1` / `-released.v1` | `holdId`, `sellerId`, `sellerOrderId` or absent, `reasonCode` |

No amount, no actor, no personal data. Rate changes publish no event (no consumer, ADR-0015). Hold events carry the exact `reasonCode`; a consumer that shows it to a seller applies the Q-S4 mapping of 5.4.

### 6.4 Events consumed (inbox, `runOnce`, `(event_id, handler)`; stale `aggregateVersion` dropped)
| Event | Effect |
|---|---|
| `ordering.order-paid.v1` | 4.3 `order-paid` |
| `ordering.seller-order-invoiced.v1` | Assessments; tax; `invoice-posted`/`charge-posted`; items |
| `ordering.seller-order-delivered.v1`, `-delivery-corrected.v1` | Anchoring (T1 A, CP-2); a correction places a `DELIVERY_CORRECTED` hold (L3) |
| `ordering.order-line-refunded.v1` | 4.8 |
| `ordering.refund-requested.v1`, `refund-request-closed.v1` (CP-3) | `REFUND_PENDING` holds |
| `payments.transfer-executed/-failed/-reversed.v1`, `payments.transfer-reversal-failed.v1` (Ali PC) | 3.6, 4.11 (`transfer-executed` for a `NOT_SENT` payout = fence breach, `transfer-after-abandon`) |
| `payments.payout-paid/-failed.v1` | Observations, alerts |
| `payments.fee-charged.v1` | 4.9 |
| `payments.dispute-opened/-closed.v1` | 3.7, 4.10 (on close, `disputeOf` re-read and missing postings made, HP-5) |
| `payments.dispute-funds-withdrawn/-reinstated.v1` (HP-5) | `dispute-debited` / `dispute-reinstated` keyed by the case (3.7, 4.10) |
| `payments.payout-account-change-reported.v1` (HP-2) | System `ADMIN_REVIEW` seller hold (idempotent by report id) + admin task (3.5) |
| `identity.seller-access-suspended.v1` | `SELLER_SUSPENDED` hold (idempotent by `decisionId`) |
| `identity.seller-access-reinstated.v1` | Admin notice only |

Not consumed: `order-line-cancelled`, `seller-order-shipped`, `shipment-reversed` (no money effect), `payments.payout-account-changed` (readiness, cooling-off included, is read live at run time). `payments.connected-account-status-changed` no longer exists (Ali PC).

Out-of-order arrival (e.g. invoiced before order-paid is processed, delivered before invoiced): the handler defers (`conflict.retry`, inbox redelivery) until its prerequisite is stored; it never posts on partial knowledge.

## 7. Data ownership (for Mojtaba)
`commission-payouts` owns, in its own schema: commission-rate series and records, payout-terms series and records, journal transactions and entries, commission assessments, settlement items, holds, payouts (+ items, + state history), schedule cursors, dispute cases, recovery actions, provider-fee facts, bank-payout observations, statements and statement sequences, outbox and inbox. Every row carries `market_id` and `tenant_id`; indexes lead with `market_id`. Money `BigInt` + `char(3)`; rates `numeric`, compared numerically; instants `timestamptz` UTC (ADR-0004). Nothing joins another module's tables.

| # | Input |
|---|---|
| PD1 | Journal: transactions (kind, `source_kind`, `source_id`, occurred/posted) and entries (account enum, `seller_id` nullable, side, amount > 0, currency, refs). INSERT and SELECT only. **Balanced per transaction and per currency** enforced in the database (deferred constraint trigger or equivalent, Mojtaba's choice) as well as the domain. Unique (`market_id`, `source_kind`, `source_id`, kind) |
| PD2 | No balance column on any business row; optional derived balance cache per (Market, seller, account) updated in the posting unit, rebuildable, verified nightly (11) — Mojtaba decides whether it is needed for the payout run's read |
| PD3 | Rate records V2 with `EXCLUDE` no-overlap per (Market, scope, seller), correct for open-ended records (L11: an open `valid_to` must give an unbounded range, never `GREATEST(valid_from, NULL)` = an empty one); `rate numeric` CHECK `0 ≤ rate ≤ 0.30`; INSERT plus an update grant on `valid_to` only |
| PD4 | Terms records V2 likewise; typed columns: weekday set (smallint bitmask, non-zero), `local_time`, `hold_days` CHECK `≥ 7 AND ≤ MAX`, minimum amount + currency, approval mode enum. No account or bank column exists |
| PD5 | Assessments: frozen columns write-once (update grant on state and cumulative reversal columns only); TX PD8 columns NOT NULL when `POSTED` (`tax_rule_set_id`, `tax_rate`, `supplier_registered`, `legal_entity_registration_valid_from`, `tax_evaluated_at`); CHECKs cumulative ≤ original; unique (Market, invoice id, line ref) |
| PD6 | Settlement items: `eligible_at` may only decrease and is never cleared (trigger; the monotonic rule in the database, 10; L3); partial index (Market, seller, `eligible_at`) where unpaid |
| PD7 | Holds: content write-once; update grant on release columns only; partial unique (seller, `source_id`) for `SELLER_SUSPENDED`; index active holds by (Market, seller) and (Market, sub-order) |
| PD8 | Payouts: payout id = instruction key; one live payout per item (single `payout_id` + FK, data L5) and **one live payout per seller** (partial unique, L13); state history append-only |
| PD9 | Cursors: one per (Market, seller); index on `next_slot_at` |
| PD10 | Statements immutable (INSERT, SELECT); sequence per (Market, series) gap-free under rollback (ORD PD6 pattern) |
| PD11 | Dispute cases, recovery actions, fee facts, bank-payout observations; unique on the payments ids |
| PD12 | **No personal data**: no names, no emails, no bank data, no tax numbers except the issuer's own (Market config copy on statements, not personal). No free-text notes: reason codes only |
| PD13 | Audit rows of 8 in `platform.audit_log` (ids, codes, before/after of terms and rates; no amounts beyond the record's own values) |
| PD14 | No DELETE grant anywhere in the schema, with one exception (Ali, L7): the platform prune of `outbox` and `inbox` is the only `DELETE` allowed on those two tables (the grant arrives with the platform prune job, as in the other modules) |
| PD15 | Reconciliation read paths: sums per (Market, account, day), per (Market, sub-order) conditional balance |
| PD16 | Migration seeds nothing: the initial Market rate and terms are seeded at boot from Market config by the system seed (11), idempotently |

## 8. Audit (brief s9; IMP-10)
Rows (actor and acting-as when SEL-08 lands; ids and codes only): `rate.set`, `rate.ended`, `payout-terms.set` / `.ended` (before/after of the four fields), `hold.placed` / `.released` (reason, outcome), `payout.approved` (payout ids and approved amounts), `payout.retry-requested`, `dispute.attributed`, `receivable.reversal-commanded`, `.collected-externally`, `.written-off`, `.confirmed` (confirmer, evidence reference code; HP-7), `rate.below-market` (alert signal, Q-S1), `financial-history.viewed` (admin reads of a seller's ledger, VER-14), `seed.applied` (system). System actions that move money (instructions, unwinds) are in the payout state history, not the audit log.

## 9. Idempotency and concurrency
- Consumed events: inbox `(event_id, handler)`; postings unique by source (PD1), so a replay posts nothing twice (AC "duplicate or out-of-order").
- Instruction key = `payout.id`, never reused; `payments` refuses the same key with a different amount (P-a). A retry after `FAILED` is a new payout with a new key.
- Writes to a series, an item or a payout use the version check (`conflict.stale`). Isolation is READ COMMITTED everywhere (ADR-0025; L15): every unit that can block or move a seller's money (payout run, hold placement, delivery correction, attribution, recovery) locks the seller's `PayoutScheduleCursor` first, then payouts, then items in id order (data 5.1); this replaces the `serializable` payout unit.
- A refund reversal and a payout on the same item serialise on the item version: whichever commits second sees the other (reversal after `IN_PAYOUT` posts to the receivable).
- Jobs take a per-(Market, job) advisory lock; a re-run after a crash finds cursors and states and cannot pay twice (AC "re-running the scheduler").

## 10. Where each hard rule is enforced
| Rule | Enforced in | Proved by |
|---|---|---|
| COM-04 frozen rate | Assessments copy ordering's frozen rate; no resolver call after placement | Test: rate 15 % → 20 % between order and invoice (AC 1) |
| COM-05 / Q7 base | `CommissionCalculator` on invoice `net`; charges get commission 0 | AC 2; AU and ZZ |
| Seller share formula; Stripe fee not deducted | `PostingFactory` (`invoice-posted`); fee only in `provider-fee` | Property test: Σ shares + commission + tax = gross; fee test |
| Ledger append-only, balanced | Domain `PostingFactory` + database guard (PD1, PD14) | Grant test; unbalanced insert refused |
| No GST arithmetic here | Only `tax` facade; boundary rule forbids `tax/domain` | Boundary fixture |
| Unknown registration → nothing payable | `AWAITING_TAX` state | Test with empty registration list |
| Hold ≥ 7, max, minimum cap | `PayoutTerms` declaration + DB CHECK + read-time check | Write and read tests in both Markets |
| `eligibleAt` only earlier | `SettlementItem` + DB guard (PD6) | Test: terms 14 → 7 pulls forward; 7 → 14 changes nothing frozen |
| No payout without conditions 1–9 | `EligibilityPolicy`, `PayoutAccessMapping`, payout-run unit re-check | Tests per condition (AC list) |
| `SELLER_SUSPENDED` never auto-released | Hold state machine; reinstated handler only notifies | AC "reinstatement" |
| Access error = no instruction | `PayoutAccessMapping` default deny, whole batch | Fault-injection tests (error, missing key, extra key, `other`) |
| Instructions only from the system worker | Payments command takes `system` only; admin use cases mark only; boundary rule: only the worker module file calls `instructTransfer` | Route-reachability test; boundary fixture |
| No double payment | Unique instruction key, one live payout per item and per seller (L13), `payments`' no-re-send rule and fence (P-d); fence breach posted as `transfer-after-abandon` | Replay, crash and late-success tests |
| Separation of duties | No manual journal use case exists; write-off and external collection need a second admin (HP-7, Q-S3) | Use-case list test; same-admin confirmation refused (domain and data CHECK) |
| Reversal and admin writes bound to the seller and Market (HP-8, HP-15) | Use-case lookups in the context's Market; `payments` seller check; data FK (3.9) | Two-seller and cross-Market tests (byte-identical not-found) |
| No personal or bank data | Event snapshots, PD12, log redaction | Contracts snapshot, redaction test |
| Market and currency | Every repository takes `MarketContext`; `Money` refuses cross-currency | Two-Market tests |

## 11. Jobs (worker role, `Clock`, advisory lock per (Market, job))
| Job | Cadence | Does |
|---|---|---|
| `seed-initial-records` | Boot (per hosted Market) | Seeds the Market rate and terms from config if the series is empty; a hosted Market without config values fails boot |
| `payout-run` | Every 15 min | 4.7 |
| `reconcile-instructions` | Every 5 min | `INSTRUCTING` → `transferByKey` (≤ 100 keys); after `transferSendTimeout` (≥ 2 × the `payments` lease, HP-4) the fenced `abandonTransfer`; after `abandoned`, the quarantine pass ≥ `TRANSFER_ABANDON_QUARANTINE` after `abandonedAt`: a second `abandonTransfer` (live provider list lookup, never `transferByKey`); `NOT_SENT` only on `still-abandoned` (3.6, HP-4 fix 5 as corrected by Hassan's re-check item 5) |
| `retry-commission-tax` | Every 15 min | `AWAITING_TAX` assessments; alert after the configured wait |
| `apply-terms-pull-forward` | On terms change (outbox-driven) | 3.2 |
| `issue-statements` | Every 15 min | 4.12 (gated slice) |
| `daily-reconciliation` | Daily per Market, after local midnight in the Market zone (a platform report, ADR-0005 fallback is acceptable for a Market-level report) | Journal balanced; cash vs `payments.dailyTotalsOf({from, to})` with the day's instants computed here (P-i); conditional per sub-order vs ordering facts; balance cache vs journal; `disputeOf` re-read of open cases, missing `dispute-debited`/`-reinstated` posted (HP-5); `seller-payable` = Σ unpaid items (`UNANCHORED`, `MATURING`; `sale` and `recall`) per seller (Ali CP-R1; data 5.3); alert on any difference |
| `alerts` | Hourly | Long-waiting MANUAL approvals, old holds, `FAILED`/`NOT_SENT` payouts, receivables over cap or aged, held funds near `heldFundsAlertDays`, fee kind `other`, fence breaches |
| `release-delivery-corrected-holds` | Every 15 min | System release of `DELIVERY_CORRECTED` holds at `releaseDueAt` (L3) |
| `held-funds` | Daily per Market | `ADMIN_REVIEW` holds at `heldFundsLimitDays` (4.11; values answered, Q-O1, owner, 2026-10-08) |

## 12. AI (ADR-0019)
None. `commission-payouts` publishes no AI tool, imports nothing of `platform/ai`, and its data never reaches a model (R2; ADR-0019 decision 10: commission, tax, payouts and refunds are rule-based paths). AIS-14 stays forbidden as written. A boundary fixture proves no file of the module imports `platform/ai`. **Reverse path (Hassan HP-17; C-P slice 1):** a `pnpm boundaries` fixture also fails when a file on the `platform/ai` allow-list or any `assistant` file imports a `commission-payouts` contract or HTTP client (or a BFF read carrying commission or payout data).

## 13. Slices, prerequisites and tests

**Prerequisites:** identity (permission registry, admin second factor, `hasRecentConfirmation`, ID-3); sellers S-c (`accessStatesForPayout`) and S-e; `ordering` slices that publish the events and facts (CP-2 to CP-4 included); `payments` G2 facades P-a to P-i (no placeholders, ADR-0031); `tax` slice 5 (commission tax; agent-gated); platform PL-1 (`legalEntity`), the `commissionPayouts` config section (shared-file PR on the board), scheduler and advisory lock; Figma for slice 7 (ADR-0017). The tax agent's written confirmation before slices 3 and 6 and PAY-09 (ADR-0036).

| Slice | Content | Hassan |
|---|---|---|
| 1 | Rate series and records (Market + seller lookup), seed, `CommissionRateSource`, `commission-rate.edit`, audit | yes |
| 2 | Journal, `order-paid`, assessments (`AWAITING_TAX`), `provider-fee` | yes |
| 3 | Commission tax, `invoice-posted`, items (**agent-gated**) | yes |
| 4 | PayoutTerms, resolver, bounds, `payout-terms.edit`, pull-forward | yes |
| 5 | Anchoring, holds, payout run AUTO/MANUAL, instruction, reconciliation, fence | yes |
| 6 | Refunds, disputes, receivable cap and recovery (**refunds agent-gated**) | yes |
| 7 | Admin terms page (with seller rate, COM-02 UI), settlement page, seller view, statements (PAY-09 gated) | yes |
| 8 | COM-06 | yes |

**Tests** (every domain and integration test runs on AU and ZZ; `pnpm verify` offline):
- Money: property tests on conservation (Σ conditional = 0 when all units invoiced/refunded; Σ reversals = originals; payable + in-transit + receivable + paid = seller shares − reversals); AU $11.00 and ZZ ¥1,150 examples; 3 × $3.35 partial invoices; worked examples appended to `test/fixtures/tax/worked-examples/`.
- Eligibility: hold 7 vs 14 days (AC terms A/B); pull-forward only earlier; delivery correction; partial deliveries (T1).
- Schedule: Brisbane, Perth and Sydney (DST forward and back), Tokyo for ZZ; missed slots → one payout; minimum accumulation.
- Payout: every condition of 4.6 blocks with its reason; MANUAL approval bound to amount; `FAILED` then retry with a new key; crash between commit and call; `abandoned` vs `already-sent`; fence breach (`transfer-executed` after `NOT_SENT`) posts `transfer-after-abandon` once; a second live payout for one seller refused (L13); dispute inquiry (`fundsWithdrawn = false`) posts nothing and the dispute fee posts once; delivery correction places `DELIVERY_CORRECTED` and never moves `eligibleAt` later (L3); duplicate events.
- Security (Hassan): IDOR on earnings, statements, terms, holds across seller and Market (byte-identical); every protected key refused without key, without recent confirmation and in acting-as; access mapping default deny (error, missing, extra, `other`); suspension in the residual window; forged event (unknown payout id) changes nothing and alerts; no HTTP route reaches `instructTransfer`, `ratesFor`, `financialFactsOf`, `commissionTax`; contracts snapshot (no amount, no PII); log redaction.
- Boundary fixtures: nobody imports C-P; only C-P implements `CommissionRateSource`; only C-P imports `sellers.payout-access.ts`; no `platform/ai` import; no `tax/domain` import; no `platform/ai` allow-list or `assistant` file imports C-P (HP-17).
- **Hassan's conditions (2026-10-08; log at the end):** quarantine after `abandoned` and a `transferSendTimeout` shorter than the lease (slice 5); Q-S2 re-check: seller suspended between commit and call → `abandonTransfer` tombstone, `NOT_SENT` (slice 5); "this wasn't me" report → `ADMIN_REVIEW` hold, idempotent (slice 5); seller-visible hold mapping (slices 5, 7); reversal of another seller's transfer → not-found (slice 6); every admin write with another Market's id → byte-identical not-found (slices 5, 6); write-off and external collection by one admin refused, journal only after confirmation, evidence code required (slice 6); inquiry → chargeback → won / lost, funds-withdrawn event before and after open, duplicate events (slice 6); seller rate below Market rate alerts (COM-02 slice); every `23xxx` answered generically, no `DETAIL` to a client (HY2, slice 2 onward). **Hassan re-check (2026-10-08):** quarantine pass with a late transfer that `transferByKey` does not yet show → `already-sent`, never `NOT_SENT`, and `payments.unavailable` → still `INSTRUCTING` (slice 5); a support-channel report places the same single hold (slice 5); recall reversal refused without a report hold, posts `transfer-recalled` (slice 6); **Ali CP-R1 condition 7 (slice 6, both fixtures):** recall, then hold release before the old account is closed → `payments.transfer.account-under-review`, `NOT_SENT`; recall, then a replacement account inside its cooling-off → `payments.transfer.cooling-off`; recall with a receivable present → netted; a duplicate `transfer-reversed.v1` → one item only; a partial reversal → one item per reversal; after `NOT_SENT` the item is proposed again and paid once; the first payout with a recall item is `AWAITING_APPROVAL` under AUTO terms; release of a report-sourced `ADMIN_REVIEW` hold refused without the key, without recent confirmation and in acting-as (condition 6); daily `seller-payable` = Σ unpaid items holds after a recall; evidence code reused by a second external collection refused, confirmer's code differing refused, pattern constant equals the CHECK literal (slice 6).

## 14. Deferred
PAY-12 plan profiles (SUB, P2); COM-03; PDF statements (P2); AIS-14 (needs an ADR); multi-currency settlement (ADR-0002); a seller-requested payout; automatic customer refunds for never-onboarded sellers (15 Q-O1: no automatic refund, owner answer staged 30/60/90).

## 15. Open questions
**For Ali (cto)** — ruled 2026-10-08 (Ali PC):
- Q-A1 Closed: T1 A and T2 A accepted through the ordering mini-review (CP-2, CP-3, CP-4, OP-1: Hadi → Mohammad → Mojtaba (CP-4) → Hassan → Ali; before C-P slice 5 and ordering slice 7).
- Q-A2 Closed: chart of accounts and receivable model kept; P-i delivers `payments`' own facts and C-P maps them (6.1).
- Q-A3 Closed: P-a to P-i as ruled (6.1; `docs/design/domain/payments.md` 4.7, 7.1).
- Q-A4 Closed: one shared-file PR per module section (`commissionPayouts` here; `PaymentsPolicy` separately), board-announced, no core defaults, both fixtures, `heldFundsLimitDays` upper bound 90. Mohammad specifies, Hossein builds, Kazem reviews.
- Q-A5 Closed: mini-reviews: identity (ID-3, ID-P1) Mohammad → Hassan → Ali before payments slice 4 and C-P slice 5; tax (TX-C1) Hadi row → Mohammad → Hassan → Ali, agent-gated, before C-P slice 7; sellers (S-e, S-P1) through the sellers chain.
- Q-A6 Closed: a `sellers` fact (not Stripe KYC); a missing answer = `false` (4.6 condition 6).
- Agent gating (Ali PC): slices 3 and 6 and PAY-09 wait for the tax agent's written confirmation (13).
- **CP-R1 Answered (Ali, Ali ruling CP-R1 2026-10-08, 2026-10-08):** `transfer-recalled` confirmed; in the same unit a `SettlementItem` of kind `recall` is created and paid by the normal payout run to the seller's current account through every gate; both draft options below rejected. Written into 2.1, 3.4, 3.5 (hold release, condition 6), 4.2, 4.6/4.7 (conditions 3, 4), 4.11 (condition 2), 4.12 (condition 8), 11, 13 (condition 7); `payments` condition 5 in `docs/design/domain/payments.md` 4.7 and 6.5; data in `docs/design/data/commission-payouts.md` 3.6, 3.9, 5.3 (specified, not measured; slice 6 migration). Hassan re-checks conditions 5 and 6 with HP-1 before payments slice 5 and C-P slice 6 code. Draft as it stood: money recalled from a hijacked account sits in `seller-payable` without settlement items. Proposal: the recall frees nothing; once the report hold is released and the seller's new account is ready, the next payout run adds the un-itemised payable to the seller's payout (one live payout per seller, L13), with its own posting reference. Alternative: an admin-commanded payout of that amount. Ali rules; Mojtaba checks the data effect.
**For Hassan (security-tester):**
- Q-S1 The five new protected keys (rate edit, retry, dispute attribution, recover, write-off).
- Q-S2 The residual window of 4.7 as documented, now closed in the unit by the cursor lock (L15, data HL4); whether to re-call `accessStatesForPayout` immediately before `instructTransfer` as well.
- Q-S3 Two-person confirmation for `receivable.write-off` (and for `payout.approve` above an amount).
- Q-S4 Seller-visible hold reason codes (does `SELLER_SUSPENDED`, `DISPUTE` or `DELIVERY_CORRECTED` show as such, or only `on-hold`; data HL3).
- Data items for Hassan (Mojtaba notes 2026-10-08): two-person write-off CHECK (HL1), deferred-trigger error messages naming ids and amounts (HL2).
- **Answered 2026-10-08** (Hassan payments and commission-payouts review 2026-10-08, approved with conditions): Q-S1 accepted (+ below-Market-rate alert, 5.1); Q-S2 cursor lock accepted + re-check before instruction (4.7 step 5); Q-S3 write-off yes, extended to external collection (HP-7), no second approver for `payout.approve` (4.11); Q-S4 mapping (5.4); HL1 to HL4 as these; HL2 = HY2 (generic codes, no `DETAIL` to clients, terse server logs). Where each item sits: log at the end.
**For Hadi (product), values, no owner decision needed:** Q-H1 `MAX_COMMISSION_RATE = "0.30"` (code constant, Ali PC) and Q-H3 `MAX_HOLD_DAYS = 60` (Ali PC): applied. Q-H2 AU default terms Tuesday 10:00 seller-local, hold 7, minimum A$50, AUTO (Ali PC "Values for Hadi"): applied in 4.4 as AU Market config; **Hadi's confirmation still to be recorded** (Hadi G2 decisions 2026-10-08 of 2026-10-08 covers ordering and tax only).
**Tax agent (AG list additions):** Q-T1 commission rounding per invoice line; Q-T2 platform-borne refund: the seller keeps the full share while the customer adjustment note reverses the line GST; Q-T3 commission and commission GST on a dispute recovery; Q-T4 the commission statement as tax invoice and its adjustment for reversals.
**For the owner (through Hadi; business or legal decisions) — all five pending; not decided here:**
- Q-O1 Money held for a seller who never finishes onboarding. **Answered (owner, 2026-10-08, Q-O1): staged 30/60/90: day 30 new sales stop; day 60 admin outreach and an `ADMIN_REVIEW` hold; day 90 the lawyer decides; the platform never keeps the money; the 90-day bound is our policy pending the lawyer** Affects 3.5, 4.11, 11.
- Q-O2 **ANSWERED (owner, 2026-10-08): yes, the seller keeps the full share; the platform bears the whole refund (GST to the tax agent, Q-T2).** Affects 4.8.
- Q-O3 **ANSWERED (owner, 2026-10-08, Q-O3): the cap is AU Market config `{amount: 50000, currency: "AUD"}` (A$500); the ZZ fixture value is `{amount: 70000, currency: "JPY"}` (Hadi payments and commission-payouts decisions 2026-10-08); no core default; exceeding it gives an alert to the admin and the admin follow-up list only, with no automatic sales stop.** Affects 4.11.
- Q-O4 **ANSWERED (owner, 2026-10-08): the seller's share only; the platform loses its commission on that sale.** This replaces the draft's recommendation (full disputed amount). Affects 3.7, 4.10.
- Q-O5 (new, Ali CP-R1, 2026-10-08; owner and lawyer decision; **not blocking C-P slice 6**): money Stripe already paid out from the hijacked connected account to the attacker's bank cannot be recalled. Who bears that loss, the platform or the seller? **ANSWERED (owner, 2026-10-08, Q-O5): case by case; an admin decides each case with the lawyer's advice; a fixed rule later needs the lawyer.** Until decided nothing is taken from the seller and nothing is posted for it, and the ledger shows the seller as already paid by the original `transfer-settled`. Hadi raises it with the owner. Affects 4.11.
- Ali PC: the 90-day upper bound behind the 30-day cap is our policy pending the lawyer.

## 16. Review record
| Date | Reviewer | Verdict | Applied |
|---|---|---|---|
| 2026-10-08 | — | Draft; awaiting Mojtaba, Ali, Hassan | — |
| 2026-10-08 | Mojtaba (`docs/design/data/commission-payouts.md`) | Data design written; findings L1 to L16 | L3, L11, L13, L14, L15 accepted and applied here (reconciliation log); L7 ruled by Ali |
| 2026-10-08 | Ali (Ali payments and commission-payouts review 2026-10-08) | Approve with changes | Dispute-fee double count fixed, payments' refusal codes, `transfer-reversal-failed.v1`, fence breach, P-a to P-i, Q-A1 to Q-A6, values (reconciliation log) |
| 2026-10-08 | Hassan (Hassan payments and commission-payouts review 2026-10-08; mandatory, tier A) | **Approved with conditions** | Conditions written in (security conditions log); Hassan re-checks HP-1, HP-4, HP-8, HP-9 before C-P slice 5 code |
| 2026-10-08 | Ali (Ali ruling CP-R1 2026-10-08) | CP-R1 ruled: `recall` settlement item paid by the normal run | Conditions 1 to 8 written in (2.1, 3.4, 3.5, 4.2, 4.6, 4.7, 4.11, 4.12, 11, 13; `payments` 4.7, 6.5); Q-O5 added; data with Mojtaba (specified, not measured; slice 6 migration) |
| 2026-10-08 | Owner (Q-O1 to Q-O5, through Hadi;) | Answered: Q-O1 staged 30/60/90; Q-O2 seller keeps full share; Q-O3 A$500, alert and list only; Q-O4 seller's share only; Q-O5 case by case | 3.5, 4.8, 4.10, 4.11, 11, 15 |

## Reconciliation log (2026-10-08)
Mohammad, with Mojtaba's `docs/design/data/commission-payouts.md` open. Inputs: Ali payments and commission-payouts review 2026-10-08 (Ali PC), Mojtaba notes 2026-10-08, commission-payouts design notes 2026-10-08, payments design notes 2026-10-08, Hadi G2 decisions 2026-10-08.

| Item | Applied where / how |
|---|---|
| Ali PC BUG dispute fee counted twice | 4.2 `dispute-debited` (disputed amount only, `dispute-loss` / `platform-cash`, only when `fundsWithdrawn`) and `provider-fee` (dispute fee only path); 3.7; 4.9; 4.10; 13 tests |
| Ali PC payments' refusal codes (`payments.transfer.cooling-off`; `RESTRICTED` → `account-not-ready`) | 3.6 `INSTRUCTING → NOT_SENT`; 4.6 condition 4 |
| Ali PC Stripe 4xx at creation = synchronous refusal; `transfer-failed` only post-creation | 3.6 (two rows), 6.1 P-a, P-g |
| Ali PC consume `transfer-reversal-failed.v1` | 4.11 (action `FAILED`, netting), 6.1 P-g, 6.4 |
| Ali PC fence breach (debit `seller-receivable`, credit `platform-cash`, alert, netting) | 3.6 text, 4.2 new kind `transfer-after-abandon`, 6.4, 10, 11 `alerts`, 13 |
| Ali PC lost-dispute recovery per Q-O4 | 4.10 answered by the owner (Q-O4: seller's share, not gross); 15 |
| Ali PC agent gating (slices 3, 6, PAY-09) | 15 (Ali) note; unchanged in 13 |
| Ali PC facade contract P-a to P-i | 6.1 rows rewritten to `payments`' names; 3.6; 4.7 step 5 (`instructionKey`, `reference`, no description); 4.9 (`feeChargesOf`, kind names); 4.10 (`disputeOf`, `fundsWithdrawn`); 4.11 (P-b `transferExecutionId`, `reasonCode`); 11 (`transferByKey`, `dailyTotalsOf`) |
| Ali PC `connected-account-status-changed.v1` dropped | 6.4 |
| Ali Q-A1 to Q-A6 | 15 (all closed); 4.6 condition 6 (Q-A6: missing answer = false); 4.4 and 4.11 (Q-A4: no core defaults, both fixtures, `heldFundsLimitDays` ≤ 90); 6.1 ID-3 route |
| Ali values (Q-H1, Q-H2, Q-H3) | 2.1 (`MAX_COMMISSION_RATE "0.30"`, `MAX_HOLD_DAYS 60`, `MIN_HOLD_DAYS 7`: platform-wide constants, not Market values); 4.4 (AU `initialPayoutTerms`: TUE 10:00 seller-local, hold 7, `{5000, AUD}`, AUTO, as Market config, never an AU branch); 15 (Hadi's confirmation to be recorded) |
| Owner Q-O1 to Q-O5 | Answered owner, 2026-10-08, owner answers 2026-10-08: 3.5, 4.8, 4.10, 4.11, 11, 15 now state the answers |
| Mojtaba L3 (`eligibleAt` strictly monotonic; `DELIVERY_CORRECTED` hold) | 2.1 (`SettlementItem`, `PayoutHold` reasons), 3.4 row replaced, 3.5 placement and release, 4.5 condition 3, 6.4, PD6, 11 new job, 13 |
| Mojtaba L11 (open-ended V2 EXCLUDE) | 2.1 `CommissionRateSeries`; PD3 |
| Mojtaba L13 (one live payout per seller) | 2.1 `Payout`, 3.6, 4.7 step 4, PD8, 10 |
| Mojtaba L14 (`<=` on the commission reversal range) | 2.2 `ReversalCalculator`, 4.8; `docs/design/data/tax.md` 10.2 CHECK changed to `<=` |
| Mojtaba L15 (cursor lock instead of serializable) | 4.7 step 4 and residual window, 9, 15 Q-S2 |
| Ali L7 (prune exception) | PD14 |
| **Left open** | Q-H2 confirmation (Hadi); Q-S1 to Q-S4, HL1 to HL4 (Hassan); TX-C1, ID-3, S-e, CP-2 to CP-4 mini-reviews (as routed in 15); Q-T1 to Q-T4 (tax agent) |

## Security conditions log (Hassan, 2026-10-08)
Mohammad, from Hassan payments and commission-payouts review 2026-10-08 (verdict: approved with conditions). Gates as Hassan's section 5. Items owned only by `payments` are listed in `docs/design/domain/payments.md`'s log; here only those C-P carries or depends on.

| Item | Where in this document | Gating slice |
|---|---|---|
| HP-1 (High) F-3 gate, pre-transfer live check | `payments` 4.6; here 4.6 condition 4 unchanged (`payments.transfer.cooling-off` mapped as given) | Hassan re-check before **C-P slice 5 code** |
| HP-2 "this wasn't me" consumer | 3.5 (`ADMIN_REVIEW` from `payout-account-change-reported.v1`); 6.1 P-j; 6.4 | C-P slice 5 (event owner `payments`, slice 4) |
| HP-4 fix 3 timeouts, fix 5 quarantine | 3.6; 11 `reconcile-instructions` | Re-check before C-P slice 5 code; built in slice 5 |
| HP-5 dispute funds after opening | 3.7; 4.2 `dispute-debited`; 4.10; 6.1 P-j; 6.4; 11 `daily-reconciliation` | C-P slice 6 / payments slice 7 |
| HP-6 one definition of "protected" | 5.1 | Gate (identity/authz); applies from C-P slice 1 |
| HP-7 external collection two-person | 4.2; 4.11; 5.2 (`confirm-recovery-action`, owner C-P); 5.4; 8; 10; data 3.9 | C-P slice 6 |
| HP-8 reversal bound to the seller | 4.11; 5.2; 6.1 P-b; 10; data 3.9 | Re-check before C-P slice 5; built in C-P slice 6 (payments slice 5) |
| HP-9 transfer ceiling | `payments` 4.7 (refusal `payments.transfer.amount-out-of-range`, mapped as given → `NOT_SENT`) | Payments slice 5 |
| HP-15 Market scoping of admin writes | 5.2 | C-P slice 5 (`request-payout-retry`), slice 6 (others) |
| HP-17 reverse AI import | 12; 13 | C-P slice 1 |
| Q-S1 five protected keys; below-Market-rate alert | 5.1; 8 | Each key's slice; alert with `set-seller-rate` (COM-02) |
| Q-S2 re-check before instruction; cursor lock | 4.7 step 5 and residual window | C-P slice 5 |
| Q-S3 two-person write-off; none for `payout.approve` | 4.2; 4.11; 5.2 | C-P slice 6 |
| Q-S4 seller-visible hold reasons | 5.4; 6.3 | C-P slice 5 (blocking reasons), slice 7 (seller view) |
| HY2 / HL2 error messages | 13 (test); `payments` 6.5 (shared rule) | From C-P slice 2 (first deferred trigger) |
| HP-10, HP-2 live mode | `payments` 4.11 | Live mode (C-P unaffected) |
| C1 audit columns in the hash chain; acting-as refusal of elevation | ADR-0038 A3, A4 (C-P has no elevation entries, 2.3) | Elevation PR |
| Still owed elsewhere | ID-3 mini-review (4.6 condition 5) | Before C-P slice 5 |

### Re-check items applied (Hassan, Hassan re-check 2026-10-08, 2026-10-08)
Mohammad, with Mojtaba for `docs/design/data/commission-payouts.md`. Only the items C-P carries or depends on; the rest is in `docs/design/domain/payments.md`'s log.

| Re-check item | Where in this document (data) | Gating |
|---|---|---|
| 1 Support entry emits the same `payout-account-change-reported.v1` | 3.5 (unchanged consumer: one `ADMIN_REVIEW` hold per report id, whatever the channel) | C-P slice 5 |
| 2(b) Recovery of a hijacked account's balance: `command-transfer-reversal` with reason `payout-account-compromised`, posting `transfer-recalled` | 4.2; 4.11; 5.2; 5.4 (data 3.3 kind, 3.9) | C-P slice 6; CP-R1 answered by Ali (next row) |
| 4 Evidence code: partial unique index; confirmer re-enters the code; one literal | 5.2; 5.4 (data 3.9) | C-P slice 6 (W6), not blocking |
| 5 HP-4 quarantine pass = second `abandonTransfer` (live provider list lookup), never `transferByKey`; `NOT_SENT` only on `still-abandoned` | 3.6; 11 `reconcile-instructions`; 13 | **C-P slice 5 code** |
| Ali CP-R1 (Ali ruling CP-R1 2026-10-08): `recall` item (1), posting from C-P's own reason code (2), payment path (3), forced approval (4), `payments.transfer.account-under-review` mapped as given (5), protected release of a report-sourced hold (6), tests (7), statement wording (8); Hassan HP-1 close-out: a `support` report is never `owner-confirmed` (`payments` side) | 2.1; 3.4; 3.5; 3.6; 4.2; 4.6; 4.7; 4.11; 4.12; 5.4; 11; 13; 15 (data 3.6, 3.9, 5.3) | C-P slice 6; Hassan re-checks conditions 5 and 6 with HP-1 before payments slice 5 and C-P slice 6 code |
