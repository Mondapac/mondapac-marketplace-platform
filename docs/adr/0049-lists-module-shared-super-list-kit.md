# ADR-0049: A `lists` Module for the Shared Super List Kit

**Status:** Accepted — 2026-11-15, on the project owner's «ساخت» of the super list plan (project
thread, 15 Nov 2026). Reviews on PR #918 (head 47d8c7ed): Hassan (security-tester, Opus) approved the
permission checks, the `own-resources` pattern and the audit; Mojtaba (database-designer) approved the
migration and the `UPDATE (position)` grant; Mohammad (software-architect) approved the module
boundary. The number 0049 is taken here without the board: renumber it if another ADR took it first.
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

## Release notes
- The copy runs once, inside the migration. Pods still on the old code keep writing to the old
  tables during the rollout and the new code never reads them, so a filter saved in that window
  stays only in the old table. The PR that drops the old tables first adds a catch-up
  (`INSERT ... SELECT ... ON CONFLICT (id) DO NOTHING`, and a replay of renames and deletes) or the
  rollout freezes saved-filter writes.
- Rolling the migration back loses every filter saved after the copy and leaves the old tables
  stale: the release runbook says so.

## B0-1b: registry and generic routes

- A module registers its lists with `registerLists(owner, definitions)` (a provider, like
  `registerAuditActions`). A definition has the list key, the population, the `viewKey`, the
  `shareKey` and a payload parser. `lists` imports no module that owns a list (its only module import is `identity`, for the
  `AuthorisationCheck` port, like every module that checks permissions); the registry refuses a duplicate key,
  a key that does not start with `<population>.<owner>.`, and a key outside the audit vocabulary.
- The use cases (list, create, update, delete, reorder) declare `own-resources` (and
  `whenSellerNotApproved: 'deny'`). Their first step is a fail-closed `AuthorisationCheck` of the
  definition's `viewKey` (and `shareKey` when visibility `everyone` is touched); a denial or an
  unavailable check refuses the call before anything is read. The access-declaration contract
  accepts this, so the fallback of one thin use case per population was not needed. Hassan's review (15 Nov 2026,
  approve) accepts this pattern; refusals of the list keys are logged by `lists`, and a throwing
  authorisation port refuses with `access.unavailable`.
- Reorder takes the full list of the caller's own ids of one list and rewrites the positions in one
  serializable unit; the app role gets `UPDATE (position)` and no other identity column.
- Planned for the seller PR, additive: a `scope: 'store' | 'account'` field on `ListDefinition`
  (seller Orders is account-scoped and cannot be shared, so it has no `shareKey`); admin
  definitions stay valid unchanged. Follow-ups: seal the registry after bootstrap; sort the
  reorder updates by id to give one lock order.
- The routes are `/lists/admin/saved-filters`; the seller routes and the seller lists' definitions
  follow in a later PR (the design note lists both).
- `20261115160000_lists_saved_filters` says position never changes after the insert; since
  B0-1b it does (reorder). A merged migration is not edited, so this line is the record.

## Consequences

- A new list needs a definition, a key in `LISTS_AUDIT_LIST_KEYS` (a file inside `lists`, with the
  audit snapshot, because audit enums are closed) and no migration; the table's `list_key` CHECK already allows any
  dotted key.
- Two modules write to `lists.saved_filters` through one contract; rules of who may rename or share
  stay in the owning module for the old routes; the generic admin routes (B0-1b) hold them in `lists`.
- The old catalog and ordering tables are dead weight for one release; rolling the migration back
  loses only the filters saved after the copy.
- A list key is a string both sides must agree on; a typo creates a list nobody opens. The owning
  module's tests pin its keys.
