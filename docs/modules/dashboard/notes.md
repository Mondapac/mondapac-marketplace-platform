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

## Seller KPIs: panel (phase 6, PR 17)

The seller home shows, below "Needs attention", the KPI section (`apps/seller/src/dashboard/kpis`),
read only when the session holds `ordering.seller-order.view`:

- Period switch (Today, 7 days, 30 days, This month) kept in the address (`?period=`), so the
  server renders the figures; an unknown value falls back to 30 days.
- Eight cards with the change against the previous period: sales (with a sparkline), paid orders,
  average order value, refunded, refund rate, shipped on time, units, cancelled. The change is
  `n/a` when the previous figure is zero or its period had fewer than five paid orders; colour
  follows better or worse (refunds and cancellations up are bad), and the words say it too.
- Sales chart with a dashed previous period and "View as table"; top categories (named from the
  public category tree, "Other categories" when unnamed); store health from `sellers/own-health`
  (links to Performance). Recent orders stay as the existing "Recent orders" card.
- A failed read says "could not be loaded" in its own card or cards, never a zero.
- Deferred: top products (FE-125), seller net earnings (FE-126), on-time with overdue unshipped
  orders (FE-127), average rating and next payout in the health card (FE-128), a relative
  "updated N min ago" (FE-129; the chart card already says the Market zone and the update time).

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
- Growth (Mojtaba, DB): the failed-payout count reads every failed payout of the Market and checks
  the 7-day window on each row. Add a partial index on (market_id, state_changed_at) WHERE
  state = 'failed' once a Market holds about 10,000 failed payouts. The restricted-account and
  due-dispute counts read every row of their Market's state or bucket; revisit at about 50,000
  sellers, or if the `needs-response` bucket stops being small.

## Seller tasks (PR 6)

