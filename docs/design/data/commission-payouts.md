# Physical data model — `commission_payouts` schema (G2)

**Author:** Mojtaba (database-designer) — 2026-10-08
**Status:** G2 data design, draft for review by Mohammad (software-architect), Ali (cto) and Hassan (security-tester; mandatory, tier A). Ali's ruling (Ali payments and commission-payouts review 2026-10-08, cited "Ali PC") is applied: the facade calls P-a to P-i with payments' names, the dispute fee only through `fee-charged` (the double count in D 4.2 removed), `dispute-debited` only for the disputed amount and only when funds are withdrawn, payments' refusal codes, `transfer-reversal-failed.v1` consumed, the fence-breach posting, `MAX_COMMISSION_RATE = "0.30"`, `MAX_HOLD_DAYS = 60`, `heldFundsLimitDays` ≤ 90. **Q-O1 to Q-O5 are answered (owner, 2026-10-08)**: the spots built to Ali's recommendations (3.5, 3.8, 3.9) match the answers, so no design change follows. Each migration still needs my sign-off. The non-trivial constraints were measured on PostgreSQL 16.15 (10).
**Ground truth:** `docs/design/domain/commission-payouts.md` (Mohammad, G2 draft 2026-10-08; cited as **D**, for example "D 3.4"; inputs PD1 to PD16 in D 7); `docs/modules/commission-payouts/brief.md` (G1 approved 2026-10-08; "brief s5", "AC n"); Ali PC; `docs/design/data/payments.md` (**PAY-data**, written together with this document: the ids C-P stores); `docs/design/data/tax.md` 10.2 (**TX-data**: the PD8 freeze and the reversal entry); `docs/design/data/ordering.md` (**OD-data**: O1 money, O2 rates, O3 proved copies, O4/O5/O16 guards, O6 closed codes, O9 zones, O10 actors, O13 no Market value in a CHECK, O14 NULL-counting shapes; the invoice position spaces of 3.9; the per-invoice subject, todo A9); `docs/design/data/platform.md` section 10 (roles, grants) and 10.9; `docs/design/data/identity.md` (**ID-data**, C1 to C11); `docs/design/data/pricing.md` (**PRC-data**: P1, P5, P6, P7; `btree_gist` 8.3); ADR-0001, 0003, 0004 (decisions 3 to 7), 0005, 0006, 0007 (decisions 1, 2, 11), 0009 (V2, V3, V4), 0018, 0025, 0035.
**Prisma models:** `prisma/schema/commission-payouts.prisma` (new), `@@schema("commission_payouts")`. Nothing exists yet.
**Business rules:** none changed. Where the mapping needed a choice D does not make, or where I recommend a change to D, it is a finding in 11.1.

## 1. Scope and table list

The physical design of everything D 7 asks the database to hold: tables, constraints, the balanced-journal guard, locking, access paths, grants, migrations, volume and retention. PostgreSQL schema name `commission_payouts` (a hyphen would need quoting everywhere); event types and handler names keep the module name `commission-payouts.`.

ADR-0009 patterns: **V2** (effective-dated, no overlap) for rate and terms records; **V3** (immutable document) for statements; **V4** (append-only) for the journal, reversals, payout items, state history, fee facts; everything else is a live root with write-once content (PRC-data P5) and a forward-only guard.

| Table | Holds (D 2.1) | Pattern | Migration (8.1) / slice |
|---|---|---|---|
| `outbox`, `inbox` | Events (ADR-0006); C-P consumes 15 event types (D 6.4) | Queue | W1 / 1 |
| `commission_rate_series`, `commission_rate_records` | `CommissionRateSeries` | V2 | W1 / 1 |
| `journal_transactions`, `journal_entries` | `Journal` (PD1) | V4, balanced | W2 / 2 |
| `commission_assessments` | `CommissionAssessment`, with the TX PD8 freeze (PD5) | Live, write-once content | W2 / 2 (tax columns used from slice 3) |
| `provider_fees` | Fee facts from `feeChargesOf` (P-f) | V4 | W2 / 2 |
| `payout_terms_series`, `payout_terms_records` | `PayoutTermsSeries` (PD4) | V2 | W3 / 4 |
| `settlement_items`, `payout_schedule_cursors` | `SettlementItem` (PD6), `PayoutScheduleCursor` (PD9; also the seller lock, 5.1) | Live | W4 / 3 |
| `payout_holds` | `PayoutHold` (PD7) | Live, write-once content | W5 / 5 |
| `payouts`, `payout_items`, `payout_state_history` | `Payout` (PD8) | Live; V4; V4 | W5 / 5 |
| `bank_payout_observations` | `payments.payout-paid/-failed.v1` observations (`bankPayoutId`) | Live, observed | W5 / 5 |
| `assessment_reversals` | Cumulative reversals of an assessment (D 4.8; TX-data 10.2) | V4 | W6 / 6 |
| `dispute_cases`, `dispute_case_seller_orders` | `DisputeCase` and its per-sub-order attribution (11.1 L10) | Live | W6 / 6 |
| `recovery_actions` | `RecoveryAction` (D 4.11) | Live | W6 / 6 |
| `statement_sequences`, `payout_statements`, `payout_statement_lines` | `PayoutStatement`, `StatementSequence` (PD10) | V3 | W7 / 7 (gated) |

Every table carries `market_id` and `tenant_id`. **No balance column on any business row** (PD2) and no balance cache at launch (11.1 L6, measured). No personal data (4).

### 1.1 ER sketch

FK = composite foreign key leading with `market_id` (ID-data C3). Dotted = a plain id of another module, no FK (ID-data C4).

```
commission_rate_series ──< commission_rate_records ............ (rate, id) FK target of assessments
payout_terms_series    ──< payout_terms_records ............... (id, currency, minimum) FK target of payouts

commission_assessments ──< assessment_reversals         FK (market_id, assessment_id, currency, original_commission)
  seller_id, seller_order_id, invoice_id, order_line_id ....   (ordering ids)
  rate copy ──> commission_rate_records (market_id, id, rate)
      │1
      └──1 settlement_items ──> payout_items (market_id, payout_id, id)   "my payout contains me"
                │                    │
payout_schedule_cursors (1 per seller)   payouts ──< payout_items, payout_state_history
                                           │  terms copy ──> payout_terms_records
                                           └ transfer_execution_id ...... payments
journal_transactions ──< journal_entries  FK (market_id, transaction_id, currency, posted_at)
  (source_kind, source_id, kind) unique   refs ──> assessments, settlement_items, payouts, dispute_cases
payout_holds (seller | seller-order) ..... seller_order_id
dispute_cases ──< dispute_case_seller_orders     payment_dispute_id ...... payments
recovery_actions ........ transfer_execution_id (payments)
provider_fees ........... payments fee charge id; bank_payout_observations ...... bankPayoutId
statement_sequences (market, series) ── numbers ──> payout_statements ──< payout_statement_lines
```

## 2. Conventions

ID-data C1 to C10, PRC-data P1, P5, P6, P7 and OD-data O1, O2, O3, O4, O5, O6, O9, O10, O13, O14, O16 apply unchanged (not repeated below: `market_id`/`tenant_id` and their CHECKs, `version`, actor columns). What C-P adds:

| # | Convention |
|---|---|
| W1 | **Money** as OD-data O1 (`<name>_minor bigint`, one `currency char(3)` per row; children prove the currency by FK, O3). Journal amounts are `BETWEEN 1 AND 9007199254740991` (D 2.1: > 0); assessment and item amounts may be 0. `minimumAmountCap`, `receivableCap`, `recoveryWindowDays`, `heldFundsAlertDays`, `approvalValidityDays` are Market configuration: **no CHECK** (O13) |
| W2 | **Code constants in CHECKs** (not Market values, so O13 does not forbid them): `MAX_COMMISSION_RATE = 0.30` (Ali PC) on rates and assessment rate copies; `MIN_HOLD_DAYS = 7`, `MAX_HOLD_DAYS = 60` (Ali PC) on terms and items. Lowering one later is a `NOT VALID` CHECK swap without `VALIDATE` (old rows stay legal history; 11.1 L12). A catalog test compares the CHECK text with the constants in `modules/commission-payouts/domain` |
| W3 | **Rates** as O2: `numeric`, `scale(x) <= 6`. Compared numerically; FK equality on `numeric` is numeric (`0.150` = `0.15`) |
| W4 | **V2 records** (rates, terms): a record row is never edited. `valid_to` and `ended_at` are written once (guard trigger; grant `UPDATE (valid_to, ended_at)` only). `valid_from >= submitted_at` (forward-only, VER-09) and `valid_to >= ended_at` (no retroactive end) are CHECKs; `submitted_at` and `ended_at` are the `Clock` instants of the unit, so the database proves "not in the past" relative to the unit's own clock reading. No overlap per series: `EXCLUDE USING gist` (`btree_gist` in schema `extensions`, PRC-data 8.3) over `tstzrange(valid_from, CASE WHEN valid_to IS NULL THEN NULL ELSE GREATEST(valid_from, valid_to) END, '[)')` (11.1 L11: `GREATEST(x, NULL)` is `x`, so the naive form gave an open record an empty range and accepted overlaps; measured and fixed) |
| W5 | **The journal is insert-only and balanced** (PD1). `reject_mutation()` on `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` for every role (`23001`), `SELECT, INSERT` grant only (`42501`), and a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on both tables (3.3) |
| W6 | **Forward-only states** as PAY-data Y6: `text` + closed CHECK holding every later value; a guard trigger per table for transitions, finals and write-once columns (`23001` for the owner too) |
| W7 | **Deferred sum proofs** as PAY-data Y7: where a parent stores a sum of children that a rule depends on (assessment reversal counters; payout gross = Σ items), a deferred constraint trigger re-sums at `COMMIT` (`23514`) |
| W8 | **Isolation READ COMMITTED everywhere** (ADR-0025). D 4.7 step 4 asks for a serialisable per-seller unit; the cursor row lock replaces it (5.1, 11.1 L15). Read-only use cases and the payout run's planning phase open no transaction |
| W9 | **Reason and kind codes** are closed CHECK lists (O6) equal to `modules/commission-payouts/domain/reason-codes.ts` (catalog test). No free text anywhere (PD12) |
| W10 | **Prisma model names** start with `CommissionPayouts` (`CommissionPayoutsJournalEntry`), `@@map` to the table (ID-data C9). Names above 63 bytes are given explicitly (measured truncation: `payout_terms_records_market_id_id_currency_minimum_amount_minor_key`, `commission_assessments_market_id_id_currency_commission_minor_key`; named `payout_terms_records_market_id_id_minimum_key` and `commission_assessments_market_id_id_commission_key`) |

