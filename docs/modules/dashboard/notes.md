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

## Seller KPIs: API (phase 6, PR 16)

`GET reporting/seller/kpis?period=today|7d|30d|month` (default 30d), owned by `reporting`
(`ViewSellerKpis`; the dashboard module composes nothing here). Always the session's own seller
(`sessionSellerOf`, never an id from input; a customer or an admin acting as themselves is
`access.denied`), key `ordering.seller-order.view`, denied while the seller is not approved. Days
are the Market's (ADR-0005); the previous period is as long and just before (month: the same
number of days of the previous month, cut at its end).

- Figures come from `reporting.daily_seller_sales` and `daily_category_sales`; every statement
  carries Market, seller and currency (the database spec holds a canary seller and a canary
  Market). Money is a decimal string of minor units; sales are goods with and without GST,
  shipping apart. Refunds are the money refunded in the period, on the refund's day.
- Shipped on time counts shipped orders only. An unshipped overdue order is a task (card "Today's
  tasks"), not yet part of the rate (the rollup has no day for it; FE-127).
- Top categories, not top products (FE-125): reporting keeps category, not product, facts. The panel
  names a category from the public category tree.
- Seller net earnings (sales minus commission and refunds) wait for a commission fact in reporting (FE-126).

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


## Admin KPIs (phase 5)

`GET dashboard/admin/kpis` composes reporting's `REPORTING_KPI_FACADE` (operations and finance, one
section each), asked only behind `ordering.order.view` and `commission-payouts.settlement.view`,
each with a 1.5 s limit and its own `error` state. `Cache-Control: no-store`; nothing is cached in
the dashboard. The numbers and their definitions are in `docs/modules/reporting/notes.md`.
Dashboard imports `ReportingModule` through its index only (`nothing-imports-dashboard` still holds).

### Admin KPI strip (phase 5, PR 15): scope against the design mock-up

The strip shows GMV (incl. GST, excl. GST in its scope line), net sales, average order, refunded
(amount and rate), paid orders, cancel rate, shipped on time and refund count, with the GMV chart.
Against the mock-up: net revenue and take rate wait for the commission ledger (FE-130), new buyers
for the ordering facade (FE-061), and the cancel rate and refund count were added because they
come from the same rollup. Marketplace health, top sellers and categories and the order flow are
separate PRs. The period is the `?period=` query of the home page; the skeleton and the error
state show only the figures the session's keys allow.

## Admin KPI and finance additions (dashboards v2, phase 1, PR 6)

`GET dashboard/admin/kpis` gains, under the same rule (`own-resources`, a platform admin acting as
themselves) and the same 1.5 s limit and `error` state per number:

- `ordersByStatus` (key `ordering.order.view`): reporting's `marketplaceOrderStatus`.
- `finance.kpis.net`: net revenue and take rate of the period and the period before it, inside the
  finance section (key `commission-payouts.settlement.view`).
- `health` (the supply and health card), each number asked only under its owner's key and checked
  again by its owner: `listings` (search `liveListings`, `catalog.product.view`),
  `certificatesExpiring` (certification `expiringCertificates`,
  `certification.seller-certificate.view`), `payoutsOnHold` (commission-payouts `payoutHolds`,
  `commission-payouts.settlement.view`), `disputeRate` (commission-payouts `disputesOpened`,
  `commission-payouts.dispute.view`, AND `ordering.order.view` for its denominator). `health` is
  null only when the viewer holds none of these keys.
- The dispute rate waits for the orders-by-status answer: its chargebacks are counted over that
  answer's instant window and divided by its paid count, so both sides cover the same Market days.
  When orders by status failed the rate is `error`. Worst case the two waits add up (2 x 1.5 s).
- Every owner answer is a count; no id, name, amount or reason of another module reaches the
  dashboard. The definitions are in `docs/modules/reporting/notes.md` (dashboards v2, PR 6).
- Load (measured in Mojtaba's review): one admin dashboard load sends about 25 statements over 12
  read-only units and fills the shared 10-connection pool (`DATABASE_POOL_MAX`) for about 0.4 s.
  If many admins use it at once, the fix is to queue or share the dashboard's reads (single-flight
  per Market and period), not to add indexes.

