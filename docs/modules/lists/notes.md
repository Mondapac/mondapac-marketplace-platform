# lists: the shared super list kit, phase 0 (saved filters first)

Speed mode (CLAUDE.md): no G1/G2 or design document. The owner approved the super list plan on
15 Nov 2026 («ساخت»). The decision is ADR-0049.

## What the code does

- `lists.saved_filters` holds the saved filters of every list. `SAVED_FILTER_STORE`
  (`modules/lists/contracts`) is the only way in: `visibleTo`, `find`, `countOwnedBy`, `countShared`,
  `nextPosition`, `add`, `change`, `remove`, each with an explicit store (`sellerId`, or `null` for
  the rows that have none).
- `catalog` (admin and seller Products) and `ordering` (admin and seller Orders) use the store
  through their old repository ports; their routes, use cases and rules are unchanged.
- The migration `20261115160000_lists_saved_filters` copies the rows of `catalog.saved_filters` and
  `ordering.saved_filters`; the old tables are dropped one release later.

## Not here yet

- B0-1b: the generic endpoints (list, create, update, delete, share-check, reorder) and the
  registration of list definitions (view permission, share permission, payload validator).
- B0-2: column preferences per user per list.
