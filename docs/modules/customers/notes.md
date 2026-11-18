# customers: build notes (speed mode)

The buyer's own data beside the `identity` account. The owner approved the customer plan on
2026-10-17 (all five packages, one PR each); under speed mode there is no separate G1/G2 brief.
This note records what is built and the rules it keeps.

## Package 1: delivery address book (this module's first slice)

- Table `customers.addresses`: one row per address of a customer account (`account_id`, no
  foreign key). Everything the customer typed (recipient first and last name, phone, address
  lines, suburb, region, postcode, delivery notes) is one ciphertext under the account's subject
  key (`customers.address.content`), so destroying the key at account deletion erases every
  address. Only the country, the default flag and the times are clear. At most one default per
  account (partial unique index).
- Routes `customers/me/addresses` (customer sessions only, CSRF on writes, `no-store`): list,
  add, change, remove, and `POST :id/default`. Use cases are `own-resources`; there is no
  permission key and no admin view. The customer comes from the session, never from the body.
- Rules: the first address is the default; removing the default makes the newest remaining one
  the default; `isDefault: false` never clears the default. At most the Market's
  `customers.addressBookLimit` addresses (AU 20). Recipient name and phone are required (delivery
  only, no SMS).
- Market configuration `customers.address`: country, postcode pattern and region list (AU: the
  eight states and territories, four-digit postcode). A Market without the section answers
  `customers.unavailable`.
- No address value reaches a log, an event, an audit row or an error (a refused field gives its
  path and a code only). Every write of the address book (add, change, remove, set default, and the erasure of an account) first takes the book's advisory lock `customers.lock-address-book` (lock class 1705, one lock per Market, tenant and account) and runs at READ COMMITTED, so writers of one book run one after the other. The limit and the one default span rows; the unique index of the one default is the second line. (They ran serializable and sometimes ran out of retry attempts with 40001 under parallel writers.)

## Package 2: the address at checkout and on the order

- `POST /orders/checkout` takes `{ "addressId": "<uuid>" }`, one of the customer's own
  addresses. Ordering reads it through `CUSTOMERS_CHECKOUT_FACADE` (use case
  `customers.read-delivery-address`, `own-resources`) before the cart or the stock is touched:
  missing is `validation.failed` (400), another customer's, unknown or erased is
  `ordering.address-not-found` (422). Stripe Checkout still collects no address.
- The order keeps a fixed copy in `ordering.orders.ship_to_ciphertext`: the address and its
  country as one ciphertext under the customer account's subject key (`ordering.order.ship-to`),
  written once at insert. A later change or removal in the address book never touches it;
  destroying the key at account deletion erases it while the order's money stays.
- Who sees it: the customer on `GET /orders/:id`, as `shipTo` (recipient name, phone, address
  lines, suburb, region, postcode, delivery notes, country), and the platform when it books the
  courier. The seller never does (owner decision 2026-11-17): its own seller order page (view,
  ready, deliver, pickup) names the customer as `customer` `{ code, firstName }`, the code the
  shop knows them by on its Customers list (`customers.seller-order-customers` through
  `CUSTOMERS_READ_FACADE`, rule `ordering.seller-order.view`), plus the customer's note to the
  shop. Lists and the admin order page carry no address. `shipTo` is null on orders placed
  before this package and once the account was erased.
