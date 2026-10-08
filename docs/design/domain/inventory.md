# Inventory — G2 domain design

**Author:** Mohammad (software-architect) — 2026-10-07
**Status:** G2 approved with conditions 2026-10-07 (Ali, cto, final verdict; Bagher, QC, final check; 15). Ali (cto) approve with changes and Hassan (security-tester) accept with changes applied 2026-10-07; catalog G2 is merged (PR #54) and its 9.7 and 18 accept section 13 as ruled, with request V-1 applied 2026-10-07 (3.6). Mojtaba's data design (docs/design/data/inventory.md) answered 2026-10-07 (14.2, 15). Follow-up: Reza (ui-ux-designer) pending for brief s12 (UI condition, 15). Open: section 14.1; review record: section 15.
**Ground truth:** `docs/modules/inventory/brief.md` (G1 approved by the owner 2026-10-07; sections, owner answers and acceptance criteria are cited as "brief s5", "Q9", "AC 3"; the role-review table as "review"); `docs/features/02-catalog-inventory.md` section 7 (INV-01..07; INV-07 is the checkout reservation the brief left without a code); ADR-0001, 0003, 0004, 0005, 0006, 0008, 0009, 0013, 0018, 0020, 0022, 0023, 0024; `docs/design/domain/platform-persistence-and-events.md` ("PE 3.1"); `docs/design/domain/platform-foundations.md` ("PF 6.2"); `docs/design/domain/identity.md` ("ID 3.3"); the briefs of `catalog`, `sellers`, `cart` and `pricing` (G1 or combined-gate domain part approved). The `catalog` G2 is approved and merged (PR #54); the `catalog` names used here (`offerSellUnits`, the events of its 9.4) are those of `docs/design/domain/catalog.md` (cited as "CAT 9.1"), and a later change to them means a mini-review here (13).

## 1. Scope

A design, not an implementation. Signatures appear only where the signature is the contract.

- **Decided here:** domain model (2), state machines (3), concurrency and allocation (4), caps, thresholds and exposure (5), authorisation (6), facade and events (7), dimensions (8), enforcement points (9), idempotency (10), jobs (11), slices (12), dependencies (13).
- **In Mojtaba's data design** (`docs/design/data/inventory.md`, written from this model): tables, columns, constraints, indexes, the lock statements (4.4), retention.
- **In the platform document:** UnitOfWork, outbox, inbox, `runOnce`, scheduler, `market_id` guard, raw-SQL helper rule (PE 4.2). Here: only what `inventory` needs from them.
- **Not decided here:** anything the brief does not say; those items are open questions (14) or deferred (12.3).

### 1.1 Brief slices and where they are covered
| Slice (brief s11) | Covered in |
|---|---|
| 1 Sources: Default on approval, more sources, priority order (INV-01, SEL-10) | 2.1, 3.4, 7.3, 10 |
| 2 Seller set/adjust stock (upsert), ledger, "not below reserved" (OFR-02 stock part); the re-key handler (V-1) | 2.1, 3.6, 4.5, 9 |
| 3 Read facade: status, sellable, threshold, "only N left" (INV-04) | 5.2, 5.3, 7.1 |
| 4 All-or-nothing reservation, expiry, per-customer cap, concurrency test (INV-07) | 3.1, 4, 5.1 |
| 5 Commit, release, fulfil for `ordering` (INV-03; with Phase 5) | 3.1, 3.2, 7.2, 10 |
| 6 P1: Manage Stock off (INV-02) | 12.3 (seam only) |

## 2. Domain model

### 2.1 Aggregates
Every aggregate root carries `marketId`, `tenantId` (ADR-0003 decision 3, ADR-0020 decision 6), an `Id` from the injected generator and a `version` (PE 10). References across aggregates and modules are ids. Quantities are integers (Q6); a fractional quantity is refused at the value-object constructor (`Quantity`, positive integer; `StockLevel`, non-negative integer).

```
SellerInventory (one per seller per Market)
  |-- InventorySource (1..n; exactly one isDefault; ordered by priority)
  '-- lowStockThreshold (optional override)
StockItem (one per (offerId, variantId, sourceId))      <- the lockable unit
Reservation (holder account, checkoutRef)
  '-- ReservationLine (1..n; one per (offerId, variantId); sourceId, stockItemId, qty)
OfferPurchaseLimit (one per offerId, optional)
AvailabilitySignal (one per (offerId, variantId))       <- last published public status
StockMovement (append-only ledger entry; not an aggregate root, written with StockItem)
```

| Aggregate | Holds | Invariants it owns |
|---|---|---|
| `SellerInventory` | `sellerId`; its sources (each: id, name, optional address, optional IANA zone, `isDefault`, priority position); the optional low-stock threshold | One per (Market, seller), unique constraint. Exactly one Default source. A source name is 1 to 80 characters with no outer spaces; an address, when present, is an inventory-owned `SourceAddress` value object (M3). Priority positions form a gap-free order 1..n with no duplicates. At most the Market's `inventory.maxSourcesPerSeller` sources (AU 4; 3.4). A threshold is an integer from 0 to 99 (Hassan finding 9: a very high value would make the exact count public). Created only by the approval handler (3.4) |
| `StockItem` | `offerId`, `variantId`, `sourceId`, `sellerId` (the source owner), `onHand`, `retiredAt` (null or instant) | Key (Market, offer, variant, source) is unique (brief s5, ADR-0010 decision 2). `sellerId` equals the source's seller and the Offer's seller (checked at creation, 9). `onHand` ≥ reserved-active + pending (4.5). A retired item takes no new reservation and no stock write. Every `onHand` change appends one `StockMovement` in the same unit |
| `StockMovement` | stock item id, signed delta, resulting `onHand`, reason code (closed enum: `seller-set`, `shipment`, `restock`, `re-key` (3.6)), actor kind and id (account id or module name), the acting-as account id once SEL-08 exists (Hassan finding 8), correlation id, `occurredAt` | Append-only, never updated or deleted (brief s5; ADR-0009 pattern V4) |
| `Reservation` | `holderAccountId` (the customer), `checkoutRef` (ordering's id for this checkout), status, the release cause when `RELEASED` (`superseded`, `cancelled`, `payment-failed`, `customer`, or `offer-moved` (3.6); Ali), `expiresAt` (UTC instant), `createdAt`, lines (each: `offerId`, `variantId`, `sellerId`, `sourceId`, `stockItemId`, `quantity`, `orderLineId` once committed, line status) | One line per (offer, variant). All lines in the reservation's Market. At most one ACTIVE reservation per (Market, holder) (unique partial constraint; brief s5). The lines are all reserved together or not at all (4.2). `expiresAt` = `createdAt` + the Market's reservation duration (Q2). Persistence adds `statusChangedAt` on the reservation and `stateChangedAt` on each line, and each line keeps a copy of `expiresAt` and, until commit, a state that mirrors the header's status, written in the same unit (M2; the repository test asserts the mirror). A line's `sellerId` and `sourceId` are loaded from its stock item, not stored on the line |
| `OfferPurchaseLimit` | `offerId`, `sellerId`, `maxPerCustomer` | 1 ≤ value ≤ the Market's line ceiling, read from platform `MarketConfig.maxLineQuantity` (AU 99; brief s5, cart Q6; Ali A2 rule, 8). Owned by the Offer's seller (9) |
| `AvailabilitySignal` | `offerId`, `variantId`, last published status (`IN_STOCK`, `LOW`, `OUT`) and `onlyLeft` | Changed only when the status or `onlyLeft` actually changes. Its version is the `aggregateVersion` of `inventory.availability-changed.v1`, so consumers can drop stale events (ADR-0006 decision 3) |

### 2.2 What is deliberately not an aggregate of `inventory`
| Thing | Why |
|---|---|
| Reserved and pending counters on `StockItem` | Derived at read time from reservation lines (4.1). A stored counter would need the expiry job to stay correct, against brief s4 flow 5 |
| A "sellable now" flag or read model | Composed at read time by cart and `ordering` (ADR-0024 decision 5) |
| Seller access state, may-sell | `identity` and `sellers` (ADR-0022); `inventory` does not check it (brief s5, Q5) |
| Price, Cost | `pricing`; never imported (brief s5, ADR-0024 decision 5) |
| Offer and Variant validity | `catalog`, asked through its public facade only (`offerSellUnits`, CAT 9.1); `inventory` keeps only retirement tombstones from its events (3.5) and re-keys on a move (3.6) |

### 2.3 Modelling choices that need a reason
| Choice | Reason | Cost |
|---|---|---|
| Sources live inside `SellerInventory`, not as their own roots | Priority order and "exactly one Default" span all sources of a seller; one root, one version, keeps them consistent without a lock | Editing one source bumps the seller's version, so two edits by the same seller at the same moment get a `conflict.stale` |
| `StockItem` separate from the source | It is the unit that concurrent checkouts contend for; one row per lockable unit keeps locks narrow | One more aggregate |
| Reservation state per line after commit | `ordering` keys commit, cancel and fulfil by order line id (brief s6); a multi-seller order is cancelled or shipped per seller | Reservation-level FULFILLED/CANCELLED become derived (3.1) |
| `AvailabilitySignal` stored | The public status changes when a reservation expires, which no write observes (it is derived). A stored "last published" lets every writer, and the expiry job, publish only real changes, with a version | One small row per sell unit |

## 3. State machines

Every transition is one use case with one read-write unit of work (PE 3.1 row 5), its time from `Clock`. A transition not listed is forbidden.

### 3.1 Reservation (holding phase)
| From → to | Trigger and guard | Effects | Serves |
|---|---|---|---|
| (none) → `ACTIVE` | `reserve` (ordering port, customer actor). Guards: every line is allocated (4.2), every line within the per-customer cap (5.1), no line on a retired item. Refused in an acting-as session (Hassan finding 8). The holder's earlier ACTIVE reservation, expired or not, is moved to `RELEASED` with cause `superseded` in the same unit | `expiresAt` set; availability signals recomputed (5.3) | INV-07, AC 1-3, brief s5 anti-hoarding |
| `ACTIVE` → `COMMITTED` (also `EXPIRED`, or `RELEASED` with cause `superseded`, → `COMMITTED`) | `commitReservation` (ordering port, system). The `checkoutRef` given must match the reservation's, else `inventory.commit-mismatch` (Hassan finding 5). Not expired at `Clock.now()`: lines unchanged. Expired (status still `ACTIVE` past `expiresAt`, or already `EXPIRED`) or `RELEASED` with cause `superseded` (the same holder's newer checkout; Ali, Q-A2): allocation is run again under lock for the same lines; if all fit, lines are re-pointed to the chosen sources and committed, else the answer is `inventory.insufficient` and the reservation keeps its status (brief s6). `RELEASED` with any other cause (`cancelled`, `payment-failed`, `customer`) is final: refused with `inventory.insufficient`, nothing taken (Ali, Q-A2) | Each line gets its `orderLineId` and line status `COMMITTED` (pending ordered qty, INV-03) | INV-03, brief s4 flow 4 |
| `ACTIVE` → `RELEASED` | `releaseReservation` (system; cause `payment-failed` or `cancelled`, given by `ordering`) or `releaseOwnReservation` (customer, own-resources; cause `customer`), or a newer `reserve` by the same holder (cause `superseded`) | The cause is stored (Ali); stock is sellable again at once; signals recomputed | brief s4 flow 5 |
| `ACTIVE` → `EXPIRED` | Derived at read time once `Clock.now()` ≥ `expiresAt`; the status column is set by the cleanup job (11) | Job publishes signal changes | AC 4 |

### 3.2 Reservation line (after commit)
| From → to | Trigger and guard | Effects | Serves |
|---|---|---|---|
| `COMMITTED` → `FULFILLED` | `recordShipment(orderLineId)` (ordering port, system) | Same source's `onHand` − qty with a `shipment` movement; the line stops counting as pending | INV-03, AC 5 |
| `COMMITTED` → `CANCELLED` | `cancelCommittedLine(orderLineId)` (ordering port, system) | Qty sellable again; signals recomputed | brief s6 |

Derived reservation status after commit: `COMMITTED` while any line is `COMMITTED`; then `FULFILLED` if any line is fulfilled, else `CANCELLED`. Forbidden: `RELEASED`/`EXPIRED` → `ACTIVE`; `RELEASED` (any cause but `superseded`) → `COMMITTED`; `COMMITTED` → `RELEASED` (cancel a line instead); `FULFILLED` → anything (a return adds stock with a reason, 12.3); committing a subset of lines; any transition from a client HTTP call except `releaseOwnReservation` through `ordering`. Partial shipment or cancellation of a line is not in the brief: a line is fulfilled or cancelled whole at launch (decided by Ali, Q-A5); a quantity parameter can be added later at the ordering or returns gate.

### 3.3 Stock item
`active` → `retired` only (catalog Offer deleted or Variant removed, 3.5); `retiredAt` is never cleared, also when a Variant tombstone is later cleared (M6, fail closed; catalog G2, merged PR #54, never reuses a removed Variant id, CAT M-1). Retired items keep their committed lines: fulfil and cancel still work on them; new reservations and seller writes are refused. ACTIVE reservations on them stay until expiry (Q5, AC 6).

### 3.4 Seller inventory and Default source (SEL-10)
| From → to | Trigger | Effects |
|---|---|---|
| (none) → exists, with one Default source | Consumed `identity.seller-access-approved.v1`, or `identity.seller-registered.v1` whose `accessState` is `approved` (the "approval required off" path before ADR-0022 decision 5 lands; ID 3.3). Handler as system actor, Market from the envelope | Default source, priority 1, created with no address and no zone; the seller's zone is implied (Q-H2, Hadi 2026-10-07: no `sellers` facade dependency at launch; an address can be added later). Idempotent twice over: inbox `(event_id, handler)` and the unique (Market, seller) key; a second approval (re-apply, reinstate) finds it and does nothing (AC 10) |

Seller use cases then add sources (appended last), rename them, and reorder. Adding a source is refused with `inventory.sources.limit-reached` when the seller already has the Market's `inventory.maxSourcesPerSeller` sources (AU 4, the Default included; Ali 1, confirmed by Hadi 2026-10-07 as a product default). The setting is per Market and can be raised; the error tells the seller the limit and that it is a platform limit. Raising it needs a re-check of the re-key's lock-set bound (3.6 step 2, 800 items). Delete or archive of a source is not in the brief (12.3).

**As built in slice 1 (2026-10-08).** `identity` publishes only `identity.seller-registered.v1` today, so `inventory.ensure-seller-inventory` subscribes to that event alone and acts only when `accessState` is `approved` (a Market with approval off, ZZ in the fixtures). With approval required (AU) a new seller gets no inventory until `identity.seller-access-approved.v1` exists. The event stays `identity`'s (identity design 8.2: `sellerId`, `decisionId`; sellers design 7.4 consumes the same event in `sellers.close-decision`); it is published when an admin's approval goes through `identity`, which is `sellers` slice 7a-decide (ADR-0022 decision 4), not yet merged. The handler gains that second subscription in the PR that merges the publisher, and until then a pending seller has no sources. The Default source is stored with the name `Default` (a stored text; the seller can rename it, and the panel marks it with the Default badge). The module checks at start-up that every hosted Market has the `inventory` configuration section (`maxSourcesPerSeller`, 1 to 5; the ceiling keeps 100 variants x 5 sources x 2 keys at the lock helper's 1,000 items, 3.6 step 2). The use cases that list, add, rename and reorder sources use the access rule `permissions`, which `identity` denies until its slice 8a brings the permission registry and role keys; they follow in the next part of slice 1.

### 3.5 Catalog retirement tombstones
`catalog.offer-deleted.v1` and `catalog.variant-removed.v1` (CAT 9.4) retire matching `StockItem`s and record a tombstone (offer, or offer+variant), so a stock upsert that arrives later does not re-create a retired row (events are unordered, ADR-0006 decision 3). `catalog.offer-created.v1` and `catalog.variant-added.v1` need no action (upsert creates rows, brief s4 flow 2); `variant-added` clears a variant tombstone only if its `aggregate_version` is newer (catalog never reuses a removed Variant id, CAT M-1, so this never happens; it stays as a harmless rule). `retire-sell-units` runs `serializable`, as does `set-stock-level` (4.5): creating the first stock item while the same sell unit is retired is a write skew no row lock stops (F2, measured; PE 3.1 rows 6 and 7).

### 3.6 Offer moved to a platform product (CAT-45; request V-1, decided by Ali 2026-10-07)
When a seller's never-published duplicate product is matched to a PLATFORM product, the same Offer id moves to the target product and `catalog` publishes `catalog.offer-moved.v1` (`offerId`, `fromProductId`, `toProductId`, `variantMapping: {from, to}[]`; CAT 4.5, 9.4). `catalog` publishes no `variant-removed` for the matched duplicate's variants (the product is terminal; CAT 9.7), so `inventory` must re-key on this event or the Offer's stock is stranded on dead keys. "The seller re-enters stock" was rejected because it loses data (Ali).

Handler `inventory.rekey-moved-offer` (slice 2, before catalog slice 16; step 4 joins with slice 4, when reservations exist): system actor, Market from the envelope, inbox `runOnce`, one unit, `serializable` (as `retire-sell-units`, 3.5: it creates first stock items and tombstones, the F2 race).
1. **Validate the mapping** outside the unit, before any read (Hassan Low): at most the Market's `catalog.maxVariantsPerProduct` pairs (AU 100, ZZ 3; catalog G2, merged PR #54); every `from` and every `to` distinct; no `from` shares an id with a `to`; `fromProductId` ≠ `toProductId` (Hassan M1). Then **check the event against catalog** (Hassan M1): call `catalog.offerSellUnits` as the system actor (CAT 9.1) for the Offer; proceed only if the Offer is present, its `status` is not `deleted`, its `productId` equals `toProductId`, and every `to` is one of its `sellUnits`. A malformed mapping or a failed check changes nothing: the handler fails and the delivery takes the platform's failed-delivery path, with an alert (it is a catalog bug, or a forged or stale event).
2. **Lock** (4.3): read the ids of every stock item of (Offer, `from`) and (Offer, `to`) for every pair, all sources, retired included, plus every stock item of every other line of the live reservations found in step 4 (a second read, then one lock call with the union); one `inventory.lock-stock-items` call in ascending id order, never split into chunks (Ali 1, V-1a). Its size is bounded by two Market settings: `catalog.maxVariantsPerProduct` (AU 100, ZZ 3; set by catalog G2, CAT 7.1, 13) and `inventory.maxSourcesPerSeller` (4 at launch, 3.4), so at most 100 × 4 × 2 = 800 items plus the items of held reservations (expected none). Above the helper's 1,000 cap (4.4) the handler fails with an alert and an operator moves the stock; this is a backstop only. Every read after the lock is a new statement.
3. **Tombstones first:** if an Offer tombstone exists (`offer-deleted` arrived first; events are unordered), only retire what is left and stop. If a variant tombstone covers (Offer, `to`), that pair moves nothing; its source items are retired (fail closed, as a removal would), and the handler logs a structured warning `inventory.rekey.stock-dropped` with the Offer, both variants, the source and the quantity retired without moving (Ali 4).
4. **Live reservations:** an Offer whose product was never published is absent from `offerListings`, so no cart line and no reservation should exist on it. Fail-safe: every ACTIVE, unexpired reservation with a line on a source sell unit is `RELEASED` with cause `offer-moved` (final, like `cancelled`: a commit after it is refused, 3.1), header and lines in the same unit (Ali 2, accepted). A reservation is one hold for the customer's whole checkout, so the release drops all its lines, other sellers' lines included; a later `commitReservation` returns the existing refused error (3.1, 7.2), and the customer starts checkout again. Each released reservation is logged as `inventory.rekey.hold-released` with the reservation id and the event's correlation id (Ali 2, Hassan Low). Committed lines are not moved: their units stay as pending on the old item, where fulfil and cancel still work (3.3); the handler logs a structured warning `inventory.rekey.pending-left`, since that also needs a bug upstream (Ali 3: accepted as is).
5. **Re-key, per pair and per source:** for every non-retired stock item of (Offer, `from`) in source S: `moved = onHand − pending(S)`; a negative value (which the invariant of 4.5 forbids) is clamped to 0 with an alert (Hassan Low). If the (Offer, `to`, S) item does not exist, create it with `onHand = moved` and write a `re-key` movement `−moved` on the old item and `+moved` on the target (no movement when `moved` is 0, M4), both with the event's correlation id. If it **already exists** (a stock write on the new key, possible only after catalog published the move), nothing is added to it (Hassan M2): the seller's later write is the intended total, so the target keeps its value; only the `−moved` movement is written on the old item, and the handler logs `inventory.rekey.target-exists` with the Offer, the `to` variant, the source and `moved`. Then retire the old item (`retiredAt`) and record a variant tombstone (Offer, `from`) with the event's `aggregate_version`, so a stock write that passed the advisory ownership check before the move cannot re-create it (4.5).
6. **A `from` stock item with no mapping entry** (catalog's mapping is total over non-retired variants, so this is a variant already removed, or a bug): retired with a tombstone, nothing moved, warning logged.
7. **Not moved, because keyed by Offer only:** `OfferPurchaseLimit` (the Offer id and its seller do not change, CAT 2.1). The ledger is append-only: past movements keep the old (Offer, Variant); history is never rewritten, and the pair of `re-key` movements links old and new.
8. **Signals:** recompute every old and new sell unit (5.3): the old ones go to `OUT`, the new ones get their first signal; events as usual.

**Replay:** a second delivery of the same event is stopped by the inbox; a delivery with another event id finds the old items already retired and the tombstones present and moves nothing (retired items are never moved). A later `variant-removed` for a `from` variant (catalog sends none) would only retire already-retired items.

## 4. Concurrency and allocation

### 4.1 Sellable quantity
Per source: `sellable(s) = max(0, onHand − Σ qty of lines with reservation ACTIVE and expiresAt > now − Σ qty of lines COMMITTED)` (brief s5). The `max(0, …)` is a defensive clamp; the invariant of 4.5 keeps it non-negative. Per (offer, variant): the largest `sellable(s)` over its non-retired sources (Q10). That number drives "only N left", the customer cap's "half" and the read facade.

**Toss-up T1: derive reserved and pending, or store counters.** Decided by Ali 2026-10-07: option A. One source of truth, and correctness never depends on the scheduler. Mojtaba sizes the index; slice 4's concurrency test also measures the read cost.
| Option | For | Against |
|---|---|---|
| A (decided). Sum lines at read time (index on stock item, status, expiresAt) | One source of truth; expiry needs no job (brief s4 flow 5, risk "scheduler down"); no drift | A grouped sum on every read; Mojtaba sizes the index |
| B. Counters on `StockItem` updated in each transaction | Constant-time reads | Expiry must decrement counters, so correctness depends on the job; two places to keep consistent |

### 4.2 The reservation transaction (all-or-nothing)
One `reserve` call carries all lines of a multi-seller cart (CRT-01) and is one read-write unit (brief s5):
1. Outside the unit: validate input (integer quantities, unique (offer, variant) lines, at most 50 distinct lines per call, else `inventory.batch.too-large` (Hassan finding 3), Market from `MarketContext`), refuse an acting-as session (Hassan finding 8), apply the rate limit (5.4), read the sellers' `SellerInventory` priority orders and `OfferPurchaseLimit`s.
2. Open the unit (READ COMMITTED) with the UnitOfWork option `lockTimeoutMs: 3000`, which `platform/persistence` issues as `SET LOCAL lock_timeout` as the unit's first statement (L7; `inventory` sends no raw `SET`); a lock timeout maps to `conflict.retry` (Hassan finding 3). **Lock set** = every non-retired `StockItem` of every requested (offer, variant), all sources, plus every `StockItem` of the holder's current ACTIVE reservation. Lock them with one `SELECT … FOR NO KEY UPDATE` in **ascending `StockItem` id order** (4.4; L5).
3. Release the holder's previous ACTIVE reservation (status `RELEASED`).
4. With the locks held, compute `sellable(s)` per locked item (a new statement, so it sees every reservation committed before the lock was granted).
5. Check each line's per-customer cap (5.1) **before** allocation (Hassan finding 1).
6. For each line, in request order, pick the first source in the seller's priority order with `sellable(s) ≥ qty` after the earlier lines of this same call (two lines never share a unit). No source fits → the line fails. A line is never split (Q3, Q9, AC 2).
7. Any failure: return `err` (`inventory.insufficient` with failing line keys and a reason code: `out`, `not-enough`, `over-limit`, `retired`); the unit commits nothing, so the release in step 3 is undone too (PE 3.1 row 3), and nothing is held (AC 3).
8. All fit: insert the reservation and lines, recompute availability signals, append events, commit.

Two concurrent calls for the last unit serialise on the same `StockItem` lock; the second sees the first's line in step 4 and fails (AC 1). The same-holder race is caught by the unique "one ACTIVE per holder" constraint (`P2002` → `conflict.retry`).

### 4.3 Lock-order rule (deadlock avoidance)
Every unit that writes reservation lines, `StockItem.onHand`, retirement or an `AvailabilitySignal` **first** locks every affected `StockItem` in ascending id order, in one statement, and takes no other explicit lock. **The lock set is every stock item of every affected sell unit, all sources, retired items included** (F1): reserve, commit re-take, commit, release, line cancel, shipment, stock write, retirement, the re-key handler (3.6) and the expiry job. A sell unit's signal is the maximum over its sources (Q10), so a unit that locked only its own source could compute it from another unit's old value. The ids are read first, then locked in one call; allocation uses only the locked items, and every read that decides something after the lock is a new statement (inventory-data L1 to L3). `reserve` may leave retired items out of its own lines' set. The hourly prune of terminal reservations (11) takes no stock lock: it deletes only rows no sum reads (M7). After that it may update reservation rows and signals (their write locks come after the stock locks in every unit, so no cycle forms). Units that touch only `SellerInventory` or `OfferPurchaseLimit` take no stock lock. If PostgreSQL still reports `40P01`, the UnitOfWork retries (PE 3.1 row 7).

### 4.4 Raw SQL
Prisma cannot express `FOR UPDATE`. PE 4.2 says the first repository that needs a row lock brings a raw helper approved by Mojtaba and Hassan: named statements on a checked-in list, the Market bound by the helper as the first parameter, each proven by a two-Market database test. `inventory` is that first repository. List: `inventory.lock-stock-items(market, ids[])` only (Hassan, security half of Q-M1); the held sum uses Prisma `groupBy`, not raw SQL. Conditions (Hassan): the helper binds Market and tenant from the unit, never from the caller; the ids go in as one `uuid[]` parameter; `$queryRawUnsafe` is banned by lint; the statement is `ORDER BY id FOR NO KEY UPDATE` (L5: no unit changes a key column of `stock_items`, and the weaker lock does not block the foreign-key checks of lines and movements; Mohammad accepted, Hassan's confirmation open, 14.1), the helper also binds the tenant, its id list length is capped (1,000; the re-key's bounded set of 800 fits under it, 3.6 step 2), and the call fails if fewer rows come back than were asked for; the Market guard allows it inside the unit by name only; a two-Market test shows that a foreign-Market id locks and returns nothing. Mojtaba approved the statement (inventory-data 4.3; Q-M1 closed, 14.2).

### 4.5 Seller stock writes
`setStockLevel` (upsert by (offer, variant, source)): outside the unit, ask `catalog.offerSellUnits(ctx, offerIds)` (CAT 9.1): the Offer must be present (unknown and other-Market ids are absent), its `sellerId` must equal `ActorContext.sellerId`, its `status` must not be `deleted` (a deleted Offer is present with no sell units) and the Variant must be one of its `sellUnits` (non-retired variants, `proposed` included, so stock can be entered before the first publish); any failure answers "not found" (AC 11). Check the source belongs to the actor's seller. `offerSellUnits`, like every batch facade read, is **advisory** (ADR-0025 decision 1): the tombstones inside the unit are the backstop, and `ordering` re-checks at purchase. The batch limit is 200 ids; an oversized call is refused whole, never truncated. The unit runs `serializable` (F2; 3.5). Inside the unit: refuse if a tombstone covers the sell unit; create the row if missing (unique key decides a creation race, PE 10), else lock it (4.3) and check the client's expected `version` (a fulfilment in between gives `conflict.stale`); refuse when the new `onHand` < reserved-active + pending, with the minimum in `details` (exact numbers are fine for the owner, brief s5; AC 9); append a `StockMovement` (setting the same level is not a change: no movement and no version raise, M4); recompute the signal. Reservations do not bump `StockItem.version`, so traffic does not make the seller's form stale. A seller write on a moved Offer's new key that lands before the re-key (3.6) is the intended total: the re-key does not add to it (Hassan M2).

## 5. Caps, thresholds and exposure

### 5.1 Per-customer reservation cap (Q11, INV-07)
- **Value per line (Hassan finding 1; decided by the owner 2026-10-07, Q-O1):** if the Offer has an `OfferPurchaseLimit`, that value. Otherwise the half is calculated only from public data: when the (offer, variant) status is `LOW` (5.2), cap = `min(D, ceil(onlyLeft / 2))`; otherwise cap = `D`. `D` is the Market value (10 in AU; a different value in the synthetic fixture). Reason: with the current rule, threshold 10 and stock of 11–19, a customer can work out the exact stock in about 3 `reserve` calls, and the rate limit cannot stop it.
- **Replaced:** G1 answer Q11's `min(D, ceil(sellable / 2))` for stock 11–19 (AU); brief change-log row needed (Hadi).
- **Always:** never above the Market line ceiling (`MarketConfig.maxLineQuantity`, AU 99; Ali). The cap is checked before allocation (4.2 step 5).
- **Rounding:** up. Rounding down would make the cap 0 for one remaining unit, and AC 1 requires that one of two buyers gets the last unit.
- **Scope:** read as "units in the holder's reservation per (offer, variant) line", since one active reservation per holder is enforced and paid units are not reservations. Decided by Hadi 2026-10-07 (Q-H1): per (offer, variant) line, not the Offer's total across Variants, matching how sellable is counted (Q10); no brief change-log row.
- **Where the data lives:** `inventory` (`OfferPurchaseLimit`), as brief s6 already lists it. The seller types it in the inventory part of the Offer form, which the catalog brief (flow A step 5) composes from `pricing` and `inventory`. The Offer form puts inventory and pricing together in the client or BFF. `catalog`'s backend calls neither (ADR-0024 decision 5; Ali). No catalog scope or acceptance criterion changes: catalog stores no stock data (catalog AC 6). Only the UI part changes (brief s12).

### 5.2 Low-stock threshold (INV-04, Q7, Q8)
Effective threshold = the seller's override (0 to 99, Hassan finding 9), else the Market default (10 in AU). Status per (offer, variant): `OUT` when sellable is 0; `LOW` with `onlyLeft = sellable` when 0 < sellable ≤ threshold; `IN_STOCK` otherwise (AC 7: threshold 5, sellable 4 → LOW 4; sellable 7 → IN_STOCK). No stock row, or all retired → `OUT` (fail closed).

### 5.3 Availability signal
Every unit that may change a sell unit's sellable (reserve, release, commit re-take, cancel, fulfil, stock write, retirement, re-key, the expiry job) recomputes the status of the affected (offer, variant)s under the stock lock and, when status or `onlyLeft` differs from the stored signal, updates it and appends `inventory.availability-changed.v1`. The first entry into `LOW` (from `IN_STOCK`) also appends `inventory.low-stock-reached.v1`.

### 5.4 Exposure and anti-hoarding (Hassan's review)
- Public reads and events: status, and `onlyLeft` only when `LOW`. No exact number above the threshold (AC 8).
- `inventory.insufficient` carries reason codes, never a number.
- Exact sellable: only through the ordering port (7.2, `system` rule) and to the owning seller.
- No "fits / doesn't fit" answer for a requested quantity. The cap may be shown to the customer only when the seller set it or it comes from the public `onlyLeft` (decided by Hassan, Q-S1; any other answer gives away the exact number).
- Rate limits at the `reserve` entry, using the platform rate limiter (decided by Hassan, Q-S2; they also stop one account keeping a hold alive by re-reserving every 14 minutes, finding 4): per (Market, holder account) 6 calls per 15 minutes and 30 per 24 hours; per (Market, origin, IPv4 address or IPv6 /64) 30 per 15 minutes. A replay with the same `checkoutRef` and the same lines is not counted. Counters live in PostgreSQL with HMAC keys, as in ID 6.8. Over the limit the answer is `request.throttled`. If the limiter fails, `reserve` fails closed with `access.unavailable` (Hassan finding 6). It sits in `inventory`, so no `ordering` path can skip it.
- Structured warning logs give the alerts of brief s8 (Hassan, Q-S2): (a) one line takes at least 50% of the stock sellable before the reservation and at least 5 units ("large share"); (b) one account has 3 or more `RELEASED` or `EXPIRED` reservations of the same item within 24 hours.

## 6. Authorisation (ADR-0018 decision 4, PF 6.2)
Every use case extends the platform `UseCase` with one access declaration. Seller-scope use cases declare `whenSellerNotApproved: 'deny'`. Ownership is checked inside `handle`: the seller comes from `ActorContext.sellerId`, never from input; a resource of another seller or Market answers "not found" and the denial is logged (AC 11).

| Use case | Entry | Rule |
|---|---|---|
| `inventory.list-sources`, `inventory.get-stock` (own seller) | HTTP, seller panel | `permissions: inventory.stock.view` |
| `inventory.create-source`, `inventory.edit-source`, `inventory.reorder-sources` | HTTP | `permissions: inventory.source.edit` |
| `inventory.set-stock-level`, `inventory.set-purchase-limit` | HTTP (Offer form) | `permissions: inventory.stock.edit` |
| `inventory.set-low-stock-threshold` | HTTP | `permissions: inventory.settings.edit` |
| `inventory.admin-view-seller-stock` (stock and ledger of any seller) | HTTP, admin panel | `permissions: inventory.seller-stock.view` (platform scope, protected; Hassan finding 7); an audit row per read (brief s9) |
| `inventory.get-availability` | Public facade (cart, storefront) | `anonymous` |
| `inventory.reserve`, `inventory.release-own-reservation` | Ordering port, in the customer's request | `own-resources`: `holderAccountId` = the actor's account; customer population only (PF C6: customer resources join this kind at their module's gate); `reserve` is refused in an acting-as session (Hassan finding 8) |
| `inventory.get-sellable-exact` | Ordering port | `system` (Ali; Hassan finding 2: an exact count never sits behind `anonymous`, fail closed); also restricted by the import rule of 7.2, and no HTTP route. Dropped if ordering's G2 does not need it; if ordering needs it inside a customer request, ordering's G2 asks for it |
| `inventory.commit-reservation`, `inventory.release-reservation`, `inventory.cancel-committed-line`, `inventory.record-shipment` | Ordering port | `system` |
| `inventory.ensure-seller-inventory`, `inventory.retire-sell-units`, `inventory.rekey-moved-offer` | Event handlers | `system` |
| `inventory.expire-reservations` | Job | `system` |

Keys go into `modules/inventory/contracts/permissions.ts`. Only `inventory.seller-stock.view` is protected, so the admin Viewer role does not receive it automatically; in admin scope the Platform Administrator can still grant it (Hassan finding 7). When SEL-08 exists, every `StockMovement` written in an acting-as session stores the acting-as account (Hassan finding 8). Which default roles receive them (for example "Catalogue and Stock", ID 5.6) is the identity mini-review the brief names in s11.

## 7. Facade and events (`contracts/`)

### 7.1 Public facade (any module)
`getAvailability(ctx, items: {offerId, variantId}[])` → per item `{status: 'IN_STOCK'|'LOW'|'OUT', onlyLeft?: integer}`. One call per cart or page (brief s9), at most 200 keys; above that the answer is `inventory.batch.too-large` (Ali; matches pricing). It takes no requested quantity (Hassan, Q-S1).

### 7.2 Ordering port (`contracts/ordering-port.ts`; only `modules/ordering` may import it, enforced by a named boundary rule, the pattern of ADR-0022's consequences)
- `reserve(ctx, {checkoutRef, lines: {offerId, variantId, quantity}[]})` → `{reservationId, expiresAt, lines: {offerId, variantId, reservationLineId}[]}` or `inventory.insufficient`.
- `commitReservation(ctx, {reservationId, checkoutRef, lines: {reservationLineId, orderLineId}[]})`; `checkoutRef` must match the reservation's (Hassan finding 5).
- `releaseReservation(ctx, {reservationId, cause: 'cancelled' | 'payment-failed'})` (system) and `releaseOwnReservation(ctx, {reservationId})` (customer; cause `customer`).
- `cancelCommittedLine(ctx, {orderLineId})`, `recordShipment(ctx, {orderLineId})`; whole lines only (Q-A5).
- `getSellableExact(ctx, items[])` (`system`; dropped if ordering's G2 does not need it).
The source chosen per line is internal; `ordering` never chooses it. No method carries price or Cost (AC 14).
Commands from `ordering` reach `inventory` only through this port; `inventory` does not subscribe to ordering's events, so the dependency stays one-way, ordering → inventory (decided by Ali, Q-A1, option A). Input for ordering's G2 (Ali, Q-A2): commit before capturing payment, so a refusal is a void, not a refund.
This G2 approves slices 1–4. The ordering port and slice 5 are re-confirmed by a mini-review at ordering's G2.

### 7.3 Events published (outbox `inventory.outbox`, payload kinds from PE 5.3)
| Type | Aggregate | Payload |
|---|---|---|
| `inventory.availability-changed.v1` | availability-signal | `offerId`, `variantId`, `status` (enum), `onlyLeft` (optional integer, set only for `LOW`) |
| `inventory.low-stock-reached.v1` | availability-signal | `sellerId`, `offerId`, `variantId`, `onlyLeft` (integer ≤ threshold) |

Consumers treat both as signals, not truth (brief s6). No reservation events: `ordering` gets synchronous answers.

### 7.4 Events consumed (inbox `inventory.inbox`, `runOnce`, Market from the envelope)
`identity.seller-access-approved.v1` and `identity.seller-registered.v1` (3.4); `catalog.offer-deleted.v1` and `catalog.variant-removed.v1` (3.5), `catalog.offer-created.v1` and `catalog.variant-added.v1` (3.5, no action), and `catalog.offer-moved.v1` (3.6, V-1). Names from catalog G2 (merged PR #54, CAT 9.4).

## 8. Market, tenant and time
- `market_id` and `tenant_id` on every row; every repository takes `MarketContext`; the guard enforces equality with the unit's Market (PE 4.1). Second-Market fixture: different reservation duration, threshold and cap default (AC 13).
- Market configuration values: reservation duration (AU 15 min, Q2), default low-stock threshold (AU 10, Q8), default cap `D` (AU 10, Q11), sources per seller `inventory.maxSourcesPerSeller` (AU 4, 3.4; it bounds the re-key's lock set, 3.6), in inventory's own per-Market policy, checked at boot for every hosted Market, with no default. The line ceiling (AU 99) is read from platform `MarketConfig.maxLineQuantity`, not from `cart`: cart already imports inventory, so the reverse import would make a cycle (Ali; A2 rule: a value more than one module reads lives in `MarketConfig`). Nothing is hardcoded.
- `expiresAt` is a UTC instant from `Clock`; no raw `Date` arithmetic in `domain/`. No launch rule here depends on a local calendar. A source's IANA zone is stored for later fulfilment cut-offs (ADR-0005 decision 2); when absent it means "the seller's zone" (Q-H2, decided by Hadi: the Default source starts empty).
- PostgreSQL is the source of truth; no Redis cache at launch (a cache of availability would need its own security review, by analogy with ADR-0022's consequences).

## 9. Where each hard rule is enforced
| Rule (brief s5) | Enforcement point | Test |
|---|---|---|
| Sellable never negative; no oversell | `StockItem` invariant checked under the lock in reserve, commit re-take and stock write (4.2, 4.5) | AC 1, concurrency test |
| Sellable of a line = largest single source | `SellableCalculator` domain service, used by reads, caps and allocation | AC 2 |
| Source by seller priority, whole line | `AllocationPolicy` domain service inside the reserve unit | AC 2 |
| All-or-nothing | One unit; `err` commits nothing (PE 3.1 row 3) | AC 3 |
| Integers only | `Quantity` and `StockLevel` value objects | AC 12 |
| Expiry derived at read | `SellableCalculator` filters on `expiresAt > Clock.now()` | AC 4 |
| Retired Offer or Variant | `StockItem.retiredAt`; allocation skips; tombstones (3.5) | AC 6 |
| Stock follows a moved Offer (CAT-45) | `inventory.rekey-moved-offer` (3.6) under the stock lock; ledger keeps history | Two Markets: moved quantity equals `onHand − pending`; an existing target row keeps its value (Hassan M2); a mapping or Offer that fails the step 1 checks changes nothing; replay moves nothing; a pair without a mapping is retired |
| Not below reserved + pending | `StockItem.setOnHand` under lock | AC 9 |
| One ACTIVE per holder; cap | `Reservation` creation in `reserve`; unique partial constraint; `CustomerCapPolicy` (rule of 5.1, Q-O1), checked before allocation | AC 12 (cap); a test that the cap gives no information above the threshold |
| No exact count in public | Facade DTO and event definitions have no field for it; contracts snapshot test | AC 8 |
| Ledger for every change | `StockItem` methods return the movement; repository writes both in one unit | slice 2 test |
| Ownership by `seller_id` | `handle` of each seller use case + `offerSellUnits` ownership check (4.5; advisory, tombstones behind it) | AC 11 |
| No `pricing` import; catalog only through `index.ts` | Boundary rule (ADR-0008 decision 6) | AC 14 |

## 10. Idempotency
| Command | Key | Repeat behaviour |
|---|---|---|
| `reserve` | (holder, `checkoutRef`) | ACTIVE with the same `checkoutRef` and the same lines → returns it; different lines → new reservation, old released |
| `commitReservation` | `reservationId` + `checkoutRef` + the `orderLineId` per line | Already COMMITTED with the same mapping → ok, no change; different mapping or a `checkoutRef` that does not match → `inventory.commit-mismatch`; RELEASED with a cause other than `superseded` → refused (3.1) |
| `releaseReservation` / own | `reservationId` | Already RELEASED or EXPIRED → ok, the stored cause is not changed; COMMITTED → refused |
| `cancelCommittedLine`, `recordShipment` | `orderLineId` | Same terminal state → ok; FULFILLED → cancel refused; CANCELLED → shipment refused |
| Event handlers | inbox `(event_id, handler)` + natural keys | No duplicate Default (AC 10); `rekey-moved-offer`: retired source items and tombstones make a second run move nothing (3.6) |

## 11. Jobs
`inventory.expire-reservations`, every minute (worker role, per hosted Market, system actor). Bounded batches of ACTIVE reservations with `expiresAt ≤ now`, one unit per batch. Each batch locks the affected stock items (4.3), sets `EXPIRED` with `WHERE status = 'ACTIVE'`, recomputes signals and appends events. Safe to run twice and concurrently (PE 7). Correctness never depends on it (AC 4). `inventory.prune-reservations`, hourly: deletes `RELEASED` and `EXPIRED` reservations (lines by cascade) 30 days after their last status change, with no stock lock (M7; 30 days is enough because Hassan's alert (b) looks back 24 hours, 5.4). Retention of committed reservations is open for ordering's G2 (14.1).

## 12. Slices, design-system impact, deferred
### 12.1 Slices
As in brief s11; slice 4 carries the concurrency test (two Markets, N parallel reservers on one unit, crossing multi-seller carts in opposite order to prove no deadlock) and measures the read cost of T1 option A; slice 5 lands with Phase 5's ordering design. This G2 approves slices 1–4. The ordering port and slice 5 are re-confirmed by a mini-review at ordering's G2. Every slice gets a security-tester review (brief s9).
### 12.2 Design system (brief s12; for Reza, Figma first, ADR-0017)
- The inventory part of the Offer form: one stock field per source, the optional per-customer cap, and the "cannot go below N" error. The Offer form puts inventory and pricing together in the client or BFF. `catalog`'s backend calls neither (ADR-0024 decision 5).
- Sources list with reorder and the Default badge.
- Threshold setting.
- Low-stock card on the seller dashboard.
- Storefront labels "Only N left" and "Out of stock".
- The checkout's "not enough" message, without numbers.
### 12.3 Deferred (not in the brief or out of scope)
- INV-02 (P1): a per-Offer "track stock" policy owned here, with untracked lines carrying no source; designed in its own slice.
- INV-05 and INV-06.
- Import columns (OFR-11, OFR-12).
- Nearest source (with `shipping`).
- Returns restock: a `restockLine(orderLineId, qty, reason)` port shape only, decided at the returns gate.
- Delete or archive of a source; partial shipment or cancellation of a line (Q-A5); sync with external stock systems; a Redis cache.

## 13. Dependencies
- `catalog` G2: event names and versions; a batch facade answering "Offer owned by seller X, Variant of its product, in Market M"; confirmation that a Simple product has exactly one stable Variant id. This design assumes every sell unit has a Variant id. **Answered by catalog G2 (merged PR #54, CAT 9.7 and 18, accepted as ruled):** the events of CAT 9.4, `offerSellUnits` (CAT 9.1; 200 ids, refused whole above), the Simple invariant (CAT 2.1), and removed Variant ids never return (CAT M-1). Catalog adds `catalog.offer-moved.v1`, consumed here (3.6, V-1); catalog slice 16 (match) waits on that handler. **Set by catalog G2 (Ali, V-1a, 2026-10-07; CAT 7.1):** the Market setting `catalog.maxVariantsPerProduct`, AU 100 and ZZ 3, enforced on every variant add and bounding the offer-moved mapping, so the re-key's lock set stays bounded (3.6 step 2); the re-key handler also relies on `offerSellUnits` returning `productId` for the system actor (CAT 9.1; Hassan M1).
- `identity`: the permission catalogue mini-review and default roles; the audit writer for admin reads.
- Platform: the raw-SQL helper (4.4); the rate limiter; inbox and `runOnce` (delivery side from identity slice 3); `maxLineQuantity` in `MarketConfig` (with pricing's `pricesIncludeTax`), in a small shared-file PR announced on the board first (Ali).
- `ordering` G2: mini-review of the ordering port and slice 5 (7.2); whether it needs `getSellableExact`.
- PH4: separate api and worker database roles before the first deployed environment (PE 16, Kazem and Mojtaba). Not inventory-specific.

## 14. Open questions (minimal)

### 14.1 Still open
| # | Question | Who answers | Recommendation |
|---|---|---|---|
| R1 | Retention of committed reservations whose lines are all fulfilled or cancelled (inventory-data 11.3) | Ali with Hadi, **ordering G2** | — |
| R2 | `checkoutRef` and `orderLineId` as `uuid` (inventory-data 11.3) | Ali, **ordering G2** | — |
| R3 | `FOR NO KEY UPDATE` in the lock statement (4.4), security confirmation | Hassan | Accept (measured; Mohammad accepted the architecture half) |
| M5 | The seller dashboard's low-stock card query and its index (12.2) | Mohammad with Reza, with the card | — |
| M6 follow-up | Can a removed Variant id ever come back? | **catalog G2** | **Closed 2026-10-07:** catalog G2 (merged PR #54) answers no, never; ids are never reused (CAT M-1, 9.7). `retiredAt` stays one-way (3.3) |
| V-1a | Lock-set size of the re-key (3.6): (pairs × sources) items in one `lock-stock-items` call, capped at 1,000 ids (4.4) | **catalog G2** (the variant cap); Ali decided the rest 2026-10-07 | **Closed 2026-10-07:** catalog G2 (merged PR #54) set the Market setting `catalog.maxVariantsPerProduct` (AU 100, ZZ 3), enforced on every variant add (CAT 7.1; 13). No chunking (Ali). Inventory caps sources with `inventory.maxSourcesPerSeller` = 4, enforced on source creation (3.4; confirmed by Hadi 2026-10-07). Worst case 100 × 4 × 2 = 800 items plus held items (expected none); "fail with an alert, an operator moves it" stays only as a backstop |
| V-1b | Security review of the re-key handler (a system writer of stock across keys; cause `offer-moved` releases a customer's reservation) | Hassan | Design reviewed 2026-10-07 (15): no Critical or High; M1 and M2 applied (3.6). **Mandatory:** Hassan's review of the handler's code before slice 2 merges (Ali 6) |
| R4 | Pooler mode and statement caching; `lock_timeout` and `statement_timeout` on the application role | Kazem | — |
| S1 | Prisma 7 composite relations, the `groupBy` SQL, the `40001` rate of serializable stock writes | **Hossein's Prisma spike**, with Mojtaba | — |
| C1 | Market configuration keys of 8 in `config/markets/*.json` (shared-file PR) | Hossein, announced on the board | — |
| Q-O1 row | The brief change-log row for Q11 (Q-O1, 5.1) | Hadi, still owed | — |

### 14.2 Decided 2026-10-07
| # | Question | Decided by | Decision |
|---|---|---|---|
| V-1 | `catalog.offer-moved.v1` after CAT-45: re-key in `inventory`, or the seller re-enters stock? | Ali | Re-key with an idempotent handler (3.6); re-entry rejected, it loses data. Catalog slice 16 waits on the handler |
| V-1 review | The re-key design (3.6): lock-set bound, hold release, pending left, dropped stock, existing target row | Ali, Hassan, Hadi (source cap) | No chunking; `catalog.maxVariantsPerProduct` 100 (set by catalog G2), `inventory.maxSourcesPerSeller` 4 (Hadi: product default, raisable per Market); `offer-moved` release accepted with `inventory.rekey.hold-released`; pending left accepted; `inventory.rekey.stock-dropped`; Hassan M1 (check against `offerSellUnits`) and M2 (existing target keeps its value) applied (3.6, 15) |
| Q-A1 | Commands from `ordering`: a `system`-rule port only `ordering` imports (A), or `inventory` subscribing to ordering's events (B)? | Ali | Option A. It keeps the dependency one-way (ordering → inventory); B creates an inventory↔ordering cycle, which blocks extracting either module later (7.2) |
| Q-A2 | Payment succeeds for a reservation that was RELEASED | Ali | Take the stock again only when the release cause is `superseded` (the same holder's newer checkout). A release for cancel, payment failure or by the customer is final, so refuse (3.1). Input for ordering's G2: commit before capturing payment, so a refusal is a void, not a refund |
| Q-A5 | Partial shipment or cancellation of one order line | Ali | Whole lines only at launch; a quantity parameter can be added later at the ordering or returns gate (3.2) |
| T1 | Derive reserved and pending, or store counters (4.1) | Ali | Option A, sum the lines at read time; Mojtaba sizes the index; slice 4's test measures the read cost |
| Q-S1 | "Fits / doesn't fit" for a requested quantity; showing the cap | Hassan | No "fits / doesn't fit" answer. The cap may be shown only if the seller set it or it comes from public `onlyLeft` (5.4, 7.1) |
| Q-S2 | Rate-limit numbers and the alert thresholds | Hassan | The numbers of 5.4 |
| Q-O1 | Default per-customer cap when the seller set none | The owner (through Hadi) | Hassan's rule (5.1): half only from public `onlyLeft` when `LOW`, otherwise `D`. Replaces G1 Q11 for stock 11–19; Hadi adds the brief change-log row (Q11) |
| Q-H1 | Cap per (Offer, Variant) line or per Offer total? | Hadi | Per line, matching Q10's sellable; no change-log row (5.1) |
| Q-H2 | Default source: copy the seller's address and zone, or start empty? | Hadi | Start empty, seller's zone implied; no `sellers` dependency; no change-log row (3.4, 8) |
| Q-M1 (security half) | The raw helper | Hassan | `lock-stock-items` only, under the conditions of 4.4; the sum through Prisma `groupBy` |
| Q-M1 (data half) | The lock statement, the index for T1, terminal-row retention | Mojtaba | Statement approved with `FOR NO KEY UPDATE` and the tenant bound (4.4); the plain held index `(market_id, stock_item_id, state, expires_at, quantity)` with the mandatory `groupBy` shape, no raw sum; released and expired rows pruned after 30 days (11); committed rows open (R1) |
| F1 | Lock set for availability signals | Mohammad (Mojtaba's recommendation) | Every stock item of every affected sell unit, in every writer (4.3) |
| F2 | Creation-against-retirement race | Mohammad (Mojtaba's recommendation) | `set-stock-level` and `retire-sell-units` run `serializable` (3.5, 4.5); the PE 3.1 row 6 pattern, no new platform rule |
| L5, L7 | Lock strength; `lock_timeout` | Mohammad (architecture half) | `FOR NO KEY UPDATE` (4.4; Hassan's confirmation open, R3); UnitOfWork option `lockTimeoutMs`, added to PE 3.1 with slice 2 (4.2) |
| M2 | Added persistence fields | Mohammad | Confirmed (2.1) |
| M3 | Source name limit; address shape | Mohammad | Name 1 to 80 characters (technical bound); address as an inventory-owned `SourceAddress` value object in `jsonb`, no shared type until a second module needs one (2.1) |
| M4 | Same stock level | Mohammad | No movement, no version raise (4.5) |
| M6 | Cleared Variant tombstone and retired stock | Mohammad | `retiredAt` stays one-way (3.3); catalog G2 closed the open part (14.1) |
| M7 | Prune without a stock lock; retention of released and expired reservations | Mohammad, on Hassan's rule | Accepted; 30 days, since alert (b) looks back 24 hours (4.3, 11) |
| M8 | Cause kept on a committed `superseded` reservation | Mohammad | Confirmed (3.1) |
| T2 (data) | Reordering sources | Mohammad | Option A, two-pass reorder in one unit |

## 15. Review record

Reviewed 2026-10-07 by Ali (cto, approve with changes) and Hassan (security-tester, accept with changes); both sets of changes are applied in sections 2 to 14. Catalog's G2 accepted this design's section 13 list (Ali A4 met; merged PR #54). Mojtaba's review (Q-M1) is recorded below; Reza's (brief s12) is pending as the UI condition.

**Re-key review (V-1), 2026-10-07:** Ali (cto, accept with changes) and Hassan (security-tester, no Critical or High; M1 and M2 to be fixed before slice 2 merges) reviewed section 3.6 and its data counterpart; their changes are applied (3.4, 3.6, 4.4, 13, 14) and listed below. Hadi confirmed `inventory.maxSourcesPerSeller` = 4 as a product default (brief change-log row).

**Catalog G2 (merged, PR #54, 0bad228), 2026-10-07:** its 9.7 and 18 accept this design's section 13 expectations (event names, `offerSellUnits`, the Simple invariant, 200-id batches refused whole with `batch.too-large`) as ruled, with one conflict, V-1, applied (3.6; Ali's ruling, 14.2); it set `catalog.maxVariantsPerProduct` (AU 100, ZZ 3) and never reuses Variant ids, closing V-1a and M6 (14.1). The merged text differs from the draft 25cbf3a only by additions this design already follows; no mini-review is needed.

**Final G2 verdict, 2026-10-07:** Ali (cto): **approve with conditions** (tier A). Conditions: (1) Hassan reviews the re-key handler's code before slice 2 merges (V-1b); (2) before slice 2, Hossein's Prisma spike (S1) and Kazem's timeouts (R4); (3) ordering's G2 re-confirms the ordering port and slice 5 (7.2); (4) Mojtaba signs off each migration; (5) no UI slice before Reza's `ux.md` and the Figma-first design-system update (ADR-0017, brief s12). Approvers: Mohammad (software-architect), Ali (cto), Mojtaba (database-designer), Hassan (security-tester). **Bagher (qc-release-manager), final check 2026-10-07:** merges cleanly with main, touches only this module's files, no blocking open finding. Follow-up: Reza (ui-ux-designer) pending, UI condition.

**Ali's decisions**
- Required changes 1–7: slices 1–4 approved, ordering port and slice 5 re-confirmed at ordering's G2 (7.2, 12.1); `get-sellable-exact` is `system` (6); line ceiling from `MarketConfig.maxLineQuantity` (2.1, 5.1, 8, 13); `getAvailability` capped at 200 keys (7.1); release cause stored (2.1, 3.1, 10); Offer form composed in the client or BFF (5.1, 12.2); Q-A1, Q-A2, Q-A5 decided (14.2).
- Q-A1: option A, one-way ordering → inventory.
- Q-A2: re-take only after a `superseded` release; any other release is final; ordering commits before capturing payment.
- Q-A5: whole lines only at launch.
- T1: option A, sum at read time.
- No ADR conflict, no new ADR, no import cycle; catalog's scope unchanged.
- V-1 (2026-10-07): consume `catalog.offer-moved.v1` and re-key stock (3.6); brief s6 consumed-events list changed, goal unchanged (brief change-log row).
- V-1 re-key review (2026-10-07), accept with changes, applied: (1) V-1a: no chunking; `catalog.maxVariantsPerProduct` = 100 (set by catalog G2, 13, 14.1); `inventory.maxSourcesPerSeller` = 4 on source creation (3.4; Hadi confirmed it as a product default, raisable per Market, clear error, a raise re-checks the 800-item bound; brief s7 note and change-log row); worst case 800 items plus held items, the operator path only a backstop (3.6 step 2, 4.4). (2) Release with cause `offer-moved` accepted; `inventory.rekey.hold-released` per released hold; the whole checkout hold drops, other sellers' lines included, and `commitReservation` returns the existing refused error (3.6 step 4). (3) Committed units left pending on the retired old item: accepted as is. (4) `inventory.rekey.stock-dropped` with the quantity when a `to` tombstone retires stock without moving it (3.6 step 3). (5) Data 4.4: the Offer tombstone is read before the release `updateMany` (inventory-data 4.4). (6) V-1b: Hassan's review mandatory before slice 2 merges (14.1).

**Hassan's findings and answers**
- Finding 1 (cap leaks exact stock for 11–19): rule written into 5.1, accepted by the owner (Q-O1, 2026-10-07); cap checked before allocation (4.2).
- Finding 2: `get-sellable-exact` is `system`, dropped if ordering's G2 does not need it (6, 7.2).
- Finding 3: at most 50 lines per `reserve`, `lock_timeout` 3 s mapped to `conflict.retry` (4.2).
- Finding 4: re-reserving bounded by the Q-S2 limits (5.4).
- Finding 5: `commitReservation` checks `checkoutRef` (3.1, 7.2, 10).
- Finding 6: rate limiter failure fails closed with `access.unavailable` (5.4).
- Finding 7: `inventory.seller-stock.view` protected (6).
- Finding 8: acting-as stored on `StockMovement` with SEL-08; `reserve` refused in acting-as (2.1, 3.1, 6).
- Finding 9: threshold ≤ 99 (2.1, 5.2).
- Q-S1: no fits / doesn't-fit answer; cap shown only if seller-set or from `onlyLeft`.
- Q-S2: 6 per 15 min and 30 per 24 h per account, 30 per 15 min per origin; alerts (a) and (b) (5.4).
- Q-M1 security half: `lock-stock-items` only, with its conditions; sum via Prisma `groupBy` (4.4).
- Re-key handler (V-1b, design review 2026-10-07): no Critical or High; both Medium fixed in the design and to be verified before slice 2 merges. M1: before the unit, `offerSellUnits` as the system actor; proceed only if the Offer is present, not deleted, its `productId` = `toProductId` and every `to` is in its `sellUnits`, else the failed-delivery path with an alert; a mapping where a `from` and a `to` share an id, or `fromProductId` = `toProductId`, is refused (3.6 step 1). M2: an existing (Offer, `to`, S) row is not added to; the `−moved` movement is written on the old item, the target keeps its value, `inventory.rekey.target-exists` is logged; tested (3.6 step 5; inventory-data 10). Low: mapping capped at 200 pairs at validation before any read (step 1); a negative `moved` clamped at 0 with an alert (step 5); a structured log per released reservation, `inventory.rekey.hold-released` (step 4).

**Mojtaba's data design (docs/design/data/inventory.md, 2026-10-07), answered by Mohammad 2026-10-07:** Q-M1 data half closed; F1, F2, L5 and L7 (architecture half), M2, M3, M4, M6, M7, M8 and T2 decided (14.2; sections 2.1, 3.3, 3.5, 4.2 to 4.5, 11 updated). Still open (14.1): R1 and R2 (ordering G2), R3 (Hassan), M5 (with the card), R4 (Kazem), S1 (Hossein's spike), C1, and Hadi's brief change-log row for Q-O1.
