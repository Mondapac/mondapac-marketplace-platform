# Physical data model — `ordering` schema (G2)

**Author:** Mojtaba (database-designer) — 2026-10-08
**Status:** **G2 data design approved with conditions 2026-10-08 (Ali, Hassan).** Revised the same day to apply every item of Mojtaba change list 2026-10-08 (A1 to A18; cited "todo A*n*"), Hassan's review (Hassan review 2026-10-08, O-1 to O-10) and Ali's rulings (Ali G2 review 2026-10-08 sections 6 and 7: D-1, T8, A1 to A4, M3), consistent with the final domain design (`docs/design/domain/ordering.md`, **D**). Every changed constraint was re-measured on PostgreSQL 16 (10.2). Conditions carried from the domain G2: Hassan re-checks the guard functions, grants and hashes at code time (O-4, O-5, O-6, A18); the reason-code lists (O6) and the open points of 11.5 are settled before the migration that needs them. Each migration still needs my sign-off. Ali's G2 rulings (Ali G2 review 2026-10-08, cited as "Ali G2-n" for section 1 and "Ali T1..T6" for the ordering rulings) are applied. Final edits the same day (10.3): the `ordering.reconcile-first-sales` plan (6.5 Q24, 9.3), refund `review` → `failed` (D 3.5, OD-data F13) in M4's CHECKs and trigger, F14 confirmed as stored, and Hadi's closed reason-code lists (Hadi G2 decisions 2026-10-08 item 2) in the CHECKs (O6). Review record: section 13.
**Ground truth:** `docs/design/domain/ordering.md` (Mohammad's G2 domain design, cited as **D**, for example "D 3.3"; inputs PD1 to PD18 in D 7); `docs/modules/ordering/brief.md` (G1 approved 2026-10-08; cited as "brief s5", "Q6", "AC n"); `docs/design/domain/tax.md` (**TX**; its PD3 and PD7 are owned here); ADR-0035 draft (ADR-0035, accepted with changes by Ali); `docs/design/data/platform.md` (roles and grants 10.2, prepared statements 10.9); `docs/design/data/identity.md` (**ID-data**, conventions C1 to C11), `sellers.md` (**SL-data** 4: encryption and ciphertext bounds), `pricing.md` (**PRC-data**: money P1, write-once P5, no-delete P6, statement order P7), `inventory.md` (**INV-data**). ADR-0003, 0004 (decisions 3 to 7), 0005, 0006, 0007 (decisions 1, 2, 8, 10, 11), 0009 (V3, V4, decision 6), 0018 (decision 6), 0020 (decision 6), 0025, 0028 (decision 12).
**Prisma models:** `prisma/schema/ordering.prisma` (new). Nothing exists yet. This document is the specification the migrations are written from.
**Business rules:** none changed. Where the mapping needed a choice that D does not make, or where I recommend a change to D, it is a finding for Mohammad in 11.1. Six of them change D's text (F1 to F6 below).

## 1. Scope and table list

This is the physical design of everything D asks the database to hold: tables, constraints, access paths, locking, encryption columns, grants, the migration plan, volume and retention. It covers PD1 to PD18 and the tax answers that `ordering` freezes (TX PD7) and reads (TX PD3).

ADR-0009 patterns: **V3** (snapshot) for the order, sub-order, line, charge and invoice content, written once and never updated. **V4** (append-only) for the three status histories and for every child record of a counter operation (cancellations, shipments, reversals, delivery marks, corrections, invoices and their lines). Nothing is V1 or V2.

| Table | Holds (D 2.1) | Pattern | Migration (8.1) / slice (brief s11) |
|---|---|---|---|
| `ordering.outbox`, `ordering.inbox` | Events (ADR-0006) | Queue | M1 / 2 |
| `ordering.checkouts` | `Checkout`: the Saga's stored state | Live root, write-once ids | M1 / 2 |
| `ordering.checkout_status_history` | Checkout transitions, including the admin's `REVIEW` resolutions | V4 (rows leave only with a pruned root) | M1 / 2 |
| `ordering.orphan_facts` | Orphan payment and refund facts and money events seen in `REVIEW` or after a terminal state (D 3.3, 3.5, PD19; todo A13) | V4 + one write-once resolution | M1 / 3 and 7 |
| `ordering.orders` | `Order` with the snapshot header | V3 + status | M1 / 2 |
| `ordering.order_status_history` | Order transitions | V4 | M1 / 2 |
| `ordering.seller_orders` | `SellerOrder` with its seller snapshot and derived status | V3 + derived columns | M1 / 2 |
| `ordering.seller_order_charges` | The flat shipping fee and its frozen tax (F6) | V3 | M1 / 2 |
| `ordering.order_lines` | `OrderLine` snapshot and quantity counters | V3 + counters | M1 / 2 |
| `ordering.seller_order_history` | One row per counter operation | V4 | M1 / 2 |
| `ordering.invoice_sequences` | `InvoiceSequence`: gap-free counter per (Market, seller, series) | Counter | M2 / 5 |
| `ordering.invoices`, `ordering.invoice_lines` | `Invoice` and adjustment notes | V3, V4 | M2 / 5 |
| `ordering.shipment_applications`, `ordering.shipment_application_lines` | `ShipmentApplication` | V4 | M3 / 6 |
| `ordering.shipment_reversals` | `ShipmentReversal` | V4 | M3 / 6 |
| `ordering.line_cancellations` | `LineCancellation` | V4 | M4 / 7 |
| `ordering.refund_requests`, `ordering.refund_request_lines` | `RefundRequest` | V3 content + state | M4 / 7 |
| `ordering.delivery_marks`, `ordering.delivery_mark_lines`, `ordering.delivery_mark_corrections` | `DeliveryMark` and its correction | V4 | M5 / 8 |
| `ordering.saved_addresses` | `SavedAddress` (Ali T6: option A, its own slice after slice 3) | Live | M6 / address-book slice |

**Not created** (D 7 lists them; 11.1 has the reasons):
- `idempotency_keys` (PD4): placement idempotency is a unique key on `checkouts` (F2). Seller and admin operations carry their keys on their own rows (9.3).
- Throttle counters: the platform limiter holds them (PL-1). If the platform limiter is not ready for slice 2, the table comes with that slice under platform's design, not here.

Every table carries `market_id` and `tenant_id`, so the guard of P 4 needs no exemption line. `platform.audit_log` is unchanged.

### 1.1 ER sketch

FK means a composite foreign key that leads with `market_id` (C3). A dotted line is a plain id with no FK (C4).

```
 checkouts ── UNIQUE (market_id, order_id) ; (market_id, order_id, customer_account_id) ; (market_id, order_id, payment_id)
     |  1                                         ...... customer_account_id: identity ; reservation_id: inventory ; payment_id: payments
     |  FK orders (market_id, id, customer_account_id) -> checkouts (market_id, order_id, customer_account_id)
     |  FK orders (market_id, id, payment_id)          -> checkouts (market_id, order_id, payment_id)
     v  0..1
 orders ── UNIQUE (market_id, id, currency, customer_account_id)
     |  1
     |  FK (market_id, order_id, currency, customer_account_id)
     v  1..n
 seller_orders ── UNIQUE (market_id, order_id, seller_id) ; (market_id, id, currency) ; (market_id, id, seller_id)
     |  1                     ...... seller_id: identity/sellers
     +──< seller_order_charges   FK (market_id, seller_order_id, currency)
     +──< order_lines            FK (market_id, seller_order_id, currency)   UNIQUE (market_id, id, seller_order_id)
     |        ...... offer_id, variant_id, product_id, product_revision_id: catalog ; price_record_id: pricing ;
     |               commission_rate_record_id: commission-payouts ; reservation_line_id: inventory
     +──< line_cancellations          FK line (market_id, order_line_id, seller_order_id)
     +──< shipment_applications ──< shipment_application_lines ; ──0..1 shipment_reversals
     +──< delivery_marks ──< delivery_mark_lines ; ──0..1 delivery_mark_corrections
     +──< refund_requests ──< refund_request_lines (line positions; charge cumulative range, no EXCLUDE: 3.12)
     +──< invoices ──< invoice_lines (EXCLUDE on unit positions per line; EXCLUDE on cumulative range per charge)
              adjusts_invoice_id ──> invoices (same seller)
 seller_order_charges ── UNIQUE (market_id, id, seller_order_id, tax_gross_minor)
     <── FK (market_id, charge_id, seller_order_id, charge_gross_minor) from invoice_lines and refund_request_lines
 invoice_sequences (market_id, seller_id, series)        no FK
 checkout_status_history, order_status_history, seller_order_history   FK to their root
 orphan_facts (market_id, event_id) UNIQUE               no FK (ids of payments' events; order_id plain)
 saved_addresses (market_id, customer_account_id, slot) UNIQUE         no FK
 outbox, inbox                                                          as in every module
```

## 2. Conventions

ID-data C1 to C10 and PRC-data P1, P5, P6, P7 apply unchanged. Not repeated in the column tables: the `market_id`/`tenant_id` columns and CHECKs. What `ordering` adds:

| # | Convention |
|---|---|
| O1 | **Money** as PRC-data P1: `<name>_minor bigint` with CHECK `BETWEEN 0 AND 9007199254740991` (zero allowed: a fee may be an explicit zero (AC 14), a tax may be zero). A unit price is `BETWEEN 1 AND …`. **One `currency char(3)` per row**, never one per amount: every amount on a row is in that currency. The currency is written once on `orders` from the Market's currency. Each child proves equality by a foreign key that includes `currency` (`seller_orders` → `orders`; lines and charges → `seller_orders`; invoices, refund requests → `seller_orders`). An order in two currencies cannot be stored (ADR-0007; D 2.1 "exactly one currency") |
| O2 | **Rates** (`tax_rate`, `commission_rate`): `numeric` without precision, CHECK `BETWEEN 0 AND 1 AND scale(x) <= 6` (TX `TaxRate`: at most 6 decimals, at most 1). Exact decimals as returned. Never `float` |
| O3 | **Copies are proved** (INV-data C3): `customer_account_id`, `currency`, `payment_id`, `seller_id` and `seller_order_id` copies sit in the foreign key, so the database proves they equal the parent's value. Each needs a wider unique key on the parent. The cost is listed per table |
| O4 | **Snapshot columns are never updated.** Three layers, as PRC-data P5: the column-level `UPDATE` grant names only status, counter and write-once columns (7); a `BEFORE UPDATE` guard trigger refuses any change to snapshot or written-once columns for every role, the owner included (`23001`); CHECKs tie written-once columns to the states that need them |
| O5 | **Append-only tables:** `SELECT, INSERT` grant only, and the trigger function `ordering.reject_mutation()` on `BEFORE UPDATE OR DELETE` (row) and `BEFORE TRUNCATE` (statement), so the owner gets `23001` too (measured on `invoices`, 10). Used on invoices, invoice lines, histories and every V4 child |
| O6 | **States and codes** are lower-case kebab `text` with a closed CHECK (`pending-payment`, `awaiting-payment`); the repository maps them to D's names. Every value a later slice needs is in the CHECK from the table's first migration. **Reason codes are closed lists in the database too** (Hassan O-5; todo A10): each reason column (`line_cancellations.reason_code`, `refund_requests.reason_code` and `loss_reason_code`, the resolution codes of `refund_requests`, `orphan_facts` and the checkout review, `shipment_reversals.reason_code`, `delivery_mark_corrections.reason_code`) has a CHECK `IN (…)` whose list equals the checked-in list in `modules/ordering/domain/reason-codes.ts`; a `pnpm test:db` catalog test compares the two. A new code is a `NOT VALID` CHECK swap (8.2). The lists themselves are Hadi's (Hadi G2 decisions 2026-10-08 item 2, 2026-10-08; table O6a below; the remaining ones in 11.5 Q1). Considered and not chosen: a reference table `ordering.reason_codes (purpose, code)` with composite FKs: no migration per new code, but a `purpose` column on every row and a seed to keep in step; the lists are short and change rarely. History rows copy the code with the pattern CHECK `^[a-z][a-z0-9-]{0,63}$` only (they hold codes of several lists) |
| O6a | **The closed lists** (Hadi item 2; no free text, extra detail in the ticket system). Column → CHECK → values: `line_cancellations.reason_code` → `line_cancellations_reason_code_check` → `out-of-stock`, `damaged`, `cannot-deliver-to-area`, `price-error`, `customer-requested`, `other`. `refund_requests.reason_code` → `refund_requests_reason_code_check` → `not-received`, `damaged`, `wrong-item`, `not-as-described`, `seller-cancelled`, `other`. `delivery_mark_corrections.reason_code` → `delivery_mark_corrections_reason_code_check` → `marked-in-error`, `carrier-reports-not-delivered`, `customer-reports-not-received`. `shipment_reversals.reason_code` → `shipment_reversals_reason_code_check` → `shipped-in-error`, `carrier-rejected`, `lost-before-handover`. Checkout `REVIEW` resolution (the `reason_code` of the `checkout_status_history` row leaving `review`, 3.2) and `orphan_facts.resolution_reason_code` → `orphan_facts_resolution_reason_code_check` → `handled-at-provider`, `provider-refunded`, `duplicate-event`: both are resolved under `ordering.checkout-review.resolve` (D 3.3 "closed the same way", D 5.3), so they share Hadi's checkout-review list (confirmed by Hadi, Hadi payments and commission-payouts decisions 2026-10-08 (c) 3). The history row's code stays pattern-only in the database (O6); the use case validates it against the list and the audit row carries it. `refund_requests.loss_reason_code` → `refund_requests_loss_reason_code_check` → `platform-error`, `carrier-loss`, `seller-unrecoverable`, `fraud-loss`, `goodwill`, `other` (Hadi (c) 1, 2026-10-08; set only when `loss_bearer = 'platform'`, the existing pair CHECK; a high `other` rate is a monthly-review signal). `refund_requests.resolution_reason_code` → `refund_requests_resolution_reason_code_check`, as `(state, code)` pairs (Hadi (c) 2): `succeeded` with `refund-confirmed-at-provider` or `matched-manually`; `failed` with `refund-failed-at-provider` or `no-refund-found`; separate from the checkout-review list. Every code is lower-case kebab (`^[a-z][a-z0-9-]{0,63}$`) |
| O7 | **Encrypted columns** are `<name>_ciphertext text`, under `SubjectKeyService` (PF 4) with a label per column (5). CHECK as SL-data 4.5: `~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$' AND char_length BETWEEN 41 AND <bound>` |
| O8 | **No free text** (Hassan O-5; todo A10). No column holds user-entered prose: cancellations, refunds, reviews and corrections carry reason codes only (O6). A future note needs a mini-review and is encrypted under the customer subject. The saved-address label moves inside the encrypted address value (3.13) |
| O9 | **IANA zones** (`delivery_zone`, `seller_zone`, `issue_zone`): CHECK `^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$` (INV-data 3.3); existence is checked by the application through Temporal |
| O10 | **Who-did-it columns** (`actor_account_id`, `requested_by_account_id`) are plain ids without FK (ID-data C4). `actor_kind` CHECK `account`, `system`; CHECK `(actor_kind = 'account') = (actor_account_id IS NOT NULL)`. The acting-as column arrives with SEL-08 (metadata-only `ADD COLUMN`, 8.2) |
| O11 | **Isolation: READ COMMITTED everywhere** (D 9; ADR-0025). Every cross-row rule is carried by a unique key or by a row lock taken as the unit's first statement (6). No unit needs `serializable` (6.3). Read-only use cases (lists, detail, `financialFactsOf`, `turnoverOf`) open no transaction (ADR-0025 decision 1) |
| O12 | **Prisma model names** start with `Ordering` (`OrderingCheckout`, `OrderingOrderLine`), tables mapped with `@@map` (ID-data C9) |
| O13 | **No Market value in a CHECK** (INV-data C6): the line ceiling, `maxSavedAddresses`, the reservation duration, `closeAfter`, `shipmentReversalWindow`, `recipientVisibleFor`, the invoice retention period and the refund target time are configuration. A CHECK carries only rules that hold in every Market |
| O14 | **Shape CHECKs count NULLs explicitly** with `num_nonnulls(...)` / `num_nulls(...)`. A comparison with a NULL column is NULL and a CHECK passes on NULL, so `quantity >= 1` alone accepts a missing quantity (measured: an invoice line without quantity and a refund line without kind were both accepted before this rule, 10.2). Each "this kind of row has these columns" CHECK names its columns in a count first |
| O15 | **Hashes are `ContentHash` text** (`docs/design/domain/platform-audit.md` 6.3, as SL-data and certification): `text` with CHECK `^hmac-sha256:[0-9a-f]{64}$` for a hash whose input holds a personal field (`SubjectKeyService.hmac`, PF 4 row 4: HMAC-SHA-256 untruncated, a key derived from the subject's data key per purpose), and `^sha256:[0-9a-f]{64}$` for one whose input holds none. **No unkeyed hash over a personal field** (Hassan O-4; todo A8). No key-version column: a subject has one data key for life (`platform.subject_keys` PK; rewrapping changes only the wrapping), so the derived hash key never changes; if PL-3 ever versions it, the `ContentHash` prefix changes and the CHECK with it. A crypto-shredded subject leaves a hash nobody can verify, which is intended |
| O16 | **Trigger functions** (todo A18; H4 accepted by Hassan): `SECURITY INVOKER`, `SET search_path = pg_catalog, pg_temp` in the definition, every table name schema-qualified (`"ordering"."checkouts"`), no grant (platform.md 10.2). Measured: all guard functions of 10.2 fire with the pinned path, for the application role and the owner |

## 3. Tables

"Personal" marks personal data. "Identifier" marks a plain id that points at a person. Constraint and index names are the exact database names.

### 3.1 `ordering.outbox` and `ordering.inbox` (M1)

The identity tables with the module name changed (ID-data 3.1, 3.8): `outbox_type_check` `^ordering\.[a-z0-9-]+\.v[1-9][0-9]*$`, `inbox_handler_check` `^ordering\.[a-z0-9-]+$`; unique `outbox_market_id_aggregate_id_aggregate_version_key`; partial `outbox_market_id_event_id_unpublished_idx`; `inbox_pkey (event_id, handler)`.
- Aggregate types: `order` (`order-paid`), `seller-order` (six events of D 6.4), `refund-request` (`order-line-refunded`). `aggregate_version` is the root's new `version` (D 6.4), so the unique key also proves "one event per version step".
- **One version step, one event per aggregate.** A unit that changes a `seller_orders` row twice would need two events with one version. D's units never do. The `cancel-and-refund` request raises the sub-order version once and emits `order-line-cancelled` on `seller-order`, while the refund event later goes on `refund-request`, so they do not collide.
- Payloads hold ids, enums, integers and instants only. No amount, no Cost, no personal data (D 6.4). The database cannot check that; the mandatory contracts snapshot test does.
- Inbox: payments' outcome events, ordering's own events (own handlers), the identity account-erasure event (address-book slice). No `DELETE` until the platform prune job.

### 3.2 `ordering.checkouts` (M1; D 2.1, 3.3, 3.4; PD3, PD14)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK. Also the `checkoutRef` sent to `inventory.reserve` (INV R2: UUIDv7, Ali G2) |
| `customer_account_id` | `uuid` | no | Identifier (C4). Immutable |
| `idempotency_key` | `uuid` | no | The client's key (D 3.3 P0). Immutable |
| `request_hash` | `text` | no | **HMAC** of the canonical request (RFC 8785) under the **customer's** subject: `SubjectKeyService.hmac(market, customerAccountId, 'ordering.checkout.request', bytes)` (O15; Hassan O-4; todo A8). The request holds the delivery address, so a plain hash would be an oracle for it. CHECK `checkouts_request_hash_check` `^hmac-sha256:[0-9a-f]{64}$`. The same request of two customers gives two values (measured). After the customer's erasure a replay cannot be verified; the account is gone, so no replay can arrive |
| `order_id` | `uuid` | no | Generated in P2 before the Order exists (D 2.1). Immutable from insert (so "write-once" holds trivially) |
| `state` | `text` | no | CHECK `started`, `reserved`, `awaiting-payment`, `committing`, `capturing`, `completed`, `rejected`, `voiding`, `releasing-stock`, `cancelled`, `compensating`, `compensated`, `abandoned`, `review` (D 3.3) |
| `review_from_state` | `text` | yes | The state a Checkout was in when it went to `review`. CHECK `checkouts_review_from_state_check`: `(state = 'review') = (review_from_state IS NOT NULL)` and the value is one of the states that can enter `REVIEW` (D 3.3; Hassan O-3, O-7, O-9; todo A14): `reserved`, `awaiting-payment`, `committing`, `capturing`, `voiding`, `releasing-stock`, `compensating` (the money-event rows and the step-budget states). Not `started` (a money event there has no payment id: an orphan fact), not `cancelled` (its money events have their own rows), not a terminal state (F14). It decides whether a reviewed Checkout still holds the customer's slot (F1) and what a re-drive returns to |
| `cause` | `text` | yes | Cancellation cause. CHECK `checkouts_cause_check`: `expired`, `superseded`, `stock-lost`, `seller-unavailable`, `capture-failed`, `payment-mismatch`, `payment-start-failed`, `review-closed` (D 3.1, 3.3; `review-closed` when an admin closes a `REVIEW` item that had no cause, Hassan O-7; todo A15). Written once. CHECK `checkouts_cause_state_check`: required in `voiding`, `releasing-stock`, `cancelled`, `compensating`, `compensated`; NULL in `started` to `capturing`, `completed` and `rejected`; in `abandoned` NULL (the job) or `superseded` (a stale `STARTED` abandoned by a new placement, D 3.3 P2; Ali A3; todo A5); free in `review` (it keeps whatever it had) |
| `reject_code` | `text` | yes | The refusal code of P3 (`inventory.insufficient`, D 3.3). CHECK `^[a-z][a-z0-9.-]{0,95}$`, `(state = 'rejected') = (reject_code IS NOT NULL)`. Reason codes of `inventory.insufficient` are answered to the client and not stored (no stock number is ever stored here, INV 5.4) |
| `reservation_id` | `uuid` | yes | `inventory`'s id (C4). Written once (O4) |
| `expires_at` | `timestamptz(6)` | yes | The reservation's expiry, copied from `inventory` in the unit that stores `reservation_id`. Written once. CHECK `(reservation_id IS NULL) = (expires_at IS NULL)`. Only here, not on `orders` (F3) |
| `payment_id` | `uuid` | yes | `payments`' id (C4). Written once. CHECK `checkouts_payment_check`: NOT NULL in `awaiting-payment`, `committing`, `capturing`, `completed`, `compensating`, `compensated` |
| `attempts` | `integer` | no | Attempts of the current step. CHECK `>= 0`. Reset to 0 on every state change |
| `next_attempt_at` | `timestamptz(6)` | yes | When `ordering.advance-checkouts` may re-drive this row. Set by the repository in every non-terminal state that the job drives (D 3.3 "Timeouts"; `started` gets `created_at` + 2 × reservation duration, the abandon point). NULL in terminal states and `review`. CHECK: NULL when `state IN ('completed','rejected','cancelled','compensated','abandoned','review')` |
| `last_error_code` | `text` | yes | A code, never a message (PE 12.3). CHECK `^[a-z][a-z0-9.-]{0,95}$` |
| `compensation_kind` | `text` | yes | CHECK `void`, `refund`. Written once |
| `compensation_refund_id` | `uuid` | yes | `payments`' refund id for `refundCompensation`. Written once. CHECK: only with kind `refund` |
| `compensation_status` | `text` | yes | CHECK `requested`, `succeeded`, `failed`; CHECK: NOT NULL iff `compensation_kind IS NOT NULL` |
| `version` | `integer` | no | C5 (P 10) |
| `created_at`, `state_changed_at` | `timestamptz(6)` | no | CHECK `state_changed_at >= created_at` |

**Keys and indexes**

| Name | Definition | Serves |
|---|---|---|
| `checkouts_pkey` | `(id)` | Load by id (every Saga step and handler) |
| `checkouts_market_id_customer_account_id_idempotency_key_key` | unique `(market_id, customer_account_id, idempotency_key)` | **Placement idempotency** (D 3.3 P0, PD4; F2). A replay finds the row and compares `request_hash`: equal → the current view; different → `idempotency.key-reused`. A same-key race ends in `P2002` on this key → re-read and answer the replay |
| `checkouts_market_id_customer_account_id_slot_key` | **partial unique** `(market_id, customer_account_id) WHERE state IN ('started','reserved','awaiting-payment','committing','capturing') OR (state = 'review' AND review_from_state IN ('committing','capturing'))` | **One active checkout per (Market, account)** (PD3; brief s5). Slot-holding states, not "every non-terminal state": **F1**. Also the lookup "my active checkout" in P2 (custom plan, platform.md 10.9) |
| `checkouts_market_id_order_id_key` | unique `(market_id, order_id)` | One checkout per order; payment-event handlers find the checkout by `orderId` |
| `checkouts_market_id_order_id_customer_account_id_key` | unique | O3 target of `orders_checkout_fkey` |
| `checkouts_market_id_order_id_payment_id_key` | unique | O3 target of `orders_payment_id_fkey` |
| `checkouts_market_id_expires_at_awaiting_idx` | partial `(market_id, expires_at) WHERE state IN ('reserved','awaiting-payment')` | `ordering.expire-checkouts` (D 11) |
| `checkouts_market_id_next_attempt_at_due_idx` | partial `(market_id, next_attempt_at) WHERE next_attempt_at IS NOT NULL` | `ordering.advance-checkouts` (D 11), including `started` → `abandoned` |
| `checkouts_market_id_state_changed_at_review_idx` | partial `(market_id, state_changed_at) WHERE state = 'review'` | The admin `REVIEW` queue (D 5.1) |
| `checkouts_market_id_customer_account_id_review_awaiting_idx` | partial `(market_id, customer_account_id) WHERE state = 'review' AND review_from_state = 'awaiting-payment'` | **P2's second lookup** (Hassan O-9; todo A14): the account's non-slot `REVIEW` Checkout entered from `AWAITING_PAYMENT`, whose intent the supersede step cancels first. Measured (10.2): 2 buffers, 0.05 ms; without it the plan walks the account's whole range of the idempotency key (a customer with 500 checkouts: 464 buffers, 0.41 ms). 16 kB at 10⁶ checkouts; written only on entering or leaving `review`. The slot key is **unchanged** |
| `checkouts_market_id_state_changed_at_prunable_idx` | partial `(market_id, state_changed_at) WHERE state IN ('rejected','abandoned')` | The 30-day prune (9.2; M7) |

- A payment event names `paymentId`; the handler resolves the order through `payments.paymentOf` (D 3.3 step 1) and then uses `(market_id, order_id)`. If payments' events carry the `orderId` itself (payments G2), nothing changes. **Not added:** an index on `payment_id` alone; if payments' events carry only `paymentId` and the handler must look up by it, `checkouts_market_id_order_id_payment_id_key` does not serve that, and a unique `(market_id, payment_id)` is added in M1 (11.2 P1).
- **Five unique indexes on one table.** The three on `order_id` could be one if `orders` did not prove its copies (O3). I keep them: `checkouts` is narrow and written a handful of times per checkout; the proofs are what make "no order without its checkout, its customer and its payment" a database fact.
- `next_attempt_at`, `state`, `expires_at` are indexed, so state changes are not HOT updates. A checkout changes state 3 to 6 times in its life; accepted.

**Guard trigger** `checkouts_write_once` (function `ordering.checkouts_guard_update()`, O16):
- `id`, `market_id`, `tenant_id`, `customer_account_id`, `idempotency_key`, `request_hash`, `order_id`, `created_at` never change;
- `reservation_id`, `expires_at`, `payment_id`, `cause`, `compensation_kind`, `compensation_refund_id` change only from NULL;
- a row in `rejected`, `completed`, `compensated` or `abandoned` never changes state. `cancelled` is **not** terminal at this level: D 3.3 moves `cancelled` → `compensating` on a late capture;
- **entering `review`** sets `review_from_state` to exactly the state left; while in `review` it never changes (todo A14);
- **leaving `review`** goes only to `review_from_state` (the admin's re-drive: the job then re-issues the stored command) or to `cancelled` / `compensated` (close as handled, Hassan O-7). Never to `completed`: closing never sets `PAID` (D 3.3).

`COMPENSATING` is now also entered from `AWAITING_PAYMENT` (supersede or authorisation answered `already-captured`), `VOIDING` and `RELEASING_STOCK` (Hassan O-3). No trigger rule needed changing for that: the trigger carries no entry rule for `compensating`, and `checkouts_cause_state_check` already requires the cause written in the same update. The full transition graph stays in `CheckoutStateMachine` (D 2.2); the trigger carries only what a bug or a manual script must never do. Measured (10, 10.2): payment id rewrite, a move out of `compensated` or `completed`, a wrong `review_from_state` and an exit from `review` to another state refused `23001`; `order_id` refused `42501` by the grant.

**`REVIEW` resolution is history, not columns** (todo A14). A Checkout may enter and leave `review` more than once (re-drive, then the budget runs out again), so write-once resolution columns on `checkouts` would refuse the second resolution. Each resolution is the `checkout_status_history` row of the transition out of `review`: `actor_kind = 'account'` and `actor_account_id` (the admin), `code` `review-redrive` or `review-close`, `reason_code` (closed list, O6), `occurred_at`; plus the audit row `ordering.checkout-review.resolved` (D 8).

### 3.3 `ordering.orders` (M1; D 2.1, 3.1, 4.1; PD1, PD10)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; equals `checkouts.order_id` (FK below) |
| `customer_account_id` | `uuid` | no | Identifier. FK-proved equal to the checkout's |
| `status` | `text` | no | CHECK `pending-payment`, `payment-failed`, `paid`, `cancelled` (D 3.1). The derived display status after `paid` is computed from `seller_orders` (D 3.1); it is not stored |
| `cancel_cause` | `text` | yes | CHECK `orders_cancel_cause_check`: the list of `checkouts.cause`, `review-closed` included (an admin closes a `REVIEW` item of a `PENDING_PAYMENT`/`PAYMENT_FAILED` order, Hassan O-7; todo A15), and `(status = 'cancelled') = (cancel_cause IS NOT NULL)` |
| `payment_id` | `uuid` | yes | Written once; FK-proved equal to the checkout's (O3). CHECK NOT NULL when `paid` |
| `currency` | `char(3)` | no | O1. The Market's currency |
| `items_gross_total_minor` | `bigint` | no | Σ line `tax_gross_minor` (D 4.4) |
| `fees_gross_total_minor` | `bigint` | no | Σ charge `tax_gross_minor` |
| `tax_total_minor` | `bigint` | no | Σ line and charge `tax_minor` (display) |
| `payable_total_minor` | `bigint` | no | CHECK `payable_total_minor = items_gross_total_minor + fees_gross_total_minor AND payable_total_minor >= 1 AND tax_total_minor <= payable_total_minor` |
| `delivery_address_ciphertext` | `text` | no | **Personal, encrypted** (5): recipient name, address lines, postcode, region, phone as one JSON value, under the customer's subject key. CHECK O7 with bound 16384 (SL-data 4.5 rule) |
| `delivery_zone` | `text` | no | O9. The address's zone from the Market's region → zone map (PL-2) |
| `service_area_code` | `text` | no | The ServiceArea that accepted the postcode (D 4.3 step 8). CHECK `^[a-z0-9][a-z0-9-]{0,63}$` (codes from `config/service-areas/`). Region and postcode are **not** stored in clear: TX-1 no longer takes the region (Ali G2-3), and nothing else filters on it |
| `locale` | `text` | no | BCP 47; CHECK `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$` |
| `quote_fingerprint` | `text` | no | D 2.2 `QuoteFingerprint`: SHA-256 over the priced snapshot, which holds **no personal field**, so it stays unkeyed (Hassan O-4; todo A8). `ContentHash` form (O15), CHECK `^sha256:[0-9a-f]{64}$` |
| `placed_at` | `timestamptz(6)` | no | P4 instant |
| `paid_at` | `timestamptz(6)` | yes | Written once; the `payment-succeeded` event's `occurred_at` (D 3.1). CHECK `orders_paid_check`: `(status = 'paid') = (paid_at IS NOT NULL)`, `paid_at >= placed_at` |
| `version` | `integer` | no | C5 |

**Keys and FKs**
- `orders_checkout_fkey`: `(market_id, id, customer_account_id)` → `checkouts (market_id, order_id, customer_account_id)`, RESTRICT. No order without its checkout; one order per checkout (the PK); the customer copy is equal (measured: an order without a checkout and one with another customer both refused).
- `orders_payment_id_fkey`: `(market_id, id, payment_id)` → `checkouts (market_id, order_id, payment_id)`, `MATCH SIMPLE`: checked once `payment_id` is set (measured: a different payment id refused; the equal one accepted). The repository writes the checkout's `payment_id` first, then the order's, in P5's unit (6.1).
- Unique `orders_market_id_id_key (market_id, id)`: C3 target of the history.
- Unique `orders_market_id_id_currency_customer_account_id_key`: the O3 target of `seller_orders` (currency and customer copies in one key).

**Indexes for the lists** (PD11):

| Name | Definition | Query |
|---|---|---|
| `orders_market_id_customer_account_id_placed_at_idx` | `(market_id, customer_account_id, placed_at DESC, id DESC)` | Q4 customer history, keyset |
| `orders_market_id_placed_at_idx` | `(market_id, placed_at DESC, id DESC)` | Q6 admin list, unfiltered |
| `orders_market_id_status_placed_at_idx` | `(market_id, status, placed_at DESC, id DESC)` | Q6 admin list filtered by stored status. A status changes at most three times per order, so the cost of a non-HOT update is small |

**Guard trigger** `orders_write_once`: every column except `status`, `cancel_cause`, `payment_id`, `paid_at`, `version` is immutable; `payment_id`, `paid_at`, `cancel_cause` change only from NULL; status moves only `pending-payment` → `payment-failed`, `paid`, `cancelled` and `payment-failed` → `pending-payment`, `paid`, `cancelled` (D 3.1); `paid` and `cancelled` never change. Measured: `paid` without `paid_at` refused by the CHECK.

### 3.4 `ordering.seller_orders` (M1; D 2.1, 3.2; PD1, PD11, PD12)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `order_id` | `uuid` | no | FK `seller_orders_order_id_fkey` `(market_id, order_id, currency, customer_account_id)` → `orders`, RESTRICT |
| `seller_id` | `uuid` | no | C4. The owner (D 5.2): every seller read has `seller_id = ActorContext.sellerId` in its `where` |
| `customer_account_id` | `uuid` | no | Copy for ownership reads (D 2.1), FK-proved |
| `currency` | `char(3)` | no | FK-proved |
| `public_store_name` | `text` | no | Snapshot from `sellerSummaries`; public, clear. CHECK 1 to 200 characters |
| `seller_zone` | `text` | no | O9. The seller's approved zone at placement (D 2.1). Display only: the invoice date uses the zone `tax` returns at issue (Ali G2, TX T7) |
| `seller_tax_registered` | `boolean` | no | Frozen at placement (Ali G2-2). **No tax number is stored here** (Ali G2-2; D 2.1 changes) |
| `seller_tax_registration_period_id` | `uuid` | yes | The `registrationPeriodId` of the answer (C4, `sellers`'). Opaque: stored and echoed, never parsed (Hassan H1). CHECK `seller_orders_tax_period_check` `NOT seller_tax_registered OR seller_tax_registration_period_id IS NOT NULL` (TX 4.4, X2 answered: present when registered; may be present when not, for a period that records "not registered"; NULL only without a period) |
| `minimum_order_minor` | `bigint` | yes | The seller minimum applied (D 4.1); NULL = none set |
| `goods_gross_total_minor` | `bigint` | no | Σ line gross |
| `payable_total_minor` | `bigint` | no | `goods_gross_total_minor` + the charge's gross. CHECK `>= goods_gross_total_minor`. The cross-row sums are checked by the repository test (6.4), not by the database |
| `paid_at` | `timestamptz(6)` | yes | Copy of `orders.paid_at`, written in the PAID unit for every sub-order. Written once. The seller list key (F5) |
| `display_status` | `text` | no | **Derived** (D 3.2, PD12), written in the same unit as every counter change by `SellerOrderStatusDeriver`. CHECK `pending` (order not paid), `void` (order cancelled before payment), `processing`, `invoiced`, `shipped`, `delivered`, `cancelled`, `refunded`. **`closed` is not stored** (F4) |
| `display_partial` | `boolean` | no | D 3.2's `partial` flag for `invoiced`/`shipped` |
| `last_delivered_at` | `timestamptz(6)` | yes | The latest non-voided delivery mark's instant; recomputed on a correction. `closed` is evaluated from it at read time against `Clock` (F4) |
| `refund_required_since` | `timestamptz(6)` | yes | Set when some line has cancelled units not refunded or locked (D 3.2 flag `refundRequired`); cleared when none. The admin queue and `ordering.watch-refunds` (F7, PD16) |
| `version` | `integer` | no | C5. Raised by every operation (D 4.5) |
| `created_at` | `timestamptz(6)` | no | |

**Keys and indexes**

| Name | Definition | Serves |
|---|---|---|
| `seller_orders_market_id_order_id_seller_id_key` | unique | ORD-01: one sub-order per seller per order. Its prefix serves "the sub-orders of an order" (detail, PAID unit, derived order status) |
| `seller_orders_market_id_id_key` | unique `(market_id, id)` | C3 target of the history |
| `seller_orders_market_id_id_currency_key` | unique | O3 target of lines, charges, refund requests |
| `seller_orders_market_id_id_seller_id_key` | unique | O3 target of `invoices` (seller copy) |
| `seller_orders_market_id_seller_id_paid_at_idx` | partial `(market_id, seller_id, paid_at DESC, id DESC) WHERE paid_at IS NOT NULL` | Q5 seller list, keyset (measured, 10). A status filter is a filter on this range (measured 0.4 ms for a 300-row seller range; no status index, 6.5) |
| `seller_orders_market_id_refund_required_since_idx` | partial `(market_id, refund_required_since) WHERE refund_required_since IS NOT NULL` | Q8 admin "refund required" queue and the alert of `watch-refunds` |

- `display_status`, `refund_required_since` and `last_delivered_at` change with operations; `display_status` is not indexed, so most counter updates stay HOT-eligible (`refund_required_since` changes only on cancellation and refund).
- **Guard trigger** `seller_orders_write_once`: snapshot columns immutable; `paid_at` written once.

### 3.5 `ordering.seller_order_charges` (M1; F6; TX PD7 per charge)

One row per charge of a sub-order. Phase 5 has one kind, the flat shipping fee (Q11, Ali G1-r7). Phase 6 replaces it by real shipping charges without a change to `seller_orders`.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; the `ref` sent to `tax` for the charge |
| `seller_order_id` | `uuid` | no | FK `(market_id, seller_order_id, currency)` → `seller_orders`, RESTRICT |
| `currency` | `char(3)` | no | O1 |
| `kind` | `text` | no | CHECK `flat-shipping` |
| `amount_minor` | `bigint` | no | The fee as set by the admin; explicit zero allowed (AC 14) |
| `settings_version` | `integer` | no | The `SellerAdminSettings` version it came from (D 4.1). CHECK `>= 1` |
| `tax_inclusive` | `boolean` | no | **The price basis sent to `tax` for the charge** (Ali D-1; todo A2): `true` = the amount contains the tax. Same name and meaning as `order_lines.tax_inclusive`. **No `price_basis` column** anywhere for the tax basis (`order_lines.price_basis` is pricing's `regular`/`special`, a different thing); the name `tax_price_basis` is reserved for a text form if one is ever needed |
| TX PD7 columns | | | As `order_lines` (3.6), with the same CHECKs: `tax_rule_set_id`, `tax_strategy_code`, `tax_category_code` (**NOT NULL**: `tax` always names the charge's category, X1 answered, TX 4.5; todo A2), `tax_treatment`, `tax_rate`, `tax_gross_minor`, `tax_minor`, `tax_net_minor`, `tax_seller_registered`, `tax_registration_period_id`, `tax_evaluated_at` |

**Constraints** (names as created; each measured, 10.2):

| Constraint | Backs |
|---|---|
| `seller_order_charges_tax_base_check`: `(tax_inclusive AND tax_gross_minor = amount_minor) OR (NOT tax_inclusive AND tax_net_minor = amount_minor)` | The answer was computed on this charge's amount and basis (X3 answered, TX 4.3 base rule; a charge has no discount) |
| `seller_order_charges_tax_treatment_check`, `_tax_rate_check`, `_tax_amounts_check`, `_tax_sum_check`, `_tax_registration_check`, `_tax_untaxed_check`, `_tax_rated_rate_check`, `_tax_period_check` | The `LineTax` backstops of 3.6 (todo A1) |
| `seller_order_charges_tax_category_code_check` | The catalog CA4 pattern `^[a-z][a-z0-9_-]{0,63}$` (AU `gst_free` has an underscore) |

- Unique `seller_order_charges_market_id_seller_order_id_kind_key`: one charge of a kind per sub-order. Its prefix serves "the charges of a sub-order".
- Unique `seller_order_charges_market_id_id_seller_order_id_gross_key` `(market_id, id, seller_order_id, tax_gross_minor)`: the O3 target of invoice and refund lines that carry a charge portion. It replaces the three-column key of the draft, so the portion's copy of the charge gross is FK-proved and its CHECK `cumulative_after_minor <= charge_gross_minor` binds the real gross (3.9, 3.12; measured: a wrong copy refused `23503`).
- `SELECT, INSERT` only; O5 trigger. Commission is never computed on it (Q7): the line table carries the commission rate, the charge carries none.

### 3.6 `ordering.order_lines` (M1; D 2.1, 4.1, 4.5; PD1, PD5, PD17; TX PD7)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; the `orderLineId` sent to `inventory` (UUIDv7, INV R2, Ali G2) |
| `seller_order_id` | `uuid` | no | FK `order_lines_seller_order_id_fkey` `(market_id, seller_order_id, currency)` → `seller_orders`, RESTRICT |
| `currency` | `char(3)` | no | FK-proved |
| `offer_id`, `variant_id`, `product_id` | `uuid` | no | catalog ids (C4) |
| `product_revision_id` | `uuid` | no | The published revision of CF-1. Also the revision the tax category code was read from: one column, not two (11.1 M1) |
| `content_hash` | `text` | no | catalog's `contentHash`. CHECK 1 to 128 characters, `^[A-Za-z0-9:_+/=-]+$` |
| `display` | `jsonb` | no | Display copy: product name, variant label, locale (PD1). CHECK `jsonb_typeof = 'object' AND octet_length(display::text) <= 4096`. Shape validated by the application |
| `unit_price_minor` | `bigint` | no | O1, `>= 1` |
| `price_record_id` | `uuid` | no | pricing's `effectiveRecordId` (C4) |
| `price_basis` | `text` | no | Pricing's basis: CHECK `regular`, `special`. Not the tax basis |
| `tax_inclusive` | `boolean` | no | From the price record (PRC 4.5). **The tax price basis sent to `tax`** (`inclusive` when true): Ali D-1 keeps this column and adds no `price_basis` for tax |
| `quantity` | `integer` | no | CHECK `>= 1`. The line ceiling is configuration (O13) |
| `line_total_minor` | `bigint` | no | CHECK `order_lines_line_total_check`: `line_total_minor = unit_price_minor * quantity` (exact; D 4.4; measured) |
| `tax_rule_set_id` | `text` | no | TX PD7. CHECK `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (`AU-2026-1`) |
| `tax_strategy_code` | `text` | no | CHECK `^[a-z][a-z0-9-]{0,63}$` (`configured-rate`) |
| `tax_category_code` | `text` | no | The catalog code frozen from CF-1 and passed to `tax` (TX T1 B). CHECK `order_lines_tax_category_code_check`: the catalog CA4 pattern `^[a-z][a-z0-9_-]{0,63}$` (the draft's reason-code pattern had no underscore and would have refused AU `gst_free`) |
| `tax_treatment` | `text` | no | CHECK `order_lines_tax_treatment_check` `IN ('rated', 'free', 'seller-not-registered')` (TX 2.2 `LineTax`; todo A1; a new kind is a migration) |
| `tax_rate` | `numeric` | no | O2. `"0"` unless rated (TX 2.2); compared numerically (`0.10 = 0.1`, measured) |
| `tax_gross_minor`, `tax_minor`, `tax_net_minor` | `bigint` | no | O1. CHECK `order_lines_tax_sum_check`: `tax_gross_minor = tax_net_minor + tax_minor` |
| `tax_seller_registered` | `boolean` | no | TX PD7 `seller_registered` |
| `tax_registration_period_id` | `uuid` | yes | TX PD7; opaque (Hassan H1). CHECK `order_lines_tax_period_check` `NOT tax_seller_registered OR tax_registration_period_id IS NOT NULL` (TX 4.4) |
| `tax_evaluated_at` | `timestamptz(6)` | no | TX PD7 `evaluated_at` |
| `commission_rate` | `numeric` | no | O2 (Q7: AU 0.15 at launch; never a CHECK value) |
| `commission_rate_record_id` | `uuid` | no | C-P's record (C4; T2 A) |
| `commission_rate_source` | `text` | no | CHECK `seller`, `market` |
| `claims` | `jsonb` | no | One full `ClaimDecision` copy per displayed tag (ADR-0028 decision 12). CHECK `jsonb_typeof = 'array' AND octet_length(claims::text) <= 32768`. `[]` when the Offer has no tag. Never read as an authorisation (CERT-21) |
| `reservation_line_id` | `uuid` | no | inventory's line (C4) |
| `qty_cancelled`, `qty_invoiced`, `qty_shipped`, `qty_delivered`, `qty_refunded`, `qty_refund_locked` | `integer` | no | Counters of D 4.5. Each CHECK `>= 0`. Insert writes 0 |

**Constraints that carry D's invariants**

| Constraint | Invariant | Measured (10) |
|---|---|---|
| `order_lines_quantities_check`: `qty_cancelled + qty_invoiced <= quantity AND qty_shipped <= qty_invoiced AND qty_delivered <= qty_shipped AND qty_refunded + qty_refund_locked <= quantity` | D 4.5, PD5, AC 11 (the "4 then 6" case: invoicing 7 after 4 of 10 is refused) | Five violations refused `23514` |
| `order_lines_line_total_check` | Line total = unit price × quantity | Refused |
| `order_lines_tax_sum_check` | `gross = net + tax` (TX `LineTax`) | Same form on charges: refused (10.2) |
| `order_lines_tax_registration_check`: `(tax_treatment = 'seller-not-registered') = (NOT tax_seller_registered)` | TX 2.2: that treatment ⇔ not registered (todo A1) | Refused `23514` (10.2) |
| `order_lines_tax_untaxed_check`: `tax_treatment = 'rated' OR (tax_minor = 0 AND tax_rate = 0)` | `free` and `seller-not-registered` carry rate `"0"` and no tax (TX 2.2, 4.3; TD M1(a)) | Refused on charges (10.2) |
| `order_lines_tax_rated_rate_check`: `tax_treatment <> 'rated' OR tax_rate > 0` | A rated line has a rate (TX 2.1) | Refused on charges (10.2) |
| `order_lines_tax_period_check` | TX 4.4 (see the column) | Refused on charges (10.2) |
| `order_lines_tax_base_check` (**confirmed**, X3; TX 4.3 base rule): `(tax_inclusive AND tax_gross_minor = line_total_minor) OR (NOT tax_inclusive AND tax_net_minor = line_total_minor)` | The tax answer was computed on this line's frozen amount and basis. A backstop against storing another line's answer. Holds while the discount is 0; it gains the discount when `promotions` arrives (TX 14) | Same form on charges: refused (10.2) |
| Grant: `UPDATE` on the six counters only | Snapshot never changes (PD1, PD5) | `quantity` update refused `42501` |

- Unique `order_lines_market_id_seller_order_id_offer_id_variant_id_key`: one line per sell unit per sub-order (cart lines are unique per sell unit). Its prefix serves "the lines of a sub-order" (every operation, detail).
- Unique `order_lines_market_id_id_seller_order_id_key`: the O3 target for every child line (invoice, shipment, delivery, cancellation, refund lines), so a child line can never name another sub-order's line.
- Unique `order_lines_market_id_reservation_line_id_key`: one order line per reservation line (the commit mapping, D 3.3 step 4).
- **No index on a counter**, so counter updates are HOT-eligible (the frequent writes of slices 5 to 8).
- **Guard trigger** `order_lines_write_once`: every non-counter column immutable, for the owner too.
- `quantity ≤ maxLineQuantity` is configuration (O13).

### 3.7 Status histories (M1; PD2; V4)

Three append-only tables with the same shape; `SELECT, INSERT` and the O5 trigger.

| Table | Root FK | Specific columns |
|---|---|---|
| `checkout_status_history` | `(market_id, checkout_id)` → `checkouts (market_id, id)` (needs unique `checkouts_market_id_id_key`) | `from_state` (NULL on creation), `to_state`, `cause` / `reject_code` / `error_code` (one `code` column, CHECK pattern) |
| `order_status_history` | `(market_id, order_id)` → `orders (market_id, id)` | `from_status`, `to_status`, `code` |
| `seller_order_history` | `(market_id, seller_order_id)` → `seller_orders (market_id, id)` | `operation` CHECK `created`, `paid`, `voided`, `invoiced`, `cancelled`, `shipped`, `delivered`, `delivery-corrected`, `shipment-reversed`, `refund-locked`, `refund-settled`, `refund-released`; `operation_ref_id uuid` (the invoice, cancellation, application, mark, reversal or refund id); `display_status_after`; `version_after integer` |

Common columns: `id uuid` PK; `actor_kind`, `actor_account_id` (O10); `reason_code` (O6, NULL unless the operation needs one); `correlation_id text` (CHECK as `audit_log_correlation_id_check`); `occurred_at`.

- One index each: `(market_id, <root>_id, occurred_at, id)`: the root's history, keyset.
- `seller_order_history` unique `(market_id, seller_order_id, version_after)`: one history row per version step, which proves every operation wrote its row (D 3 "appends one status-history row").
- `checkout_status_history` is the only history whose root may be pruned (9.2, M7); its FK is `ON DELETE CASCADE` for that reason (the cascade needs no `DELETE` grant on the child). The other two are `RESTRICT`: orders are never deleted (PD18).
- **Finding, measured (10.2):** the O5 trigger `reject_mutation()` on `BEFORE DELETE` also fires for a cascaded delete, so the draft's prune failed with `23001` and deleted nothing. `checkout_status_history` therefore gets its own guard, `ordering.checkout_status_history_guard()` (O16): `UPDATE` always refused; `DELETE` allowed only when the row's root no longer exists (`NOT EXISTS (SELECT 1 FROM "ordering"."checkouts" WHERE market_id = OLD.market_id AND id = OLD.checkout_id)`), which is true only inside the cascade of a pruned checkout; `TRUNCATE` refused by `reject_mutation()`. Measured: the prune deletes the checkout and its two history rows; the owner's direct `DELETE`, `UPDATE` and `TRUNCATE` of a live checkout's history are refused `23001`; the application has no `DELETE` grant (`42501`).

### 3.8 `ordering.invoice_sequences` (M2; D 2.1, 4.6; PD6)

| Column | Type | Null | Notes |
|---|---|---|---|
| `seller_id` | `uuid` | no | C4 |
| `series` | `text` | no | CHECK `invoice`, `adjustment`. Whether adjustment notes take their own series or share `invoice` is the tax agent's AG-11; the column lets either run without a migration (11.2 X4) |
| `last_number` | `bigint` | no | CHECK `>= 1` |

- PK `invoice_sequences_pkey (market_id, seller_id, series)`. No id: the key is the identity.
- **Gap-free by the issuing unit** (PD6): one statement inside the unit that inserts the invoice:

  ```sql
  INSERT INTO "ordering"."invoice_sequences" (market_id, tenant_id, seller_id, series, last_number)
  VALUES ($1, $2, $3, $4, 1)
  ON CONFLICT (market_id, seller_id, series)
  DO UPDATE SET last_number = "ordering"."invoice_sequences".last_number + 1
  RETURNING last_number;
  ```
  Prisma `upsert` on the compound key with `marketId` at the top level of `where` (ID-data C10, spike 6: one native `INSERT … ON CONFLICT`); `update: { lastNumber: { increment: 1 } }`. The row lock taken by the update serialises one seller's documents; sellers never contend. A rolled-back unit rolls back its increment, so no number is lost. **Measured** (10): 16 sessions × 25 issues on one seller, 30 % of units rolled back after taking the number, the first issue racing on the insert: 279 committed invoices numbered exactly 1 to 279, `last_number` 279, no duplicate, no gap.
- `SELECT, INSERT, UPDATE (last_number)`; never deleted.

### 3.9 `ordering.invoices` and `ordering.invoice_lines` (M2; D 2.1, 4.6, 4.8; PD6, PD7; TX PD7; Ali G2-2)

**`invoices`** (immutable once inserted: `SELECT, INSERT` and O5; measured):

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `seller_order_id`, `seller_id` | `uuid` | no | FK `(market_id, seller_order_id, seller_id)` → `seller_orders (market_id, id, seller_id)` |
| `currency` | `char(3)` | no | FK `(market_id, seller_order_id, currency)` → `seller_orders` |
| `series`, `sequence_number` | `text`, `bigint` | no | From 3.8. Unique `invoices_market_id_seller_id_series_sequence_number_key` (PD6) |
| `document_number` | `text` | no | The number as printed (prefix and format from Market configuration, frozen so a later format change never alters an issued document). CHECK 1 to 64 characters. Unique `(market_id, seller_id, document_number)` |
| `kind` | `text` | no | CHECK `tax-document`, `plain-document`, `tax-adjustment-document`, `plain-adjustment-document` (TX-2) |
| `label_key` | `text` | no | TX PD7. CHECK pattern `^[a-z][a-z0-9.-]{0,127}$` |
| `adjusts_invoice_id` | `uuid` | yes | FK `(market_id, adjusts_invoice_id, seller_id)` → `invoices (market_id, id, seller_id)`: an adjustment note adjusts an invoice of the same seller |
| `refund_request_id` | `uuid` | yes | FK `(market_id, refund_request_id)` → `refund_requests` (added in M4, when that table exists: 8.1). CHECK `invoices_adjustment_check`: adjustment kinds ⇔ `refund_request_id IS NOT NULL`; `adjusts_invoice_id` only on adjustment kinds |
| `issued_at` | `timestamptz(6)` | no | `now` from `Clock`, accepted by `tax` within [now − 5 min, now] (TX T7) |
| `issue_date` | `date` | no | The local date in `issue_zone` (TX PD7) |
| `issue_zone` | `text` | no | O9. **The zone `tax` returns**, not `seller_orders.seller_zone` (Ali G2, tax 4.6) |
| `tax_rule_set_id`, `tax_strategy_code` | `text` | no | The document rule version (TX PD7) |
| `required_fields` | `text[]` | no | The field codes from `DocumentPolicy` (one form with TD 10.1.2; todo A6). CHECK `invoices_required_fields_check`: `cardinality(required_fields) >= 1 AND required_fields <@ ARRAY['seller-legal-name', 'seller-tax-number', 'issue-date', 'item-description', 'item-quantity', 'item-price', 'tax-amount-or-inclusive-statement', 'taxable-extent-per-line', 'buyer-identity-or-tax-number']::text[]` (the closed list of TX 4.6; a new code is a `NOT VALID` CHECK swap). `text[]` rather than `jsonb`: a short closed list, read whole, never queried by element. Prisma `String[]`. Measured: an unknown code, an empty array and a NULL element refused `23514` |
| `tax_document_mandatory`, `buyer_identity_required` | `boolean` | no | TX PD7 / TX 6.2 `DocumentAnswer` |
| `gross_total_minor`, `tax_total_minor`, `net_total_minor` | `bigint` | no | CHECK gross = net + tax. Signs: an adjustment note stores the amounts reversed as positive values; `kind` gives the direction |
| `seller_identity_ciphertext` | `text` | no | **Personal for a sole trader; encrypted under the per-invoice subject** (5; todo A9): legal name, trading name and tax number, read at issue from `taxProfileOf` and S-3 (Ali G2-2). A registered seller without a number at issue is refused before the unit (Ali G2-2) and writes nothing. Bound 4096 |
| `buyer_identity_ciphertext` | `text` | yes | **Personal, encrypted under the per-invoice subject**: buyer identity when `buyer_identity_required` (TX AG-8). CHECK `buyer_identity_required = (buyer_identity_ciphertext IS NOT NULL)`. Bound 4096 |
| `content_hash` | `text` | no | **HMAC** over the canonical content (plaintext before encryption, D 2.1) under the **per-invoice** subject: `SubjectKeyService.hmac(market, <invoice subject>, 'ordering.invoice.content', bytes)` (O15; Hassan O-4; todo A8). CHECK `invoices_content_hash_check` `^hmac-sha256:[0-9a-f]{64}$`. After the AG-12 retention job destroys the subject, the hash can no longer be verified, by design |

**The per-invoice subject** (Hassan accepted option B; D 2.1, PD10; todo A9). Every row of `invoices`, adjustment notes included, has its own subject in `SubjectKeyService`: subject id = `invoices.id`, of the namespaced kind `ordering-invoice` (the key-table side is the platform note, C3). **No new column**: the id is immutable and is the reference; a separate column would be a copy needing a CHECK. The key is created by `createKey` inside the issuing unit (PF 4 row 8), so no invoice exists without its key and a rolled-back issue leaves no key. The subject is **outside customer erasure** (erasure destroys the account's subject only; the key service refuses to destroy an `ordering-invoice` subject except for the retention purpose) and is destroyed **only** by the AG-12 retention job `ordering.shred-invoice-identities` (9.3). After that, `seller_identity_ciphertext`, `buyer_identity_ciphertext` and `content_hash` stay as unreadable bytes; the amounts, dates and numbers of the document stay readable.
| `client_key` | `uuid` | yes | The seller's idempotency key (D 9). Unique `(market_id, seller_order_id, client_key)`; NULL for system-issued adjustment notes, whose key is `refund_request_id` (unique `(market_id, refund_request_id)`: one adjustment note per refund request) |
| `actor_kind`, `actor_account_id` | | | O10. `system` for adjustment notes |
| `correlation_id` | `text` | no | |

Indexes: `invoices_market_id_seller_order_id_issued_at_idx` (the sub-order's invoices tab, customer download list, `financialFactsOf` by sub-order). Unique `(market_id, id, seller_id)` and `(market_id, id)`: FK targets. The turnover index (TX PD3) comes with its reader: 3.9.1.

**`invoice_lines`** (`SELECT, INSERT`, O5):

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `invoice_id` | `uuid` | no | FK `(market_id, invoice_id, seller_order_id)` → `invoices (market_id, id, seller_order_id)` (unique added on `invoices`) |
| `seller_order_id` | `uuid` | no | Copy, proved twice: by the invoice FK and by the line or charge FK |
| `order_line_id` | `uuid` | yes | FK `(market_id, order_line_id, seller_order_id)` → `order_lines (market_id, id, seller_order_id)` |
| `charge_id` | `uuid` | yes | FK `invoice_lines_charge_id_fkey` `(market_id, charge_id, seller_order_id, charge_gross_minor)` → `seller_order_charges (market_id, id, seller_order_id, tax_gross_minor)`. CHECK `invoice_lines_target_check`: exactly one of `order_line_id`, `charge_id` |
| `position_space` | `text` | no | CHECK `invoiced`, `refunded`. **NOT NULL on every row** now that charge portions carry it too (todo A3): `invoiced` on invoices, `refunded` on adjustment notes (the invoice's direction; the repository checks the copy) |
| `position_from` | `integer` | yes | Line rows: the 0-based position of the first unit on this document (= units already invoiced or refunded; TX PD7, TX 4.6). CHECK `>= 0` |
| `quantity` | `integer` | yes | Line rows. CHECK `>= 1` |
| `charge_gross_minor` | `bigint` | yes | Charge rows: copy of the charge's `tax_gross_minor`, **proved by the FK** (O3), so the range bound below binds the real gross |
| `cumulative_before_minor`, `cumulative_after_minor` | `bigint` | yes | Charge rows: the cumulative range `[before, after)` of the charge gross that this document covers (TX 4.6, 4.8 `CumulativeAmountAllocator`; D 4.6 "first invoice carries `[0, fee gross)`") |
| `gross_minor`, `tax_minor`, `net_minor` | `bigint` | no | This document's amounts for the line or charge portion (TX-2, TX-3). CHECK `invoice_lines_amounts_check`: bounds and gross = net + tax |
| `tax_treatment` | `text` | no | The marker shown per line (TX 6.2). CHECK the three treatments of 3.6 |

**Shape CHECKs** (O14; measured, 10.2):
- `invoice_lines_line_check`: `order_line_id IS NULL OR (num_nonnulls(quantity, position_from) = 2 AND quantity >= 1 AND position_from >= 0 AND num_nulls(charge_gross_minor, cumulative_before_minor, cumulative_after_minor) = 3)`.
- `invoice_lines_charge_check`: `charge_id IS NULL OR (num_nulls(quantity, position_from) = 2 AND num_nonnulls(charge_gross_minor, cumulative_before_minor, cumulative_after_minor) = 3 AND cumulative_before_minor >= 0 AND cumulative_before_minor < cumulative_after_minor AND cumulative_after_minor <= charge_gross_minor AND gross_minor = cumulative_after_minor - cumulative_before_minor)`. The last term makes the portion's gross equal its range, so the ranges of all documents sum to the charge gross exactly when they tile it.

**Keys and exclusions**
- Unique `(market_id, invoice_id, order_line_id)` and `(market_id, invoice_id, charge_id)`: one row per line or charge per document (NULLs do not collide).
- **`invoice_lines_positions_excl`** (F8, accepted): `EXCLUDE USING gist (market_id WITH =, order_line_id WITH =, position_space WITH =, int4range(position_from, position_from + quantity) WITH &&) WHERE (order_line_id IS NOT NULL)`. No unit position of a line is ever invoiced twice, or refunded twice, across all its documents: the database's proof that the per-unit tax shares (TX `UnitShareAllocator`) of partial documents sum exactly to the line. **Measured** (10.2): `[0,1)` then `[1,3)` accepted; `[2,3)` again refused `23P01`; `[0,1)` in `refunded` accepted beside the invoiced one; an overlapping refunded range refused.
- **`invoice_lines_charge_ranges_excl`** (todo A3): `EXCLUDE USING gist (market_id WITH =, charge_id WITH =, position_space WITH =, int8range(cumulative_before_minor, cumulative_after_minor) WITH &&) WHERE (charge_id IS NOT NULL)`. **"The fee is invoiced once" and "no part of the fee is refunded twice" are database facts.** Measured: `[0, 990)` invoiced, then the same range or `[500, 990)` refused `23P01`; refunded `[0, 330)` then `[330, 990)` accepted, `[300, 400)` refused.
- `btree_gist` already exists in schema `extensions` (PRC-data 8.3); `ordering` never creates it. Cost: two GiST indexes on an insert-only table.
- A **zero fee** (explicit zero, AC 14) has gross 0, and `[0, 0)` is refused by `before < after`, so a zero fee never appears as a document line: there is nothing to invoice or refund. The document shows "shipping 0" from the charge row if Reza's template wants it (11.1 F15).
- That the next document starts at the previous end (no hole) is the domain's job: `position_from = qty_invoiced` (lines) and `before` = the charge gross already on earlier documents (charges), read under the sub-order lock (6.2).

#### 3.9.1 The turnover read (TX PD3; P1, with tax slice 6)

`SellerTurnoverSource.turnoverOf(ctx, sellerIds ≤ 100, from, to)`: net invoiced minus net adjusted per seller over `[from, to)` of `issued_at`. One statement, grouped:

```
SELECT seller_id, kind, sum(net_total_minor) FROM ordering.invoices
 WHERE market_id = $1 AND seller_id = ANY($2) AND issued_at >= $3 AND issued_at < $4
 GROUP BY seller_id, kind
```
(Prisma `groupBy` by `sellerId`, `kind`, `_sum: { netTotalMinor }`, `marketId` at the top level.) Index `invoices_market_id_seller_id_issued_at_idx` on `(market_id, seller_id, issued_at) INCLUDE (kind, net_total_minor)`, for index-only scans; the table is insert-only, so the visibility map stays set after vacuum. Added in its own migration with the TX-4 implementation (M8), not before. Adjustment notes are rows of `invoices`, so a refund counts at its own issue instant (TX 4.10) and the window is one range on one table. This document is the owning text for the turnover read (TD 10.1.3 points here).

`SellerTurnoverSource.sellersWithSupplies(ctx, from, to, after, limit ≤ 100)` (Ali T8; todo A7): the seller ids with any document in `[from, to)`, keyset by seller id. On the **same** M8 index, no other:

```
SELECT seller_id FROM ordering.invoices
 WHERE market_id = $1 AND seller_id > $after AND issued_at >= $from AND issued_at < $to
 GROUP BY seller_id ORDER BY seller_id LIMIT $limit
```
Prisma: `groupBy({ by: ['sellerId'], where: { marketId, sellerId: { gt: after }, issuedAt: { gte: from, lt: to } }, orderBy: { sellerId: 'asc' }, take: limit })`; `after` is the nil UUID on the first page. **Never `findMany({ distinct })`**: Prisma applies `distinct` in memory after fetching every row. Plan: index-only scan in seller order, `Group`, stop at 100 groups; PostgreSQL 16 has no skip scan, so a page reads every index entry of its sellers, in and out of the window.

**Measured** (10.2; document level, replacing TD's line-level scratch): 3 × 10⁶ documents over two years, 1,000 sellers per Market with a skewed distribution (largest 270,118 documents, smallest 868), 2.7 × 10⁶ in AU, 1.35 × 10⁶ inside the 12-month window; heap 1,465 MB, M8 index 221 MB; `shared_buffers` 128 MB.

| Read | Plan | Time, buffers |
|---|---|---|
| `turnoverOf`, the 100 largest sellers | Index-only scan, 0 heap fetches, `HashAggregate` | 388 ms, 527 k buffers (626 k entries in window) |
| `turnoverOf`, the 100 smallest sellers | Same | 26 ms, 39.5 k buffers |
| `sellersWithSupplies`, first page | Index-only scan, `Group`, `Limit` | 152 ms, 230 k buffers (the page holds the largest seller) |
| `sellersWithSupplies`, the whole walk (10 pages, 1,000 sellers) | Same | 0.65 s in total, worst page 141 ms |

The daily job therefore costs about one second per Market at ten times the year-1 volume. **Not added:** an index leading on `(market_id, issued_at, seller_id)`, which would read only window rows for the listing but adds a second index on the largest insert-only table for a P1 job; revisit if the walk exceeds 10 s. A per-seller daily rollup (TD 10.1.3) stays unneeded.

### 3.10 Shipment, reversal and delivery (M3, M5; D 3.2, 4.7, 6.3; PD9)

All append-only (`SELECT, INSERT`, O5). Counter effects happen on `order_lines` in the same unit.

**`shipment_applications`**: `id` (PK), `shipment_id uuid` (shipping's id), `seller_order_id` (FK `(market_id, seller_order_id)` → `seller_orders`), `actor_account_id` (O10, seller account), `applied_at`, `correlation_id`.
- **Unique `shipment_applications_market_id_shipment_id_key`** (PD9): the idempotency key of `applyShipment` (AC 15). A repeat reads the row and returns the first answer; a race ends in `P2002` → re-read.
- `(market_id, seller_order_id, applied_at)`: the Shipments tab.
- Unique `(market_id, id, seller_order_id)`: target of its lines and of the reversal.

**`shipment_application_lines`**: PK `(market_id, shipment_application_id, order_line_id)` (ID-data C7 shape); `seller_order_id` copy; `quantity integer CHECK >= 1`. FKs `(market_id, shipment_application_id, seller_order_id)` → applications, `(market_id, order_line_id, seller_order_id)` → `order_lines`.

**`shipment_reversals`**: `id` (PK; the `reversalId` sent to `inventory.reverseShipment`, T5 A), `shipment_application_id` with **unique** `(market_id, shipment_application_id)` (an application is reversed at most once), `seller_order_id` copy (FK `(market_id, shipment_application_id, seller_order_id)`), `reason_code` (NOT NULL, CHECK `shipment_reversals_reason_code_check`, Hadi's list, O6a), `actor_account_id` (admin), `reversed_at` CHECK nothing beyond NOT NULL, `correlation_id`. The window (`now − applied_at ≤ shipmentReversalWindow`, 90 days, ordering policy, own refusal code, Ali G2-4) is checked by the use case against the application's `applied_at`; no CHECK (O13).

**`delivery_marks`**: `id`, `seller_order_id`, `actor_account_id` (seller), `marked_at`, `correlation_id`; unique `(market_id, id, seller_order_id)`; index `(market_id, seller_order_id, marked_at)`.
**`delivery_mark_lines`**: PK `(market_id, delivery_mark_id, order_line_id)`, `seller_order_id` copy, `quantity >= 1`. The correction sets the counters back by exactly these quantities.
**`delivery_mark_corrections`**: `id`, `delivery_mark_id` with **unique** `(market_id, delivery_mark_id)` (a mark is voided once; D has no "un-correct"), `seller_order_id` copy, `reason_code` NOT NULL (CHECK `delivery_mark_corrections_reason_code_check`, Hadi's list, O6a), `actor_account_id` (admin), `corrected_at`, `correlation_id`.

Corrections and reversals are separate insert-only rows, not write-once columns on the mark or the application. The tables stay append-only by privilege alone, and no guard trigger is needed for them.

`shipmentStatus(system, shipmentIds)` (D 6.3) is answered from the unique key of PD9: `accepted` when a row exists. **`refused` cannot be answered**, because a refused command writes nothing (F9).

### 3.11 `ordering.line_cancellations` (M4; D 2.1, 3.2; PD16)

Append-only (`SELECT, INSERT`, O5).

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; the `cancellationId` sent to `inventory.cancelCommittedLine` (IP-1) and in the event |
| `seller_order_id`, `order_line_id` | `uuid` | no | FK `(market_id, order_line_id, seller_order_id)` → `order_lines` |
| `quantity` | `integer` | no | CHECK `>= 1` |
| `reason_code` | `text` | no | Mandatory (ORD-06). CHECK `line_cancellations_reason_code_check` `IN ('out-of-stock', 'damaged', 'cannot-deliver-to-area', 'price-error', 'customer-requested', 'other')`, Hadi's list (O6a) |
| `by_kind` | `text` | no | CHECK `seller`, `admin` (event field `by`) |
| `actor_account_id` | `uuid` | no | O10 |
| `refund_required` | `boolean` | no | PD16. `true` for a plain cancel (seller or admin); `false` for the cancel half of an admin `cancel-and-refund`, whose refund is the same request. CHECK `refund_required = (refund_request_id IS NULL)` |
| `refund_request_id` | `uuid` | yes | FK `(market_id, refund_request_id, seller_order_id)` → `refund_requests` |
| `cancelled_at` | `timestamptz(6)` | no | |
| `correlation_id` | `text` | no | |

- **No `note` column** (Hassan O-5; todo A10): the draft's free-text note is dropped (O8).
- Index `(market_id, seller_order_id, cancelled_at)`: detail and tabs.
- **Not added:** an index on `refund_required`. Whether a cancellation's units are still unrefunded depends on later refunds (D 4.5: a refund takes cancelled units first), which an append-only row cannot record. The queue reads `seller_orders.refund_required_since` (F7).

### 3.12 `ordering.refund_requests` and `ordering.refund_request_lines` (M4; D 2.1, 3.5, 4.8; PD8)

**`refund_requests`**:

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; also the idempotency key sent to `payments.refund` (D 3.5; PD8 "unique key = id") |
| `order_id`, `seller_order_id` | `uuid` | no | FK `(market_id, seller_order_id, currency)` → `seller_orders`; `order_id` is a copy for the per-Order cap and lookups; proved by a second FK `(market_id, seller_order_id, order_id)` → `seller_orders` (unique added) |
| `payment_id` | `uuid` | no | Copy of `orders.payment_id` (D 2.1). Not FK-proved (it would need a third unique key on `orders`); the repository test checks it (6.4) |
| `currency` | `char(3)` | no | O1 |
| `goods_minor`, `fee_share_minor`, `total_minor` | `bigint` | no | D 4.8. `goods_minor` = Σ `gross_minor` of the request's line rows; `fee_share_minor` = Σ `gross_minor` of its charge rows (Ali A4; todo A4; repository test, 6.4). CHECK `refund_requests_total_check` `total_minor = goods_minor + fee_share_minor AND total_minor >= 1` |
| `loss_bearer` | `text` | no | CHECK `seller`, `platform` |
| `loss_reason_code` | `text` | yes | Closed list (O6, O6a; Hadi (c) 1). CHECK `refund_requests_loss_reason_code_check` `loss_reason_code IN ('platform-error', 'carrier-loss', 'seller-unrecoverable', 'fraud-loss', 'goodwill', 'other')` (NULL passes; nullness is the pair CHECK's). CHECK `(loss_bearer = 'platform') = (loss_reason_code IS NOT NULL)` (D 2.1: `platform` needs a reason code). Measured 2026-10-08 (PostgreSQL 16.15, throwaway schema): free text and `platform` without a code refused `23514` |
| `reason_code` | `text` | no | CHECK `refund_requests_reason_code_check` `IN ('not-received', 'damaged', 'wrong-item', 'not-as-described', 'seller-cancelled', 'other')`, Hadi's list (O6a; measured: a free-text value refused `23514`, 10.3). **No `note` column** (Hassan O-5; todo A10) |
| `requested_by_account_id` | `uuid` | no | The admin (O10) |
| `requested_at` | `timestamptz(6)` | no | |
| `state` | `text` | no | CHECK `refund_requests_state_check` `requested`, `submitted`, `not-sent`, `succeeded`, `failed`, `review` (D 3.5; Hassan O-2; todo A12) |
| `not_sent_reason` | `text` | yes | Why `NOT_SENT`: `refused` (a definite synchronous refusal) or `abandoned` (the fenced `abandonRefund` answered `abandoned`, P-7). Written once. CHECK `refund_requests_not_sent_reason_check`: NOT NULL in `not-sent` and `review`; NULL in `requested`, `submitted`; kept on a `succeeded` or `failed` reached from `review` (F13), where it marks the request as one that needs the resolution triple (below) |
| `payments_refund_id` | `uuid` | yes | `payments`' refund id (never the provider's own id: `payments` owns provider ids). Written once. CHECK `refund_requests_refund_id_check`: NOT NULL in `submitted`, `succeeded`, and in a `failed` reached from `submitted`; in `review` it is written when the refund is seen or confirmed; a `failed` reached from `review` with outcome `not-found` has none (F13) |
| `refund_confirmed_at`, `refund_confirmed_outcome` | `timestamptz(6)`, `text` | yes | **The stored provider confirmation** the admin's resolution needs (D 3.5, F13): written by `ordering.watch-refunds` (system actor) from `payments.refundByKey`, only while the request is in `review`, so the admin request makes no elevated call. Outcome CHECK `succeeded`, `failed` (the provider's refund failed), `not-found` (no refund exists for the key). CHECK `refund_requests_confirmed_check`: both or neither; only on a request that went through `not-sent`; `succeeded` only with `payments_refund_id`. **Write rule (trigger):** set from NULL; `succeeded` and `failed` are then final; `not-found` may be replaced by a later re-check (`succeeded` or `failed`, with a later `refund_confirmed_at`) while the request stays in `review`, so a refund that appears late flips the confirmation before the admin can close it as `failed` |
| `resolved_by_account_id`, `resolution_reason_code`, `resolved_at` | `uuid`, `text`, `timestamptz(6)` | yes | The admin's `REVIEW` resolution, to `SUCCEEDED` (D 3.5; Hassan O-7) or to `FAILED` (D 3.5, F13). Written once, together. CHECK `refund_requests_resolution_check`: all three or none; present exactly on a `succeeded` or `failed` that went through `not-sent`; `succeeded` only with outcome `succeeded`; `failed` only with outcome `failed` or `not-found` (written NULL-safe: `IS NOT DISTINCT FROM` and `coalesce(… IN …, false)`; the plain form let a `failed` with no confirmation through, measured 10.3). `resolution_reason_code` is a closed list (O6, O6a; Hadi (c) 2): CHECK `refund_requests_resolution_reason_code_check` `resolution_reason_code IS NULL OR (state = 'succeeded' AND resolution_reason_code IN ('refund-confirmed-at-provider', 'matched-manually')) OR (state = 'failed' AND resolution_reason_code IN ('refund-failed-at-provider', 'no-refund-found'))`; NULL-safe by its first branch (`state` is NOT NULL). Measured 2026-10-08: a `succeeded` code on `failed`, a `failed` code on `succeeded`, a code on `review` and `other` refused `23514`; both valid pairs accepted |
| `state_changed_at` | `timestamptz(6)` | no | |
| `version` | `integer` | no | C5 |
| `correlation_id` | `text` | no | |

- **Guard trigger** `refund_requests_write_once` (O16): content immutable (PD8); `payments_refund_id`, `not_sent_reason`, `refund_confirmed_at` and the resolution triple written once; state moves only `requested` → `submitted`, `not-sent`; `submitted` → `succeeded`, `failed`; `not-sent` → `review`; `review` → `succeeded`, `failed` (F13, accepted in D 3.5: admin `ordering.refund.execute`, protected, second factor; no counter change, the locks were released at `NOT_SENT`). `succeeded` and `failed` are terminal. The confirmation follows the write rule above. Measured (10.2, 10.3): every other move refused `23001`, including `not-sent` → `requested` (a re-send); `review` → `failed` accepted only with the resolution and a `failed` / `not-found` confirmation (10.3).
- Grant `UPDATE (state, payments_refund_id, not_sent_reason, refund_confirmed_at, refund_confirmed_outcome, resolved_by_account_id, resolution_reason_code, resolved_at, state_changed_at, version)`: still state fields only (todo A12); content `UPDATE` refused `42501`.
- Indexes: `(market_id, seller_order_id, requested_at)` (Refunds tab; the cumulative fee share of D 4.8 reads the earlier requests of the sub-order); `(market_id, order_id, state)` (the per-Order cap: Σ `total_minor` of `requested`/`submitted`/`succeeded` requests of the Order); partial `(market_id, requested_at) WHERE state = 'requested'` (`ordering.watch-refunds`, D 11); partial `refund_requests_market_id_state_changed_at_review_idx (market_id, state_changed_at) WHERE state = 'review'` (the refund `REVIEW` queue and the job's `refundByKey` re-check).
- A refund `REVIEW` holds no lock: its positions were released at `NOT_SENT`. Its resolution to `SUCCEEDED` takes the positions again in the settle unit, and the adjustment note's `invoice_lines_positions_excl` refuses it (`23P01` → `ordering.refund.positions-taken`) if a later request already refunded them.

**`refund_request_lines`** (`SELECT, INSERT`, O5): `id uuid` PK; `refund_request_id` with FK `(market_id, refund_request_id, seller_order_id)` → `refund_requests` (unique added there); `seller_order_id` copy; then either a line row or a charge row:
- **Line row:** `order_line_id` (FK `(market_id, order_line_id, seller_order_id)` → `order_lines`), `kind` CHECK `cancel-and-refund`, `refund`, `quantity >= 1`, `position_from >= 0` (the refunded positions `[p, p + q)`, D 4.8).
- **Charge row:** `charge_id` with `charge_gross_minor` (FK `(market_id, charge_id, seller_order_id, charge_gross_minor)` → `seller_order_charges (market_id, id, seller_order_id, tax_gross_minor)`, as invoice lines) and the cumulative range `cumulative_before_minor`, `cumulative_after_minor` of the fee gross refunded or locked (D 4.8; todo A3).
- **Both:** `gross_minor`, `tax_minor`, `net_minor` (todo A4; Ali A4): the amounts `tax.reverseRefundTax` (TX-3) returned for exactly these positions or this range, frozen at `REQUESTED`; CHECK `refund_request_lines_amounts_check` bounds and gross = net + tax. The draft's per-row `goods_minor` is replaced by `gross_minor`.
- Shape CHECKs as invoice lines (O14): `refund_request_lines_target_check` (exactly one of line, charge), `refund_request_lines_line_check`, `refund_request_lines_charge_check` (`0 <= before < after <= charge gross`, `gross_minor = after − before`). Measured: a line without `kind`, a charge row without `before`, gross ≠ net + tax, `after` above the gross, a charge of another sub-order: all refused.
- Unique `(market_id, refund_request_id, order_line_id)` and `(market_id, refund_request_id, charge_id)`, as invoice lines.
- **No EXCLUDE here** (todo A3 asked for one on both tables; finding F16): a `NOT_SENT` or `FAILED` request releases its positions and range, and the admin's next request takes **the same** positions again with a new key (D 3.5). An exclusion over all request lines would refuse that legitimate retry (measured: adding it to a table with one not-sent and one retried request fails `23P01`). The rows that must never overlap are the **adjustment-note lines** (`invoice_lines` in `refunded` space), which exist only for `SUCCEEDED` requests and carry both EXCLUDEs. The locks of live requests are held by the counters (`qty_refund_locked`, 3.6) under the Order and sub-order locks (6.1).

### 3.13 `ordering.saved_addresses` (M6; Ali T6 A, own slice after slice 3; PD15)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `customer_account_id` | `uuid` | no | Identifier |
| `slot` | `smallint` | no | 1..n. CHECK `BETWEEN 1 AND 100`: a technical ceiling, not the Market limit (O13) |
| `address_ciphertext` | `text` | no | **Personal, encrypted**, customer subject (5): the address and the customer's optional label ("Home"), one JSON value. The label is free text the customer types, so it is not stored in clear (O8; Hassan O-5). Bound 16384 |
| `last_used_at` | `timestamptz(6)` | yes | |
| `created_at` | `timestamptz(6)` | no | |

- **At most N per account** (PD15), option chosen: unique `saved_addresses_market_id_customer_account_id_slot_key`. The use case picks the lowest free slot ≤ `ordering.maxSavedAddresses` (Market policy). Two concurrent saves pick the same slot and one gets `P2002` → retry, which then finds no free slot within N and refuses. No lock, no count, no `serializable`. The alternative, a count under a lock, needs a per-account row to lock, which `ordering` does not have.
- Its prefix serves the list.
- Grant `SELECT, INSERT, UPDATE (address_ciphertext, last_used_at), DELETE` (customer delete; erasure handler deletes all of an account's rows, PD13).
- It is **not** read by placement as a copy source after the order: `orders.delivery_address_ciphertext` is its own copy (D 2.1).

### 3.14 `ordering.orphan_facts` (M1; D 3.3, 3.5, PD19; Hassan O-2, O-3, O-7; todo A13)

One row per payment or refund event that `ordering` must not act on by itself and that an admin resolves from the `REVIEW` queue. Ids and codes only, **no amount** (PD19).

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `kind` | `text` | no | CHECK `payment`, `refund` |
| `cause` | `text` | no | CHECK `payment-id-mismatch` (the event's `paymentId` is not the Checkout's, ADR-0035 decision 7), `refund-key-unknown` (a refund event whose key matches no request and no compensation, D 3.5), `event-in-review` (a money event for a Checkout in `REVIEW`: "fact recorded on the review item", D 3.3), `event-after-terminal` (a money event for a Checkout in a terminal state, F14) |
| `event_id` | `uuid` | no | The consumed event's id. Unique `orphan_facts_market_id_event_id_key`: one fact per event, also under an inbox replay (measured `23505`) |
| `event_type` | `text` | no | CHECK `^payments\.[a-z0-9-]+\.v[1-9][0-9]*$` |
| `payment_id` | `uuid` | yes | From the event (C4). Required on `payment` facts |
| `order_id` | `uuid` | yes | From the event when it names one; links the fact to the `REVIEW` item. Plain id, **no FK** (a fact may name an order or checkout that does not exist, and the prune must never meet a reference) |
| `refund_key` | `text` | yes | The refund key as `payments` sent it (a request id or `compensation:<paymentId>`). CHECK `^[A-Za-z0-9:_-]{1,128}$`; required on `refund` facts |
| `seen_at` | `timestamptz(6)` | no | Handler's `Clock` |
| `resolved_by_account_id`, `resolution_reason_code`, `resolved_at` | `uuid`, `text`, `timestamptz(6)` | yes | "Close as handled" after the `paymentOf` check (D 3.3, O-7). Written once, all three together, `resolved_at >= seen_at`. CHECK `orphan_facts_resolution_reason_code_check` `IN ('handled-at-provider', 'provider-refunded', 'duplicate-event')` (Hadi's checkout-review list, O6a) |

- **F14 needs no new storage**: `event-after-terminal` is already a `cause` value from M1's first migration; the handler inserts the fact in its `runOnce` unit and the Checkout row is not updated (its trigger would refuse it anyway). The fact's `order_id` links it to the terminal Checkout's order when the event names one; `REJECTED`/`ABANDONED` Checkouts have no order, so such a fact carries the event's ids only.
- CHECK `orphan_facts_shape_check`: a `payment` fact has `payment_id`, no `refund_key`, and a cause other than `refund-key-unknown`; a `refund` fact has `refund_key`.
- Guard function `ordering.orphan_facts_guard()` (O16) on `BEFORE UPDATE`, `BEFORE DELETE` (row) and `BEFORE TRUNCATE`: content immutable, resolution written once, no delete, for every role (measured `23001`).
- Grant `SELECT, INSERT, UPDATE (resolved_by_account_id, resolution_reason_code, resolved_at)`. Resolution is one guarded statement, `updateMany where { marketId, id, resolvedAt: null }` (one row or none; no `version`, as `tax.threshold_alerts` 3.2).
- Indexes: partial `orphan_facts_market_id_seen_at_open_idx (market_id, seen_at, id) WHERE resolved_at IS NULL` (the open facts in the admin `REVIEW` queue, keyset); partial `orphan_facts_market_id_order_id_idx (market_id, order_id) WHERE order_id IS NOT NULL` (the facts of one `REVIEW` item on its detail page).
- Volume: a handful a month, from provider or payments bugs only. Kept (an audit trail of money anomalies; ids only, no personal data).
- Alternative considered: columns on `checkouts` and `refund_requests`. Rejected: an orphan by definition has no matching row, and one Checkout can collect several facts.

## 4. What is never stored

| Never in the database | Instead |
|---|---|
| pricing Cost, in any form | Nothing (ADR-0024; AC 16). No Cost column exists, and the contracts test covers events |
| A seller tax number or legal identity on `seller_orders` | Read at invoice issue and stored encrypted on the invoice only (Ali G2-2) |
| The delivery address, recipient name, phone, postcode or region in clear | `orders.delivery_address_ciphertext`; clear only the zone and ServiceArea code |
| The customer's email | `identity`, read at send time (D 4.9) |
| A plain or unkeyed hash over any personal field | None (Hassan O-4). `checkouts.request_hash` is an HMAC under the customer subject; `invoices.content_hash` an HMAC under the per-invoice subject; `orders.quote_fingerprint` covers no personal field and stays SHA-256 (O15) |
| Free text (notes, comments, labels in clear) | Reason codes from closed lists (O6, O8; Hassan O-5). The saved-address label is inside the encrypted address |
| An amount in an orphan fact | Ids and codes only (3.14) |
| The provider's own refund or payment id | `payments`' ids only (`payments_refund_id`, `payment_id`) |
| GST arithmetic results that `tax` did not return | Only `tax`'s answers are stored (D 4.4); `ordering` sums gross amounts |
| Commission amounts | C-P (D 4.4); only the rate |
| Stock numbers (`inventory.insufficient` reason details) | Answered, not stored |
| Card or provider client data | `payments` |
| A stored `closed` status | Derived at read time (F4) |
| Personal data in `outbox`, `inbox`, histories, logs | Ids, codes, instants |

## 5. Encryption at rest (PD10)

| Column | Subject (`SubjectKeyService`) | Label | Unwraps per read |
|---|---|---|---|
| `orders.delivery_address_ciphertext` | Customer account id | `ordering.order.delivery-address` | Customer detail 1; **seller: only `ordering.view-seller-order-recipient`, 1** (+ audit row `ordering.recipient-data.read`, D 5.2); admin detail 1 (+ the audit row `ordering.customer-data.read`, D 8); **all lists 0** (F10) |
| `invoices.seller_identity_ciphertext` | **Per-invoice subject** (kind `ordering-invoice`, id = `invoices.id`; 3.9) | `ordering.invoice.seller-identity` | Document render 1 |
| `invoices.buyer_identity_ciphertext` | Per-invoice subject | `ordering.invoice.buyer-identity` | Document render 1 |
| `saved_addresses.address_ciphertext` | Customer account id | `ordering.saved-address.address` | List of the customer's own addresses: up to N (one key, one unwrap of the key, N decryptions) |

Keyed hashes (O15): `checkouts.request_hash` (customer subject, purpose `ordering.checkout.request`), `invoices.content_hash` (per-invoice subject, purpose `ordering.invoice.content`).

- Bound to its label (PF 4 row 2): a value copied to another column or row does not decrypt.
- **Recipient data (Hassan O-6; todo A11).** A seller unwraps the customer's subject only in `ordering.view-seller-order-recipient`, after the ownership check, for a paid sub-order, and only until `recipientVisibleFor` after `CLOSED` (D PD20). **No new column:** the window is a read-time predicate on the loaded sub-order, `paid_at IS NOT NULL AND NOT (closed AND last_delivered_at + closeAfter + recipientVisibleFor <= now)`, with `closed` as F4. **0 decryptions per list page, confirmed:** the seller list (Q5) reads `seller_orders` only, which has no address column; the customer (Q4) and admin (Q6) lists read `orders` with an explicit Prisma `select` that omits `delivery_address_ciphertext` (no `SELECT *`, so the value is not even detoasted). A repository test captures the SQL of every list query (Prisma query events) and asserts that `delivery_address_ciphertext` appears in none, and that the recipient use case is the only seller path whose SQL selects it. **Audit volume** of `ordering.recipient-data.read` (one row per decryption, no value): at the 9.1 upper bound, 10³ paid orders × 1.5 sub-orders × about 3 detail views a day ≈ 4.5 × 10³ rows a day, 1.6 × 10⁶ a year. That alone exceeds platform.md 4's estimate for the whole `audit_log` (under 10⁶ a year); the platform note (C2) carries the revised figure.
- **Customer erasure (Ali A2, a CUS-03 design rule; todo A17).** Erasure waits until the customer has no unshipped sub-order in the Market. The check, one read with no new index:

  ```
  SELECT s.id FROM ordering.seller_orders s
   WHERE s.market_id = $1
     AND (s.market_id, s.order_id) IN (SELECT o.market_id, o.id FROM ordering.orders o
                                        WHERE o.market_id = $1 AND o.customer_account_id = $2)
     AND (s.display_status IN ('pending', 'processing', 'invoiced') OR (s.display_status = 'shipped' AND s.display_partial))
   LIMIT 1
  ```
  Prisma: `orderingSellerOrder.findFirst({ where: { marketId, order: { is: { customerAccountId } }, OR: [...] }, select: { id: true } })` through the four-column relation (S1). "Unshipped" is read from the stored derived status (`pending`: the order is not paid yet; `processing`, `invoiced`, or `shipped` with `partial`), which `SellerOrderStatusDeriver` keeps exact in every unit (D 3.2); Mohammad confirms that this set is the CUS-03 meaning of "unshipped". **Measured** (10.2, 4 × 10⁵ orders, 6 × 10⁵ sub-orders): a customer with 10 orders 0.33 ms, 47 buffers; a customer with 500 orders 5.2 ms, 2,490 buffers; the same predicate on `seller_orders.customer_account_id` alone, with no index, is a parallel seq scan of 64 ms. **Not added:** an index on `seller_orders (market_id, customer_account_id)`: erasure is rare, and the `orders` index already serves it.
- **Tax-record retention still applies** (Ali A2): erasure destroys the customer's subject (order addresses, saved addresses, `request_hash` verification) but never an `ordering-invoice` subject, so a retained invoice keeps the buyer identity it was required to carry until the AG-12 job (9.3).

## 6. Locking, statement order and isolation

### 6.1 Lock order (one rule for every unit)

**`checkouts` → `orders` → `seller_orders` (ascending `id`) → `order_lines` (ascending `id`) → `invoice_sequences` → inserts (children, histories, outbox).** Every unit raises the version of each root it changes as its **first** statement on that root (PRC-data P7): `UPDATE … SET version = version + 1 WHERE market_id = $1 AND id = $2 AND version = $expected` (Prisma `updateMany`, one row or none → `conflict.stale`). A concurrent writer waits on that row and then finds the version stale; it never reaches the counter CHECKs. No unit locks in another order, so the module has no deadlock cycle among its own units.

| Unit (D) | Statements, in order |
|---|---|
| P2 create (supersede included) | Old checkout: guarded state update (version) **before** the insert of the new one, because the slot key is immediate (measured: the reverse order fails `23505`) → insert checkout → history |
| P4 create order | Checkout version + `reservation_id`, `expires_at`, state → insert `orders` → `seller_orders` → charges → lines → histories |
| P5 store payment | Checkout `payment_id`, state → order `payment_id` (the FK needs the checkout's value first) |
| `payment-succeeded` (PAID) | Checkout → order (`paid`, `paid_at`) → each sub-order (`paid_at`, `display_status`, version) → histories → outbox `order-paid` |
| Seller operations (invoice, cancel, ship, deliver), admin correction, reversal | Sub-order version → lines' counters (`updateMany` per line; the CHECKs are the backstop) → `invoice_sequences` (invoice only) → the record and its lines → sub-order derived columns (same row, already locked) → history → outbox |
| Refund request (D 3.5) | **Order version first** (F11: serialises refunds of one Order for the per-Order cap) → sub-order version → lines `qty_refund_locked` (+ `qty_cancelled` for `cancel-and-refund`) → insert request, lines, cancellation → history → outbox |
| Refund settled / failed / not sent | Sub-order version → lines (`locked` → `refunded`, or released) → request state (+ adjustment note with its sequence, F12) → history → outbox |
| Refund `not-sent` → `review`; job stores or replaces the confirmation | Request state or `refund_confirmed_*` (version) → orphan or audit rows; no counter changes (D 3.5) |
| Refund `review` → `failed` (admin, F13) | Request state, resolution (version) → history → audit (no outbox event: D 3.5 emits none for `FAILED`); no Order or sub-order lock and no counter change (the positions were released at `NOT_SENT`). The job's confirmation update raises the same version, so a resolution racing a re-check fails `conflict.stale` and re-reads |
| Refund `review` → `succeeded` (admin) | **Order version first** (as the creating unit: the positions are taken again) → sub-order version → lines (`refunded`) → request state and resolution → adjustment note with its sequence → history → outbox. `23P01` on the note's lines → refused `ordering.refund.positions-taken`, the request stays `review` |
| Checkout `REVIEW` resolution (admin) | Checkout version (state; re-drive also `next_attempt_at`) → order (`cancelled`, `review-closed`, only if still unpaid) → history row with the resolution → audit |
| Orphan fact recorded (handler) / resolved (admin) | One insert inside the handler's `runOnce` unit / one guarded update (3.14) |
| Prune (job) | One `DELETE` per batch; the cascade removes the history (3.7) |

### 6.2 Why the counters need no explicit lock

The version-guarded update of the sub-order is the lock. Two invoices on one sub-order: the second waits on the row, then finds the version changed and fails `conflict.stale` (AC 11). An invoice against a cancellation: the same. The counter CHECKs (3.6) stop any path that forgot the version. The unit positions of the next document are read after the lock (READ COMMITTED: a new statement sees the committed counters).

### 6.3 Isolation: no serializable unit

I agree with D 9. Each cross-row rule has a holder:

| Rule | Holder |
|---|---|
| One active checkout per account | Partial unique key (3.2) |
| Placement idempotency | Unique key (3.2) |
| Gap-free invoice numbers | Row lock in the issuing unit (3.8, measured) |
| Quantities per line | Sub-order row (6.2) + CHECKs |
| Refund cap per Order across sub-orders | Order row (F11) |
| One shipment application per shipping id; one reversal per application; one correction per mark | Unique keys |
| At most N saved addresses | Slot unique key (3.13) |
| No unit position invoiced twice, or refunded twice | `invoice_lines_positions_excl` (3.9) |
| The fee invoiced once; no part of the fee refunded twice | `invoice_lines_charge_ranges_excl` (3.9) |
| One orphan fact per event | Unique key (3.14) |

### 6.4 Invariants the database does not carry

| Invariant | Why not | Enforced by |
|---|---|---|
| Order payable = Σ sub-order payable; sub-order goods = Σ line gross; order tax = Σ line and charge tax | Across rows; a deferred constraint trigger would surface at `COMMIT`, away from the statement | The factories (D 2.1) and a repository test that re-sums every fixture order, AU and ZZ |
| `display_status`, `display_partial`, `refund_required_since`, `last_delivered_at` agree with the counters and child rows | Derived | `SellerOrderStatusDeriver` in the same unit; a repository test after every operation |
| The checkout state graph; the sub-order operation guards (D 3.2 table) | Behaviour | `CheckoutStateMachine`, `LineQuantities`; the triggers carry only terminal states and write-once columns |
| `refund_requests.payment_id` equals the order's | Would need a third unique key on `orders` | Repository test |
| `refund_requests.goods_minor` = Σ line-row `gross_minor`; `fee_share_minor` = Σ charge-row `gross_minor`; the adjustment note's amounts equal the request's (D 4.8) | Across rows | `RefundCalculator`, the settle unit's comparison, and a repository test |
| A request's line positions and charge range do not overlap another **live** request's | Live is a state of another table; released requests reuse positions (F16) | Counters under the Order and sub-order locks (6.1); the note EXCLUDEs at `SUCCEEDED` |
| A line's tax answer belongs to this line (beyond the base CHECK, X3) | `tax` data | Factory; contract test with fake `tax` |
| Every line's `tax_seller_registered` equals the sub-order's | Across rows | Factory |
| Market limits (line ceiling, N addresses, reversal window, close-after) | O13 | Policies |
| Ids of other modules exist | No cross-module FK | Facades |

### 6.5 Access paths (the real queries)

All Prisma, `marketId` at the top level, unnamed statements (platform.md 10.9: the partial indexes below rely on custom plans). Lists use keyset pagination on `(timestamp DESC, id DESC)`; no `OFFSET`.

| # | Query | Index |
|---|---|---|
| Q1 | Placement replay: by (Market, account, key) | `checkouts_…_idempotency_key_key` |
| Q2 | Active checkout of the account (P2) | `checkouts_…_slot_key` |
| Q3 | Payment handler: checkout and order by `orderId` | `checkouts_market_id_order_id_key`, `orders_pkey` |
| Q4 | Customer history | `orders_market_id_customer_account_id_placed_at_idx` |
| Q5 | Seller list (+ optional status filter) | `seller_orders_market_id_seller_id_paid_at_idx` (measured: 26 rows, 29 buffers, 0.10 ms; status filter over a 300-row range, 307 buffers, 0.40 ms; 3 × 10⁵ rows) |
| Q6 | Admin list (+ stored status) | `orders_market_id_placed_at_idx`, `orders_market_id_status_placed_at_idx` |
| Q7 | Detail: order, sub-orders, lines, charges, children | PK and the `(market_id, <parent>_id, …)` prefixes of section 3 |
| Q8 | Refund-required queue and alert | `seller_orders_market_id_refund_required_since_idx` |
| Q9 | Expiry job candidates: `state IN (reserved, awaiting-payment) AND expires_at <= $now − grace`, `LIMIT 100` | `checkouts_market_id_expires_at_awaiting_idx` |
| Q10 | Advance job: `next_attempt_at <= $now`, `LIMIT 100` | `checkouts_market_id_next_attempt_at_due_idx` |
| Q11 | REVIEW queue | `checkouts_market_id_state_changed_at_review_idx` |
| Q12 | Watch refunds: `state = 'requested' AND requested_at <= $now − timeout` | `refund_requests` partial index |
| Q13 | `financialFactsOf` by order, invoice, cancellation, refund ids (≤ 100) | PKs; lines by `seller_order_id` prefix |
| Q14 | `applyShipment` idempotency; `shipmentStatus` | `shipment_applications_market_id_shipment_id_key` |
| Q15 | `turnoverOf` (P1) | 3.9.1 |
| Q16 | Per-Order refund cap | `refund_requests (market_id, order_id, state)` |
| Q17 | P2: the account's `REVIEW` Checkout entered from `AWAITING_PAYMENT` (O-9) | `checkouts_market_id_customer_account_id_review_awaiting_idx` (measured, 3.2) |
| Q18 | Customer erasure: any unshipped sub-order (A2) | `orders_market_id_customer_account_id_placed_at_idx`, then `seller_orders_market_id_order_id_seller_id_key` (measured, 5) |
| Q19 | `sellersWithSupplies` (P1, T8) | M8 index (measured, 3.9.1) |
| Q20 | Open orphan facts; facts of one `REVIEW` item | `orphan_facts` partial indexes (3.14) |
| Q21 | Refund `REVIEW` queue; the job's re-check | `refund_requests_market_id_state_changed_at_review_idx` |
| Q22 | Prune candidates | `checkouts_market_id_state_changed_at_prunable_idx` (M7) |
| Q23 | Recipient read (O-6) | `orders_pkey` after the sub-order's ownership read; the only seller query that selects the address (5) |
| Q24 | `ordering.reconcile-first-sales` (D 11): per seller with a paid sub-order, the earliest `paid_at` and that sub-order's `order_id`, keyset by `seller_id`, 100 sellers per batch | `seller_orders_market_id_seller_id_paid_at_idx` (measured 10.3: 2.8 ms, about 700 buffers per batch at 6 × 10⁵ sub-orders; plan in 9.3) |

**Deliberately not added:** a status index on `seller_orders` (a seller's range is small; measured); a `(market_id, seller_id)` index on `invoices` beyond the unique sequence key until TX-4; an index on `checkouts.payment_id` (11.2 P1); any index on a counter or on `display_status` (HOT updates); a full-text index on orders (no search in D; ORD-03's admin search by order id uses the PK); `seller_orders (market_id, customer_account_id)` (Q18 is served through `orders`); an `(market_id, issued_at, seller_id)` index for Q19 (3.9.1); an `invoices (market_id, issued_at)` index for the invoice-identity retention job (it selects through the key service, 9.3); an `INCLUDE (order_id)` on the seller-list index or a `(market_id, seller_id, paid_at ASC)` index for Q24 (one heap fetch per seller, 100 per batch, for an hourly job: a wider index costs every PAID unit and the seller list for no measured need).

**Prisma keyset shape** (`OR: [{ paidAt: { lt } }, { paidAt: x, id: { lt } }]`) was not measured; the row comparison above was (11.4 S1).

## 7. Grants

Under platform.md 10.2: hand-written in the `migration.sql` that creates each table, in the block `-- Grants (database-designer): docs/design/data/ordering.md section 7`, to `mondapac_app` only, mirrored by `REVOKE` in `down.sql` before any `DROP`. `GRANT USAGE ON SCHEMA "ordering"` in M1. No sequence. Trigger functions get no grant.

| Table | Privileges of `mondapac_app` | Reason |
|---|---|---|
| `outbox` | `SELECT, INSERT, UPDATE (published_at)` | PM2 |
| `inbox` | `SELECT, INSERT` | Prune job later |
| `checkouts` | `SELECT, INSERT, UPDATE (state, review_from_state, cause, reject_code, reservation_id, expires_at, payment_id, attempts, next_attempt_at, last_error_code, compensation_kind, compensation_refund_id, compensation_status, version, state_changed_at)`; `DELETE` from M7 | PD14; prune of terminal rows without an order (9.2) |
| `orders` | `SELECT, INSERT, UPDATE (status, cancel_cause, payment_id, paid_at, version)` | Snapshot immutable (PD1); no `DELETE` (PD13, PD18) |
| `seller_orders` | `SELECT, INSERT, UPDATE (paid_at, display_status, display_partial, last_delivered_at, refund_required_since, version)` | PD12 |
| `order_lines` | `SELECT, INSERT, UPDATE (qty_cancelled, qty_invoiced, qty_shipped, qty_delivered, qty_refunded, qty_refund_locked)` | PD5 |
| `invoice_sequences` | `SELECT, INSERT, UPDATE (last_number)` | PD6 |
| `refund_requests` | `SELECT, INSERT, UPDATE (state, payments_refund_id, not_sent_reason, refund_confirmed_at, refund_confirmed_outcome, resolved_by_account_id, resolution_reason_code, resolved_at, state_changed_at, version)` | PD8; state fields only (todo A12) |
| `orphan_facts` | `SELECT, INSERT, UPDATE (resolved_by_account_id, resolution_reason_code, resolved_at)` | PD19; no `DELETE` |
| `saved_addresses` | `SELECT, INSERT, UPDATE (address_ciphertext, last_used_at), DELETE` | PD13, PD15 |
| `seller_order_charges`, `invoices`, `invoice_lines`, the three histories, `shipment_applications`, `shipment_application_lines`, `shipment_reversals`, `delivery_marks`, `delivery_mark_lines`, `delivery_mark_corrections`, `line_cancellations`, `refund_request_lines` | `SELECT, INSERT` | Append-only or immutable (PD2, PD7) |

Measured (10, 10.2): column grants refuse `quantity`, `order_id`, `seller_order_charges.tax_inclusive`, `refund_requests.goods_minor`, an orphan fact's content, and every invoice `UPDATE`/`DELETE` with `42501`. Column-level `UPDATE` meets the four conditions of 10.2. `checkout_status_history` rows go only by cascade (no grant needed; its guard admits only that, 3.7).

## 8. Migration plan

### 8.1 Order (one migration PR open at a time, `docs/process/parallel-tracks.md` rule 6; Phase 5 shares the slot with payments, C-P, tax and shipping: announce on the board)

| # | Slice | Migration | Contains |
|---|---|---|---|
| M1 | 2 | `ordering_checkout_orders` | `CREATE SCHEMA "ordering"`, `USAGE`; `outbox`, `inbox`, `checkouts`, `checkout_status_history`, `orders`, `order_status_history`, `seller_orders`, `seller_order_charges` (with `tax_inclusive`), `order_lines`, `seller_order_history`, **`orphan_facts`** (slice 3 needs it and has no migration); every CHECK (all Saga states, causes including `review-closed` and `superseded` on `abandoned`, the widened `review_from_state`, the three tax treatments and their backstops, the reason-code lists slice 3 needs), the partial indexes (with the O-9 index), `reject_mutation()`, `checkout_status_history_guard()`, `orphan_facts_guard()` and the four write-once guard functions and triggers (O16); grants. `base.prisma` gains `"ordering"` in `schemas` (shared file, this PR). Slice 1 (domain only) has no migration. **Needs before merge:** the `SubjectKeyService.hmac` purpose `ordering.checkout.request` (PL-3) and the slice 3 reason-code lists (11.5 Q1) |
| — | 3 | None | The Saga uses M1's columns and indexes |
| M2 | 5 | `ordering_invoices` | `invoice_sequences`, `invoices` (without the `refund_request_id` FK; `required_fields text[]`; `content_hash` HMAC), `invoice_lines` with both EXCLUDEs and the charge-gross FK; triggers; grants. **Needs before merge:** the `ordering-invoice` subject kind in `platform.subject_keys` (platform note C3) |
| M3 | 6 | `ordering_shipments` | `shipment_applications`, its lines, `shipment_reversals`; grants |
| M4 | 7 | `ordering_cancellations_refunds` | `refund_requests` (six states, `not_sent_reason`, confirmation and resolution columns, review index), `refund_request_lines` (gross/tax/net, charge ranges, no EXCLUDE), `line_cancellations` (no `note`); the trigger; `ALTER TABLE invoices ADD CONSTRAINT invoices_refund_request_id_fkey` (`invoices` may hold rows: added `NOT VALID`, then `VALIDATE`, 8.2); grants; the `review` → `failed` transition and `refund_confirmed_outcome` (F13, 3.12); Hadi's refund and cancellation CHECKs (O6a). **Needs before merge:** the payments G2's fenced `abandonRefund` (P-7) and Hadi's loss and refund-resolution lists (11.5 Q1) |
| M5 | 8 | `ordering_delivery` | `delivery_marks`, its lines, `delivery_mark_corrections`; grants |
| M6 | Address-book slice (after 3, Ali T6) | `ordering_saved_addresses` | `saved_addresses` (no clear `label`); grants. Then the erasure handler |
| M7 | With the checkout prune, before the first deployed environment (Ali A1) | `ordering_checkout_prune` | Partial index `checkouts_market_id_state_changed_at_prunable_idx (market_id, state_changed_at) WHERE state IN ('rejected','abandoned')`; `GRANT DELETE ON "ordering"."checkouts"`. If `checkouts` already holds more than about 10⁵ rows in any deployed environment, the index is `CREATE INDEX CONCURRENTLY` in its own hand-written migration (8.2) |
| M8 | TX-4 (P1, tax slice 6) | `ordering_invoice_turnover_index` | 3.9.1 index, serving both `turnoverOf` and `sellersWithSupplies`. `invoices` is live by then: `CREATE INDEX CONCURRENTLY`, alone, outside a transaction, `SET lock_timeout` first |
| M9 | SEL-08 | `ordering_acting_as` | Nullable `acting_as_account_id` on the histories and V4 children (O10); guard functions `CREATE OR REPLACE` |

Slices 2, 5 and 7 being in different PRs means M2 lands only after the tax agent's written confirmation (Q1), like slice 5 itself.

### 8.2 Reversibility and safety

- Every `down.sql` mirrors its up in reverse: `REVOKE`s first, then triggers, then tables children before parents (lines before sub-orders before orders before checkouts; histories before their roots), then functions, then (M1) `REVOKE USAGE ON SCHEMA`; the empty schema stays (ID-data 8.2). M4's down drops `invoices_refund_request_id_fkey` before `refund_requests`. No `IF EXISTS`. `pnpm db:check-reversible` runs up → down → up.
- M1 to M6 create new tables: no backfill. M4's added FK on `invoices`, M7's and M8's indexes, M9's columns can meet live rows:
  - FK: `ADD CONSTRAINT … NOT VALID` (brief `SHARE ROW EXCLUSIVE` lock, `SET lock_timeout = '5s'`), then `VALIDATE CONSTRAINT` (`SHARE UPDATE EXCLUSIVE`, does not block inserts).
  - Index on a table with more than about 10⁵ rows in any deployed environment: `CREATE INDEX CONCURRENTLY` alone in a hand-written migration, outside a transaction, `SET lock_timeout` first (PRC-data 8.2). Otherwise plain.
  - Columns: nullable, no default: metadata only.
- A new CHECK value later (a cause, an operation, a charge kind, a reason code, a required-field code): drop and re-add the CHECK as `NOT VALID` + `VALIDATE` in one migration with `lock_timeout`. `NOT VALID` takes a brief `ACCESS EXCLUSIVE` lock without scanning; `VALIDATE` scans under `SHARE UPDATE EXCLUSIVE` and blocks no insert.
- My sign-off per migration: platform.md 8 checklist, the five points of 10.2, the hand-written block equal to this document, and the catalog tests changed in the same PR.

### 8.3 Seed data

None. The Market values (line ceiling, reservation duration from `inventory`, `expiryGrace`, step budget, `closeAfter`, `refundSendTimeout`, `refundTargetTime`, `cartClearWindow` 7 days, `shipmentReversalWindow` 90 days, `maxSavedAddresses`) are `config/markets/*.json` keys validated at start-up; ZZ gets different values. **Boot check** (Ali G2-4): `inventory`'s committed-reservation retention (R1, 120 days) ≥ `shipmentReversalWindow` + 30 days, for every hosted Market; fail start-up otherwise. Shared-file PR announced on the board.

### 8.4 Prisma specifics

- `prisma/schema/ordering.prisma`, models named by O12, `@@schema("ordering")`. Types: `BigInt`, `Decimal` (`@db.Decimal` without precision maps to `numeric`), `@db.Char(3)`, `@db.Timestamptz(6)`, `@db.Uuid`, `@db.VarChar(8)`, `@db.JsonB`, `Bytes`, `@db.Date`, `@db.SmallInt`.
- **Prisma declares:** tables, keys, non-partial unique keys and indexes, and the composite relations. The four-column relation `seller_orders → orders` and the three-column ones are **not measured** on Prisma 7 (INV-data S1 covers three columns; four is new). Fallback if Prisma refuses: the four-column FK hand-written in the marked block (it is then drift Prisma ignores, as partial indexes are).
- **Hand-written** in marked blocks: every CHECK; the partial indexes (`*_slot_key`, `*_awaiting_idx`, `*_due_idx`, `*_review_idx`, `*_review_awaiting_idx`, `*_paid_at_idx`, `*_refund_required_since_idx`, the refund `requested` and `review` indexes, the two `orphan_facts` indexes, `outbox_…_unpublished_idx`, M7's); the two EXCLUDEs; the functions and triggers; the grants. The catalog tests of `pnpm test:db` gain the partial-index list, the exclusion list, the privilege map with column lists, "every outbox has the same columns", **every trigger function is `SECURITY INVOKER` with `search_path` pinned** (from `pg_proc.prosecdef` and `proconfig`), and the reason-code lists equal to `reason-codes.ts` (O6).
- `required_fields` is `String[]`; the hashes are `String` (O15); `tax_inclusive` on the charge is `Boolean`.
- `$queryRaw` and `$executeRaw*` banned under `modules/ordering` (`pnpm boundaries`), as in pricing. No raw statement is needed: the sequence is a Prisma `upsert`, every lock a version `updateMany`.

## 9. Volume, retention and jobs

### 9.1 Volume (PD18)

**Assumption** (not measured; first year, one Market, Greater Brisbane beta): 10² to 10³ paid orders per day; 1.5 sub-orders and 3 lines per order; 3 to 10 checkouts started per paid order; 1 to 2 invoices per sub-order; refunds and cancellations a few per cent of lines.

| Table | Rows, year 1 (upper) | Growth control |
|---|---|---|
| `orders` | 3.7 × 10⁵ | Never deleted (PD18). Partition by `placed_at` reconsidered at 5 × 10⁷ |
| `seller_orders`, `seller_order_charges` | 5.5 × 10⁵ each | Measured at 3 × 10⁵: heap 38 MB, seller-list index 30 MB (narrow test rows; real rows wider) |
| `order_lines` | 1.1 × 10⁶ | Never deleted. Counter updates HOT-eligible; watch `n_tup_hot_upd` |
| `invoices`, `invoice_lines` | 10⁶, 3 × 10⁶ | Never deleted; insert-only |
| Histories | About 6 rows per order: 2 × 10⁶ | Never deleted except checkout history by cascade |
| `checkouts` | Up to 3.7 × 10⁶ | Terminal rows without an order (`rejected`, `abandoned`) deleted after 30 days (Ali A1, M7); about 80 % of rows |
| `orphan_facts` | A handful a month | Kept |
| `platform.audit_log` rows from `ordering` | `ordering.recipient-data.read` about 1.6 × 10⁶ a year at the upper bound (5), plus `customer-data.read` and the operation rows | Platform's (platform note C2) |
| `outbox` | About 6 events per order: 2 × 10⁶ | Platform prune (P 6.5) |
| `inbox` | payments' events (4 to 6 per order) + own handlers | Platform prune |
| Children of operations | 10⁵ to 10⁶ | Kept |

### 9.2 Retention

- Orders, sub-orders, lines, charges, invoices, refunds and their histories: never deleted. The legal minimum (AG-12) only bounds the erasure of personal parts (5, CUS-03), never the rows.
- **Invoice identity retention (todo A9).** When AG-12's period has passed since an invoice's `issued_at`, its per-invoice subject is destroyed (9.3), which makes the seller and buyer identity and the content hash unreadable; the document's other columns stay. Until the tax agent answers AG-12 the period is unset (Market configuration, no core default; O13), and nothing is destroyed.
- **Checkout prune (Ali A1; todo A16)**, replacing PD4's 7-day key prune (F2): Prisma `findMany` of up to 1,000 ids `where { marketId, state: { in: ['rejected','abandoned'] }, stateChangedAt: { lt: cutoff } }` ordered by `stateChangedAt`, then `deleteMany where { marketId, id: { in: ids }, state: { in: [...] }, stateChangedAt: { lt: cutoff } }` with `cutoff = now − 30 days` from `Clock`. The state and time conditions are repeated in the delete (INV-data 9: a row changed after the read is re-checked only against the delete's own conditions). The terminal check plus the guard trigger mean a pruned row could not have moved again; a `rejected` or `abandoned` checkout never has an order (P4 creates it in `RESERVED`), and the `orders_checkout_fkey` RESTRICT would refuse it if one did (measured `23503`).
- **Replay window ≤ 30 days.** The client idempotency key of a pruned checkout becomes reusable, so a key older than 30 days is not a replay (Ali A1). The boundary in the database is strict (`<`): **measured** (10.2) with a fixed instant T, the rows at `T − 30 d − 1 s` were deleted with their history and their key could be used again, while the rows at exactly `T − 30 d` and at `T − 30 d + 1 s` stayed and their keys still replayed (`23505` on the key → the replay path). `test:db` carries this boundary through the real job with a fake `Clock` (D 13: a key at 30 days minus one second replays; a pruned one does not), on AU and ZZ (the ZZ row of the measurement was untouched by the AU run).

### 9.3 Jobs (per hosted Market, `market_id` in every statement)

| Job | Statement | Safe twice |
|---|---|---|
| `ordering.expire-checkouts` (1 min) | Q9 candidates without a lock, then one unit each with the version check | Version guard |
| `ordering.advance-checkouts` (1 min) | Q10, `ORDER BY next_attempt_at LIMIT 100`; external calls before each unit (PE 6.4) | Version guard; stored keys |
| `ordering.watch-refunds` (5 min) | Q12, Q21 (stores the confirmation; replaces only a `not-found`, 3.12) and Q8 | State and version guard; confirmation rule of 3.12 |
| `ordering.prune-checkouts` (hourly, M7) | 9.2 | Conditions repeated in the delete |
| `ordering.reconcile-first-sales` (hourly; D 11; before `sellers` slice S-d) | Q24, one Market per run, `$queryRaw` tagged template (Prisma has no skip scan or `LATERAL`): a recursive CTE walks the distinct `seller_id`s of the partial seller-list index after the cursor (one index probe per seller, `LIMIT 1`, stop at 100), and `CROSS JOIN LATERAL (… WHERE market_id = $m AND seller_id = s.seller_id AND paid_at IS NOT NULL ORDER BY paid_at ASC, id ASC LIMIT 1)` takes the earliest row by a backward scan of the same index (`paid_at DESC, id DESC`); ties on `paid_at` go to the lower sub-order id, so the answer is deterministic. The cursor is the batch's last `seller_id`, kept in the job's memory for the run (no state table: a crashed run starts again from the first seller, which only repeats no-op calls). Reads only `seller_orders`; never a `sellers` table. Sellers with only unpaid sub-orders are outside the partial index and never sent. Rejected: `DISTINCT ON (seller_id) … ORDER BY seller_id, paid_at, id LIMIT 100` reads every paid sub-order of the batch's sellers (measured 105 ms, 80,763 buffers for the first batch; grows with orders, Q24 grows with sellers); a Prisma `groupBy` with `_min` scans the Market's whole index range per run | `firstSaleAt` only moves earlier: a re-send is a no-op (`sellers`' rule, SMR) |
| `ordering.shred-invoice-identities` (daily; with slice 5, active once AG-12 sets the period) | `SubjectKeyService` lists live subjects of kind `ordering-invoice` created before `now − retention` (≤ 100, oldest first; platform note C3); `ordering` re-reads those invoices by PK and destroys the key of each whose `issued_at` is before the cutoff (a subject with no invoice row is destroyed too: no data depends on it); one audit row per destroyed subject (ids only). No `ordering` index: the key table's partial index serves the selection, and destroyed keys drop out of it | Destroying twice changes no row (identity data 3.2) |

`ordering.prune-idempotency` (D 11) is not needed (F2). Idempotency of seller and admin operations sits on their own rows (`invoices.client_key`, `shipment_applications.shipment_id`, `refund_requests.id`) and is never pruned.

## 10. Evidence

### 10.1 First round (G2 draft)

Measured 2026-10-08 on PostgreSQL 16.15 in a throwaway cluster (scratch directory, dropped afterwards), with a `NOLOGIN` group holding the grants of section 7 for the prototype tables (`checkouts`, `orders`, `seller_orders`, `order_lines`, `invoice_sequences`, `invoices`). Prisma was not used.

| Verified | Used in |
|---|---|
| Slot key: a second active checkout for one (Market, account) refused `23505`; the same account in ZZ accepted; supersede (old row updated first, then new insert, one transaction) accepted | 3.2, 6.1 |
| **F1:** under D's definition of "open" (every non-terminal state) the late-capture path `cancelled` → `compensating`, while the customer's new checkout is open, fails `23505`. Under the slot definition it succeeds | 3.2, F1 |
| Write-once `payment_id` and moving out of `compensated` refused `23001`; `order_id` update refused `42501` | 3.2 |
| `orders_checkout_fkey` refuses an order without a checkout and one with another customer; `orders_payment_id_fkey` refuses a different payment id and accepts the equal one; `paid` without `paid_at` refused | 3.3 |
| `seller_orders` with another currency than its order refused by the FK | O1 |
| Line total ≠ price × quantity refused; the five quantity violations (over-invoice after 4 of 10, cancel invoiced units, ship above invoiced, deliver above shipped, refund + lock above quantity) refused `23514`; `quantity` update refused `42501` | 3.6 |
| Invoice `UPDATE` and `DELETE` refused `42501` for the application; `UPDATE`, `DELETE`, `TRUNCATE` refused `23001` for the owner | 3.9, O5 |
| Gap-free numbering: 16 × 25 concurrent issues with 30 % rollbacks after taking the number: 279 committed, numbers 1 to 279, no gap, no duplicate | 3.8 |
| Seller list keyset on 3 × 10⁵ sub-orders (1,000 sellers, two Markets): 0.10 ms, 29 buffers; with a status filter 0.40 ms over the seller's range | 3.4, 6.5 |

**Not measured:** PostgreSQL 17; Prisma 7 (four-column relations, the `upsert` SQL, the keyset `OR` shape, the relation filter of Q18, `groupBy` with `take` of Q19); the guard triggers on `orders`, `seller_orders`, `order_lines`; the expiry and due indexes at volume; UUIDv7 locality; anything through the real guard; the real `SubjectKeyService.hmac` (10.2 used `pgcrypto` only to show that two keys give two values).

**Tests the slices must carry** (`pnpm test:db`, application role, AU and ZZ): every case above and of 10.2 as constraint tests; the privilege map with section 7's lists; the partial-index and exclusion lists; the trigger-function check of 8.4; the late-compensation case of F1 through the real use cases; concurrency (two invoices, two shipments, invoice against cancellation, two refunds on one sub-order and on two sub-orders of one Order: AC 11, F11); the gap-free test above through the real issuing unit; the sums of 6.4 re-computed for every fixture order; the prune boundary through the real job; the list-SQL test of 5 (no address column selected); up → down → up per migration.

### 10.2 Re-measured after the G2 reviews (2026-10-08, second round)

PostgreSQL 16.15, throwaway cluster outside the repository, dropped afterwards. Roles as platform.md 10: a non-superuser owner `mondapac_migrator`, the `NOLOGIN` group `mondapac_app` and its login `mondapac_api`, which ran every application-side case. `btree_gist` and `pgcrypto` in schema `extensions` (created by the superuser). Prototype tables carried exactly the columns, CHECKs, keys, EXCLUDEs, triggers and grants written in sections 3 and 7 for `checkouts`, `checkout_status_history`, `orders`, `seller_orders`, `seller_order_charges`, `order_lines`, `invoices`, `invoice_lines`, `refund_requests`, `refund_request_lines` and `orphan_facts`. Every SQLSTATE below was observed.

| Verified (todo item) | Result | Used in |
|---|---|---|
| A1, A2: charge with `tax_inclusive` and gross ≠ amount; `tax_inclusive` NULL; `tax_category_code` NULL; `seller-not-registered` with registered = true and `rated` with registered = false; `free` with rate 0.10 or tax 1; `rated` with rate 0; registered without period id; a 7-decimal rate | `23514` on `_tax_base_check`, `_tax_registration_check`, `_tax_untaxed_check`, `_tax_rated_rate_check`, `_tax_period_check`, `_tax_rate_check`; `23502` on the NOT NULLs | 3.5, 3.6 |
| A1, A2: an exclusive ZZ-shape charge (net = amount, rate 0.15), an unregistered charge (rate `0.0`, period NULL), a line with rate `0.1`; update of `tax_inclusive` as the application | Accepted; the update `42501` | 3.5, 3.6, 7 |
| A3: line positions `[0,1)`, `[1,3)` then `[2,3)`; refunded `[0,1)` beside, then `[0,2)` | ok, ok, `23P01`; ok, `23P01` | 3.9 |
| A3: charge `[0,990)` invoiced twice, `[500,990)`; refunded `[0,330)`, `[330,990)`, then `[300,400)` | `23P01`, `23P01`; ok, ok, `23P01` | 3.9 |
| A3: charge row with a wrong gross copy (free range), gross copy NULL, `before` NULL, `after` > gross, gross ≠ after − before, `[5,5)`, a line row with a range, a row naming both | `23503` on the charge FK; `23514` on the shape CHECKs | 3.9 |
| O14 (found here): before the `num_nonnulls` form, an invoice line without `quantity` and a refund line without `kind` were **accepted** | Fixed; both refused `23514` | O14 |
| A3, F16: two refund requests taking the same fee range (the first not sent); then adding an EXCLUDE to `refund_request_lines` | Both accepted; the EXCLUDE cannot be created (`23P01`) | 3.12 |
| A4: refund line gross ≠ net + tax; line without kind; charge after > gross; a charge of another sub-order | `23514`, `23514`, `23514`, `23503` | 3.12 |
| A12: `requested` → `submitted` without refund id; `submitted` → `requested`; `succeeded` → `review`; `not-sent` without reason; reason rewritten; `not-sent` → `requested`; `review` → `succeeded` without confirmation or with a partial resolution; `review` → `failed`; resolution rewritten; content update; `note` column | `23514`, `23001`, `23001`, `23514`, `23001`, `23001`, `23514`, `23514`, `23001`, `23001`, `42501`, `42703` | 3.12 |
| A12: `requested` → `submitted` → `succeeded`; `requested` → `not-sent` (abandoned) → `review` → job stores confirmation → `succeeded` with resolution | Accepted | 3.12 |
| A14: second slot-holding checkout for one account; `review` with a wrong `review_from_state`; a new `started` beside a `review` from `awaiting-payment`; exit from `review` to another state; to `cancelled` without cause; `review` from `cancelled`; `compensated` or `completed` → `review` | `23505`; `23001`; ok; `23001`; `23514`; `23514`; `23001` | 3.2 |
| A14, A15, A5: `review` → `cancelled` (`review-closed`) → `compensating` → `review` → re-drive → `compensated`; `started` → `abandoned` (`superseded`); `abandoned` with `expired`; an order cancelled `review-closed`; an unknown cancel cause | Accepted ×4; `23514`; ok; `23514` | 3.2, 3.3 |
| A14, O-9: P2 lookup of a `review` from `awaiting-payment`, customer with 500 checkouts, 10⁶ checkouts | Partial index: 2 buffers, 0.05 ms. Without it: the idempotency key's range, 500 rows filtered, 464 buffers, 0.41 ms. Slot lookup: 2 buffers | 3.2 |
| A16: prune at a fixed T with the draft's history trigger | **`23001`, nothing deleted** (finding, 3.7) | 3.7 |
| A16: prune with the new history guard: rows at T − 30 d − 1 s, T − 30 d, T − 30 d + 1 s, and a ZZ row | One AU row deleted with its two history rows; its key reusable; the other two keys still `23505`; ZZ untouched | 9.2 |
| A16: application deletes a checkout with an order; deletes history; owner deletes, updates, truncates a live checkout's history | `23503`; `42501`; `23001` ×3 | 3.7, 9.2 |
| A13: payment fact; the same event again; refund fact without key; payment fact with `refund-key-unknown`; another module's event type; partial resolution; resolution; re-resolution; content update and delete as the application | ok, `23505`, `23514`, `23514`, `23514`, `23514`, ok, `23001`, `42501` ×2 | 3.14 |
| A6: `required_fields` with an unknown code, empty, with a NULL element | `23514` ×3 | 3.9 |
| A8: `ContentHash` HMAC accepted; an unkeyed `sha256:` value, upper-case hex, 63 hex digits in an HMAC column; an `hmac-sha256:` value as the quote fingerprint; the same request under two customer keys (`pgcrypto` HMAC-SHA-256) | ok; `23514` ×4; two different values | O15, 3.2, 3.3, 3.9 |
| A17: erasure check at 4 × 10⁵ orders, 6 × 10⁵ sub-orders | 0.33 ms (10 orders), 5.2 ms (500 orders); seq scan on `seller_orders` alone 64 ms | 5 |
| A7: `turnoverOf` and `sellersWithSupplies` at 3 × 10⁶ documents | 3.9.1 table | 3.9.1 |
| A18: every trigger function above created with `SECURITY INVOKER` and `SET search_path = pg_catalog, pg_temp` | Fired as expected for both roles | O16 |

### 10.3 Final edits (2026-10-08, third round)

PostgreSQL 16.15, throwaway cluster in the session scratch directory, dropped afterwards; superuser session, prototype tables only (no grants: the privilege cases of 10.2 are unchanged).

| Verified | Result | Used in |
|---|---|---|
| Q24 on 6 × 10⁵ `seller_orders` (AU 5 × 10⁵ over 1,000 sellers, skewed; ZZ 10⁵ over 200; 15 % unpaid; 50 AU sellers with unpaid sub-orders only), partial seller-list index, custom plan | First batch and a mid-range batch: Recursive Union of 100 Index Only Scans (`seller_id > $prev`, `LIMIT 1`), then Nested Loop with Index Scan Backward per seller; 3.0 ms / 2.8 ms, about 700 buffers, no sort spill | 6.5, 9.3 |
| Full sweep, both Markets | AU 1,000 sellers in 10 batches, 37.6 ms in total; ZZ 200 in 2 batches, 6.1 ms; 0 mismatches against a brute-force `DISTINCT ON` over the whole table; the 50 unpaid-only sellers not returned; no ZZ row in an AU batch | 9.3 |
| `DISTINCT ON … LIMIT 100` alternative | 105 ms, 80,763 buffers (first batch); 52 ms, 33,086 buffers (mid batch) | 9.3 (rejected) |
| F13: `review` → `failed` without confirmation; without the resolution; to `succeeded` on `not-found`; to `failed` on `succeeded`; `failed` → `succeeded`; resolution rewritten; `succeeded`/`failed` confirmation rewritten; confirmation written outside `review`; `submitted` → `failed` with a resolution; `failed` with no refund id not via `review` | `23514`, `23514`, `23514`, `23514`, `23001`, `23001`, `23001`, `23001`, `23514`, `23514` | 3.12 |
| F13: `review` + `not-found` → `failed` with resolution; `review` + `failed` (with refund id) → `failed`; `not-found` replaced by a later `succeeded`, after which `failed` is refused and `succeeded` accepted; plain `submitted` → `failed` | Accepted | 3.12 |
| Found while measuring: the first form of `refund_requests_resolution_check` (`refund_confirmed_outcome IN (…)`) evaluated to NULL for a missing confirmation and **accepted** `review` → `failed` without one | Fixed with the NULL-safe form (3.12); refused `23514` | 3.12, O14 |
| Hadi's refund list: a free-text `reason_code` | `23514` on `refund_requests_reason_code_check` | O6a |

## 11. Findings and open points

### 11.1 Findings for Mohammad (domain text changes; no business rule changes)

F1 to F12, M1 and M2 were **all accepted** in D 17 (F1 by Hassan with O-9); they are applied above and kept here for the record. F13 to F16 are new in this revision.

| # | Point | My recommendation |
|---|---|---|
| F1 | **D's "open" Checkout breaks the late-compensation path.** D 2.1 counts every state except five terminal ones as open, and PD3's key covers them all. A `cancelled` checkout moves to `compensating` on a late capture (D 3.3); if the customer has started a new checkout meanwhile, that update violates the key (measured), the handler retries for ever and the money is not returned. The same holds for `voiding`, `releasing-stock` and `review`, which would also block the customer from buying while the system cleans up | The key covers **slot-holding** states only: `started`, `reserved`, `awaiting-payment`, `committing`, `capturing`, and `review` entered from `committing` or `capturing` (money may be authorised). D 2.1, 3.3 (P2 refusal list) and PD3 to say so. Hassan to confirm that a customer may start a new checkout while an old one voids or compensates (one payment never runs beside another: an old `awaiting-payment` is superseded, `committing`/`capturing` still refuse) |
| F2 | PD4's `idempotency_keys` duplicates `checkouts`' key and hash | Unique `(market_id, customer_account_id, idempotency_key)` on `checkouts`; no separate table, no 7-day prune; the 30-day prune of rejected and abandoned checkouts replaces it (9.2) |
| F3 | `expiresAt` on both `Checkout` and `Order` | Stored on `checkouts` only (the Saga's and the expiry job's). `retry-payment` and the customer page read it through the 1:1 order → checkout key |
| F4 | PD12's stored status cannot hold `CLOSED`, which depends on `Clock` (D 3.2) | Store `last_delivered_at`; `closed` is a read-time predicate (`display_status = 'delivered' AND NOT refund lock AND last_delivered_at <= now − closeAfter`); also add stored values `pending` and `void` for sub-orders of unpaid and pre-payment-cancelled orders |
| F5 | PD11 seller list on `placed_at` | On `paid_at`, partial `WHERE paid_at IS NOT NULL`: a seller never sees a sub-order before payment (D 3.2 forbids operations, D 4.9 notifies at `order-paid`). Confirm sellers never list unpaid sub-orders |
| F6 | The flat fee as columns of `SellerOrder` | A `seller_order_charges` row with the same frozen tax columns as a line. Invoice and refund lines then reference a line or a charge uniformly, and Phase 6's real shipping charges add a `kind`, not columns. Domain shape unchanged if the repository maps it to `SellerOrderSnapshot` |
| F7 | PD16 "refund required" read from `line_cancellations` | An append-only cancellation cannot know whether a later refund covered it (D 4.5 takes cancelled units first). The sub-order stores `refund_required_since`, set and cleared with the counters; `line_cancellations.refund_required` stays as the per-cancellation fact |
| F8 | No proof that partial documents do not overlap in unit positions | The EXCLUDE of 3.9 on `(line, space, positions)`. Accept or drop (cost: one GiST index); I recommend accept: it is the only database check behind the tax agent's per-unit split |
| F9 | `shipmentStatus` answering `refused` (D 6.3) | A refusal writes nothing, so only `accepted` / `unknown` can be answered. `shipping` re-sends an `unknown` intent; the repeat is refused again or applied once (PD9). No refusal table. Confirm with shipping G2 |
| F10 | Seller and admin lists showing recipient data | Lists show no recipient field (0 decryptions per page); name and address only on detail. Reza for the screen |
| F11 | Refund cap per Order across sub-orders (D 3.5, 4.8) | Two concurrent requests on two sub-orders of one Order both pass the per-sub-order lock. The creating unit raises the **Order's** version first (6.1). D 9 to list it |
| F12 | Which transition issues the adjustment note, and in which series | At `SUCCEEDED`, in the refund-settled unit (the amount is final; a failed refund leaves no document). The series is AG-11 (3.8) |
| M1 | The line's "tax category catalog revision id" | Equal to `product_revision_id` (CF-1 reads the category from that revision); one column |
| M2 | Fields added to D 2.1 | `checkouts.review_from_state`, `reject_code`, `state_changed_at`; `seller_orders.paid_at`, `display_partial`, `last_delivered_at`, `refund_required_since`; `invoices.series`, `document_number`, `client_key`; `invoice_lines.position_space`, `position_from`; `refund_requests.order_id`, `version`; `saved_addresses.slot`; `seller_order_history.version_after`. Removed: `seller_orders` tax number (Ali G2-2), `orders.expires_at` (F3), address region in clear (Ali G2-3) |
| F13 | **A refund `REVIEW` reached by `refund-failed`** (D 3.5: `NOT_SENT` → `REVIEW` on `refund-succeeded` **or** `refund-failed`) has no exit in D: its only listed exit is `REVIEW` → `SUCCEEDED`, which needs a confirmed refund | The trigger allows only `review` → `succeeded` today (measured: `review` → `failed` refused). Proposal: add `REVIEW` → `FAILED` (admin, reason code, after the job confirms through `refundByKey` that no refund exists), with the same resolution columns. If Mohammad agrees, it is one line in the trigger and the resolution CHECK, added to M4 before it merges (no live rows). Before slice 7 code |
| F14 | **A money event for a Checkout in a terminal state.** D 3.3 sends a money event in an unlisted state to `REVIEW`, but `completed`, `compensated`, `rejected` and `abandoned` are final in the trigger (a bug or script must never revive them), and `rejected`/`abandoned` have no payment id | Such an event is recorded as an orphan fact with cause `event-after-terminal` and an alert; the Checkout does not move (3.14). D 3.3's "every state × money event" table should name this row. The `payment-authorized`/`payment-succeeded` redeliveries in `COMPLETED`, `COMPENSATED` that D already lists as "no effect, logged" are unchanged |
| F15 | A **zero flat fee** (AC 14) cannot be a document line: its range `[0, 0)` is empty and refused (`before < after`, todo A3's CHECK) | No document line for a zero fee; nothing is invoiced or refunded. If the template shows "shipping 0", it reads the charge row. Reza and the tax agent (AG-16) to note it |
| F16 | Todo A3 asked for the EXCLUDE on `refund_request_lines` as well | Not added: a `NOT_SENT` or `FAILED` request releases its positions and the next request takes them again (measured `23P01` when adding it). The note lines carry the EXCLUDE instead (3.12). No domain text change; D PD7's "per charge portion the cumulative range, with the same kind of EXCLUDE" holds for documents |

### 11.2 Points for other G2s

| # | Point | Who | Status |
|---|---|---|---|
| P1 | Do payments' outcome events carry `orderId`? If they carry only `paymentId`, M1 adds unique `checkouts (market_id, payment_id)` for the handler lookup | Payments G2 | **Open** |
| X1 | A category code for a charge | Tax G2 | **Answered** (TX 4.5, 6.2: never null): `tax_category_code` NOT NULL on charges (3.5) |
| X2 | `registrationPeriodId` presence | Tax G2 | **Answered** (TX 4.4): CHECKs of 3.4, 3.5, 3.6 |
| X3 | The base CHECK | Tax G2, Mohammad | **Answered** (TX 4.3): holds while the discount is 0; on lines and charges |
| X4 | One number series or two (AG-11) | Tax agent, through Hadi | **Open**; no migration either way (3.8) |
| P-7 | The fenced `abandonRefund` (Hassan O-2) | Payments G2 | **Open**; M4 waits for it (8.1) |

### 11.3 For Hassan (answered in Hassan review 2026-10-08, applied)

| # | Question | Answer, where applied |
|---|---|---|
| H1 | Subject of the invoice identity fields | **Option B accepted**: per-invoice subject, namespaced kind, outside customer erasure, destroyed only by the AG-12 job (3.9, 5, 9.2, 9.3; platform note C3) |
| H2 | A seller request unwrapping the customer's key | Became **O-6**: only the recipient use case, with its own permission, paid sub-orders, window, audit row per decryption (5) |
| H3 | Notes in clear | Became **O-5**: no notes, reason codes only (O6, O8, 3.11, 3.12) |
| H4 | Guard functions | **Accepted**: `SECURITY INVOKER`, pinned `search_path` (O16); Hassan checks at code time |
| H5 | Hashes | **Accepted except the hashes** → **O-4**: HMACs under the subject keys; the fingerprint stays SHA-256 (O15) |
| H6 | F1 | **Accepted with O-9** (3.2: Q17) |

### 11.4 Others

| # | Point | Who |
|---|---|---|
| S1 | Prisma 7: the four-column relation `seller_orders → orders` (also Q18's relation filter), the `upsert` SQL of 3.8, the keyset `OR` shape, `groupBy` with `take` (Q19), `String[]` for `required_fields`, the EXCLUDEs ignored by drift (PRC-data S1 (a)) | Hossein, with me, in slice 2's PR (EXCLUDEs in slice 5's, Q19 in tax slice 6) |
| K1 | Pool sizing for the worker's three one-minute jobs plus the outbox relay; `lock_timeout` 3 s on the units of 6.1 through `UnitOfWorkOptions.lockTimeoutMs` (INV-data L7) | Kazem |
| A1 | 30-day prune of rejected and abandoned checkouts; erasure waits for open sub-orders | **Ruled by Ali** (A1, A2): applied in 9.2 and 5 |

### 11.5 Open after this revision

| # | Point | Who | Needed by |
|---|---|---|---|
| Q1 | **Closed 2026-10-08** (Hadi payments and commission-payouts decisions 2026-10-08 (c)): the `loss_reason_code` list and the `(state, code)` refund-resolution pairs are applied in O6a and 3.12 with measured CHECKs; the orphan-fact reading is confirmed. Note for Hadi, not blocking: the database does not tie `no-refund-found` to outcome `not-found` or `refund-failed-at-provider` to `failed`; the use case can, if Hadi wants it | — | — |
| Q2 | **Closed:** F13 and F14 accepted in D 3.3, 3.5 and applied (3.12, 3.14, 10.3). New, small, for Mohammad: D 3.5 lists no row for a `refund-succeeded` arriving for the key of a request already `FAILED` from `review` (`not-found`, then the provider refunds late). The data model takes it as an orphan refund fact (cause `refund-key-unknown` would be wrong; I propose a cause `event-after-terminal` on `refund` facts too, allowed by the current CHECK) | Mohammad | Slice 7 code |
| Q3 | The CUS-03 meaning of "unshipped" as the stored statuses of 5 | Mohammad, Hadi | CUS-03 design |
| Q4 | The platform side of C1 to C3 (audit columns, audit volume, subject kind and keyed hash) | Platform owner; Hassan for C1 and C3 | Elevation PR (C1), slices 2 and 5 (C3) |

## 12. Follow-up changes

This document changes no other file. After G2:

| File | Change | When |
|---|---|---|
| `docs/design/data/ordering.md` | This document with the review answers | At G2; Mojtaba |
| `docs/design/domain/ordering.md` (D 3.3, 3.5) | F13, F14 applied; F15 noted; 11.5 Q2's late-refund row | Before slice 7; Mohammad |
| platform data note 2026-10-08 | C1 to C3 for the platform owner (written with this revision) | Elevation PR; slices 2 and 5 |
| `prisma/schema/base.prisma`, `ordering.prisma`; M1 to M9 with `down.sql` | As specified; each needs my sign-off | Per slice; Hossein |
| `modules/ordering/domain/reason-codes.ts` | The closed lists of 11.5 Q1 | Before M1 |
| `pnpm test:db` catalog tests | Section 7 lists, partial-index and exclusion lists, trigger-function settings, reason-code lists | With each migration |
| `config/markets/*.json` and validation | 8.3 keys and the boot check, plus `recipientVisibleFor` and the invoice retention period (no core default) | Before slice 2 (retention: before slice 5); shared-file PR |

## 13. Review record

| Date | Reviewer | Outcome | Applied in this revision |
|---|---|---|---|
| 2026-10-08 | Mohammad (software-architect), domain design `docs/design/domain/ordering.md` section 17 | F1 to F12, M1, M2 accepted; X1 to X3 answered; the remaining data changes collected in Mojtaba change list 2026-10-08 (A1 to A18) | 11.1, 11.2 |
| 2026-10-08 | Hassan (security-tester), Hassan review 2026-10-08 | Accept with changes: O-1 to O-10; Mojtaba's points (per-invoice subject accepted; H2 → O-6; H3 → O-5; H4, H5 accepted except the hashes → O-4; F1 with O-9) | 11.3 |
| 2026-10-08 | Ali (cto), Ali G2 review 2026-10-08 sections 6 and 7 | D-1, T8, A1 to A4 approved; M3 Hadi's call; ordering G2 approved with conditions | 11.2, 11.4 |
| 2026-10-08 | Mojtaba (database-designer), this revision | **Every todo item applied**, re-measured on PostgreSQL 16 (10.2): A1 treatments and backstops (3.5, 3.6); A2 `tax_inclusive` and NOT NULL category on charges, no `price_basis` (3.5); A3 charge cumulative ranges with FK-proved gross and an EXCLUDE on documents (3.9, 3.12; F16); A4 refund gross/tax/net (3.12); A5 `superseded` on `abandoned` (3.2); A6 `required_fields text[]` (3.9); A7 `sellersWithSupplies` on the M8 index, measured (3.9.1); A8 HMAC `ContentHash` hashes, no key-version column (O15); A9 per-invoice subject, no new column, retention job (3.9, 9); A10 no notes, closed reason lists (O6, O8); A11 recipient window as a predicate, 0 list decryptions, audit volume (5); A12 refund states (3.12); A13 `orphan_facts` (3.14); A14 `review_from_state`, O-9 index, resolution as history, trigger (3.2); A15 `review-closed` (3.2, 3.3); A16 prune and ≤ 30-day replay window, boundary measured (9.2); A17 erasure check plan (5); A18 trigger functions (O16). Found and fixed while measuring: the history trigger blocked the prune's cascade (3.7); NULL-tolerant shape CHECKs (O14); the category-code pattern refused `gst_free` (3.6). Platform items C1 to C3 in platform data note 2026-10-08 | Whole document |
| 2026-10-08 | Ali (cto), Hassan (security-tester) | **G2 data design approved with conditions** (status line) | Status line |
| 2026-10-08 | Mojtaba (database-designer), final edits after D's revision (D 17 row for 11.1 F13 to F16) and Hadi's G2 decisions | Q24 plan for `ordering.reconcile-first-sales` measured; refund `review` → `failed` with `refund_confirmed_outcome` and the NULL-safe resolution CHECK (one NULL-tolerant CHECK found and fixed); F14 needs no new storage; Hadi's five reason lists in the CHECKs, two lists still open (11.5 Q1) | Status line, O6, O6a, 3.10, 3.11, 3.12, 3.14, 6.1, 6.5, 7, 9.3, 10.3, 11.5, 12 |