- Hassan (PR #406 review: GO) follow-ups: (1) done: the seller no longer gets `shipTo` at all
  (2026-11-17); the retention rule now governs only the customer's note to the shop.
  (2) Removing an address from the book does not remove its copy on placed orders; only account
  erasure (package 5) does. The privacy notice must say so.

## Next packages

3. Customer profile API. 4. Marketing consent record in `legal`.
5. Customer account deletion (v1.5, CUS-03), built in three PRs: 5a and 5b (below, built), 5c.

## Package 5a: account deletion setting and server lock (API only)

Owner approved design v2 on 2026-10-26. Package 5a is the setting and the lock only. There is no
admin screen and no buyer screen yet (screens wait for Reza's review), no deletion flow and no
manual admin deletion.

- **Setting.** One row per Market version in `customers.account_deletion_settings` (insert-only,
  the application role has SELECT and INSERT only, like `assistant.settings`): `enabled`
  (built-in default false) and `waitingPeriodDays` (default 30, allowed 7 to 90). Version 0 is the
  built-in defaults. Each row also keeps the admin account, the time and the `reason`.
- **Admin routes** (population `admin`, `no-store`): `GET` and `PUT
  customers/admin/account-deletion-settings`. View needs `customers.account-deletion-settings.view`
  (plain, in the Viewer default role, seed version 15). Change needs
  `customers.account-deletion-settings.manage`, a protected key held by the Platform Administrator
  only. The body is `{ expectedVersion, settings: { enabled, waitingPeriodDays }, reason }`; CSRF
  as every unsafe route; `reason` is 1 to 500 characters of one line of plain text; a stale
  `expectedVersion` answers `customers.conflict` (409); the same values again change nothing.
- **Audit and event.** A change writes the history row (with the reason), an audit row
  `customers.account-deletion-settings.changed` (versions, `enabled`, `waitingPeriodDays`; audit
  fields hold no free text, so the reason is only in the history row, which is part of the audit
  evidence) and the outbox event `customers.account-deletion-settings-changed.v1` (previous and
  new `enabled` and `waitingPeriodDays`; no actor, because events carry none (ADR-0018 decision
  4), and no reason text), in one unit. `customers` gets its own `customers.outbox` table for it.
- **Admin step-up** (owner decision, after PR #515). A change also needs a fresh two-step
  proof of the admin's session for the admin step-up action
  `customers.account-deletion-settings.change` (`POST identity/admin/step-up/verify`, valid 5
  minutes), exactly as the wallet switch (`wallet.settings.change`): `@RequiresStepUp` on the
  `PUT` route refuses without one with `403 second-factor.required` and `details.actionKey`
  (`second-factor.enrolment-required` when the admin has no active two-step), and the flow spends
  the proof in the unit of the change, so one proof serves one change and a refusal commits
  nothing. A no-op, an invalid body or a stale version spends no proof. The audit row's `after`
  names the proof (`stepUpSessionId`, `stepUpVerifiedAt`). An acting-as session is refused. The
  `GET` needs no proof.
- **Customer route.** `GET customers/me/account-deletion` (customer sessions only, `no-store`)
  answers `{ canDeleteAccount, waitingPeriodDays }`. The buyer UI reads only this.
- **Server lock.** `assertAccountDeletionAllowed(settings, market)` in
  `application/account-deletion-settings-flow.ts` fails with `customers.account-deletion-disabled`
  (HTTP 403 in `CUSTOMERS_STATUS`) while the Market has deletion off, else answers the waiting
  period in force. Package 5b calls it first, inside its own unit of work, and only to start a
  request.

## Package 5b: buyer deletion flow (API only)

Owner approved design v2 on 2026-10-26. No screens (Reza later). The flow lives in
`CustomersAccountDeletionModule` (`customers/account-deletion.module.ts`), registered in
`modules/index.ts` beside `CustomersModule` (as `SellerStoreProfileModule`): `ordering` imports
`customers`, so `CustomersModule` cannot import `ordering` without a module cycle. It is not in
the customers barrel.

- **Routes** (customer sessions, `no-store`, CSRF on the unsafe ones): `POST
  customers/me/deletion-requests` (body `{ confirm: true }`; 201 `{ status, requestedAt,
  scheduledFor, waitingPeriodDays }`), `GET .../current` (404
  `customers.account-deletion-request-not-found` when none), `DELETE .../current` (204).
- **Request order.** (1) `assertAccountDeletionAllowed` (403 `customers.account-deletion-disabled`
  before any module is asked); (2) blockers, each through the owning module's facade: open orders
  and pending refunds (`ordering.ownOpenObligations`), wallet balance available or held above 0
  (`wallet.ownBalanceOf`). 409 `customers.account-deletion-blocked` with `details.blockers`
  (`open-orders` and `pending-refunds` with a count, `wallet-balance`); a module that cannot answer
  fails closed (503 `customers.unavailable`); (3) one serializable unit: the setting again, one
  pending request per account (partial unique index, 409 `...already-requested`), insert at
  `now + waitingPeriodDays` of the setting in force (Clock, UTC), audit row, outbox event;
  (4) `identity.endOtherCustomerSessions` ends every other session (the one that asked stays and
  can cancel). If that call fails the request stays committed and the failure is logged.
- **Setting race (5a review L1).** `SetAccountDeletionSettings` now runs serializable too, and a
  conflict answers `customers.conflict`, so a request and a switch-off are ordered one way or the
  other and two changes from the same version leave one winner. The client sends no raw SQL, so a
  `FOR SHARE` on the insert-only history was not possible; a request that serialised just before
  a switch-off is a request made a moment earlier (switching off never cancels, owner decision).
  `test/db/customers-account-deletion.db-spec.ts` (second block) covers both races.
- **Executor** `customers.execute-account-deletions` (hourly job, worker role, 25 requests per run,
  system actor). Per due request (a pending one whose date has come, or an `executing` one whose
  claim is older than 15 minutes), each step safe to repeat: (1) blockers under the system actor
  (a blocked request stays pending, no side effect); (2) the **claim**, in its own serializable
  unit and before any irreversible step: one conditional update `pending` to `executing` with
  `claimed_at` (or a stale claim taken again), and only the run whose update matched goes on, so a
  cancel and a second run cannot overlap with the work (review finding H1); (3)
  `identity.endAllCustomerSessions` (system) ends every remaining session of the account, so no
  order or credit can land afterwards (Hassan L1); (4) the blockers once more: a blocker found here
  gives the claim back (`pending`, cancellable) and the request waits; (5)
  `identity.eraseCustomerAccount` with the request id (subject key destroyed, account row,
  credential, sessions and links deleted, audit `identity.account.erased` with `after.requestId`;
  `already-erased` on a re-run); (6) `engagement.forgetAccount` and `reviews.detachAuthor`
  (reviews and ratings stay as "Former customer"); (7) one unit deletes the account's
  `customers.addresses` rows, closes the request `completed` (only from `executing`) and writes
  audit and event. A failing request is logged by class name and left `executing`; a later run
  repeats it once the claim is stale. Orders, tax invoices and payments stay (ids only).
- **Cancel and the claim.** `DELETE .../current` matches only `pending`. A claimed request answers
  409 `customers.account-deletion-in-progress` (also for `cancelPendingOnSignIn`); a unit that
  conflicts with the claim answers 409 `customers.conflict` and the next try is definite. So a 204
  always means the account will not be erased. `GET .../current` shows `status: "executing"`.
  `viewCurrentAccountDeletionRequest` refuses acting-as sessions like the other routes.
- **Data.** `customers.account_deletion_requests` (ids, status, waiting period, times; no personal
  data; the application role may update only the state columns and may not delete; see
  `docs/design/data/customers.md`). Events
  `customers.account-deletion-requested.v1`, `-cancelled.v1`, `-completed.v1` (aggregate = the
  request; no account id). Audit `customers.account-deletion.requested`, `.cancelled`, `.completed`.
- **Facade additions.** identity `endOtherCustomerSessions` (customer, own) and
  `endAllCustomerSessions` and `eraseCustomerAccount` (system; the erase takes the request id); wallet `ownBalanceOf` (customer, own); ordering
  `ownOpenObligations` (customer, own) and `openObligationsOf` (system). `CUSTOMERS_ACCOUNT_DELETION_FACADE`
  (`cancelPendingOnSignIn`) is the call a sign-in flow would make.

### Not built, because the platform has no mechanism (follow-ups)

- **No customer step-up or OTP.** Identity has second factors for admins and sellers only. The
  request asks for no proof of the buyer; a customer OTP needs its own identity slice.
- **No account lock and no cancel on sign-in.** Identity has no post-sign-in hook or sign-in event
  and may not import another module. After the request only the other sessions end; the buyer
  can sign in again and is not refused, and signing in does not cancel. A hook (or an identity
  event customers can consume) would call `cancelPendingOnSignIn`; a lock needs an identity
  account flag. The executor's blocker re-check covers an order placed in the meantime.
- **No emails** (request received with cancel instructions, completed): `notifications` has no
  transactional customer email facade, only events (which carry no address). The three events are
  ready for it; a completed notice also cannot read an address once the key is destroyed, so it
  must be sent before the erase.
- **M2, pre-launch blocker for any buyer UI.** The buyer is asked for no step-up (no customer OTP),
  signing in or resetting the password does not cancel the request, and no email is sent. Until
  these exist the buyer deletion screen must not ship.
- **M3, erasure does not yet cover** `assistant.conversations` (the assistant text is the
  important one: it can hold what the buyer typed), cart rows and saved items, per-account
  `notifications` rows and the wallet account row. Each owning module needs its own
  forget-account call, added to the executor like `engagement.forgetAccount`.
- **The blocker check outside the serializable unit.** The request's blocker read (orders, refunds,
  wallet) is not part of the serializable insert: an order placed in between is caught by the
  executor's two re-checks (before the claim and after every session is ended).
- **Mojtaba L3, closed-once in code only.** A `cancelled` or `completed` row is never updated
  again because every update names the status it moves from; no trigger or CHECK enforces it.
- **Mojtaba L5, retention.** Deletion request rows are kept as the audit record of the erasure;
  no retention period is set.
- **No account lock after the sessions end.** `identity.endAllCustomerSessions` ends every session,
  but the buyer can sign in again between it and the erase; the last blocker check and the erase
  follow within one run, yet a sign-in plus an order in that gap is only caught by the next
  retry. A real lock needs an identity account flag.
- **Erase callers are not restricted by a boundaries allow-list.** `identity.eraseCustomerAccount`,
  `endAllCustomerSessions` and `customerAccountExists` are `system` use cases reachable from any
  module that holds the identity facade; only `customers` should call them, and no `pnpm
  boundaries` rule enforces it yet.
- **Claim hand-back.** A request that was already `executing` when a run took it (a resumed stale
  claim) is handed back to `pending` only after `identity.customerAccountExists` says the account
  is still there; if it is already erased the run finishes the remaining steps with a warn log
  (ids only), and if identity cannot answer the request stays `executing` for a retry. `complete`
  matches the run's own `claimed_at`, as `release` does. `identity.endAllCustomerSessions` writes
  `identity.account.sessions-ended-for-erasure` (account id, request id, count).
- **No returns or disputes module**: only open orders and pending refunds are blockers.
- **Market without wallet settings** fails closed (503) because the wallet cannot answer.

### What packages 5c will do

- **5b, buyer flow.** Built (above).
- **5c, admin manual deletion.** Built (above). An admin deletes a buyer's account with a ticket reference, a
  reason and an OTP, under a new `buyers.account.delete` permission, with the same blockers and
  the same waiting period.

## Package 5c: admin manual deletion (API only)

Owner said «ساخت» on 2026-10-28 (design v2 section 4-ب, decision ح5). No screens (Reza later). The
admin deletes a buyer's account for them, from a support ticket.

- **Routes** (population `admin`, `no-store`, CSRF on the unsafe ones, `@RequiresStepUp
  ('customers.buyer-account.delete')`, acting-as refused): `POST customers/admin/buyers/:accountId/
  deletion-requests` (body `{ ticketRef, reason, confirm: true }`, closed; 201 `{ requestId, status,
  requestedAt, scheduledFor, waitingPeriodDays }`), `DELETE customers/admin/deletion-requests/
  :requestId` (body `{ reason }`; 204) and `GET customers/admin/deletion-requests?status=pending
  &cursor&limit` (page of `{ requestId, accountId, requestedAt, scheduledFor, status, requestedBy }`
  and `nextCursor`; earliest date first; no names, emails or ticket text).
- **Permissions.** `customers.buyer-account.delete` (protected: Platform Administrator or a custom
  role; the spec's `buyers.account.delete` cannot be declared by `customers` because a key starts
  with its module, `definePermission`) and `customers.account-deletion-requests.view` (plain, Viewer
  seed version 21). The step-up action key is `customers.buyer-account.delete` (admin audience,
  locked), one proof per request or cancel, spent in the unit of the write; a refusal (blocker,
  already requested, not found, validation) spends none.
- **Request order.** Admin and body validation (400); the buyer through `identity.customerAccountOf`
  (404 `customers.buyer-account-not-found` for a malformed, unknown, non-customer, disabled or other
  Market's account, alike); blockers as 5b (open orders, pending refunds, wallet balance; 409 with
  the typed list, 503 when a module cannot answer); one serializable unit: one open request per
  account (409), proof spent, insert at `now + waitingPeriodDays` of the setting in force (version
  0 means 30), audit, event; then `identity.endCustomerSessionsForAdmin` ends every buyer session
  (a failure is retried once, then logged at warn with ids only; the request stays). The Market's self-service switch does not apply.
- **Cancel.** Whoever made the request, `pending` only; `executing` is 409 in-progress, a closed or
  unknown request 404, as the buyer's cancel. The buyer can still cancel an admin request.
- **Data.** Migration `20261029140000_customers_account_deletion_admin`: `requested_by`,
  `admin_account_id`, `ticket_ref`, `reason`, `cancelled_by_admin_id`, `redacted_at`; `cancel_reason`
  gains `admin` (see `docs/design/data/customers.md`). The ticket reference and the reason are
  admin-entered text and possible personal data: on the row only, not in audit fields (they hold no
  text) and not in events. **Redaction (Hassan M2, Mojtaba 1):** when an admin request closes
  (cancelled by the buyer or an admin, or completed) the same unit sets `reason` to NULL and
  `redacted_at`; the closing write is one statement that redacts, a CHECK demands it for a closed admin request, and a trigger lets `reason` change only to NULL with `redacted_at`; the ticket reference
  stays. The admin's cancel note is validated but never stored (the admin id and the proof are in
  the audit row), so there is no `cancel_note` column. The OpenAPI text tells admins not to enter
  personal data in the reason.
- **Events and audit.** `customers.account-deletion-requested-by-admin.v1` (waiting period,
  scheduled instant) and `customers.account-deletion-cancelled-by-admin.v1` (empty payload), both on
  the request aggregate; audit `customers.account-deletion.requested-by-admin` (account id, dates,
  step-up proof) and `.cancelled-by-admin`. The admin is the audit row's actor.
- **Peers added (rule `permissions [customers.buyer-account.delete]`, platform admin only, no
  seller, not acting-as; Hassan M1: any other admin, a Viewer included, is refused at the gate).** identity `endCustomerSessionsForAdmin` (audit
  `identity.account.sessions-ended-for-erasure` now also allows an authenticated actor), ordering
  `adminOpenObligationsOf`, wallet `adminBalanceOf`. A module may not mint a system context, so the
  system-only reads of 5b could not be reused.
- **Executor** unchanged: it handles admin requests as the buyer's.

### Not built (5c gaps)

- **No buyer email** (request received with a cancel link): `notifications` still has no
  transactional customer email facade (same gap as 5b). The buyer learns of it only through the
  ended sessions and support.
- **No SOC emission.** No SOC or security-event facade is reachable from `customers`; the audit row
  and the event are the record.
- **No disputes blocker.** `payments` disputes (`disputesOfOrder`, `disputeOf`) answer per order or
  dispute id; there is no per-account query, so open disputes are not a blocker (also in 5b).
- **A disabled buyer account** answers 404 (`customerAccountOf` answers active accounts only).
- **Admin cancel notice to the buyer** is also not sent (no email facade).

### 5c review follow-ups (not built)

- **Keyset `OR` form (Mojtaba 2).** The pending list pages with `scheduled_for > x OR (scheduled_for = x
  AND id > y)`. A row-value comparison (`(scheduled_for, id) > (x, y)`) would use the partial index
  more exactly; do it when the list grows past a screen of rows (Prisma needs a raw query).
- **Probe before the proof (Hassan L2).** The admin request reads the buyer's account and the
  blockers before the step-up proof is spent, so an admin with a valid proof can probe whether an
  account id is a customer of the Market without spending it. Only an admin holding the protected
  key gets here; move the proof ahead of the probes if that is thought too much.

## Package 5d: screens (PRs #569 buyer site, #570 admin)

- **#569 buyer site.** Delete account page and the Privacy card entry, driven by `canDeleteAccount`.
  The Market setting stays **Off** (default); nothing switches it on. It may be turned on only after
  a buyer OTP, cancel on sign-in and the emails exist (M2), by a new owner decision on the board.
  The copy promises no email, lock, sign-in cancel or code.
- **#570 admin.** Settings tab "Account deletion" (On/Off, waiting period, pending count: first page
  of 100, "100+" when more), pending requests list with cancel, and "Delete this buyer's account" on
  the customer lookup card. Every write goes through the shared step-up dialog and a reason dialog.