`GET dashboard/seller/tasks` (`ViewSellerTasks`, rule `own-resources`, not-approved `allow`; each
queue's owner applies its own seller-state rule). Always the session's own seller: every owner use
case reads the seller id from the session through `countSellerWorkQueue` (platform/work-queue),
never from input. A customer or an admin acting as themselves is `access.denied`; a seller session
that carries the acting-as marker (Login as Seller, SEL-08) is allowed, as the seller reads are.
Counts are cached per seller and access state, except the live queues.

| Key                                       | Level          | Key needed                         | Definition                                                                                                                                                                                                                                            |
| ----------------------------------------- | -------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ordering.late-orders`                    | critical, live | `ordering.seller-order.view`       | The admin late-delivery rule for this seller only. Overdue: past the promise by more than 1 hour.                                                                                                                                                     |
| `commission-payouts.dispute-reply-needed` | critical, live | `commission-payouts.earnings.view` | Cases in `needs-response` whose dispute holds one of the seller's orders (active dispute holds). Overdue: deadline passed; `oldestAt`: nearest deadline.                                                                                              |
| `payments.payouts-blocked`                | critical       | `payments.payout-account.view`     | 0 or 1: the seller's account is `restricted` or `payouts_enabled` is false (onboarding not finished counts too). No account: 0. Overdue 0; `oldestAt`: the account's last update.                                                                     |
| `ordering.to-ship-today`                  | today          | `ordering.seller-order.view`       | Paid, `to-ship`, not marked ready, not refunded in full; ready-by from now to the end of the seller's local day, or a scheduled window that starts that day and has not ended. Never late (no double count). Overdue 0; `oldestAt`: earliest payment. |
| `ordering.pickups-uncollected`            | today          | `ordering.seller-order.view`       | Pickup orders marked ready, not collected. Overdue: ready since before 48 hours; `oldestAt`: earliest ready time.                                                                                                                                     |
| `commission-payouts.payout-holds`         | today          | `commission-payouts.earnings.view` | The seller's active payout holds (dispute holds included). Overdue: placed before 48 hours.                                                                                                                                                           |
| `reviews.unanswered`                      | review         | `reviews.seller.view`              | The Reviews list's `unanswered` view: published reviews without a published reply of the shop. Overdue: published before 7 days.                                                                                                                      |

- The seller's day is the seller's approved operating zone (sellers `operatingZones`, read before
  the unit); before the seller has an approved file it falls back to the Market's zone.
- commission-payouts has no seller dispute key: the two money queues use
  `commission-payouts.earnings.view`, the module's one seller read key, while the dispute and hold
  lists are `own-resources`. A member without that key does not see these two queues.
- New partial index `seller_orders_market_id_seller_id_open_idx` on (market_id, seller_id) WHERE not
  delivered, paid and not refunded in full, built CONCURRENTLY in its own migration. It serves
  the three ordering seller counts.
- Dropped: `inventory.published-out-of-stock`. Whether an Offer is published is catalog data and
  the stock is inventory data, so a count would need both modules (no cross-module join).
  Inventory's availability signals carry no publication state.
- Deferred: low stock, changes requested on an Offer, certificate expiring, a delivery-by promise
  for shipped instant and same-day orders (FE-095), and the thresholds as Market settings (FE-109).
- Growth (Mojtaba, DB): the unanswered-review count of a seller with many reviews anti-joins
  `review_replies`, which has no index leading on `seller_id` (the Reviews list's own query shape);
  revisit near 1 million replies with a partial index (market_id, seller_id, review_id) WHERE
  status = 'published'. The scheduled counts of a large seller read the Market-wide window index
  and filter by seller; the next step, if measured, is a partial index (market_id, seller_id,
  delivery_window_end) of the open scheduled orders.

## Phase 2: action centre UI (PR 7, admin)

- The admin dashboard opens with the "Needs action" card (`packages/ui` `WorkQueueCard`, words and
  links in `apps/admin/src/work-queue/queues.ts`). It replaces the four "Needs attention" figures,
  which counted a first page and showed "50+". Every critical queue shows; the five most urgent
  today queues show and the rest fold into one line; the review queues fold into one line; empty
  queues are summed up as "All clear". Urgency: a queue that could not be read first, then the
  most overdue, then the oldest, then the most items.
- Each row says where it stands in words as well as colour (Reza, UI/UX): "Incident" for listings
  claiming a certificate without a valid one, "Due in 6h" or "Overdue" for disputes (their
  `oldestAt` is the nearest deadline; "Overdue by 30m" once it passed), else the count says
  "17 · 5 overdue" with "Oldest 3d" in the critical tone, "Overdue 1h" when every item is
  overdue, or "Oldest 9h". Folded lines keep the overdue count and tone, and never show 0 for
  queues none of which could be read. A queue in its
  normal state has a neutral dot (Jafar). A failed queue says "Couldn't load", never 0, and does
  not link. On a phone only the critical group stays open.
- The read is made only when the session holds the key of at least one queue the panel knows; a
  key the panel does not know (a queue added to the API first) is left out. Without any, the
  full page says there is no access (never "All clear"). `queues.spec.ts` checks the panel's
  keys, levels and order against `dashboard.module.ts`.
- `/work-queue` is the full page, a super list without saved filters and without row selection
  (john's choice, 22 Nov 2026; FE-119): views (needs action, all, per level) with counts, search
  by queue name, a state filter with chips, sort (most urgent first by default: level, then the
  card's order; "Waiting since" sorts by age and leaves the disputes, whose time is a deadline,
  last), the column picker,
  CSV and XLSX export of the rows on show, the phone layout. It reads the queue once (about twenty
  rows), so there is no footer. `?view=` opens a view (the card's folded lines use it).
- Not yet: deep links that open each list oldest first (FE-120), lists for three queues that
  have none (FE-121; failed webhooks is FE-110), refresh without a reload (FE-122).

## Phase 2: action centre UI (PR 8, seller)

- The seller dashboard opens with "Today's tasks" (the same `WorkQueueCard`; words and pages in
  `apps/seller/src/work-queue/queues.ts`): every urgent task, today's tasks, the review task, and
  "All clear" for empty ones. There is no full page: the seller has seven tasks at most, and each
  row links to the page where it is done (orders, earnings, payout account, reviews).
- "Payouts paused or not set up" counts an account whose setup is not finished as well as a
  restricted one, so its words name both; its status is "Fix payout details".
- A dispute's hold is counted in both "Disputes waiting for your reply" and "Payouts on hold,
  disputes included"; the hold row says so.
- "Orders to ship today" shows its count with no age. Design section 3 shows "Next by 2 pm", but
  the API gives the earliest payment as `oldestAt`, and how long ago an order was paid is not what
  the seller acts on. The next ready-by time is FE-123.
- The groups are "Urgent", "Today" and "When you have time" (the admin card says "Critical"): a
  seller reads a task, not a severity. The seller has three today tasks, under the card's limit of
  five, so "top N of M" and "N more tasks" stay in the messages only for a task added later.
- A member who may view the payout account but not manage it still reads "Fix payout details";
  the page then says who can change it. Accepted for now (Reza, UI/UX).
- The review task opens the Reviews page on every review: the page does not read a view from the
  address yet (FE-124).
- `queues.spec.ts` reads the API's bindings as text and checks every seller task's key, level,
  order and permission, as the admin panel does.
- The "Needs attention" figures stay until the seller KPI strip (phase 6) replaces them.
- Deferred: "Published but out of stock" (FE-113), the folded low-stock, changes-requested and
  certificate tasks (FE-114), the ready-by time of today's orders (FE-123), the Reviews page
  opening on "Unanswered" from the task (FE-124).