### Seller dashboard v2 (dashboards v2, phase 1, PR 8)

The seller home page is one `DashboardGrid` (12 columns; phone order KPI cards, tasks, the rest).
Shared pieces: `KpiCard` in `packages/ui/src/dashboard` (coloured icon tile, "?" definition,
`note` for a figure that is withheld, `highlight` for the one main card), `GridItem` hides itself
while it has no content, `StatCardSkeleton as="div"` is the KPI card's twin. Cards and sources:
Sales and Seller orders paid (`reporting/seller/kpis`), Net earnings (`reporting/seller/net-earnings`,
earnings key; no number until a week of ledger records, FE-066), Next payout
(`commission-payouts/seller/payouts/next`), sales chart with a Sales/Orders switch (same KPI read),
store health ring (`sellers/own-health`), top categories (KPI read; per-product ranking FE-20261124-seller-top-products-per-offer),
stock watch (`inventory/seller/low-stock`; best sellers first FE-20261124-seller-stock-watch-best-sellers-first), today's tasks and recent
orders (existing reads). `GET reporting/seller/net-earnings?period=` is new: session seller only,
key `commission-payouts.earnings.view`, `ready:false` with `netEarnings:null` until ready, money as
a minor-unit string. Screenshots: `apps/seller/test/dashboard-shots` (not part of CI).

### Orders by state (dashboards v2, phase 2, PR 1)