- **Left out.** "Last changed by/at" (GET returns only `version` and `settings`); blockers show only
  after the attempt (no preflight route). No SOC emission: events and audit only.

## Open follow-ups (Hassan, PR #405 review: GO, two low findings)

- Rows under a destroyed account key still count toward the limit and can be promoted to the
  default. Package 5 (account deletion) deletes the account's `customers.addresses` rows with the
  key, which closes this.
- One damaged ciphertext row makes the list answer 500 (`addressFromJson` throws). Later: let
  `open` return a typed failure, skip the row and log only the address id and a code.

## Customers management, phase 1, package B1: read models and the last-order facade (15 Nov 2026)

- **Tables.** `customers.customer_directory` (a copy of the identity account: sign-in address,
  display name, status, email verified, signed up; PERSONAL DATA, never logged or put in an event)
  and `customers.customer_stats` (first and last confirmed order, order count, spent, refund count
  and amount; no personal data). One row per customer and Market. Both are removed in the unit that
  erases the account (account deletion), and removed or recreated by the sync when identity no
  longer has the account.
- **Kept by events, replaced never incremented.** `SyncCustomerReadModel` consumes
  `identity.customer-account-registered`, `account-display-name-changed`, `account-email-verified`,
  `account-disabled` and `account-enabled`, and `ordering.order-paid` and `refund-succeeded`. It reads
  the account through `identity.customerDirectoryRecords` and the totals through
  `ordering.customerOrderStats` (both rule `system`, before any unit opens) and replaces the rows, so a
  repeated or late event changes nothing. `customers` cannot import `ordering`, so the peers are
  bound at start by `CustomersReadModelsModule`, like the deletion flow.
- **Inbox (fix, 16 Nov 2026).** The subscribers handle each event once through `runOnce`, which
  needs `customers.inbox`. B1 shipped without it, so every delivery failed and was retried until
  dead-lettered; migration `20261116000000_customers_inbox` adds it, and
  `email-verification.db-spec.ts` now checks that a sign-up reaches the directory through it.
- **Backfill and reconcile.** Job `customers.reconcile-read-models` (daily and at worker start) walks
  `identity.customerDirectoryPage` and `ordering.customerOrderAccounts` by keyset (at most 200 pages of
  200 per phase per run) and replaces every row.
- **Facade.** `CUSTOMERS_READ_FACADE.lastOrderAt(system context, accountId)` and
  `ownLastOrderAt(customer context)`: the last confirmed order, `null` for none, and
  `customers.customer-unknown` for a customer with no directory row (the caller fails closed).
  Promotions' `CUSTOMER_ORDER_HISTORY` is bound to it; an admin's preview of the returning-customer
  discount answers "unknown" until a permission-based read is needed.
- **Left for B2 and B3.** Done in the section below.

## Customers management, phase 1, packages B2 and B3: the admin list API and the customer page reads (15 Nov 2026)

- **The list (B2).** `POST customers/admin/list` (key `customers.customers.view`; `POST list/ids` answers select-all) reads the two
  read models in one query (a composite foreign key from stats to directory). Views: all, new (30
  days), active (an order in the last 90 days), inactive, never-ordered, disabled, pending-deletion.
  Search is an email prefix or a name `contains` (2 to 80 characters). Filters: status, verified,
  joined and last-order dates, order count, spent in minor units. Sorts: joined, name, email,
  last-order, orders, spent, each with the id as tie-break. Page mode (`page`, `pageSize`, total, cap
  10,000 rows) and cursor mode (`o<offset>`). `ids` answers select-all (cap 10,000). Counts of every
  tab come with the list. The answer is personal data: never logged, `Cache-Control: no-store`.
- **Export.** `customers.customers.export` plus a fresh two-step proof (`customers.customers.export`,
  spent inside the unit). CSV (formula-safe through `platform-import`, with BOM) or XLSX, streamed in
  chunks; more than 10,000 customers is refused whole. The audit row holds the format, the row count, whether
  ids or a filter selected them and the proof's session and instant, never an address or a name.
- **Saved filters.** `customers.saved_filters` (personal, or shared with `customers.saved-filter.share`;
  50 per owner, 20 shared; a closed document that holds filter keys only). Sharing, changing and
  removing a shared one is audited.
- **The customer page (B3).** `GET customers/admin/customers/:accountId` is the header and Overview
  (profile, totals, first and last order, refunds). `POST .../tab-opened` audits the opening of the
  Orders and Money tabs. Every open writes `customers.customer-page.opened` (tab and admin; no
  customer data), in the unit that reads the customer, so a page that cannot be audited is not shown.
  A customer of another Market, or none, is `customers.customer-not-found`.
- **Tabs read from the owning module by account id, each under its own key.** Orders:
  `GET ordering/admin/orders?accountId=` (`ordering.order.view`). Refunds:
  `GET ordering/admin/customers/:accountId/refunds` (`ordering.order.view`, newest 100 with their
  credit notes). Wallet: `GET wallet/admin/customers/:id` (balance) and
  `.../history` (journal, `wallet.credit.view`). Credits: `GET promotions/admin/customers/:id/credits`
  (`promotions.promotion.view`; index `credit_issuances_recipient_newest_idx`).
