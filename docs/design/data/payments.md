# Physical data model — `payments` schema (G2)

**Author:** Mojtaba (database-designer) — 2026-10-08
**Status:** G2 data design, draft for review by Mohammad (software-architect), Ali (cto) and Hassan (security-tester; mandatory, tier A). Ali's ruling on the payments ↔ commission-payouts contract (Ali payments and commission-payouts review 2026-10-08, cited "Ali PC") is applied: P-a to P-i, the transfer fence (`abandonTransfer`), `transferByKey`, `bankPayoutId`, `fundsWithdrawn`, the dispute fee only through `fee-charged`, `dailyTotalsOf`, A-1 to A-6. Each migration still needs my sign-off. The non-trivial constraints were measured on PostgreSQL 16.15 (10).
**Ground truth:** `docs/design/domain/payments.md` (Mohammad, G2 draft 2026-10-08; cited as **D**, for example "D 3.2"; inputs PD1 to PD16 in D 8); `docs/modules/payments/brief.md` (G1 approved 2026-10-08; "brief s5", "Q3", "AC n"); Ali PC; `docs/design/data/ordering.md` (**OD-data**: money O1, rates O2, proved copies O3, guard triggers O4/O5/O16, NULL-counting shape CHECKs O14, refund lock order 6.1, orphan facts 3.14); `docs/design/data/tax.md`; `docs/design/data/commission-payouts.md` (**CP-data**, written together with this document); `docs/design/data/platform.md` section 10 (roles and grants) and 10.9 (partial indexes and prepared statements); `docs/design/data/identity.md` (**ID-data**, conventions C1 to C11); `docs/design/data/pricing.md` (**PRC-data**: P1 money, P5 write-once, P6 no delete, P7 statement order); ADR-0001, 0003, 0004 (decisions 3 to 7), 0005, 0006, 0007 (decision 1), 0009, 0018, 0025, 0026, 0035 (decisions 3, 4, 5, 7).
**Prisma models:** `prisma/schema/payments.prisma` (new). Nothing exists yet.
**Business rules:** none changed. Where the mapping needed a choice D does not make, or where I recommend a change to D, it is a finding in 11.1.

## 1. Scope and table list

The physical design of everything D 8 asks the database to hold: tables, constraints, locking, access paths, grants, the migration plan, volume and retention. It covers PD1 to PD16 and the facade reads Ali PC added (P-c `transferByKey`, P-d `abandonTransfer`, P-i `dailyTotalsOf`).

ADR-0009 patterns: **V4** (append-only) for card display, attempt outcomes, payout-account changes and fee charges. Everything else is a live root with write-once content (PRC-data P5) and a forward-only state guard. Nothing is V1, V2 or V3: `payments` freezes nothing for other modules (they receive ids).

| Table | Holds (D 2.1) | Pattern | Migration (8.1) / slice (brief s11) |
|---|---|---|---|
| `payments.outbox`, `payments.inbox` | Events (ADR-0006). `inbox` stays empty: `payments` consumes no bus event (D 7, P-6) | Queue | Y1 / 1 |
| `payments.payments` | `Payment` root | Live root, write-once content | Y1 / 1 |
| `payments.payment_card_displays` | `CardDisplay` (0..1 per payment): **brand and last 4 only** (11.1 Y1) | V4, 1:1 | Y1 / 1 |
| `payments.payment_attempt_outcomes` | `PaymentAttemptOutcome` (declines, authentication failures; the P-8 cap) | V4 | Y1 / 1 |
| `payments.provider_commands` | `ProviderCommand`: stored key, fingerprint and lease of every payment-intent and account-creation write | Live, write-once content | Y1 / 1 |
| `payments.provider_events` | `ProviderEvent`: the webhook inbox, **ids only, no body** (PD5) | Queue, pruned | Y2 / 2 |
| `payments.connected_accounts` | `ConnectedAccount` | Live root | Y3 / 4 |
| `payments.payout_account_changes` | `PayoutAccountChange` (VER-10 history) | V4 | Y3 / 4 |
| `payments.transfer_executions` | `TransferExecution`, with the transfer fence (Ali PC P-d) | Live, write-once content | Y4 / 5 |
| `payments.transfer_reversals` | `TransferReversal` | Live, write-once content | Y4 / 5 |
| `payments.bank_payouts` | `PayoutObservation`, renamed (Ali PC: `bankPayoutId`) | Live, observed | Y4 / 5 |
| `payments.refund_commands` | `RefundCommand` (RET-06, compensation, external), with the P-7 fence and tombstones | Live, write-once content | Y5 / 6 |
| `payments.disputes` | `Dispute` | Live, observed | Y6 / 7 |
| `payments.fee_charges` | `FeeCharge` (Q8) | V4 | Y6 / 7 |

Every table carries `market_id` and `tenant_id`. No table holds card numbers, CVC, full expiry, bank details, names, emails, addresses or IP addresses (4).

### 1.1 ER sketch

FK = a composite foreign key that leads with `market_id` (ID-data C3). Dotted = a plain id, no FK (ID-data C4).

```
payments.payments ───────────────┬──< payment_card_displays          (market_id, payment_id) 1:1, insert-only
  id, order_id (unique per Market)│
  customer_account_id ...........│──< payment_attempt_outcomes       one per provider event
  currency, amounts, status,      │
  refund_regime (write-once)      ├──< refund_commands               FK (market_id, payment_id, currency)
                                  │        key (unique), kind, regime   FK (market_id, payment_id, regime) -> (.., refund_regime)
                                  │        breached_key ──> refund_commands (market_id, key)   (fence breach)
                                  ├──< disputes                       FK (market_id, payment_id, currency)
                                  └──< fee_charges (payment-processing) FK, nullable
payments.provider_commands        key (unique), target_id .......... (payment or seller id)

payments.connected_accounts ─────┬──< payout_account_changes        FK (market_id, account_id, seller_id)
  seller_id ...., one non-closed │──< transfer_executions ──< transfer_reversals
  row per (Market, seller)       │        instruction_key (unique)     reversal_key (unique)
                                 └──< bank_payouts                    FK (market_id, account_id, seller_id)
payments.provider_events          (market_id, provider_code, provider_event_id) unique; no FK, no body
payments.outbox, payments.inbox   no FK
```

## 2. Conventions

ID-data C1 to C10, PRC-data P1, P5, P6, P7 and OD-data O1, O3, O4, O5, O6, O10, O14, O16 apply unchanged. Not repeated in the column tables: `market_id`/`tenant_id` and their CHECKs. What `payments` adds:

| # | Convention |
|---|---|
| Y1 | **Money** as OD-data O1: `<name>_minor bigint`, one `currency char(3)` per row. A requested, refund, transfer, reversal or fee amount is `BETWEEN 1 AND 9007199254740991`; counters (`amount_authorised_minor`, `amount_captured_minor`, `amount_refunded_minor`, `amount_refund_pending_minor`, `reversed_minor`, `reversal_pending_minor`) are `>= 0`. A child's currency is proved equal to its parent's by a foreign key that includes `currency` (O3). The Market's currency and `maxPaymentAmount` are configuration (D 2.2 `PaymentsPolicy`), not CHECKs (OD-data O13) |
| Y2 | **Provider codes and refs** (PD16). `provider_code text` CHECK `IN ('stripe', 'fake')` on every table that holds a provider ref. Each ref column has a per-kind CHECK: `char_length <= 255` and `(provider_code = 'stripe' AND ref ~ '^<prefix>[A-Za-z0-9]+$') OR (provider_code = 'fake' AND ref ~ '^fake_<prefix>[A-Za-z0-9]+$')`, with the prefixes `pi_` (payment), `re_` (refund), `acct_` (account), `tr_` (transfer), `trr_` (transfer reversal), `po_` (bank payout), `dp_` (dispute), `txn_` (balance transaction), `evt_` (event). A wrong-kind value is refused (measured on `pi_` with an `re_` value, `23514`). A new provider is a new adapter release and a CHECK swap migration (8.2). Refs are written once and never leave the module (D 2.1) |
| Y3 | **Command keys** (D 2.2 `CommandKey`): `text` CHECK `^[A-Za-z0-9:_-]{1,128}$`, unique per (Market, table): `provider_commands.key`, `refund_commands.key`, `transfer_executions.instruction_key`, `transfer_reversals.reversal_key`. The content a key stands for (target, kind, amount, currency) is stored in plain columns **and** as `content_hash text` CHECK `^sha256:[0-9a-f]{64}$` (the fingerprint holds no personal field, so it is SHA-256, OD-data O15). Content and fingerprint are immutable (guard trigger, `23001`; column grants, `42501`) |
| Y4 | **"Same key, other content" is refused in two layers.** The reserving unit inserts with the unique key; on `23505` (Prisma `P2002`) the repository reads the stored row and compares the fingerprint: equal → the stored answer; different → `idempotency.key-reused` (ADR-0035 d3). The database guarantees that the stored row cannot be rewritten to match a second request (measured: a second insert of key `rr-1` with 5,000 instead of 3,000 refused `23505` and its unit rolled back; `UPDATE amount_minor` refused `42501`). The comparison itself is the domain's, because PostgreSQL never sees the second request as a row |
| Y5 | **Leases and the "sent at most once" rule** (D 3.2, Ali PC P-d). A command row that reaches the provider carries `sending_until`, `attempt_token` and `send_count smallint`. RET-06 refunds and transfers are **never re-sent by `payments`**: CHECK `send_count <= 1`, and the guard trigger refuses a new `attempt_token` once one is written (measured `23001`). Compensation refunds and provider commands may be re-sent with the same key (D 3.2, 4.2); `send_count` only grows |
| Y6 | **Forward-only states.** Every state column is `text` with a closed CHECK (O6) holding every value a later slice needs. A `BEFORE UPDATE` guard trigger per table allows only D 3's transitions, freezes final states and refuses any change to content or written-once columns, for every role, the owner included (`23001`). The triggers do not encode the guards that need other rows (5) |
| Y7 | **Deferred counter checks.** Where a parent stores a running sum of child rows that a cap depends on (`payments` refund counters; `transfer_executions` reversal counters), a `DEFERRABLE INITIALLY DEFERRED` constraint trigger re-sums the children at `COMMIT` and refuses a mismatch with `23514`. The immediate CHECK on the parent carries the cap; the deferred trigger proves the counters are not invented. It never fires in a correct unit; it exists for a bug or a manual script (measured: a counter raised without a refund row, and a refund row without the counter, both refused at commit) |
| Y8 | **Isolation: READ COMMITTED everywhere** (ADR-0025). Every cross-row rule has a holder in 5.2. D 3.2 asks for one `serializable` unit in `abandonRefund`; it is not needed (11.1 Y9). Read-only facades (`paymentOf`, `payoutReadiness`, `transferByKey`, `feeChargesOf`, `disputeOf`, `dailyTotalsOf`) open no transaction (ADR-0025 decision 1) |
| Y9 | **Prisma model names** start with `Payments` (`PaymentsPayment`, `PaymentsRefundCommand`), tables mapped with `@@map` (ID-data C9). Constraint and index names are given in full where PostgreSQL's 63-byte limit would truncate the default (measured: `connected_accounts_market_id_provider_code_provider_account_ref_key` was truncated; it is named `connected_accounts_market_id_provider_account_ref_key`) |

