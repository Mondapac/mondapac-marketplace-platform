# Physical data model — `inventory` schema (G2)

**Author:** Mojtaba (database-designer) — 2026-10-07
**Status:** G2 approved with conditions 2026-10-07 (Ali (cto) final verdict; Bagher (qc-release-manager) final check; 11.4). Reviewed by Ali (cto), Mohammad (software-architect), Hassan (security-tester). Each migration still needs Mojtaba's sign-off. Revised 2026-10-07 for catalog's request V-1 (the re-key of D 3.6; Ali's ruling), with catalog's names from its merged G2 (PR #54), which accepts D 13 as ruled (CAT 9.7, 18). Follow-up: Reza (ui-ux-designer) pending, UI condition. Open points: section 11.
**Ground truth:** `docs/design/domain/inventory.md` (Mohammad's G2 domain draft, cited as **D**, for example "D 4.2"), read in its revision with Ali's and Hassan's reviews applied (D 15); `docs/modules/inventory/brief.md` (G1 approved 2026-10-07; cited as "brief s5", "Q9", "AC 3"); `docs/design/domain/platform-persistence-and-events.md` (**P**); `docs/design/data/platform.md` section 10 (grants, cited as "platform.md 10.2"); `docs/design/data/identity.md` (**ID**; its conventions C1 to C11 are reused here by number); ADR-0001, 0003, 0004 (decisions 3 to 6), 0005, 0006, 0008 (decision 6), 0009, 0010 (decision 2), 0020 (decision 6), 0023, 0024 (decision 5).
**Prisma models:** `prisma/schema/inventory.prisma` (new). Nothing here exists yet. This document is the specification the migrations are written from. After G2 it moves to `docs/design/data/inventory.md`, the path D 1 names.

## 1. Scope and table list

This is the physical design of everything D asks the database to hold, slice by slice: constraints, access paths, the raw lock statement, grants and the migration plan. It does not change a business rule. Where the mapping needed a choice that D does not make, the choice is listed as a finding for Mohammad in 11.2.

ADR-0009 pattern: only **V4** is used, for the stock ledger. Nothing in `inventory` is revisioned or effective-dated, and nothing is snapshotted.

| Table | Holds (D 2.1) | ADR-0009 pattern | Created in (brief s11) |
|---|---|---|---|
| `inventory.inbox` | Handled deliveries (ADR-0006 decision 5) | None | Slice 1 |
| `inventory.seller_inventories` | `SellerInventory` root: the seller and the optional low-stock threshold | None | Slice 1 |
| `inventory.sources` | `InventorySource`, a child entity of `SellerInventory` | None | Slice 1 |
| `inventory.outbox` | Events of the module (ADR-0006 decision 2) | None: a queue | Slice 2 (the first event) |
| `inventory.stock_items` | `StockItem` | None: a live record; its history is the ledger | Slice 2 |
| `inventory.stock_movements` | `StockMovement` | **V4** append-only, kept without limit (brief s5) | Slice 2 |
| `inventory.availability_signals` | `AvailabilitySignal` | None | Slice 2 (stock writes recompute it, D 4.5) |
| `inventory.retirements` | Catalog retirement tombstones (D 3.5) | None | Slice 2 |
| `inventory.reservations` | `Reservation` root | None. Terminal rows are pruned (9) | Slice 4 |
| `inventory.reservation_lines` | `ReservationLine` | None | Slice 4 |
| `inventory.offer_purchase_limits` | `OfferPurchaseLimit` | None | Slice 4 |

Every table is Market-scoped: all of them carry `market_id` and `tenant_id`, so the guard of P 4 needs no exemption line. Slices 3 and 5 create no table. Slice 5 uses columns and CHECK values that slice 4 already creates, so no later slice changes a CHECK. Slice 6 (INV-02, P1) is deferred (D 12.3).

ER sketch. FK means a composite foreign key that leads with `market_id` (C3). A dotted line is a plain id with no FK (C4).

```
 seller_inventories (market_id, seller_id) UNIQUE
        |  1
        |  FK (market_id, seller_id)
        v  n
 sources ----------- UNIQUE (market_id, id, seller_id)
        |  1
        |  FK (market_id, source_id, seller_id)      ...... offer_id, variant_id: catalog ids
        v  n
 stock_items ------- UNIQUE (market_id, id, offer_id, variant_id)
        |  1                         |  1
        |  FK (market_id,            |  FK (market_id, stock_item_id, offer_id, variant_id)
        |  stock_item_id,            v  n
        |  offer_id, variant_id)   stock_movements (append-only ledger)
        v  n
 reservation_lines  n ---- FK (market_id, reservation_id, expires_at) ---- 1  reservations
                                                 ...... holder_account_id: identity account id
                                                 ...... checkout_ref, order_line_id: ordering ids
 offer_purchase_limits    (market_id, offer_id) UNIQUE         ...... offer_id, seller_id
 availability_signals     (market_id, offer_id, variant_id) UNIQUE
 retirements              (market_id, offer_id) | (market_id, offer_id, variant_id), partial UNIQUE
 outbox, inbox            as in every module (ID 3.1, 3.8)
```

## 2. Conventions used by every table

ID's conventions apply unchanged unless a row below says otherwise.

| # | Convention |
|---|---|
| C1 | As ID C1: `market_id varchar(8) NOT NULL` and `tenant_id text NOT NULL`, no default, each with the kernel-pattern CHECK (`<table>_market_id_check`, `<table>_tenant_id_check`). They are left out of the column tables below. `tenant_id` is in no key and no index |
| C2 | As ID C2: ids are `uuid` (UUIDv7 from the application); instants are `timestamptz(6)` from `Clock`; no column default, no `now()`, no sequence, no enum type. States and codes are lower-case kebab `text` with a CHECK (`active`, `in-stock`, `seller-set`), and the repository maps them to the domain's names (`ACTIVE`, `IN_STOCK`) |
| C3 | As ID C3, and wider: a child cannot belong to another Market than its parent, **and a copied column must equal its parent's value**. Where a row carries a copy for an access path or a constraint, the foreign key includes the copy, so the database proves the two are equal. The copies: source → seller inventory (`seller_id`); stock item → source (`seller_id`); line → stock item (`offer_id`, `variant_id`); line → reservation (`expires_at`); movement → stock item (`offer_id`, `variant_id`). All are `ON UPDATE RESTRICT`. The cost is one wider unique index on each parent (3.3, 3.4, 3.6) |
| C4 | As ID C4: ids owned by other modules are plain ids with no foreign key: `seller_id` (`identity`), `offer_id` and `variant_id` (`catalog`), `holder_account_id` and `actor_account_id` (`identity`), `checkout_ref` and `order_line_id` (`ordering`) |
| C5 | `version integer NOT NULL`, CHECK `>= 1`, and the insert writes 1 (P 10). It is on the roots of D 2.1: `seller_inventories`, `stock_items`, `reservations`, `offer_purchase_limits`, `availability_signals`. It is not on `sources` (a source change raises `seller_inventories.version`, D 2.3), on `reservation_lines` (a line change raises `reservations.version`), on the ledger, on `retirements`, on `outbox` or on `inbox`. A reservation does **not** raise `stock_items.version` (D 4.5) |
| C6 | Quantities are `integer` (Q6). A CHECK carries only rules that hold in every Market (`> 0`, `>= 0`) and the fixed bound D sets (the threshold's 0 to 99, Hassan finding 9). The line ceiling (`MarketConfig.maxLineQuantity`, AU 99), the default cap `D`, the default threshold and the reservation duration are Market configuration (D 8). A CHECK on any of them would hardcode AU |
| C7 | As ID C7: every index leads with `market_id` (ADR-0004 decision 4) |
| C8 | Deletes: `ON DELETE CASCADE` only for `reservation_lines` from `reservations`, because a line has no meaning without its reservation. Every other foreign key is `RESTRICT`. The application never deletes a seller inventory, a source, a stock item or a ledger row (no source delete in the brief, D 12.3; stock items are retired, D 3.3) |
| C9 | As ID C9: Prisma model names start with `Inventory` (`InventoryStockItem`, `InventoryOutbox`); tables are mapped with `@@map` |
| C10 | **Raw SQL: one named statement, `inventory.lock-stock-items`** (4.3), through the platform raw helper (P 4.2; D 4.4, Hassan's conditions). Everything else is Prisma, with `marketId` at the top level of every `where` (P 4.1), the held sum included (`groupBy`, Hassan's decision, D 14.2) |
| C11 | **Isolation.** READ COMMITTED, except for the use cases of 4.5, which run `serializable`: `inventory.set-stock-level`, the retirement handler `inventory.retire-sell-units` (finding F2) and the re-key handler `inventory.rekey-moved-offer` (D 3.6; it also creates first stock items and tombstones) |

## 3. Tables

Columns of C1 are left out. "Personal" marks personal data (ADR-0018 decision 6). "Identifier" marks a plain id that points at a person.

### 3.1 `inventory.outbox` and `inventory.inbox`

Both are the identity tables with the module name changed (ID 3.1 and 3.8; P 11 PM1 and PM4): the `type` CHECK is `^inventory\.[a-z0-9-]+\.v[1-9][0-9]*$` and the `handler` CHECK is `^inventory\.[a-z0-9-]+$`. The columns, the unique key `(market_id, aggregate_id, aggregate_version)`, the claim index `(market_id, event_id) WHERE published_at IS NULL` and the inbox primary key `(event_id, handler)` are the same. The catalog test "every outbox has the same columns" (P 13) covers them.

- The only aggregate type in the outbox is `availability-signal` (D 7.3). `aggregate_version` is `availability_signals.version`, so the unique key also proves "one event per version step".
- The inbox gets no other index and no `DELETE` grant until the platform prune job exists (ID 3.8). It receives one row per consumed event: seller approvals plus catalog Offer and Variant events, `catalog.offer-moved.v1` included (9).

### 3.2 `inventory.seller_inventories` (slice 1)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; the aggregate id |
| `seller_id` | `uuid` | no | C4: the seller id minted by `identity` (ID 3.9) |
| `low_stock_threshold` | `integer` | yes | The seller's override (Q8). NULL means the Market default (D 5.2). CHECK `BETWEEN 0 AND 99` (D 2.1, Hassan finding 9: a fixed bound, not a Market value) |
| `version` | `integer` | no | C5 |
| `created_at` | `timestamptz(6)` | no | |

- **Unique `(market_id, seller_id)`**: one per seller and Market (D 2.1). This makes the approval handler idempotent a second time, after the inbox (AC 10). On a creation race, the repository maps `P2002` on this constraint to "already exists" and the handler does nothing (P 10). It is also the foreign-key target of `sources`, so there is no separate `(market_id, id)` key: nothing references `id`.
- Read by this key, together with the seller's sources, whenever the availability of that seller's items is computed.

### 3.3 `inventory.sources` (slice 1)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `seller_id` | `uuid` | no | FK `(market_id, seller_id)` → `seller_inventories (market_id, seller_id)`, RESTRICT. The owner; never changes |
| `name` | `text` | no | Free text from the seller; **may hold personal data** (a person's name). CHECK 1 to 80 characters, no outer spaces (limit proposed: 11.2 M3) |
| `address` | `jsonb` | yes | **Personal, plain**: a sole trader's source may be a home address. CHECK `jsonb_typeof = 'object'`; the application validates the shape (11.2 M3). NULL when the Default source is created (Q-H2, decided by Hadi: start empty, seller's zone implied) |
| `time_zone` | `text` | yes | An IANA id (ADR-0005 decision 2). CHECK on the IANA form, `^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$`. Whether the zone exists is checked by the application through Temporal. NULL means "the seller's zone" (D 8) |
| `is_default` | `boolean` | no | Set at creation and never changed: D 3.4 has no "change Default" use case. Not in the `UPDATE` grant (7) |
| `priority` | `integer` | no | Position 1..n in the seller's order (Q9). CHECK `>= 1` |
| `created_at` | `timestamptz(6)` | no | |

- **Partial unique `(market_id, seller_id) WHERE is_default`**: at most one Default per seller (measured). "Exactly one" needs a deferred check across rows, so it stays with the aggregate (6).
- **Unique `(market_id, seller_id, priority)`**: no two sources share a position (measured). It also serves the one list query, "the seller's sources in priority order" (allocation, D 4.2 step 1; the sources screen). "Gap-free" is the aggregate's rule.
- Unique `(market_id, id, seller_id)`: the C3 target for `stock_items`. It proves that a stock item's seller is the seller of its source (D 2.1; measured).

**Toss-up T2: reordering against a non-deferrable unique key.** PostgreSQL checks a non-deferrable unique index row by row, so swapping two positions in place fails.

| Option | For | Against |
|---|---|---|
| A (recommended). A plain unique index, and the repository writes a reorder in two passes inside the one unit. First each moved source goes to `n + new_position`, then to `new_position`. The parked values `n+1..2n` cannot collide with `1..n` | Prisma declares the index and the drift check covers it; nothing is hand-written | 2 × (moved sources) single-row updates, with n in the tens at most. The root version makes two concurrent reorders fail as stale (D 2.3) |
| B. `UNIQUE … DEFERRABLE INITIALLY DEFERRED`, hand-written | One pass | Prisma cannot declare a deferrable constraint, so it becomes drift to manage, and a deferrable unique key cannot serve as an `ON CONFLICT` arbiter. Not measured with Prisma 7 here |

### 3.4 `inventory.stock_items` (slice 2)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK. The lock order of section 4 is ascending `id` |
| `offer_id`, `variant_id` | `uuid` | no | C4, catalog ids. Every sell unit has a Variant id (D 13) |
| `source_id` | `uuid` | no | FK `(market_id, source_id, seller_id)` → `sources (market_id, id, seller_id)`, RESTRICT |
| `seller_id` | `uuid` | no | The source's seller, proved by the FK. Also the Offer's seller, which is checked through the catalog facade (D 4.5) and cannot be proved here |
| `on_hand` | `integer` | no | CHECK `>= 0` (Q6; brief s5) |
| `retired_at` | `timestamptz(6)` | yes | D 3.3. Set once, never cleared (6) |
| `version` | `integer` | no | C5. A stock write raises it; a reservation does not |
| `created_at` | `timestamptz(6)` | no | |

- **Unique `(market_id, offer_id, variant_id, source_id)`**: the inventory key of brief s5 and ADR-0010 decision 2. It settles a creation race in the upsert (`P2002`, P 10). Its prefix `(market_id, offer_id, variant_id)` serves "every stock item of these sell units" (4.2 L1) and every availability read. Measured: one index probe per sell unit.
- Unique `(market_id, id, offer_id, variant_id)`: the C3 target for both lines and movements, which proves that they name the same Offer and Variant as their stock item (measured). It also serves the lock statement (measured: the planner picks it for `market_id` plus `id = ANY`).
- `(market_id, seller_id, offer_id)`: the seller's own stock (`inventory.get-stock`) and the admin's view of a seller (`inventory.admin-view-seller-stock`), with keyset pagination by Offer.
- No index contains `on_hand`, `version` or `retired_at`, so the frequent stock writes can be HOT updates.

### 3.5 `inventory.stock_movements` (slice 2; V4)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `stock_item_id`, `offer_id`, `variant_id` | `uuid` | no | FK `(market_id, stock_item_id, offer_id, variant_id)` → `stock_items`, RESTRICT. The copies of the Offer and Variant ids are immutable and proved equal (C3), so a ledger can be read by Offer without a join |
| `delta` | `integer` | no | Signed. CHECK `<> 0`: setting the same level is not a change and writes no row (D 2.1, "every `onHand` change"; 11.2 M4) |
| `resulting_on_hand` | `integer` | no | CHECK `>= 0 AND resulting_on_hand - delta >= 0`, so the previous level was not negative either |
| `reason` | `text` | no | CHECK `seller-set`, `shipment`, `restock`, `re-key` (D 2.1, D 3.6; a closed list; a new reason needs a migration). `re-key` is in migration 2 from the start, so V-1 adds no migration |
| `actor_kind` | `text` | no | CHECK `account`, `module` |
| `actor_account_id` | `uuid` | yes | Identifier (C4). CHECK `(actor_kind = 'account') = (actor_account_id IS NOT NULL)` |
| `actor_module` | `text` | yes | CHECK `^[a-z][a-z0-9-]*$` and `(actor_kind = 'module') = (actor_module IS NOT NULL)` |
| `correlation_id` | `text` | no | CHECK as `audit_log_correlation_id_check` |
| `occurred_at` | `timestamptz(6)` | no | |

- CHECK `reason NOT IN ('shipment', 're-key') OR actor_kind = 'module'`: a shipment always comes from `ordering` (D 3.2); a re-key always comes from the handler of D 3.6 (`actor_module = 'inventory'`, correlation id from the event envelope).
- **Acting-as** (D 2.1, Hassan finding 8, "once SEL-08 exists"): the nullable column `acting_as_account_id uuid`, with CHECK `acting_as_account_id IS NULL OR actor_kind = 'account'`, arrives in SEL-08's slice. Adding a nullable column with no default is a catalog-only change in PostgreSQL 11 and later, so the append-only table is not rewritten.
- **Append-only by privilege**: `SELECT, INSERT` only (7; measured: `UPDATE` and `DELETE` fail with `42501`). It is never pruned (brief s5). There is no trigger and no hash chain: the tamper-evident record of an admin action is the audit row, and admins cannot write stock at launch (brief s2).
- One index, `(market_id, stock_item_id, occurred_at, id)`: the ledger of one stock item, for its seller and for the admin, newest first, with keyset pagination on `(occurred_at, id)`.
- Not added: a seller-wide timeline `(market_id, seller_id, occurred_at)`. No screen in D needs one. It would need a `seller_id` copy, which the C3 target of 3.4 could prove.

### 3.6 `inventory.reservations` (slice 4)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `holder_account_id` | `uuid` | no | **Identifier** of the customer (C4). Brief s9: no other customer data is stored here |
| `checkout_ref` | `uuid` | no | `ordering`'s id for the checkout (C4). `commitReservation` must match it (D 3.1, Hassan finding 5); the comparison is on the row read by primary key, so it needs no index. The type is an assumption until the ordering G2 (11.3) |
| `status` | `text` | no | CHECK `active`, `released`, `expired`, `committed` (D 3.1). FULFILLED and CANCELLED are derived from the lines and are not stored (D 3.2) |
| `release_cause` | `text` | yes | CHECK `superseded`, `cancelled`, `payment-failed`, `customer`, `offer-moved` (D 2.1, D 3.6; Ali). See the CHECK below. `offer-moved` is in migration 3 from the start |
| `expires_at` | `timestamptz(6)` | no | `created_at` + the Market's duration (Q2), computed by the domain. Never changes. CHECK `> created_at` |
| `created_at` | `timestamptz(6)` | no | |
| `status_changed_at` | `timestamptz(6)` | no | The anchor of the prune (9). CHECK `>= created_at`. Not in D 2.1: 11.2 M2 |
| `version` | `integer` | no | C5 |

- CHECK `reservations_release_cause_check`:
  - `(status = 'released' AND release_cause IS NOT NULL)`
  - `OR (status = 'committed' AND (release_cause IS NULL OR release_cause = 'superseded'))`
  - `OR (status IN ('active', 'expired') AND release_cause IS NULL)`

  A released row always has its cause. Only a `superseded` release can later be committed (Q-A2), and the cause is kept on the committed row as history (11.2 M8). A repeated release does not change the stored cause (D 10); that is a guarded `updateMany` on `status = 'active'`.
- **Partial unique `(market_id, holder_account_id) WHERE status = 'active'`**: at most one ACTIVE reservation per Market and holder (brief s5; D 2.1). Measured: a second one is refused; the same holder in the other Market is accepted; a new one after a release is accepted. An expired row still `active` holds its slot until `reserve` releases it as `superseded` in the same unit (D 3.1) or the job marks it. A same-holder race ends in `P2002` → `conflict.retry` (D 4.2). The same index answers the idempotent `reserve` (D 10: the holder's ACTIVE row, then its `checkout_ref` and lines are compared); measured, the planner uses it for that lookup.
- Unique `(market_id, id, expires_at)`: the C3 target of the lines, so the `expires_at` copy on a line cannot differ from its header's (measured).
- **Expiry job:** partial index `(market_id, expires_at) WHERE status = 'active'`. It holds only live rows: 240 kB in the measured set of 10⁶ reservations.
- **Prune job** (migration 4, 8.1): partial index `(market_id, status_changed_at) WHERE status IN ('released', 'expired')`.
- No index on `checkout_ref`: every port call after `reserve` names the `reservationId` (D 7.2).

### 3.7 `inventory.reservation_lines` (slice 4)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK: the `reservationLineId` of the port (D 7.2) |
| `reservation_id` | `uuid` | no | FK `(market_id, reservation_id, expires_at)` → `reservations (market_id, id, expires_at)`, `ON DELETE CASCADE` |
| `expires_at` | `timestamptz(6)` | no | Copy of the header's value (C3). It lets the held sum read a single index (4.1) |
| `offer_id`, `variant_id` | `uuid` | no | The line's sell unit as requested; never changes |
| `stock_item_id` | `uuid` | no | The allocated unit. FK `(market_id, stock_item_id, offer_id, variant_id)` → `stock_items`, RESTRICT, so re-pointing a line at commit (D 3.1) stays inside the same sell unit. The line's source and seller are those of the stock item and are not stored (11.2 M2) |
| `quantity` | `integer` | no | CHECK `>= 1` (Q6); no upper bound (C6); never changes |
| `state` | `text` | no | CHECK `active`, `released`, `expired`, `committed`, `fulfilled`, `cancelled`. Until commit it mirrors the header (4.1); after commit it is the line's own state (D 3.2) |
| `order_line_id` | `uuid` | yes | C4. CHECK `(order_line_id IS NULL) = (state IN ('active', 'released', 'expired'))`: set exactly from commit on (measured) |
| `state_changed_at` | `timestamptz(6)` | no | Not in D 2.1: 11.2 M2 |

- Unique `(market_id, reservation_id, offer_id, variant_id)`: one line per sell unit (D 2.1). Its prefix also serves "the lines of a reservation", which is used by load, commit, release, the expiry job and the cascade of the prune.
- **Unique `(market_id, order_line_id)`**: the idempotency key of `cancelCommittedLine` and `recordShipment` (D 10), and their lookup. NULLs do not collide, so a plain unique key is enough and Prisma declares it.
- **The held index** (T1, 4.1): `reservation_lines_market_id_stock_item_id_state_idx` on `(market_id, stock_item_id, state, expires_at, quantity)`. It is a plain index that Prisma declares. Index-only scans read `state = ANY(…)` as an index condition, so only the entries of live lines are visited, however long an item's history is. Measured: 67 B per line, which is 194 MB for 3 × 10⁶ lines. Why it is not partial: 4.3.
- Changing `state` is not a HOT update, because the column is indexed. A line changes state once or twice in its life, so this is accepted.

### 3.8 `inventory.offer_purchase_limits` (slice 4)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `offer_id` | `uuid` | no | C4 |
| `seller_id` | `uuid` | no | The Offer's seller (D 5.1). Ownership is checked through the catalog facade (D 9) |
| `max_per_customer` | `integer` | no | CHECK `>= 1`. Its upper bound is `MarketConfig.maxLineQuantity` (C6, 6) |
| `version` | `integer` | no | C5 |
| `created_at` | `timestamptz(6)` | no | |

- **Unique `(market_id, offer_id)`**: at most one cap per Offer (D 2.1). It is also the read in `reserve` (D 4.2 step 1), by Offer ids.
- Removing a seller's cap deletes the row, so the default of D 5.1 applies again. That is why the grant includes `DELETE` (7).

### 3.9 `inventory.availability_signals` (slice 2)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK: the `aggregateId` of the D 7.3 events |
| `offer_id`, `variant_id` | `uuid` | no | C4 |
| `seller_id` | `uuid` | no | For `inventory.low-stock-reached.v1` (D 7.3) |
| `status` | `text` | no | CHECK `in-stock`, `low`, `out` |
| `only_left` | `integer` | yes | CHECK `(status = 'low') = (only_left IS NOT NULL) AND only_left BETWEEN 1 AND 99`. Within that range, "at most the effective threshold" is policy (6) |
| `changed_at` | `timestamptz(6)` | no | |
| `version` | `integer` | no | C5; equals the last event's `aggregate_version` |

- **Unique `(market_id, offer_id, variant_id)`**: one signal per sell unit. The first recompute creates it. A creation race ends in `P2002`, which the repository maps to `conflict.retry` (P 3.1 row 7 does not cover `P2002`). Under the lock rule of 4.2 two units cannot recompute the same sell unit at the same time, so this race needs a bug to occur.
- Only the key is indexed, so the frequent updates can be HOT.
- The signal is **not** the read model of `getAvailability`, which is computed (D 2.2, 5.3; 4.4 "availability read"). Not added: an index for the seller dashboard's low-stock card (D 12.2). It comes with the card's query, which D does not yet define (11.2 M5).

### 3.10 `inventory.retirements` (slice 2; D 3.5)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `scope` | `text` | no | CHECK `offer`, `variant` |
| `offer_id` | `uuid` | no | C4 |
| `variant_id` | `uuid` | yes | CHECK `(scope = 'variant') = (variant_id IS NOT NULL)` |
| `source_aggregate_version` | `integer` | no | The `aggregate_version` of the catalog event that retired it (`offer-deleted`, `variant-removed`, or `offer-moved` for the re-key of D 3.6): the comparison for "Variant-added clears a tombstone only if newer" (D 3.5). CHECK `>= 1`. Kept for audit only: catalog never reuses a removed Variant id (CAT M-1), so the comparison never clears a tombstone |
| `retired_at` | `timestamptz(6)` | no | |

- Partial unique `(market_id, offer_id) WHERE scope = 'offer'` and partial unique `(market_id, offer_id, variant_id) WHERE scope = 'variant'`. There are two because Prisma cannot declare `NULLS NOT DISTINCT` (ID 8.4). Both also serve the tombstone check of the stock upsert.
- A repeated retirement event inserts nothing (the unique key). Clearing a tombstone deletes its row, hence `DELETE` in the grant. Retired stock items of a cleared Variant never become active again (11.2 M6, closed: catalog G2 never reuses a Variant id); this design keeps `retired_at` one-way.

## 4. Locking, the raw statement and toss-up T1

### 4.1 T1 (decided by Ali: option A) and the index I size for it

T1 option A is decided (D 4.1). The held sum reads only the lines, through the index of 3.7 and Prisma `groupBy` (Hassan, D 14.2). Measured on PostgreSQL 16.15 with 3 × 10⁶ lines, summing for 31 stock items, one of which has 300 live holds and 20,000 historical lines:

| Design | Held sum, generic plan (the worst case for a cached statement) | Index size |
|---|---|---|
| **Chosen:** plain index `(market_id, stock_item_id, state, expires_at, quantity)`, Prisma `groupBy` in the shape of 4.3 | **0.23 to 0.55 ms**, index-only, condition `state = ANY(…)`; history is not visited | 194 MB (67 B per line) |
| Partial covering index `… WHERE state IN ('active', 'committed')` read through Prisma | 149 to 180 ms: parallel sequential scan, because a planner cannot prove the partial predicate from bind parameters in a generic plan | 5.8 MB |
| The same partial index with a raw statement that has the states as literals | 0.26 to 0.32 ms | 5.8 MB |
| No `state` filter, only the OR (Prisma's naive shape) on the chosen index | 2.9 ms: it walks all 20,000 historical entries of the hot item, so the cost grows with history | — |
| Lines joined to the header for status and expiry (no copies on the lines) | 6.96 ms, 2,981 buffers; grows with history | — |
| Option B, counters | O(1), but correctness depends on the expiry job | — |

To make A cheap the lines carry two values from the header. `expires_at` never changes and a foreign key proves it equal. The holding-phase `state` is kept in sync by the repository, which writes the header and all its lines in the same unit whenever the header's status changes. The database cannot prove the mirrored state (6), so a repository test asserts it for every transition. This denormalisation exists because of a measured read need: see the join row.

The raw literal-state statement would be 30 times smaller on disk. I do **not** propose it: Hassan limited the raw list to the lock (D 4.4), and the plain index keeps the Prisma form safe under any plan. If the index's size ever matters, his list is the place to revisit (9).

### 4.2 Lock set and rules (D 4.3, with finding F1)

| # | Rule |
|---|---|
| L1 | **The lock set is every stock item of every affected sell unit**, in every unit that changes a sell unit's sellable quantity: reserve, the commit re-take, commit, release, line cancel, shipment, stock write, retirement, the re-key (D 3.6) and the expiry job. That means all sources, retired items included. D 4.2 already does this for `reserve`; F1 extends it to every writer. The reason: a sell unit's signal is the maximum over all its sources (Q10). If two units each lock only "their" source, each computes that maximum from the other's old value, and the signal can stay wrong with no conflict raised. Example: two sources drop to 0 at the same moment, and the signal stays `in-stock`. Retired items are included because their committed lines still change (D 3.3); `reserve` may leave them out, as D 4.2 says, without harm |
| L2 | Inside the unit, the use case first reads the ids of those stock items (Prisma, on the prefix of the inventory key), then passes them all to **one** `inventory.lock-stock-items` call, ordered by `id`. Measured: `LockRows` sits above the `Sort` by `id`, so rows are locked in ascending order. With 16 clients locking random, crossing sets of 3 out of 6 sell units: **0 deadlocks in 800 transactions**. The same work locked sell unit by sell unit in request order: **641 deadlocks in 800** |
| L3 | A stock item created and committed between that read and the lock is not locked by this unit. Allocation therefore uses **only the locked items**: there is no oversell, because a new item has no holds. After the lock, every read that decides something is a **new statement**: the held sums, the sell unit's stock items when the signal is recomputed (so the new item is counted there), the signal row and the reservation. Under READ COMMITTED each new statement sees everything that committed before the lock was granted (D 4.2 step 4) |
| L4 | After the stock locks, the unit may write `reservations`, `reservation_lines`, `availability_signals`, `stock_items`, `stock_movements` and `outbox` in any order. No unit takes a row lock on those tables before its stock locks, the expiry job included (4.4) |
| L5 | **`FOR NO KEY UPDATE` rather than `FOR UPDATE`** (a request to Hassan, since D 4.4 writes `FOR UPDATE`). No unit changes a key column of `stock_items`. The weaker lock does not block the `FOR KEY SHARE` that every foreign-key check of a line or a movement takes on its stock item. Measured: under `FOR UPDATE`, another session's ledger insert for that item waited until `lock_timeout`; under `FOR NO KEY UPDATE` it went straight through. Between lockers the mutual exclusion is the same |
| L6 | Units that touch only `seller_inventories`, `sources`, `offer_purchase_limits` or, alone, `retirements` take no stock lock (D 4.3). The prune job (9) deletes only terminal rows, which no sum reads, and it takes no stock lock (11.2 M7) |
| L7 | **`lock_timeout`.** D 4.2 step 2 sets `SET LOCAL lock_timeout = '3s'` (Hassan finding 3). That is raw SQL inside a unit, which the guard refuses (P 4.2). I propose a UnitOfWork option, `lockTimeoutMs`, which `platform/persistence` issues as the first statement of the transaction, rather than a second module statement (11.3 R3). The role-level `lock_timeout` stays the outer bound (ID K1) |

### 4.3 The named statement and the held-sum shape (Q-M1, my part)

**`inventory.lock-stock-items`**. Following Hassan's conditions (D 4.4): Market and tenant are bound by the helper from the open unit and never come from the caller. The ids go in as one `uuid[]`. The text is fixed and on the checked-in list.

```sql
SELECT s.id, s.offer_id, s.variant_id, s.source_id, s.seller_id, s.on_hand, s.retired_at, s.version
  FROM "inventory"."stock_items" AS s
 WHERE s.market_id = $1
   AND s.tenant_id = $2
   AND s.id = ANY($3::uuid[])
 ORDER BY s.id
   FOR NO KEY UPDATE OF s;
```

- **Helper checks.** The helper deduplicates `$3` and refuses an empty list or one of more than 1,000 ids. D caps `reserve` at 50 lines (finding 3); with the previous reservation's 50 that is at most 100 sell units, times at most 4 sources each (`inventory.maxSourcesPerSeller`, D 3.4), so 400. The re-key (D 3.6) is bounded by `catalog.maxVariantsPerProduct` (AU 100, ZZ 3; set by catalog G2, merged PR #54) × 4 sources × 2 (`from` and `to`) = 800 items, plus held items (expected none); it is never chunked, and the 1,000 cap stays its backstop: above it the handler fails with an alert and an operator moves the stock (Ali, V-1a, 2026-10-07). Raising either Market cap needs a re-check of this bound. It also fails when fewer rows come back than distinct ids were given. Stock items are never deleted (C8), so a short answer means a foreign-Market id or a bug.
- **Measured** with 51 ids under a generic plan: 0.6 ms, on the unique key `(market_id, id, offer_id, variant_id)`, `LockRows` above `Sort`. The same ids under ZZ returned and locked nothing.
- **Verdict on Q-M1, my half:** approved, with L5 (`FOR NO KEY UPDATE`) and the tenant condition written into the text. The only change from D 4.4 is the lock strength. The rule that decides which ids are passed is F1 (L1, L2).

**Held sum, Prisma `groupBy`** (Hassan's decision). This exact `where` shape is part of the contract, because the plan depends on it:

```ts
// by: ['stockItemId', 'state'], _sum: { quantity: true }
where: {
  marketId,                                  // top level (P 4.1)
  stockItemId: { in: lockedIds },            // at most 1,000
  state: { in: ['active', 'committed'] },    // mandatory: it becomes the index condition
  OR: [{ state: 'committed' }, { expiresAt: { gt: now } }],  // now = Clock instant
}
```

Grouping by `state` returns `reserved` (`active`) and `pending` (`committed`) separately. AC 9's "cannot go below N" and the seller's view need both. A line is held while `expires_at > now` and stops being held at `now ≥ expiresAt` (D 3.1). The time is the `Clock` instant and never the database's `now()` (ADR-0005). Measured with this shape under generic and custom plans: `state = ANY(…)` is an index condition, either as `IN ($a, $b)` or as `= ANY($arr)`. Without the `state: { in }` line the cost grows with history (4.1). A database test asserts the plan (10).

### 4.4 Statement order per use case

Every unit is READ COMMITTED unless C11 says otherwise. "Lock" means: read the ids of L1, then `inventory.lock-stock-items`. "Sum" means the `groupBy` of 4.3. Everything else is Prisma with `marketId` in `where`.

| Use case (D 6) | Inside the unit, in order |
|---|---|
| `reserve` | Lock (the requested sell units plus those of the holder's ACTIVE reservation) → `updateMany` the previous ACTIVE header and its lines to `released`, cause `superseded`, guarded on `status = 'active'` → sum over the locked items → cap check (D 4.2 step 5), then allocation (step 6) → insert the header, then the lines → recompute signals (L3) → outbox. An `err` commits nothing, so the release is undone too (D 4.2 step 7) |
| `commitReservation` | Load the header (by id) and its lines; `checkout_ref` must match, else `inventory.commit-mismatch` → lock their sell units → not expired: set `order_line_id` and state `committed` on the lines. Expired, or released with cause `superseded`: sum, allocate again, re-point `stock_item_id`, commit, or `inventory.insufficient` → header `committed`, version + 1 → signals. A repeat with the same mapping changes nothing (D 10; the unique `order_line_id`) |
| `releaseReservation`, `releaseOwnReservation` | Load → lock → header and lines `active` → `released` with the given cause (guarded) → signals |
| `cancelCommittedLine`, `recordShipment` | Find the line by `(market_id, order_line_id)` → lock its sell unit → line `cancelled`; or line `fulfilled` plus `on_hand − quantity`, version + 1, and a `shipment` movement → signals |
| `set-stock-level` (**serializable**, C11) | Catalog ownership checks before the unit (D 4.5) → lock the sell unit → read the tombstones of 3.10 and refuse if retired → insert the item, or check its `version` → sum → refuse below `reserved + pending` (AC 9) → update `on_hand` and version → movement → signals |
| `retire-sell-units` (handler, **serializable**) | `runOnce` → lock the Offer's (or Variant's) items → insert the tombstone → `updateMany retired_at` where the Offer (and Variant) match and `retired_at IS NULL`, as a new statement (L3) → signals |
| `rekey-moved-offer` (handler, **serializable**; D 3.6) | `runOnce`; before the unit, the mapping is validated before any read (at most the Market's `catalog.maxVariantsPerProduct` pairs (AU 100, ZZ 3; catalog G2, merged PR #54); distinct ids; no `from` equal to a `to`; `fromProductId` ≠ `toProductId`) and checked against `offerSellUnits` as the system actor (present, not deleted, `productId` = `toProductId`, every `to` a sell unit; Hassan M1), else the handler fails with an alert → read the ids of every stock item of (Offer, `from`) and (Offer, `to`) for every pair (`variant_id IN (…)` on the prefix of the inventory key) → read the live holds on the source items through the held index (`state = 'active'`, `expires_at > $now`) and the stock items of every line of those reservations → **one** lock call with the union, ascending `id`, never chunked: at most 800 plus held items under the two Market caps, the helper's 1,000 a backstop (else the handler fails with an alert; D 3.6 step 2, 14.1 V-1a) → read the Offer tombstone (new statement, L3); **if it exists**, `updateMany retired_at` on what is left and stop, before any release (D 3.6 step 3; Ali 5) → read the variant tombstones of the `to` variants; a covered pair is retired without moving and logs `inventory.rekey.stock-dropped` with the quantity → `updateMany` those reservations to `released`, cause `offer-moved`, guarded on `status = 'active'`, and their lines; one `inventory.rekey.hold-released` log per reservation → sum over the locked items (pending per item); `moved` below 0 is clamped to 0 with an alert → per pair and source: insert the (Offer, `to`, source) item with `on_hand = moved` and write two `re-key` movements (none when `moved = 0`); **if it exists**, leave it unchanged and write only the `−moved` movement on the old item, logging `inventory.rekey.target-exists` (Hassan M2) → `updateMany retired_at` on the source items where `retired_at IS NULL` → insert the variant tombstones of the `from` variants (`createMany` with `skipDuplicates`, the partial unique key of 3.10) → signals of old and new sell units → outbox. A target insert that meets `P2002` (a racing stock write) or a `40001` is retried by the UnitOfWork, and the retry finds the row and leaves it unchanged |
| `expire-reservations` (job) | Per batch: candidates without a lock (9) → their lines' sell units → lock → `updateMany` the headers to `status = 'expired'` where `id IN (…) AND status = 'active' AND expires_at <= $now`, version + 1 → lines `active` → `expired` for the headers that changed → signals → outbox |
| Availability read (`getAvailability`, read-only unit, at most 200 keys, D 7.1) | The stock items of the sell units → sum → thresholds → status. No lock |

### 4.5 Serializable writers (finding F2; measured)

The retirement tombstone (D 3.5) has a write-skew race that no row lock can stop. A stock upsert creates the **first** stock item of a sell unit while the same Variant is being retired. Neither unit has an existing row to lock: the creator sees no tombstone, and the retirer's `UPDATE` sees no stock item. Both commit, and an active stock item exists for a retired Variant, which breaks AC 6.

Measured: under READ COMMITTED, one active item was left on a retired Variant. With both units `serializable`, the creator failed with `40001` in 2 of 2 runs and no bad row remained. The UnitOfWork retries `40001` (P 3.1 row 7), and the retry sees the tombstone and refuses.

| Option | For | Against |
|---|---|---|
| A (recommended). `set-stock-level` and `retire-sell-units` run `serializable` (C11); all other units stay READ COMMITTED | Two low-rate use cases; no new table; the identity pattern (ID C11) | SSI predicate locks can raise a false `40001` on a seller's stock write, which is then retried. Spike S1 measures the retry rate under a burst of stock writes |
| B. An anchor row per sell unit (insert or lock), which both units take first | No serializable unit | A new table, or `availability_signals` used as the anchor, which changes D's lock unit; one more row lock in every writer |

## 5. What is never stored

| Never in the database | Instead |
|---|---|
| A reserved or pending counter on a stock item | Summed at read time (4.1) |
| A "sellable now" number or flag, or an availability read model | Computed per call (D 2.2). `availability_signals` holds only the last **published** status |
| An exact stock number in an outbox payload | Status, and `onlyLeft` only for `low` (D 5.4). The database cannot check a payload; the contracts snapshot does (P 5.3) |
| Price, Cost, currency or any money | None in this schema (ADR-0024 decision 5; AC 14) |
| Seller access state or may-sell | `identity` and `sellers` (ADR-0022) |
| Customer data beyond the account id | No email, name or address of a customer (brief s9) |
| Offer or product content | `catalog`; only ids are stored here |

## 6. Invariants the database does not carry

| Invariant | Why not a constraint | Enforced by |
|---|---|---|
| Sellable is never negative: `on_hand ≥ reserved + pending` | It spans rows of two tables and depends on `Clock` | `StockItem.setOnHand` and the allocation under the lock (4.2, 4.4); the concurrency test (10) |
| Exactly one Default source; gap-free priorities | "At least one" and "no gaps" need deferred checks across rows | The `SellerInventory` aggregate. The database carries "at most one Default" and "no duplicate position" (3.3) |
| A stock item's seller is the Offer's seller; the Variant belongs to the Offer's product; the Offer is in this Market | Catalog data (C4) | The catalog facade check before the unit (D 4.5; AC 11) |
| A line's holding-phase state equals its header's status | After commit the two diverge, so a foreign key cannot carry it | The repository writes both in one unit; a repository test per transition (4.1) |
| Which state follows which; no `committed` → `released`; no subset commit; only a `superseded` release can be re-taken | CHECKs carry value sets only. The release-cause CHECK carries the last rule's data side | The `Reservation` aggregate (D 3) |
| The cap ≤ `maxLineQuantity`; the default threshold and cap; `only_left` ≤ the effective threshold; the reservation duration | Market configuration (C6) | Domain policies, at read time |
| One allocation per line: the first fitting source in priority order, never split | Behaviour | `AllocationPolicy` (D 9) |
| `retired_at` is never cleared; `is_default`, `seller_id`, `offer_id`, `variant_id`, `quantity` and `expires_at` never change | No trigger | The column-level `UPDATE` grants of section 7, for the application role. `retired_at` is the exception: it must stay updatable once |
| A line's `stock_item_id` changes only at the commit re-take | Behaviour | The `Reservation` aggregate; the foreign key keeps the line inside its sell unit |
| A stock item exists only for a non-retired Offer and Variant | The tombstone is in another table | The serializable pair of 4.5, plus the lock (L3) |
| `seller_id`, `offer_id`, `variant_id` and `holder_account_id` exist in their owning modules | No cross-module foreign key (ADR-0004 decision 3) | Facades and events |
| A row's Market never changes | No trigger | The guard (P 4.1) |

## 7. Grants

Under platform.md 10.2. Grants are hand-written in the `migration.sql` that creates each table, in a block headed `-- Grants (database-designer): docs/design/data/inventory.md section 7`. They go to `mondapac_app` only and are mirrored in `down.sql`, with every `REVOKE` before any `DROP`. Nothing from the "Never" row is used. `GRANT USAGE ON SCHEMA "inventory"` is in migration 1. There are no sequences and no functions.

| Table | Privileges of `mondapac_app` (the **Privileges line**) | Reason |
|---|---|---|
| `inventory.outbox` | `SELECT, INSERT`, `UPDATE (published_at)` | PM2 |
| `inventory.inbox` | `SELECT, INSERT` | `DELETE` arrives with the platform prune job |
| `inventory.seller_inventories` | `SELECT, INSERT`, `UPDATE (low_stock_threshold, version)` | Never deleted; `seller_id` is immutable |
| `inventory.sources` | `SELECT, INSERT`, `UPDATE (name, address, time_zone, priority)` | The brief has no source delete; `is_default` and `seller_id` are immutable (measured: `42501`) |
| `inventory.stock_items` | `SELECT, INSERT`, `UPDATE (on_hand, retired_at, version)` | The lock needs `UPDATE` on at least one column; measured, `FOR NO KEY UPDATE` works under the column-level grant. Items are retired, never deleted |
| `inventory.stock_movements` | `SELECT, INSERT` | Append-only (measured: `UPDATE` and `DELETE` → `42501`) |
| `inventory.reservations` | `SELECT, INSERT`, `UPDATE (status, release_cause, status_changed_at, version)`; `DELETE` from migration 4 | `expires_at` is immutable (measured). `DELETE` is only for the prune job |
| `inventory.reservation_lines` | `SELECT, INSERT`, `UPDATE (stock_item_id, state, order_line_id, state_changed_at)` | `quantity`, `offer_id`, `variant_id` and `expires_at` are immutable (measured). Lines are deleted only by the cascade, which needs no grant on the child (measured) |
| `inventory.offer_purchase_limits` | `SELECT, INSERT, UPDATE, DELETE` | An ordinary table; a delete clears the cap |
| `inventory.availability_signals` | `SELECT, INSERT`, `UPDATE (status, only_left, changed_at, version)` | The key columns are immutable |
| `inventory.retirements` | `SELECT, INSERT, DELETE` | A tombstone is inserted or cleared, never edited |

Column-level `UPDATE` meets the four conditions of 10.2: the columns are named here; no table has a Prisma `@updatedAt`; column-level and table-level `UPDATE` are never mixed on one table; and the expected map of platform.md 10.5 carries these lists. The api and worker roles share `mondapac_app`. PH4 (separate roles before the first deployed environment) applies to `UPDATE (published_at)` here, as it does for identity.

## 8. Migration plan

### 8.1 Order (one PR with a migration open at a time, `docs/process/parallel-tracks.md` rule 6)

| # | Slice | Migration | Contains |
|---|---|---|---|
| 1 | 1 | `inventory_sources` | `CREATE SCHEMA "inventory"` and schema `USAGE`; `inbox`, `seller_inventories`, `sources`; grants. `base.prisma` gains `"inventory"` in `schemas` (a shared file, in this PR) |
| 2 | 2 | `inventory_stock` | `outbox`, `stock_items`, `stock_movements`, `availability_signals`, `retirements`; grants |
| 3 | 4 | `inventory_reservations` | `reservations`, `reservation_lines` (every CHECK value slice 5 needs), `offer_purchase_limits`; grants without `DELETE` on `reservations` |
| 4 | With the prune job (9), before the first deployed environment | `inventory_reservation_prune` | The terminal partial index of 3.6; `GRANT DELETE ON "inventory"."reservations"` |
| 5 | SEL-08's slice | `inventory_movement_acting_as` | The nullable column of 3.5 and its CHECK |

Slices 3 and 5 need no migration. The platform raw helper (P 4.2) and `inventory.lock-stock-items` land in slice 2, where the stock write first locks, in that slice's PR and with Hassan's review. Slice 4 reuses them.

### 8.2 Reversibility and safety

- Every `down.sql` mirrors its up in reverse: `REVOKE` first, then children before parents (`reservation_lines` before `reservations`; `stock_movements` before `stock_items`, before `sources`, before `seller_inventories`). The down of migration 1 revokes schema `USAGE` and leaves the empty schema (ID 8.2). There is no `IF EXISTS`. `pnpm db:check-reversible` runs up → down → up.
- All tables are new, so there is no backfill and no lock that matters. Migrations 4 and 5 are the only ones that can meet live rows. Migration 5 is a catalog-only `ADD COLUMN`, run with `SET lock_timeout`. Migration 4 builds its index `CONCURRENTLY` in a hand-written migration of its own, outside a transaction, if an environment already holds reservations. Today no deployed environment exists, so the plain form is fine.
- My sign-off for each migration: the checklist of platform.md section 8, the five review points of 10.2, and a check that the hand-written block equals 8.4 for that table.

### 8.3 Seed data

**None.** No row comes from a migration, because SQL knows neither the hosted Markets nor the tenant constant (ID 8.3). Seller inventories are created by the approval handler (D 3.4).

The Market values of D 8 are configuration, not rows: the reservation duration, the default threshold, the default cap `D`, and the platform's `MarketConfig.maxLineQuantity`. They live in `config/markets/<CODE>.json`, validated at start-up, and the synthetic Market fixture gets different values (AC 13). `config/` is not a track folder, so changing it is a shared-file PR, announced on the board first (11.3).

### 8.4 Prisma specifics

- One file, `prisma/schema/inventory.prisma`. Models are named by C9, each with `@@schema("inventory")`.
- **Prisma declares** the tables, the column types, the primary keys, the non-partial unique keys and plain indexes of section 3 (the held index of 3.7 included, with an explicit `map:` name), and the composite relations of C3 through `@@unique` targets:
  - `sources → seller_inventories` on `[marketId, sellerId]`
  - `stock_items → sources` on `[marketId, sourceId, sellerId]`
  - `reservation_lines → stock_items` and `stock_movements → stock_items` on `[marketId, stockItemId, offerId, variantId]`
  - `reservation_lines → reservations` on `[marketId, reservationId, expiresAt]`, with `onDelete: Cascade`

  Identity measured two-column composite keys on Prisma 7.10. Three- and four-column keys, and a key that contains a `timestamptz`, are **not measured** (spike S1, 11.3). If Prisma refuses the `expires_at` relation, the fallback is a two-column foreign key plus the invariant in 6.
- **Hand-written**, appended in a marked block as in platform.md section 6: every CHECK, the grants, and these partial indexes. Prisma neither creates nor checks them (ID 8.4, decision A5). The catalog test of `pnpm test:db` compares them with this checked-in list:

```sql
CREATE INDEX "outbox_market_id_event_id_unpublished_idx" ON "inventory"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;
CREATE UNIQUE INDEX "sources_market_id_seller_id_default_key" ON "inventory"."sources" ("market_id", "seller_id") WHERE "is_default";
CREATE UNIQUE INDEX "retirements_market_id_offer_id_offer_key" ON "inventory"."retirements" ("market_id", "offer_id") WHERE "scope" = 'offer';
CREATE UNIQUE INDEX "retirements_market_id_offer_id_variant_id_variant_key" ON "inventory"."retirements" ("market_id", "offer_id", "variant_id") WHERE "scope" = 'variant';
CREATE UNIQUE INDEX "reservations_market_id_holder_account_id_active_key" ON "inventory"."reservations" ("market_id", "holder_account_id") WHERE "status" = 'active';
CREATE INDEX "reservations_market_id_expires_at_active_idx" ON "inventory"."reservations" ("market_id", "expires_at") WHERE "status" = 'active';
-- migration 4:
CREATE INDEX "reservations_market_id_status_changed_at_terminal_idx" ON "inventory"."reservations" ("market_id", "status_changed_at") WHERE "status" IN ('released', 'expired');
```

- `inventory.lock-stock-items` is not in the Prisma schema. Its text lives on the helper's checked-in list, and the tests of 10 cover it.

## 9. Volume, retention and jobs

Assumptions (not measured; one Market, Greater Brisbane, first year): 10² to 10³ sellers with 1 to 3 sources each; 10⁴ to 10⁵ sell units; 10³ to 10⁴ checkouts started per day with about 3 lines each; 10² to 10³ orders per day. Measured row sizes on PostgreSQL 16: a line is 168 B of heap plus 67 B in the held index, a reservation 135 B, a stock item 150 B. The other indexes add about as much again, and somewhat less with UUIDv7 than with the random UUIDs of the test.

| Table | Rows expected | Growth control |
|---|---|---|
| `stock_items`, `availability_signals` | 10⁴ to 3 × 10⁵; one signal per sell unit | None needed. Both are update-heavy and HOT-eligible: watch `n_tup_hot_upd` before proposing a fillfactor |
| `stock_movements` | One per stock write and per shipment: 10³ to 10⁴ per day, so at most about 4 × 10⁶ per year | **Never deleted** (brief s5). At 5 × 10⁷ rows, monthly range partitions on `occurred_at` for maintenance; partitions are never dropped. Archiving would be an owner decision |
| `reservations` and `reservation_lines` | Up to 10⁴ headers and 3 × 10⁴ lines per day | Released and expired rows are pruned after 30 days (proposed; 11.2 M7), which keeps the held index near 30 days of lines plus the committed ones (about 3 × 10⁶ lines at the upper bound, about 200 MB). Committed rows (pending, then fulfilled or cancelled) are kept; their retention is open (11.3 R1) and drives the index's long-term size |
| `outbox` | One event per change of status or `onlyLeft` (every reservation on a LOW item changes `onlyLeft`) plus `low-stock-reached`: up to 10⁴ per day | Reaches the one-million-row trigger of P 6.5 within months at the upper bound, so inventory is likely the module that forces the platform's outbox prune |
| `inbox` | Seller approvals plus catalog Offer and Variant events (and `offer-moved`, one per CAT-45 match): 10⁴ to 10⁵ | The platform prune job |
| `seller_inventories`, `sources`, `offer_purchase_limits`, `retirements` | 10² to 10⁵ | None needed |

| Job (per hosted Market; `market_id` in every statement) | Batch statement |
|---|---|
| `inventory.expire-reservations`, every minute (D 11) | Candidates are read without a lock: `SELECT id FROM inventory.reservations WHERE market_id = $1 AND status = 'active' AND expires_at <= $now ORDER BY expires_at, id LIMIT 100`. Measured with 200 rows: 1.14 ms on the active partial index. Each batch then runs the unit of 4.4. The guarded `updateMany` skips headers that changed in between, so the job is safe to run twice and concurrently (P 7). Correctness never depends on it (AC 4) |
| `inventory.prune-reservations`, hourly (migration 4) | `DELETE FROM inventory.reservations WHERE market_id = $1 AND status IN ('released', 'expired') AND status_changed_at < $now − 30 days AND id IN (SELECT … ORDER BY status_changed_at LIMIT 1000)`. **The status condition must also be in the outer `WHERE`**: under READ COMMITTED, a row changed after the subquery is re-checked only against the outer conditions, and a `superseded` release can still be committed (Q-A2). Lines go with the cascade. Measured: 1,000 headers and 3,000 lines in 118 ms |

## 10. Evidence and the tests to write

Measured on 2026-10-07 on PostgreSQL 16.15, in two throwaway databases with throwaway roles, all dropped afterwards. Prisma was not available in this session, so Prisma's shapes were reproduced as `PREPARE` statements under `plan_cache_mode = force_generic_plan` and `force_custom_plan`. Data: an AU Market with about 1,000 sellers, 2,000 sources and 100,000 to 247,500 stock items, plus ZZ; about 1,000,000 reservations and 3,000,000 lines (about 15,000 active, about 52,000 committed, the rest terminal); one hot item with 300 live holds (in the second run also 20,000 historical lines). The roles were a `NOLOGIN` group holding the grants of section 7 and one login member.

| Verified | Used in |
|---|---|
| Held sum: 0.23 to 0.55 ms through the plain index in Prisma's shape under a generic plan; 149 to 180 ms with a partial index under the same plan; 2.9 ms without the `state: { in }` line; 6.96 ms through the header join | 4.1, 4.3 |
| Lock statement: `LockRows` over `Sort` by `id`; 51 ids in 0.6 ms (generic plan); ZZ locks nothing for AU ids. 0 deadlocks in 800 with one ordered statement, 641 in 800 when locking per sell unit | 4.2, 4.3 |
| **Oversell race**: 20 clients × 5 attempts on a 1-unit item (lock, sum, insert, with a 5 ms gap between check and insert) gave exactly 1 hold. The control without the lock gave 20 holds | 4.2; AC 1 |
| `FOR NO KEY UPDATE` does not block a foreign-key check, while `FOR UPDATE` does; `FOR NO KEY UPDATE` works under a column-level `UPDATE` grant | L5, 7 |
| Creation against retirement: READ COMMITTED leaves an active item on a retired Variant; under serializable the creator gets `40001` (2 of 2 runs) | 4.5 |
| Sixteen constraint and grant cases: a seller mismatch and another Market through the source FK; a second Default; a duplicate priority; a negative `on_hand`; a second ACTIVE per holder, with the other Market and a new one after a release accepted; a line `expires_at` that differs from its header; a line Offer that is not its stock item's; a ZZ line under an AU header; `committed` without an order line; quantity 0; immutable columns and ledger `UPDATE`/`DELETE` refused with `42501`; the cascade without a `DELETE` grant; the two ledger CHECKs | 3, 7 |
| Expiry candidates in 1.14 ms; prune batch in 118 ms; the holder lookup uses its partial unique index | 3.6, 9 |

**Not measured:** PostgreSQL 17 (Compose and CI); Prisma 7 itself (the composite relations of 8.4, the SQL it generates for `groupBy`, and whether it caches statements); the raw helper; the release-cause CHECK (written after the measurement runs); UUIDv7 index locality; the `40001` rate of serializable stock writes; anything through the real guard.

**Tests the slices must carry** (`pnpm test:db`, application role, AU and ZZ):

| Test | Slice |
|---|---|
| `inventory.lock-stock-items` for AU and ZZ: a ZZ id locks and returns nothing in an AU unit; the helper refuses an empty list or one over the cap, and fails on a short answer (Hassan's conditions, D 4.4) | 2 |
| The held-sum `groupBy` as generated by Prisma: `EXPLAIN` shows the held index with `state` in the index condition, under `force_generic_plan` | 4 |
| **Concurrency** (brief s8, D 12.1): N parallel `reserve` calls through the real use case on a sell unit with sellable 1 give exactly one success, for AU and ZZ at the same time; multi-seller carts crossing in opposite request order give no deadlock and no `TransactionConflictError`; a stock write racing a reservation of the same sell unit never goes below `reserved + pending` | 4 |
| The sixteen cases above plus the release-cause CHECK as constraint tests; the privilege map of platform.md 10.5 with the column lists of section 7; the partial-index catalog test with the list of 8.4; "every outbox has the same columns" | Per migration |
| The re-key of D 3.6, AU and ZZ: moved quantity is `on_hand − pending`, the ledger keeps the old rows and gains two `re-key` movements, the source items are retired with tombstones, a pre-existing target row keeps its value while the old item gets only the `−moved` movement and `inventory.rekey.target-exists` is logged (Hassan M2), a live hold is released with `offer-moved` and logged as `inventory.rekey.hold-released`, an Offer tombstone found after the lock releases nothing, a `to` tombstone retires without moving and logs `inventory.rekey.stock-dropped`, a mapping over 200 pairs or with a shared id and an Offer whose `productId` ≠ `toProductId` or with a `to` outside its sell units change nothing (Hassan M1), a replay with a new event id moves nothing, a stock write racing the move ends in `40001` and its retry is refused by the tombstone, and an over-cap lock set fails without a change | 2, before catalog slice 16; the reservation step (live hold released) with 4 |
| The header and line state mirror after every transition; the retirement race of 4.5 with both units at once; expiry at read time with the job off (AC 4); a repeated approval event → one Default (AC 10); a source over the Market's `inventory.maxSourcesPerSeller` (AU 4, ZZ another value) is refused on creation (D 3.4) | 1, 2, 4, 5 |

## 11. Review record and open points

### 11.1 Q-M1 (D 14.1, my half)

| Part | Answer |
|---|---|
| Approve `inventory.lock-stock-items` (D 4.4) | **Approved** as written in 4.3, with Hassan's conditions. One change goes back to Hassan: `FOR NO KEY UPDATE` instead of `FOR UPDATE` (L5, measured). F1 decides which ids are passed |
| The index for T1 option A | The plain index `(market_id, stock_item_id, state, expires_at, quantity)` with the mandatory `where` shape of 4.3. It is safe through Prisma `groupBy` under any plan (measured). No raw sum statement |
| Retention of terminal reservation rows | Released and expired: deleted after 30 days (**decided**, M7: Hassan's alert (b) looks back 24 hours). Committed rows: open (R1, ordering G2). The ledger: kept without limit (brief s5) |

### 11.2 Findings and questions for Mohammad (domain model; no business rule changes)

| # | Point | My recommendation |
|---|---|---|
| F1 | The lock set is every stock item of every affected sell unit, in every writer and not only `reserve` (L1 to L3). D 4.3 should say so | Accept. **Decided by Mohammad 2026-10-07:** accepted; D 4.3 and 5.3 now say it (L1 to L3) |
| F2 | The race between creation and retirement (4.5): run `set-stock-level` and `retire-sell-units` serializable (option A), or add an anchor row per sell unit (B). Ali to confirm, since this adds two serializable writers | A. **Decided by Mohammad 2026-10-07:** option A. It is the existing rule of P 3.1 row 6 (the writers of a cross-row invariant run serializable), so it adds no platform rule; the `40001` retry rate is measured in S1 and slice 2 (D 4.5, 3.5, 10) |
| M2 | Fields added beyond D 2.1: `reservations.status_changed_at`, `reservation_lines.state_changed_at`, `reservation_lines.expires_at` (a copy), and line holding-phase states that mirror the header. Lines store no `source_id` or `seller_id`, which come from the stock item (FK-proved). Movements carry copies of the Offer and Variant ids | Confirm. **Decided by Mohammad 2026-10-07:** confirmed; D 2.1 lists them. The line's `sellerId` and `sourceId` stay in the domain model and are loaded from its stock item |
| M3 | The limit on a source `name` (80 proposed) and the shape of `address`: jsonb validated by `inventory`, or a shared address value object (Q-H2 settled only that the Default starts empty) | Mohammad; Hadi for the limit if it is a product rule. **Decided by Mohammad 2026-10-07:** `name` 1 to 80 characters is a technical input bound, not a product rule (as pricing's `decision_note` limit, pricing D 15 M6); Jafar may word the error. `address` stays `jsonb`, validated by an inventory-owned `SourceAddress` value object; no shared address type now, as no other module reads a source address at launch. If `shipping` or another module needs a shared address type, it moves to the kernel through that module's gate and this column is migrated then (D 2.1)  **Shape fixed 2026-10-08 (slice 1, part 2):** see the M3 row of the domain design, decisions table. An optional `octet_length` CHECK on `address` is Mojtaba's call, not required |
| M4 | A seller setting the same level writes no movement (CHECK `delta <> 0`) | Confirm. **Decided by Mohammad 2026-10-07:** confirmed: setting the same level is not a change, writes no movement and does not raise the version (D 4.5) |
| M5 | The seller dashboard's low-stock card: which query (the signals, or a computation), so its index can be added with it | Define with the card. **Open:** Mohammad with Reza, when the card is designed (D 12.2); its index comes with its query |
| M6 | Once a Variant tombstone is cleared, do retired stock items become active again? This design keeps `retired_at` one-way | Not in the brief: for Hadi, through Mohammad. **Decided by Mohammad 2026-10-07:** no. `retired_at` stays one-way, as D 3.3 already says (`active` → `retired` only); no new rule is made here. **Closed 2026-10-07:** catalog G2 (merged PR #54) answers that a removed Variant id never comes back (CAT M-1, 9.7; the same as pricing's M5 (c)), so no reactivation rule is needed (D 3.3, 3.5) |
| M7 | The prune deletes terminal rows without a stock lock (L6), an exception to D 4.3's wording. The 30-day retention of released and expired reservations | Accept. Hassan says if an anti-hoarding investigation needs longer. **Decided by Mohammad 2026-10-07:** the prune takes no stock lock (D 4.3, 11). 30 days decided on the basis of Hassan's rule: his alert (b) (D 5.4, Q-S2) looks back 24 hours, so 30 days of released and expired rows is enough |
| M8 | A `superseded` release that is later committed keeps `release_cause = 'superseded'` as history (CHECK in 3.6) | Confirm. **Decided by Mohammad 2026-10-07:** confirmed (D 2.1, 3.1) |
| T2 | Reordering sources against the non-deferrable unique key (3.3) | **Decided by Mohammad 2026-10-07:** option A, the two-pass reorder in one unit (Mojtaba's recommendation) |
| L5, L7 | `FOR NO KEY UPDATE` instead of `FOR UPDATE`; `lock_timeout` as a UnitOfWork option | **Decided by Mohammad 2026-10-07:** both accepted, architecture half. L5: no unit changes a key column of `stock_items`, mutual exclusion between lockers is unchanged, and the FK checks of lines and movements are no longer blocked (measured). L7: a platform option `UnitOfWorkOptions.lockTimeoutMs`, issued by `platform/persistence` as `SET LOCAL lock_timeout` as the first statement of the unit; `inventory` sends no raw `SET`. The option is added to P 3.1 with slice 2 (12). Hassan's confirmation of L5 stays open (R3) (D 4.2, 4.3, 4.4) |

### 11.3 Questions for others

| # | Question | Who |
|---|---|---|
| R1 | Retention of committed reservations whose lines are all fulfilled or cancelled. The returns restock (D 12.3) needs the link from order line to source for the returns window | Ali, with the ordering G2 and Hadi. **Open: ordering G2** |
| R2 | `checkout_ref` and `order_line_id` are assumed to be `uuid` | Ali, with the ordering G2. **Open: ordering G2** |
| R3 | `FOR NO KEY UPDATE` in the lock statement (L5); `lock_timeout` set as a UnitOfWork option rather than raw `SET LOCAL` in the module (L7) | Hassan (security); Mohammad for the platform option. Mohammad's half **decided** (11.2 L5, L7: `lockTimeoutMs`). **Open:** Hassan, security confirmation of L5 (his condition in D 4.4 named `FOR UPDATE`) |
| R4 | Pooler mode and statement caching (generic plans): the design is now safe under both, but Kazem should know that the held-sum shape is part of the contract. `lock_timeout` and `statement_timeout` on the application role (ID K1) | Kazem |
| S1 | Spike: Prisma 7 composite relations of three and four columns, one of them with a `timestamptz` (8.4); the SQL Prisma generates for the `groupBy` of 4.3; the `40001` rate of serializable stock writes | Hossein, with me. **Open: Hossein's Prisma spike** |
| C1 | The Market configuration keys of D 8 in `config/markets/*.json` (a shared-file PR) | Hossein (backend track), announced on the board |
| V-1 | Physical impact of the re-key (D 3.6): CHECK values `re-key` (3.5) and `offer-moved` (3.6) written into migrations 2 and 3 from the start, so **no new migration**; no new index (the inventory-key prefix, the held index and the tombstone keys serve every read); no new grant (the column lists of 7 already cover it); no key column is updated, so the `ON UPDATE RESTRICT` foreign keys of C3 and the append-only ledger are untouched. The lock-set cap is decided (Ali 2026-10-07: no chunking; at most 800 items under `catalog.maxVariantsPerProduct` = 100 (AU; ZZ 3), set by catalog G2 (merged PR #54), and `inventory.maxSourcesPerSeller` = 4, confirmed by Hadi; 4.3); Hassan's design review (no Critical or High; M1, M2 applied in 4.4) | Variant cap closed by catalog G2; Hassan (code review mandatory before slice 2 merges, D 14.1 V-1b) |

### 11.4 G2 verdict (2026-10-07)

Catalog G2 is merged (PR #54, 0bad228); its 9.7 and 18 accept D 13 as ruled and differ from the draft 25cbf3a only by additions this design already follows. **Ali (cto), final verdict: approve with conditions** (tier A): Hassan reviews the re-key handler's code before slice 2 merges (V-1b); Hossein's Prisma spike (S1) and Kazem's timeouts (R4) before slice 2; ordering's G2 re-confirms the ordering port and slice 5 (R1, R2); Mojtaba signs off each migration; no UI slice before Reza's `ux.md` and the Figma-first design-system update (ADR-0017). Approvers: Mohammad (software-architect), Ali (cto), Mojtaba (database-designer), Hassan (security-tester). **Bagher (qc-release-manager), final check:** merges cleanly with main, touches only this module's files, no blocking open finding. Follow-up: Reza (ui-ux-designer) pending, UI condition.

## 12. Follow-up changes

This document changes no other file. After G2:

| File | Change | When |
|---|---|---|
| `docs/design/data/inventory.md` | This document, with the review answers | At G2; Mojtaba |
| `docs/design/domain/inventory.md` (D 4.3, 4.4, 11, 14) | F1, F2, M2, M8; Q-M1 closed; L5 and L7 if Hassan agrees | At G2; Mohammad |
| `docs/design/domain/platform-persistence-and-events.md` | The raw-helper section that P 4.2 announces (the named list, Market and tenant binding, refusal rules) and the `lockTimeoutMs` option | With slice 2; Mohammad and Hassan |
| `prisma/schema/base.prisma`, `inventory.prisma`; migrations 1 to 5 with `down.sql` | As specified; each needs my sign-off | Per slice; Hossein |
| The privilege map and catalog tests of `pnpm test:db` | Section 7 with its column lists; the partial-index list of 8.4 | With each migration; Hossein |
| `config/markets/*.json` and its validation | The keys of D 8 (C1) | Before slice 2; shared-file PR |

## 13. As built

**Migration 2, `inventory_stock` (slice 2, part 1; no application code yet).** Creates `outbox`, `stock_items`, `stock_movements`, `availability_signals` and `retirements` exactly as 3.1, 3.4, 3.5, 3.9 and 3.10 specify, with every CHECK of those sections, the three partial indexes of 8.4 that belong to them (the relay's claim and the two tombstone keys) and the grants of section 7. `re-key` is among the ledger reasons from the start (V-1), so the re-key handler adds no migration. The privilege map, the partial-index catalog and `inventory-stock-constraints.db-spec.ts` (both Market fixtures) cover it. Not in this migration: reservations (migration 3), the raw helper and `lockTimeoutMs` (a platform change that lands with the first use case that locks), the use cases and handlers (slice 2, parts 2 to 4). Mojtaba's sign-off on the migration is recorded on the PR.

**Slice 2, part 2 (platform change, no migration).** The raw helper P 4.2 announces landed with `inventory.lock-stock-items` exactly as 4.3 specifies (`FOR NO KEY UPDATE OF s`, `ORDER BY s.id`, `market_id` and `tenant_id` bound by the helper from the open unit, `uuid[]` ids deduplicated, 1 to 1,000, a short answer fails the call) and the UnitOfWork option `lockTimeoutMs` (L7). The guard recognises the statement by its exact text because Prisma copies the `Sql` object before the extension runs. `lock-stock-items.db-spec.ts` proves it for both Market fixtures: ascending order, another Market's id fails the whole call, a second locker waits and ends with 55P03 after `lockTimeoutMs`, a ledger insert on a locked item is not blocked (L5), and 24 crossing units asking in opposite orders never deadlock.

**Slice 2, part 3 (no migration): `inventory.set-stock-level`.** The seller's stock write, in a `serializable` unit opened by the module's own `runSerializable` (the repository writers `insertItem` and `setOnHand` fail closed outside it). Order inside the unit follows 4.4: the seller's inventory proves the source is theirs, the sell unit's items are read and locked with `inventory.lock-stock-items` (an item of another seller on the sell unit, a tombstone or a retired item answers `inventory.not-found`, like an unknown Offer or source, AC 11), the expected `version` is checked (`null` for a source with no item yet; a mismatch is `conflict.stale`), the level is refused below what is held (`inventory.stock.below-held`, `details.min`; the held quantity is 0 until slice 4 brings the reservation tables, and `heldQuantities` then counts them), the item is inserted or updated with a guarded `updateMany`, one `seller-set` movement is written (none for a new item at 0 or for an unchanged level, M4) and the signal is recomputed from the largest non-retired source. A changed signal is created at version 1 or updated, and `availability-changed.v1` (plus `low-stock-reached.v1` on the first entry into `low` from `in-stock`, one version later) goes to the outbox in the same unit. The low-stock threshold is the seller's override, else the new Market key `inventory.defaultLowStockThreshold` (0 to 99; AU 10, ZZ fixture 3). Until catalog slice 7, catalog's fail-closed `offerSellUnits` answers every Offer as absent, so the use case answers `inventory.not-found` in production; the route and the acting-as refusal (a compile-time tripwire spec, SEL-08) come later. `inventory-set-stock-level.db-spec.ts` proves it for both Market fixtures, including two simultaneous first writes (one item, one winner).