- **Known gaps.** (1) The list cannot search by order number: the only peer that resolves an order
  number (`orderNotice`) is a `system` read and refuses an admin context; it needs an admin-keyed read in
  `ordering`. (2) Promotion usage per customer (code redemptions) is not readable: `promotion_usage` is
  per promotion, not per account. The Money tab shows credits issued, not code usage.
- **Known limits of the audit.** Only the Overview read and `tab-opened` write the page audit row. The
  tab data endpoints of the owning modules (orders by `accountId`, refunds, wallet history, credits)
  check their own key and write no row, and the default Viewer holds `ordering.order.view` and
  `promotions.promotion.view`, so it can read ids, amounts and codes of a customer by account id
  (no name or address). Accepted for phase 1; a per-account audit in the owning modules is the
  follow-up if the owner wants it.
- **Export keys.** The export needs `customers.customers.view` and `customers.customers.export`, and
  a fresh proof of `customers.customers.export` (registered in `STEP_UP_ACTION_KEYS`).
- **Performance follow-ups (database review).** The seven tab counts run on every list request
  (about 0.8 s at 500,000 customers; cache or one `FILTER` query when a Market passes about 200,000).
  `customer_directory_email_prefix_idx` is partial and the planner never uses it for a prefix search
  (make it a full `text_pattern_ops` index in a new migration). A name search of three characters or
  more is a scan of the Market until `pg_trgm` is approved. The two sort indexes on the stats
  table are not used by the left join and can be dropped later.

## Customers management, phase 1 frontend: F1 list and F2 customer page (15 Nov 2026)

- **Customers list** (`apps/admin/src/customers/customers-list.tsx`, `/customers`) replaces the exact-email lookup. It is a
  super list on `SuperList`/`SuperTable`: the seven tabs with counts, saved filters (`customers/admin/saved-filters`),
  search (email start or name, 2 to 80 characters; shorter is not sent), filters, sort, columns (this browser),
  selection with "select all matching", the Bulk action menu (Export, with the `customers.customers.export` two-step code)
  and the row Actions menu (open, copy email, copy account id, disable or enable). The nav item and the dashboard's
  "Find a customer" now need `customers.customers.view` (was `identity.customer-account.view`).
- **Customer page** (`/customers/:accountId`, `?tab=overview|orders|money`): header (status, verified, joined; Issue
  wallet credit; More: disable or enable, delete through the 5c dialog), Overview figures and profile, Orders (the admin
  Orders list scoped with `accountId`, no Customer column, no saved filters), Money (Spent, Refunded, wallet balance;
  refunds, wallet journal and promotion credits, each under its own key). `tab-opened` is called once per tab per visit
  before the tab's data is read.
- **Known gaps (phase 2 backend):** order-number search; refunds read capped at 100 with no paging or sort (the page
  pages the 100 in the browser); payments per order, chargebacks and code usage per customer; the
  "deleted customer" view (erasure removes the directory row, so the page says not found). The spent filter is typed in
  the currency the rows carry (the panel has no Market currency setting); with no ordering customer on the page it is
  hidden.
- **Review round 1 (PR #925):** the Overview read now carries `deletionRequest` (the open request: id, pending or
  executing, requested and scheduled instants), so the page shows the banner with the date and Cancel and offers no
  second request. The panel relay allows the new routes (list, export with a 48 KB body cap for 1000 ids, saved
  filters, the overview, `tab-opened`, refunds, wallet journal, promotion credits) and lets `accountId` (a UUID) cross
  on `ordering/admin/orders`. More than 1000 ticked rows are refused instead of exporting the whole filter. The
  customer's Orders tab keeps its own column choice; an order opened from it (or from Money) has Back to the customer.
  The page tabs use the ARIA tabs pattern (`Tabs` with `panelId`).
- **Still open:** the day filters (joined, last order) are evaluated as UTC days on the API while the list shows days in
  the admin's zone (ADR-0005; phase 2 backend). A shared saved filter may hold an email prefix as its search; every
  admin who sees it already holds `customers.customers.view`. The `tab-opened` audit is written because the page calls
  it first; a direct read of the owning module's route is audited by that module only.

## Customers management, phase 2, PR 2a: groups, notes, the activity timeline and the name edit (15 Nov 2026)

- **Manual groups.** `customers.customer_groups` and `customer_group_members` (migration
  `20261116060000_customers_groups_notes_timeline`). A group has a name unique per Market whatever
  its case (index `customer_groups_name_key` on `lower(name)`), an optional description, a version
  and an archive instant; it is never deleted (a promotion may name it). Routes under
  `customers/admin/groups` (`GET`, `POST`, `GET/PUT :groupId`, `POST :groupId/members/add|remove`),
  key `customers.groups.manage` (protected, owner decision 15 Nov 2026: a group can carry a
  discount) with `customers.customers.view` to change, the view key to read. At
  most 500 groups per Market. Members are added or removed by `ids` (at most 1,000) or by the
  Customers list's `view`, `q` and `filters` ("select all matching", at most 10,000; more is
  refused whole with the total). Ids that are no customer of the Market are skipped; an archived
  group takes no new members. Every change is audited (`customers.customer-group.created`,
  `.changed`, `.members-changed`: how many and how they were picked, no names) and lands on each
  customer's timeline.
- **Members list = the Customers super list.** The list gains the filter `group` (a group id) and
  the column `groups` (names, archived flagged), also in the export. No second list was built.
- **Promotions.** A `CUSTOMER_GROUP` discount can take the segment `{ kind: "MANUAL_GROUP",
  groupId }` (column `promotions.segment_group_id`, migration
  `20261116060001_promotions_manual_group_segment`; a CHECK ties the id to that segment). The quote
  asks `CustomersReadFacade.isGroupMember` as the system actor, once per group; a refusal, an error,
  an unknown or archived group is "not a member" (fail closed). The group id is not checked at
  create (an admin context cannot call the `system` read); an unknown id simply never applies.
- **Notes.** `customers.customer_notes`: free text about a person, sealed under the customer
  account's subject key before the unit (`fieldLabel('customers.customer-note.body')`), opened
  after the read, never logged. Audited as `customers.customer-note.added` (note id and length).
  Write key `customers.customer-notes.write`; read with the view key (`GET` keyset pages of at most
  100, newest first). A destroyed key (erased account) shows a note without its text. Notes are
  never edited or deleted by an admin.
- **Activity timeline.** `customers.customer_timeline`: one row per event or admin action, with a
  kind code, the instant, an order, refund, group or note reference, the admin who did it, and the
  source event id (unique per customer, so an event is written once). From events: signed up,
  email verified, name changed, disabled, enabled, order paid, refund succeeded (subscriptions
  `customers.timeline-*`). From admin actions: every customer page open (with the tab), note added,
  group added or removed, renamed by an admin. A page open is written once per admin, tab and
  UTC day, so the table does not grow with every click. An event about an account that has no
  directory row yet is refused with `customers.unavailable` and retried, so it is never lost;
  a bulk write checks the directory in slices of 1,000. `POST customers/admin/customers/:accountId/activity`
  is a super list scoped to one customer (filter by category or kinds and by day range, sort by
  time, both paging modes); each read writes the page-open audit row (tab `activity`).
  `.../activity/export` (CSV or XLSX, at most 10,000) needs the export key and a fresh two-step
  proof, and is audited (`customers.customer-timeline.exported`).
- **Name edit.** `PUT customers/admin/customers/:accountId/display-name` (key
  `customers.customers.edit`): identity owns the write (`IdentityFacade.renameCustomerForAdmin`,
  audit `identity.account.renamed-by-admin`, the usual name-changed event). Status changes stay on
  identity's audited routes (`POST identity/admin/customers/:accountId/disable|enable`, key
  `identity.customer-account.disable`). Deletion stays on the package 5c path.
- **Erasure.** The account's erasure and the sweep call `removeAllOf`, which deletes the directory
  row; foreign keys with ON DELETE CASCADE remove the customer's timeline rows, notes and group
  memberships with it.
- **Not in this PR.** The admin email change (identity's pending-email flow with step-up, a mail
  to the new address and a warning to the old) is a PR of its own (security review). Per-module
  reads of the customer page tabs are PR 2b.
- **Known gaps.** Reviews and consent events carry no account id, so they are not on the timeline
  yet. Status-change entries from identity's events have no admin attached. A rename by an admin writes
  two entries (`renamed-by-admin` with the admin, and `name-changed` from identity's event, which
  carries no actor). The notes read writes
  no audit row of its own (the page open does). No role is seeded with the new keys; the owner
  assigns them.