`GET dashboard/admin/kpis` gains the section `ordersByState` (key `ordering.order.view`, null without
it, `status: error` when it fails or takes over 1.5 s): the seller orders paid in the period by the
state they were delivered to (a pickup counts in the store's state), from `reporting.seller_orders.
delivery_state` only; no postcode is read. Up to eight states, biggest first (ties by code), the
rest summed in `other`, orders with no state recorded (placed before delivery quotes were kept, or
before the history backfill reached them) in `unknown`, never folded into a state. Below five paid
orders no share is shown (`not-enough-data`). "Paid" counts every paid seller order, cancelled ones
included, like `ordersByStatus.paid`; the card must not read as live orders. The card is built in the phase 2 cards PR.

### Shopping funnel (dashboards v2, phase 2, nightly engagement)

`GET dashboard/admin/kpis` gains the section `shoppingFunnel` (key `ordering.order.view`, null
without it, `status: error` when it fails or takes over 1.5 s): reporting's
`marketplaceShoppingFunnel`, from `reporting.daily_engagement` only. Steps `viewed`, `carted`,
`checkedOut`, `paid`, each with `count`, `rateBp` (of the step before), `change` and `rateChange`
against the period before; `recordedDays` of `periodDays` (a day's row is written once by the hourly job,
at least 2 h after the Market day ends, so today has none). `not-enough-data` below 20 viewers in the period; a step under 5 is
`count: null` with its rate (never 0), and so is every step after it; change `na` when the period
before had under 20 viewers. Counts are customer-days (each day's distinct customers summed): the
card's "?" must say so (true distinct over a period: FE-20261125-dashboards-funnel-distinct-over-period).
The "?" must also say that steps under 5 are hidden in each answer, not that small numbers can
never be worked out (two overlapping custom ranges can recover one day's small count; Hassan L1,
accepted, `docs/modules/reporting/notes.md`).
The seller's "Product funnel" card has no API yet (FE-20261125-dashboards-seller-product-funnel), so
the seller KPI endpoint is unchanged. The card is built in the phase 2 cards PR.

### Zero-result searches (dashboards v2, phase 2)

`GET dashboard/admin/kpis` gains the section `zeroResultSearches` (key `catalog.product.view`, null
without it, `status: error` when it fails or takes over 1.5 s): reporting's
`marketplaceZeroResultSearches`, from the nightly rows only. `queries` (at most ten, most searches
first): `query` (the folded text; render it as a plain text node, never HTML or markup and never a
link, Hassan I4), `searches` (every search of the text by the counted customers on the days of the
period it found nothing at least once, including that day's searches that found something, Hassan
I3), `searcherDays` (each kept day's distinct signed-in searchers summed)
and `days`; `recordedDays` of `periodDays`. `not-enough-data` (`minimumSearchers: 10`) when no text
was searched by at least ten distinct customers on one day of the period. The "?" must say that a
text appears only on days at least ten customers searched it and that searches count on days it
returned nothing. The mock's "Top searches" card with a no-result share is
FE-20261125-dashboards-top-searches-no-result-share. The card is built in the phase 2 cards PR.

### Discount cost (dashboards v2, phase 2)

`GET dashboard/admin/kpis` gains the section `discountCost` (keys `commission-payouts.settlement.view`
and `promotions.promotion.manage`, both, null without either: spend is for promotion managers, so the
default Viewer, which holds the money key and promotion view, does not see it; owner's choice of
25 November; `status: error` when it fails or takes over 1.5 s; null too when
promotions refuses the key): reporting's `marketplaceDiscountCost`. The discounts of the orders whose
payment was confirmed in the period's Market days that still stand, with GST (`amount`), Mondapac's
and the sellers' shares (`platformShare`, `sellerShare`, `platformShareBp`), per kind (`promotion`,
`first-order`, `free-shipping`, each with `uses`, `amount`, `platformShare`, `shareBp`; zeros listed;
a kind of 1 to 4 uses has every figure null, and the shares of the kinds shown add up to 100.00%),
`change` and `previousAmount` against the period before (`na` below 100.00 of the currency before), and
`released`: the orders of the period refunded or cancelled after payment and the discount they gave
back (already left out of `amount`; null for 1 to 4 orders). `not-enough-data` below five
discounted orders. The money base of the change is 10,000 minor units in every currency (100.00 AUD,
10,000 JPY); scaling it per currency is deferred with the other KPIs
(FE-20261125-dashboards-money-base-per-currency). The card's "?"
must say the amounts include GST, while the finance section's net revenue subtracts the
platform-funded part without GST. Top promotions by cost and the seller's own discount cost are
deferred (FE-20261125-dashboards-top-promotions-by-cost, FE-20261125-dashboards-seller-discount-cost).
The card is built in the phase 2 cards PR.

### Monthly target and seller goal, with the month-end forecast (dashboards v2, phase 2)

API only; the cards come in the phase 2 cards PR.

- Market target: a Market setting `monthly-revenue-target` in the settings store (ADR-0026, the
  history table keeps every earlier target). Value `none` or `<currency>:<minor units>` in the
  Market's own currency. `GET` and `PUT settings/admin/monthly-revenue-target` (keys
  `settings.monthly-revenue-target.view` and `.manage`, unprotected; the view key is in the Viewer
  role, seed version 38). The change is the shared settings flow: version check, refused in
  acting-as, System requests review, revert, and the audit action
  `settings.monthly-revenue-target.changed` (money before and after). One standing target for
  every month until changed.
- Seller goal: table `reporting.seller_monthly_goals` (per seller and calendar month, version,
  docs/design/data/reporting.md). `PUT reporting/seller/monthly-goal` (key
  `reporting.seller-goal.manage`, a seller key the Seller Owner holds; denied while not approved;
  the session's seller only; this month or one of the next 12; audited as
  `reporting.seller-goal.changed`). Reporting owns it, not sellers: it is read only with
  reporting's figures and keeps the module to one schema; it is the one authored table of
  reporting (its down migration loses the goals).
- `GET dashboard/admin/kpis` gains `marketTarget` (keys `commission-payouts.settlement.view` and
  `settings.monthly-revenue-target.view`; null without both, `status: error` on failure or after
  1.5 s). `GET reporting/seller/kpis` gains `sellerGoal` (key `ordering.seller-order.view`, as the
  strip; null when refused, `status: error` on failure or after 1.5 s). Both are the current
  calendar month whatever the period.
- Revenue basis: the KPI one. Admin: GMV with GST (goods of paid seller orders on their paid day;
  refunds never lower it). Seller: sales with GST, the same basis per seller. Days and the month
  are the Market's (the rollups are by Market day), also for the seller goal: the seller's own
  zone is not used (FE-20261125-seller-goal-seller-zone). A goal cannot be removed yet
  (FE-20261125-seller-goal-remove); the Market target is one standing value, not per month
  (FE-20261125-market-target-per-month).
- Forecast (`reporting/domain/month-forecast.ts`): month to date ÷ time elapsed in the month ×
  length of the month, both exact time from the month's start to the next month's start in the
  Market zone (a month with a daylight-saving change is as long as it really is), half up. Always
  an estimate (`status: estimate`); `not-enough-data` while fewer than 3 whole Market days of the
  month are behind today (so from the 4th). With it: the whole month before, `progressBp`
  (to date ÷ target), `paceBp` (forecast ÷ target), `toGo` and `perDayToGo` (`daysLeft` counts
  today). A target in another currency than the Market's is shown as no target.

### Abandoned carts (dashboards v2, phase 2, nightly snapshot)

`GET dashboard/admin/kpis` gains the section `abandonedCarts` (key `ordering.order.view`, null
without it, `status: error` when it fails or takes over 1.5 s): reporting's
`marketplaceAbandonedCarts`, from `reporting.daily_abandoned_carts` only. `carts` and
`approximateValue` (Money as a string; null with mixed currencies) of `asOfDay`, the latest snapshot
day of the period, with `change` against the latest day of the period before (`na` below 5 carts
there), and `recordedDays` of `periodDays`. `not-enough-data` below 5 carts (no count, no value) or
with no snapshot in the period (the period "today" has none until tomorrow). The card must say
"about" for the value (prices when the items were added) and show the count as "untouched 24h+ as of
<day>", not as a total of the period. "Reminders sent" is not in the API
(FE-20261125-dashboards-abandoned-carts-reminders-sent). The card is built in the phase 2 cards PR.

### Phase 2 cards (dashboards v2, phase 2, cards PR)

The phase 2 sections now have cards. Admin (`apps/admin/src/dashboard/kpi-phase2.tsx`; shared card
pieces moved to `kpi-parts.tsx`), after the chart and Needs action: a row with Monthly target and a
column of Shopping funnel with a compact Abandoned carts card under it (as in the design); the existing row (sales by category, orders by status, supply
and health); Top sellers; then a row with Searches with no results, Orders by state and Discount
cost. Each card is left out when its section is null or absent (no key; the panel mirrors the API's
keys in `allowedOf`), shows an in-place error with a secondary "Try again" (reads the page
again) when its section is `error` or the whole
read failed, a skeleton while the read streams, and "Not enough data yet" in words (never 0) for
`not-enough-data`, a hidden funnel step ("Fewer than 5") and a held-back discount kind. Each has a
"?" with the rules the sections above ask for (funnel: customer-days and steps under 5 hidden in
each answer; searches: counted on the days a text found nothing, shown only when 10 or more
shoppers searched it in a day; discounts: with GST, unlike net revenue). The pace badge says it in words, not by colour only ("On pace for X%" at 100% or more,
"Behind pace: X%" below); the gauge's text alternative says the same figure as its centre; the
"Estimate" badge shows only with a forecast. Muted text on the tiles (`fg-muted` on `bg-muted`)
measures 5.2:1 light and 5.6:1 dark. A zero-result text is
rendered only as a React text node (no HTML, link or title attribute; tested with markup in it).
Orders by state shows the region code as the API sends it
(FE-20261125-dashboards-orders-by-state-names).

The target is edited on the dashboard: with `settings.monthly-revenue-target.manage` the Monthly
target card has an Edit button that opens a dialog (`target-editor.tsx`): it reads `GET
settings/admin/monthly-revenue-target` (version, review flag), sends `PUT` with the version, a note
where the area is reviewed (an amount takes a comma only as a thousands separator), or `target: null` to remove it, and reads the page again. The currency is
the Market's from the KPI section, because the settings read does not name it while no target is
set; a Settings page is FE-20261125-market-target-settings-page. Both routes were added to the admin
BFF.

Seller (`apps/seller/src/dashboard/kpis/seller-goal.tsx`): Monthly goal beside the sales chart, from
`sellerGoal` of the KPI read; left out when null, error in place with "Try again", "Set goal" or
"Edit goal" in the card header only with `reporting.seller-goal.manage`. The dialog sets this month's goal (`PUT reporting/seller/monthly-goal`
through the BFF, the version seen; future months are FE-20261125-seller-goal-future-months). The
panel cannot tell an acting-as session in advance: the API refuses it with 403 like a missing key,
and the dialog says the goal can only be set by the store owner signed in as themselves. The seller
new-versus-returning and product funnel cards have no API yet and are not built. Built in code first
under speed mode (FE-20261125-dashboards-phase2-cards-figma-backport). Screenshots:
`apps/admin/test/dashboard-shots`, `apps/seller/test/dashboard-shots` (not part of CI).

## Drill-down (dashboards v2, phase 2)

A click on an admin dashboard figure opens the Orders list on the matching filter (the URL
filters of PR 1331). Every address is built by one pure helper, `ordersHref` in
`apps/admin/src/orders/orders-link.ts`: it writes only the names and values the list's own reader
takes (`status`, `fulfilment`, `paymentState`, `placed`, `from`/`to` as real yyyy-mm-dd days, from
the list's constants), drops any other value and a backwards range, and encodes with
`URLSearchParams`. No text from an answer and no id of a person reaches an address.

| Element | Opens |
|---|---|
| GMV and Seller orders paid cards | `/orders?from=<period from>&to=<period to>` |
| Orders by status: Delivered, Shipped, To ship (legend row and table row) | `/orders?fulfilment=<delivered\|shipped\|to-ship>&from=&to=` |
| Orders by status: Cancelled | `/orders?status=cancelled&from=&to=` |
| Orders by status: card action "Orders" | `/orders?from=&to=` |
| Revenue chart, GMV and Orders measures: a day (pointer column, Enter on the focused chart, table row) | `/orders?from=<day>&to=<day>` |
| Revenue chart action "View orders" | `/orders?from=&to=` |
| Work queue: Failed customer payments | `/orders?status=cancelled` |

How it is built: `ShareBar` (packages/ui) takes `href` and `linkLabel` per part; a linked legend
row is an `<a>` with the same grid, so the layout does not move. `LineAreaChart` takes `href` and
`linkLabel` per point: a transparent column per day is a link for a pointer (out of the tab order,
so a long range adds no tab stops), Enter on the focused chart follows the active day's link (the
live text says so), and in "View as table" each day is a focusable link. Names: "View orders:
Delivered, placed 16 Nov - 22 Nov" and "View orders placed on 21 Nov". The names hold no count on
purpose: the KPI counts seller orders by their paid Market day, the list shows orders by their
placed day on the admin's clock, so the list is the closest match, not the same number
(FE-20261125-dashboard-drill-paid-day).

Not linked (no matching list filter, so no link is invented):

- Orders by state rows: no delivery-state filter (FE-20261125-dashboard-drill-orders-by-state).
- Discount cost order count: no discounted or promotion filter
  (FE-20261125-dashboard-drill-discounted-orders).
- Orders by status Refunded part and the Refunded chart measure: no refund filter on the list, and
  the Refunds list reads no filter from the address (FE-20261125-dashboard-drill-refunded-orders).
- Sales by category: no category filter (FE-20261125-dashboard-drill-category).
- Failed customer payments opens every cancelled order, not only payment failures of the last 24
  hours (FE-20261125-dashboard-drill-failed-payments).
- Monthly target, shopping funnel, abandoned carts, zero-result searches, net revenue, average
  order: no list of their items exists; a zero-result text never goes into an address.
- Seller dashboard: the seller orders list reads no filter from the address (only `view=board`), so
  its cards and sales chart keep their plain links (FE-20261125-dashboard-drill-seller-orders).
