# ADR-0040: One Store for Platform-Level Market Settings

**Status:** Accepted — 2026-11-01, on the project owner's decision (project thread, 1 Nov 2026):
the shared settings store of ADR-0026 is built now, with List paging as its first setting; the
settings that already exist are not changed. Ali (cto), Mohammad (software-architect), Mojtaba
(database-designer) and Hassan (security-tester) review the implementation PR; their review is
not yet recorded here.
**Amends:** ADR-0026 (it says the store lands "no later than" the first slice that needs it; this
ADR says where it lives and how the existing settings reach it)
**Relates to:** ADR-0008 decision 6, ADR-0018 decision 4

## Context
ADR-0026 accepted a shared store for admin-editable Market settings (value, version, history,
audit, safe value) but it was never built. Meanwhile `reviews`, `wallet` and `promotions` each
created their own one-row `market_settings` table, with different columns and no history or
version. The next setting, List paging (how every list in both panels pages), has no natural
owner module. A permission key must start with a module name and the access, route-population and
boundary checks are module-based, so a store with no owning module does not fit those rules.

## Decision
1. **One shared store.** A small module, `settings` (schema `settings`), owns the store: the
   current value, a version, an insert-only history, the audit action and the permission keys
   `settings.market-setting.view` and `settings.market-setting.manage`. It declares the editable
   settings in code (`domain/definitions.ts`): code, allowed values, default and safe value.
2. **List paging is the first setting.** Values `pages` (page numbers with the total; the
   default) and `prev-next`. If the store cannot be read, readers get `prev-next`.
3. **Every new platform-level, admin-editable Market setting goes into this store.** No module
   adds another `market_settings` table for a setting of this kind.
4. **Existing settings are not changed now.** The `market_settings` tables of `reviews`, `wallet`
   and `promotions`, and the other settings that modules own, stay as they are.
5. **Consolidation later, one setting at a time.** Moving an existing setting into the store is
   its own PR, decided by the owner, with a data migration, a check that readers see the same
   value, and the review its path needs (for example Hassan for anything on a decision path).
   Until then both ways exist side by side.
6. **Per-seller settings stay in `sellers`** (ADR-0026 decision 9); anything read by
   `evaluateClaim` or `ClaimBasisPolicy`, identity's security policy, AI provider/model/region,
   payment and commission values and `HOSTED_MARKETS` are still never settings.

## Consequences
- Each new setting costs a definition, a translation and a page row, not a table and a migration.
- Versioning, history, audit and the safe value are written and reviewed once.
- Two ways to hold a setting exist until the owner moves the old ones.

## Alternatives considered
- **One more single-row table in a module for List paging:** quickest, but a fourth copy and an
  owner module that does not own the idea.
- **A store inside `platform/` with no module:** needs platform-owned permission keys, controllers
  and check exemptions that the rules do not allow today.
- **Move the existing settings now:** a data migration on three live modules, not asked for.
