# ADR-0049: A `lists` Module for the Shared Super List Kit

**Status:** Proposed — 2026-11-15, on the project owner's «ساخت» of the super list plan (project
thread, 15 Nov 2026). Mohammad (software-architect) reviews the module boundary; Mojtaba
(database-designer, Opus) the migration; Hassan (security-tester, Opus) the permission checks. Their
review is not yet recorded here. The number 0049 is taken here without the board: renumber it if
another ADR took it first.
**Relates to:** ADR-0008 decision 6 (module boundaries), ADR-0042 (the `settings` module is the
precedent for a small shared module), CLAUDE.md rule 14 (super list)

## Context

Every list in the panels that can pass 50 rows must be a super list (CLAUDE.md rule 14), and one of
its features is saved filters, personal or shared. Saved filters were built twice: `catalog`
(`catalog.saved_filters`, admin and seller Products) and `ordering` (`ordering.saved_filters`, admin
and seller Orders), with the same columns, the same uniques and the same caps. About 38 more lists
need them. Left alone, each list's module would add a third, fourth and fifth copy of the table.

## Decision

1. **One owner.** A new module, `lists` (schema `lists`), owns the table of saved filters of every
   list: `lists.saved_filters`, keyed by `list_key`, with the owner account, an optional store
   (`seller_id`), the visibility (`me` or `everyone`), the name, a versioned JSON payload and the
   position. Later it owns the per-user column preferences of each list (B0-2) and the generic
   saved-filter endpoints (B0-1b).
2. **Modules keep the meaning.** The module that owns a list keeps the vocabulary of its payload
   (it validates it on write), the permission that shows the list and the permission that shares a
   filter. `lists` never imports a module; a module reaches the table only through the contract
   `SAVED_FILTER_STORE` exported by `lists`.
3. **Scopes.** An admin list has no store. A store-scoped seller list carries `seller_id` (every
   member of the store sees what is shared). An account-scoped seller list (the seller order list)
   leaves `seller_id` null and cannot be shared (CHECK).
4. **Data move.** The migration creates the table and copies every row of the two old tables with
   its id, so a filter keeps its identity. The old tables stay and are dropped in a later release,
   after the copy is proven; until then the old catalog and ordering routes and use cases keep
   working, now on the shared store (`PrismaSavedFilterRepository` and its seller twin delegate to
   the store).
5. **Platform helpers are not a module.** The shared export writer (`platform/list-export`) and the
   list query contract with the row actions helper (`platform/list-query`) are platform code: they
   hold no table and no permission.

## Consequences

- A new list needs a definition and no migration; the table's `list_key` CHECK already allows any
  dotted key.
- Two modules write to `lists.saved_filters` through one contract; rules of who may rename or share
  stay in the owning module until B0-1b moves them behind the generic endpoints.
- The old catalog and ordering tables are dead weight for one release; rolling the migration back
  loses only the filters saved after the copy.
- A list key is a string both sides must agree on; a typo creates a list nobody opens. The owning
  module's tests pin its keys.
