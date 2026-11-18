# lists: the shared super list kit, phase 0 (saved filters first)

Speed mode (CLAUDE.md): no G1/G2 or design document. The owner approved the super list plan on
15 Nov 2026 («ساخت»). The decision is ADR-0049.

## What the code does

- `lists.saved_filters` holds the saved filters of every list. `SAVED_FILTER_STORE`
  (`modules/lists/contracts`) is the only way in: `visibleTo`, `find`, `countOwnedBy`, `countShared`,
  `nextPosition`, `add`, `change`, `remove`, `ownedBy`, `reposition`, each with an explicit store (`sellerId`, or `null` for
  the rows that have none).
- `catalog` (admin and seller Products) and `ordering` (admin and seller Orders) use the store
  through their old repository ports; their routes, use cases and rules are unchanged.
- The migration `20261115160000_lists_saved_filters` copies the rows of `catalog.saved_filters` and
  `ordering.saved_filters`. `20261118150000_lists_drop_old_saved_filters` drops the old tables: it
  first copies what old pods saved after the first copy (rows created since that migration began,
  `ON CONFLICT (id) DO NOTHING`, a name clash fails the migration) and takes a newer rename or
  visibility change, then drops. Rows an old pod deleted after the copy stay (a filter is a
  preference). Deploy it only when no pod of the release before the shared store runs. Before
  deploying, compare the per-list row counts of old and new tables on a copy of production.

## B0-1b (admin)

- `registerLists(owner, definitions)` registers a module's lists (ADR-0049, "B0-1b"). A new admin
  list adds one `ListDefinition` (key `admin.<module>.<list>`, `viewKey`, `shareKey`, payload
  parser) and the key to `LISTS_AUDIT_LIST_KEYS`; it never reads `lists.saved_filters` itself.
- Routes: `GET/POST /lists/admin/saved-filters`, `PUT /lists/admin/saved-filters/order`,
  `PUT/DELETE /lists/admin/saved-filters/:id`. The old catalog and ordering routes stay until the
  panels move.

## Admin Sales lists (ordering)

`ordering` registers three more admin lists, guarded like Orders (`ordering.order.view`, share
`ordering.saved-filter.share`); no migration (the `list_key` CHECK is a pattern). Payloads are
closed (`v: 1`; date filters are relative presets, never dates; search text is never saved):

- `admin.ordering.shipments`: tab `all|attention|to-prepare|ready|shipped|delivered|refunded`;
  filters `deliveryMethod`, `attention`, `paid`, `shipped`; sort `paid|shipped|delivered|total`.
- `admin.ordering.refunds`: tab `all|pending|succeeded|failed`; filters `reason`, `actor`,
  `lossBearer`, `ledger`, `requested`; sort `requested|settled|amount`.
- `admin.ordering.documents` (the Invoices page): tab `order-confirmation|credit-note`; filter
  `issued`; sort `issued|amount`.

## B0-2 column preferences

- `lists.column_preferences` keeps the columns a user chose per list (one row per account and list,
  per store later), behind `COLUMN_PREFERENCE_STORE`. A list opts in with `columns` (its column ids)
  on its `ListDefinition`; the panel's own column ids must stay the same.
- Routes: `GET/PUT/DELETE /lists/admin/column-preferences` (`listKey` in the query or body). No
  audit: it is a personal preference. Ids the list no longer offers are dropped on read.

## B0-1b (seller)

- Routes: the same five as the admin ones under `/lists/seller/saved-filters`. The use case bodies
  are shared (`handleSavedFilter*`); the seller classes only declare their own access
  (`own-resources`, `whenSellerNotApproved: 'allow'`, so a store still onboarding can use them).
- `ListDefinition.scope`: `store` (default; rows kept per store, shareable with the store through
  `shareKey`) or `account` (rows kept per seller account across its stores, `seller_id` null).
  `shareKey` is optional: without it a filter is always private. `seller.catalog.products` is
  store-scoped with the own-share key; `seller.ordering.orders` is account-scoped with no share key.
- An acting-as (Login as Seller) session is refused with `access.acting-as-refused` (403) in every
  use case; admin and seller lists never answer each other's routes.

## Not here yet

- Seller column preferences (the seller panels' column vocabulary) and the switch of the panels to
  the generic routes.
