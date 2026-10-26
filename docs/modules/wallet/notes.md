# wallet: customer wallet, package 1 (ledger core)

Speed mode (CLAUDE.md): no G1/G2 or design document. This note only points to the owner's
decisions and records what the code does. The source of the decisions is the hand-off
`customer-wallet-package1.md` in the Project (outside the repo) and the Persian design
`wallet-design-fa.html` (sections 4, 5, 6). Owner approved the build on 2026-10-25.

## Owner decisions (binding)

- Option A only: store credit issued by the platform. No card top-up, no bank withdrawal, no
  P2P, no Stripe call in this module. A schema test refuses card or bank vocabulary in any column.
- A refund goes to the original source by default; credit is optional (package 4, not now).
- Promo credit expires after 12 months; refund credit never expires. Both are Market config
  (`wallet.promoExpiryMonths`); refund lots have no expiry.
- Promo cost is always borne by the platform (`promo_expense`); the seller's commission and
  ledger are unchanged. Cashback is promo credit (later package).
- Wallet balance cap per customer: 500.00 in the Market currency, from Market config
  `wallet.balanceCapMinor` (AU 50000), never hardcoded. A grant over the cap is refused
  (`wallet.cap-exceeded`); held credit counts toward the cap.
- Admin caps (package 2): 50.00 per issue and 500.00 per admin per day without a second approval
  (`wallet.adminIssueCapMinor`, `wallet.adminDailyCapMinor`; package 2a below).

## The switch is runtime, not config (scope change 2026-10-25)

There is no `wallet.enabled` in `config/markets/*.json`. The state of the wallet in a Market is
the row of `wallet.market_settings` (no row = `off`), set by an admin:

| state                           | grants and new holds | capture           | release and hold expiry | promo expiry job | customer reads    |
| ------------------------------- | -------------------- | ----------------- | ----------------------- | ---------------- | ----------------- |
| `off` (default; never launched) | `wallet.disabled`    | `wallet.disabled` | `wallet.disabled`       | does not run     | `wallet.disabled` |
| `active`                        | allowed              | allowed           | allowed                 | runs             | allowed           |
| `paused` (wind-down)            | `wallet.paused`      | allowed           | allowed                 | runs             | allowed           |
| `frozen` (emergency)            | `wallet.frozen`      | `wallet.frozen`   | allowed                 | runs             | allowed           |

Hard rules, each with tests:

1. No state change deletes or zeroes a balance or a lot. The switch only decides which operations
   may start; no wallet table has a DELETE grant and a trigger refuses DELETE and TRUNCATE.
2. A hold already placed is always settled: release and expiry work in every state but `off`;
   capture works in `active` and `paused`.
3. The worker job `wallet.expire-credit` (holds past `expires_at`, promo lots past `expires_at`)
   runs in every state except `off`.
4. Going back to `off` is refused once any journal exists for the Market
   (`wallet.cannot-turn-off-with-history`, also enforced by a trigger); use `paused`.

Admin endpoints (no UI in this package; the toggle page comes in package 2):

- `GET /wallet/admin/settings` needs `wallet.settings.view`.
- `PUT /wallet/admin/settings` body `{status, reasonCode}`, needs `wallet.settings.manage`
  (protected key) and a fresh admin step-up proof for `wallet.settings.change` (issue #491, see
  below). `reasonCode` is required for `paused` and `frozen` and refused for `off` and
  `active`; it is one of a closed list (`wind-down`, `security-incident`, `fraud-suspected`,
  `legal-hold`, `maintenance`, `owner-decision`) because audit fields hold no free text. The call
  is refused in an acting-as session, writes one audit row with before and after, and is
  idempotent (the same state again writes nothing). Both keys are protected (Platform
  Administrator only), so no default role changes in this package.

