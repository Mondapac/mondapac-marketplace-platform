# ADR-0050: A `dashboard` Composition Module for the Panels' Work Queues

**Status:** Accepted — 2026-11-22, on the project owner's choice of option B of the dashboards
upgrade (design `design/admin/dashboards-upgrade/dashboards-upgrade-fa.html`, section 6, with
Mohammad's (software-architect) amendments). The number 0050 is taken here without the board:
renumber it if another ADR took it first.
**Relates to:** ADR-0008 decisions 5 and 6 (communication contract, boundaries), ADR-0018 decision 4
(authorisation in the use case), ADR-0049 (precedent for a small shared module)

## Context

The admin and seller dashboards read each queue with its own list call and count one page of 50
("50+"). Option B needs one answer per panel with the real count, the overdue count and the age of
the oldest item of every queue the viewer may see, from about twenty queues owned by ordering,
catalog, sellers, security, certification, payments and commission-payouts.

## Decision

1. **Owners count.** Each owner module answers its queues from its public facade, through a use case
   with its own rule, with one indexed count (never a page read and counted). The answer's shape,
   `WorkQueueCount` (`count`, `overdue`, `oldestAt`), lives in `platform/work-queue` so no owner
   imports the dashboard.
2. **One composition module.** `modules/dashboard` has no tables. It binds each queue (key, panel,
   level, required keys, live or not) to its owner's facade and serves `GET dashboard/admin/work-queue`
   and `GET dashboard/seller/tasks`. It reads the viewer's permission set through
   `identity.describeActor`, asks only the queues whose keys the viewer holds, all at once, each with
   the caller's `CallContext` unchanged and a 1.5 s limit. A failed, late or malformed queue answers
   `error` (the panel shows "Couldn't load", never 0); an owner's refusal hides the queue.
3. **Cache.** Counts are kept in the API process for 60 s under Market, tenant, panel, the viewer's
   whole sorted permission set and (seller panel) the seller. Live queues (security alerts,
   disputes, listings claiming a certification without a valid one, such as halal) are never kept. The HTTP answer is `no-store`.
4. **Boundary.** No module or platform file imports `modules/dashboard` (dependency-cruiser
   `nothing-imports-dashboard`); only the module list registers it. The dashboard reaches other
   modules only through their `index.ts`, as every module does.

## Consequences

- A new queue is one facade method in its owner plus one source in the dashboard module.
- The dashboard depends on many modules; since nothing depends on it, it can never form a cycle.
- An in-process cache is per API instance: two instances may show counts up to 60 s apart. A read
  model replaces the counts if their p95 grows (future-enhancements register).