## 3. Tables

"Identifier" marks a plain id that points at a person (seller or account). Constraint names are the exact database names.

### 3.1 `outbox` and `inbox` (W1)

The identity tables with the module name changed (ID-data 3.1, 3.8): `outbox_type_check` `^commission-payouts\.[a-z0-9-]+\.v[1-9][0-9]*$`, `inbox_handler_check` `^commission-payouts\.[a-z0-9-]+$`, `inbox_pkey (event_id, handler)`.
- Published (D 6.3): `payout-instructed`, `payout-status-changed`, `seller-balance-negative`, `statement-issued`, `payout-terms-changed`, `payout-hold-placed`, `payout-hold-released` (`.v1`). Payloads ids, enums and instants only, no amount (Ali A-3).
- Consumed (D 6.4 as amended by Ali PC): ordering `order-paid`, `seller-order-invoiced`, `seller-order-delivered`, `seller-order-delivery-corrected`, `order-line-refunded`, `refund-requested`, `refund-request-closed`; payments `transfer-executed`, `transfer-failed`, `transfer-reversed`, `transfer-reversal-failed` (Ali PC), `payout-paid`, `payout-failed`, `fee-charged`, `dispute-opened`, `dispute-closed`; identity `seller-access-suspended`, `seller-access-reinstated`. `connected-account-status-changed` does not exist any more (Ali PC).
- Every posting is also idempotent by its own source key (3.3), so the inbox is the first guard, not the only one.

### 3.2 Rate and terms series and records (W1, W3; D 2.1, 3.1, 4.1, 4.4; PD3, PD4)

**`commission_rate_series`** and **`payout_terms_series`** (same shape): `id uuid` PK; `scope text` CHECK `market`, `seller` (the `plan` scope has no writer until SUB: not in the CHECK; adding it is a CHECK swap, D 4.4); `seller_id uuid` (identifier) with `*_seller_check` `(scope = 'seller') = (seller_id IS NOT NULL)`; `version`, `created_at`. Partial uniques: `*_market_id_market_key (market_id) WHERE scope = 'market'` (one Market series) and `*_market_id_seller_id_key (market_id, seller_id) WHERE scope = 'seller'`; FK target `*_market_id_id_key`. The series `version` is the write lock of D 3.1 ("expected series version"): grant `UPDATE (version)` only.

**`commission_rate_records`:**

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; the `rateRecordId` ordering freezes (COM-04) |
| `series_id` | `uuid` | no | FK `(market_id, series_id)` |
| `rate` | `numeric` | no | `commission_rate_records_rate_check`: `rate >= 0 AND rate <= 0.30 AND scale(rate) <= 6` (W2, W3) |
| `valid_from` | `timestamptz(6)` | no | `commission_rate_records_forward_check`: `valid_from >= submitted_at` |
| `valid_to`, `ended_at` | `timestamptz(6)` | yes | Written once (W4). `commission_rate_records_end_check`: `(valid_to IS NULL) = (ended_at IS NULL) AND (valid_to IS NULL OR valid_to >= ended_at)` |
| `reason_code` | `text` | no | Closed list (W9); `initial` for the boot seed |
| `submitted_by_kind`, `submitted_by_account_id`, `submitted_at` | | | O10; `system` for the seed. Acting-as column arrives with SEL-08 |

`commission_rate_records_period_excl` (W4); FK target `commission_rate_records_market_id_id_rate_key (market_id, id, rate)` for the assessment copy (3.4). Guard trigger `*_guard_update` (function `v2_record_guard_update()`, shared by both record tables): `valid_to` written once, every other column compared through `to_jsonb(NEW) - 'valid_to' - 'ended_at'`; no delete, no truncate.

**`payout_terms_records`:** same record columns, plus the four fields of PT, typed (PD4):

| Column | Type | Null | Notes |
|---|---|---|---|
| `schedule_weekdays` | `smallint` | no | ISO weekday bitmask, bit 0 = Monday. `payout_terms_records_schedule_weekdays_check BETWEEN 1 AND 127` (at least one day). AU default Tuesday = `2` |
| `schedule_local_time` | `time(0)` | no | Local `HH:mm` in the seller's zone (D 4.6); AU default `10:00` |
| `hold_days` | `smallint` | no | `payout_terms_records_hold_days_check BETWEEN 7 AND 60` (W2; PD4) |
| `minimum_amount_minor`, `currency` | `bigint`, `char(3)` | no | `>= 0`; the cap is Market config (W1). AU default A$50 = `5000 AUD` |
| `approval_mode` | `text` | no | CHECK `auto`, `manual` |

FK target `payout_terms_records_market_id_id_minimum_key (market_id, id, currency, minimum_amount_minor)` (3.7). **No account, bank, commission or verification column exists** (PT; PD4). The read-time bound check of D 4.4 stays in the resolver; with the CHECK a stored row outside the bounds cannot exist unless a constant is lowered (W2), which is exactly the case the read check covers.

**Not in the database:** "the Market record is never ended" (the series scope is on the parent row; the use case refuses `market-record-cannot-end`); "no gap in the Market series" (same).

### 3.3 `journal_transactions` and `journal_entries` (W2, W5; D 2.1, 4.2; PD1, PD2, PD15)

**`journal_transactions`:**

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `kind` | `text` | no | CHECK: the 18 kinds of D 4.2 plus **`transfer-after-abandon`** (Ali PC fence breach: debit `seller-receivable`, credit `platform-cash`) and **`transfer-recalled`** (Hassan re-check 2(b); D 4.11: debit `platform-cash`, credit `seller-payable`; unique source = the recovery action id, as `transfer-reversed`) |
| `source_kind`, `source_id` | `text`, `uuid` | no | `source_kind` CHECK `^commission-payouts\.[a-z0-9-]+$`; values in the table below |
| `currency` | `char(3)` | no | One currency per transaction (D 2.1) |
| `entry_count` | `smallint` | no | `BETWEEN 2 AND 1000`: the number of entries the header declares |
| `total_minor` | `bigint` | no | `BETWEEN 1 AND …`: Σ debits = Σ credits = this |
| `corrects_transaction_id` | `uuid` | yes | A reversing kind names what it corrects (D 2.1) |
| `occurred_at`, `posted_at` | `timestamptz(6)` | no | Fact instant; posting instant (`Clock`) |

Unique **`journal_transactions_market_id_source_kind_source_id_kind_key`** (PD1: a replay posts nothing twice; measured `23505`). FK target `journal_transactions_market_id_id_currency_posted_at_key`. Index `journal_transactions_market_id_posted_at_idx` (daily reconciliation, PD15).

| Source kind | Source id | Kinds |
|---|---|---|
| `commission-payouts.order` | ordering order id | `order-paid` |
| `commission-payouts.invoice` | ordering invoice id | `invoice-posted`, `charge-posted` (one transaction per invoice, entries per assessment; 11.1 L1) |
| `commission-payouts.refund` | ordering refund id | `refund-uninvoiced`, `refund-reversal`, `refund-reversal-after-payout`, `refund-platform-borne` |
| `commission-payouts.payout` | payout id | `payout-instructed`, `payout-netting`, `payout-unwound`, `transfer-settled`, `transfer-after-abandon` |
| `commission-payouts.fee` | payments fee charge id | `provider-fee` (every fee, **the dispute fee included**, Ali PC) |
| `commission-payouts.dispute-case` | dispute case id | `dispute-debited` (**disputed amount only; only when `fundsWithdrawn`**; an inquiry posts nothing), `dispute-reinstated` |
| `commission-payouts.dispute-attribution` | `dispute_case_seller_orders.id` | `dispute-recovered` |
| `commission-payouts.recovery` | recovery action id | `transfer-reversed`, `receivable-collected-externally`, `receivable-written-off` |

**`journal_entries`:** `id uuid` PK; `transaction_id`, `line_no smallint >= 1` with unique `journal_entries_market_id_transaction_id_line_no_key`; `account` CHECK the 11 accounts of D 4.2; `seller_id` (identifier) with `journal_entries_seller_check` `(account LIKE 'seller-%') = (seller_id IS NOT NULL)` (measured `23514`); `side` CHECK `debit`, `credit`; `amount_minor` `BETWEEN 1 AND …` (measured: 0 refused); `currency`, `posted_at` copies proved by FK `(market_id, transaction_id, currency, posted_at)` → the header (measured: another currency or instant `23503`); refs `seller_order_id`, `order_line_id`, `invoice_id` (ordering ids, plain) and `assessment_id`, `settlement_item_id`, `payout_id`, `dispute_case_id` (in-schema FKs; parents are never deleted).

**The balance guard (PD1).** Constraint triggers `journal_transactions_balanced` (after insert on the header) and `journal_entries_balanced` (after insert on an entry), both `DEFERRABLE INITIALLY DEFERRED`, call `check_journal_balanced()` (O16), which at `COMMIT` re-reads the transaction and refuses (`23514`) unless `count(entries) = entry_count` and Σ debit = Σ credit = `total_minor`. Because the header declares its size, a balanced pair appended to a committed transaction later is refused too (the count no longer matches; 11.1 L2). Measured: AU `invoice-posted` 1,100 = 935 + 150 + 15 committed; one cent off refused; a header without entries refused; a later balanced pair refused; owner `UPDATE`/`DELETE`/`TRUNCATE` `23001`, application `42501`.

**Cost (measured, 4-entry transaction, 200 runs):** 1.39 to 1.60 ms with the deferred trigger against 1.19 to 1.26 ms without: +0.2 to 0.35 ms per posting. The trigger's two reads use the PK and the line-key index.

**Indexes:** `journal_entries_market_id_seller_id_account_idx (market_id, seller_id, account) INCLUDE (side, amount_minor) WHERE seller_id IS NOT NULL` (balances by aggregation; index-only); `journal_entries_market_id_seller_id_posted_at_id_idx (market_id, seller_id, posted_at, id) WHERE seller_id IS NOT NULL` (PAY-08 transactions, keyset); `journal_entries_market_id_seller_order_id_conditional_idx (market_id, seller_order_id) INCLUDE (side, amount_minor) WHERE account = 'seller-conditional'` (PD15 conditional per sub-order; not measured).