Admin step-up (issue #491, closes M3): `wallet.settings.change` is registered as an admin
step-up action (`contracts/step-up.ts`, `audience: 'admin'`, locked). The PUT carries
`@RequiresStepUp('wallet.settings.change')` (a read-only check before the body is read). The
proof is single use (Hassan L1, L2): `setStatus` spends it through the platform port
`STEP_UP_CONSUMER` inside the same unit that saves the switch, right before the save, so one
verified code moves the switch once. No fresh proof left at that moment means the unit commits
nothing. A refused change (bad body, `wallet.cannot-turn-off-with-history`) and a no-op (the
same state) spend no proof. Without a proof the answer is `403 second-factor.required` with
`details.actionKey: "wallet.settings.change"`; an admin without an active second factor gets
`403 second-factor.enrolment-required`. The panel then calls
`POST /identity/admin/step-up/verify {actionKey, code}` and repeats the PUT. The
`wallet.market-status.changed` row names the proof it spent (`stepUpSessionId`,
`stepUpVerifiedAt`; Hassan L3). Credit issuance (package 2) spends its own admin action the same
way.

Remaining gap (to settle before package 2):

- Refunds that would exceed the cap go to the original card (owner decision); the caller handles
  `wallet.cap-exceeded`.

M3 (closed by #491): the admin step-up blocked package 2 (the admin toggle page) and setting any
production Market to `active` or `frozen` through this endpoint. Identity now offers the admin
step-up and `setStatus` calls it before `save`, so package 2 is unblocked on this point.

`down.sql` must never run in production after launch: it drops every wallet table, and with them
every balance, lot and journal. It exists for development and for the reversibility check only.

The switch is a fence at the database. Prisma has no `FOR SHARE` and modules may not use raw SQL,
so the use cases read the status with a plain read for the friendly answer (`wallet.paused`,
`wallet.frozen`, `wallet.disabled`), and a `BEFORE INSERT` trigger on `journals`
(`check_market_status`) reads `market_settings` `FOR SHARE` and refuses a kind the status does not
allow (active: all; paused: capture, release, expire; frozen: release, expire; off or no row:
none). A status change takes the row lock `FOR UPDATE` (a no-change update after a seed
`INSERT ... ON CONFLICT DO NOTHING` of an `off` row, so two first PUTs queue instead of failing),
so it waits for every journal in flight, and a journal in flight waits for it and then reads the
new status. A use case that loses that race gets the trigger's refusal, runs once more, and
answers from the new status. The same lock makes "never back to off with history" race-free.

Books at COMMIT: deferred constraint triggers on `balances`, `lots`, `holds` and `postings` check,
per customer wallet, that available = postings on the wallet account = the lots' remaining credit
and held = the held holds; a hold that leaves `held` needs a capture or release journal for its
order; an expired promo lot is restored only in the transaction that releases a hold that took
from it; a leg has the currency of its account and of its journal; a closed account never
reopens. A direct UPDATE of a balance, lot or hold, by any role, fails the commit.

A hold is born `held` (insert trigger) and its lots are written in the transaction that creates
it. It leaves `held` only with a capture or release journal of that very hold (`journals.hold_id`)
written in the same transaction, and a wallet's legs on the Market's `holds` account must equal its
held holds at commit. The admin status change sets a 3 s lock timeout and answers `wallet.busy`
(409) instead of queueing the Market's wallet writes behind it. Still open: schedule `reconcile()`
nightly with alerting before the facade gets a caller, after its rewrite (see "Database design").

Idempotency keys starting with `sys:` are the worker's; a facade caller may not send them. A
unique violation on `(market_id, idempotency_key)` between two parallel requests is answered
from the first journal (its result, or `idempotency.key-reused`). Facade callers must derive keys
on the server (`<module>:<orderId>:<operation>`) and never pass a client-supplied key unchanged.

Idempotent replay: a retried request with a known key returns its first answer even if the Market
status changed since. `grantCredit`, `placeHold`, `captureHold` and `releaseHold` look the journal
up (under the balance lock) before the switch gate; only new work meets the gate.

Reconciliation: `WalletRepository.reconcile(market)` is read-only and returns the mismatches
(postings = available = lots per wallet, held holds = held, every journal sums to zero, the
`holds` account = all held holds). No endpoint yet; it is the base of the nightly reconciliation.

## Database design (review of PR #490, 2026-10-25)

Access paths. Every trigger query and every repository query filters on `market_id` and reaches
its rows through an index that leads with it (a db test checks the plans after ANALYZE):

| Query | Index |
|---|---|
| journal balanced, leg currency | `postings (market_id, journal_id)` |
| books: postings on the wallet / on the `holds` account | `postings (market_id, wallet_account_id, account_id, amount_minor)`, index-only |
| books: lots | `lots (market_id, wallet_account_id, remaining_minor)`, index-only |
| books: held holds | `holds (market_id, wallet_account_id, amount_minor) WHERE status = 'held'` |
| lot restore checks | `hold_lots (market_id, lot_id)` |
| hold settled by its journal | `journals (market_id, hold_id) WHERE hold_id IS NOT NULL` |
| lot ledger: takes on a lot, expire journals of a lot | `hold_lots (market_id, lot_id)`, `journals (market_id, lot_id) WHERE lot_id IS NOT NULL` |
| expiry sweep: promo lots, held holds | `lots (market_id, expires_at, id) WHERE source = 'promo' AND remaining_minor > 0`, `holds (market_id, expires_at, id) WHERE status = 'held'` |
| history | `journals (market_id, wallet_account_id, created_at DESC, id DESC)` |

- Each leg carries its journal's wallet (`postings.wallet_account_id`, checked equal on insert), so
  the books sum a wallet's own legs on the `holds` account without a join. A leg on a customer
  wallet belongs to that wallet's journal; a leg on the `holds` account needs a wallet.
- "INCLUDE amount" is written as a trailing key column: Prisma cannot express INCLUDE and
  `db:check-reversible` compares the migration with the schema. The scans are index-only either way.
- `balances_market_id_idx` was dropped: the primary key is the wallet and no query reads the
  balances of a whole Market.
- Lots and balances are updated in place on every spend: `fillfactor = 70` and
  `autovacuum_vacuum_scale_factor = 0.02`; holds `fillfactor = 80` (HOT updates).
- Lots, holds and balances reference `accounts (market_id, id, currency)`, and an insert trigger
  requires the account to be a customer wallet (`credit_liability`). Lots and holds expire after
  they are created; a journal names its wallet unless it is a `reverse`, and its hold exactly for
  `hold`, `capture` and `release`.
- `journals.hold_id` and `journals.lot_id` have no foreign key by design: the journal is written
  before its hold, and the unit orders the inserts. The CHECKs (`hold_id` exactly for hold,
  capture and release; `lot_id` exactly for expire) and the commit-time checks keep them
  consistent.
- `reverse` journals have no wallet and cannot post to a customer wallet account today (the
  posting guard refuses it); package 2 defines what a reversal of a wallet journal writes.
- Lot ledger (security re-check N1b): at COMMIT, every lot whose remaining changes, that gains a
  hold lot, whose hold changes status, or that an expire journal names must satisfy
  `original - remaining = held and captured hold_lots + expired by its expire journals`. With
  the books check (lots = available) this ties every movement of credit to the lot a hold or an
  expiry names, so credit cannot move between a wallet's lots (refund credit into an expired
  promo lot, or promo credit spent in place of refund credit). It compares states, so the order
  of the writes does not matter and it does not rely on `xmin`. It also runs for a new lot
  (remaining must equal original). An expire journal must name an expired promo lot of its own
  wallet and post a negative sum to the wallet; a hold lot must name a lot of the hold's wallet
  and currency.
- "Expired" in the database means `expires_at <= now()` (the transaction's start time), the same
  clock as `guard_lot_update`. The sweep decides by the injected Clock; if the application clock
  runs ahead of the database's, an expiry within that skew is refused and retried by the next
  sweep (fails closed). The db tests start their fixed clock in 2020 so that it stays behind the
  database clock.
- The sweeps (`dueLots`, `dueHolds`) are Prisma queries with bound parameters
  (`source = $`, `status = $`, `remaining_minor > $`), so their partial indexes can be used only
  in custom plans. Generic plans for them are unsupported: `plan_cache_mode` must stay `auto` (or
  `force_custom_plan`), and a pooler in transaction mode needs this revisited first. The plan
  test checks them under `force_custom_plan`.
- Savepoints: the "written in this transaction" checks compare `xmin` with the top-level
  transaction id. A row written inside a SAVEPOINT (or a PL/pgSQL EXCEPTION block) carries a
  subtransaction id, so the check refuses it (fails closed). Wallet units must not use savepoints;
  a db test documents the behaviour.
- The books check runs at COMMIT once per touched row (balance, lot, hold, wallet leg), and an
  UPDATE that changes nothing the books read queues no check, so `lockBalance` (a no-change
  update) costs no books work. It stays a Prisma update: modules have no `$queryRaw`, and
  `SELECT ... FOR UPDATE` would have to be a platform named statement. A per-transaction "already
  checked this wallet" marker was not added: any session marker (`set_config`) can be set by the
  same transaction that edits the rows, so it would let a crafted transaction skip the check.

Measured on a throwaway database (PostgreSQL 16, 4 cores, 128 MB shared buffers), seeded with the
row triggers off and then VACUUM ANALYZE: Market AU with 1,000 wallets, 500,000 journals and
1,000,000 postings; Market HV with one wallet of 100,000 journals and 200,000 postings.

| Books query | AU wallet (500 journals) | HV wallet (100,000 journals) |
|---|---|---|
| postings on the wallet | index-only, 500 rows, 0.13 ms | index-only, 100,000 rows, 22 ms |
| postings on the `holds` account | index-only, 250 rows, 0.06 ms | index-only, 50,000 rows, 11 ms |
| lots | index-only, 250 rows, 0.13 ms | index-only, 50,000 rows, 6 ms |
| held holds | index-only, 250 rows, 0.06 ms | index-only, 50,000 rows, 6 ms |
| journal balanced | index scan, 2 rows, 0.07 ms | index scan, 2 rows, 0.07 ms |

All with `Heap Fetches: 0` and no sequential scan. A 3-lot hold (one journal, two legs, a hold,
three hold lots, three lot updates, one balance update; seven books checks at COMMIT), as the
application role: COMMIT 8 to 11 ms warm (247 ms cold) on the AU wallet, and 210 to 241 ms on the
HV wallet. The books cost grows linearly with a wallet's history, about 45 ms per check per
100,000 journals.

Required before the nightly reconciliation job (S6): rewrite `reconcile()` as one set-based SQL
statement per Market (one snapshot, CTEs), with a `LIMIT` on the mismatches returned and the
unbalanced-journal check run in `created_at` chunks; run it on the worker with a
`statement_timeout`. Today it runs six statements with separate snapshots (false drift under
load) and loads every account and journal into Node.

Growth: `journals` and `postings` are append-only. No partitioning at launch; the composite keys
`(market_id, id)` make time-partitioning of `journals` awkward, so the likely path is archiving
the ledgers of closed orders, never deleting them. Revisit when `postings` passes 50M rows, the
commit-time books check passes 50 ms p95, or one wallet passes 20,000 journals (then add a
checked running total so the books stop summing the whole history).

## What exists in package 1

- Schema `wallet`: `accounts`, `journals` (insert-only, unique `(market_id, idempotency_key)`),
  `postings` (insert-only, deferred trigger: legs of a journal sum to zero, at least two), `lots`
  (only `remaining_minor` changes; only decreases, except a released or expired hold restores it),
  `holds` and `hold_lots` (release restores the exact lots), `balances` (CHECK >= 0, locked
  with a no-change update before every change), `market_settings`. Composite, market-scoped
  foreign keys (`ON DELETE RESTRICT`) tie postings, lots, holds, hold lots, balances and
  journals to their parents inside the schema.
- Facade `WALLET_FACADE` for system callers only (no ordering wiring yet): `grantCredit`,
  `placeHold`, `captureHold`, `releaseHold`, `balanceOf`.
- Customer HTTP: `GET /wallet/me` and `GET /wallet/me/history` (own resources; reads are allowed
  in an acting-as session; nothing here can be spent over HTTP).
- Spend order: soonest-expiring lot first, promo before refund at an equal expiry; an expired lot
  is never spent. Money is integer minor units. Time comes from the injected Clock; promo expiry
  is calendar months in the Market's time zone.
- Idempotency: the same key with the same request returns the first result; the same key with
  another request answers `idempotency.key-reused`.

## Package 2a: admin credit issuance with maker-checker

Owner decisions of 2026-10-25 (hand-off `customer-wallet-package2a.md`). Backend only; the admin
pages are package 2b.

- An admin issues promo store credit (`grant-promo` journal, promo lot, Market promo expiry, cost
  `promo_expense`) to a customer with a closed reason code (`goodwill`, `service-recovery`,
  `promotion`, `correction`) and an optional note (1 to 500 characters, no control characters).
  The note is stored for the admins and returned only by the admin routes; it never enters a
  journal, an audit row, an event or a log.
- Within both caps the credit is granted at once: the request row is `granted` and names its
  journal. Above either cap (`approval_reason` `issue-cap` or `daily-cap`) it is `pending`, with
  no ledger effect, until a second admin approves (the grant happens then), rejects (closed
  reason: `not-justified`, `amount-too-high`, `duplicate`, `wrong-customer`, `policy`), or it
  expires after `wallet.adminRequestExpiryDays` calendar days in the Market's zone (AU 7). Exactly
  at a cap is within it.
- The daily cap is per admin per calendar day in the Market's time zone (ADR-0005, injected
  Clock), counting the amounts the admin has `granted`, `pending` and `approved` that day;
  rejected and expired requests free it again. Race-safe: an issue first locks the admin's day
  row (`wallet.admin_credit_days`, created on first use, then a lock-only update), so two issues
  by one admin on one day run one after the other and the second counts the first. The db spec
  runs two parallel issues straddling the cap: one is granted, one waits.
- At approval the wallet state, the customer wallet state and the customer balance cap are
  checked again (the same grant code as the facade). The wallet must be `active` to issue or to
  approve; `paused`, `frozen` and `off` refuse, and a `BEFORE INSERT` trigger on the requests
  table reads the switch `FOR SHARE` like the journals' fence. Rejecting works in any state.
- Maker-checker: the admin who asked can neither approve nor reject
  (`wallet.approver-is-requester`), also enforced by a CHECK (`decided_by <> requested_by`).
- Each write spends a fresh admin step-up proof of its own action through `STEP_UP_CONSUMER`,
  inside the unit, right before the first write (as `setStatus`): `wallet.credit.issue` for an
  issue, `wallet.credit.approve` for approve and reject. Both are admin actions (locked) and are
  guarded on their routes with `@RequiresStepUp`. Refusals before that point spend no proof.
- Permissions (protected, platform scope; no seller or customer can hold them):
  `wallet.credit.view` (list, customer summary), `wallet.credit.issue`, `wallet.credit.approve`.
  Writes and both reads are refused in an acting-as session (review S4).
- Idempotency: the client's `idempotencyKey` is unique per Market on the request row; the same key
  and request (admin, customer, amount, reason, note) answer the first result, another request
  `idempotency.key-reused`. The stored fingerprint is a SHA-256 (hex) of those fields joined, so
  the column never holds the note (review S2); the note itself is limited to 500 characters at
  validation. The ledger key is derived on the server
  (`wallet:admin-credit:<requestId>`), never the client's key.
- Audit rows: `wallet.admin-credit.issued`, `.requested`, `.approved`, `.rejected` (each naming
  the step-up session and its verification time) and `.expired` (system). There is no outbox
  event: the wallet module has no outbox yet, so `wallet.credit-granted` is not emitted.
- Worker job `wallet.expire-admin-credit-requests` (every 5 minutes) expires pending requests
  past `expires_at`, one unit each, under the row lock.

HTTP (admin population, CSRF on writes, `no-store`):

| Route | Key | Step-up |
|---|---|---|
| `POST /wallet/admin/credits` `{customerAccountId, amount, currency, reasonCode, note?, idempotencyKey}` | `wallet.credit.issue` | `wallet.credit.issue` |
| `POST /wallet/admin/credit-requests/:requestId/approve` | `wallet.credit.approve` | `wallet.credit.approve` |
| `POST /wallet/admin/credit-requests/:requestId/reject` `{reasonCode}` | `wallet.credit.approve` | `wallet.credit.approve` |
| `GET /wallet/admin/credit-requests?status=pending\|decided\|granted&cursor&limit` | `wallet.credit.view` | none |
| `GET /wallet/admin/customers/:customerAccountId` | `wallet.credit.view` | none |

Tables: `wallet.admin_credit_requests` (never deleted; insert-only except the decision columns,
once, from `pending`; CHECKs tie each status to its columns; the journal it names must be this
request's promo grant of the same customer and amount, written in the same transaction) and
`wallet.admin_credit_days` (the day lock). Indexes: the daily sum reads
`(market_id, requested_by_account_id, local_day, status, amount_minor)` only; the list
`(market_id, status, requested_at DESC, id DESC)`; the sweep a partial
`(market_id, expires_at, id) WHERE status = 'pending'`.

Customer id (review S1, Hassan C1): issue, approve and the customer summary ask identity's facade
`customerAccountOf(context, id)` (identity use case `identity.customer-account-of`, rule
`own-resources`, platform admin only, never acting-as; ids only, no personal data). It answers
only an active customer account of `context.market`; an unknown id, a seller or admin account,
another Market's account and a closed account are absent alike, and the wallet answers
`wallet.customer-not-found` (404). A refusal or a failed call fails closed (`access.denied` /
`access.unavailable`). Units do not nest, so the check runs just before the write unit:

- Issue: before the unit, so a miss spends no step-up proof, takes no day lock and writes nothing.
- Approve: the request is read first (its customer never changes, a trigger fences it), then the
  customer is checked. A miss leaves the request **pending** and spends nothing; a checker
  rejects it with `wrong-customer`, or it expires. (Chosen over an automatic rejection: a
  decision stays with an admin, and the request may be valid again if the account is reopened.)
- Accepted race: an account closed between the check and the commit of the grant (a few
  milliseconds). The credit then sits on a closed account where nobody can spend it, and the
  audit row names it; an admin can reverse it once the `reverse` journal exists.
- A replay of a known key for a customer closed since answers `wallet.customer-not-found`
  instead of the first answer.
- The facade's `grantCredit` (system callers) still does not check the customer: its callers
  (ordering, refunds) carry a customer id from their own records.

### Review notes for later (PR #522, 2026-10-26)

- D1 (Mojtaba): the `decided` list (`status IN ('approved','rejected','expired')`) scans: the
  list index leads with one `status`, and the cursor's `OR` is a filter, not an index condition.
  Fine at today's volume; when it grows, add a partial index
  `(market_id, requested_at DESC, id DESC) WHERE status IN ('approved','rejected','expired')`
  and write the cursor as a row comparison `(requested_at, id) < ($1, $2)`.
- D2 (Mojtaba): the journal guard on the requests table matches `xmin = pg_current_xact_id()`.
  Inside a savepoint (a subtransaction) the journal's `xmin` is the subtransaction's id, so the
  guard refuses: it fails closed. No code uses savepoints today; note it on the trigger if one
  ever does.
- D3 (Mojtaba): the expiry sweep takes 100 due requests per run (every 5 minutes), oldest first.
  Rows that fail every time stay at the head and could starve the rest. When it matters, order
  the ids that failed last run at the end (or log and skip them after N failures).
- S3 (Hassan): within the caps one admin can still credit a customer they control, up to the
  daily cap every day (and again just after midnight in the Market's zone). Maker-checker does not
  cover that. Recommended: a daily report of admin credit by customer and by admin (sum, count,
  admins involved) for the finance team, before the wallet goes live in production.

## Out of scope

Admin UI (package 2b), gift codes, checkout wiring, refunds to the wallet, cashback, notifications, the `reverse`
journal use case (the kind exists in the CHECK for package 2).
