# Physical data model — `tax` schema (G2)

**Author:** Mojtaba (database-designer) — 2026-10-08
**Status:** **G2 data design approved with conditions 2026-10-08 (Ali, Hassan).** Revised the same day with every `tax` item (B1 to B7) of Mojtaba change list 2026-10-08, consistent with the final `docs/design/domain/tax.md` (G2 approved with conditions), Hassan's review (Hassan review 2026-10-08, H1 to H7) and Ali's rulings (Ali G2 review 2026-10-08 sections 6 and 7: D-1, T8, M3). Conditions: Hassan checks H5 (the purge, 3.2 and 9) at code time; spike S1 in slice 6's PR; each migration still needs my sign-off. Platform items (C1 to C3) are in platform data note 2026-10-08, not here. Open points: 12.2. Review record: 13.
**Ground truth:** `docs/design/domain/tax.md` (Mohammad, G2 draft 2026-10-08; cited as **D**, for example "D 4.10"; its inputs PD1 to PD8 in D 7); `docs/modules/tax/brief.md` (G1 approved by the owner 2026-10-08; "brief s6", "AC 16"); Ali G2 review 2026-10-08 (Ali's G2 review of D and of the ordering domain design, 2026-10-08; T3 ruled option D, T7 settled); `docs/design/domain/ordering.md` (cited **OD**; only for the inputs of section 10); `docs/design/data/platform.md` section 10 (roles and grants, "platform.md 10") and 10.9 (partial indexes and prepared statements); `docs/design/data/identity.md` (conventions C1 to C11, "ID-data"); `docs/design/data/pricing.md` (structure and conventions P1 to P10, "PRC-data"); `docs/design/data/sellers.md` 3.7 and 10 (tax registration periods, purge); ADR-0003 (decision 3), ADR-0004 (decisions 3 to 7), ADR-0006, ADR-0007 (decisions 1, 2, 8), ADR-0009 (V3, V4), ADR-0025 (decision 1).
**Prisma models:** `prisma/schema/tax.prisma`, created only by slice 6 (8.1). Nothing exists yet. This document is the specification the slice 6 migration is written from, plus the inputs that `ordering` and `commission-payouts` take into their own data designs (section 10).
**Business rules:** none changed. Where the mapping needed a value or a reading that neither the brief nor D gives, it is an open point in 12.2, and the text shows my proposal.

## 1. Scope and table list

`tax` is a calculator with configuration (D 2.1). Its rules are effective-dated code in `config/markets/<code>.json` (D 4.1; Ali's ruling A6; ADR-0003 decision 5, ADR-0007 decision 9), not rows. Its answers are frozen by the callers: `ordering` on its snapshot and documents (PD7), `commission-payouts` in its ledger (PD8). So the `tax` schema is small and late.

**PD1 confirmed: no `tax` schema, no Prisma model and no migration before slice 6.** Slices 1 to 5 are code and configuration only. Consequences:
- `prisma/schema/base.prisma` gains `"tax"` in `schemas` only in slice 6's PR (a shared file; announce on the board).
- Until slice 6, `modules/tax` has no `infrastructure/persistence` folder and imports no Prisma client or model. A `pnpm boundaries` fixture states it, so a later slice cannot add a table without this design (Hossein).
- Slices 1 to 5 open no unit of work. The facade calls are pure plus one `sellers` read (ST1, ST2), advisory in the ADR-0025 sense; no transaction is opened for them (ADR-0025 decision 1).

From slice 6 (P1, after launch):

| Table | Holds (D 2.1, D 7) | ADR-0009 pattern | Created in (brief s11 slice) |
|---|---|---|---|
| `tax.outbox` | `tax.registration-threshold-approached.v1` (D 6.3) | None: a queue | 6 |
| `tax.inbox` | Handled deliveries of `sellers.tax-registration-recorded.v1` (D 6.4) | None | 6 |
| `tax.threshold_alerts` | `ThresholdAlert` (D 2.1, 3.2) | V4 append-only, plus two write-once clear columns; a cleared row is deleted by the retention purge only (Hassan H5; 3.2, 9) | 6 |

No sales table (PD2; Ali ruled T3 option D, Ali G2 review 2026-10-08 section 2). If that ruling is ever reversed to option A, 3.3 gives the table. Every table carries `market_id` and `tenant_id`, so the persistence guard needs no exemption line. `platform.audit_log` is unchanged.

### 1.1 ER sketch

```
tax.threshold_alerts            (market_id, seller_id) unique WHERE cleared_at IS NULL   -- at most one open alert
  id, seller_id (plain id, no FK; owned by sellers)
  opened_at, window_from, window_to, seller_zone
  tax_rule_set_id, currency, trailing_total_minor, threshold_minor, warning_ratio
  cleared_at, clear_cause       (write-once pair; a cleared row is purged after AG-12, 9)

tax.outbox, tax.inbox           no FK

(no table)  rule sets, category treatments, document policy   -> config/markets/<code>.json, section "tax"
(no table)  frozen tax answers                                 -> ordering (PD7), commission-payouts (PD8)
(no table)  seller turnover                                    -> ordering implements SellerTurnoverSource (PD3)
```

## 2. Conventions used by every table

ID-data C1 to C10 apply unchanged: `market_id varchar(8)` and `tenant_id text` with their pattern CHECKs and no default; `uuid` ids from the application (UUIDv7); `timestamptz(6)` from `Clock`; no column default, sequence or enum; foreign keys only inside the schema (there is none here); indexes lead with `market_id`; no raw SQL. PRC-data P1 (Money), P5 (write-once columns), P6 (no `DELETE`, no `TRUNCATE`) apply as written, with one exception: a **cleared** threshold alert may be deleted, by the retention purge only (Hassan H5; 3.2, 9). Every trigger function is `SECURITY INVOKER` with `SET search_path = pg_catalog, pg_temp` and schema-qualified names (ordering-data O16). What `tax` adds:

| # | Convention |
|---|---|
| X1 | **Money** as PRC-data P1: `<name>_minor bigint` + `currency char(3)` with CHECK `^[A-Z]{3}$`, amounts in the currency's own ISO 4217 exponent (AUD 2, JPY 0 for the `ZZ` fixture), CHECK `> 0 AND <= 9007199254740991`. One currency column per row: every amount of a row is in it. That it equals the Market's currency is checked by the domain (D 4.1, 10), not by a constraint (configuration) |
| X2 | **Rates and ratios** (ADR-0007 decision 2): `numeric` with CHECK `> 0` (or `>= 0` for a tax rate) `AND <= 1 AND scale(<col>) <= 6`. Unconstrained `numeric` keeps the configured digits (`'0.10'` stays `0.10`, measured) and the CHECK **refuses** a seventh decimal, where `numeric(7,6)` would round it silently. Equality is numeric (`0.10 = 0.1` is true, measured), so the domain compares rates as numbers and never as strings (12.2 M1). Fallback if spike S1 shows Prisma cannot declare an unconstrained `numeric`: `numeric(7,6)`, with the domain's boot validation as the only refusal of a seventh decimal |
| X3 | **Codes that come from configuration** (rule set id, strategy code, category code) are `text` with a pattern CHECK, never a closed list, because a new Market adds values without a migration: rule set id `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; strategy code `^[a-z][a-z0-9-]{0,63}$`; category code the catalog CA4 pattern `^[a-z][a-z0-9_-]{0,63}$`. **Closed** domain lists (clear cause; in section 10 the treatment and the document kind) are `text` + `IN (…)` CHECK |
| X4 | **Zones** are IANA ids, CHECK as sellers' `operating_timezone`: `^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$` and length ≤ 64. Never an offset (ADR-0005) |
| X5 | **Prisma model names** start with `Tax` (`TaxOutbox`, `TaxInbox`, `TaxThresholdAlert`), tables mapped with `@@map` (ID-data C9) |
| X6 | **Isolation.** READ COMMITTED everywhere. No `tax` unit needs `serializable`: the one race (two openings for one seller) is closed by the partial unique key (3.2), not by isolation |

## 3. Tables

The columns of C1 are omitted. Names of constraints and indexes are the exact database names.

### 3.1 `tax.outbox` and `tax.inbox` (slice 6)

The two tables of ID-data 3.1 and 3.8, under this schema, with these changes only:
- `outbox_type_check`: `^tax\.[a-z0-9-]+\.v[1-9][0-9]*$`. `aggregate_type` is `threshold-alert`.
- `aggregate_version` is always 1: an alert publishes one event, on opening, and has no `version` column (3.2). If a later event on clearing is added, it uses version 2 (an alert is cleared once), and the outbox unique key still holds.
- `inbox_handler_check`: `^tax\.[a-z0-9-]+$`. One handler: `tax.clear-alert-on-registration` (D 6.4).
- Unique `outbox_market_id_aggregate_id_aggregate_version_key`; partial `outbox_market_id_event_id_unpublished_idx`; `inbox_pkey (event_id, handler)`. No inbox index until the platform prune job (ID-data 3.8).
- `payload` holds `sellerId`, `alertId`, `crossedAt` only (D 6.3): no amount, no actor. The database cannot check that; the contracts snapshot test (D 13.4) does.

### 3.2 `tax.threshold_alerts` (slice 6; D 2.1, 3.2, PD4)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK `threshold_alerts_pkey`. The `alertId` of the event |
| `seller_id` | `uuid` | no | `sellers`' seller id. Plain id, no FK (C4: owned elsewhere). Business data; see 9 for the sole-trader case |
| `opened_at` | `timestamptz(6)` | no | The evaluation instant at which the crossing was found (D's "crossing instant"; the event's `crossedAt`) |
| `window_from`, `window_to` | `timestamptz(6)` | no | The trailing window the total was read over, `[from, to)`, as instants: 365 local days ending at the seller's local today (D 4.10; AG-10 may change the length, so no CHECK on the length). Kept so that the figure can be explained and re-read from `ordering` later. CHECK `window_from < window_to` |
| `seller_zone` | `text` | no | The approved zone the window's local days were computed in (ST2). X4 |
| `tax_rule_set_id` | `text` | no | The rule set that gave the threshold and the ratio (X3). The answer is reproducible from it (D 13 pin test) |
| `currency` | `char(3)` | no | X1; the Market's currency at opening |
| `trailing_total_minor` | `bigint` | no | Net platform supplies over the window at opening (X1). **Personal information for a sole trader (Hassan H5, accepted, D 3.2)**: kept only until the retention purge (9); never copied into an audit `after` value (D 8) or a log line |
| `threshold_minor` | `bigint` | no | The registration threshold of the rule set at opening (AU 7,500,000 cents) (X1) |
| `warning_ratio` | `numeric` | no | X2, CHECK `> 0 AND <= 1 AND scale <= 6` |
| `cleared_at` | `timestamptz(6)` | yes | NULL = open. Written once (PRC-data P5). Starts the retention period (9) |
| `clear_cause` | `text` | yes | CHECK `IN ('below-ratio', 'seller-registered')` (D 3.2: the two triggers of `OPEN → CLEARED`). `below-ratio` means below the rule set's **clear ratio** (D 4.10), which equals the warning ratio by default |

**Clear ratio (todo B5; Ali M3: Hadi's call, default no hysteresis).** No column by default. The clear ratio is a rule-set value (D 4.1, 4.10) and the row keeps `tax_rule_set_id`, so the value that applied is reproducible from the pin test. Only if Hadi adopts a clear ratio below the warning ratio **and** a reader needs it from the row (for example the seller view "clears below X"), slice 6's migration adds `clear_ratio numeric NOT NULL` with CHECK `threshold_alerts_clear_ratio_check` `clear_ratio > 0 AND clear_ratio <= warning_ratio AND scale(clear_ratio) <= 6` (X2; table empty at creation, so `NOT NULL` costs nothing), and the column joins the guard's immutable list. A later addition on a live table is a nullable column plus `NOT VALID` CHECK (8.3).

**State.** D's `OPEN` / `CLEARED` is not a column: open is `cleared_at IS NULL`. One fact, one place: a `state` column next to `cleared_at` would need a CHECK to keep them equal and a column grant for both. The repository maps the two states. Prisma sends `IS NULL` as SQL text, not as a bind parameter, so the partial index below is used even under a generic plan (measured; platform.md 10.9 applies anyway).

**Constraints (each backs a rule of D):**

| Constraint | Rule it backs |
|---|---|
| Unique `threshold_alerts_market_id_seller_id_open_key` `(market_id, seller_id) WHERE cleared_at IS NULL` | At most one open alert per seller (D 2.1, PD4). Two concurrent job runs: the second insert gets `23505` (Prisma `P2002`), which the job treats as "already open" (D 9; measured). The same seller id in another Market is a separate key (measured) |
| `threshold_alerts_crossed_check` `trailing_total_minor >= threshold_minor * warning_ratio` | An alert is opened only at a crossing (D 3.2 guard). Exact: `bigint * numeric` is `numeric`, no rounding (measured: 5,999,999 against 7,500,000 × 0.80 refused) |
| `threshold_alerts_amounts_check` | X1 bounds on both amounts |
| `threshold_alerts_warning_ratio_check` | X2 |
| `threshold_alerts_window_check` | Non-empty window |
| `threshold_alerts_cleared_check` `(cleared_at IS NULL) = (clear_cause IS NULL) AND (cleared_at IS NULL OR cleared_at >= opened_at)` | A clear has its cause; no clear before the opening |
| `threshold_alerts_clear_cause_check`, `_currency_check`, `_seller_zone_check`, `_tax_rule_set_id_check`, `_market_id_check`, `_tenant_id_check` | X1, X3, X4, C1 |
| Trigger `threshold_alerts_guard_update` (`BEFORE UPDATE`) | Content columns never change; a cleared alert is final (`cleared_at` and `clear_cause` written once). `23001`, for the owner role too (measured) |
| Trigger `threshold_alerts_guard_delete` (`BEFORE DELETE`, row) | **An open alert is never deleted** (`23001`, every role, the owner included; measured). A cleared row may be deleted: that is the retention purge (Hassan H5, D PD6; 9), which overrides PD5's "no `DELETE`" for cleared rows only. Same migration as the table (slice 6), not a later one |
| Trigger `threshold_alerts_guard_truncate` (`BEFORE TRUNCATE`, statement) | `TRUNCATE` is refused for every role (`23001`; measured): it would remove open alerts and skip the row trigger |

- "A new alert only after the total fell below the ratio and crossed again" (D 2.1) is the partial unique key plus the job: the job clears with `below-ratio` when the total falls below the ratio, and only then can a new row be inserted. The database does not know the total between runs (5).
- **Clearing statement** (job and handler): Prisma `updateMany` where `{ marketId, id, clearedAt: null }`, data `{ clearedAt: now, clearCause }`. One row changed or none; none means another run or the handler cleared it first. No version column: the row is changed only by this single guarded statement (ID-data C5).
- **No `version`**, no `(market_id, id)` unique: the table has no children and no load-change-save cycle.
- **Why the narrow `DELETE` is a grant plus a trigger, not a `SECURITY DEFINER` function** (D PD6 offered either): a definer function would be the first in the database owned by the migrator and callable by the application, a new pattern for platform.md 10.2 review; the trigger already refuses every delete that is not of a cleared row, for every role, so the table-level `DELETE` grant can only remove what the purge may remove. The cost: the application could delete a cleared alert before the retention period ends; the purge statement's `cleared_at < cutoff` predicate and the code review (Hassan H5 at code time) cover that, and the alert decides nothing (D 3.2).

### 3.3 Conditional: `tax.seller_supplies` (only if T3 option A replaced option D; PD2)

Ali ruled option D; this table is **not** created. It is given so that a reversal has a ready design. One insert-only row per supply id:
`supply_id uuid` (the command's id, idempotency), `seller_id uuid`, `kind text IN ('invoice', 'refund')`, `net_minor bigint` signed (CHECK `kind = 'invoice' AND net_minor >= 0 OR kind = 'refund' AND net_minor <= 0`, bound ±2^53−1), `currency char(3)`, `occurred_at timestamptz(6)`, `seller_local_date date`, `seller_zone text`; PK `seller_supplies_pkey (market_id, supply_id)` (the "unique per (Market, supply id)" of PD2, so a repeated command is a `skipDuplicates` no-op); index `(market_id, seller_id, occurred_at) INCLUDE (net_minor)` (the shape measured in 10.1.3); grants `SELECT, INSERT`; triggers refusing every `DELETE` and `TRUNCATE` (the pre-H5 form of 3.2; a purge, if the rows are personal information, would need its own design); a backfill from `ordering` before the first evaluation. Cost: a second copy of sales data that can disagree with `ordering`, which is why D recommended against it.

## 4. What is never stored

| Never in the `tax` schema | Instead |
|---|---|
| Rule sets, rates, category treatments, thresholds, clear ratio, document policy | `config/markets/<code>.json`, section `tax`, validated at boot (D 4.1, 4.7); pinned by the rule-set hash test (D 13.4) |
| Rule-set digests or the golden list (Hassan H3) | A checked-in file under CODEOWNERS (D 3.1, 13.4), compared at boot and in CI. **No table and no column in `tax` stores a digest** (todo B7, confirmed: the only rule-set reference stored anywhere in `tax` is `threshold_alerts.tax_rule_set_id`, an id) |
| A trailing total in an audit row, an event or a log line | Only in `threshold_alerts.trailing_total_minor` until the purge (Hassan H5; D 6.3, 8) |
| A tax answer: line tax, document decision, refund reversal, commission tax | Frozen by the caller (PD7 `ordering`, PD8 `commission-payouts`; ADR-0007 decision 8). Storing it here would be a second copy that can disagree |
| Sales, invoices, refunds or a running tally | `ordering` answers `SellerTurnoverSource` from its own documents (T3 option D, PD3) |
| A tax number (ABN), a legal name, an address, a buyer's identity | `sellers.taxProfileOf` (system) and the invoice identity read for `ordering` (D 2.3; Ali's review item 2). `tax` never receives a number (ST1, H4) |
| The seller's registration status | `sellers.tax_registration_periods` (sellers 3.7); `tax` reads it per call (ST1) |
| The platform's registration (`legalEntity`) | `MarketConfig.legalEntity` (D 4.9; PL1) |
| An amount or an actor in an event payload | Ids and instants only (D 6.3) |
| Customer data of any kind | None reaches `tax` (brief s9 privacy) |

## 5. Invariants the database does not carry

| Invariant | Why not a constraint | Enforced by |
|---|---|---|
| The currency equals the Market's | Configuration | Job and `Money` guard (D 4.3, 10) |
| The seller is not registered when an alert opens; an open alert is cleared when the seller registers | Cross-module (`sellers`) | Job (D 11) with ST1; the `sellers.tax-registration-recorded.v1` handler (D 6.4) |
| The trailing total is the true net of `ordering`'s documents over the window | Cross-module | `SellerTurnoverSource` (PD3), read by the job |
| "Cleared below the ratio before a new crossing" | Needs the total between runs | Job (D 3.2); the partial unique key backs "at most one open" |
| The window is 365 local days in the seller's approved zone | Needs the zone database | Job (D 4.10); the row keeps the zone and both instants so the window can be checked later |
| The threshold and ratio equal the rule set named | Configuration | Job; reproducible from `tax_rule_set_id` and the pin test |
| A cleared alert is deleted only after the AG-12 period | The period is configuration and may count from the financial year end | Purge job predicate `cleared_at < cutoff` (9); the trigger guarantees only "never an open alert" |

**Known benign race.** The registration handler and the job can interleave: the job reads "not registered", the seller registers, the handler finds no open alert and does nothing, the job then inserts an alert. The alert stays open until the next daily run clears it with `seller-registered`. Closing it would need a cross-module lock; not worth it, since an alert decides nothing and blocks no sale (D 3.2, ADR-0007 decision 6). The job tests include this sequence.

## 6. Access paths

Volume used for the measurements: 2 Markets × 10⁴ sellers × 20 alerts each = 4 × 10⁵ rows, 2,002 open (about 10 × the first-year seller count of 10³, and 20 crossings per seller, far above the expected rate). PostgreSQL 16.15, as the application login, warm cache (11).

| # | Query (D section) | Statement (Prisma shape) | Index | Measured |
|---|---|---|---|---|
| A1 | Seller's own status and open alert (`tax.view-own-threshold-status`, D 5.2); admin view of one seller (`tax.view-seller-threshold-status`) | `findFirst` where `{ marketId, sellerId, clearedAt: null }` | `threshold_alerts_market_id_seller_id_open_key` | Index scan, **3 buffers, 0.07 ms**, also with a forced generic plan (platform.md 10.9) |
| A2 | Job: open alerts of a batch of up to 100 sellers (D 11) | `findMany` where `{ marketId, sellerId: { in: [≤100] }, clearedAt: null }` | Same | Index scan, 203 buffers, 0.29 ms |
| A3 | Admin list of the Market's open alerts, oldest first (`tax.list-threshold-alerts`) | `findMany` where `{ marketId, clearedAt: null }`, order `(openedAt, id)`, keyset after the last pair, page of 50 | Same index (bitmap on `market_id`), then a top-N sort | 1,001 open in the Market: **6.0 ms, 1,017 buffers** |
| A4 | Clear (job, handler) | `updateMany` by `{ marketId, id, clearedAt: null }` | PK | Point update |
| A5 | Open (job) | `create`; `P2002` = already open | Partial unique key | — |
| A6 | Purge (`tax.purge-threshold-alerts`, 9): one batch of cleared alerts older than the cutoff | `findMany` where `{ marketId, clearedAt: { lt: cutoff } }`, select `id`, order `id`, `take: 500`; then `deleteMany` where `{ marketId, id: { in: ids }, clearedAt: { lt: cutoff } }` | PK for the delete; **no index for the selection** (below) | 4 × 10⁵ rows, 398,000 cleared: parallel seq scan, **51 ms** per batch selection; with a partial `(market_id, cleared_at) WHERE cleared_at IS NOT NULL` index, 3 buffers |
| A7 | Job population: sellers with an open alert (D 4.10, 11) | `findMany` where `{ marketId, clearedAt: null }`, select `sellerId`, keyset by `sellerId`, `take: 100` | Partial unique key | Index scan on the open key |

**Deliberately not added**
- `(market_id, opened_at, id) WHERE cleared_at IS NULL` for A3. At 10³ open alerts per Market the sort costs 6 ms; add the index (and the keyset becomes an index range) when open alerts in one Market exceed about 10⁴.
- `(market_id, seller_id, opened_at)` for a seller's alert history: no use case reads history (D 5.2). It arrives with its reader.
- Any index on `inbox` until the prune job (ID-data 3.8).
- `(market_id, cleared_at) WHERE cleared_at IS NOT NULL` for A6. The purge runs once a day; 51 ms per batch at forty times the expected volume does not pay for a second index on every insert and clear. Add it when the table passes about 10⁶ rows or a purge run exceeds a few seconds.

## 7. Grants

Under platform.md 10.2: hand-written in the `migration.sql` that creates the table, in the block `-- Grants (database-designer): `docs/design/data/tax.md` section 7`, to `mondapac_app` only, mirrored by `REVOKE` in `down.sql` before any `DROP`. `GRANT USAGE ON SCHEMA "tax"` is in the same migration. The trigger function gets no grant (it fires without `EXECUTE`).

| Table | Privileges of `mondapac_app` | Reason |
|---|---|---|
| `tax.outbox` | `SELECT, INSERT, UPDATE (published_at)` | PM2 |
| `tax.inbox` | `SELECT, INSERT` | `DELETE` arrives with the prune job |
| `tax.threshold_alerts` | `SELECT, INSERT, UPDATE (cleared_at, clear_cause), DELETE` | PD5: the clear pair only. `DELETE` for the retention purge (Hassan H5, D PD6), narrowed by the trigger to cleared rows (3.2). No `TRUNCATE`. No `@updatedAt` column exists |

Measured as the application login: an update of `trailing_total_minor`, of the outbox `payload`, and `TRUNCATE` refused with `42501`; `DELETE` of an open alert refused by the trigger with `23001`; `DELETE` of a cleared alert accepted; the guarded clear accepted; a second, unguarded clear refused by the trigger with `23001`. The privilege map of platform.md 10.5 gains these three lines in slice 6's PR.

## 8. Migration plan

### 8.1 Order

| # | Slice | Migration | Contains |
|---|---|---|---|
| — | 1 to 5 | None (PD1) | — |
| 1 | 6 (P1) | `<timestamp>_tax_threshold_alerts` | `CREATE SCHEMA IF NOT EXISTS "tax"`; `outbox`, `inbox`, `threshold_alerts` with their CHECKs, the partial indexes, the guard function and three triggers; schema `USAGE` and table grants. `base.prisma` gains `"tax"` |

One migration PR open at a time across Phase 5 tracks (`docs/process/parallel-tracks.md` rule 6); slice 6 is after launch, so it does not compete with `ordering`'s and `payments`' migrations.

### 8.2 The migration (draft, measured up → down → up)

Prisma generates the tables, the primary keys and the non-partial unique index from `tax.prisma`. Hand-written, appended under marked blocks as in platform.md 6:

```sql
-- Hand-written (database-designer): `docs/design/data/tax.md` 3.1, 3.2
ALTER TABLE "tax"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^tax\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');
CREATE INDEX "outbox_market_id_event_id_unpublished_idx" ON "tax"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

ALTER TABLE "tax"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^tax\.[a-z0-9-]+$');

ALTER TABLE "tax"."threshold_alerts"
  ADD CONSTRAINT "threshold_alerts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "threshold_alerts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "threshold_alerts_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "threshold_alerts_amounts_check" CHECK ("trailing_total_minor" > 0 AND "trailing_total_minor" <= 9007199254740991
                                                       AND "threshold_minor" > 0 AND "threshold_minor" <= 9007199254740991),
  ADD CONSTRAINT "threshold_alerts_warning_ratio_check" CHECK ("warning_ratio" > 0 AND "warning_ratio" <= 1 AND scale("warning_ratio") <= 6),
  ADD CONSTRAINT "threshold_alerts_crossed_check" CHECK ("trailing_total_minor" >= "threshold_minor" * "warning_ratio"),
  ADD CONSTRAINT "threshold_alerts_window_check" CHECK ("window_from" < "window_to"),
  ADD CONSTRAINT "threshold_alerts_seller_zone_check" CHECK ("seller_zone" ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
                                                           AND char_length("seller_zone") <= 64),
  ADD CONSTRAINT "threshold_alerts_tax_rule_set_id_check" CHECK ("tax_rule_set_id" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  ADD CONSTRAINT "threshold_alerts_clear_cause_check" CHECK ("clear_cause" IN ('below-ratio', 'seller-registered')),
  ADD CONSTRAINT "threshold_alerts_cleared_check" CHECK ((("cleared_at" IS NULL) = ("clear_cause" IS NULL))
                                                       AND ("cleared_at" IS NULL OR "cleared_at" >= "opened_at"));
CREATE UNIQUE INDEX "threshold_alerts_market_id_seller_id_open_key"
  ON "tax"."threshold_alerts" ("market_id", "seller_id") WHERE "cleared_at" IS NULL;

CREATE FUNCTION "tax"."threshold_alerts_guard"() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'tax.threshold_alerts: TRUNCATE is not allowed' USING ERRCODE = '23001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."cleared_at" IS NULL THEN
      RAISE EXCEPTION 'tax.threshold_alerts: an open alert is never deleted' USING ERRCODE = '23001';
    END IF;
    RETURN OLD;  -- the retention purge (`docs/design/data/tax.md` 9)
  END IF;
  IF (NEW."id", NEW."market_id", NEW."tenant_id", NEW."seller_id", NEW."opened_at", NEW."window_from",
      NEW."window_to", NEW."seller_zone", NEW."tax_rule_set_id", NEW."currency",
      NEW."trailing_total_minor", NEW."threshold_minor", NEW."warning_ratio")
     IS DISTINCT FROM
     (OLD."id", OLD."market_id", OLD."tenant_id", OLD."seller_id", OLD."opened_at", OLD."window_from",
      OLD."window_to", OLD."seller_zone", OLD."tax_rule_set_id", OLD."currency",
      OLD."trailing_total_minor", OLD."threshold_minor", OLD."warning_ratio") THEN
    RAISE EXCEPTION 'tax.threshold_alerts content is immutable' USING ERRCODE = '23001';
  END IF;
  IF OLD."cleared_at" IS NOT NULL THEN
    RAISE EXCEPTION 'tax.threshold_alerts: a cleared alert is final' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "threshold_alerts_guard_update" BEFORE UPDATE ON "tax"."threshold_alerts"
  FOR EACH ROW EXECUTE FUNCTION "tax"."threshold_alerts_guard"();
CREATE TRIGGER "threshold_alerts_guard_delete" BEFORE DELETE ON "tax"."threshold_alerts"
  FOR EACH ROW EXECUTE FUNCTION "tax"."threshold_alerts_guard"();
CREATE TRIGGER "threshold_alerts_guard_truncate" BEFORE TRUNCATE ON "tax"."threshold_alerts"
  FOR EACH STATEMENT EXECUTE FUNCTION "tax"."threshold_alerts_guard"();

-- Grants (database-designer): `docs/design/data/tax.md` section 7
GRANT USAGE ON SCHEMA "tax" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "tax"."outbox" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "tax"."inbox" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("cleared_at", "clear_cause"), DELETE ON TABLE "tax"."threshold_alerts" TO "mondapac_app";
```

`down.sql` (reverse order: revokes, triggers, tables, function, schema usage; no `IF EXISTS`; the empty schema stays, as in ID-data 8.2, which is why the up says `CREATE SCHEMA IF NOT EXISTS`, as Prisma generates it):

```sql
REVOKE SELECT, INSERT, UPDATE ("cleared_at", "clear_cause"), DELETE ON TABLE "tax"."threshold_alerts" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "tax"."inbox" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("published_at") ON TABLE "tax"."outbox" FROM "mondapac_app";
DROP TRIGGER "threshold_alerts_guard_truncate" ON "tax"."threshold_alerts";
DROP TRIGGER "threshold_alerts_guard_delete" ON "tax"."threshold_alerts";
DROP TRIGGER "threshold_alerts_guard_update" ON "tax"."threshold_alerts";
DROP TABLE "tax"."threshold_alerts";
DROP TABLE "tax"."inbox";
DROP TABLE "tax"."outbox";
DROP FUNCTION "tax"."threshold_alerts_guard"();
REVOKE USAGE ON SCHEMA "tax" FROM "mondapac_app";
```

Measured: up, down, up as a non-superuser owner; after the down no relation or function is left in `tax` and the schema carries no grant for `mondapac_app`. The function is a trigger function, so it gets no grant and no `REVOKE` (platform.md 10.2; a direct call fails with `0A000`), as in pricing's migration.

### 8.3 Safety

- All three tables are new: no backfill, no lock that matters, plain `CREATE INDEX`.
- Later changes on a live `threshold_alerts`: expand/contract; a new CHECK `NOT VALID` then `VALIDATE`; a new column nullable without default (metadata only) and added to the guard function's immutable list by `CREATE OR REPLACE` in the same migration.
- My sign-off uses the checklist of platform.md 8 and the five review points of platform.md 10.2, plus: the hand-written block equals 8.2, and the catalog tests below changed in the same PR.

### 8.4 Prisma specifics

- `prisma/schema/tax.prisma`: `TaxOutbox`, `TaxInbox` (copies of the pricing models under `@@schema("tax")`), `TaxThresholdAlert` with `BigInt` amounts, `@db.Char(3)`, `@db.Timestamptz(6)`, `@db.Uuid`, `@db.VarChar(8)`, and `warningRatio Decimal` (X2; spike S1 below).
- **Hand-written** (Prisma cannot express them): every CHECK, the two partial indexes, the function and the three triggers, the grants.
- **Catalog tests** (`pnpm test:db`, ID-data 8.4 option A): the checked-in list of partial indexes gains `outbox_market_id_event_id_unpublished_idx` and `threshold_alerts_market_id_seller_id_open_key`; the privilege map gains section 7; "every outbox has the same columns" gains `tax.outbox`; the trigger test refuses each guard branch as `mondapac_app` and as the owner.
- **Spike S1, in slice 6's PR (Hossein, with me):** (a) whether Prisma 7 can declare an unconstrained `numeric` (`Decimal @db.Decimal` without arguments) and keeps it out of drift; otherwise X2's fallback `@db.Decimal(7, 6)`; (b) how `Prisma.Decimal` serialises `0.10` (decimal.js may print `0.1`; harmless under X2's numeric comparison, but the audit `after` value must not depend on it).

## 9. Volume, retention and jobs

**Assumption** (first year, Greater Brisbane, one Market): 10² to 10³ sellers; the warning concerns only unregistered sellers near $60,000 of yearly platform sales, so open alerts are expected in the tens.

| Table | Rows expected (year 1) | Measured at test volume | Growth control |
|---|---|---|---|
| `threshold_alerts` | Tens; worst case one per seller per day of flapping around the ratio (365 per seller per year) | 4 × 10⁵ rows: heap 73 MB, PK 17 MB, open key 128 kB | Open rows kept; cleared rows purged after the AG-12 period (below). No partitioning |
| `outbox` | One row per opened alert | — | Platform pruning (P 6.5) |
| `inbox` | One row per `tax-registration-recorded` event | — | Platform prune job (ID-data 3.8) |

**Flapping.** With the default clear ratio (= warning ratio, D 4.10) a seller whose total moves around the ratio day by day gets a new alert, an event and an email on every upward crossing. Volume is no problem; the seller experience may be. A clear ratio below the warning ratio is Hadi's call (Ali M3; 3.2 for the optional column).

**Retention (PD6; Hassan H5, accepted in D 3.2).**
- A sole trader's platform turnover is personal information (INTL-52). An **open** alert is kept. A **cleared** alert is deleted once `cleared_at` is older than the Market's tax-record retention period (AG-12). Until AG-12 is answered the period is unset, the job deletes nothing and logs that the period is unset (D 11); there is no core default.
- The audit rows of the alert actions carry ids, ratio and clear cause, **no trailing total** (D 8), so the audit log, which is never deleted, keeps no turnover figure. The event payload never had one (3.1).
- **`sellers`' purge of a seller file (SEL 8.4, sellers-data 10.1).** That purge selects only never-approved files. A never-approved seller has made no sale, so `sellersWithSupplies` never lists it and no alert can exist for it: nothing to purge in `tax` today, and no cross-module call is added (it rests on sellers-data 10.1 selecting never-approved files only; if that selection widens, the handler below is needed first). **Later:** erasure of an approved seller's file (sellers-data 10.4, with CUS-03) is not designed yet; when it is, it publishes an event and `tax` adds an inbox handler that deletes that seller's **cleared** alerts and clears then deletes an open one (cause to be added to `clear_cause` by a `NOT VALID` CHECK swap). Recorded as follow-up F-T1 (12.2).

**Job** `tax.evaluate-registration-thresholds` (D 11), daily per hosted Market, `market_id` at the top level of every statement. Population (D 4.10, Ali T8): the seller ids from `SellerTurnoverSource.sellersWithSupplies` over the widest window of the run (keyset by seller id, 100 per page; plan measured in ordering-data 3.9.1), merged with the sellers that have an open alert (A7). For each batch of up to 100 sellers: one ST1 read, one ST2 read, the sellers grouped by zone and one `turnoverOf` call per distinct window (10.1.3), one A2 read, then per seller one unit (open: insert + outbox + audit; clear: guarded update + audit). Safe to run twice and concurrently (partial unique key; guarded clear).

**Job** `tax.purge-threshold-alerts` (D 11; Hassan H5), daily per hosted Market, system actor:
1. Read the Market's retention period; unset → log "retention period unset" and stop (nothing deleted).
2. `cutoff = now − period`, from `Clock` (the period is a duration of the Market's tax records, AG-12; whether it counts from `cleared_at` or from the end of the financial year is AG-12's answer, and the job computes `cutoff` accordingly; the row only offers `cleared_at`).
3. Loop: A6 selection (`take: 500`, order `id`); none → stop. One unit per batch: `deleteMany` where `{ marketId, id: { in: ids }, clearedAt: { lt: cutoff } }` (the predicate is repeated, so a row cleared later or a wrong id list deletes nothing extra; the trigger refuses an open row in any case), plus one audit row `tax.threshold-alert.purged` with the alert ids only (no seller turnover; seller ids are not needed and are left out). Batches of 500 keep each unit short (500 point deletes by PK; the delete itself was not timed at volume).
4. Safe to run twice and concurrently: a second run selects nothing, or `deleteMany` deletes 0 rows for ids already gone.
- After a large first purge, autovacuum reclaims the space; no manual `VACUUM` is needed at this size.

## 10. Inputs to other modules' data designs (PD3, PD7, PD8, ST1)

These are not `tax` tables. Each module's own data design owns them. For `ordering` that is now done: **`docs/design/data/ordering.md` is the owning text** (3.5, 3.6, 3.9, 3.9.1, 3.12) and wins over this section if the two ever differ; this section keeps only what `tax` relies on and the names, so that one naming is used (todo B2). For `commission-payouts`, 10.2 is the input to its G2 data design.

### 10.1 `ordering` (PD7, PD3)

**10.1.1 Line and charge snapshot** (todo B1; on `ordering.order_lines` and `ordering.seller_order_charges`, ordering-data 3.5 and 3.6; `TaxBreakdown` = the frozen `LineTaxAnswer`, Ali's review item 1). Names are `ordering`'s:

| Column | Type | Notes |
|---|---|---|
| `tax_inclusive` | `boolean NOT NULL` | **The price basis sent to `tax`** (Ali D-1, accepted): `true` = the amount contains the tax. On lines (from the price record, PRC 4.5) **and** on charges. **No `price_basis` column** for the tax basis (the earlier draft's proposal is withdrawn; `order_lines.price_basis` is pricing's `regular`/`special`, unrelated) |
| `tax_rule_set_id` | `text` | X3 pattern |
| `tax_strategy_code` | `text` | X3 pattern |
| `tax_category_code` | `text NOT NULL` | CA4 pattern `^[a-z][a-z0-9_-]{0,63}$` (accepts AU `gst_free`); on charges too (`tax` always names the charge's category, D 4.5) |
| `tax_treatment` | `text` | CHECK `IN ('rated', 'free', 'seller-not-registered')` |
| `tax_rate` | `numeric` | X2 with `>= 0`; `0` unless `rated` (D 2.2, M1 answered) |
| `tax_gross_minor`, `tax_minor`, `tax_net_minor` | `bigint` | With the row's single `currency char(3)`; X1 bounds, `tax >= 0`, `net >= 0`; CHECK `gross = net + tax` |
| `tax_seller_registered` | `boolean` | D PD7 `seller_registered` |
| `tax_registration_period_id` | `uuid` | Nullable. **Rule (D 4.4):** present when the seller is registered; may be present when not (a period that records "not registered"); NULL only when no period covers `at`. CHECK `NOT tax_seller_registered OR tax_registration_period_id IS NOT NULL`. **Opaque** (Hassan H1): stored and echoed, never parsed, never joined; plain id, no FK |
| `tax_evaluated_at` | `timestamptz(6)` | |

Backstop CHECKs, as ordering-data 3.5 and 3.6 declare them (re-measured there, 10.2): sum; `(tax_treatment = 'seller-not-registered') = (NOT tax_seller_registered)`; `tax_treatment = 'rated' OR (tax_minor = 0 AND tax_rate = 0)`; `tax_treatment <> 'rated' OR tax_rate > 0`; the period rule above. No `UPDATE` grant on any snapshot column (V3).

**10.1.2 Documents** (todo B2; ordering-data 3.9 owns the text): per document `kind` (the four document kinds), `issue_date` + `issue_zone` (the zone `tax` returns), `required_fields text[]` with the `<@` closed list of D 4.6 (decided: `text[]`, Prisma `String[]`), `tax_document_mandatory`, `buyer_identity_required`, `tax_rule_set_id`. Per document line, one naming:
- **Unit positions** (line rows): `position_space` (`invoiced` | `refunded`, NOT NULL on every row), `position_from` and `quantity`, the range `[position_from, position_from + quantity)`; `EXCLUDE USING gist` per (Market, order line, position space): no unit invoiced twice, none refunded twice (`23P01`, measured). This replaces the draft's `unit_position_from/_to` and `purpose`.
- **Charge portions** (charge rows): `charge_gross_minor` (copy of the charge's gross, proved by a composite FK), `cumulative_before_minor`, `cumulative_after_minor` with CHECK `0 <= before < after <= charge_gross_minor`, and an `EXCLUDE` over `int8range(before, after)` per (Market, charge, position space). A zero charge is never a document line (ordering-data F15).
- Adjustment notes are rows of `ordering.invoices` with their own `net_total_minor` and `issued_at`, so `turnoverOf` reads one table and a refund counts at its own issue instant (D 4.10). Refund requests carry gross, tax and net per line or charge (ordering-data 3.12); they feed the adjustment note, not the turnover read.

**10.1.3 `SellerTurnoverSource`** (todo B3; PD3; Ali ruled T3 option D and approved T8; P1, slice 6). Both methods run on `ordering`'s covering index M8 (ordering-data 3.9.1), re-measured there on the document tables themselves: `turnoverOf` 388 ms for the 100 largest sellers and 26 ms for the 100 smallest; `sellersWithSupplies(ctx, from, to, after, limit ≤ 100)` 152 ms for the first page and 0.65 s for the whole walk of 1,000 sellers (index-only scan, `Group`, `Limit`; Prisma `groupBy` with `take`, never `findMany` `distinct`, which de-duplicates in memory). The first measurement, on a scratch invoice-line table, is kept below for the index choice: 3 × 10⁶ rows over two years, 1,000 sellers with a skewed distribution (largest 299,268 rows, smallest 947), 100 sellers per call, a 12-month window. Statement: Prisma `groupBy` by `sellerId` with `_sum` of the net, where `{ marketId, sellerId: { in: [≤100] }, issuedAt: { gte: from, lt: to } }` (no raw SQL), once for invoice lines and once for refund lines.

| Index on the invoice-line (and refund-line) table | 100 largest sellers (694,615 rows in window) | 100 smallest sellers (52,132 rows) | Size |
|---|---|---|---|
| `(market_id, seller_id, issued_at)` | Index scan with heap fetches: **4.0 to 4.2 s**, 564,000 buffer reads | — | 142 MB |
| **`(market_id, seller_id, issued_at) INCLUDE (net_minor)`** (recommended) | Index-only scan, 0 heap fetches: **0.33 to 0.40 s** | 25 ms | 169 MB |

The covering index is what matters (ten times faster than the plain index); the document-level re-measure confirmed it. Index-only scans depend on the visibility map: the document table is insert-only, so autovacuum keeps it current (PostgreSQL 13+ vacuums on inserts). A per-seller daily rollup in `ordering` stays unneeded.

**Per-zone windows (M2 (a), answered in D 4.10 and 11):** D 4.10 counts 365 days ending at each seller's local today, so sellers in different zones have different windows. The signature keeps one window per call; the job groups each batch by zone and calls `turnoverOf` once per distinct window (a Market has a handful of zones; ZZ's fixture has three). Per-seller windows in one call would be an `OR` of 100 ranges, which planned badly in PRC-data 6.1. `sellersWithSupplies` is called over the **widest** window of the run (the union of the zone windows), so no seller is missed; a listed seller whose own window holds no supply gets a total of 0. A refund counts at its own issue instant (D 4.10).

**"Data from day one" (brief s3, s6)** depends on `ordering` keeping every invoice and adjustment note with `seller_id`, `issued_at`, `net_total_minor` and `currency` for at least the window plus the retention of AG-12, which its legal-document rules already require (D 4.10; tax brief change-log row with T3).

### 10.2 `commission-payouts` (PD8)

**Commission-tax entry.** Freezes, with its amount: `tax_rule_set_id text` (X3); `tax_rate numeric` (X2, `>= 0`); `supplier_registered boolean`; `legal_entity_registration_valid_from timestamptz(6)` **NOT NULL** (an unknown registration is refused, so no stored entry lacks it, D 4.9); `tax_evaluated_at timestamptz(6)` (the `at` sent, = the invoice's immutable `issuedAt`, Hassan H2); `commission_minor bigint` and `commission_tax_minor bigint` with the entry's `currency char(3)`, CHECK `>= 0` and `supplier_registered OR commission_tax_minor = 0`; unique per invoiced line (one entry per line, D 4.9), which is also the idempotency key of the handler. For the reversal FK below it also declares unique `(market_id, id, currency, commission_minor)`.

**Reversal entry (todo B4; D 4.9, PD8; Hassan H7).** `reverseCommissionTax` takes frozen values only; the database proves the copies are the original's and that no part of a commission is reversed twice:

| Column | Type | Notes |
|---|---|---|
| `reverses_entry_id` | `uuid NOT NULL` | The original commission-tax entry, inside the `commission-payouts` schema |
| `currency` | `char(3)` | Copy of the original's |
| `original_commission_minor` | `bigint` | Copy of the original's commission |
| `reversed_before_minor`, `reversed_after_minor` | `bigint` | The cumulative commission reversed before and after this reversal (D 4.9 `CumulativeAmountAllocator`) |
| `commission_tax_reversed_minor` | `bigint` | This reversal's tax as `tax` returned it; CHECK `>= 0` |
| (rate, rule set, registration) | — | Not copied: read through the FK from the original entry, so they cannot differ |

| Constraint | Backs |
|---|---|
| FK `(market_id, reverses_entry_id, currency, original_commission_minor)` → original `(market_id, id, currency, commission_minor)` | The reversal names a real entry of the same Market; currency and original commission are the original's (the O3 pattern of ordering-data). The currency mismatch that Hassan H7 has `tax` refuse is also a database refusal |
| CHECK `0 <= reversed_before_minor AND reversed_before_minor <= reversed_after_minor AND reversed_after_minor <= original_commission_minor` | D 4.9's `0 ≤ before ≤ after ≤ original`. **`<=`, not `<`** (CP-data L14, applied 2026-10-08): a partial unit reversal can reverse 0 commission by rounding (C = 1, q = 3, u = 1) while units and seller share still move, and `commission-payouts` stores that row (its units and gross ranges stay strict). An empty range overlaps nothing, so the `EXCLUDE` below is unaffected. `tax`'s own rule is unchanged: it may accept `before = after` and answer 0 |
| `EXCLUDE USING gist (market_id WITH =, reverses_entry_id WITH =, int8range(reversed_before_minor, reversed_after_minor) WITH &&)` | No part of a commission is reversed twice, whatever the stored cumulative counter says (`btree_gist`, PRC-data 8.3) |

Measured on scratch tables (11): `[0, 400)` then `[400, 1000)` accepted; `[300, 500)` refused `23P01`; `after` above the original and `before = after` refused `23514` (the latter under the earlier `<`; with L14's `<=` it is accepted, as measured on CP-data's own table: two empty commission ranges on one assessment accepted); a wrong original commission, a wrong currency (on a free range) and another Market refused `23503`. That all reversals' tax sums to the original tax is arithmetic of `CumulativeAmountAllocator` (D 13 property test), not a constraint. Grants `SELECT, INSERT` only (V3). This is the input to `commission-payouts`' own G2 data design; its names are that design's choice.

### 10.3 `sellers` (ST1, for its mini-review)

`taxRegistrationOf(ctx, sellerIds ≤ 100, at)`: one Prisma `findMany` on `tax_registration_periods` where `{ marketId, sellerId: { in }, validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gt: at } }] }`, selecting `sellerId`, `id`, `registeredForIndirectTax`, `validFrom`, on the existing btree `(market_id, seller_id, valid_from)` (sellers 3.7). The no-overlap `EXCLUDE` guarantees at most one row per seller. No new index, column or grant; no tax number is selected (H4). A cancelled future period (sellers 7, `DELETE` granted) can never be the one frozen, because a period that contains `at` is not in the future.

## 11. Evidence

Measured on 2026-10-08 on PostgreSQL 16.15 in a throwaway cluster: a non-superuser owner with the attributes of platform.md 10.1, the `NOLOGIN` group `mondapac_app` and one login member that ran the application tests. `shared_buffers` 128 MB (default), so the 169 MB turnover index did not fit in cache. Everything was dropped afterwards. Every SQLSTATE quoted was observed. Rows marked **(rev)** were measured for this revision, after the H5 guard change.

| Verified | Used in |
|---|---|
| **(rev)** Up, down, up of 8.2 (H5 guard, `DELETE` grant) as the non-superuser owner; nothing left after the down | 8.2 |
| Second open alert for one seller refused (`23505`); same seller in `ZZ` (JPY) accepted; a cleared alert allows a new open one | 3.2 |
| `crossed_check` (5,999,999 vs 7,500,000 × 0.80), ratio with 7 decimals, `2^53`, an offset as zone, `cleared_at` without cause: each refused (`23514`) | 3.2, X1, X2, X4 |
| As `mondapac_app`: content update, outbox `payload` update refused (`42501`); guarded clear changes 1 row, a repeat 0; unguarded re-clear refused by the trigger (`23001`) | 3.2, 7 |
| **(rev)** As the application login: `DELETE` of an open alert refused by the trigger (`23001`); `TRUNCATE` refused (`42501`); the purge's `DELETE` of a cleared alert with `cleared_at < cutoff` accepted. As the owner: `TRUNCATE` and `DELETE` of an open alert refused (`23001`); the open row remained | 3.2, 7, 9 |
| Outbox: another module's type refused (`23514`) | 3.1 |
| Plans of A1 (custom and forced generic), A2, A3 at 4 × 10⁵ rows; sizes | 6, 9 |
| **(rev)** A6 purge selection at 4 × 10⁵ rows: parallel seq scan 51 ms without an index; 3 buffers with a partial `(market_id, cleared_at)` index (not added) | 6, 9 |
| `'0.10'::numeric` keeps `0.10`; `numeric(7,6)` gives `0.100000`; `0.10 = 0.1` | X2 |
| Scratch PD7 table: `gross ≠ net + tax`, `free` with a non-zero rate, flag/treatment mismatch, 7-decimal rate refused; per-unit `EXCLUDE` (`23P01`) | 10.1 (superseded by ordering-data 10.2, measured on the real tables) |
| Turnover `groupBy` shape with and without `INCLUDE` at 3 × 10⁶ rows; **(rev)** `turnoverOf` and `sellersWithSupplies` on the document table | 10.1.3, ordering-data 3.9.1 |
| **(rev)** Commission reversal scratch tables: range CHECK, `EXCLUDE` (`23P01`), composite FK on currency, original commission and Market (`23503`) | 10.2 |

**Not measured:** PostgreSQL 17 (Compose, CI); anything through Prisma (spike S1); the market guard; the purge's `deleteMany` at volume; the jobs end to end; `commission-payouts`' real tables (its G2 is not written).

## 12. Answers and open points

### 12.1 Answers to Mohammad (D 7)

| # | Answer |
|---|---|
| PD1 | **Confirmed.** No schema, model or migration before slice 6; a boundary fixture keeps Prisma out of `modules/tax` until then (1) |
| PD2 | **No sales table** (option D, ruled by Ali). Option A's table is specified in 3.3 for a reversal only |
| PD3 | `ordering`'s M8 covering index serves `turnoverOf` and `sellersWithSupplies` (ordering-data 3.9.1, measured); per-zone grouping (10.1.3) |
| PD4 | `tax.threshold_alerts` (3.2): partial unique `(market_id, seller_id) WHERE cleared_at IS NULL`; open = `cleared_at IS NULL` (no state column); content and the clear pair write-once by trigger |
| PD5 | `SELECT, INSERT, UPDATE (cleared_at, clear_cause)`, plus `DELETE` for the purge, narrowed by the trigger to cleared rows (7; PD6) |
| PD6 | Purge job of cleared alerts after AG-12, nothing while unset; open alerts kept; `sellers`' purge cannot meet an alert today; approved-seller erasure is follow-up F-T1 (9) |
| PD7 | Reviewed; `docs/design/data/ordering.md` owns it; names and rules in 10.1.1 and 10.1.2. `price_basis` withdrawn (Ali D-1) |
| PD8 | Reviewed; 10.2 with the reversal entry and its constraints (B4) |

### 12.2 Status of earlier points, and still open

| # | Point | Status |
|---|---|---|
| M1 | Rate for `seller-not-registered`; numeric comparison | **Answered** (D 2.2: `0` unless `rated`; rates compared numerically). The backstop CHECKs stand |
| M2 | Per-zone windows; job population; refund instant | **Answered**: per-zone grouping (D 11), `sellersWithSupplies` plus open alerts (Ali T8, D 4.10), refund at its own issue instant. Plan measured (10.1.3) |
| M3 | Hysteresis | **Answered**: Hadi's call, default `clearRatio = warningRatio` (Ali). Optional `clear_ratio` column only if adopted (3.2) |
| M4 | Commission-tax reversal from frozen values | **Answered** (D 4.9, PD8); constraints specified and measured (10.2) |
| H1 | Turnover as personal information | **Answered** (Hassan H5): purge after AG-12 (9), no total in audit; Hassan checks at code time |
| H2 | Turnover read by `tax` | **Answered** (Hassan H6): system-only list |
| S1 | Spike S1 (8.4): unconstrained `numeric` in Prisma 7; `Prisma.Decimal` text form | **Open**: Hossein, with me, slice 6 PR |
| AG-12 | Tax-record retention period (and whether it counts from `cleared_at` or the financial year end) | **Open**: tax agent. Until answered, nothing is purged |
| F-T1 | Erasure of an approved seller (sellers-data 10.4, CUS-03): `tax` handler that removes that seller's alerts | **Follow-up**, with that design; not blocking slice 6 |
| B5 | `clear_ratio` column | **Conditional** on Hadi (M3) |
| K1 | None for `tax`. `btree_gist` (ordering 3.9 and C-P 10.2) is settled by PRC-data 8.3 K1 | — |

No ADR change: everything here follows ADR-0004, 0007 and 0009. Platform items raised by this G2 (audit columns for ADR-0038, audit volume, subject kinds) are in platform data note 2026-10-08.

## 13. Review record

| Date | Who | Result | Applied in |
|---|---|---|---|
| 2026-10-08 | Mojtaba (database-designer) | G2 draft | Whole document |
| 2026-10-08 | Hassan (security-tester), Hassan review 2026-10-08 | Accept with changes: H1 opaque period id; H2 immutable `issuedAt` for `at`; H3 golden list is a file; H5 turnover is personal information (purge, no total in audit); H6 system-only; H7 reversal validation | H1: 10.1.1. H2: 10.2. H3: 4 (B7). H5: 2, 3.2, 4, 7, 8.2, 9. H7: 10.2 |
| 2026-10-08 | Ali (cto), Ali G2 review 2026-10-08 sections 6 and 7 | D-1 (no `price_basis`; `tax_inclusive` on lines and charges); T8 (`sellersWithSupplies`); M3 (Hadi's call, default no hysteresis) | 10.1.1, 10.1.3, 9, 3.2 |
| 2026-10-08 | Mojtaba (database-designer), this revision | **Todo B1 to B7 applied**: B1 10.1.1; B2 10.1.2 (ordering-data owns the text); B3 10.1.3, 9; B4 10.2, measured; B5 3.2 (conditional); B6 3.2, 6, 7, 8.2, 9, measured; B7 4. Re-measured (11, **(rev)**) | Whole document |
| 2026-10-08 | Ali (cto), Hassan (security-tester) | **G2 data design approved with conditions** (status line): Hassan checks H5 at code time; spike S1 in slice 6's PR | Status line |