### 3.4 `commission_assessments` (W2; D 2.1, 3.3, 4.3; TX-data 10.2; PD5)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `seller_id`, `seller_order_id`, `invoice_id` | `uuid` | no | Ordering ids (identifier: seller) |
| `kind` | `text` | no | CHECK `line`, `charge` |
| `order_line_id`, `position_from`, `quantity` | `uuid`, `integer`, `integer` | yes | Line rows: the invoice's unit positions `[position_from, position_from + quantity)` in ordering's `invoiced` space (OD-data 3.9) |
| `charge_id`, `cumulative_before_minor`, `cumulative_after_minor` | | yes | Charge rows: the invoice's cumulative range of the flat fee (OD-data 3.9) |
| `currency`, `gross_minor`, `net_minor`, `line_tax_minor` | | no | From `financialFactsOf({kind: 'invoice'})`; `gross = net + tax` |
| `commission_rate`, `commission_rate_record_id`, `commission_rate_source` | `numeric`, `uuid`, `text` | yes | Line rows: ordering's frozen copy (COM-04), proved by FK **`commission_assessments_rate_record_fkey (market_id, commission_rate_record_id, commission_rate)` → `commission_rate_records (market_id, id, rate)`** (measured: rate 0.16 against a 0.15 record `23503`) |
| `commission_minor` | `bigint` | no | `round_half_up(net × rate)`; line: `<= net_minor`; charge: `0` |
| `tax_rule_set_id`, `tax_rate`, `supplier_registered`, `legal_entity_registration_valid_from`, `tax_evaluated_at` | | yes | TX PD8 freeze, written once at `posted` (TX-data 10.2; `tax_evaluated_at` = the invoice's `issued_at`, Hassan H2) |
| `commission_tax_minor`, `seller_share_minor` | `bigint` | yes | Written once at `posted` |
| `state` | `text` | no | CHECK `awaiting-tax`, `posted`, `partly-reversed`, `reversed` |
| `units_reversed`, `gross_reversed_minor`, `commission_reversed_minor`, `commission_tax_reversed_minor`, `seller_share_reversed_minor` | | no | Cumulative, only grow; = Σ `assessment_reversals` (W7) |
| `issued_at`, `created_at`, `version` | | no | |

Constraints (all measured, 10):
- `commission_assessments_line_check` / `_charge_check` (O14): a line has its six line columns, no charge columns, `quantity >= 1`, the rate within W2 and `commission <= net`; a charge has its three range columns, no rate or tax-freeze columns, `gross = after − before`, `commission = 0`, `commission_tax = 0` and is never `awaiting-tax` (Q7, Q11; measured: a charge with commission 10 refused).
- `commission_assessments_tax_check`: `awaiting-tax` ⇔ no tax and no share; a posted line has all five PD8 columns (measured: missing `tax_rule_set_id` refused); `supplier_registered OR commission_tax = 0` (measured); **`seller_share = gross − commission − commission_tax`** (brief s5; Q8: no fee; measured: 2,806 for 2,805 refused).
- `commission_assessments_reversed_check`: every cumulative between 0 and its original, units ≤ quantity (measured: 4 of 3 refused), and `reversed` ⇔ everything reversed.
- `commission_assessments_positions_excl` `EXCLUDE (market_id =, order_line_id =, int4range(position_from, position_from + quantity) &&) WHERE kind = 'line'` and `_charge_ranges_excl` on the charge range: **no unit and no part of the fee is assessed twice**, whatever the handler does (measured: `[2,3)` over `[0,3)` `23P01`; `[3,4)` accepted). Together with the unique keys `commission_assessments_market_id_invoice_id_order_line_id_key` and `..._invoice_id_charge_id_key` (partial by kind) this is PD5's "unique (Market, invoice id, line ref)" and the handler's idempotency.
- FK targets: `commission_assessments_market_id_id_commission_key (market_id, id, currency, commission_minor)` (TX-data 10.2's reversal FK) and `commission_assessments_market_id_id_seller_key (market_id, id, seller_id, seller_order_id, currency)` (settlement items, O3).
- Guard trigger `commission_assessments_guard_update` (W6): content columns immutable; the PD8 columns, tax and share written once on `awaiting-tax → posted`; `posted → partly-reversed → reversed` only; cumulative columns only grow. Grant `UPDATE` on state, the PD8 and share columns, the cumulative columns and `version` (7).

Indexes: `commission_assessments_market_id_seller_order_id_idx` (refunds, disputes, COM-06 batch ≤ 100 sub-orders); `commission_assessments_market_id_created_at_awaiting_idx (market_id, created_at) WHERE state = 'awaiting-tax'` (retry job, D 11).

### 3.5 `assessment_reversals` (W7; D 4.8; TX-data 10.2; Ali PC Q-O2)

Insert-only (O5). `id uuid` PK; `assessment_id`; `refund_id uuid` (ordering's refund id) with unique `assessment_reversals_market_id_assessment_id_refund_id_key` (idempotency); `currency`; `units_before`, `units_after` (line rows; NULL for charges); `gross_before_minor`, `gross_after_minor`; `original_commission_minor`, `commission_before_minor`, `commission_after_minor` (TX-data's `reversed_before/after`); `commission_tax_reversed_minor` (as `tax.reverseCommissionTax` returned it), `seller_share_reversed_minor`; `posting` CHECK `unpaid`, `after-payout`; `created_at`.
- FK `assessment_reversals_assessment_fkey (market_id, assessment_id, currency, original_commission_minor)` → `commission_assessments (market_id, id, currency, commission_minor)` (TX-data 10.2: the copies are the original's; measured `23503` for a wrong original commission).
- CHECKs: `0 <= units_before < units_after`; `0 <= gross_before < gross_after`; **`0 <= commission_before <= commission_after <= original`** (11.1 L14: `<=`, not TX-data's `<`).
- `EXCLUDE` per assessment over the unit range (lines), the gross range and the commission range: no unit, no cent of gross and no cent of commission is reversed twice (measured: units `[0,2)` after `[0,1)` `23P01`; two empty commission ranges on one assessment accepted, as an empty range overlaps nothing).
- Deferred constraint triggers `assessment_reversals_counters` and `commission_assessments_counters` (function `check_assessment_reversals()`): the assessment's five cumulative columns equal the sums of its reversal rows at `COMMIT` (measured: counters raised without a row refused at commit).
- A platform-borne refund writes **no** reversal row: it posts `refund-platform-borne` only, so the assessment and the item stay untouched. **Answered (owner, 2026-10-08, Q-O2): the seller keeps the full share; the platform bears the whole refund.**

### 3.6 `settlement_items` and `payout_schedule_cursors` (W2, W6; D 2.1, 3.4, 4.5, 4.6; PD6, PD9)

**`settlement_items`:** `id uuid` PK; `seller_id`, `seller_order_id`, `assessment_id`, `currency` (proved by FK `settlement_items_assessment_fkey (market_id, assessment_id, seller_id, seller_order_id, currency)` → assessments) with unique `(market_id, assessment_id)` (one item per assessment); `amount_minor >= 0`; `state` CHECK `unanchored`, `maturing`, `in-payout`, `paid`, `closed` (`eligible` is derived at read time, D 4.5); `anchor_at`, `eligible_at`, `hold_days_applied smallint BETWEEN 7 AND 60`, `terms_record_id` (FK → `payout_terms_records`); `payout_id`; `version`.
- `settlement_items_anchor_check`: once `maturing`, `in-payout` or `paid`, all four anchor columns are set, and `eligible_at <= anchor_at + hold_days_applied days` (measured `23514`). This is "hold ≥ 7 frozen" as a database fact: an item can never become eligible later than its own frozen hold, and no stored `eligible_at` exceeds the bound it was computed from.
- `settlement_items_payout_check`: `(state = 'in-payout') = (payout_id IS NOT NULL)` (measured).
- **`settlement_items_payout_item_fkey (market_id, payout_id, id)` → `payout_items (market_id, payout_id, settlement_item_id)`**: an item in a payout is listed by that payout (measured: pointing at another payout `23503`). With the single `payout_id` column this is **"one live payout per item"** (PD8; 11.1 L5).
- Guard trigger `settlement_items_guard_update` (PD6, measured): content immutable; **`eligible_at` may only move earlier and is never cleared once set** (later `23001`, NULL `23001`); the amount is frozen once `in-payout`, `paid` or `closed` (`23001`); `paid` and `closed` final. `anchor_at` may change (a re-delivery, 11.1 L3), which can only lower the bound's effect, never move `eligible_at` later.
- Index **`settlement_items_market_id_seller_id_eligible_at_idx (market_id, seller_id, eligible_at) INCLUDE (amount_minor) WHERE state = 'maturing'`** (PD6: unpaid and not in a payout; the payout run's read); `settlement_items_market_id_seller_order_id_open_idx (market_id, seller_order_id) WHERE state IN ('unanchored', 'maturing')` (anchoring by delivery facts, holds, refunds).
- **Ali CP-R1, `recall` items (Ali ruling CP-R1 2026-10-08 conditions 1 and 2; C-P slice 6, W6 as `ALTER TABLE`; specified, not measured; slice 6 migration; my sign-off on W6):**
  - `kind text NOT NULL`, CHECK `IN ('sale', 'recall')` (added `DEFAULT 'sale'`, a fast default with no rewrite, then `DROP DEFAULT` in the same migration). `assessment_id` and `seller_order_id` become NULL-able; new `recovery_action_id uuid NULL`.
  - CHECK `settlement_items_kind_check` (NULL-safe; `kind` is NOT NULL and every branch ends in IS / IS NOT tests or ANDs with them): `CASE kind WHEN 'sale' THEN assessment_id IS NOT NULL AND seller_order_id IS NOT NULL AND recovery_action_id IS NULL AND (hold_days_applied IS NULL OR hold_days_applied BETWEEN 7 AND 60) WHEN 'recall' THEN recovery_action_id IS NOT NULL AND assessment_id IS NULL AND seller_order_id IS NULL AND terms_record_id IS NULL AND state <> 'unanchored' AND hold_days_applied IS NOT NULL AND hold_days_applied = 0 AND anchor_at IS NOT NULL AND eligible_at IS NOT NULL AND eligible_at = anchor_at ELSE false END`. It replaces the column CHECK `hold_days_applied BETWEEN 7 AND 60`; `settlement_items_anchor_check` keeps its four-column rule for `sale` only (`kind = 'recall' OR …`); its bound `eligible_at <= anchor_at + hold_days_applied days` holds for both kinds.
  - Unique `settlement_items_market_id_recovery_action_id_key (market_id, recovery_action_id)`: one item per reversal, so a duplicate `transfer-reversed.v1` creates nothing twice (NULLs stay distinct, so `sale` rows are unaffected; the unique `(market_id, assessment_id)` likewise ignores `recall` rows).
  - FK `settlement_items_recovery_action_fkey (market_id, recovery_action_id, seller_id, currency, amount_minor)` → a new unique `recovery_actions_market_id_id_seller_id_currency_amount_key` on `recovery_actions`: the item belongs to the action's seller, in its currency, for exactly its amount (P-b reverses the amount sent). MATCH SIMPLE, so `sale` rows are not checked; the assessment FK likewise skips `recall` rows. That the action is a `transfer-reversal` with reason `payout-account-compromised` in state `reversed` is cross-table: use case plus repository test (3.9).
  - Guard trigger `settlement_items_guard_update`: on a `recall` row `anchor_at` and `eligible_at` never change (PD6 otherwise unchanged); `kind` and `recovery_action_id` are content (immutable).
  - The item and the `transfer-recalled` transaction are written in one unit that locks the seller's cursor first (5.1); the transaction's unique source key (3.3) and the item's unique key make it idempotent.
  - Forced approval (D 4.6, 4.7): a payout holding an unpaid `recall` item with `transfer > 0` is stored `approval_mode = 'manual'`, so `payouts_approval_check` binds the amount; that rule is cross-table (repository test).
  - The payout-run index (`… WHERE state = 'maturing'`) serves `recall` rows unchanged. `down.sql` drops the new constraints, column and FK and restores the old CHECK and NOT NULLs; it fails while `recall` rows exist (expected: down runs only on a throwaway or pre-data database).
  - To measure in W6: `sale` without an assessment, `recall` without an action, `recall` with an assessment, `recall` with `hold_days_applied <> 0`, `eligible_at <> anchor_at`, or `state = 'unanchored'` each refused `23514`; a second item for one action refused `23505`; an item for another seller's action or another amount refused `23503`; a later `eligible_at` on a `recall` row refused `23001`.

**`payout_schedule_cursors`:** PK `(market_id, seller_id)` (PD9); `last_slot_at timestamptz(6) NOT NULL`; `next_slot_at timestamptz(6)` (NULL until the run first computes it); `zone text` (O9; the zone used, D 2.1); `updated_at`, `version`. Guard: `last_slot_at` only forward. Index `payout_schedule_cursors_market_id_next_slot_at_idx (market_id, next_slot_at)` (NULLs sort last; the run reads `next_slot_at <= $now`, then a second short query for `IS NULL`). The cursor is created in the unit that creates the seller's first item (`createMany skipDuplicates`), because it is also **the seller's money lock** (5.1).

### 3.7 `payouts`, `payout_items`, `payout_state_history` (W6, W7; D 3.6, 4.7; Ali PC P-a to P-d; PD8)

**`payouts`:**

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK. **The instruction key** sent as `instructTransfer({instructionKey: id, sellerId, amount, reference: id})` (Ali PC P-a; PAY-data 3.8 stores it under its unique key). A retry is a new row, a new key (D 9). No separate key column: the PK is the uniqueness (PD8) |
| `seller_id` | `uuid` | no | Identifier |
| `currency`, `gross_minor`, `netted_minor`, `transfer_minor` | | no | `gross >= 1`; `netted >= 0`; `transfer >= 0`; **immutable** (no grant; guard) |
| `approval_mode` | `text` | no | `auto`, `manual` (from the terms at run time) |
| `terms_record_id`, `minimum_amount_minor` | `uuid`, `bigint` | no | FK `payouts_terms_fkey (market_id, terms_record_id, currency, minimum_amount_minor)` → `payout_terms_records`: the minimum is the one of the record used (measured: a forged minimum `23503`) |
| `state` | `text` | no | CHECK `pending`, `awaiting-approval`, `approved`, `instructing`, `instructed`, `paid`, `failed`, `not-sent`, `voided`, `settled-by-netting` |
| `approved_by_account_id`, `approved_at`, `approved_transfer_minor` | | yes | Written once (identifier) |
| `transfer_execution_id` | `uuid` | yes | payments' `transferExecutionId`, written once |
| `outcome_code` | `text` | yes | payments' refusal codes as given (`payments.transfer.cooling-off`, `payments.transfer.account-not-ready`, …; Ali PC) or `abandoned`, `voided.*` |
| `created_at`, `state_changed_at`, `version` | | no | |

Constraints (measured, 10): `payouts_amounts_check` `transfer = gross − netted`; `payouts_minimum_check` `(transfer = 0 AND netted > 0) OR transfer >= minimum` (AC "minimum"); `payouts_netting_check` `(state = 'settled-by-netting') = (transfer = 0)`; `payouts_approval_check`: approval columns all or none, only on `manual`, **`approved_transfer = transfer`** (approval binds the amount; measured 5,999 for 6,000 refused), a manual payout past `awaiting-approval` (except `voided`) has an approval (measured), `pending` and `settled-by-netting` only for `auto`; `payouts_transfer_check` `instructed`, `paid`, `failed` ⇒ `transfer_execution_id` (measured). Partial unique **`payouts_market_id_seller_id_live_key (market_id, seller_id) WHERE state IN ('pending', 'awaiting-approval', 'approved', 'instructing')`**: one live payout per seller (measured `23505`; 11.1 L13). FK target `payouts_market_id_id_seller_id_currency_key`.

Guard trigger (W6): transitions exactly as D 3.6, finals `paid`, `failed`, `not-sent`, `voided`, `settled-by-netting`; `instructed → paid | failed` only with `transfer_execution_id` set. Deferred constraint triggers `payouts_items_sum` and `payout_items_sum` (function `check_payout_items()`): `gross_minor = Σ payout_items.amount_minor` at `COMMIT` (measured: a payout without items refused).

**`payout_items`** (V4): PK `(market_id, payout_id, settlement_item_id)`; `seller_id`, `currency` proved by FK `(market_id, payout_id, seller_id, currency)` → `payouts` (measured: JPY item on an AUD payout `23503`); `amount_minor >= 1` (the item's amount when taken; equal to the item's frozen amount, repository test). The history of an item across voided and failed payouts stays here.

**`payout_state_history`** (V4): `id`, `payout_id` FK, `from_state`, `to_state`, `actor_kind`, `actor_account_id` (O10), `code` (pattern), `version_after` with unique `(market_id, payout_id, version_after)`, `occurred_at`, `correlation_id`. System money movements are recorded here, not in the audit log (D 8).

Indexes: `payouts_market_id_open_idx (market_id, state, state_changed_at, id) WHERE state IN ('pending', 'awaiting-approval', 'approved', 'instructing')` (worker pass, approval list, `reconcile-instructions` with `transferSendTimeout` > payments' lease, Ali PC P-d); `payouts_market_id_seller_id_created_at_id_idx` (seller and admin lists, keyset).

### 3.8 `payout_holds` (W6, W9; D 3.5, 4.5; Q-O1 answered, owner, 2026-10-08; PD7)

`id uuid` PK; `scope` CHECK `seller`, `seller-order`; `seller_id` (identifier), `seller_order_id` with `payout_holds_seller_order_check`; `reason_code` CHECK `not-received`, `seller-suspended`, `dispute`, `refund-pending`, `admin-review`, **`delivery-corrected`** (11.1 L3); `origin` CHECK `admin`, `system`; `source_id uuid` (identity's `decisionId`, ordering's refund id, the dispute case id, the correction id, or the admin use case's record id); `placed_by_account_id`, `placed_at`; `state` CHECK `active`, `released`; release columns `released_at`, `release_actor_kind`, `released_by_account_id`, `release_reason_code`, `outcome` (`released`, `settled-by-refunds`); `release_due_at` (only `delivery-corrected`: re-delivery + hold days, written once).
- **`payout_holds_placement_check`**: admin holds carry the admin; `seller-suspended`, `refund-pending`, `dispute`, `delivery-corrected` are system-only; `seller-suspended` only at seller scope (measured: an admin `seller-suspended` refused). `admin-review` may be system (the held-funds job at `heldFundsLimitDays`; **answered (owner, 2026-10-08, Q-O1): day 60**; or `payments.payout-account-change-reported.v1`, seller scope, `source_id` = the report id, Hassan HP-2) or admin. The exact code is stored; what a seller sees is the read use case's mapping (Hassan Q-S4, D 5.4).
- **`payout_holds_release_check`**: release columns all set ⇔ `released`; a system release only of a system hold with `refund-pending`, `dispute` or `delivery-corrected`. **`seller-suspended` can never be released by the system** (Ali G1-r5; measured `23514`); an admin may release any hold (measured). (`delivery-corrected` added after the measurement, same expression.)
- Partial unique `payout_holds_market_id_system_source_key (market_id, reason_code, source_id, seller_id, seller_order_id) NULLS NOT DISTINCT WHERE origin = 'system'`: one system hold per source and scope, so a replayed suspension, refund or dispute event places nothing twice (PD7; measured `23505`).
- Content write-once (guard); grant `UPDATE` on release columns only.
- Indexes: `payout_holds_market_id_seller_id_active_idx (market_id, seller_id) WHERE state = 'active'`; `payout_holds_market_id_seller_order_id_active_idx (market_id, seller_order_id) WHERE state = 'active' AND seller_order_id IS NOT NULL`.

### 3.9 Disputes, recovery, fees, bank payouts (W6; D 3.7, 4.9 to 4.11; Ali PC P-f, P-g, P-h; Q-O3, Q-O4 answered, owner, 2026-10-08; PD11)

**`dispute_cases`:** `id` PK; `payment_dispute_id` (payments' id) unique per Market; `order_id`; `currency`, `disputed_amount_minor` (from `disputeOf`); `funds_withdrawn boolean` (Ali PC P-h); `state` CHECK `open`, `won`, `lost`, `resolved`, `closed-inquiry`; `debited_transaction_id`, `reinstated_transaction_id` (FKs to the journal; CHECK `debited_transaction_id IS NULL OR funds_withdrawn`); `opened_at`, `closed_at`, `version`. No fee column: the dispute fee arrives only as a `provider_fees` row (Ali PC). **HP-5 (Hassan; C-P slice 6):** `funds_withdrawn` may move `false → true` once and `debited_transaction_id` / `reinstated_transaction_id` are written once at any state (from `dispute-funds-withdrawn.v1` / `-reinstated.v1` or the close/daily re-read); the journal's unique source `(dispute case id, kind)` keeps each posting single; guard mutable list and grant include them.

**`dispute_case_seller_orders`** (11.1 L10): `id` PK; FK `(market_id, dispute_case_id)`; `seller_order_id`, `seller_id`; unique `(market_id, dispute_case_id, seller_order_id)`; `attribution` CHECK `pending`, `seller`, `platform`; `recovery_cap_minor` (the seller's unreversed share of that sub-order at attribution; **answered (owner, 2026-10-08, Q-O4): the seller's share only, not gross; the platform bears fees and loses its commission on that sale**; the gross is not built); `recovery_amount_minor` with CHECK `attribution <> 'seller' OR recovery_amount_minor BETWEEN 1 AND recovery_cap_minor`, NULL otherwise; `attributed_by_account_id`, `reason_code`, `attributed_at`; `recovery_transaction_id`; `version`. The cap's value is computed by the repository from assessments and reversals; the CHECK proves the recovery does not exceed it.

**`recovery_actions`:** `id` PK (also the reversal key sent as `instructTransferReversal({key: id, transferExecutionId, amount, reasonCode})`, Ali PC P-b); `seller_id`; `kind` CHECK `transfer-reversal`, `external-collection`, `write-off`; `amount_minor >= 1`, `currency`; `transfer_execution_id` (CHECK set ⇔ `transfer-reversal`); `reason_code`; `requested_by_account_id`, `requested_at`; `confirmed_by_account_id`, `confirmed_at` (write-off: CHECK `confirmed_by_account_id <> requested_by_account_id`; accepted by Hassan Q-S3 and extended to external collection, below); `state` CHECK `requested`, `instructing`, `reversed`, `failed` (`transfer-reversal-failed.v1`, Ali PC), `recorded`; `journal_transaction_id`; `version`. The cap "≤ unreversed transfer and ≤ receivable" is read from payments and the journal by the use case (5.3).

**Hassan's conditions on `recovery_actions` (2026-10-08; C-P slice 6; specified, not measured; my sign-off on W6):**
- **Q-S3 + HP-7, two-person rule for `write-off` and `external-collection`:** CHECK `recovery_actions_two_person_check`: `kind = 'transfer-reversal' OR state = 'requested' OR (confirmed_by_account_id IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_by_account_id <> requested_by_account_id)`; `journal_transaction_id IS NULL` while `requested` (the journal is posted only in the confirming unit); guard: `requested → recorded` only for those two kinds. New column `evidence_reference_code text`, CHECK `~ '^[A-Z0-9][A-Z0-9-]{3,34}$'` (closed pattern, no free text; exact pattern with Hassan in the slice), NOT NULL when `kind = 'external-collection' AND state = 'recorded'`, NULL for the other kinds. Recent confirmation and not acting-as for the confirmer are checked in the use case (D 5.2 `confirm-recovery-action`). **Mojtaba G2 (2026-10-08; measured on PostgreSQL 16.15, throwaway schema):** (a) the evidence rule as first written (`~ pattern AND kind … OR IS NULL AND NOT …`) evaluated to NULL for a recorded external collection with no code and **accepted** it (the 10.3 trap); it is written NULL-safe as `recovery_actions_evidence_check` `CASE WHEN evidence_reference_code IS NULL THEN NOT (kind = 'external-collection' AND state = 'recorded') ELSE kind = 'external-collection' AND evidence_reference_code ~ '^[A-Z0-9][A-Z0-9-]{3,34}$' END` (measured: missing code and free text refused `23514`, a code on a write-off refused, a code at `requested` accepted); written once. (b) The two-person CHECK also requires `requested_by_account_id IS NOT NULL` in its third branch, so a NULL requester cannot make `<>` NULL and pass (measured: refused `23514`; same id refused). (c) New `recovery_actions_kind_state_check`: `state = 'requested' OR (kind = 'transfer-reversal' AND state IN ('instructing', 'reversed', 'failed')) OR (kind IN ('external-collection', 'write-off') AND state = 'recorded')` (a write-off in `instructing` refused). (d) `recovery_actions_confirm_check`: nothing confirmed and no journal while `requested`; `recovery_actions_journal_check`: `recorded` has `journal_transaction_id` (both measured `23514`).
- **HP-8, reversal bound to the seller:** FK `recovery_actions_transfer_fkey (market_id, transfer_execution_id, seller_id)` → a new unique constraint `payouts_market_id_transfer_execution_id_seller_id_key (market_id, transfer_execution_id, seller_id)` on `payouts` (not partial, since an FK target cannot be a partial index; NULLs stay distinct, so payouts without a transfer are unaffected; MATCH SIMPLE: actions without a transfer are not checked): a reversal can name only a transfer that one of *that seller's* payouts received. Test with two sellers.
- **Hassan re-check item 4 (C-P slice 6, W6; not blocking; specified, not measured; my sign-off on W6):** partial unique index `recovery_actions_market_id_evidence_reference_code_key (market_id, evidence_reference_code) WHERE kind = 'external-collection' AND evidence_reference_code IS NOT NULL`, so one bank reference cannot clear two receivables in a Market (NULLs would be distinct anyway; the `IS NOT NULL` keeps the index small and the intent explicit; the pattern admits upper case only, so no case variant slips past). A code entered at `requested` already reserves it; there is no cancel state, so a stale request keeps it (conservative; an admin uses another reference only with the bank's). The use case checks first and answers `commission-payouts.recovery.evidence-reused`; the index is the second lock (`23505` → `conflict.retry`, HY2). The application validates with the same literal as `recovery_actions_evidence_check` (`EVIDENCE_REFERENCE_PATTERN`; a `test:db` test reads the CHECK from `pg_constraint` and compares), and the confirmer re-enters the code, compared in the use case (D 5.2). To measure in W6: a second external collection with the same code in AU refused `23505`, the same code in ZZ accepted, two write-offs (NULL codes) accepted.
- **Hassan re-check 2(b), recall (C-P slice 6):** `reason_code` gains `payout-account-compromised` in C-P's closed list (pattern CHECK unchanged; the list is the use case's). Such a `transfer-reversal` action is not capped by the receivable (D 4.11; the use case reads the transfer's unreversed amount); its `transfer-reversed.v1` posts `transfer-recalled`. "Only under an active report-sourced `ADMIN_REVIEW` hold" is cross-table: use case plus repository test. **CP-R1 answered (Ali, Ali ruling CP-R1 2026-10-08):** the reversal's `transfer-reversed.v1` posts `transfer-recalled` and, in the same unit, inserts a `recall` `settlement_items` row for this action (3.6; one per action, so several partial reversals give several items); `recovery_actions` gains the unique `(market_id, id, seller_id, currency, amount_minor)` as the FK target of 3.6 (specified, not measured; slice 6 migration).


**`provider_fees`** (V4): `id` PK; `payments_fee_charge_id` unique per Market (PD11); `kind` CHECK payments' names `payment-processing`, `connect-active-account`, `connect-payout`, `dispute`, `other` (Ali PC P-f; `other` posts and raises an alert); `amount_minor >= 1`, `currency`; `order_id`, `seller_id`, `payment_dispute_id` (nullable plain ids); `provider_created_at`; `journal_transaction_id`.

**`bank_payout_observations`:** `bank_payout_id` (payments' `bankPayoutId`, Ali PC) unique per Market; `seller_id`; `state` CHECK `in-transit`, `paid`, `failed`, `cancelled`; `arrival_at`; `observed_at`, `version`. No amount (Ali A-3; the seller view shows the transfer's amount).

### 3.10 Statements (W2; D 4.12; PD10; gated on the tax agent)

**`statement_sequences`:** PK `(market_id, series)`; `series` CHECK `statement`, `tax-invoice`, `adjustment` (the third reserved for TX-C1 / Q-T4); `last_number bigint >= 1`. **Gap-free under rollback:** the number is taken inside the issuing unit with `INSERT … ON CONFLICT (market_id, series) DO UPDATE SET last_number = last_number + 1 RETURNING last_number` (ORD PD6 pattern), so a rolled-back issue rolls its number back too. Measured: 16 sessions × 25 issues with about 30 % rollbacks: 271 committed statements numbered exactly 1..271, no gap, no duplicate. The row lock serialises statement issue per (Market, series) (11.1 L9).

**`payout_statements`** (V3): `id` PK; `payout_id` FK, unique `(market_id, payout_id)`; `seller_id`; `series`, `document_number` with unique `payout_statements_market_id_series_document_number_key`; `kind` CHECK `statement`, `tax-invoice` (from TX-C1); `issuer_legal_name`, `issuer_tax_number` (copies of `MarketConfig.legalEntity` at `issued_at`: the platform's own entity, not personal, PD12); `issued_at`, `issue_date date`, `issue_zone` (O9; the seller's zone, ADR-0005); totals `gross_minor`, `commission_minor`, `commission_tax_minor`, `seller_share_minor`, `netted_minor`, `transfer_minor`, `currency`. **`payout_statement_lines`** (V3): PK `(market_id, statement_id, line_no)`; `assessment_id` or `assessment_reversal_id` (exactly one, O14); the line's amounts. Both `SELECT, INSERT` only with `reject_mutation()`. No seller identity column today (11.1 L8).

## 4. What is never stored

| Never in the `commission_payouts` schema | Instead |
|---|---|
| Seller or customer names, emails, addresses, phone numbers | Ids only; the BFF composes names (PD12) |
| Bank details, connected-account refs, provider refs | `payments` (ids only: `transferExecutionId`, `bankPayoutId`, fee and dispute ids) |
| Seller tax numbers (ABN) | `sellers` / `ordering` invoices; only the issuer's own number on statements |
| Free text, notes | Reason codes (W9) |
| A balance column or editable balance | Aggregation over `journal_entries` (PD2) |
| An `eligible` flag | Derived from `eligible_at`, holds and state (D 4.5) |
| Amounts in events | Facades and C-P's HTTP reads (Ali A-3) |
| Model output of any kind | ADR-0019 decision 10: no AI in this module |

## 5. Invariants, locking and isolation

### 5.1 Lock order (one rule for every unit)

**`payout_schedule_cursors` (the seller) → `payouts` → `settlement_items` (id order) → `commission_assessments` (id order) → `dispute_case_seller_orders` / `recovery_actions` / holds → inserts (journal, reversals, items, history, outbox).** Each root is locked by its version `updateMany` as the first statement on it (PRC-data P7). Units that touch several sellers lock their cursors in seller-id order.

| Unit (D) | Statements, in order |
|---|---|
| `order-paid` handler | Insert transaction + entries (unique source refuses a replay) → outbox |
| Invoice handler / `retry-commission-tax` | Insert assessments (`awaiting-tax`) → later: assessments `posted` (version) → insert cursor (skip duplicates) → insert items → transaction `invoice-posted`/`charge-posted` |
| Delivery facts (anchor) | Items `maturing` (version) |
| Delivery correction | Cursor → insert `delivery-corrected` hold (11.1 L3) |
| Refund (D 4.8) | Items of the touched assessments (version, amount down if unpaid) → assessments (cumulative, version) → insert reversals → transaction |
| Hold placed (system or admin) | **Cursor** → live payout `voided` (version) → its items freed → insert hold → outbox |
| Payout run, per seller (D 4.7 step 4) | **Cursor** (version) → re-read active holds (`seller-suspended` re-check) → items `in-payout` (version, id order) → insert payout, payout items, history → `payout-instructed` or `payout-netting` |
| Approve (admin) | Payout version + approval columns → history |
| Instruct result / reconcile / abandon | Payout version → items freed (`not-sent`, `failed`) → transaction (`payout-unwound`) |
| `transfer-executed` | Payout version → items `paid` → `transfer-settled` → statement job later |
| Attribution / recovery | Cursor → attribution or action row → transaction |

**The cursor replaces `serializable` (11.1 L15).** Every unit that can block a seller's money (hold placement) and the payout unit lock the same row first. Under READ COMMITTED a statement after the lock sees every committed hold: if the hold unit commits first, the payout unit's re-read sees the hold; if the payout unit locks first, the hold unit waits and then finds the payout `instructing`, the case D 3.5 already describes ("it left; the alert says so"). This is the same outcome `serializable` would give, without retries on serialization failures, and it matches D 4.7's residual window exactly (Hassan Q-S2).

### 5.2 Who holds each cross-row rule

| Rule | Holder |
|---|---|
| Journal balanced, insert-only; no posting twice | Deferred trigger + header count + `reject_mutation` + grants; unique source key (3.3, measured) |
| No unit or fee portion assessed twice; rate copy = the record | EXCLUDEs and uniques; rate FK (3.4, measured) |
| No part of an assessment reversed twice; reversals ≤ originals; counters true | EXCLUDEs, CHECKs, reversal FK, deferred trigger (3.5, measured) |
| Rates and terms: no overlap, forward-only, bounds, never edited | EXCLUDE, CHECKs, guard, column grant (3.2, measured) |
| `eligible_at` only earlier; hold ≥ 7 frozen | Guard trigger + anchor CHECK (3.6, measured) |
| One live payout per item; one live payout per seller; gross = Σ items | Single `payout_id` + FK to `payout_items`; partial unique; deferred trigger (3.6, 3.7, measured) |
| Approval binds the amount; minimum from the terms used | `payouts_approval_check`; terms FK + minimum CHECK (3.7, measured) |
| No double payment | Payout id = instruction key (payments refuses same key, other amount, PAY-data Y4); items' live payout; payments' fence (PAY-data 3.8) |
| `seller-suspended` never released by the system | `payout_holds_release_check` (measured) |
| One system hold per source | Partial unique (measured) |
| Recovery ≤ the cap of the sub-order (the seller's share, answered owner, 2026-10-08, Q-O4) | `dispute_case_seller_orders` CHECK |
| Statement numbers gap-free | In-unit upsert on the sequence row (measured) |

### 5.3 Invariants the database does not carry

| Invariant | Why not | Enforced by |
|---|---|---|
| `valid_from >= now` against the real clock | `now` is `Clock`'s; the CHECK compares with the unit's `submitted_at` | Use case (`valid-from-in-past`) |
| Minimum ≤ `minimumAmountCap`; receivable cap; approval validity | Market configuration (O13) | Declaration, policy, jobs |
| Market record never ended; no gap in the Market series | Scope is on the parent row | Use case |
| Payout conditions 4 to 9 (readiness, second factor, business-id, access) | Other modules' facts | Payout run (D 4.6, 4.7) |
| Recovery ≤ unreversed transfer and ≤ receivable | payments' and the journal's figures | `command-transfer-reversal` use case |
| Item amount = Σ its assessment's share − unpaid reversals | Cross-table arithmetic | Repository + property test (D 13) |
| `seller-payable` = Σ amounts of the seller's unpaid items (`unanchored`, `maturing`; `sale` and `recall`; Ali CP-R1) | Cross-table arithmetic between the journal and `settlement_items` | The `daily-reconciliation` job (D 11): per Market and seller, the `seller-payable` balance from `journal_entries` against `SUM(amount_minor)` of unpaid items, alert on any difference; query and plan in the slice 6 PR (specified, not measured; slice 6 migration) |
| Postings follow D 4.2's debit/credit pattern per kind | A per-kind account matrix in SQL would duplicate `PostingFactory` | `PostingFactory` tests; the database proves balance only |

## 6. Access paths

**Assumption** (first year, one Market, upper bounds): 10² to 10³ paid orders a day, about 3 lines each → up to 10⁶ assessments and items a year; about 3 × 10⁶ journal entries a year; 10² to 10³ sellers; one payout per seller per weekly slot (up to 5 × 10⁴ a year).

### 6.1 Queries and their indexes

| Query (D) | Index | Measured |
|---|---|---|
| Seller balance buckets (earnings view, payout run receivable `R`): Σ by account for one seller | `journal_entries_market_id_seller_id_account_idx` (index-only) | At 3.1 × 10⁶ entries: biggest seller (4.5 × 10⁵ entries) **all buckets ≈ 100 ms** (parallel index-only scan); typical seller 0.6 ms; **receivable only 0.17 ms** |
| PAY-08 transactions, keyset | `journal_entries_market_id_seller_id_posted_at_id_idx` | 0.19 ms per page |
| Payout run: eligible items of a seller | `settlement_items_market_id_seller_id_eligible_at_idx` | Not measured (partial, small: maturing items only) |
| Due sellers | `payout_schedule_cursors_market_id_next_slot_at_idx` | — |
| Active holds per seller / sub-order | The two partial hold indexes | — |
| Anchoring, refunds, disputes by sub-order | `settlement_items_..._seller_order_id_open_idx`, `commission_assessments_market_id_seller_order_id_idx` | — |
| `ratesFor(≤ 100 sellers, at)` | Series partial uniques → records by `(market_id, series_id)` with the EXCLUDE's GiST index for `valid_from <= at < valid_to` | — |
| `reconcile-instructions`, approval list, worker pass | `payouts_market_id_open_idx` | — |
| Daily reconciliation per account and day (PD15) | `journal_transactions_market_id_posted_at_idx` + the line key | — |
| Conditional per sub-order (PD15) | `journal_entries_..._conditional_idx` | — |
| `retry-commission-tax` | `commission_assessments_..._awaiting_idx` | — |

Index sizes at 3.1 × 10⁶ entries: heap 427 MB, balance index 118 MB, list index 172 MB, line key 208 MB.

### 6.2 Deliberately not added

- **A balance cache** (PD2; 11.1 L6). The payout run reads only items and the receivable (0.17 ms). Add a trigger-free cache table updated in the posting unit, rebuilt and compared nightly, when the seller view's p95 exceeds 50 ms.
- An index on `journal_entries (market_id, transaction_id)` beyond the line key (the line key serves it).
- Indexes on in-schema FK referencing columns of the journal refs: parents are never deleted.
- An index by `invoice_id` on entries: assessments are found by invoice through their unique key.

## 7. Grants

Under platform.md 10.2: hand-written in each `migration.sql`, block `-- Grants (database-designer): docs/design/data/commission-payouts.md section 7`, to `mondapac_app` only, mirrored by `REVOKE` in `down.sql`. `GRANT USAGE ON SCHEMA "commission_payouts"` in W1. **No `DELETE` and no `TRUNCATE` on any table** (PD14), with one exception ruled by Ali (L7, 2026-10-08): the platform prune of `outbox` and `inbox` is the only `DELETE` allowed on those two tables; its grant arrives with the platform prune job, as in the other modules (ID-data 3.8). Trigger functions get no grant.

| Table | Privileges of `mondapac_app` |
|---|---|
| `outbox` | `SELECT, INSERT, UPDATE (published_at)` |
| `inbox` | `SELECT, INSERT` |
| `commission_rate_series`, `payout_terms_series` | `SELECT, INSERT, UPDATE (version)` |
| `commission_rate_records`, `payout_terms_records` | `SELECT, INSERT, UPDATE (valid_to, ended_at)` |
| `journal_transactions`, `journal_entries`, `assessment_reversals`, `payout_items`, `payout_state_history`, `provider_fees`, `payout_statements`, `payout_statement_lines` | `SELECT, INSERT` |
| `commission_assessments` | `SELECT, INSERT, UPDATE (state, tax_rule_set_id, tax_rate, supplier_registered, legal_entity_registration_valid_from, tax_evaluated_at, commission_tax_minor, seller_share_minor, units_reversed, gross_reversed_minor, commission_reversed_minor, commission_tax_reversed_minor, seller_share_reversed_minor, version)` |
| `settlement_items` | `SELECT, INSERT, UPDATE (amount_minor, state, anchor_at, eligible_at, hold_days_applied, terms_record_id, payout_id, version)` |
| `payout_schedule_cursors` | `SELECT, INSERT, UPDATE (last_slot_at, next_slot_at, zone, updated_at, version)` |
| `payouts` | `SELECT, INSERT, UPDATE (state, approved_by_account_id, approved_at, approved_transfer_minor, transfer_execution_id, outcome_code, state_changed_at, version)` |
| `payout_holds` | `SELECT, INSERT, UPDATE (state, released_at, release_actor_kind, released_by_account_id, release_reason_code, outcome, release_due_at)` |
| `dispute_cases`, `dispute_case_seller_orders`, `recovery_actions`, `bank_payout_observations` | `SELECT, INSERT, UPDATE (<state and written-once columns>)` (exact lists in the slice PR, equal to the guard's mutable list) |
| `statement_sequences` | `SELECT, INSERT, UPDATE (last_number)` |

Measured: journal and payout amount `UPDATE`, journal `DELETE`, `TRUNCATE` refused `42501` for the application; owner `UPDATE`, `DELETE`, `TRUNCATE` of the journal `23001`.

## 8. Migration plan

### 8.1 Order (one migration PR open at a time; announced on the board; Phase 5 shares the slot with ordering, payments, tax, shipping)

| # | Slice | Migration | Contains |
|---|---|---|---|
| W1 | 1 | `commission_payouts_rates` | Schema, `USAGE`; `outbox`, `inbox`; `reject_mutation()`, `v2_record_guard_update()`; rate series and records (EXCLUDE, FK target); grants. `base.prisma` gains the schema (shared file, this PR) |
| W2 | 2 | `commission_payouts_journal` | Journal tables, `check_journal_balanced()` and both constraint triggers; `commission_assessments` with every column (PD8 columns stay NULL until slice 3); `provider_fees`; grants |
| W3 | 4 | `commission_payouts_terms` | Terms series and records; FK target for payouts; if W4 is already merged, `settlement_items_terms_record_id_fkey` is added here |
| W4 | 3 | `commission_payouts_items` | `settlement_items`, `payout_schedule_cursors`, guards; the terms FK if W3 is merged (slices 3 and 4 may merge in either order: slice 3 is agent-gated) |
| W5 | 5 | `commission_payouts_payouts` | `payouts`, `payout_items`, `payout_state_history`, `payout_holds`, `bank_payout_observations`; `check_payout_items()` and triggers; `settlement_items_payout_item_fkey` (`ADD CONSTRAINT … NOT VALID`, then `VALIDATE` in the same file; all `payout_id` NULL by then; `SET lock_timeout = '3s'` first). After payments' Y4 (Ali PC: no placeholder) |
| W6 | 6 | `commission_payouts_refunds_disputes` | `assessment_reversals`, `check_assessment_reversals()` and both constraint triggers (the one on `commission_assessments` is metadata only), `dispute_cases`, `dispute_case_seller_orders`, `recovery_actions`. Agent-gated slice |
| W7 | 7 | `commission_payouts_statements` | `statement_sequences`, `payout_statements`, `payout_statement_lines`. Agent-gated (PAY-09); after TX-C1 |
| — | 8 | None | COM-06 reads 3.4 |

### 8.2 Reversibility and safety

- Every `down.sql` mirrors its up in reverse: `REVOKE`s, constraint triggers and triggers, FKs added to earlier tables, tables children before parents, functions; W1 ends with `REVOKE USAGE ON SCHEMA`; the empty schema stays (ID-data 8.2). **Measured:** up → down → up three times for the W1/W2/W4/W5 prototype and twice for the assessment/reversal/payout prototype, as the non-superuser owner: clean, nothing left.
- Only W3/W4 (the cross FK), W5 (the item FK) and W6 (the assessment trigger) touch existing tables; each is metadata or validates over columns that are NULL by construction.
- A constant lowered (W2) or a new code (W9): `NOT VALID` CHECK swap with `lock_timeout`; values only added, never removed while rows hold them.
- Partitioning `journal_entries` by `posted_at` is reconsidered at 5 × 10⁷ rows; the FK to the header would then include `posted_at` already (3.3), which is why it is in the FK now.

### 8.3 Seed data

None (PD16). The initial Market rate and terms are inserted at boot by `seed-initial-records` from `config/markets/*.json` (`commissionPayouts` section, Ali Q-A4; AU 0.15, Tuesday 10:00, hold 7, A$50, AUTO; ZZ its own values), idempotent through the series partial uniques.

### 8.4 Prisma specifics

- Types: `BigInt`, `@db.Char(3)`, `@db.Timestamptz(6)`, `@db.Uuid`, `@db.VarChar(8)`, `@db.SmallInt`, `Decimal` (`numeric`, no precision), `@db.Time(0)`, `@db.Date`.
- **Prisma declares:** tables, PKs, non-partial uniques, the composite relations (the rate FK on `(market_id, id, rate)` includes a `Decimal` column, the terms FK includes `minimum_amount_minor`; not measured through Prisma, spike S1).
- **Hand-written:** every CHECK; the EXCLUDEs; the partial uniques and indexes (`*_market_key`, `*_seller_id_key`, `*_live_key`, `*_system_source_key`, `*_open_idx`, `*_active_idx`, `*_awaiting_idx`, `*_conditional_idx`, the balance indexes with `INCLUDE`); guard, reject and check functions and all constraint triggers (drift ignores triggers); grants.
- The statement number needs `INSERT … ON CONFLICT DO UPDATE … RETURNING`: Prisma `upsert` with `{increment: 1}` qualifies for a native upsert only under its documented conditions; if spike S1 shows it does not, the statement job uses one `$queryRaw` tagged template, the module's only raw statement (allow-listed in `pnpm boundaries`).
- Catalog tests: privilege map (7); partial-index and constraint-trigger lists; trigger-function settings (O16); W2 constants equal to the CHECKs; W9 lists equal to `reason-codes.ts`; "no `DELETE` grant in the schema".

## 9. Volume, retention and jobs

| Table | Rows, year 1 (upper) | Growth control |
|---|---|---|
| `journal_entries`, `journal_transactions` | 3 × 10⁶; 8 × 10⁵ | Never deleted (financial records; AG-12 retention). Partition reconsidered at 5 × 10⁷ |
| `commission_assessments`, `settlement_items`, `assessment_reversals` | 10⁶; 10⁶; a few % | Kept |
| `payouts`, `payout_items`, `payout_state_history` | 5 × 10⁴; 10⁶; 2 × 10⁵ | Kept |
| `payout_holds`, `dispute_*`, `recovery_actions`, `provider_fees`, `bank_payout_observations` | Small | Kept |
| `payout_statements` (+ lines) | 5 × 10⁴ (+ 10⁶) | Kept (V3) |
| `outbox`, `inbox` | About 5 rows per order | Platform prune (11.1 L7) |

Hot rows: `payout_schedule_cursors` (one update per seller per slot plus holds), `statement_sequences` (one per statement); both tiny. Autovacuum defaults suffice; `settlement_items` gets updates per item life (about 3), fine at 10⁶.

**Jobs** (D 11, `market_id` at the top of every statement; advisory lock per (Market, job)): payout run (cursor index; per seller unit of 5.1), reconcile instructions (open index; `transferByKey` ≤ 100, then the fenced `abandonTransfer` after `transferSendTimeout` > payments' lease), retry commission tax (awaiting index), terms pull-forward (`UPDATE settlement_items SET eligible_at = least(eligible_at, anchor_at + $days)` in batches of 1,000 by id; the guard accepts it), statements (sequence), daily reconciliation (journal sums vs `dailyTotalsOf`, Ali PC P-i; conditional per sub-order vs ordering facts), held-funds and alert jobs.

## 10. Evidence

Measured 2026-10-08 on PostgreSQL 16.15 in two throwaway clusters (under the postgres user's home, removed afterwards). Roles as platform.md 10: owner `mondapac_migrator`, group `mondapac_app`, login `mondapac_api` for every application-side case. `btree_gist` in `extensions`. Every SQLSTATE below was observed.

| Verified | Result | Used in |
|---|---|---|
| Balanced `invoice-posted` 1,100 = 935 + 150 + 15; one cent off; header without entries; a balanced pair appended to a committed transaction | ok; refused at COMMIT ×3 (`23514`) | 3.3 |
| Entry in another currency / `posted_at`; seller account without `seller_id`; duplicate source + kind; zero amount | `23503`; `23514`; `23505`; `23514` | 3.3 |
| Journal `UPDATE`/`DELETE` as the application; owner `UPDATE`/`DELETE`/`TRUNCATE` | `42501`; `23001` | W5, 7 |
| Posting cost, 4 entries | 1.39–1.60 ms with the trigger, 1.19–1.26 ms without | 3.3 |
| Second Market series; rate 0.31; 7 decimals; past `valid_from` | `23505`; `23514` ×3 | 3.2 |
| Overlap with an open record (naive `GREATEST`) / with the fix | accepted (bug) / `23P01` | W4, L11 |
| Close-then-add in one unit; `valid_to` rewritten; scheduled record cancelled to an empty period; retroactive end; rate edited | ok; `23001`; ok; `23514`; `42501` | 3.2, L4 |
| Terms hold 6 and 61; weekdays 0; hold 7 | `23514` ×3; ok | 3.2 |
| Item `eligible_at` earlier / later / NULL; anchor bound; `in-payout` without payout; amount change in payout | ok; `23001`; `23001`; `23514`; `23514`; `23001` | 3.6 |
| System hold replay; system release of `seller-suspended`; admin release; admin placing `seller-suspended` | `23505`; `23514`; ok; `23514` | 3.8 |
| Assessment: wrong share; unregistered with tax; posted without rule set; rate copy ≠ record; overlapping positions; adjacent; charge with commission | `23514` ×3; `23503`; `23P01`; ok; `23514` | 3.4 |
| Reversals: unit [0,1) with counters; two empty commission ranges; overlapping units; counters without row; wrong original commission; units > quantity | ok; ok; `23P01`; refused at COMMIT; `23503`; `23514` | 3.5 |
| Payouts: transfer ≠ gross − netted; below minimum; forged minimum; payout with item; second live payout; payout without items; netting payout | `23514`; `23514`; `23503`; ok; `23505`; refused at COMMIT; ok | 3.7 |
| Item pointing at a payout without it; `instructed` without transfer id; approval ≠ amount; manual `instructing` without approval; amount `UPDATE`; item currency ≠ payout | `23503`; `23514` ×3; `42501`; `23503` | 3.6, 3.7 |
| Gap-free numbers: 16 sessions × 25, about 30 % rollbacks | 271 committed = 1..271 | 3.10 |
| 3.1 × 10⁶ entries: biggest seller all buckets; small seller; receivable; keyset page | ≈ 100 ms; 0.6 ms; 0.17 ms; 0.19 ms | 6.1 |
| Up → down → up (3 and 2 cycles) | Clean | 8.2 |

**Not measured:** PostgreSQL 17; anything through Prisma (S1); the guard triggers of assessments, payouts and cursors (same shape as items); disputes, recovery, fees, observations, statement lines (specified only); `delivery-corrected` in the release CHECK; the conditional index; the pull-forward batch; jobs end to end; the market guard.

## 11. Findings and open points

### 11.1 Findings for Mohammad (domain text; no business rule changes)

| # | Point | Recommendation |
|---|---|---|
| L1 | D 2.1 implies one journal transaction per assessment | One transaction per (source, kind), entries carry `assessment_id`: an invoice of 30 lines is one balanced transaction, and PD1's unique key stays per source |
| L2 | PD1 "balanced per transaction" | The header declares `entry_count` and `total_minor`; a later append is refused even if balanced (measured). `PostingFactory` must set both |
| L3 | D 3.4 `MATURING → UNANCHORED` clears the anchor and may re-anchor later | **Option A (recommended):** the item keeps `eligible_at` (strict "only earlier", PD6); the correction places a system `delivery-corrected` hold, released by the system at re-delivery + hold days (`release_due_at`). The delay is an explicit hold with a reason, as PT requires. **Option B:** let the guard clear `eligible_at` on `→ unanchored`: simpler, but then any bug can push money later through unanchor/re-anchor, and PD6 is no longer a database fact. D 3.4 and 3.5's reason list change under A |
| L4 | D 3.1 does not say what happens to a scheduled record superseded by an earlier start | It is ended with `valid_to = valid_from` (empty period; measured accepted by the EXCLUDE) |
| L5 | PD8 "partial unique on payout items among live payouts" | Not expressible (the state is on `payouts`). Held by the single `settlement_items.payout_id` with the FK to `payout_items` (measured) |
| L6 | PD2 balance cache | Not at launch (measured 0.17 ms receivable, 100 ms worst-case seller view); trigger to add: p95 > 50 ms |
| L7 | PD14 "no DELETE anywhere" | Holds for the application. The platform outbox/inbox prune (P 6.5) needs a stated exception or runs under its own role: Ali to state it once for all modules (payments has the same). **Ruled by Ali 2026-10-08:** outbox/inbox pruning is the only allowed `DELETE` on those tables (7; D PD14; PAY-data 3.1) |
| L8 | TX-C1 may require the recipient's (seller's) identity on a commission tax invoice | Then statements need a seller identity column encrypted under a per-statement subject, as ordering's per-invoice subject (OD-data A9). Not added until TX-C1 says so |
| L9 | Gap-free numbering | Serialises statement issue per (Market, series): fine for a job; never number in an HTTP request |
| L10 | D 3.7 keeps attribution on the case | A child row per sub-order: a dispute spans several sellers, and Q-O4's cap is per sub-order |
| L11 | V2 EXCLUDE with open ends | `GREATEST(valid_from, NULL)` = `valid_from` gave an open record an empty range: overlaps accepted. Fixed with the `CASE` (measured). PRC-data's pattern is safe only because its ends are never NULL; the platform note should say so |
| L12 | D 15 Q-H1, Q-H3 | CHECKs use 0.30 and 60 (Ali PC). Lowering one later: `NOT VALID` without `VALIDATE` |
| L13 | D does not limit live payouts per seller | **One live payout per seller** (partial unique, measured). Without it, two live payouts compute netting from the same receivable and over-net (a MANUAL payout posts nothing until instructed). Mohammad confirms; D 3.6 to say so |
| L14 | TX-data 10.2 CHECK `before < after` on commission | `<=` here: a partial unit reversal can reverse 0 commission by rounding (C = 1, q = 3, u = 1) while units and share still move. Units and gross ranges stay strict. tax's own rule (no stored zero entry) is unchanged; the reversal row here is C-P's |
| L15 | D 4.7 step 4 "serialisable" | READ COMMITTED with the cursor as the seller lock (5.1): same outcome, no serialization retries. D 9 to say so |
| L16 | D 4.2 `dispute-debited` | Disputed amount only (`dispute-loss` / `platform-cash`), only when `fundsWithdrawn`; the fee posts once as `provider-fee` (Ali PC). New kind `transfer-after-abandon` for the fence breach |

### 11.2 Answers to D 7 (PD1 to PD16)

| PD | Answer |
|---|---|
| PD1 | 3.3: insert-only, deferred balance trigger with declared count and total, unique source; measured |
| PD2 | No balance column; no cache at launch (L6); measured |
| PD3 | 3.2: EXCLUDE (with L11 fix), `0 ≤ rate ≤ 0.30`, `UPDATE (valid_to, ended_at)` only; measured |
| PD4 | 3.2: bitmask, `time(0)`, hold `7..60`, minimum + currency, mode; no account column; measured |
| PD5 | 3.4: write-once guard, PD8 columns NOT NULL when posted, cumulative ≤ original, unique per invoice line + EXCLUDE on positions; measured |
| PD6 | 3.6: guard trigger (only earlier, never NULL), anchor CHECK, partial index; measured |
| PD7 | 3.8: write-once, release-only grant, system-source partial unique, active indexes; measured |
| PD8 | 3.7: payout id = instruction key; one live payout per item (L5) and per seller (L13); history V4; measured |
| PD9 | 3.6: PK per seller; `next_slot_at` index |
| PD10 | 3.10: V3; gap-free upsert; measured |
| PD11 | 3.9: unique payments ids |
| PD12 | 4: no personal data, codes only; issuer's own number only |
| PD13 | Platform audit writer; nothing in this schema |
| PD14 | 7: no `DELETE` grant (L7) |
| PD15 | 6.1: posted-at index, conditional index |
| PD16 | 8.3: no seed in migrations |

### 11.3 For Hassan

| # | Question |
|---|---|
| HL1 | Q-S3: write-off two-person rule as `confirmed_by_account_id <> requested_by_account_id` (3.9); also for `payout.approve` above an amount? (then an `approvals` child table, not a column) |
| HL2 | Deferred-trigger messages name the transaction, assessment or payout id and the sums of that row (no personal data). Acceptable in logs? |
| HL3 | Q-S4: the database stores the exact reason code; which codes the seller sees is a mapping in the read use case. Confirm `seller-suspended`, `dispute`, `delivery-corrected` show only as `on-hold` |
| HL4 | Q-S2: the cursor lock (5.1, L15) as the closure of the in-unit re-check, instead of `serializable` |

**Hassan's answers (Hassan payments and commission-payouts review 2026-10-08, 2026-10-08):** HL1 **accepted** for write-off and **extended to external collection** (HP-7); confirmation columns NOT NULL before `recorded`, journal only after confirmation, confirmer holds the key with a recent confirmation, not in acting-as (3.9). No `approvals` table: `payout.approve` gets no amount-based second approver. HL2 **accepted with conditions** (as PAY-data HY2): ids and the row's own sums in server logs only; every `23xxx` mapped to a generic code with no `message`/`DETAIL` to a client; Prisma logger drops `meta`/`DETAIL`; deployed PostgreSQL `log_error_verbosity = terse`, no statement parameters (Kazem). HL3 **answered**: store the exact code; sellers see `seller-suspended`, `dispute`, `admin-review` as `on-hold`, and `refund-pending`, `not-received`, `delivery-corrected` specifically (D 5.4). HL4 **accepted**, plus a re-check of `accessStatesForPayout` after commit, before instruction (D 4.7 step 5). New data conditions: HP-7 and HP-8 (3.9), HP-5 (3.9 `dispute_cases`), HP-2 (3.8 `admin-review` source).

### 11.4 Still open

| # | Point | Who |
|---|---|---|
| S1 | Prisma 7: `Decimal` in a composite relation; native upsert for the sequence; drift with constraint triggers | Hossein, with me, slices 1, 2, 7 |
| ~~L3, L13, L15~~ | Domain text | Closed 2026-10-08: accepted by Mohammad (L3 option A) and written into D (with L11, L14) |
| ~~L7~~ | Prune exception to "no DELETE" | Closed 2026-10-08: ruled by Ali (11.1 L7) |
| Q-O1 to Q-O4 | Built to Ali's recommendations; the owner answered as recommended (owner, 2026-10-08) | Closed |
| L8 | Seller identity on statements | TX-C1 mini-review |
| K1 | Pool sizing for the payout run (one unit per seller, 100 per batch); `lock_timeout` 3 s on 5.1 units | Kazem |

## 12. Follow-up changes

This document changes no other file. After G2:

| File | Change | When |
|---|---|---|
| `docs/design/data/commission-payouts.md` | This document with the review answers | At G2; Mojtaba |
| `docs/design/domain/commission-payouts.md` | L1 to L16 if accepted (D 2.1, 3.4, 3.5, 3.6, 3.7, 4.2, 4.7, 9) | Mohammad |
| `prisma/schema/base.prisma`, `commission-payouts.prisma`; W1 to W7 with `down.sql` | As specified; each needs my sign-off | Per slice; Hossein |
| `docs/design/data/platform.md` | L11 note on V2 EXCLUDE with NULL ends | Mojtaba, platform PR |

## 13. Review record

| Date | Reviewer | Outcome | Applied |
|---|---|---|---|
| 2026-10-08 | Ali (cto), Ali payments and commission-payouts review 2026-10-08 | Facade contract and values ruled; Q-O1 to Q-O4 were owner questions with Ali's recommendations; **answered as recommended (owner, 2026-10-08)** | P-a to P-i names and ids (3.7, 3.9), dispute fee once (L16), `transfer-after-abandon`, `transfer-reversal-failed.v1`, W2 constants; built to the recommendations, now confirmed: Q-O1 `admin-review` system hold, Q-O2 no reversal row, Q-O4 share cap |
| 2026-10-08 | Mohammad (software-architect), reconciliation (D's log) | L3 (option A), L11, L13, L14, L15 accepted and applied in D; L7 ruled by Ali; L14's `<=` applied to `docs/design/data/tax.md` 10.2 too | 3.1 to 3.9 unchanged except the pending marks; 7, 11.1, 11.4 |
| 2026-10-08 | Mojtaba (database-designer) | **G2 sign-off, 2026-10-08: design approved; measurements in slice migrations W6** (constraints so far measured on PostgreSQL 16.15, 10) | Whole document. Re-review of the `recovery_actions` conditions (3.9): NULL-safe evidence CHECK (the first form accepted a recorded external collection with no code), requester NOT NULL in the two-person CHECK, kind/state, confirm and journal CHECKs; measured on PostgreSQL 16.15 ("Mojtaba G2") |
| 2026-10-08 | Hassan (security-tester; mandatory), Hassan payments and commission-payouts review 2026-10-08 | Approved with conditions; HL1 extended, HL2 with conditions, HL3 answered, HL4 accepted | Data conditions written in by Mohammad with this file (3.8, 3.9, 11.3); not measured yet: Mojtaba measures and signs off in W6 |
| 2026-10-08 | Hassan re-check (Hassan re-check 2026-10-08) | Approved with conditions; evidence pattern and NULL-safe CHECK closed | Mohammad with Mojtaba (specified, not measured; measured in W6): 3.9 evidence-code partial unique index and one literal (item 4); `payout-account-compromised` reason and 3.3 kind `transfer-recalled` (item 2(b)); CP-R1 open |
| 2026-10-08 | Ali, Ali ruling CP-R1 2026-10-08 (CP-R1) | `recall` settlement item; reconciliation `seller-payable` = Σ unpaid items | Mohammad with Mojtaba (specified, not measured; slice 6 migration W6): 3.6 `kind`, `recovery_action_id`, `settlement_items_kind_check`, unique per action, FK to `recovery_actions` with seller, currency and amount, guard on `recall` rows; 3.9 FK target; 5.3 reconciliation row |
