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
Settings, and counts from a read model if the work queue's p95 grows.