## 3. Tables

"Identifier" marks a plain id that points at a person. Constraint and index names are the exact database names.

### 3.1 `payments.outbox` and `payments.inbox` (Y1)

The identity tables with the module name changed (ID-data 3.1, 3.8): `outbox_type_check` `^payments\.[a-z0-9-]+\.v[1-9][0-9]*$`, `inbox_handler_check` `^payments\.[a-z0-9-]+$`; unique `outbox_market_id_aggregate_id_aggregate_version_key`; partial `outbox_market_id_event_id_unpublished_idx`; `inbox_pkey (event_id, handler)`.
- Aggregate types: `payment`, `refund`, `connected-account`, `transfer`, `bank-payout`, `dispute`, `fee-charge`. Events of D 7.2 as amended by Ali PC: `connected-account-status-changed.v1` and every event without a named consumer are dropped (ADR-0015).
- Payloads: ids, enums and instants only. **No amount** (Ali A-3), no provider ref, no card field, no actor, no free string (D 7.2). The database cannot check that; the mandatory contracts snapshot test does.
- `inbox`: created for the platform contract (D 8), never written while `payments` consumes no bus event (P-6). No `DELETE` grant until the platform prune job exists.
- **Ali's L7 exception (2026-10-08):** the platform prune of `outbox` and `inbox` is the only `DELETE` allowed on those two tables; its grant arrives with the platform prune job, as in the other modules (ID-data 3.8). PD12's "no `DELETE`" means no other `DELETE`.

### 3.2 `payments.payments` (Y1; D 2.1, 3.1, 4.2, 4.3; PD1)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; the `paymentId` of every facade and event |
| `order_id` | `uuid` | no | ordering's order id (C4). Unique `payments_market_id_order_id_key`: one `Payment` per (Market, order) (PD1). Events read it from here (D 4.3: every payment and refund event carries `orderId`) |
| `customer_account_id` | `uuid` | no | **Identifier.** The customer; ownership of `view-own-payment` (D 6.2) |
| `provider_code` | `text` | no | Y2 |
| `provider_payment_ref` | `text` | yes | `pi_…` (Y2). Written once, in unit 2 of `createPayment` (D 4.2). Unique `payments_market_id_provider_code_provider_payment_ref_key` (PD1) |
| `capture_method` | `text` | no | CHECK `= 'manual'` (ADR-0035 d4: no automatic capture path in Phase 5; measured: `automatic` refused). A later method is a CHECK swap, reviewed by Hassan |
| `payment_methods_offered` | `text[]` | no | From the Market config at creation (D 2.1). CHECK 1 to 3 elements, `<@ ARRAY['card','apple-pay','google-pay']`, no NULL element (Q13; measured: `link` refused) |
| `payment_method_used` | `text` | yes | The method that authorised (`card`, `apple-pay`, `google-pay`). Written once at `authorised`. This replaces D 4.5's wallet column on the card table (11.1 Y1) |
| `currency` | `char(3)` | no | Y1 |
| `amount_requested_minor` | `bigint` | no | Y1, `>= 1` |
| `amount_authorised_minor`, `amount_captured_minor`, `amount_refunded_minor`, `amount_refund_pending_minor` | `bigint` | no | Counters, `>= 0`, only grow except `refund_pending` (guard trigger) |
| `status` | `text` | no | CHECK `requires-payment`, `authorised`, `capture-requested`, `captured`, `capture-failed`, `cancelled`, `expired` (D 3.1) |
| `refund_regime` | `text` | no | CHECK `none`, `ret06`, `compensation`. Written once from `none` (guard trigger; measured: `ret06` → `compensation` refused `23001`) |
| `decline_count` | `smallint` | no | `>= 0`, only grows; equals the payment's `payment_attempt_outcomes` rows (repository test) |
| `expires_at` | `timestamptz(6)` | no | The reservation's expiry from `ordering` (D 2.1) |
| `authorisation_expires_at` | `timestamptz(6)` | yes | The provider's `capture_before` |
| `authorised_at`, `captured_at` | `timestamptz(6)` | yes | Written once. CHECK `payments_captured_check`: `(status = 'captured') = (captured_at IS NOT NULL)` |
| `status_changed_at`, `created_at` | `timestamptz(6)` | no | |
| `version` | `integer` | no | C5. Raised by every unit that touches the payment, as its first statement on it (6.1) |

**Constraints that carry D's invariants** (all measured, 10):

| Constraint | Invariant |
|---|---|
| `payments_amounts_check`: `amount_captured_minor <= amount_authorised_minor AND amount_authorised_minor <= amount_requested_minor AND amount_refunded_minor + amount_refund_pending_minor <= amount_captured_minor` | Captured ≤ authorised ≤ requested; **the RET-06 refund cap** (PD1, brief s5): over-cap refused `23514` (measured: 3,000 pending + 7,001 on 10,000) |
| `payments_full_capture_check`: `amount_captured_minor = 0 OR amount_captured_minor = amount_authorised_minor` | Full capture only, no partial capture (D 3.1 "Captured = authorised") |
| `payments_market_id_order_id_key` | One payment per (Market, order); the same order id in ZZ is a separate payment (measured) |
| Trigger `payments_guard_update` (function `payments.payments_guard_update()`) | Content immutable; ref, method, `authorised_at`, `captured_at` written once; `refund_regime` written once; transitions only as D 3.1; `captured`, `capture-failed`, `cancelled`, `expired` final; counters only grow (refund pending excepted) |
| Triggers `payments_no_delete`, `payments_no_truncate` (function `payments.reject_mutation()`) | Never deleted: financial retention (PD13; measured `23001` for the owner, `42501` for the application) |
| Constraint trigger `payments_refund_counters` (deferred, Y7) | `amount_refunded_minor` and `amount_refund_pending_minor` equal the sums of the payment's refund rows (3.11) |

Unique keys that only serve as FK targets: `payments_market_id_id_key`, `payments_market_id_id_currency_key` (O3: refunds and disputes prove the currency), `payments_market_id_id_refund_regime_key` (3.11: a refund's kind is proved equal to the payment's regime). Cost: three small btrees on a table of at most 10⁶ rows a year.

**Provider amount above the request.** If the provider ever reports an authorised amount above `amount_requested_minor`, `payments_amounts_check` refuses the write. D 3.1 keeps such a payment `AUTHORISED` with the provider's facts; the physical model cannot store a figure above the request. The handler records the anomaly (event `dead`, alert) and voids (11.1 Y4).

### 3.3 `payments.payment_card_displays` (Y1; D 4.5; PD8)

