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

## Catalog, pricing and sellers queues (PR 3)

- Each owner answers through its own `*WorkQueueFacade` and one use case per queue, gated by the
  key of the queue's own list, through the shared `countAdminWorkQueue` (platform/work-queue):
  platform admins acting as themselves only, one read-only unit, `access.unavailable` on abort or
  failure.
- Today: seller applications (`sellers.seller.view`; pending business-file revisions, by creation),
  Offers pending first publication and product revisions (`catalog.product.view`; by submission),
  price holds (`pricing.price-hold.view`; regular and special records pending review, counts only),
  the seller health queue (`sellers.seller.view`; a snapshot of the queue's own read: no overdue,
  no oldest). Review: brand merge groups (`catalog.brand.read`; shared by every Market) and
  category proposals (`catalog.category-proposal.decide`).
- Each count runs on the partial index its list already reads; no migration.
- The category-proposal count reader is on the shelf-isolation allow-list (CAT-52): it reads a count
  and the earliest `created_at`, never a name or a shelf.
- There is no attribute-proposal queue in catalog yet, so the design's "category and attribute
  proposals" row counts category proposals only.
- Known limits (Sajad, QA; Hassan, security): the health-queue count stops at the queue's bound
  (`UNHEALTHY_QUEUE_MAX`, 200) as its list does, with no "200+" mark yet; the brand-merge count takes
  every open group while its list pages them. A failed count logs its error class
  (`work-queue.count-failed`), never the message.
- The readers' statement specs pin each where clause (status, scope, Market, age column, strict
  `lt`), so a count that drops its Market filter fails there; the database spec runs them on
  PostgreSQL.

## Security and certification queues (PR 4)

- Critical, live (never cached): `catalog.claims-without-certificate` (`catalog.product.view`) and
  `security.open-alerts` (`security.centre.view`). Review: `certification.seller-certificates` and
  `certification.product-certificates` (each its review list's view key).
- Claims without a certificate (definition by Hadi, product owner): the Offer tags of every type
  that are `active` with `valid_until` before now, so a buyer still sees the badge after the
  certificate has expired. These are incidents, so every one counts as overdue. `oldestAt` is the
  earliest validity end that has passed. The count lives in catalog, which owns `offer_tags`.
  `rechecking`, `suspended`, `pending-publish` and `removed` tags show no badge and are not
  counted. A separate "stuck re-evaluation" signal for long `rechecking` tags is FE-107.
- The incident count reads a new partial index, (market_id, valid_until) WHERE status = 'active',
  built CONCURRENTLY.
- Certificate reviews wait from their pending submission's `submitted_at`, because a renewal leaves
  the certificate's `status_changed_at` unchanged.

## Payments and payout queues (PR 5)

Definitions by Hadi (product owner), 22 Nov 2026. Each count is scoped to the caller's Market.

- Critical, live: `commission-payouts.disputes-due` (`commission-payouts.dispute.view`). It counts
  the cases in the `needs-response` bucket whose response is due within 24 hours, past due
  included. Overdue means the deadline has passed. `oldestAt` is the nearest deadline, so the row's
  link sorts the Disputes list by due date, the one exception to "oldest first". The
  `under-review` and `decision-needed` buckets have no response deadline and are not counted.
- Today, with their own 1-hour age limit (`WorkQueueSource.staleAfterMinutes`, design section 2):
  - `ordering.failed-payments` (`ordering.order.view`): orders cancelled `payment-failed` or
    `provider-failed` within the last 24 hours.
  - `payments.failed-webhooks` (`payments.customer-payment.view`): Stripe events still not applied
    an hour after they arrived, plus events given up (`outcome = 'failed'`) within 7 days.
    `rejected` events are not counted. No admin list exists yet (FE-110).
  - `commission-payouts.failed-payouts` (`commission-payouts.payout.view`): payouts in `failed`
    within 7 days. Their items are planned again automatically, and transfer failures in payments
    are not part of this queue.
- Today, with the default 48 hours: `payments.restricted-accounts`
  (`payments.connected-account.view`), since the account's last update, and
  `commission-payouts.payout-holds` (`commission-payouts.settlement.view`), every active hold since
  it was placed.
- Failed payments, webhooks and payouts have no handled state, so they count over a rolling
  window (FE-108). The windows and age limits are constants for now and become Market settings
  later (FE-109).
- Two new partial indexes, each built CONCURRENTLY in its own migration: the cancellations for a
  failed payment on (market_id, cancelled_at), and the given-up Stripe events on
  (market_id, received_at).
