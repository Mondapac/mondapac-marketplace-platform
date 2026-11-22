# dashboard (panels' dashboards: composed reads)

Tier C (reads only; no tables, no money, no personal data of its own). No G1/G2 (speed mode); the
owner chose option B of the dashboards upgrade on 2026-11-22. Design:
`design/admin/dashboards-upgrade/dashboards-upgrade-fa.html` (project files), sections 2 to 4 and 6.
Architecture: ADR-0050.

## Phase 1: work-queue counts

- `GET dashboard/admin/work-queue`: every admin queue whose keys the admin holds.
- `GET dashboard/seller/tasks`: the seller's own tasks (own store only).
- Each queue is a `WorkQueueSource` bound in `dashboard.module.ts` to its owner's facade method.
- Levels and default overdue ages: critical 1 h (or the queue's own deadline), today 48 h, review 7 d.

## Deferred

Tracked in the central register (FE-066 to FE-081), among them: overdue thresholds editable in admin
Settings, and counts from a read model if the work queue's p95 grows. Also FE-095: a delivery-by
promise for instant and same-day orders once shipped (today only their ready-by time is a promise).

## Review notes (PR 1225)

- Only a platform admin acting as themselves reads the admin work queue (`isPlatformAdminActor`), so
  a cached count never reaches an acting-as session (Hassan, security).
- A late queue's signal is aborted; owners check it before they start a read, and again between
  rounds of reads (ordering's late count).
- Single flight: concurrent requests with one cache key share one read of the owner (Sajad, QA).

## Review notes (PR 1226, ordering counts)

- Late rule per delivery method, from the promises an order records (port doc of
  `WorkQueueCountReader.lateDeliveries`): scheduled on the window end, the others on the ready-by
  time; a shipped instant or same-day order is not late (FE-095) (Sajad, QA).
- The open scheduled orders have a partial index on (market_id, delivery_window_end); the per-minutes
  counts stay in Prisma, not one raw statement (Mojtaba, database).
- The database spec counts under a tenant of its own, so its counts are exact (Sajad, QA).