| Column | Type | Null | Notes |
|---|---|---|---|
| `payment_id` | `uuid` | no | PK `payment_card_displays_pkey (market_id, payment_id)`; FK `(market_id, payment_id)` → `payments` |
| `brand` | `text` | no | CHECK `visa`, `mastercard`, `amex`, `discover`, `diners`, `jcb`, `unionpay`, `eftpos-au`, `unknown` (the adapter maps Stripe's `card.brand`) |
| `last4` | `char(4)` | no | CHECK `^[0-9]{4}$` (measured: `42a2` refused) |
| `recorded_at` | `timestamptz(6)` | no | |

- **No other card column exists** (brief s5; D 11). Written once, at `authorised`, from the provider re-read; insert-only (trigger `payment_card_displays_no_update_delete`; application `UPDATE` refused `42501`, measured).
- Not stored, though D 4.5 lists them: expiry month and year, network, wallet kind on this table (11.1 Y1). No use case reads them (no saved cards, brief s3); the wallet is `payments.payment_method_used`.
- A schema test (`pnpm test:db`) lists every column of the schema and fails on any column whose name or comment matches the card or bank vocabulary (`pan`, `card_number`, `cvc`, `cvv`, `exp`, `bsb`, `account_number`, `iban`, `routing`), as the second layer under D 11's log and DB scan.

### 3.4 `payments.payment_attempt_outcomes` (Y1; D 3.1 P-8)

`id uuid` PK; `payment_id` FK `(market_id, payment_id)` → `payments`; `outcome text` CHECK `declined`, `authentication-failed`, `processing-error`; `provider_code`; `provider_event_id text` (`evt_`, Y2); `occurred_at` (the provider event's `created`); `recorded_at`. Unique `payment_attempt_outcomes_market_id_provider_event_id_key (market_id, provider_code, provider_event_id)`: a redelivered or re-read failure counts once, so `decline_count` is idempotent. Insert-only (O5). No provider decline code or message is stored (D 3.1: `reasonCategory` only).

### 3.5 `payments.provider_commands` (Y1; D 2.1, 4.2, 10; PD2)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `key` | `text` | no | Y3. Unique `provider_commands_market_id_key_key` |
| `kind` | `text` | no | CHECK `create-intent`, `capture`, `cancel`, `decline-cap-cancel`, `hold-limit-cancel`, `void-after-capture-failure`, `create-connected-account` |
| `target_id` | `uuid` | no | The payment id (payment kinds) or the seller id (`create-connected-account`) |
| `amount_minor`, `currency` | `bigint`, `char(3)` | yes | Present for `create-intent` and `capture` (`num_nonnulls` shape CHECK, O14) |
| `content_hash` | `text` | no | Y3 |
| `provider_code` | `text` | no | Y2 |
| `state` | `text` | no | CHECK `reserved`, `sending`, `succeeded`, `refused`. `unknown` answers stay `sending` (D 2.3) |
| `send_count`, `sending_until`, `attempt_token` | `smallint`, `timestamptz(6)`, `uuid` | | Y5; re-send with the same key allowed (D 4.2, within Stripe's 24 h) |
| `result_code` | `text` | yes | A definite refusal's code (pattern CHECK), never a provider message |
| `created_at`, `state_changed_at` | `timestamptz(6)` | no | |

- Partial unique `provider_commands_market_id_target_id_settle_key (market_id, target_id) WHERE kind IN ('capture', 'cancel', 'decline-cap-cancel', 'hold-limit-cancel')`: **capture and cancel of one payment can never both be stored**, so they can never both be sent (D 10 "the second sees the first's command row"). `void-after-capture-failure` is outside it (it follows a failed capture). Not measured; same form as the measured partial unique keys.
- Transfers, reversals and refunds keep their keys on their own tables (3.8, 3.9, 3.11), not here (11.1 Y2).
- Guard trigger: content and fingerprint immutable; `reserved → sending → succeeded | refused`; `reserved → refused`. Never deleted (PD2).

### 3.6 `payments.provider_events` (Y2; D 5.2 to 5.4; PD5)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK (our id, for claiming by id) |
| `provider_code` | `text` | no | Y2 |
| `provider_event_id` | `text` | no | `evt_…`. Unique `provider_events_market_id_provider_event_id_key (market_id, provider_code, provider_event_id)`: `ON CONFLICT DO NOTHING`, duplicate → 200 (D 5.2 step 3) |
| `destination` | `text` | no | CHECK `platform`, `connected` (D 5.1) |
| `event_type` | `text` | no | CHECK `^[a-z_]+(\.[a-z_]+){1,3}$`, at most 128 characters |
| `object_type` | `text` | no | CHECK `^[a-z_.]{1,64}$` |
| `object_ref` | `text` | no | CHECK `^[A-Za-z0-9_]{1,255}$`. Any provider object kind, so no per-kind prefix here |
| `connected_account_ref` | `text` | yes | `acct_…` (Y2). NULL for `platform` (D 5.2 step 2). CHECK `(destination = 'connected') = (connected_account_ref IS NOT NULL)` |
| `livemode` | `boolean` | no | CHECK `provider_events_livemode_check`: `livemode = false` (11.1 Y8: a second lock beside `LIVE_MODE_ALLOWED`, D 4.11) |
| `provider_created_at` | `timestamptz(6)` | no | The provider's `created` |
| `received_via` | `text` | no | CHECK `webhook`, `reconciliation` (D 5.4: the daily job enqueues missed events) |
| `status` | `text` | no | CHECK `pending`, `applied`, `ignored`, `dead` |
| `attempts` | `smallint` | no | `>= 0` |
| `next_attempt_at` | `timestamptz(6)` | no | PE back-off |
| `last_error_code` | `text` | yes | Code pattern only |
| `received_at` | `timestamptz(6)` | no | |
| `settled_at` | `timestamptz(6)` | yes | Set with `applied` or `ignored`. CHECK `(status IN ('applied', 'ignored')) = (settled_at IS NOT NULL)` |

- **No body, no snapshot, no header column** (D 5.3): billing details, emails and IP addresses cannot be stored because no column can hold them.
- Indexes: claim `provider_events_market_id_next_attempt_at_pending_idx (market_id, next_attempt_at, id) WHERE status = 'pending'` (D 5.4, `FOR UPDATE SKIP LOCKED` through the platform claim helper); per-object grouping `provider_events_market_id_object_ref_pending_idx (market_id, object_ref) WHERE status = 'pending'`; prune `provider_events_market_id_settled_at_idx (market_id, settled_at) WHERE status IN ('applied', 'ignored')`. Each relies on custom plans (platform.md 10.9).
- **The only `DELETE` grant of the schema** (PD12): the prune job removes `applied` and `ignored` rows whose `settled_at` is older than 30 days (D 5.3), with the status and time conditions repeated in the `deleteMany` (OD-data 9.2). `dead` rows are kept until an operator re-queues them (status back to `pending` only from `dead`, guard trigger).

### 3.7 `payments.connected_accounts` and `payments.payout_account_changes` (Y3; D 3.4, 4.6; PD4, PD9)

**`connected_accounts`**

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `seller_id` | `uuid` | no | **Identifier** (a seller may be a sole trader) |
| `creation_seq` | `smallint` | no | The `<n>` of key `connected-account:<sellerId>:<n>` (D 4.6). Unique `(market_id, seller_id, creation_seq)` |
| `provider_code`, `provider_account_ref` | `text` | no, yes | `acct_…`, written once. Unique `connected_accounts_market_id_provider_account_ref_key (market_id, provider_code, provider_account_ref)` |
| `status` | `text` | no | CHECK `not-started`, `pending`, `restricted`, `enabled`, `rejected`, `closed` (D 3.4). `closed` is final |
| `transfers_active`, `payouts_enabled` | `boolean` | no | From the provider re-read |
| `requirements_due_count`, `requirements_past_due_count` | `smallint` | no | `>= 0`. Counts only (D 2.1) |
| `requirement_categories` | `text[]` | no | CHECK `<@ ARRAY['identity','business','representative','bank-account','tax','other']`, no NULL element. Categories only, never a value (VER-10) |
| `cooling_off_until` | `timestamptz(6)` | yes | The VER-10 waiting period. **Can only be extended** (guard trigger; measured: shortening refused `23001`). Equal to the latest `payout_account_changes.cooling_off_until` (repository test) |
| `provider_observed_at` | `timestamptz(6)` | yes | The re-read instant; only moves forward |
| `closed_at`, `closed_by_account_id`, `close_reason_code` | | yes | CHECK `connected_accounts_closed_check`: all three set if and only if `closed` (admin close, D 6.2) |
| `status_changed_at`, `created_at`, `version` | | no | |

- **One active account per seller** (PD4): partial unique `connected_accounts_market_id_seller_id_active_key (market_id, seller_id) INCLUDE (status) WHERE status <> 'closed'`. Measured: a second non-closed account refused `23505`; after closing, a new one accepted; the same seller in ZZ accepted. `rejected` counts as active, so an admin closes it before a new one starts (D 3.4).
- Unique `connected_accounts_market_id_id_seller_id_key`: the FK target that proves `seller_id` on changes, transfers and bank payouts (O3).
- `ready` is derived (`status = 'enabled'`, D 3.4), never stored.
- **No column can hold a bank number, BSB, name, email, ABN or identity document** (VER-10; D 11).

**`payout_account_changes`** (insert-only, O5): `id uuid` PK; FK `(market_id, connected_account_id, seller_id)` → `connected_accounts`; `kind` CHECK `initial`, `added`, `updated`, `removed`; `provider_code`, `provider_event_id` with unique `(market_id, provider_code, provider_event_id)` (one change per provider event, idempotent); `detected_at`; `cooling_off_until` with CHECK `(kind = 'initial') = (cooling_off_until IS NULL) AND (cooling_off_until IS NULL OR cooling_off_until > detected_at)` (D 4.6: the first connection starts no cooling-off; every later change does). No bank field.

**Hassan's conditions (2026-10-08; Y3, slice 4 unless noted; specified, not measured; my sign-off on the migration):**
- **HP-3, replacement account:** `kind` CHECK gains `replaced`. `payout_account_changes` gains `account_creation_seq smallint NOT NULL`, carried in the FK `(market_id, connected_account_id, seller_id, account_creation_seq)` → a new unique `connected_accounts (market_id, id, seller_id, creation_seq)`, and CHECK `kind <> 'initial' OR account_creation_seq = 1`: `initial` exists only on the seller's first account in that Market; the first change on any later account is `replaced`, with a cooling-off (the existing CHECK then requires `cooling_off_until`). **Mojtaba G2 (2026-10-08; measured on PostgreSQL 16.15, throwaway schema):** the CHECK alone let a `replaced` row sit on account 1 and two opening rows on one account. It becomes `payout_account_changes_seq_kind_check` `(kind <> 'initial' OR account_creation_seq = 1) AND (kind <> 'replaced' OR account_creation_seq > 1)`, plus partial unique `payout_account_changes_opening_key (market_id, connected_account_id) WHERE kind IN ('initial', 'replaced')` (one opening change per account; with the unique `(market_id, seller_id, creation_seq)` this is one `initial` per seller and Market). Measured: `initial` on account 2 and `replaced` on account 1 refused `23514`, a second `replaced` refused `23505`, a wrong `account_creation_seq` refused `23503`, `replaced` without cooling-off refused `23514`. That the first change on a later account is the opening one is a repository test.
- **HP-1.2, live check:** `connected_accounts.external_account_hmac text NULL`, CHECK `~ '^hmac-sha256:k[1-9][0-9]{0,3}:[0-9a-f]{64}$'` (**Mojtaba G2 (2026-10-08; measured on PostgreSQL 16.15, throwaway schema):** the value carries the key version, so a key rotation is not read as a changed bank account for every seller: the live check recomputes with the stored version, and a rotation re-stamps only under the re-stamp rules below (Hassan re-check item 6 replaced "re-stamps from a live read without recording a change"); the unversioned form refused `23514`, the versioned accepted) (keyed hash of the default external account's provider id; never the id; not bank data, VER-10); added to the `UPDATE` grant (7). `payout_account_changes` gains `detected_by` CHECK `webhook`, `live-check`; `provider_event_id` NULL only when `detected_by = 'live-check'` (CHECK), so the unique key still makes webhook changes idempotent. Slice 5 reads it; slice 4 writes it. **Re-stamp rules (Hassan re-check item 6; D 4.6 condition 2; slice 4; specified, not measured; my sign-off on the migration):** (i) a re-stamp computes the HMAC of the live provider id under the **stored** version's key; only if it equals the stored value (constant-time compare in the application) does one guarded statement write the new-version value: `UPDATE … SET external_account_hmac = $new, version = version + 1 WHERE market_id = $m AND id = $a AND external_account_hmac = $stored` (a NULL column never equals, so the statement is NULL-safe and a concurrent change makes it update 0 rows). Otherwise the unit inserts a `payout_account_changes` row (`detected_by = 'live-check'`, `provider_event_id` NULL, `cooling_off_until` set, extended on the account) together with the new value; (ii) a NULL `external_account_hmac` never counts as a match: `instructTransfer` answers `payments.transfer.account-not-ready` until a webhook or a live read stamps it; (iii) key retirement: a version is removed from the secret store only when `SELECT count(*) FROM payments.connected_accounts WHERE external_account_hmac LIKE 'hmac-sha256:k' || $v || ':%'` returns 0 (Kazem's runbook step; small table, no index); a stored version whose key is missing answers `payments.unavailable` plus an alert, never a re-stamp; (iv) repository rule: an `UPDATE` that sets a different value under the same `k<version>` prefix runs only in a unit that also inserts a `payout_account_changes` row for that account; a `test:db` test proves the repository refuses it otherwise. A trigger is not the lock here: it cannot tell a rotation from a change without the key; a deferred check on "a change row inserted in this transaction" (`xmin`) was considered and not taken.
- **HP-1.1, option 2 only (if F-3 cannot be closed):** `connected_accounts.payouts_paused_until timestamptz(6) NULL` (set with the pause command, cleared with the resume; restore-job partial index `(market_id, payouts_paused_until) WHERE payouts_paused_until IS NOT NULL`); **Mojtaba G2 (2026-10-08; measured on PostgreSQL 16.15, throwaway schema):** CHECK `connected_accounts_pause_check` `payouts_paused_until IS NULL OR cooling_off_until IS NULL OR payouts_paused_until >= cooling_off_until`, so a pause never ends before the cooling-off and a later change that extends the cooling-off must extend the pause in the same unit (measured: pause before cooling-off refused `23514`). A "this wasn't me" report extends it to `detected_at + 14 d` and the admin resolution may bring it back no earlier than `cooling_off_until` (D 4.6 condition 4, Ali (2b)); the 14-day cap is cross-table, so a repository test proves it. A report re-pause and its resume use keys `payout-pause:<reportId>` / `payout-resume:<reportId>`; `provider_commands.kind` gains `payout-pause`, `payout-resume` (keys `payout-pause:<changeId>`, `payout-resume:<changeId>`, 3.5 pattern). Not created under option 1. **Hassan re-check 2(b), 2(c) (slice 4; specified, not measured; my sign-off on the migration):** (a) the restore-job partial index becomes `connected_accounts_market_id_payouts_paused_until_idx (market_id, payouts_paused_until) WHERE payouts_paused_until IS NOT NULL AND status <> 'closed'` (`status` is NOT NULL, so the predicate is never NULL), so a `closed` account is never a restore candidate; the guard trigger refuses clearing `payouts_paused_until` on a `closed` row (`23001`): a closed account keeps its pause. (b) The resume is one guarded statement `UPDATE payments.connected_accounts SET payouts_paused_until = NULL, version = version + 1 WHERE market_id = $m AND id = $a AND status <> 'closed' AND payouts_paused_until = $read` with a non-NULL `$read` (a NULL column never matches); the resume command is sent only when it reports one row. (c) Pause and resume **sends** for one account are serialised by a session-level advisory lock, two-key form `pg_advisory_lock(<payments payout-schedule namespace, an int4 code constant>, hashtext(market_id || ':' || id::text))`, taken on one checked-out connection of the `pg` driver adapter before the guarded statement and released after the recording unit (a crash releases it with the connection); waits are bounded by polling `pg_try_advisory_lock` up to `PAYOUT_SCHEDULE_LOCK_WAIT` (code constant, proposal 10 s), after which the job skips the account to its next run and the webhook handler leaves the event to the inbox retry; a hash collision only over-serialises (safe). The unit that extends `payouts_paused_until` takes no advisory lock (the guarded clear catches it). Through Prisma 7 not measured (spike S1). (d) Re-read re-pause keys `payout-repause:<providerEventId>` and `payout-repause:<connectedAccountId>:<reconcileRunId>` (≤ 88 characters, the key pattern of 3.5), `provider_commands.kind` `payout-pause` (no new kind).
- **HP-2, "this wasn't me":** `payout_account_change_reports` (insert-only, O5): `id uuid` PK (the `reportId`); FK `(market_id, change_id)` → `payout_account_changes`; `seller_id` (FK-proved through the change); `reported_by_account_id`; `reported_at`; unique `(market_id, change_id)` (one report per change; a second answers the stored one). Grants `SELECT, INSERT`. **Mojtaba G2 (2026-10-08; measured on PostgreSQL 16.15, throwaway schema):** (a) the FK as written did not prove `seller_id`; it becomes `(market_id, change_id, seller_id)` → a new unique `payout_account_changes (market_id, id, seller_id)` (measured: another seller's id refused `23503`). (b) Ali (2b) needs a resolution: columns `resolved_by_account_id uuid`, `resolution_code text`, `resolved_at timestamptz(6)`, all NULL; CHECK `payout_account_change_reports_resolution_check` `num_nulls(…) IN (0, 3)`, code `IN ('owner-confirmed', 'account-closed')`, `resolved_at >= reported_at` (measured: partial triple and free text refused `23514`); written once by a guard trigger; grant `UPDATE (resolved_by_account_id, resolution_code, resolved_at)`; partial index `(market_id, reported_at) WHERE resolved_at IS NULL` for the admin queue. The table is no longer insert-only; still never deleted. **Hassan re-check items 1 and 2(a) (slice 4; specified, not measured; my sign-off on the migration):** (c) `channel text NOT NULL`, CHECK `payout_account_change_reports_channel_check (channel IN ('seller-panel', 'support'))`; `reported_by_account_id` is the Seller Owner for `seller-panel` and the admin for `support` (the population is checked by the use case; the database cannot tell accounts apart). The unique `(market_id, change_id)` stays: one report per change whatever the channel; a second entry answers the stored one. (d) `owner_withdrawn_at timestamptz(6) NULL`, `owner_withdrawn_by_account_id uuid NULL`; CHECK `payout_account_change_reports_withdrawal_check`: `num_nulls(owner_withdrawn_at, owner_withdrawn_by_account_id) IN (0, 2) AND (owner_withdrawn_at IS NULL OR owner_withdrawn_at >= reported_at) AND (owner_withdrawn_at IS NULL OR resolved_at IS NULL OR owner_withdrawn_at <= resolved_at)`; CHECK `payout_account_change_reports_owner_confirmed_check`: `resolution_code IS DISTINCT FROM 'owner-confirmed' OR owner_withdrawn_at IS NOT NULL` (NULL-safe: an unresolved row has a NULL code and passes through `IS DISTINCT FROM`; `owner-confirmed` without a withdrawal evaluates to false, never NULL; `reported_at` is NOT NULL). The guard trigger writes both columns once and only while `resolved_at IS NULL` (a resolved row is frozen); grant `UPDATE (owner_withdrawn_at, owner_withdrawn_by_account_id)` added (7). "`account-closed` only on a `closed` account" is cross-table: use case plus repository test. To measure in the slice 4 migration: a bad channel, `owner-confirmed` without a withdrawal, a half withdrawal, a withdrawal before the report or after the resolution each refused `23514`; a second withdrawal refused `23001`. **Hassan HP-1 close-out, item 2(a) (slice 4; specified, not measured; my sign-off on the migration):** (e) a `support`-channel report is never resolved `owner-confirmed` (the attacker may hold the panel, step-up included, so a panel withdrawal proves nothing): CHECK `payout_account_change_reports_support_resolution_check` `channel <> 'support' OR resolution_code IS DISTINCT FROM 'owner-confirmed'` (NULL-safe: `channel` is NOT NULL, an unresolved row passes through `IS DISTINCT FROM`). Such a report ends only by `account-closed` or at the 14-day cap. The use case refuses a panel withdrawal of a `support` report with `payments.payout-account.report-not-withdrawable` before any write (D 4.6 condition 4, 6.2); the database does not also refuse `owner_withdrawn_at` on a `support` row (the use case holds that; a repository test proves it). To measure in the slice 4 migration: `owner-confirmed` on a `support` row refused `23514` (with and without a withdrawal), `account-closed` on it accepted, `owner-confirmed` on a `seller-panel` row with a withdrawal accepted. **Ali CP-R1 condition 5 (payments slice 5):** `instructTransfer` reads unresolved reports of the account (`resolved_at IS NULL`, through the change FK); the table is small and the admin-queue partial index `(market_id, reported_at) WHERE resolved_at IS NULL` serves it; no new index.

The cooling-off duration is the ADR-0026 setting `payments.payout-account-change-cooling-off` (Ali A-5: bounds 24 h to 14 days, store error → the upper bound). It lives in the platform settings store: no table here (PD15).

### 3.8 `payments.transfer_executions` (Y4; D 3.5, 4.7; Ali PC P-a, P-c, P-d; PD6)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; the `transferExecutionId` C-P stores |
| `origin` | `text` | no | CHECK `command`, `tombstone` (P-d: `abandonTransfer` on an unknown key) |
| `instruction_key` | `text` | no | Y3; C-P's payout id. Unique `transfer_executions_market_id_instruction_key_key` |
| `seller_id`, `connected_account_id` | `uuid` | yes | FK `(market_id, connected_account_id, seller_id)` → `connected_accounts (market_id, id, seller_id)`: the account is the seller's (measured: another seller's account refused `23503`) |
| `reference_id` | `uuid` | yes | P-a `reference: payoutId`. **No description or free-text column** (Ali PC) |
| `currency`, `amount_minor` | | yes | Y1 |
| `content_hash` | `text` | yes | Y3 (seller, amount, currency, reference) |
| `provider_code`, `provider_transfer_ref` | `text` | no, yes | `tr_…`, written once |
| `state` | `text` | no | CHECK `reserved`, `sending`, `executed`, `failed`, `refused`, `abandoned` |
| `send_count` | `smallint` | no | CHECK `BETWEEN 0 AND 1` (Ali PC: no self-initiated re-send; measured `23514` at 2) |
| `sending_until`, `attempt_token` | | yes | Y5; the lease of the fence |
| `refusal_code`, `failure_category` | `text` | yes | Code patterns. `refused` covers a provider 4xx after reservation, insufficient platform balance included (Ali PC) |
| `reversed_minor`, `reversal_pending_minor` | `bigint` | no | Counters, Y7 |
| `executed_at`, `created_at`, `state_changed_at` | `timestamptz(6)` | | `executed_at` written once |
| `version` | `integer` | no | |

- CHECK `transfer_executions_shape_check` (O14): a `command` row has all six content columns; a `tombstone` has none of them, is `abandoned` with `send_count = 0` (measured: a command with a tombstoned key refused `23505`).
- CHECK `transfer_executions_reversed_check`: `reversed_minor + reversal_pending_minor <= amount_minor` and non-zero only when `executed` (PD6 "`reversed ≤ transferred`").
- Guard trigger: content immutable; `reserved → sending | abandoned`; `sending → executed | refused | abandoned`; `executed → failed` (Ali PC: `transfer-failed.v1` only after creation; only with `reversed_minor = 0`); final: `failed`, `refused`, `abandoned`; `attempt_token` written once (Y5).
- Deferred constraint trigger `transfer_executions_reversal_counters` (Y7): counters equal the sums of `transfer_reversals` (same function shape as 3.11, not measured separately).
- A refusal **before** reservation (`account-not-ready`, `cooling-off`, `currency-mismatch`, `validation.failed`) writes no row (D 3.5). C-P never reuses a key (its key is a new payout id), so the unique key covers every key that reached the provider.
- **The fence (P-d), as `abandonRefund`:** `abandonTransfer(key)` is one guarded statement per case: no row → insert a tombstone (`skipDuplicates`; a concurrent `instructTransfer` with the same key meets the unique key, whichever commits first wins); `reserved` → `abandoned` (`updateMany where state = 'reserved'`); `sending` inside the lease → `in-flight`, no write; `sending` past the lease → the provider lookup by `transfer_group`/metadata **outside** any unit, then `updateMany where state = 'sending' and attempt_token = $t` to `executed` (found) or `abandoned` (not found). One row, one condition: READ COMMITTED suffices (11.1 Y9). C-P's `transferSendTimeout` > the lease (Ali PC).
- **Quarantine pass and fence breach (Hassan re-check item 5; D 3.5, 4.7; slice 5; specified, not measured; my sign-off on the migration):** `abandonTransfer` on an `abandoned` key repeats the live provider list lookup outside any unit and writes nothing when nothing is found (`still-abandoned`). Found → one guarded statement `UPDATE … SET state = 'executed', provider_transfer_ref = $r, executed_at = $t, fence_breached_at = $now WHERE market_id = $m AND instruction_key = $k AND state = 'abandoned' AND origin = 'command' AND send_count = 1`. New column `fence_breached_at timestamptz(6) NULL`, added to the `UPDATE` grant (7); CHECK `transfer_executions_fence_breach_check`: `fence_breached_at IS NULL OR (origin = 'command' AND send_count = 1 AND state IN ('executed', 'failed'))` (NULL-safe: `origin`, `send_count` and `state` are NOT NULL). The guard trigger gains the one transition `abandoned → executed`, only when the same statement sets `fence_breached_at` (a tombstone or a row never sent stays final). `transferByKey` (P-c) stays a stored-state read (Y8, 6.1) and is never the quarantine check. To measure: a tombstone moved to `executed` refused `23514`; `abandoned → executed` without `fence_breached_at` refused `23001`.

### 3.9 `payments.transfer_reversals` (Y4; D 4.7; Ali PC P-b)

`id uuid` PK; FK `(market_id, transfer_execution_id, currency)` → `transfer_executions (market_id, id, currency)` (unique added there); `reversal_key` (Y3) unique `transfer_reversals_market_id_reversal_key_key`; `amount_minor`, `currency`; `reason_code` (pattern CHECK; C-P's closed list); `content_hash`; `state` CHECK `reserved`, `sending`, `reversed`, `refused`, `failed`; `send_count` CHECK `BETWEEN 0 AND 1`; `sending_until`, `attempt_token`; `provider_reversal_ref` (`trr_`, written once); `failure_category` (`insufficient-account-balance`, D 4.7); `reversed_at`; `created_at`, `state_changed_at`, `version`.
- The reversing unit raises the transfer's `version` and `reversal_pending_minor` first (6.1), so two reversals of one transfer serialise and `transfer_executions_reversed_check` caps them (the refund-cap pattern, measured in 3.11).
- An `unknown` outcome is resolved by key lookup (P-b), never by a re-send.
- **HP-8 (Hassan; slice 5):** `transfer_reversals` gains `seller_id uuid NOT NULL` (P-b now carries `sellerId`), and the FK becomes `(market_id, transfer_execution_id, seller_id, currency)` → a unique `transfer_executions (market_id, id, seller_id, currency)`: a reversal of another seller's transfer cannot be stored (`23503`). **Mojtaba G2 (2026-10-08; measured on PostgreSQL 16.15, throwaway schema):** measured: another seller refused `23503`; a tombstone (`seller_id` NULL) cannot be the target (`23503`); the old FK and its three-column unique key are dropped in the same migration. The use case answers `payments.transfer.seller-mismatch` before reserving; the FK is the second lock. Test with two sellers.

### 3.10 `payments.bank_payouts` (Y4; D 3.6, 4.8; Ali PC P-g "`bankPayoutId`")

`id uuid` PK (the `bankPayoutId`); FK `(market_id, connected_account_id, seller_id)` → `connected_accounts`; `provider_code`, `provider_payout_ref` (`po_`, unique per Market); `amount_minor`, `currency`; `state` CHECK `in-transit`, `paid`, `failed`, `cancelled` (`in-transit` → the other three, final); `arrival_at timestamptz(6)` (the provider's arrival date as an instant; shown in the seller's zone, ADR-0005); `failure_category`; `observed_at`, `state_changed_at`, `version`. Observed only: `payments` never creates a payout (D 4.8). Amount and refs immutable.

### 3.11 `payments.refund_commands` (Y5; D 3.2, 4.4; Ali PC; PD2, PD3)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; our `refundId` |
| `origin` | `text` | no | CHECK `command`, `tombstone`, `external` |
| `key` | `text` | yes | Y3. Unique `refund_commands_market_id_key_key`. NULL only on `external` rows (a dashboard refund has no key of ours) |
| `payment_id` | `uuid` | yes | FK `(market_id, payment_id, currency)` → `payments` (O3). NULL only on tombstones (`abandonRefund` receives only a key, D 3.2 (d)) |
| `kind` | `text` | yes | CHECK `ret06`, `compensation`, `external` |
| `regime` | `text` | yes | CHECK `ret06`, `compensation`; equal to `kind` on `command` rows, NULL otherwise. FK `refund_commands_market_id_payment_id_regime_fkey (market_id, payment_id, regime)` → `payments (market_id, id, refund_regime)`: **a RET-06 refund exists only on a payment whose regime is `ret06`, a compensation refund only on a `compensation` payment** (ADR-0035 d5 mutual exclusion as a database fact; measured: compensation on a `ret06` payment refused `23503`). External rows have `regime` NULL, so the FK does not apply to them (MATCH SIMPLE) |
| `currency`, `amount_minor` | | yes | Y1 |
| `content_hash` | `text` | yes | Y3 (payment, kind, amount, currency, reason) |
| `reason_code` | `text` | yes | Pattern `^[a-z][a-z0-9-]{0,63}$`: ordering's closed list (OD-data O6) or `compensation` |
| `requested_by_kind`, `requested_by_account_id` | `text`, `uuid` | yes | O10. CHECK `refund_commands_actor_check`: on `command` rows, `kind = 'ret06'` if and only if the requester is an account (the admin; RET-06), and `compensation` only by `system` |
| `breached_key` | `text` | yes | On an `external` row recorded for a fence breach (D 3.2 "`ABANDONED` → (none)"): the abandoned key. FK `refund_commands_breached_key_fkey (market_id, breached_key)` → `refund_commands (market_id, key)` |
| `state` | `text` | no | CHECK `reserved`, `sending`, `pending`, `succeeded`, `failed`, `refused`, `abandoned` |
| `send_count`, `sending_until`, `attempt_token` | | | Y5. CHECK `refund_commands_send_once_check`: `kind <> 'ret06' OR send_count <= 1`; CHECK `refund_commands_lease_check` (lease set while `sending`) |
| `provider_code`, `provider_refund_ref` | `text` | no, yes | `re_…`, written once; unique per Market |
| `failure_category` | `text` | yes | Code pattern |
| `settled_at` | `timestamptz(6)` | yes | Set with `succeeded` or `failed`; serves `dailyTotalsOf` (6.2) |
| `created_at`, `state_changed_at`, `version` | | no | |

CHECK `refund_commands_shape_check` (O14), the three row kinds:
- `command`: `num_nonnulls(key, payment_id, kind, regime, currency, amount_minor, content_hash, reason_code, requested_by_kind) = 9`, `kind = regime`, no `breached_key`;
- `tombstone`: key only, `kind = 'ret06'`, `state = 'abandoned'`, `send_count = 0`, every content column NULL;
- `external`: no key, `kind = 'external'`, payment, currency, amount and provider ref present, no requester, state `pending`, `succeeded` or `failed`.

Guard trigger `refund_commands_guard_update` (Y6), measured: content immutable; transitions `reserved → sending | abandoned | pending | succeeded`, `sending → pending | succeeded | failed | refused | abandoned`, `pending → succeeded | failed`; `succeeded`, `failed`, `refused`, `abandoned` final (`abandoned → sending` refused `23001`); a RET-06 `attempt_token` written once (re-send refused `23001`); `send_count` changes in place only for a `compensation` row in `sending` (D 3.2 compensation re-send). No `DELETE` (PD2: "the fence must outlive any retry").

**Hassan HP-4 and HP-16 (slice 6):** CHECK `refund_commands_send_bound_check` `kind <> 'compensation' OR send_count <= 5` (D 3.2 item 6, `MAX_COMPENSATION_SENDS`; reaching it alerts). **Mojtaba G2 (2026-10-08; measured on PostgreSQL 16.15, throwaway schema):** 5 accepted, 6 refused `23514`, a tombstone (`kind` NULL) passes; the Ali (3) drift test reads the literal with `pg_get_constraintdef` on the named constraint (measured: returns 5) and asserts it equals the constant. A fence-breach `external` row refused by `payments_amounts_check` while a replacement RET-06 is still reserved alerts on the **first** `23514` (the handler recognises the constraint name), not after 10 attempts; the event retries and applies once the replacement settles (test: breach → replacement refused by the provider → breach applies).

**The refund cap in the database (PD1, PD3).** The refund unit's first statement is the payment's version raise together with the reservation, one `updateMany`:

```
UPDATE payments.payments
   SET version = version + 1, refund_regime = $regime,
       amount_refund_pending_minor = amount_refund_pending_minor + $amount
 WHERE market_id = $1 AND id = $2 AND version = $expected   -- 1 row, or 0 → conflict.stale
```
then the `refund_commands` insert. The row lock serialises every refund of one payment; `payments_amounts_check` refuses an over-cap total even if the domain's `RefundCap` were bypassed; the regime FK refuses the wrong kind; the deferred constraint triggers `refund_commands_counters` and `payments_refund_counters` (function `payments.check_refund_counters()`) prove at `COMMIT` that `amount_refunded_minor = Σ succeeded` and `amount_refund_pending_minor = Σ reserved, sending, pending` over all the payment's rows (external rows included). Measured (10): a two-session race of 6,000 + 6,000 on 10,000: the second session waited on the row and updated 0 rows (version stale); without the version guard the CHECK refused it `23514`; a counter without its row and a row without its counter both refused at commit.

Each later state change of a refund (`sending → refused`, `pending → succeeded`, `abandoned`) moves the amount between the counters in the same unit, payment row first (6.1).

Indexes: `refund_commands_market_id_payment_id_idx (market_id, payment_id) WHERE payment_id IS NOT NULL` (the deferred trigger's sum, `paymentOf` refund amounts, the admin detail); `refund_commands_market_id_sending_until_idx (market_id, sending_until) WHERE state = 'sending'` (resolve job, PD11); `refund_commands_market_id_settled_at_idx (market_id, settled_at) WHERE state = 'succeeded'` (P-i).

### 3.12 `payments.disputes` (Y6; D 3.3, 4.9; Ali PC P-h)

`id uuid` PK; FK `(market_id, payment_id, currency)` → `payments`; `provider_code`, `provider_dispute_ref` (`dp_`, unique per Market); `amount_minor`, `currency`; `reason_category` CHECK `fraud`, `not-received`, `not-as-described`, `duplicate`, `credit-not-processed`, `unrecognised`, `other` (the adapter maps Stripe's reasons; proposal, 11.1 Y11); `state` CHECK `open`, `won`, `lost`, `closed-inquiry` (forward only, three finals); `funds_withdrawn boolean NOT NULL`, `funds_withdrawn_at`, `funds_reinstated_at` (Ali PC: `disputeOf` states `fundsWithdrawn`; an inquiry withdraws nothing and posts no debit in C-P). CHECK `(funds_withdrawn) = (funds_withdrawn_at IS NOT NULL)`, `funds_reinstated_at IS NULL OR (funds_withdrawn AND state = 'won')`; `evidence_due_by`; `opened_at`, `closed_at` (set with a final state), `version`.
- **No fee column** (Ali PC: the dispute fee only through `fee-charged`, 3.13).
- **HP-5 (Hassan; slice 7):** an inquiry can become a chargeback after opening, so `funds_withdrawn` may move `false → true` once (with `funds_withdrawn_at`, written once) in any non-final state, never back; `funds_reinstated_at` written once. Both columns in the guard trigger's mutable list and the `UPDATE` grant. **Mojtaba G2 (2026-10-08; measured on PostgreSQL 16.15, throwaway schema):** the guard must also let `funds_reinstated_at` be written on a row already final `won` (Stripe reinstates after the close), while every other column of a final row stays fixed. Measured: false → true then back refused `23001`; withdrawal on a final `closed-inquiry` refused `23001`; reinstatement after `won` accepted once, a second write refused `23001`. Each move emits `dispute-funds-withdrawn.v1` / `-reinstated.v1` in the same unit (D 3.3, 7.2).
- Index `disputes_market_id_evidence_due_by_open_idx (market_id, evidence_due_by) WHERE state = 'open'` (admin list "open first", PD10).
- `orderId` in `disputeOf` and the events comes from the payment row (11.1 Y3).

### 3.13 `payments.fee_charges` (Y6; D 4.10; Ali PC P-f)

`id uuid` PK; `kind` CHECK `payment-processing`, `connect-active-account`, `connect-payout`, `dispute`, `other` (payments' names, Ali PC); `amount_minor` (> 0), `tax_minor` (NULL or `BETWEEN 0 AND amount_minor`, when the provider states it, F-1), `currency`; `payment_id` (FK, nullable), `dispute_id` (FK, nullable), `bank_payout_id` (FK, nullable), `seller_id` (nullable, identifier); `provider_code`, `provider_balance_txn_ref` (`txn_`, unique per Market: one fee per balance transaction, PD7, idempotent); `provider_created_at`, `recorded_at`.
- CHECK `fee_charges_shape_check`: `payment-processing` has `payment_id`; `dispute` has `dispute_id`; `connect-payout` has `bank_payout_id` or `seller_id` (F-1 unverified, so not stricter).
- Insert-only (O5). `feeChargesOf` answers `orderId` for payment fees from the payment row (Ali PC P-f).

## 4. What is never stored

| Never in the `payments` schema | Instead |
|---|---|
| Card number, CVC, full expiry, network, cardholder name, billing address | Provider form only; brand and last 4 (3.3) |
| Bank account, BSB, account holder, identity documents, ABN | Stripe-hosted onboarding (VER-10); counts and categories only (3.7) |
| Webhook bodies, provider object snapshots, request or response bodies, headers, IP addresses | Ids and enums (3.6) |
| The client secret, publishable key values, webhook secrets, onboarding links | Never written to a table (D 4.2, 4.6; log-redaction test) |
| Customer or seller names, emails | Ids only (PD13). The BFF composes names from `sellers` and `identity` |
| Amounts in events | Facades (Ali A-3) |
| Commission, ledger, eligibility, schedules | `commission-payouts` (D 2.4) |
| Provider decline codes or messages | `reasonCategory` (D 3.1) |
| Free text of any kind | Reason codes (O6, O8) |
| A stored `ready` flag | Derived from `status` (3.7) |

## 5. Invariants, locking and isolation

### 5.1 Lock order (one rule for every unit)

**`connected_accounts` → `payments` → `transfer_executions` → `refund_commands` / `transfer_reversals` / `provider_commands` → inserts (children, outbox).** Every unit raises the version of each root it changes as its first statement on that root (PRC-data P7; `updateMany` with the expected version → one row or `conflict.stale`).

| Unit (D) | Statements, in order |
|---|---|
| `createPayment` unit 1 | Insert `payments` (`requires-payment`) → insert `provider_commands` (`create-intent`, `reserved`); a key conflict → read and compare (Y4) |
| `createPayment` unit 2 | Payment version + `provider_payment_ref` → command `succeeded` |
| Webhook apply (per object, after the re-read) | Payment version + status, amounts, card display insert, attempt outcome insert, `decline_count` → event rows `applied` → outbox |
| `capturePayment`, `cancelPayment` | Payment version → insert `provider_commands` (the settle key refuses the second of capture/cancel) |
| Refund reserve (RET-06, compensation) | **Payment version + regime + `refund_pending`** → insert `refund_commands` (3.11) |
| Refund send / result / abandon | Payment version + counters → refund state (guarded by `attempt_token`) |
| `instructTransfer` reserve | **Account version** (so a concurrent webhook unit that writes `cooling_off_until` or `status` is serialised with it, and the reserve reads the committed state) → insert `transfer_executions` |
| Reversal reserve | Transfer version + `reversal_pending` → insert `transfer_reversals` |
| Account webhook (status, external account change) | Account version + status / `cooling_off_until` → insert `payout_account_changes` → outbox |

No unit locks in another order, so the module has no deadlock cycle of its own. Provider calls happen only between units (D 10, PE 6.4).

### 5.2 Who holds each cross-row rule (READ COMMITTED, Y8)

| Rule | Holder |
|---|---|
| One payment per order; at most one capture | Unique key (3.2); the capture/cancel settle key (3.5); `payments_full_capture_check` |
| Refund cap; two refunds racing | Payment row lock + `payments_amounts_check` + deferred counter check (3.11, measured) |
| RET-06 never re-sent; key never sent after `abandoned` | `send_count <= 1`, write-once `attempt_token`, `abandoned` final, tombstone on the unique key (3.11, measured) |
| RET-06 and compensation exclusive per payment | Write-once `refund_regime` + regime FK (3.11, measured) |
| Same key, other content | Unique key + immutable content (Y4, measured) |
| One active connected account per seller | Partial unique key (3.7, measured) |
| Cooling-off never shortened | Guard trigger (3.7, measured) |
| No transfer above what was sent; reversals capped | `transfer_executions_reversed_check` + transfer row lock |
| Transfer sent at most once; fenced abandon | `send_count BETWEEN 0 AND 1`, tombstone, `abandoned` final (3.8, measured) |
| One webhook event applied once | Unique provider event id (3.6) |

### 5.3 Invariants the database does not carry

| Invariant | Why not | Enforced by |
|---|---|---|
| Currency = the Market's; amount ≤ `maxPaymentAmount` | Configuration (O13) | `PaymentAmount`, `PaymentsPolicy` |
| No transfer to a not-ready or cooling-off account | `now` is `Clock`'s, not the database's | `instructTransfer` in the reserving unit, after the account lock (5.1) |
| A fingerprint comparison on key reuse | The second request is not a row | Repository (Y4) |
| `decline_count` = attempt rows; `cooling_off_until` = latest change | Small cross-row sums, not caps | Repository tests |
| A re-read older than the stored state changes nothing | Ordering of provider facts | Webhook handler (D 5.4); the triggers keep states forward-only |
| Who may refund, ownership, acting-as | Actor | Application layer (D 6) |

## 6. Access paths

**Assumption** (not measured end to end; first year, one Market): 10² to 10³ paid orders a day; one payment per placed order (up to 10⁶ a year including unpaid); refunds a few per cent of payments; 10² to 10³ connected accounts; one transfer per seller per payout slot (weekly default: up to 5 × 10⁴ a year); 5 to 10 provider events per payment.

### 6.1 Queries and their indexes

| Query (D) | Statement | Index |
|---|---|---|
| `payoutReadiness(≤ 100 sellerIds)` (PD9; sellers ruling M2; deadline 300 ms) | One `findMany` where `marketId`, `sellerId in [...]`, `status not 'closed'`; select `sellerId, status` | `connected_accounts_market_id_seller_id_active_key` (`INCLUDE (status)`). **Measured** at 1.2 × 10⁵ accounts (two Markets, 20 % of sellers also with a closed account): **index-only scan, 1.2 to 1.9 ms, 397 + 219 buffers, planning 0.9 to 1.5 ms**. Unknown or other-Market id → absent → `ready: false` |
| `paymentOf`, `refundByKey`, `transferByKey(≤ 100 keys)`, `feeChargesOf(≤ 100)`, `disputeOf(≤ 100)` | Primary or unique key; `in` lists | PKs and the key uniques. One statement per table per call |
| Webhook handlers: object by provider ref | Unique ref keys | `*_provider_*_ref_key` |
| Admin payments list (PD10), newest first, keyset | `marketId`, optional `status`, order `(created_at desc, id desc)` | `payments_market_id_created_at_id_idx`; with a status filter the planner filters over that range. Not measured; if the slice 8 plans show a slow filtered page, add `(market_id, status, created_at, id)` |
| Admin disputes, open first | `state = 'open'` by `evidence_due_by` | `disputes_market_id_evidence_due_by_open_idx` |
| Admin connected accounts by status | `(market_id, status, id)` | Not added: at most 10³ rows per Market |
| Jobs (PD11): unconfirmed expiry, hold-limit void, reconciliation of open payments | `status = 'requires-payment' AND expires_at <= $t`; `status = 'authorised' AND authorised_at <= $t`; `status in (open)` keyset | One partial index `payments_market_id_status_changed_at_open_idx (market_id, status_changed_at, id) WHERE status IN ('requires-payment', 'authorised', 'capture-requested')`: an equality on `status` implies the predicate, and the open set is small (at most a few hundred rows) |
| Resolve job: `sending` past the lease | `state = 'sending' AND sending_until <= $t` | `*_sending_until_idx` partial on refunds, provider commands, transfers, reversals |
| Webhook claim and grouping | 3.6 | 3.6 |
| `dailyTotalsOf({from, to})` (Ali PC P-i) | Per fact: captured payments by `captured_at`; succeeded refunds by `settled_at`; executed transfers by `executed_at`; reversals by `reversed_at`; fees by `provider_created_at`; disputes by `funds_withdrawn_at`/`funds_reinstated_at`; each `sum` grouped by currency in `[from, to)` | Partial `payments_market_id_captured_at_idx (market_id, captured_at) WHERE captured_at IS NOT NULL` and `refund_commands_market_id_settled_at_idx`. The other tables are small (≤ 10⁵ rows a year); no index until the slice 7 plans show a need |

### 6.2 Deliberately not added

- An index on `customer_account_id`: `view-own-payment` starts from an order id (the customer page), so the order key serves it. CUS-03 erasure needs no handler (PD13).
- An index on `seller_id` of transfers: `transferByKey` reads by key; the seller's payout view reads C-P's tables.
- Indexes on the referencing side of in-schema FKs: parents are never deleted, so RESTRICT checks never run.
- Any index on `inbox` (never written).

## 7. Grants

Under platform.md 10.2: hand-written in the `migration.sql` that creates each table, in the block `-- Grants (database-designer): docs/design/data/payments.md section 7`, to `mondapac_app` only, mirrored by `REVOKE` in `down.sql` before any `DROP`. `GRANT USAGE ON SCHEMA "payments"` in Y1. No sequence. Trigger functions get no grant.

| Table | Privileges of `mondapac_app` | Reason |
|---|---|---|
| `outbox` | `SELECT, INSERT, UPDATE (published_at)` | PM2 |
| `inbox` | `SELECT, INSERT` | Unused (P-6) |
| `payments` | `SELECT, INSERT, UPDATE (provider_payment_ref, payment_method_used, amount_authorised_minor, amount_captured_minor, amount_refunded_minor, amount_refund_pending_minor, status, refund_regime, decline_count, authorisation_expires_at, authorised_at, captured_at, status_changed_at, version)` | PD12: state, counters, written-once refs |
| `provider_commands` | `SELECT, INSERT, UPDATE (state, send_count, sending_until, attempt_token, result_code, state_changed_at)` | PD2 |
| `refund_commands` | `SELECT, INSERT, UPDATE (state, send_count, sending_until, attempt_token, provider_refund_ref, failure_category, settled_at, state_changed_at, version)` | PD2 |
| `connected_accounts` | `SELECT, INSERT, UPDATE (provider_account_ref, status, transfers_active, payouts_enabled, requirements_due_count, requirements_past_due_count, requirement_categories, cooling_off_until, provider_observed_at, closed_at, closed_by_account_id, close_reason_code, status_changed_at, version, external_account_hmac` (HP-1.2)`, payouts_paused_until` (HP-1 option 2 only)`)` | PD4 |
| `transfer_executions` | `SELECT, INSERT, UPDATE (state, send_count, sending_until, attempt_token, provider_transfer_ref, refusal_code, failure_category, reversed_minor, reversal_pending_minor, executed_at, state_changed_at, version)` | PD6 |
| `transfer_reversals` | `SELECT, INSERT, UPDATE (state, send_count, sending_until, attempt_token, provider_reversal_ref, failure_category, reversed_at, state_changed_at, version)` | PD6 |
| `bank_payouts`, `disputes` | `SELECT, INSERT, UPDATE (<state and observation columns>)` (exact lists in the slice PR, equal to the guard trigger's mutable list) | PD7 |
| `provider_events` | `SELECT, INSERT, UPDATE (status, attempts, next_attempt_at, last_error_code, settled_at), DELETE` | **The only `DELETE` of the module's own tables** (prune, PD5, PD12); outbox/inbox prune per Ali's L7 exception (3.1) |
| `payment_card_displays`, `payment_attempt_outcomes`, `payout_account_changes`, `fee_charges` | `SELECT, INSERT` | V4 |

Measured (10): content columns, `amount_minor` of a refund, card display `UPDATE`, `DELETE` and `TRUNCATE` refused `42501` for the application; the owner's `DELETE`, content `UPDATE` and `TRUNCATE … CASCADE` refused `23001` by the triggers.

## 8. Migration plan

### 8.1 Order (one migration PR open at a time, `docs/process/parallel-tracks.md` rule 6; Phase 5 shares the slot with ordering, C-P, tax and shipping: announce on the board)

| # | Slice | Migration | Contains |
|---|---|---|---|
| Y1 | 1 | `payments_core` | `CREATE SCHEMA IF NOT EXISTS "payments"`, `USAGE`; `outbox`, `inbox`, `payments` (every CHECK, the three FK-target uniques, the open-payments index), `payment_card_displays`, `payment_attempt_outcomes`, `provider_commands` (with the settle key); `reject_mutation()` and the guard functions (O16: `SECURITY INVOKER`, pinned `search_path`); grants. `base.prisma` gains `"payments"` (shared file, this PR) |
| Y2 | 2 | `payments_provider_events` | `provider_events` with its three partial indexes, the `livemode` CHECK (if Y8 is accepted) and the `DELETE` grant (the prune job ships in this slice) |
| — | 3 | None | The Saga uses Y1's columns |
| Y3 | 4 | `payments_connected_accounts` | `connected_accounts`, `payout_account_changes`; guard; grants. Needs the identity mini-review (ID-P1) before merge, for the slice, not for the tables |
| Y4 | 5 | `payments_transfers` | `transfer_executions` (with tombstones and the fence states), `transfer_reversals`, `bank_payouts`; counter trigger; grants. Before C-P's slice 5 (Ali PC: no placeholder, ADR-0031 d5) |
| Y5 | 6 | `payments_refunds` | `refund_commands` with tombstones; `payments.check_refund_counters()` and **both** constraint triggers (`refund_commands_counters`, `payments_refund_counters`; the second goes on the existing `payments` table, a metadata-only `CREATE CONSTRAINT TRIGGER`); `payments_market_id_captured_at_idx` and the refund settled index (plain `CREATE INDEX` unless `payments` holds more than about 10⁵ rows in a deployed environment, then `CONCURRENTLY` alone in its file, `SET lock_timeout` first); grants. **ordering's M4 waits for it** (P-7, Hassan O-2) |
| Y6 | 7 | `payments_disputes_fees` | `disputes`, `fee_charges`; grants |

### 8.2 Reversibility and safety

- Every `down.sql` mirrors its up in reverse: `REVOKE`s first, then constraint triggers and triggers, tables children before parents, functions, then (Y1) `REVOKE USAGE ON SCHEMA`; the empty schema stays (ID-data 8.2). No `IF EXISTS` in the down. **Measured:** up → down → up → down → up → down of the prototype tables of 3.2, 3.3, 3.7, 3.8 and 3.11 with their triggers, functions and grants, as the non-superuser owner: nothing left in the schema, no grant left on it.
- Y1 to Y4 and Y6 create new tables. Y5 adds a constraint trigger and indexes to `payments`, which holds rows by then: the trigger is metadata only (it checks new writes; existing rows were written with refunds impossible, counters 0); the index rule above.
- A new CHECK value (a state, a provider, a brand, a ref prefix): drop and re-add `NOT VALID`, then `VALIDATE`, `lock_timeout` first (OD-data 8.2).
- Removing `provider_events_livemode_check` (Y8) and widening `capture_method` are their own migrations with Hassan's review: they are security switches, not schema tidying. **HY1 accepted by Hassan (2026-10-08):** the CHECK ships in Y2; its removal is its own migration with Hassan's sign-off, in the live-mode PR.
- My sign-off per migration: platform.md 8 checklist, the five points of 10.2, the hand-written block equal to this document, the catalog tests changed in the same PR.

### 8.3 Seed data

None. `PaymentsPolicy` values are `config/markets/*.json` (D 2.2; Ali Q-A4: a separate shared-file PR, both fixtures, no core default). The cooling-off setting is ADR-0026 (A-5).

### 8.4 Prisma specifics

- `prisma/schema/payments.prisma`, models named by Y9, `@@schema("payments")`. Types: `BigInt`, `@db.Char(3)`, `@db.Char(4)` (`last4`), `@db.Timestamptz(6)`, `@db.Uuid`, `@db.VarChar(8)`, `@db.SmallInt`, `String[]`, `@db.JsonB` (outbox payload).
- **Prisma declares:** tables, PKs, non-partial uniques and indexes, the composite relations (including the three-column `(market_id, payment_id, regime)` → `(market_id, id, refund_regime)` relation and the self-relation on `(market_id, breached_key)`; not measured through Prisma, spike S1).
- **Hand-written** in marked blocks: every CHECK; the partial uniques and indexes (`*_active_key`, `*_settle_key`, `*_open_idx`, `*_pending_idx`, `*_sending_until_idx`, `*_settled_at_idx`, `*_captured_at_idx`, `*_evidence_due_by_open_idx`, the outbox claim); the guard and reject functions and triggers; the **constraint triggers** of Y7 (Prisma cannot express them; drift ignores triggers, PRC-data 12.1 row 2); the grants.
- Catalog tests (`pnpm test:db`): privilege map with section 7's column lists; partial-index list; every trigger function `SECURITY INVOKER` with `search_path` pinned; the list of constraint triggers (`pg_trigger.tgconstraint <> 0`) equal to a checked-in list; the card/bank vocabulary column scan (3.3); "every outbox has the same columns".
- `$queryRaw` and `$executeRaw*` banned under `modules/payments` (`pnpm boundaries`). No raw statement is needed: every lock is a version `updateMany`, the deferred checks are triggers.

## 9. Volume, retention and jobs

| Table | Rows, year 1 (upper) | Growth control |
|---|---|---|
| `payments` | 10⁶ | Never deleted (financial retention, PD13). Partition by `created_at` reconsidered at 5 × 10⁷ |
| `payment_card_displays`, `payment_attempt_outcomes` | 4 × 10⁵; a few × 10⁵ | Kept with the payment |
| `provider_commands` | 2 to 3 per payment | Kept (PD2) |
| `refund_commands` | Few per cent of payments | Kept (PD2: the fence outlives every retry; retention = financial records period) |
| `provider_events` | 5 × 10⁶ a year; steady state about 4 × 10⁵ | Pruned 30 days after settling (3.6). Autovacuum on the prune; the hottest table of the schema |
| `connected_accounts`, `payout_account_changes` | 10³; a few × 10³ | Kept |
| `transfer_executions`, `transfer_reversals`, `bank_payouts` | 5 × 10⁴ each at most | Kept |
| `disputes`, `fee_charges` | Rare; about 1 per payment + 12 per account + 1 per bank payout | Kept |
| `outbox` | About 4 events per payment | Platform prune (P 6.5) |

**Retention.** Payment, refund, transfer and dispute rows are financial records: never deleted. They hold no personal data beyond two identifiers (`customer_account_id`, `seller_id`), so CUS-03 erasure needs no handler (D 7, PD13); the retention period itself is Ali's A2 / AG-12 question and bounds nothing here.

**Jobs** (D 12, per hosted Market, `market_id` at the top level of every statement): apply provider events (claim index); expire unconfirmed payments and release stale authorisations (open-payments index); resolve uncertain commands (sending indexes; RET-06 and transfers are looked up and fenced, never re-sent); daily reconciliation (open-payments index, keyset by id; inserts missed events with `received_via = 'reconciliation'`); collect Connect fees (insert-only, unique ref); prune provider events (3.6). Each is safe to run twice: unique keys and forward-only guards.

## 10. Evidence

Measured 2026-10-08 on PostgreSQL 16.15 in a throwaway cluster (under the postgres user's home, removed afterwards). Roles as platform.md 10: non-superuser owner `mondapac_migrator`, `NOLOGIN` group `mondapac_app`, login `mondapac_api`, which ran every application-side case. `btree_gist` in schema `extensions`. Prototype tables carried exactly the columns, CHECKs, keys, triggers and grants of 3.2, 3.3, 3.7, 3.8 and 3.11. Every SQLSTATE below was observed.

| Verified | Result | Used in |
|---|---|---|
| Second payment for one (Market, order); the same order in ZZ (JPY, exponent 0) | `23505`; accepted | 3.2 |
| `capture_method = 'automatic'`; partial capture (100 authorised, 50 captured); method `link`; an `re_` value as payment ref | `23514` ×4 | 3.2, Y2 |
| Refund reserve unit (version + regime + pending, then the row) | Committed | 3.11 |
| Over-cap: 3,000 pending + 7,001 on 10,000 | `23514` `payments_amounts_check` | 3.2, 3.11 |
| Counter raised without a refund row; a refund row without the counter | Both refused **at COMMIT** (`23514`, deferred trigger) | Y7 |
| Same key `rr-1` with 5,000 instead of 3,000 | `23505`; the unit's counter raise rolled back | Y4 |
| `UPDATE amount_minor` of a stored command; `DELETE`, `TRUNCATE` as the application | `42501` ×3 | 7 |
| Compensation refund on a `ret06` payment; regime `ret06` → `compensation` | `23503` (regime FK); `23001` | 3.11 |
| RET-06: first send; new `attempt_token`; `send_count` 2 | ok; `23001`; `23001` | Y5 |
| Abandon after the lease (pending released in the unit), then `abandoned` → `sending` | ok; `23001` | 3.11 |
| Tombstone for an unknown key, then a RET-06 refund with that key | ok; `23505` | 3.11 |
| Fence breach: `external` row naming the abandoned key, refunded counter raised | Committed; counters consistent | 3.11 |
| Two-session race, 6,000 + 6,000 on 10,000, both with expected version 1 | A committed; B waited, then `UPDATE 0` (stale); pending 6,000, version 2 | 5.1, 5.2 |
| The same race without the version guard (a bug) | `23514` | 5.2 |
| Owner: `DELETE` of a refund, content `UPDATE` of a payment, `TRUNCATE … CASCADE` | `23001` ×3 | Y6 |
| Second active account for a seller; cooling-off shortened; closed → enabled; a new account after closing; ZZ account for the same seller | `23505`; `23001`; `23001`; ok; ok | 3.7 |
| `payoutReadiness` for 100 ids at 1.2 × 10⁵ accounts | Index-only scan, 1.2 to 1.9 ms | 6.1 |
| Card `last4 = '42a2'`; card display `UPDATE` | `23514`; `42501` | 3.3 |
| Transfer: command with a tombstoned key; another seller's account; `send_count` 2 | `23505`; `23503`; `23514` | 3.8 |
| Up → down → up (three times) as the non-superuser owner | Clean; nothing left; no schema grant left | 8.2 |
| A default name above 63 bytes | Truncated with a notice (named explicitly, Y9) | Y9 |

**Not measured:** PostgreSQL 17 (Compose, CI); anything through Prisma (spike S1: the three-column regime relation, the self-relation, `createMany({ skipDuplicates })` for tombstones and provider events); `provider_commands`, `provider_events`, `transfer_reversals`, `bank_payouts`, `disputes`, `fee_charges` (specified, not prototyped); the reversal counter trigger (same function shape as the refund one); the prune at volume; the admin list with a status filter; the jobs end to end; the market guard.

**Tests the slices must carry** (`pnpm test:db`, application role, AU and ZZ): every row above as a constraint test; the privilege map; the partial-index and constraint-trigger lists; the trigger-function settings; the card/bank column scan; the concurrency tests of D 10 (two refunds racing the cap, capture vs cancel, `abandonRefund` vs a late provider success, duplicate and out-of-order webhooks, two transfers with one key and different amounts, `abandonTransfer` vs `instructTransfer` on one key); up → down → up per migration.

## 11. Findings and open points

### 11.1 Findings for Mohammad (domain text; no business rule changes)

Mohammad, 2026-10-08: **Y1, Y4 and Y9 accepted** and applied in D (see D's reconciliation log); the others stand as written here and in D's references to them.

| # | Point | Recommendation |
|---|---|---|
| Y1 | **Card display: brand and last 4 only.** D 4.5 and PD8 also store expiry month/year, network and wallet | Store `brand` and `last4` (3.3) and the method used on the payment (`payment_method_used`). No use case reads expiry or network (no saved cards); data we never read is data we can leak. D 4.5 and PD8 to say so; Hassan confirms |
| Y2 | `ProviderCommand` also covering transfer and reversal keys (D 2.1, 10) | Their keys, fingerprints and leases live on `transfer_executions` and `transfer_reversals` (one row per key there). `provider_commands` covers payment-intent writes and account creation. One table per key space, no duplicate row |
| Y3 | `Dispute.orderId` (D 2.1) and `orderId` on refunds | Not copied: read from the payment row (same schema). Events and facades still carry `orderId` |
| Y4 | D 3.1 row "authorised ≠ requested → still `AUTHORISED`" | An authorised amount **above** the request cannot be stored (PD1 CHECK). The handler marks the event `dead`, alerts and voids. Below the request: stored, as D says |
| Y5 | Tombstone shape (D 3.2 (d)) | A tombstone holds only the key (`abandonRefund` receives no payment id). Fine as is; if Mohammad prefers the payment id on the tombstone, P-7 would need `{key, paymentId}` (an ordering contract change; not needed) |
| Y6 | PD3 "`refund_pending` and `refunded` change only in units that also change a refund row" | Enforced: deferred constraint triggers re-sum at commit (Y7, measured). Same for transfer reversals |
| Y7 | "Nobody re-sends a RET-06 refund"; "no self-initiated transfer re-send" (Ali PC) | Also database facts: `send_count <= 1` and a write-once `attempt_token` (measured) |
| Y8 | Test mode only (D 4.11) | Proposal: `provider_events_livemode_check (livemode = false)` as a second lock beside `LIVE_MODE_ALLOWED`; removing it is a reviewed migration at the live-mode switch. Hassan decides |
| Y9 | D 3.2 (`abandonRefund`) asks for one `serializable` unit | Not needed: each case is one guarded single-row statement (`state` and `attempt_token` in the `WHERE`), and the "no row" case is a tombstone insert on the unique key. READ COMMITTED; D 10 to say so. Same for `abandonTransfer` (3.8) |
| Y10 | Capture and cancel exclusion (D 10) | A partial unique key per payment over capture and cancel kinds (3.5) |
| Y11 | Dispute reason categories (D 3.3) | Proposed closed list in 3.12; Mohammad confirms the names |
| Y12 | `cooling_off_until` (D 4.6) | Only extended, never shortened, by trigger (measured). A shorter setting applies to later changes only |

### 11.2 Answers to D 8 (PD1 to PD16)

| PD | Answer |
|---|---|
| PD1 | Unique per (Market, order) and per provider ref; amount CHECKs; regime write-once; status guard (3.2). Measured |
| PD2 | Unique keys, pattern, fingerprint, immutable content, state-only grants, never deleted (Y3, 3.5, 3.11). Measured |
| PD3 | Payment row lock first; deferred counter proof (3.11, 5.1). Measured |
| PD4 | Partial unique; append-only changes; `cooling_off_until` monotonic (3.7). Measured |
| PD5 | Unique event id; claim and grouping indexes; no body; prune ≥ 30 days (3.6) |
| PD6 | Unique instruction and reversal keys; reversed cap (3.8, 3.9) |
| PD7 | Unique provider refs on bank payouts, disputes, fees; fees insert-only (3.10, 3.12, 3.13) |
| PD8 | Brand and last 4 only (Y1) |
| PD9 | One statement, index-only, 1.2 to 1.9 ms (6.1) |
| PD10 | Admin lists (6.1) |
| PD11 | Job indexes (6.1) |
| PD12 | Grants (7); `DELETE` only on `provider_events`, plus the platform outbox/inbox prune (Ali L7 exception, 3.1) |
| PD13 | Two identifiers only; no erasure handler (9) |
| PD14 | Platform audit writer; `originating_actor_*` columns as platform data note 2026-10-08 C1, nothing in this schema |
| PD15 | ADR-0026 store (Ali A-5); no table |
| PD16 | Per-kind ref CHECKs, with `trr_` and `evt_` added (Y2) |

### 11.3 For Hassan

| # | Question |
|---|---|
| HY1 | Y8: the `livemode = false` CHECK as a second lock until the pen test |
| HY2 | Deferred triggers raise at `COMMIT`; their message names the payment or transfer id (ids only, no amounts beyond the row's own). Acceptable in logs? Also: a CHECK violation's `DETAIL` prints the whole row (ids and amounts, no personal data in this schema) |
| HY3 | The lease and fence as data (3.8, 3.11; H-P2), and the residual window in 5.1: the account lock serialises `instructTransfer` with a cooling-off write from a webhook, but a bank change at Stripe that our webhook has not delivered yet is invisible to the reserve (H-P3) |

**Hassan's answers (Hassan payments and commission-payouts review 2026-10-08, 2026-10-08):** HY1 **accepted** (8.2). HY2 **accepted with conditions**: ids and the row's own amounts in **server** logs only; the application maps every `23xxx` to a generic code (`conflict.retry` / 500 with a correlation id) and never returns `message`/`DETAIL`; the Prisma error logger drops `meta`/`DETAIL`; deployed PostgreSQL uses `log_error_verbosity = terse` and does not log statement parameters (`customer_account_id`, `seller_id` are pseudonymous identifiers) (D 6.5; slice 1 onward; Kazem for the deployed setting). HY3 **re-raised as HP-1** (pre-transfer live check: 3.7 conditions, D 4.6). Data parts of HP-3, HP-1, HP-2 (3.7), HP-8 (3.9), HP-4 and HP-16 (3.11), HP-5 (3.12).

### 11.4 Still open

| # | Point | Who |
|---|---|---|
| S1 | Prisma 7: the three-column regime relation, the self-relation on `breached_key`, `skipDuplicates` counts on tombstones and events, drift with constraint triggers | Hossein, with me, slice 1 and slice 6 PRs |
| F-1 | Whether Connect fees and their GST arrive as balance transactions (`fee_charges.tax_minor`, the shape CHECK) | Slice 7 test-mode check |
| K1 | Pool sizing for the worker's jobs; `lock_timeout` 3 s on the units of 5.1 | Kazem |

## 12. Follow-up changes

This document changes no other file. After G2:

| File | Change | When |
|---|---|---|
| `docs/design/data/payments.md` | This document with the review answers | At G2; Mojtaba |
| `docs/design/domain/payments.md` | Y1 to Y12 if accepted (D 2.1, 3.1, 3.2, 4.5, 8, 10) | Mohammad's next revision |
| `prisma/schema/base.prisma`, `payments.prisma`; Y1 to Y6 with `down.sql` | As specified; each needs my sign-off | Per slice; Hossein |
| `pnpm test:db` catalog tests | Section 7 lists, partial-index and constraint-trigger lists, trigger-function settings, card/bank column scan | With each migration |

## 13. Review record

| Date | Reviewer | Outcome | Applied |
|---|---|---|---|
| 2026-10-08 | Ali (cto), Ali payments and commission-payouts review 2026-10-08 | Facade contract P-a to P-i and A-1 to A-6 ruled | Transfer fence and tombstones (3.8), `transferByKey`, `bank_payouts` (`bankPayoutId`), `funds_withdrawn` and no dispute fee column (3.12), fee kinds (3.13), `dailyTotalsOf` paths (6.1), no `connected-account-status-changed` (3.1), cooling-off setting (3.7) |
| 2026-10-08 | Mojtaba (database-designer) | **G2 sign-off, 2026-10-08: design approved; measurements in slice migrations Y3-Y6** (constraints so far measured on PostgreSQL 16.15, 10) | Whole document. Re-review of Mohammad's data conditions (3.7 `replaced`, HMAC, payout pause, reports; 3.9 `seller_id`; 3.11 `send_count`; 3.12 `funds_withdrawn`): fixed and measured on PostgreSQL 16.15 (each marked "Mojtaba G2"): opening-change unique key and `replaced` seq CHECK; key-versioned HMAC; pause ≥ cooling-off CHECK; reports FK through `seller_id` and the resolution columns for Ali (2b); reinstatement on a final `won` row |
| 2026-10-08 | Mohammad (software-architect), reconciliation (`docs/design/domain/payments.md` log) | Y1 (brand + last 4 only; method on the payment), Y4 (authorised above the request not storable: event `dead`, alert, void) and Y9 (READ COMMITTED fences, no `serializable`) **accepted** and written into D 2.1, 3.1, 3.2, 4.5, 4.7, PD8, 10. Ali L7: outbox/inbox prune is the only `DELETE` on those tables (3.1, 7). Open for D: the Y4 void's key name and `provider_commands.kind` value (slice 3, with Mojtaba) | D and 3.1, 7 here |
| 2026-10-08 | Hassan (security-tester; mandatory), Hassan payments and commission-payouts review 2026-10-08 | Approved with conditions; HY1, HY2 accepted (HY2 with conditions); HY3 → HP-1 | Data conditions written in by Mohammad with this file (3.7, 3.9, 3.11, 3.12, 8.2, 11.3); not measured yet: Mojtaba measures and signs off in the slice 4, 5, 6, 7 migrations |
| 2026-10-08 | Hassan re-check (Hassan re-check 2026-10-08) | Approved with conditions; HP-1 open until the text is re-checked; HP-4 text blocks slice 5 | Mohammad with Mojtaba (specified NULL-safe, not measured; measured in the slice 4 and 5 migrations): 3.7 report `channel`, `owner_withdrawn_*` and their CHECKs (items 1, 2(a)); restore index excludes `closed`, no clear on a closed row, guarded clear, advisory lock, re-pause keys (2(b), 2(c)); HMAC re-stamp rules (item 6); 3.8 `fence_breached_at` and the `abandoned → executed` breach transition (item 5) |
