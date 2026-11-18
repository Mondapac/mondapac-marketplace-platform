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
  `ordering.saved_filters`; the old tables are dropped one release later.

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

## Phase 4 lists (PR10)

- Registered admin lists: `admin.commission-payouts.payouts` (21), `admin.commission-payouts.disputes`
  (23), `admin.payments.connected-accounts` (22), `admin.wallet.credit-requests` (24),
  `admin.customers.deletion-requests` (25) and `admin.blog.posts` (26). Each `viewKey` is the key
  its list use case checks; each `shareKey` is its module's `<module>.saved-filter.share`
  (customers reuses `customers.saved-filter.share`).
- Their payload is one closed shape, `savedListPayloadParser` (`contracts/saved-list-payload.ts`):
  `{v: 1, view, q?, filters, sort, direction}`, `view` only for a list with views (the Seller
  accounts list has none), no paging or columns. The view, `q` and filters go through the list's own
  selector reader, so a saved value is one the list accepts; the stored form is canonical (ids in
  lower case, instants as ISO text in UTC, minor units as digits). Every saved text (`q` and each filter
  value) must be a string: `null` or another type is `type`, a control, private-use, surrogate or
  unassigned character is `format`, and blank text is left out.
- The compact lists 27 and 28 have no saved filters. The seller Earnings › Payouts list (33),
  `seller.commission-payouts.payouts`, is on the seller routes (B0-1b): store-scoped, view key
  `commission-payouts.earnings.view` (as its export), share key
  `commission-payouts.own-saved-filter.share` (the Seller Owner holds it with no seed change), no
  views (the status tabs are a filter). The seller panel still has to call these routes.

## Not here yet

- Seller column preferences (the seller panels' column vocabulary) and the switch of the panels to
  the generic routes.