## Customers management: admin changes a customer's sign-in email (16 Nov 2026, API only)

Design note of 16 Nov 2026 with Mohammad's and Hassan's reviews (R1 to R12). The storefront
confirm page and the admin screen are not part of this change.

- **Routes.** `PUT customers/admin/customers/:accountId/email` (body `email` only) and
  `DELETE customers/admin/customers/:accountId/email-change`: admin sessions, CSRF, `no-store`,
  keys `customers.customers.view` and the new **protected** `customers.customer-email.change`
  (held by the Platform Administrator only), and a fresh step-up proof of that key, spent by
  identity inside its own unit. Anonymous `POST identity/customer/email-change/confirm`
  (`token`, `password`; `no-store`, `Referrer-Policy: no-referrer`).
- **Who owns what.** customers checks its own side first (no pending deletion request:
  `customers.account-deletion-pending`) and maps identity's codes. identity owns the account,
  the pending address (`identity.accounts.pending_email*`), the `confirm-email-change` link, the
  step-up spend, the mail counters (`mail.account` for the customer and for the admin, plus
  `mail.origin`), the audit rows and the events. customers reaches identity through a late-bound
  `EMAIL_CHANGE_PEER` bound by `CustomersAccountDeletionModule`.
- **Flow.** The request keeps the current address; the link goes to the new address (SendLinkMail
  picks the recipient per purpose) and a warning with the new address masked goes to the current
  one. A newer request replaces an older one and voids its link; the current address again answers
  `changed: false` and spends nothing. The confirmation needs the link and the account's password
  and runs through the sign-in sequence (throttles, failure counter): the link must belong to the
  pending request (bound by its request instant); the address is swapped and verified, every
  session is revoked (`email-changed`), no session is opened, the account's other live links are
  cancelled, and a notice goes to the previous address. The notice is one row per confirmed
  change in `identity.email_change_notices` (key: Market, account, the account version of the
  swap; both addresses sealed under the account's key; cascade with the account); the mail
  handler sends exactly its event's notice, masks that change's new address, and deletes only
  that row. Every refusal of the link is `link.rejected`; a clash on the unique email key rolls
  the unit back and also answers `link.rejected`.
- **Lapse.** A pending address lapses at `requestedAt` plus the Market's `confirm-email-change`
  link lifetime (AU 1440 minutes). Confirm and SendLinkMail use that one boundary: a link mail
  that is delivered late is skipped once the address has lapsed (`account.pending-email-lapsed`),
  and a link issued late may outlive the lapse but its confirmation answers `link.rejected`.
  The customer page stops showing the address then; `identity.purge-expired` clears it (index
  `accounts_market_id_pending_email_requested_at_idx`, partial, built concurrently).
- **Deletion.** A deletion request (by the customer or an admin) cancels the pending change:
  customers' subscribers `customers.email-change-on-deletion` and
  `customers.email-change-on-admin-deletion` read the request's account and call identity's
  `cancelCustomerEmailChangeForDeletion` (system actor from the dispatcher; repeat-safe; the
  link is voided without a mail; logged by id; no audit row, the deletion request is audited).
  The request itself still refuses a change while a deletion is pending.
- **Customer page.** The overview carries `pendingEmailChange` (`email`, `requestedAt`) or null,
  read from identity at read time (`identity.customer-pending-email-of`, key
  `customers.customers.view`). The read model takes the new address from
  `identity.account-email-changed.v1`.
- **Known gaps.** (1) The deletion cancel is asynchronous: between the deletion request's commit
  and the dispatch of its event, a confirmation can still swap the address. (2) No timeline
  entries yet: the customer timeline (phase 2, PR 2a) merged while this change was open; the
  subscriber and the three entry kinds follow in a PR of their own.

## Phase 2b: per-module admin reads (PR 2b, partial)

Stacked on PR 2a (#929). What landed, by handoff item:

- **Day filters in the right zone (i).** Two kinds of date filter, on purpose:
  - The Customers list (joined and last-order days) and the activity timeline (from and to) take
    `YYYY-MM-DD` days, resolved on the server in the admin's own zone (identity's account
    setting), falling back to the Market's zone (`AdminDayZone`, ADR-0005). A zone that is
    missing, empty, refused, failing or not a valid IANA id falls back to the Market's zone (never
    a 500). A day whose midnight a DST change skips starts at its first real instant.
  - The refunds, payments and disputes lists (owned by ordering and payments) take ISO instants,
    as the admin Orders list does: the panel converts the admin's days.
  The page-open dedup stays "once per UTC day".
- **Tombstone (h).** `GET customers/admin/customers/:accountId` answers
  `{ accountId, status: 'deleted', deletedAt }` for an account whose erasure completed here
  (partial index `account_deletion_requests_completed_idx`); the open is audited, no timeline row.
- **Order number search (a).** `orderNumber` on `POST customers/admin/list` (the order id: orders
  have no separate number) resolves the account through ordering's `adminOrderAccountOf`, which
  needs `ordering.order.view`; an unknown order lists nobody.
- **Refunds (b).** `POST ordering/admin/customers/:accountId/refunds` (+ `/export`): a super list
  (state, reason, requested between instants; sort requested or amount; both paging modes).
- **Payments and disputes (c, d, f).** `POST payments/admin/customers/:accountId/payments` and
  `.../disputes` (+ `/export`), new key `payments.customer-payment.view` (not seeded to Viewer:
  financial data). Payments reads the orders through ordering's facade; the answer's `paid` (the
  gross captured amount: the captured orders' totals per currency, refunds not taken off; refunds
  are shown in the refunds list) replaces the stats estimate for Money "Paid". No provider
  id but Stripe's payment id; disputes show no provider id, evidence or buyer text. A customer with
  more than 10,000 orders gets `batch.too-large` on disputes.
- **Customers view key on every tab.** The refunds, payments and disputes reads and their exports
  also need `customers.customers.view`, as every other tab of the customer page does (ordering
  and payments cast the literal; `test/contracts/admin-facade-permission.contract.spec.ts` pins
  it). An admin with only `ordering.order.view` or `payments.customer-payment.view` gets 403.
- **Exports.** Every owning-module export needs its view keys plus the protected
  `customers.customers.export` and spends the customers export step-up in its unit; each writes
  its own audit row (`ordering.customer-refunds.exported`, `payments.customer-payments.exported`,
  `payments.customer-disputes.exported`).
- **Addresses.** `GET customers/admin/customers/:accountId/addresses` shows suburb and country
  only. `POST .../addresses/:addressId/reveal` needs the protected
  `customers.customer-address.reveal`; one unit writes the audit row
  `customers.customer-address.revealed` (the address id) and the timeline entry
  `address-revealed` before the content is answered.
- **Archive warning (j).** Archiving a group asks promotions, through `CustomerGroupUsageRegistry`
  (owned by customers, registered by promotions at start, so customers never imports
  promotions), how many live, waiting or paused promotions name it. Advisory: the answer's
  `liveSegmentUse` and the audit row say `some`, `none` or `unknown`.

Delivered elsewhere:

- **Pending deletion request on GET customer (g).** Delivered by PR #925 (frontend thread), not by
  this PR.

Not built in 2b (remaining):

- **Promotion usages per customer (e).** No data: `promotion_usage` keeps per-promotion counters
  and orders record no promotion. Needs a usage table written at checkout first.
- **Reviews and consent on the timeline (k).** reviews' events carry no account id (by design:
  a seller must not tie a review to a buyer from the event), legal publishes no events. Needs an
  event change in those modules, or a facade read instead of a timeline copy.
- **Identity section; cart, notifications, legal, engagement and assistant reads.** Built in
  part 2 (below). Reviews remain.

## Phase 2b, part 2: the sections other modules own (16 Nov 2026)

One facade read per owner, behind the owner's own key, checked again in the owner (a platform
admin, not seller-scoped, not acting as anyone). customers composes them lazily, one route per
section under `customers/admin/customers/:accountId/...`; every route also needs
`customers.customers.view` (pinned in `test/contracts/admin-facade-permission.contract.spec.ts`).
The owners are bound at start by `CustomersSectionsModule` (a binding module, because cart,
notifications and assistant reach ordering, which imports customers); until then every section
answers 503 `access.unavailable`. customers declares the owners' answer shapes itself
(`ports/customer-section-peers.ts`) rather than importing them, for the same cycle reason.

Every list here is a super list (`customer-section-lists.ts`): POST with `filters`, `sort`,
`direction`, both paging modes; its export (CSV or XLSX, at most 10,000 rows) needs the
protected `customers.customers.export` and a fresh step-up, spent in the unit that writes
`customers.customer-section.exported` (section, format, count).

