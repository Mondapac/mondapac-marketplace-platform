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
  path and a code only). Writes run serializable (the limit and the one default span rows).

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
- Who sees it: the customer on `GET /orders/:id` and the seller on its own seller order page
  (view, ship, deliver), as `shipTo` (recipient name, phone, address lines, suburb, region,
  postcode, delivery notes, country), never the customer's email or account id. Lists and the
  admin order page carry no address. `shipTo` is null on orders placed before this package and
  once the account was erased.
- Hassan (PR #406 review: GO) follow-ups: (1) a seller can read the address of every paid order
  for ever; later drop `shipTo` from the seller's answer a Market-set time after delivery.
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
- **Data.** Migration `20261028120000_customers_account_deletion_admin`: `requested_by`,
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

## Open follow-ups (Hassan, PR #405 review: GO, two low findings)

- Rows under a destroyed account key still count toward the limit and can be promoted to the
  default. Package 5 (account deletion) deletes the account's `customers.addresses` rows with the
  key, which closes this.
- One damaged ciphertext row makes the list answer 500 (`addressFromJson` throws). Later: let
  `open` return a typed failure, skip the row and log only the address id and a code.
