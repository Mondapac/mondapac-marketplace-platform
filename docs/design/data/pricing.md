# Physical data model — `pricing` schema (G2)

**Author:** Mojtaba (database-designer) — 2026-10-07
**Status:** G2 approved with conditions 2026-10-07 (Ali (cto) final verdict; Bagher (qc-release-manager) final check; 11.3). Reviewers: Mohammad (software-architect), Ali (cto), Hassan (security-tester); Kazem (devops-engineer) settles 8.3 (a condition). Each migration still needs my sign-off. Catalog G2 is merged (PR #54) and accepts CF1–CF4 as ruled (catalog 9.7, 18). Follow-up: Reza (ui-ux-designer) pending, UI condition. Revised 2026-10-07 for Ali's ruling P-1 on catalog's G2 (draft 25cbf3a, merged as PR #54): the CF4 re-key (3.2, 3.6, 3.7, 5.1, 7, 8.1, 11.2 M8). Revised again 2026-10-07 for Ali's and Hassan's re-key review (3.2.1, 7, 8.1 row 7, 11.2 M8). Open points: 11.2.
**Ground truth:** `docs/design/domain/pricing.md` (Mohammad, revised 2026-10-07 with Ali's and Hassan's reviews applied; cited as **D**, for example "D 3.1"; its inputs PD1 to PD7 and questions M1 to M3); `docs/modules/pricing/brief.md` (G1 approved by the owner 2026-10-07; "brief s5", "AC 12", "Q8"); `docs/design/domain/platform-persistence-and-events.md` (**P**; inputs PM1 to PM8); `docs/design/data/platform.md` section 10 (roles and grants, cited "platform.md 10"); `docs/design/data/identity.md` (conventions C1 to C11, cited "ID-data"); ADR-0004 (decisions 3 to 7), ADR-0006, ADR-0007 (decisions 1, 2, 4, 8, 10), ADR-0008, ADR-0009 (decision 2, V2), ADR-0020 (decision 6), ADR-0023 (decision 1), ADR-0024.
**Prisma models:** `prisma/schema/pricing.prisma` (new). Nothing here exists yet. This document is the specification the migrations are written from.
**Business rules:** none changed. Wherever the mapping needed a value or a reading that neither the brief nor D gives, it is an open question in 11.2, and the table shows my proposal.

## 1. Scope and table list

This is the physical design of what D asks the database to hold: tables, constraints, access paths, grants, the migration plan, volume, and evidence. The domain model is unchanged.

ADR-0009 patterns: **V2** for the regular and special price records (effective periods with an `EXCLUDE USING gist` no-overlap constraint, PD1). **V4** append-only for Cost records, boundary markers and tombstones. Nothing is V1 or V3: `ordering` freezes the record id (V3 lives there, ADR-0007 decision 8).

| Table | Holds (D 2.1, D 7) | ADR-0009 pattern | Created in (brief s11 slice) |
|---|---|---|---|
| `pricing.outbox` | The module's events (ADR-0006 decision 2; D 6.3) | None: a queue | 1 |
| `pricing.inbox` | Handled deliveries of catalog's events (D 6.4: `offer-deleted`, `variant-removed`; `offer-moved` from P1) | None | 1 |
| `pricing.price_series` | `PriceSeries` root: one per (Market, Offer, Variant) | None: live root, versioned | 1 |
| `pricing.regular_price_records` | `RegularPriceRecord` | V2, plus write-once decision columns | 1 |
| `pricing.retired_offers`, `pricing.retired_variants` | Retirement tombstones (PD7; Hassan finding 3) | V4 append-only | 1 |
| `pricing.cost_series` | `CostSeries` root | None: live root, versioned | 3 |
| `pricing.cost_records` | `CostRecord` | V4 append-only | 3 |
| `pricing.special_price_records` | `SpecialPriceRecord` | V2, plus write-once decision columns | 5 |
| `pricing.special_price_boundaries` | `BoundaryMarker` (PD6) | V4 append-only | 5 |
| `pricing.write_refusal_throttles` | **Proposed, open (11.2 M7):** the counter behind "at most 1 audit row per (actor, Offer) per minute" (D 5.2, H3) | None: transient counters | 1, if adopted |

Every table carries `market_id` and `tenant_id`, so the guard of P 4 needs no exemption line. `platform.audit_log` is unchanged (8.1).

### 1.1 ER sketch

```
pricing.price_series ─────────────┐ (market_id, id, currency)
  id, offer_id, variant_id,       │
  product_id, seller_id (copies), ├──< pricing.regular_price_records
  currency, retired_at, version   │        id, amount_minor, currency, status,
                                  │        effective_from, effective_to   ── EXCLUDE no-overlap (accepted|approved)
                                  │        anchor_record_id ──> regular_price_records (same series)
                                  │
                                  └──< pricing.special_price_records
                                           starts_at, ends_at, zone, effective_from, withdrawn_at
                                           regular_record_id ──> regular_price_records (same series)
                                           anchor_record_id  ──> regular_price_records (same series)
                                           ── EXCLUDE no-overlap (accepted|approved|withdrawn)
                                           └──< pricing.special_price_boundaries (0..2: start, end)

pricing.retired_offers   (market_id, offer_id)                 no FK: ids from catalog events
pricing.retired_variants (market_id, product_id, variant_id)   no FK

pricing.cost_series ──< pricing.cost_records       no relation to any price table (D 6.5)

pricing.outbox, pricing.inbox                      no FK
```

## 2. Conventions used by every table

ID-data C1 to C10 apply unchanged: `market_id varchar(8)` and `tenant_id text` with their pattern CHECKs and no default; `uuid` ids from the application; `timestamptz(6)` from `Clock`; no column default, sequence or enum; composite foreign keys that carry `market_id`; foreign keys only inside the schema; indexes lead with `market_id`; no raw SQL. What pricing adds:

| # | Convention |
|---|---|
| C1-C10 | As ID-data. Not repeated in the column tables below; the market and tenant CHECKs are on every table |
| P1 | **Money** (ADR-0004 decision 4, ADR-0007 decision 1): `<name>_minor bigint` plus `currency char(3)` with CHECK `^[A-Z]{3}$`. Amounts are minor units in the currency's own ISO 4217 exponent. The exponent is not stored: it comes from the kernel's `Money`, so AUD (2) and JPY (0, the `ZZ` fixture) use the same columns and CHECKs. Every amount has CHECK `> 0 AND <= 9007199254740991` (2^53 − 1; brief s5 "never above the safe integer"). Market maximums (Q10) are policy, not CHECKs (5) |
| P2 | **One currency per series, by foreign key.** `price_series` and `cost_series` carry `currency`, written once from the Market's currency when the series is created. Each record's foreign key is `(market_id, series_id, currency)` → `(market_id, id, currency)`. A record in another currency, or in another Market, is refused (measured, 10). This is a backstop for brief s5 "the currency equals the Market's"; the check against the Market itself stays in the domain (`PriceAmount`). Cost: one extra unique index per series table |
| P3 | **References inside one series.** A record's anchor and a special's measured regular record are foreign keys `(market_id, series_id, <ref>_id)` → `regular_price_records (market_id, series_id, id)`, so an anchor from another series is refused (measured). Target: the unique key `(market_id, series_id, id)`, which also serves "records of one series in submission order" (UUIDv7 ids are time-ordered) |
| P4 | **Status** is `text` with a closed CHECK, in lower-case kebab form as in identity: `accepted`, `pending-review`, `approved`, `rejected`, `superseded`, `withdrawn` (D's `ACCEPTED` … `WITHDRAWN`; the repository maps them). Every status a slice will ever need is in the CHECK from the table's first migration, so no later slice alters it |
| P5 | **Write-once columns.** Decision, supersede, withdrawal and period-end columns start NULL and are written once, in the transition that owns them. Three layers: the column-level `UPDATE` grant names only these columns (7); a `BEFORE UPDATE` trigger refuses any change to content, any status move that D 3 does not list, and any rewrite of a written-once column, for every role, the owner included (3.3); CHECKs tie each column to the statuses that need it |
| P6 | **No `DELETE`, no `TRUNCATE`.** No grant, and on the three record tables a trigger answers `23001` to the owner too (brief s5 "never deleted or rewritten"; brief s9 "complete and undeletable") |
| P7 | **Statement order inside a unit: shrink, then grow.** The `EXCLUDE` constraints are immediate. A unit that changes effective periods first closes or shortens the existing period (`effective_to`, `withdrawn_at`) and only then inserts or approves the new record. The reverse order fails with `23P01` (measured). Before both, the unit raises the series `version` (P 10) as its **first** statement, so a concurrent writer of the same series waits on that row and then finds the version stale. It never reaches the constraints |
| P8 | **Who-did-it columns** (`submitted_by_account_id`, `decided_by_account_id`, `withdrawn_by_account_id`) are plain ids without a foreign key (ID-data C4). The acting-as account (D 5.4) is **not** a column yet. Hassan's finding 6 refuses every price, special-price and Cost write in an acting-as session until the SEL-08 mini-review. That review adds `*_acting_as_account_id uuid NULL` columns: a metadata-only `ALTER TABLE … ADD COLUMN` that also extends the immutable list of the triggers (8.2) |
| P9 | **Prisma model names** start with `Pricing` (`PricingPriceSeries`, `PricingRegularPriceRecord`, `PricingCostRecord`, …), tables mapped with `@@map` (ID-data C9) |
| P10 | **Isolation.** READ COMMITTED, except two kinds of unit that run `serializable`: a unit that **creates** a `price_series` or `cost_series` row, and the two retirement handlers (5.1; measured); from P1 also the re-key handler (3.2.1; not measured). The batch read is a read-only unit with no transaction (ADR-0025 decision 1; 6.1) |

## 3. Tables

The columns of C1 are omitted. "Personal" marks personal data. Names of constraints and indexes are the exact database names.

### 3.1 `pricing.outbox` and `pricing.inbox` (slice 1; PM1 to PM4)

The two tables of ID-data 3.1 and 3.8, under this schema, with these changes only:
- `outbox_type_check`: `^pricing\.[a-z0-9-]+\.v[1-9][0-9]*$`. `aggregate_type` is `price-series` for the three events of D 6.3. Cost publishes nothing (D 6.3).
- `inbox_handler_check`: `^pricing\.[a-z0-9-]+$`.
- Unique `outbox_market_id_aggregate_id_aggregate_version_key`; partial `outbox_market_id_event_id_unpublished_idx`. `inbox_pkey (event_id, handler)`.
- `payload` holds ids, enums and instants only. No amount and no Cost is ever in a payload (D 6.3). The database cannot check that; the event contracts snapshot test (D 13) does.

### 3.2 `pricing.price_series` (slice 1; D 2.1, 2.3)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `offer_id` | `uuid` | no | catalog's Offer id (plain id, C4). Never changes |
| `variant_id` | `uuid` | no | catalog's Variant id. Changes only in the CF4 re-key, with `product_id` (3.2.1) |
| `product_id` | `uuid` | no | Copy from the catalog facade (`offerSellUnits`) at creation (D 2.3); the Variant-removed handler finds series by it. Changes only in the CF4 re-key, with `variant_id` (3.2.1) |
| `seller_id` | `uuid` | no | Copy at creation (D 2.3). **Ownership is never decided from it** (D 5.2) |
| `currency` | `char(3)` | no | P2. CHECK `^[A-Z]{3}$` |
| `rekeyed_from_product_id`, `rekeyed_from_variant_id` | `uuid` | yes | From P1 (migration 7): the key the series was moved from, written by the CF4 re-key only, with `variant_id` and `product_id`; CHECK both NULL or both set. Read by the reviewer queue to show "re-keyed" (D 6.4 step 5; Hassan, Low) |
| `retired_at` | `timestamptz(6)` | yes | Set once by a retirement handler |
| `retire_cause` | `text` | yes | CHECK `offer-removed`, `variant-removed`; CHECK `(retired_at IS NULL) = (retire_cause IS NULL)` and `retired_at >= created_at` |
| `version` | `integer` | no | CHECK `>= 1`; insert writes 1 (P 10). Raised by every write to the series: records, retirement, and the boundary job (D 11) |
| `created_at` | `timestamptz(6)` | no | |

- **Unique `price_series_market_id_offer_id_variant_id_key`**: one series per (Market, Offer, Variant) (D 2.1). Two concurrent first prices for one key: the second insert gets `P2002`, which the repository maps to `conflict.stale` (P 10, "creation races"). The same key in another Market is a separate series (measured).
- Unique `price_series_market_id_id_currency_key`: the P2 target.
- `price_series_market_id_product_id_variant_id_idx`: the Variant-removed handler (D 6.4).
- The Offer-removed handler uses the leading `(market_id, offer_id)` of the unique key.
- Not added: `(market_id, seller_id)`. No query lists series by seller. Seller screens start from catalog's Offer list and ask by key (6.1).
- A retired series is never "un-retired", never receives a record and is never re-keyed (D 2.1, 6.4). Its row stays, so its key can never be priced again. A removed Variant id never returns (catalog G2 M-1, merged PR #54; 11.2 M5 (c) closed).

#### 3.2.1 The CF4 re-key (P1; D 6.4, PD8)

`pricing.rekey-series-for-moved-offer` changes `variant_id` and `product_id` of an existing row in place, and records the old pair in `rekeyed_from_product_id` and `rekeyed_from_variant_id`. The series id stays, so every record, the anchor and basis foreign keys (P3), the markers and the ids `ordering` froze are untouched.
- **Before the unit (D 6.4 steps 1 to 3):** the `offerSellUnits` read and the validation of the mapping happen outside any transaction. A refused mapping writes only its audit row and dead-letters the delivery; an absent or `deleted` Offer goes through the Offer-removed path. No statement below runs for either.
- **One unit for the whole mapping, never chunked (Ali):** at most 100 pairs (`catalog.maxVariantsPerProduct` = 100), so at most 200 series rows (price and Cost) are updated, plus up to 100 tombstones; a larger mapping is refused before the unit. The predicate locks stay within the Offer's range of the unique key.
- **Statement order (P7), in one `serializable` unit (5.1):** raise `version` of every non-retired series of the Offer (`price_series` and `cost_series`); read the target keys (Offer, `to`) and the `(toProductId, to)` tombstones; insert the `(fromProductId, from)` tombstones (`skipDuplicates`); retire the series that cannot move (as the Variant-removed handler, cause `variant-removed`); then one `UPDATE` per moving series setting `variant_id`, `product_id`, `rekeyed_from_product_id` and `rekeyed_from_variant_id`.
- **Unique key `(market_id, offer_id, variant_id)`:** the handler moves a series only when its `to` is named once and no row holds (Offer, `to`). Old and new Variant ids are distinct (ids are never reused), so no swap passes through a transient duplicate. A concurrent first price for (Offer, `to`) either commits first (the handler then sees the target and retires the old series) or meets the handler's read and fails with `40001` (PostgreSQL reports a unique conflict on a key the transaction read as absent as a serialization failure); the UnitOfWork retries. Not measured yet (11.2 M8).
- **`EXCLUDE` constraints:** keyed by `(market_id, series_id)` and the periods; no record row is updated, so the re-key never touches them and cannot raise `23P01`.
- **Guard:** trigger `price_series_guard_update` (`BEFORE UPDATE`, also on `cost_series`): `id`, `market_id`, `tenant_id`, `offer_id`, `seller_id`, `currency`, `created_at` never change; when `variant_id` or `product_id` changes, the row must satisfy `NEW.product_id IS DISTINCT FROM OLD.product_id AND NEW.variant_id <> OLD.variant_id` (both change: never a move inside the same product; Hassan, Medium), `OLD.retired_at IS NULL`, `NEW.version > OLD.version`, and `NEW.rekeyed_from_product_id = OLD.product_id AND NEW.rekeyed_from_variant_id = OLD.variant_id`; the two `rekeyed_from_*` columns change only in that same update; `retired_at` and `retire_cause` are written once. `23001` otherwise, for the owner too (P5).
- **Only one writer (Hassan, Medium):** a `pnpm boundaries` rule lets only the re-key repository method (`rekey` on the price-series repository and its Cost twin) write `variant_id`, `product_id` and the `rekeyed_from_*` columns of either series model; a fixture that writes them elsewhere fails.
- **Tests, in the P1 PR with migration 7 (`pnpm test:db`; Hassan's condition on M8 (a)):** each guard branch refuses with `23001` (one column changed alone, a move inside the same product, a retired series, no version raise, a wrong `rekeyed_from_*` pair), run as `mondapac_app` **and as the owner role** (`mondapac_migrator`), which also gets `23001`; the privilege map refuses every other column with `42501`; the re-key unit at 100 pairs (200 series) and the `40001` on a concurrent first price for a target key (11.2 M8 (b)); no `EXCLUDE` constraint is touched; up, down, up of migration 7. The domain cases (more than 100 pairs, `offerSellUnits` mismatch, facade timeout, each refusal) are in D 13.

### 3.3 `pricing.regular_price_records` (slice 1; D 2.1, 3.1, 4.2)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; the `effectiveRecordId` / `regularRecordId` that `ordering` freezes (D 6.2) |
| `series_id` | `uuid` | no | FK `regular_price_records_series_id_fkey` `(market_id, series_id, currency)` → `price_series (market_id, id, currency)`, RESTRICT (P2) |
| `amount_minor` | `bigint` | no | P1 |
| `currency` | `char(3)` | no | P1, P2 |
| `tax_inclusive` | `boolean` | no | The Market's `pricesIncludeTax` at write time (D 4.5). Never changes |
| `status` | `text` | no | CHECK `accepted`, `pending-review`, `approved`, `rejected`, `superseded` (D 3.1) |
| `submitted_at` | `timestamptz(6)` | no | |
| `submitted_by_account_id` | `uuid` | no | P8 |
| `anchor_record_id` | `uuid` | yes | The anchor this record was measured against (D 2.4 option A, decided by Ali). NULL only for a record that was not measured (the first price, D 3.1). FK `regular_price_records_anchor_record_id_fkey` `(market_id, series_id, anchor_record_id)` → `(market_id, series_id, id)` (P3). CHECK: not the record itself |
| `anchor_amount_minor` | `bigint` | yes | The anchor's amount, copied. CHECK `(anchor_record_id IS NULL) = (anchor_amount_minor IS NULL)`, range as P1 |
| `hold_direction` | `text` | yes | CHECK `up`, `down`. `regular_price_records_hold_direction_check`: NULL if and only if `status = 'accepted'` (a held record is every record that is not `accepted`), and the direction agrees with the amounts: `up` requires `amount_minor > anchor_amount_minor`, `down` requires `<` |
| `effective_from` | `timestamptz(6)` | yes | Set when the record becomes effective: at insert for `accepted`, at approval for `approved` (D 3.1). CHECK: NOT NULL if and only if `accepted` or `approved`; `>= submitted_at`; for `approved`, `>= decided_at` ("effective from approval", brief s5). No input sets it (Q5) |
| `effective_to` | `timestamptz(6)` | yes | **The stored period end (M1).** NULL = open. Written once, in the unit that makes the next record effective (P7). CHECK `effective_to > effective_from`, so a period is never empty |
| `decided_at`, `decided_by_account_id` | `timestamptz(6)`, `uuid` | yes | CHECK: set if and only if `approved` or `rejected`; both or neither; `decided_at >= submitted_at` |
| `decision_reason_code` | `text` | yes | CHECK `^[a-z][a-z0-9-]{0,63}$`. Required for `rejected` (D 3.1, brief s9); allowed only once decided. The closed list is policy (Q4), not a CHECK |
| `decision_note` | `text` | yes | **Personal (free text): treated as personal.** Optional; only once decided. CHECK `regular_price_records_decision_note_check`: 1 to 1,000 characters (proposal, 11.2 M6), no outer spaces, no C0 or C1 control or bidi formatting character except newline (the class of ID-data 3.3). Never in an audit row, an event or a log (D 8: "the optional note stays on the record") |
| `superseded_at` | `timestamptz(6)` | yes | CHECK: set if and only if `superseded` |
| `superseded_by_record_id` | `uuid` | yes | The record that replaced it. Plain id **without** a foreign key: the superseded row is updated before its replacement is inserted (the one-pending index forces that order), and an immediate FK would refuse it. CHECK: set if and only if the cause is `replaced`; not the record itself |
| `supersede_cause` | `text` | yes | CHECK `replaced` (a new seller write, D 3.1 (a)), `cancelled` (a write equal to the current price, D 3.1 (b)), `offer-removed`, `variant-removed` (D 6.4). Names proposed (11.2 M6) |

**Constraints that carry D's invariants**

| Constraint | Invariant (D) | Measured (10) |
|---|---|---|
| `regular_price_records_effective_period_excl`: `EXCLUDE USING gist (market_id WITH =, series_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&) WHERE (status IN ('accepted', 'approved'))` | Regular effective periods never overlap (PD1, D 2.1). Two open periods always overlap, so it also means "at most one open period per series" | Overlap refused `23P01`; adjacent `[a, b)` and `[b, …)` accepted; pending, rejected and superseded rows ignored; approving before closing the previous period refused |
| `regular_price_records_market_id_series_id_pending_key`: unique `(market_id, series_id) WHERE status = 'pending-review'` | At most one pending regular record per series (PD2, AC 12) | Second pending refused `23505` |
| `regular_price_records_decider_check`: `decided_by_account_id IS NULL OR decided_by_account_id <> submitted_by_account_id` | The decider is never the submitter (H4, Hassan) | Refused `23514` |
| `regular_price_records_hold_direction_check` | A held record carries its anchor and a direction that matches the amounts (D 3.1, 4.2) | Wrong direction refused |
| `regular_price_records_effective_check`, `_decision_check`, `_superseded_check` | The columns each status needs (D 3.1); "effective from approval" | Each refused case in 10 |
| Trigger `regular_price_records_write_once` (`BEFORE UPDATE`, function `pricing.regular_price_records_guard_update()`) | Record content never changes; status moves only `pending-review` → `approved` / `rejected` / `superseded`; a written-once column never changes again (P5) | `approved` → `rejected`, rewriting or re-opening `effective_to`, adding a note later, `accepted` → `superseded`: all `23001`, as the application and as the owner |
| Triggers `regular_price_records_no_delete`, `_no_truncate` (function `pricing.reject_mutation()`) | Never deleted (P6) | Owner `DELETE` and `TRUNCATE … CASCADE` refused `23001`; the application gets `42501` first |

"Strictly increasing starts" (D 2.1): the database guarantees non-empty, non-overlapping periods. That the newest record has the latest start follows from P7 and `effective_from = max(now, previous + 1 ms)` (D 9), which is the domain's job (5).

The trigger function, as measured (the special-record function in 3.4 follows the same pattern):

```sql
CREATE FUNCTION "pricing"."regular_price_records_guard_update"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW."id", NEW."market_id", NEW."tenant_id", NEW."series_id", NEW."amount_minor", NEW."currency",
      NEW."tax_inclusive", NEW."submitted_at", NEW."submitted_by_account_id", NEW."anchor_record_id",
      NEW."anchor_amount_minor", NEW."hold_direction")
     IS DISTINCT FROM
     (OLD."id", OLD."market_id", OLD."tenant_id", OLD."series_id", OLD."amount_minor", OLD."currency",
      OLD."tax_inclusive", OLD."submitted_at", OLD."submitted_by_account_id", OLD."anchor_record_id",
      OLD."anchor_amount_minor", OLD."hold_direction") THEN
    RAISE EXCEPTION 'pricing.regular_price_records: record content is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'pending-review' AND NEW."status" IN ('approved', 'rejected', 'superseded')) THEN
    RAISE EXCEPTION 'pricing.regular_price_records: status % -> % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD."effective_from" IS NOT NULL AND NEW."effective_from" IS DISTINCT FROM OLD."effective_from")
     OR (OLD."effective_to" IS NOT NULL AND NEW."effective_to" IS DISTINCT FROM OLD."effective_to")
     OR (OLD."decided_at" IS NOT NULL AND NEW."decided_at" IS DISTINCT FROM OLD."decided_at")
     OR (OLD."decided_by_account_id" IS NOT NULL AND NEW."decided_by_account_id" IS DISTINCT FROM OLD."decided_by_account_id")
     OR (OLD."decision_reason_code" IS NOT NULL AND NEW."decision_reason_code" IS DISTINCT FROM OLD."decision_reason_code")
     OR (OLD."decision_note" IS NOT NULL AND NEW."decision_note" IS DISTINCT FROM OLD."decision_note")
     OR (OLD."superseded_at" IS NOT NULL AND NEW."superseded_at" IS DISTINCT FROM OLD."superseded_at")
     OR (OLD."superseded_by_record_id" IS NOT NULL AND NEW."superseded_by_record_id" IS DISTINCT FROM OLD."superseded_by_record_id")
     OR (OLD."supersede_cause" IS NOT NULL AND NEW."supersede_cause" IS DISTINCT FROM OLD."supersede_cause") THEN
    RAISE EXCEPTION 'pricing.regular_price_records: a written-once column cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = OLD."status"
     AND (NEW."effective_from", NEW."decided_at", NEW."decided_by_account_id", NEW."decision_reason_code",
          NEW."decision_note", NEW."superseded_at", NEW."superseded_by_record_id", NEW."supersede_cause")
         IS DISTINCT FROM
         (OLD."effective_from", OLD."decided_at", OLD."decided_by_account_id", OLD."decision_reason_code",
          OLD."decision_note", OLD."superseded_at", OLD."superseded_by_record_id", OLD."supersede_cause") THEN
    RAISE EXCEPTION 'pricing.regular_price_records: decision columns change only with the status' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
```

`effective_to` is the only column that may be written while the status stays the same (closing an `accepted` or `approved` period). The CHECK allows it only next to an `effective_from`.

### 3.4 `pricing.special_price_records` (slice 5; D 2.1, 3.2, 4.3)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; unique `(market_id, id)` as the markers' FK target (C3) |
| `series_id` | `uuid` | no | FK `special_price_records_series_id_fkey` `(market_id, series_id, currency)` → series (P2) |
| `amount_minor`, `currency`, `tax_inclusive` | as 3.3 | no | |
| `starts_at`, `ends_at` | `timestamptz(6)` | no | The window as UTC instants (brief s5). CHECK `special_price_records_window_check`: `ends_at > starts_at AND starts_at >= submitted_at` (D 3.2: no start in the past; a window always ends) |
| `zone` | `text` | no | The seller's IANA zone at write time, stored on the record (Ali: a later zone change never moves a window). CHECK shape `^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$`, at most 64 characters; validity against tzdb is the domain's |
| `regular_record_id`, `regular_amount_minor` | `uuid`, `bigint` | no | The regular record in effect at submission and its amount (D 2.1). FK `special_price_records_regular_record_id_fkey` → `regular_price_records (market_id, series_id, id)` (P3). CHECK `special_price_records_amount_minor_check`: `0 < amount_minor < regular_amount_minor` (special below regular, AC 14) |
| `anchor_record_id`, `anchor_amount_minor` | `uuid`, `bigint` | no | The anchor of D 2.4 the special was also measured against (Hassan finding 1; D 4.3). FK `special_price_records_anchor_record_id_fkey`. The special is not required to be below the anchor (only held, D 4.3), so no amount CHECK beyond P1 |
| `status` | `text` | no | CHECK `accepted`, `pending-review`, `approved`, `rejected`, `superseded`, `withdrawn` |
| `submitted_at`, `submitted_by_account_id` | | no | |
| `effective_from` | `timestamptz(6)` | yes | `starts_at` when accepted; `max(starts_at, approval instant)` when approved (D 3.2). CHECK: NOT NULL if and only if `accepted`, `approved` or `withdrawn`; `starts_at <= effective_from < ends_at` (approval after the end is refused, D 3.2) |
| `decided_at`, `decided_by_account_id`, `decision_reason_code`, `decision_note` | as 3.3 | yes | Required for `approved` and `rejected`; absent for `accepted`, `pending-review`, `superseded`; either for `withdrawn` (a withdrawn special may have been approved). `special_price_records_decider_check` as 3.3 (H4) |
| `superseded_at`, `superseded_by_record_id`, `supersede_cause` | as 3.3 | yes | As 3.3 |
| `withdrawn_at` | `timestamptz(6)` | yes | The instant the special stops: now, or the replacement's start (D 3.2). It may lie in the future. CHECK: set if and only if `withdrawn`; `>= submitted_at` |
| `withdrawn_by_account_id` | `uuid` | yes | Set if and only if the cause is `seller` or `replaced` |
| `withdraw_cause` | `text` | yes | CHECK `seller`, `replaced`, `offer-removed`, `variant-removed` (proposed names, 11.2 M6) |

**Effective period.** `[effective_from, least(ends_at, withdrawn_at))`. When a special is cancelled before it starts (`withdrawn_at < effective_from`) the period is empty: `GREATEST(effective_from, …)` makes it `[x, x)` instead of an invalid range (measured: "cancel, then a new special over the same window" works).

| Constraint | Invariant (D) | Measured |
|---|---|---|
| `special_price_records_effective_period_excl`: `EXCLUDE USING gist (market_id WITH =, series_id WITH =, tstzrange(effective_from, GREATEST(effective_from, LEAST(ends_at, withdrawn_at)), '[)') WITH &&) WHERE (status IN ('accepted', 'approved', 'withdrawn'))` | At most one special in effect at any instant (D 4.1 step 3 "at most one exists, by invariant"). It holds whatever the owner answers to Q3, unless the answer is "overlapping specials", which would drop this constraint | Overlap refused `23P01`; replacement at the boundary (withdraw S1 at S2's start, then insert S2) accepted |
| `special_price_records_market_id_series_id_pending_key`: unique `(market_id, series_id) WHERE status = 'pending-review'` | At most one pending special per series (D 2.1) | Second pending refused |
| Trigger `special_price_records_write_once` (function `pricing.special_price_records_guard_update()`; same pattern as 3.3) | Content immutable (window and zone included: "editing a window" is forbidden, D 3.2); status moves only `pending-review` → `approved` / `rejected` / `superseded` and `accepted` / `approved` → `withdrawn` | `withdrawn` → `accepted` refused `23001` |
| `special_price_records_no_delete`, `_no_truncate` | P6 | As 3.3 |

**PD2 as written cannot be one partial unique index.** "At most one special that is not in a final state" (D 2.1, Q3) would need "ended", which is derived and not stored (D 3.2), so a special that ended naturally would block every later special. It would also refuse the legal pair "one accepted special in effect plus one pending replacement" (D 3.2 row 2). I therefore map PD2 to the two constraints above: one pending special, plus no overlap among specials in effect. Mohammad confirms (11.2 M4).

**`withdrawn` with a future `withdrawn_at`.** D 3.2 sets status `withdrawn` at once with `withdrawnAt` = the replacement's start, which may be in the future. D 4.1 steps 3 and 5 would then ignore the record before that instant, and the job of D 11 would never announce it. The physical model counts a `withdrawn` record as in effect until `withdrawn_at`: the `EXCLUDE` covers it, and the batch read (6.1, Q3) includes `withdrawn` with `withdrawn_at > t`. D 4.1 and D 11 should say the same (11.2 M4).

### 3.5 `pricing.special_price_boundaries` (slice 5; PD6, D 11)

`special_record_id uuid`, `boundary text` CHECK `start`, `end`, `marked_at timestamptz(6)`. PK `special_price_boundaries_pkey (market_id, special_record_id, boundary)` (PD6). FK `special_price_boundaries_special_record_id_fkey` `(market_id, special_record_id)` → `special_price_records (market_id, id)`. Insert-only.

The job writes the marker **first** in its unit, with `createMany({ skipDuplicates: true })`. A count of 0 means another run already published that boundary, so the unit ends without a version bump or an event. Otherwise it raises the series version and appends the event (D 11). A concurrent run is therefore a no-op, not an error.

### 3.6 `pricing.retired_offers` and `pricing.retired_variants` (slice 1; PD7, M3, Hassan finding 3)

| Table | Key | Other columns |
|---|---|---|
| `retired_offers` | PK `(market_id, offer_id)` | `retired_at timestamptz(6)`, `cause_event_id uuid` (catalog's event id, for tracing) |
| `retired_variants` | PK `(market_id, product_id, variant_id)` | as above |

- A handler records the tombstone even when no series exists (D 6.4) with `createMany({ skipDuplicates: true })`, so a redelivery is a no-op on top of the inbox.
- **The Variant tombstone is keyed by `(product_id, variant_id)`, not "(Offer, Variant)" (D 2.1, 5.2).** `catalog.variant-removed.v1` carries `productId` and `variantId` and no Offer id (D 6.1). It is sent at every retirement, a draft save included, so a priced `proposed` Variant gets its tombstone. Pricing cannot list the Offers of a product that have no series yet. Series creation checks both tombstones: `(offer_id)` and `(product_id, variant_id)`, with `product_id` taken from the `offerSellUnits` answer. Same guarantee, different key. Mohammad confirms (11.2 M5).
- The re-key (3.2.1) also writes `(fromProductId, from)` Variant tombstones, so no series is created under a moved Offer's old key, even from a stale (advisory) `offerSellUnits` answer.
- Never removed: pricing does not subscribe to Variant-added, and a removed Variant id never returns (catalog G2 M-1).
- Insert-only. Two point lookups by primary key in the creating unit; no other index.

### 3.7 `pricing.cost_series` and `pricing.cost_records` (slice 3; D 2.1, 6.5)

`cost_series` has the columns, keys, CHECKs and grants of `price_series` (3.2) under its own names: `cost_series_market_id_offer_id_variant_id_key`, `cost_series_market_id_id_currency_key`, `cost_series_market_id_product_id_variant_id_idx`. It is a separate root with its own `version` (D 2.3). The retirement handlers retire it too, and the re-key moves it with the same rules and guard trigger (3.2.1; D 6.4).

`cost_records`:

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `cost_series_id` | `uuid` | no | FK `cost_records_cost_series_id_fkey` `(market_id, cost_series_id, currency)` → `cost_series (market_id, id, currency)` (P2) |
| `kind` | `text` | no | CHECK `amount`, `cleared` (Q7: Cost is optional) |
| `amount_minor` | `bigint` | yes | CHECK: NOT NULL if and only if `kind = 'amount'`; range P1. **Cost: never leaves the module** (D 6.5) |
| `currency` | `char(3)` | no | The series currency, also on `cleared` rows, so the foreign key is always checked (a NULL currency would switch a composite FK off) |
| `submitted_at` | `timestamptz(6)` | no | |
| `submitted_by_account_id` | `uuid` | no | Who wrote it (Hassan finding 4: the audit row has no amount, H2, so the actor is recorded here). Acting-as: P8 |

- **Append-only.** `SELECT`, `INSERT` only; trigger `cost_records_no_update_delete` (`BEFORE UPDATE OR DELETE`) and `cost_records_no_truncate` answer `23001` to the owner (measured for `UPDATE` as the application: `42501`).
- Current Cost of a series = the latest row. Index `cost_records_market_id_cost_series_id_submitted_at_id_idx`, read newest first per series. A page of the seller's Offer list reads the rows of at most that page's series in one statement. Cost changes are rare, so the read returns few rows per series. Not measured at volume; revisit with the slice 3 plans (10).
- No column of a price table holds Cost, and no Cost table has a relation to a price table. A query on price tables cannot return Cost by structure, as `password_credentials` is kept apart from `accounts` (ID-data 3.3).

### 3.8 `pricing.write_refusal_throttles` (proposed; slice 1 if adopted; 11.2 M7)

D 5.2 and H3 cap the `pricing.offer-write-refused` audit rows at 1 per (actor, Offer) per minute. They must be written on the same path for every cause (Hassan finding 2), but D does not say where the counter lives. Proposal, the pattern of identity's `sign_in_throttles` (ID-data 3.5):

| Column | Type | Notes |
|---|---|---|
| `actor_account_id`, `offer_id` | `uuid` | PK `(market_id, actor_account_id, offer_id)` |
| `window_started_at` | `timestamptz(6)` | |

- In the refusal's own short unit: `updateMany` where the key matches and `window_started_at <= now − 60 s`, setting `window_started_at = now`. If no row changed, `createMany({ skipDuplicates: true })`. If either changed a row, write the audit row; otherwise write nothing.
- Purge rows older than one hour (hourly job; no index needed at this size).
- Grants `SELECT, INSERT, UPDATE (window_started_at), DELETE`.
- Not personal beyond the account id, which the audit row holds anyway.
- Alternative: a Redis counter (ADR-0004 decision 1 allows Redis for rate limiting). Rejected here: a second store on a security path for one counter.

## 4. What is never stored

| Never in the `pricing` schema | Instead |
|---|---|
| A computed "effective price", a "current" pointer, or an "ended" status | Derived at read time from the records and `Clock` (D 4.1); validity never depends on the job (D 11) |
| Cost in a price table, an outbox row, a marker, a tombstone or an audit before/after value | `cost_records` only (D 6.5; H2) |
| An amount in an event payload | Ids, enums and instants only (D 6.3) |
| Tax amounts, rates or a GST split | `tax` computes from the frozen price and `tax_inclusive` (D 4.5) |
| Order or cart data, or which record an order froze | `ordering` keeps the record id (ADR-0007 decision 8) |
| The Market's timezone as a stand-in for a missing seller zone | The write is refused (Ali; D 4.3) |
| The acting-as account (until SEL-08) | Such writes are refused (Hassan finding 6; P8) |
| Offer, Variant, product or seller names | Composed through the catalog and sellers facades (D 7) |
| Customer data of any kind | None reaches `pricing` |

## 5. Invariants the database does not carry

| Invariant | Why not a constraint | Enforced by |
|---|---|---|
| Currency equals the Market's currency; amount ≤ the Market maximum (Q10) | Configuration, not schema | `PriceAmount` and `PriceLimits` (D 4.4); P2 keeps a series single-currency |
| Who may write, ownership, Variant and Market of the Offer (D 5.2) | Cross-module (catalog), and the actor | Application layer, through `offerSellUnits` (CF1; advisory, ADR-0025 decision 1) |
| The jump hold and the anchor choice (D 2.4, 4.2, 4.3); "the first price is never held" | Needs policy (T, W) and history | `JumpPolicy`, `PriceSeries`; the CHECKs only keep a held row self-consistent |
| `effective_from = max(now, previous + 1 ms)`; starts strictly increasing in submission order | Needs the previous row | `PriceSeries` (D 9); the `EXCLUDE` and `effective_to > effective_from` back it |
| A special is below the regular price **in effect at approval** and at read time (D 3.2, 4.1 step 4) | Cross-row and time-dependent | `approveHold`, `EffectivePriceResolver`; the row CHECK holds the submission-time comparison |
| No record is written for a retired series | Cross-row | `PriceSeries`; the retirement raises `version`, so a concurrent writer is stale |
| No series is created after a tombstone (Hassan finding 3) | Absence of a row in another table | The creating unit reads both tombstones; the creating unit and the handlers run `serializable` (5.1) |
| Which transition follows which | CHECKs carry value sets and columns; the triggers carry only "content is immutable, a column is written once, a final status is final" | The aggregates (D 3) |
| `superseded_by_record_id` names a later record of the same series | Written before its target exists (3.3) | `PriceSeries` |
| The copies on `price_series` (`product_id`, `seller_id`) equal catalog's | Cross-module | Read once at creation; `product_id` updated by the CF4 re-key; never used for ownership (D 2.3) |
| A re-key moves a series only to a free, untombstoned (Offer, `to`) named once | Cross-row, needs the event's mapping | The re-key handler (3.2.1); the unique key and the guard trigger back it |
| Cost never leaves the module | Behaviour | D 6.5 (types, routes, boundary rule, tests); grants (7) |
| H3's one audit row per (actor, Offer) per minute | A rate, not a row rule | 3.8, if adopted |

### 5.1 Serializable units (P10; M3)

The tombstone rule is a write skew. Creator: read the tombstones (none), then insert a series. Handler: insert the tombstone, then retire the Offer's series (none yet). Under READ COMMITTED both commit, leaving **a live series after its tombstone (measured)**. Under SERIALIZABLE for both units, PostgreSQL refuses one with `40001`. The UnitOfWork runs it again (P 3.1 row 7), and the retried creator now sees the tombstone and answers `pricing.offer-not-found` (measured: 0 live series).

So `isolation: 'serializable'` is declared by:
- every unit that **inserts** a `price_series` or `cost_series` row (the first price, first special or first Cost of a key);
- `pricing.retire-series-for-removed-offer` and `pricing.retire-series-for-removed-variant`;
- `pricing.rekey-series-for-moved-offer` (P1; 3.2.1): the same skew with a creator under the old key (closed by the `(fromProductId, from)` tombstone) or the new key (closed by the unique key and its read of the target).

Writes to an existing series stay READ COMMITTED: retirement raises the version, so they become stale.

The serializable reads in these units are point lookups (two tombstone primary keys) and one index range per handler, so predicate locks stay narrow. The retry rate is measured in the slice 1 integration test. D 9 needs one line for this (11.2 M3).

## 6. Access paths

Volume assumed: 10 × the first-year upper bound of section 9. AU had 100,000 series with 12 regular records each (1.3 million rows, 1,203 pending) and 100,000 specials. ZZ (JPY) had 20,000 series. Measured on PostgreSQL 16.15, as the application login, warm cache unless stated (10).

### 6.1 The 200-key batch read (PD4, M2; D 6.2)

The facade answers 1 to 200 `(offerId, variantId)` keys (D 6.2). Three statements, one per table, **always three whatever the number of keys**: no N+1. They run in one read-only unit. All are plain Prisma `findMany` with `market_id` at the top level (P 4.1). No raw SQL.

| # | Statement (Prisma shape) | Index | Measured |
|---|---|---|---|
| Q1 | `price_series` where `marketId`, `offerId in [≤200]`; select `id, offerId, variantId, retiredAt`; the pairs are matched in memory | `price_series_market_id_offer_id_variant_id_key` (leading columns) | Index scan, 195 rows, 1.4 to 3.2 ms execution, 0.6 to 0.8 ms planning, 798 buffers |
| Q2 | `regular_price_records` where `marketId`, `seriesId in [Q1 ids]`, `status in [accepted, approved]`, `effectiveFrom <= t`, `OR [{effectiveTo: null}, {effectiveTo: {gt: t}}]` | **`regular_price_records_market_id_series_id_effective_to_live_idx`**: `(market_id, series_id, effective_to) WHERE status IN ('accepted', 'approved')` | BitmapOr of the two arms (`IS NULL` and `> t`), both index conditions. 12 records per series: 2.4 to 3.7 ms. 60 records per series: **1.6 to 1.9 ms, 1,205 buffers** |
| Q3 | `special_price_records` where `marketId`, `seriesId in […]`, `status in [accepted, approved, withdrawn]`, `effectiveFrom <= t`, `endsAt > t`, `OR [{withdrawnAt: null}, {withdrawnAt: {gt: t}}]` | **`special_price_records_market_id_series_id_ends_at_live_idx`**: `(market_id, series_id, ends_at) WHERE status IN ('accepted', 'approved', 'withdrawn')` | Index scan, 0.86 to 1.4 ms |

`t` is `pricing`'s `Clock.now()`, passed as a parameter (D 6.2: the caller supplies no instant). The no-overlap constraints guarantee at most one row per series from Q2 and from Q3. The resolver (D 4.1) then combines them, keeping the read-time guard "special < regular". The whole read measured 4 to 10 ms of database time in this setup, planning included. Prisma's own overhead and the three round trips were not measured (no Prisma in this environment, 10).

**Options measured and rejected**

| Option | Result | Verdict |
|---|---|---|
| Q1 as `OR` of 200 `(offerId AND variantId)` pairs (the exact form) | BitmapOr of 200 index scans: 3.4 to 3.8 ms to execute, but **9.7 to 10.8 ms to plan** | Rejected: planning dominates. Q1's in-memory match costs at most the extra Variants of the same Offers |
| Q1 as `offerId in […] AND variantId in […]` | The planner misestimated and chose a parallel sequential scan: 12.1 to 12.3 ms | Rejected |
| Q2 without the live index (the planner uses `(market_id, series_id, id)` and filters) | 12 records per series: 3.0 ms, comparable. **60 records per series: 5.3 to 7.2 ms, 12,607 buffers**. Its cost grows with every record of the series; the live index's does not | Keep the live index: 80 MB at 1.3 M rows |
| Q3 through the `EXCLUDE` gist index only | 5.5 ms | Keep the live index: 6 MB |
| Range containment on the gist index (`tstzrange(…) @> t`) | Not expressible in Prisma; needs raw SQL (P 4.2) | Not used |
| One statement with `include` of the records | Prisma's default relation strategy issues the same three statements; the join strategy's status in Prisma 7.10 was not checked | No gain expected; not pursued |

**Isolation of the read.** A read-only unit opens no transaction (ADR-0025 decision 1), so each of the three statements sees its own snapshot and the answer is advisory; `ordering` re-checks at purchase (D 6.2). Every write use case changes one stream of one series (regular, special, or retirement), so a mixed read shows a state that was true for each stream within the read's few milliseconds. The resolver's read-time guard keeps the buyer at or below the regular price (D 4.1 step 4), and `ordering` freezes a real record id. Accepted as is. A read-only `REPEATABLE READ` option on the UnitOfWork would give one snapshot without serialisation failures; it is a platform change and not needed now.

**Proposed facade wording** (D 6.2 says "one query per call"): "one statement per table, three per call whatever the number of keys".

### 6.2 Other queries

| Query (D section) | Statement | Index |
|---|---|---|
| Series by key for a write (5.2) | Unique key | `price_series_market_id_offer_id_variant_id_key` |
| Tombstone check in the creating unit (5.2, 3.6) | Two primary-key lookups | `retired_offers_pkey`, `retired_variants_pkey` |
| Aggregate load for a write: a **bounded working set**, not the whole history. The current regular record, the record at `now − W` (anchor (a), D 2.4), the latest approved record (anchor (b)), the pending regular, current or scheduled specials, the pending special | Same predicate as Q2 at `t = now` and at `t = now − W`; the pending indexes; Q3 with `endsAt > now` | Live indexes; pending keys; **`regular_price_records_market_id_series_id_effective_from_approved_idx`**: `(market_id, series_id, effective_from) WHERE status = 'approved'` (slice 4) for "latest approved". Approvals are a small share of records (holds were 1% in the test data), so it is small. Not measured: there were no approved rows in the volume test |
| Review queue, oldest first (PD5; D 5.2) | Per table, `status = 'pending-review'`, order `(submitted_at, id)`, keyset after the last `(submitted_at, id)`, page of 50; the two streams are merged in memory | `regular_price_records_market_id_submitted_at_id_pending_idx`, `special_price_records_market_id_submitted_at_id_pending_idx`. Measured: page 1 0.06 to 0.11 ms, next page 0.24 to 0.28 ms |
| One held record with its anchor (D 5.2) | Primary key, then the anchor by primary key | PKs |
| Seller panel: price, special and hold status for a page of Offers (D 5.2) | Q1 to Q3 plus the pending records by `(market_id, series_id)` and the latest decision | Pending keys; `(market_id, series_id, id)` read newest first |
| Retirement handlers (D 6.4) | Series of an Offer, or of a (product, Variant); then their pending and live records | Series unique key; `price_series_market_id_product_id_variant_id_idx`; pending keys; live indexes |
| Re-key handler (3.2.1) | Series of the Offer; target keys (Offer, `to`); tombstones by primary key | Leading `(market_id, offer_id)` of the series unique key; `retired_variants_pkey`. No new index |
| Boundary job, starts (D 11) | Specials with `effective_from` in `(now − H, now]`, no `start` marker (Prisma `none` relation filter = `NOT EXISTS`), `ORDER BY effective_from LIMIT 100` | `special_price_records_market_id_effective_from_live_idx` + marker PK |
| Boundary job, natural ends | `status IN (accepted, approved)`, `ends_at` in `(now − H, now]`, no `end` marker | `special_price_records_market_id_ends_at_live_idx` |
| Cost of a page of series (D 5.2) | `cost_records` by `cost_series_id in […]`, newest first | `cost_records_market_id_cost_series_id_submitted_at_id_idx` |

**Job horizon H** (proposal: 7 days). Measured at steady state, with 91,048 of 91,058 past starts already marked: with H the discovery query took **11 to 13 ms** (3,583 probes). Without H it took **229 to 238 ms** (91,058 probes) and grows with every special ever created, every minute. A boundary older than H with no marker is not published. Prices are still correct (D 11: the job only tells consumers), and a daily check counts such rows and alerts. This adds a value and an alert to D 11 (11.2 M4).

**Deliberately not added**
- `(market_id, seller_id)` on series.
- An index on `superseded_by_record_id`.
- Indexes on the referencing side of the in-schema foreign keys: parents are never deleted, so RESTRICT checks never run.
- A covering `INCLUDE` on the live indexes: the heap fetches are about 1 per key.
- A `(market_id, offer_id)` index on tombstones: the PK leads with it.
- Any index on `inbox` until its prune job exists (ID-data 3.8).

## 7. Grants

Under platform.md 10.2: hand-written in the `migration.sql` that creates the table, in the block `-- Grants (database-designer): docs/design/data/pricing.md section 7`, to `mondapac_app` only, mirrored by `REVOKE` in `down.sql` before any `DROP`. `GRANT USAGE ON SCHEMA "pricing"` is in the first pricing migration. Trigger functions get no grant. The Privileges lines:

| Table | Privileges of `mondapac_app` | Reason |
|---|---|---|
| `pricing.outbox` | `SELECT, INSERT, UPDATE (published_at)` | PM2 |
| `pricing.inbox` | `SELECT, INSERT` | `DELETE` arrives with the prune job |
| `pricing.price_series`, `pricing.cost_series` | `SELECT, INSERT, UPDATE (retired_at, retire_cause, version)`; from P1 also `UPDATE (variant_id, product_id, rekeyed_from_product_id, rekeyed_from_variant_id)` (8.1 row 7) | Offer, seller and currency never change; `variant_id` and `product_id` only through the re-key, under the guard trigger (3.2.1); no `DELETE` |
| `pricing.regular_price_records` | `SELECT, INSERT, UPDATE (status, effective_from, effective_to, decided_at, decided_by_account_id, decision_reason_code, decision_note, superseded_at, superseded_by_record_id, supersede_cause)` | PD3: status, decision and period-end columns only; no `DELETE` |
| `pricing.special_price_records` | `SELECT, INSERT, UPDATE (status, effective_from, decided_at, decided_by_account_id, decision_reason_code, decision_note, superseded_at, superseded_by_record_id, supersede_cause, withdrawn_at, withdrawn_by_account_id, withdraw_cause)` | PD3; the window and the zone are not updatable |
| `pricing.special_price_boundaries`, `pricing.retired_offers`, `pricing.retired_variants`, `pricing.cost_records` | `SELECT, INSERT` | Append-only |
| `pricing.write_refusal_throttles` (if adopted) | `SELECT, INSERT, UPDATE (window_started_at), DELETE` | Counters with purge |

Column-level `UPDATE` follows the four conditions of platform.md 10.2: it replaces the table-level `UPDATE`; it covers exactly the named columns (no `@updatedAt` column exists); it never stands next to a table-level `UPDATE`; and the test of 10.4 proves that every other column refuses with `42501`, driven by the expected map. Measured: content columns, `market_id`, keys, the outbox `payload`, `DELETE` and `TRUNCATE` all refused `42501` for the application.

**Keeping Cost readable only by what needs it** (D 6.5; my recommendation, Hassan decides, 11.2 H-D1):

| Option | What the database enforces | Cost |
|---|---|---|
| **A (recommended)** Same group `mondapac_app`. Cost lives only in its two tables, which no price query touches, and the D 6.5 boundary rule says only `infrastructure/cost/` references the `PricingCost*` models | Structure: no price statement can return Cost; append-only Cost history. Not: a separate privilege. The api and the worker share the group (platform.md 10.1) | None. When Kazem gives the worker its own login and group (platform.md 10.1 allows it), `cost_records` goes to the api group only: the worker only retires `cost_series` and never reads Cost |
| B A second group (`mondapac_cost`) and login, used by a second Prisma client in `infrastructure/cost/` only; `mondapac_app` gets nothing on `cost_records` | A bug or injection in any other repository cannot read Cost | A new role decision (platform.md 10.1: Ali), bootstrap and self-check changes (Kazem), a second pool and guard instance, and Cost units cannot share a transaction with the audit writer unless that group can also insert into `platform.audit_log` |

## 8. Migration plan

### 8.1 Order (one migration PR open at a time, `docs/process/parallel-tracks.md` rule 6; Phase 4 shares this with inventory and cart: announce on the board)

| # | Slice | Migration | Contains |
|---|---|---|---|
| 1 | 1 | `platform_btree_gist` | `CREATE EXTENSION "btree_gist" WITH SCHEMA "public";` only (8.3) |
| 2 | 1 | `pricing_series_regular` | `CREATE SCHEMA "pricing"`, schema `USAGE`; `outbox`, `inbox`, `price_series`, `regular_price_records` (with its `EXCLUDE`, the pending key, the two triggers and their functions), `retired_offers`, `retired_variants`; `write_refusal_throttles` if M7 is adopted; grants |
| 3 | 2 | `pricing_effective_read_index` | `regular_price_records_market_id_series_id_effective_to_live_idx` (it arrives with its reader) |
| 4 | 3 | `pricing_cost` | `cost_series`, `cost_records`, triggers, grants |
| 5 | 4 | `pricing_price_hold_indexes` | The regular queue index and the "latest approved" index |
| 6 | 5 | `pricing_special_prices` | `special_price_records` (all its constraints, indexes, triggers), `special_price_boundaries`, grants |
| — | 6 (P1) | None expected | VER-09's admin history list brings its own index with its reader |
| 7 | P1, before catalog's CAT-45 slice | `pricing_series_rekey` | `ADD COLUMN rekeyed_from_product_id`, `rekeyed_from_variant_id` (nullable, no default) with their CHECK on both series tables; `price_series_guard_update` on both (function and triggers, 3.2.1); `GRANT UPDATE (variant_id, product_id, rekeyed_from_product_id, rekeyed_from_variant_id)` on both. Metadata only, no lock that matters. `down.sql` **revokes the grant first**, then drops the triggers, the function, the CHECKs and the columns (Hassan's condition on M8 (a)). The trigger tests of 3.2.1 ship in the same PR |

Migrations 1 and 2 are in one PR (slice 1), as identity's slice 3 carried two. If the retirement handlers ship later than slice 1 (11.2 M5), the tombstone tables still land in migration 2: the creating unit reads them from the first price on.

### 8.2 Reversibility and safety

- Every `down.sql` mirrors its up in reverse: `REVOKE`s first, then triggers, then tables (children before parents), then functions, then (migration 2) `REVOKE USAGE ON SCHEMA`. The empty schema stays, as in ID-data 8.2. No `IF EXISTS`. Measured: up, down, up on PostgreSQL 16.15 as a non-superuser owner, with the extension in place. After the down no relation or function is left in `pricing` and the schema carries no grant.
- `platform_btree_gist`'s down is `DROP EXTENSION "btree_gist";`. It fails while an `EXCLUDE` uses it, which is the right order: pricing's downs run first.
- All tables are new: no backfill and no lock that matters. Migrations 3 and 5 add indexes to tables that may hold rows in a deployed environment by then. If any deployed environment holds more than about 10⁵ rows in that table, the migration is hand-written as `CREATE INDEX CONCURRENTLY` alone in its file (it cannot run inside a transaction), with `SET lock_timeout = '5s'` before it. The PR checks how Prisma Migrate runs such a file (not measured here). Otherwise a plain `CREATE INDEX`.
- Later changes on live tables use expand/contract. A new CHECK is added `NOT VALID`, then `VALIDATE`. A new column is nullable without a default, which is metadata only. **A change of the `EXCLUDE` is drop-and-add, which takes an `ACCESS EXCLUSIVE` lock and rescans the table**: plan it as its own migration with `lock_timeout`, outside peak hours.
- The SEL-08 acting-as columns (P8) are metadata-only `ADD COLUMN`s plus `CREATE OR REPLACE` of both trigger functions, so the new columns join the immutable list.
- My sign-off per migration uses the checklist of platform.md 8 and the five review points of platform.md 10.2, plus: the hand-written block equals this document for that table, and the catalog tests below changed in the same PR.

### 8.3 `btree_gist`: who enables it

- **Why:** the `EXCLUDE` constraints compare `market_id` (varchar) and `series_id` (uuid) with `=` inside a GiST index. Without btree_gist there is no GiST operator class for them (ADR-0009 decision 2 names it).
- **Can a migration create it?** Yes. btree_gist is a *trusted* extension (PostgreSQL 13 and later), so the non-superuser migration role, which owns the database, may create it. Measured on 16.15 with a role of platform.md 10.1's shape. The application role needs no privilege on the extension's functions to insert into a table with the constraint (measured).
- **Schema:** `public`. The constraint binds the operator classes when it is created, so `search_path` at run time does not matter. Nothing is granted on `public` (platform.md 10.2 "Never").
- **Ownership.** Mojtaba designs it (this section); Hossein writes migration 1 in slice 1's PR. It is a database-wide object in a shared path (`prisma/migrations` order), so it is announced on the board. The first module that needs it creates it once; no other module creates it again. Kazem confirms that the extension is available and creatable by the migration role on the PostgreSQL 17 image of Compose and CI and on each Region Stack's managed PostgreSQL. Some managed services allow-list extensions by a server parameter, so this is a deploy-time check (11.2 K1).
- **No ADR needed:** ADR-0009 decision 2 already names btree_gist.

### 8.4 Prisma specifics

- `prisma/schema/pricing.prisma`, models named by P9, each `@@schema("pricing")`. `base.prisma` gains `"pricing"` in `schemas` (a shared file, in migration 2's PR).
- **Prisma expresses:** the tables and types (`BigInt`, `@db.Char(3)`, `@db.Timestamptz(6)`, `@db.Uuid`, `@db.VarChar(8)`, `@db.JsonB`); the primary and unique keys; the non-partial indexes; and the composite relations of P2 and P3 with `map:` names as in section 3. Relations referencing a three-column `@@unique`, and two relations sharing `market_id` and `series_id`, are standard Prisma, but **not measured here** (spike S1 below).
- **Hand-written**, appended under marked blocks as in platform.md 6: every CHECK; both `EXCLUDE` constraints; the partial indexes (`*_pending_key`, `*_live_idx`, `*_pending_idx`, `*_approved_idx`, `outbox_…_unpublished_idx`); the three trigger functions and eight triggers; the grants.
- **Catalog tests** (`pnpm test:db`, ID-data 8.4 option A, decided by Ali): the checked-in list of partial indexes gains this schema's. A second list compares `pg_get_constraintdef` of every exclusion constraint (`pg_constraint.contype = 'x'`). The privilege map gains section 7 with its column lists. "Every outbox has the same columns" (P 13) gains `pricing.outbox`.
- **Spike S1, in slice 1's PR (Hossein, with me):**
  - (a) Prisma 7.10's drift check against a database holding the extension, the `EXCLUDE` constraints and the expression GiST indexes. Identity measured that partial indexes are ignored; this case was not measured, and if they show up as drift the fallback is option B of ID-data 8.4.
  - (b) The composite relations of P2 and P3 generate exactly the FKs of section 3.
  - (c) The SQL Prisma sends for `in` lists and the `OR` of nullable comparisons in Q2 and Q3, with `EXPLAIN (ANALYZE, BUFFERS)` through the real client.
  - (d) `createMany({ skipDuplicates })` returns the inserted count (3.5, 3.6).

## 9. Volume, retention and jobs

**Assumption** (first year, Greater Brisbane, one Market): 10² to 10³ sellers; 10⁴ to 10⁵ priced (Offer, Variant) keys; on average one regular change per key per month; holds on about 1% of changes; specials at most one per key per month. The volume test used 10 × the upper bound for regular records (section 6).

| Table | Rows expected (year 1) | Measured size at test volume | Growth control |
|---|---|---|---|
| `price_series`, `cost_series` | 10⁴ to 10⁵ | 17 MB heap at 1.2 × 10⁵ | None needed |
| `regular_price_records` | Up to 1.2 × 10⁶ | 1.3 × 10⁶ rows: heap 185 MB; the `EXCLUDE` GiST index **136 MB** (the largest object); `(market_id, series_id, id)` 93 MB; live index 80 MB; PK 50 MB; about 420 bytes per row in all | Kept for ever (brief s9: complete and undeletable; VER-09). Revisit partitioning at 5 × 10⁷ rows. An exclusion constraint on a partitioned table needs the partition key inside it with `=`; check the PostgreSQL version's support then |
| `special_price_records` | Up to 10⁶ | 10⁵ rows: heap 23 MB, GiST 10 MB | Kept for ever |
| `special_price_boundaries` | 2 per accepted special | — | Kept |
| `cost_records` | 10⁴ to 10⁵ | Not measured | Kept |
| `retired_offers`, `retired_variants` | Deleted Offers and removed Variants: 10³ to 10⁴ | — | Kept (a tombstone must outlive the redelivery window; there is no Variant-added clearing) |
| `outbox` | About 1.5 events per change: up to 2 × 10⁶ | — | Platform pruning (P 6.5); decided at 10⁶ rows as for identity |
| `inbox` | catalog's `offer-deleted`, `variant-removed` (draft saves included) and, from P1, `offer-moved` events | — | Platform prune job (ID-data 3.8) |

- **Writes:** the bulk load of 1.3 × 10⁶ regular rows with all indexes took 101 s (about 78 µs per row in bulk). Single-row latency was not measured.
- **Update churn** is one or two updates per record in its life (period end; decision), each touching an indexed column, so they are not HOT. Autovacuum defaults are enough at this rate. `price_series` takes a version update per write and per boundary; it is the table to watch first.
- **Jobs (per hosted Market, `market_id` at the top level of every statement):**
  - `pricing.publish-special-price-boundaries`, every minute (D 11), with horizon H (6.2).
  - A daily check for unmarked boundaries older than H (alert only).
  - The hourly purge of `write_refusal_throttles`, if adopted.
  - Each job is safe to run twice and concurrently (markers, P 7).

## 10. Evidence

Measured on 2026-10-07 on PostgreSQL 16.15. The setup was a throwaway database and roles on a local cluster: a non-superuser owner with the attributes of platform.md 10.1, a `NOLOGIN` group, and one login member that ran the tests through `SET ROLE`. Everything was dropped afterwards. Every SQLSTATE quoted here was observed.

| Verified | Used in |
|---|---|
| `CREATE EXTENSION btree_gist` by the non-superuser owner; up, down, up of the full schema; nothing left after the down | 8.2, 8.3 |
| AU (AUD) and ZZ (JPY, exponent 0): JPY amounts (1500, 980) and AUD amounts stored by the same columns and CHECKs; `0`, `-5` and `2^53` refused, `2^53 − 1` within range; the same (Offer, Variant) key accepted in both Markets and refused twice in one; a record in another currency, or claiming the other Market, refused by the composite FK (`23503`); a malformed market code refused | P1, P2, 3.2 |
| Regular `EXCLUDE`: overlap refused (`23P01`); close-then-approve accepted; approve-then-close refused; pending rows outside the constraint | 3.3, P7, M1 |
| One pending regular and one pending special per series (`23505`); decider = submitter refused; reject without a reason refused; wrong hold direction refused; `effective_from` before submission refused; anchor from another series refused | 3.3, 3.4 |
| Write-once triggers: status moves outside D 3 refused, written-once columns frozen, content frozen, `DELETE` and `TRUNCATE … CASCADE` refused (`23001`), also for the owner | P5, P6 |
| Column grants: content columns, keys, `market_id`, outbox `payload`, `cost_records` updates, `DELETE`, `TRUNCATE` and `CREATE TEMP TABLE` all refused for the application (`42501`) | 7 |
| Special `EXCLUDE` with `GREATEST`/`LEAST`: overlap refused; replacement at the boundary accepted; cancel-before-start gives an empty range and frees the window; special ≥ regular, window ending before its start, start before submission, and a basis record of another series all refused | 3.4 |
| Markers: second marker refused. Cost: `cleared` with an amount refused; append-only | 3.5, 3.7 |
| Tombstone race: READ COMMITTED leaves a live series after the tombstone; SERIALIZABLE refuses the creator with `40001` and leaves none | 5.1, M3 |
| Plans and timings of section 6 (batch read in three shapes, with and without each live index, at 12 and 60 records per series; queue pages; job discovery with and without horizon at steady state); sizes of section 9 | 6, 9 |

**Not measured:** PostgreSQL 17 (Compose and CI); anything through Prisma (no `node_modules` in this environment; spike S1); the market guard; concurrency through the UnitOfWork, including the `40001` retry rate; the "latest approved" and Cost reads at volume; single-row insert latency; `CREATE INDEX CONCURRENTLY` under Prisma Migrate; the re-key (3.2.1), including the `40001` on a concurrent first price for the target key.

## 11. Answers and open points

### 11.1 Answers to Mohammad (D 15)

| # | Question | Answer |
|---|---|---|
| M1 | A stored period end with column-level `UPDATE` grants for V2 records (PD1, PD3) | **Yes.** `regular_price_records.effective_to`, NULL while open, written once in the unit that makes the next record effective, closing first (P7, measured). The `EXCLUDE` needs both bounds in the row, and the batch read needs them to stay a plain Prisma query. Grants: `UPDATE` on the status, decision, supersede and period-end columns only (7), backed by the write-once trigger (P5). Specials need no extra column: their end is `least(ends_at, withdrawn_at)`, both written once. A `DEFERRABLE INITIALLY DEFERRED` `EXCLUDE` would remove the order dependency, but its error would surface at `COMMIT`, away from the statement the repository maps. Not chosen |
| M2 | An index for the 200-key batch read (PD4) | **Three statements, two partial "live" indexes** (6.1). Measured 4 to 10 ms of database time for 200 keys at 10 × year-1 volume, flat as history grows. The `OR`-of-pairs form is rejected: 10 ms of planning |
| M3 | Storage of retirement tombstones (PD7) | **Two insert-only tables:** `retired_offers (market_id, offer_id)` and `retired_variants (market_id, product_id, variant_id)` (3.6). The creating unit and both handlers run `serializable`, which closes the measured write skew (5.1). D 9 should list those three units as serializable |

### 11.2 Still open

| # | Point | Who |
|---|---|---|
| M4 | (a) PD2 mapped to "one pending special + no overlap among specials in effect" instead of "one non-final special" (3.4). (b) A `withdrawn` special counts as in effect until `withdrawn_at`; D 4.1 steps 3 and 5 and D 11 to say so (3.4). (c) The boundary job's horizon H (proposal 7 days) and the daily alert for older unmarked boundaries (6.2) | Mohammad |
| M5 | (a) The Variant tombstone keyed by `(product_id, variant_id)`, as CF2 carries no Offer id (3.6). (b) Which slice ships the two retirement handlers: at the latest slice 1, because slice 1 creates series. (c) Can a removed Variant id ever come back? **Answered by catalog G2 (M-1, merged PR #54): never**; tombstones stay one-way | Mohammad; (c) closed |
| M8 | The CF4 re-key (3.2.1, 8.1 row 7): (a) widening `UPDATE` on both series tables to `variant_id`, `product_id` and the `rekeyed_from_*` columns, guarded by the trigger; (b) measure the re-key unit (100 pairs, 200 series), the `40001` on a concurrent target insert, and that no `EXCLUDE` is touched, in the P1 PR; (c) whether `variantMapping` is one-to-one and complete | (a) **Accepted by Hassan 2026-10-07 on conditions, all applied:** the High (mapping validated, D 6.4) and Medium changes (guard requires both ids to change; one writer by `pnpm boundaries`; owner role gets `23001`); `down.sql` revokes before dropping triggers; the trigger test in the P1 PR (3.2.1, 8.1). (b) Hossein with me, P1 PR. (c) **Closed by Ali 2026-10-07:** catalog G2 4.5 maps every non-retired Variant one-to-one to a distinct published target Variant, not necessarily all of them; at most 100 pairs (`catalog.maxVariantsPerProduct`); the retire branch stays as a backstop |
| M6 | Proposed value lists and limits: `supersede_cause` (`replaced`, `cancelled`, `offer-removed`, `variant-removed`), `withdraw_cause` (`seller`, `replaced`, `offer-removed`, `variant-removed`), `retire_cause`; `decision_note` at most 1,000 characters (Jafar for the wording with Q4); `currency` on the series tables (P2) | Mohammad |
| M7 | Where the H3 counter (1 audit row per actor and Offer per minute) lives: the proposed table 3.8, or something else | **Decided 2026-10-07** (Mohammad; security half Hassan): the PostgreSQL table of 3.8, updated in the same unit as the audit row, so the counter cannot advance without its row; Redis rejected. Added (Hassan, Medium: the Offer id comes from the caller): a per-actor cap of 20 rows a minute across Offers, then one `pricing.offer-write-refused.suppressed` summary row for that minute. The pricing write routes are under the general per-account rate limit (tested in slice 1). Follow-up for Mojtaba: the per-actor counter in 3.8, 7 and 8.1 (D 5.2, 8) |
| H-D1 | Cost isolation in the database: option A (structure plus code, recommended) or B (separate group, login and client) (7) | **Decided by Hassan 2026-10-07: option A**, with three conditions: (1) `pnpm boundaries` enforces in CI that only `infrastructure/cost/` uses `PricingCost*`; (2) when the worker gets its own group, its access to `cost_records` is revoked in the same PR; (3) move to option B if raw SQL, a reporting replica or an export ever reads the `pricing` schema (D 6.5) |
| K1 | btree_gist available and creatable by the migration role on the PostgreSQL 17 image (Compose, CI) and on each Region Stack's managed PostgreSQL (8.3) | Kazem |
| S1 | Spike S1 (8.4): Prisma drift with `EXCLUDE` and the extension; composite relations; the SQL of Q1 to Q3 through the real client; `skipDuplicates` counts | Hossein, with me, in slice 1's PR |

**Owner:** nothing new. Q1 to Q5 stay with Hadi (D 15). Q3's answer only matters here if the owner allows overlapping specials, which would drop the special `EXCLUDE` (3.4).

**Answers to Mojtaba (Mohammad, 2026-10-07; recorded in D 15).** M4: (a) accepted, PD2 = one pending special plus no overlap among specials in effect; (b) accepted, a `withdrawn` special is in effect until `withdrawn_at` (D 3.2, 4.1, 11 updated); (c) H = 7 days with the daily alert. M5: (a) accepted, Variant tombstone keyed by `(product_id, variant_id)`; (b) both retirement handlers ship in slice 1; (c) a dependency on catalog G2, now closed: catalog's merged G2 (PR #54, M-1) never reuses a Variant id. M6: all value lists, `decision_note` 1 to 1,000 characters and `currency` on the series tables accepted as proposed. The owner decided Q1 to Q5 on 2026-10-07; Q3 is one special at a time, so the special `EXCLUDE` stays. M7, H-D1, K1 and S1 remain open with the people named above.

**Hassan's review of this document (2026-10-07; approved with conditions, no Critical or High), recorded by Mohammad in D 6.5, 8, 13, 15 and 17.** H-D1 and M7 decided as in the table. Also: (Low) a `test:db` or integration test that `regular_amount_minor` and `anchor_amount_minor` equal the rows they reference; (Low) `$queryRaw` and `$executeRaw*` banned under `modules/pricing` by lint or `pnpm boundaries`, confirmed by spike S1; (Informational) the trigger functions stay `SECURITY INVOKER` (platform.md 10.8 self-check), and the contract snapshot test is mandatory because it is the only check of the outbox "no amount" rule. **Still open:** K1 (Kazem); S1 (Hossein with Mojtaba, now also confirming the raw-SQL ban); the per-actor counter in 3.8 (Mojtaba).

### 11.3 G2 verdict (2026-10-07)

Catalog G2 is merged (PR #54, 0bad228); its 9.7 and 18 accept CF1–CF4 as ruled and differ from the draft 25cbf3a only by additions this design already follows. **Ali (cto), final verdict: approve with conditions** (tier A): Hassan reviews every price or Cost write and every facade, event or response that carries Cost before it merges (ADR-0024); Kazem settles 8.3 (K1); Mojtaba signs off each migration; no UI slice before Reza's `ux.md` and the Figma-first design-system update (ADR-0017). Approvers: Mohammad (software-architect), Ali (cto), Mojtaba (database-designer), Hassan (security-tester). **Bagher (qc-release-manager), final check:** merges cleanly with main, touches only this module's files, no blocking open finding. Follow-up: Reza (ui-ux-designer) pending, UI condition.

## 12. Follow-up changes

This document changes no other file. After G2:

| File | Change | When |
|---|---|---|
| `docs/design/domain/pricing.md` | Done 2026-10-07, with P-1 (CF1 to CF4, re-key in D 6.4, PD8). Earlier: M3: serializable units in D 9; M4 (a) to (c) in D 2.1, 4.1, 11; M5 (a) in D 2.1, 5.2, 6.4; facade wording "three statements per call" (6.1) | With Mohammad's next revision |
| `docs/design/data/pricing.md` | This document, moved into the repo (D 1 names that path) | With the G2 PR; Mojtaba |
| `prisma/schema/base.prisma`, `pricing.prisma`; the migrations of 8.1 with `down.sql` | As specified; each needs my sign-off | Per slice; Hossein |
| Privilege map, partial-index list, exclusion-constraint list, outbox column test (`pnpm test:db`) | Section 7 and 8.4 | With each migration; Hossein |
| `docs/design/data/platform.md` | One line: btree_gist is enabled by `platform_btree_gist` (8.3) | After migration 1 merges; Mojtaba |