The date filters of `sign-ins` and `cart-additions` (`filters.from`, `filters.to`) take ISO 8601
instants with an offset or `Z` (`platform/list-query/instant-range.ts`), not days: the panel turns
the days the admin picked into instants in the admin's zone, or the Market's (ADR-0005). `from` is
inclusive, `to` exclusive; a bare day, junk, or `to` at or before `from` answers 400
`validation.failed`. (The timeline's filter, from part 1, still takes local days.)

- **Security (identity).** `POST sign-ins` (+ `/export`): the last 90 days; time, result
  (success, failure, credential-change), identity's outcome code and the coarse device. No
  address and no city: `city` is always null (seam for a geo lookup the owner has not decided).
  The device is recorded on sign-in records from this release (`sign_in_records.device`), so
  older records show null. `POST sign-ins/:signInId/reveal` needs the protected
  `identity.customer-sign-in.reveal`; identity reads the address and writes
  `identity.account.sign-in-address-revealed` in one unit, and customers answers the address only
  after the timeline entry `sign-in-address-revealed` is written. `GET sessions` (at most 50 and
  `more`), `POST sessions/end` (`identity.customer-session.end`; shares
  AdminEndCustomerSessions' core; audited, timeline `signed-out-by-admin`) and
  `POST password-reset` (`identity.customer-password-reset.send`: the customer's own reset mail,
  the admin sees no link; audited, timeline `password-reset-sent`; 409 for a disabled or
  unverified account, 429 within five minutes of the last request). No step-up on the two
  actions, as for disabling an account. The timeline entry of an action is a second unit after
  identity's: if it fails the action stands and a warning is logged (ids only).
- **Cart (cart.customer-cart.view).** `GET cart` (lines by ids, quantity, the price when added as
  `{ amount: string, currency }`, `savedCount`) and `POST saved-items` (+ export). Saved items
  are paged in cart's memory: an account holds at most `MAX_SAVED_ITEMS` (100) and the read
  loads at most `SAVED_READ_CAP` (twice that, pinned by a test).
- **Reminders sent (notifications.customer-cart-reminder.view).** `POST cart-reminders`
  (+ export): `sentAt`, stage, the cart change; kept 30 days. `sentAt` is
  `cart_reminders.taken_at`, when notifications claimed the stage for sending, not proof of
  delivery: the claim stays when the send then fails or is skipped (no consent, no address,
  unsubscribe or contact not configured), and the stage is not retried. The export column is
  "Taken for sending at".
- **Behaviour (engagement.customer-behaviour.view).** `GET behaviour`: the personalization
  switch, counts by kind and the ten most viewed categories over the 12 months kept; never the
  search text. `POST cart-additions` (+ export, date range): the add-to-cart history. A DB CHECK
  (`behaviour_events_shape_check`) gives every addition its offer and variant, so the page and
  its total count the same rows.
- **Consent (legal.customer-consent.view).** `GET consent` (each channel; not granted until the
  customer agreed) and `POST consent-history` (+ export, channel filter) with the source. Read
  only.
- **Assistant (assistant.customer-conversation.view).** `POST assistant-conversations`
  (+ export): started and last-message dates, `conversationCount` beside every page. Never a
  message, card or turn count; nothing reaches a model. New index
  `conversations(market_id, account_id, started_at DESC)`.

None of the new view keys is seeded to Viewer (one customer's data).

Not built in part 2 (remaining):

- **Reviews** (the customer's reviews with status and moderation actions, the seller ratings
  they gave, helpful votes, reports by and about them). Larger than expected: four super lists,
  and `reviews.reports.reporter_account_id` needs an index first. To be a reviews facade read
  keyed by account, admin key only, that never lets a seller tie a review to a buyer.
- **Sent emails.** notifications keeps no per-account log of sent emails, so there is nothing
  to show; not built (in-app notices go to sellers and admins only).
- **Promotion usages (e)** remain as above.


## Phase 2b, part 3 (reviews) (16 Nov 2026)

The last sections of the customer page and the review events on the timeline (handoff item k).

- **reviews' facade read by account.** `CustomerReviewsFacade` (`CUSTOMER_REVIEWS_FACADE`), four
  reads behind the new plain platform key `reviews.customer-review.view` (not a seller key, not
  seeded to Viewer), checked again in reviews for a platform admin who is not seller-scoped and not
  acting as anyone. Read only and text-free: never a review's title or body, never a reporter's
  account, never the author of a review the customer voted for. They answer whether reviews are on
  or off in the Market (they are the history). Their own small dependency set
  (`CustomerReviewsReader`, `PrismaCustomerReviewsReader`), not the big review repository.
- **Four super lists, each with `/export`.** Under `customers/admin/customers/:accountId/`:
  `POST reviews` (filter `status`; each row: ids, rating, anonymous, status, created/edited/published,
  helpful votes, open reports and the latest moderation line: action, reason code, whether a
  moderator did it, when; no moderation action here), `POST seller-ratings` (filter `status`),
  `POST helpful-votes` (no filters) and `POST review-reports` (filter `role`: `by` the customer
  made it, `about` it reports one of their reviews; a NULL reporter counts as someone else). Each
  needs `customers.customers.view` and `reviews.customer-review.view`; each export also the
  protected `customers.customers.export` with its step-up, audited as
  `customers.customer-section.exported` (the sections `reviews`, `seller-ratings`,
  `helpful-votes`, `review-reports` are back in `CUSTOMER_SECTIONS` and the catalogue snapshot).
  customers mirrors reviews' status lists (it cannot import reviews: reviews reaches ordering,
  which imports customers); the admin-facade-permission contract pins them.
- **Index.** `20261117050300_reviews_reports_reporter_idx`:
  `review_reports(market_id, reporter_account_id, created_at DESC)`, plain `CREATE INDEX` with
  `lock_timeout` (no deployed environment; not partial, so not in the partial-index list; no grant,
  so no change to the expected privileges), reversible. The reports about a customer's reviews and
  the other three lists use existing indexes (`product_reviews`, `seller_ratings` and
  `helpful_votes` by (market, account, created); the reports' (market, review, reporter) key).
  The reports `about` the customer take two queries in the same read-only unit: the account's
  review ids in the Market, then `review_id IN (...)` (Mojtaba, B1: a relation filter inside the
  `OR` planned a hashed SubPlan with no `market_id`, a scan of every Market's reviews). Page and
  count use the same filter.
- **Reviews on the timeline.** New kinds `review-published`, `review-held`, `review-hidden`,
  `review-restored` in the new category `reviews`. Subscriptions `customers.timeline-review-*` on
  reviews' four events, registered by `CustomersSectionsModule` (it imports reviews). reviews'
  events still carry no account: `RecordCustomerTimeline` asks `reviewAuthorOf` (new use case
  `reviews.review-author-of`, rule `system`, so no person and no seller reaches it), then writes
  once per delivery (`runOnce`, the customers inbox) and once per event. A review that is gone or
  whose author was deleted writes nothing; reviews unavailable is refused and retried. No reference
  on the entry (the timeline CHECK allows order, refund, group and note only).
- **Review kinds need the reviews key (Hassan, L1).** The timeline read, its export and so the
  Overview's last five show `review-published`, `review-held`, `review-hidden` and
  `review-restored` only to a caller who also holds `reviews.customer-review.view`, asked through
  the probe use case `customers.customer-review-events-check` (the gate decides). Without the key
  the kinds leave the query itself (not the page afterwards), so the page and its total agree; a
  filter on the `reviews` category or on review kinds only answers an empty list, not an error. A
  probe the gate cannot answer is `access.unavailable`.
- **Author removals.** reviews publishes no event when an author deletes their own review (there
  is no removal event; `ReviewHidden` follows only a moderator's hide or remove of a published
  review), so an author's removal does not appear on the timeline: the earlier `review-published`
  entry stays and nothing follows it.
- **Tests.** Unit on both Market fixtures (reviews' reads and refusals; the four sections through
  the shared section spec; the timeline from review events and subscriptions), HTTP
  (`customers-reviews-admin.e2e.spec.ts`: also a seller session, answered 403, and an acting-as
  session, answered 401 `session.invalid` as on every admin route, on all eight routes; both view
  keys without the export key refused on every export), PostgreSQL
  (`reviews-customer-reads.db-spec.ts`, including both roles on both Markets).

Not built in part 3:

- **Consent on the timeline.** legal publishes no event (it has no outbox, and its flow says no
  consent value reaches an event). Needs a decision: a legal outbox and an event such as
  `legal.marketing-consent-changed.v1` (account and channel, no value), which customers would copy
  as `consent-changed`. The consent history section (part 2) shows every change meanwhile.
- `review-published` also follows an edit that passed the checks and a release from a hold, as
  reviews' event does; the timeline cannot tell a first submission from those.

## Per-admin limits on customer PII actions and the bulk-reveal alert (16 Nov 2026)

Follow-up of Hassan's review of #969 (findings L2, L3, I3).

- **Limits.** Per admin account and fixed one-hour window, from the Market's
  `customers.adminActionLimits` (AU / ZZ fixture): `passwordResetsPerHour` 20 / 5 for "send
  password reset", and `piiRevealsPerHour` 60 / 10 for the reveals of a customer's personal data,
  the sign-in address (`sign-ins/:signInId/reveal`) and the delivery address
  (`addresses/:addressId/reveal`) sharing one count. Past it the route answers 429
  `request.throttled` with `details.retryAfterSeconds` and `Retry-After` (the seconds left in the
  window). "Sign out everywhere" and the reads are not limited. A Market without the section, or a
  counter that cannot be read, refuses with `access.unavailable` (503).
- **Counters.** The platform's shared per-subject counters (`SubjectRateLimits`), new classes
  `admin-customer-password-reset` and `admin-customer-pii-reveal` (3600-second windows), subject
  `<market>:<admin account id>` stored as its keyed hash. Migration
  `20261117050400_platform_rate_limit_admin_customer_classes` widens
  `platform.rate_limit_counters_key_check` (no grant or index change), reversible.
- **What counts.** Counted in the application layer after the gate allowed the call and the body
  is closed, before the customer is looked up: a refused key, an acting-as session or a stray body
  does not count; an unknown customer, sign-in or address does (no free probing). A refused
  (throttled) attempt counts too: the windows are fixed, so trying on does not move the window's
  end, and the count stays one atomic statement.
- **Bulk-reveal alert.** From `piiRevealAlertAt` on (AU 40 / ZZ 6, at most the reveal limit),
  every admitted reveal records the security event `customers.pii-reveal.bulk` (s2, target the
  admin's account, payload `{ reveals }` only): at most `piiRevealsPerHour - piiRevealAlertAt + 1`
  events per admin and window (AU 21). A reveal whose event cannot be recorded is refused
  (`access.unavailable`, logged at error level), so one failed write never loses the alert and
  every reveal past the alert count fails closed while it is unrecorded (Hassan L1 on #974; an
  earlier version recorded only at the exact count, and a failure there lost the alert). The
  security events have no dedupe key, so the dedupe is the security centre's: the rule
  `admin-bulk-pii-reveal` (threshold 1, one-hour window, grouped by the event's target account)
  keeps one live alert per admin and raises its event count with each later event. No migration.
- **Fixed-window bursts (Hassan I2).** The windows are fixed, not sliding: an admin can use the
  whole limit at the end of one window and again at the start of the next, so up to about twice
  the limit (AU 120 reveals or 40 password resets) can pass within a few minutes around a window
  boundary. The alert counts per window too: such a burst reaches the alert count in each window,
  and if the first alert has been resolved meanwhile a second one opens (one live alert per admin
  otherwise). The windows start at the admin's first counted attempt, not on the clock hour.
- **I3.** The platform-admin check of the admin reads (authenticated admin, no seller, no
  acting-as marker) is one helper, `isPlatformAdminActor` in `platform/authz`, used by identity's
  customer security, cart, engagement, legal, reviews, notifications (support contact) and
  assistant (settings). In the last two it replaces a population-only check; today no admin actor
  has a seller or an acting-as marker, so no answer changes.
- **Tests.** `admin-action-limits.spec.ts` (both Markets: limit then 429, another admin
  unaffected, the window resets, the shared count, the event from the alert count on, a failed
  event at the alert count recorded by the next reveal, only allowed calls counted, fail closed),
  the evaluator keeping one alert per admin (`security-use-cases.spec.ts`), HTTP 429 mapping of the
  sign-in reveal and the password reset in `customers-sections-admin.e2e.spec.ts` and of the
  address reveal in `customers-management-admin.e2e.spec.ts`, both Markets, the CHECK in
  `rate-limit-counters.db-spec.ts`.

## Phase 2b, part 4: consent on the timeline; promotion usages not built (16 Nov 2026)

- **Consent on the timeline (rest of item k).** legal publishes `legal.marketing-consent-changed.v1`
  from its new outbox (migration `20261117050700_legal_outbox`; docs/modules/legal/notes.md): the
  account and the channel, never the value or the source. Subscription
  `customers.timeline-consent-changed`, registered by `CustomersSectionsModule` (which already
  imports legal), hands it to `RecordCustomerTimeline` (rule `system`; `runOnce` and the customers
  inbox; once per event by the source event id). New kind `consent-changed` in the `account`
  category, the channel as the entry's `detail` (a code; anything else is `validation.failed`), no
  reference, no actor. An account without a directory row yet is refused and retried as for the
  other account events; an erased account gets nothing. No customers migration: the kind and
  detail CHECKs are code alphabets.
- **Consent entries need legal's key (decision).** The task suggested `customers.customers.view`
  might be enough, since an entry carries no value. It is not: only real changes are recorded and
  the default is "not granted", so the number of `consent-changed` entries tells whether the
  customer consents now, which is what `legal.customer-consent.view` guards on the consent
  section. So the timeline read, its export and the Overview's last five show `consent-changed`
  only to a caller who also holds `legal.customer-consent.view`, through the probe use case
  `customers.customer-consent-events-check` (the gate decides), exactly as the review kinds need
  `reviews.customer-review.view`: without the key the kind leaves the query (page and total agree),
  a filter on it alone is an empty list, a probe the gate cannot answer is `access.unavailable`.
  The two probes are independent (the review key does not open the consent kind). Pinned in
  `test/contracts/admin-facade-permission.contract.spec.ts`.
- **No new permission key, audit action or security event.** The registry, the Viewer exclusion
  list, the role seed and the audit snapshot are unchanged; the event catalogue snapshot and the
  subscriber list gain the new type and subscriber. The probe has a permission rule, so it is not
  in `access-declarations.json`.
- **Promotion usages per customer (item e): not built, blocked.** There is still no per-account
  redemption data: checkout never calls promotions (ordering has no promotion or discount on an
  order), `promotion_usage` holds per-promotion counters that nothing writes yet, and
  `promotion_batch_codes.used_at` is never set (promotions package T2, "marking a code used on
  redemption", is open). A read and route over an empty or invented table would show nothing true.
  Needs, first: promotions package T2 (apply the quote at checkout, a redemption row per order and
  promotion with the account, the discount as Money, the time and a status, released or reversed
  on cancel or refund), designed with Mohammad and Mojtaba. Then this read is a promotions facade
  read keyed by account behind its own key, as planned.
- **Tests.** Unit on both Market fixtures: legal writes one event per real change, none for a
  no-op or a failed write, never a value (`legal-use-cases.spec.ts`); the subscription records once
  per event with the channel, skips an erased account, retries a missing directory row, refuses a
  bad channel (`customer-timeline-events.spec.ts`); the gate on the read and the export
  (`customer-management.spec.ts`). PostgreSQL: the event row in `legal.outbox` with the change and
  rolled back with a serialization loser (`legal-marketing-consent.db-spec.ts`), the timeline row
  (`customers-management.db-spec.ts`), privileges and the partial-index list.

- **Identity section** (logins over 90 days as a super list, sessions, sign out everywhere,
  send a password reset): the largest piece, an auth path (security review). `sign_in_records`
  holds the full IP and no geo data, so a "rough city" needs a geo lookup first.
- **cart, reviews, notifications, legal/engagement/assistant reads.** Each needs a new facade
  read and key in its owner. notifications keeps no per-account log of sent emails today (in-app
  notices are addressed to sellers or admins, not to customers); the abandoned-cart reminders it
  took are in `notifications.cart_reminders`, kept 30 days.

## Phase 3: per-seller customers and store follows (2026-11-16)

- **Store follows live in `engagement`** (`engagement.store_follows`, one row per account and store,
  at most 1000 per account). `PUT/DELETE/GET customers/me/followed-stores/:sellerId` and
  `GET customers/me/followed-stores` (My stores, newest first, cursor `<epochMs>.<id>`). Only a
  published store can be followed (`sellers.publishedStoreSlugs`). Each change writes
  `engagement.store-followed.v1` or `store-unfollowed.v1` (account and seller ids only) to the new
  `engagement.outbox`. Erasure removes the follows with no event.
- **`customers.seller_customers`** is one row per (seller, customer) while there is a relation:
  an order with the seller (count, first and last order, spent net of refunds) or a follow. The
  `exclusive` flag is reserved for phase 4. The customer code (`XXXX-XXXX`, Crockford base32, 40
  random bits) is drawn when the row is created, is unique per seller (a code taken at the seller is
  drawn again) and is kept while the row exists; a seller whose relation ends loses the row and the
  code. The foreign key to `customer_directory` cascades, so erasure leaves nothing.
- **Sync.** `customers.sync-seller-customers` from `ordering.order-paid.v1`, `refund-succeeded.v1`
  and the two follow events re-reads `ordering.customerSellerStats` and
  `engagement.followsOfAccount` (both `system`) and replaces the customer's rows, once per delivery.
  `customers.reconcile-seller-customers` (daily, and at worker start) syncs every customer of the
  directory again. Two syncs of one account racing on stale reads is accepted: the next event or
  the nightly run converges (as B1).
- **What a seller sees.** `customers/seller/customers` (`list`, `list/codes`, `export`, `:code`):
  the code, the first name (first word of the display name) and the numbers with that seller only.
  Never an account id, an email, a full name or anything done at another shop. Keys
  `customers.seller-customers.view` and `.export` (seller scope, unprotected; no default seller role
  lists them, so the Seller Owner grants them). A Login as Seller session is refused. The customer
  page reads the seller's own paid seller orders through `ordering.sellerCustomerOrders`, which
  checks `ordering.seller-order.view` itself (`orders: null` without it). The export is audited
  (`customers.seller-customers.exported`: format, count, how picked).
- **Admin.** The seller page's Customers tab: `customers/admin/sellers/:sellerId/customers/summary`
  (tab counts and 12 months of new buyers and new followers) and `.../list` (rows with the account
  id), under `customers.customers.view`. The admin Customers list has the filter `followsSellerId`.
- **Promotions.** `STORE_FOLLOWER` now reads `engagement.followedAmong` (system for the quote, own
  for the customer; anything else is unknown, so the offer is not made). The Follow gift is
  `GET promotions/stores/:sellerId/follow-gift` (anonymous): the seller's live store-follower
  promotions without a code and not in test mode.
- **Known gaps.** (1) The SEL-15 store setting "let the seller see its customers" does not exist in
  code; access is by key only. (2) The trend is cut in the Market's zone: a seller has no zone of its
  own yet (ADR-0005 fallback). (3) The `lastOrderFrom/To` filter days are UTC days. (4) Seller saved filters wait for the shared list kit's generic endpoints (B0-1b). (5) The
  reconcile syncs at most 40,000 customers per run; a larger Market relies on the events. The run
  answers `failed` and `capped`, goes on past an account whose sync fails, and the job logs a warning
  when either is set.
- **Accepted from the reviews (2026-11-16).** (1) Two syncs of one account can interleave on stale
  peer reads (an order event and a follow event at once); the older read can land last and stays
  until the next event or the nightly reconcile (at most a day). No lock is taken for it.
  (2) The Follow gift does not check that the store is published: the live follower offers of a
  hidden store can be read by its seller id, but nothing about a customer is in it and nothing can be
  bought there. (3) A seller's order page still shows the recipient's name and address while an
  order is fulfilled (the existing fulfilment design); "code and first name only" applies to the
  Customers list, its export and the customer page. (4) Spent adds up seller order totals across
  orders and takes the latest order's currency, which holds while a Market has one currency.
- **Database.** The sort indexes on `last_order_at` and `followed_at` are `DESC NULLS LAST`, as the
  list sorts them; a CHECK ties `currency` to `order_count > 0`.

## Phase 4a, PR 4a-1: sellers' invite links and the exclusive customer (2026-11-17)

Plan sections 6, 7 and 7b (customers-management-plan-fa.html). API only; the seller panel's link
card, the storefront's invite banner and the admin list's screens follow in the frontend phase.

- **Tables** (`customers` schema): `seller_invite_links` (one live link per seller by a partial
  unique index; a token of 26 Crockford symbols unique in the Market; a refresh revokes the old
  link, whose customers stay attributed) and `seller_attributions` (one per account, foreign key to
  the directory with cascade, so erasure removes it; status `active` or `rejected` with a reason
  `seller-team` or `admin`; `flags` holds `link-burst`; a decision is a conditional update on
  `version`). No raw SQL: concurrency rests on the unique indexes and the versioned update.
- **Where the link lives**: in `customers`, not `sellers`, so the link and the attribution share
  one module and one unit. Permission `customers.seller-invite-link.manage` (seller scope) for the
  link; `customers.seller-attributions.manage` (platform, protected) for an admin decision.
- **The claim**: the storefront resolves a token anonymously to the store's address only
  (`GET customers/store-invitations/:token`). After sign-up and email verification the signed-in
  customer claims it (`POST customers/me/store-invitation`). New sign-ups only: signed up within
  the Market's `customers.invitations.signUpWindowDays`, no order, no attribution yet. Then the
  store is followed for the customer (best effort, after the commit) and
  `customers.seller-attribution-changed.v1` marks the customer `exclusive` in the seller's
  customers read model (new view `referred`, filter `exclusive`).
- **Burst count, review fixes**: the count is per seller (any of its links), so a refresh does not
  reset it; the claim locks the live link's row first (a no-op update, no raw SQL), so concurrent
  claims through it run one after another and the count is exact. The suspicious view's partial
  index is written as Prisma writes the filter (`flags <> '{}'`), and a db-spec checks the plan.
- **Abuse checks**: a customer whose sign-in address is on the seller's team (identity's
  `ownAccountTiedToSeller`) is recorded as rejected (`seller-team`) and refused; an admin cannot
  restore it. More attributions through one link in 24 hours than `burstPerDay` flag the new one
  `link-burst`. Household and payment-method matches are not built: the platform has no such
  signal (promotions' referral signals answer "unknown" too). The admin's manual reject or
  restore covers the rest.
- **Admin list** (`customers/admin/seller-attributions`): a super list (views suspicious, all,
  active, rejected; email prefix search; filters seller, status, reject reason, flag, day range;
  both paging modes; select all matching up to 10,000; saved filters under
  `admin.customers.seller-attributions`; CSV/XLSX export behind the Customers export step-up,
  audited without personal data). Rows show the seller id, not the store name.
- **Market settings**: `customers.invitations` (AU: 7 days, 50 a day; ZZ: 3 days, 2 a day). A
  Market without it has the feature off.
- **For 4b**: `exclusiveSellerOf` (the seller of an active attribution recorded at or before an
  instant) is ready for checkout's order-line freeze; the facade method comes with 4b.
- PR 4a-2: use case `customers.read-exclusive-seller` (rule `system`) and the read facade method
  `exclusiveSellerOf(context, accountId, at)` for promotions' exclusive-customer discount (and
  for 4b's checkout freeze). Ids and the instant only.

## Phase 4b: the lower commission for an exclusive customer (2026-11-17)

- Use case `customers.read-own-exclusive-seller` (rule `own-resources`, customer only, Login-as
  refused) behind the checkout facade method `ownExclusiveSeller(context)`: the signed-in
  customer's exclusive seller now (an active attribution), or null.
- Checkout (ordering) asks it once per order; any failure or throw means none (standard rate).
  It passes the answer to commission-payouts' `commissionRates`, which lowers the exclusive
  seller's rate while the window is open, and freezes on every line `exclusive_seller` and
  `commission_rate_reason` (`standard` | `exclusive`).
- Market setting `commissionPayouts.exclusiveCustomer` `{ reductionBps, floorBps, months }`
  (AU 5000/300/12: half, floor 3 %, 12 months; ZZ 2500/500/6). It lives with the commission
  settings (commission-payouts owns the rate), not under `customers` as the handoff named it.
  The window runs from the attribution (`since`), in UTC months. A Market without it has no lower
  rate. The lower rate is `max(floor, floor(rate × (1 − reduction)))`, never above the rate in
  force; `exclusive` only when it is lower.
- Migration `20261117080000_ordering_exclusive_seller_commission`: two columns with constant
  defaults (no rewrite) and a CHECK (`exclusive` needs `exclusive_seller` and a frozen rate).

## Seller attributions: day filters in the admin's zone (18 Nov 2026)

- `attributedFrom` and `attributedTo` on the attributions list, `ids` and export are now read in
  the calling admin's own panel zone, else the Market's (`AdminDayZone`, ADR-0005), as the
  customer list's day filters are; they were UTC days. The request body is unchanged: the zone is
  resolved on the server, never taken from the body. Saved filters keep the plain days, so a shared
  filter reads in each viewer's own zone.
- The repository takes a `ZonedAttributionSelector` (the parsed selector plus `dayZone`) and cuts
  the days with `localDayStart`/`localDayEnd`; a day such as 31 February is refused at parse.
