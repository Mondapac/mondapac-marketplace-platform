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
  system actor). Per due request, each step safe to repeat: blockers again under the system actor
  (a blocked request stays pending and is asked again); `identity.eraseCustomerAccount` (subject
  key destroyed, account row, credential, sessions and links deleted, audit
  `identity.account.erased`; `already-erased` on a re-run); `engagement.forgetAccount`; then one
  unit deletes the account's `customers.addresses` rows, closes the request `completed` (only if
  still pending) and writes audit and event. A failing request is logged by class name and left
  pending; the next run repeats it. Orders, tax invoices and payments stay (ids only).
- **Data.** `customers.account_deletion_requests` (ids, status, waiting period, times; no personal
  data; the application role may update only the closing columns and may not delete). Events
  `customers.account-deletion-requested.v1`, `-cancelled.v1`, `-completed.v1` (aggregate = the
  request; no account id). Audit `customers.account-deletion.requested`, `.cancelled`, `.completed`.
- **Facade additions.** identity `endOtherCustomerSessions` (customer, own) and
  `eraseCustomerAccount` (system); wallet `ownBalanceOf` (customer, own); ordering
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
- **No reviews module**: nothing to anonymise yet (owner decisions ح6, ن11 apply when it lands).
- **No returns or disputes module**: only open orders and pending refunds are blockers.
- **Market without wallet settings** fails closed (503) because the wallet cannot answer.

### What packages 5c will do

- **5b, buyer flow.** Built (above).
- **5c, admin manual deletion.** An admin deletes a buyer's account with a ticket reference, a
  reason and an OTP, under a new `buyers.account.delete` permission, with the same blockers and
  the same waiting period.

## Open follow-ups (Hassan, PR #405 review: GO, two low findings)

- Rows under a destroyed account key still count toward the limit and can be promoted to the
  default. Package 5 (account deletion) deletes the account's `customers.addresses` rows with the
  key, which closes this.
- One damaged ciphertext row makes the list answer 500 (`addressFromJson` throws). Later: let
  `open` return a typed failure, skip the row and log only the address id and a code.
