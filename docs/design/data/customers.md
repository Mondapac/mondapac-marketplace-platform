# Physical data model: `customers` account deletion requests

**Ground truth:** `docs/modules/customers/notes.md` (packages 5a and 5b); `docs/design/data/platform.md`
(10.2 grants).
**Files:** `prisma/schema/customers.prisma`,
`prisma/migrations/20261027180000_customers_account_deletion_requests/` (package 5c adds the admin columns in `20261028120000_customers_account_deletion_admin/`).

This note covers `customers.account_deletion_requests` only (the address book and the
`account_deletion_settings` history are described in `notes.md`). The table carries `market_id` and
`tenant_id`, and every statement the application sends is scoped to the request's Market.

## 1. `account_deletion_requests`

One row per buyer request to delete their account. A buyer's own request holds **no personal data**:
ids, a status, the waiting period and instants. An admin's request (package 5c) also holds two
admin-entered text columns, `ticket_ref` and `reason`, which are **possible personal data** (an admin
can type a name or a phone number into either): the `reason` is redacted when the request closes
(section 5), the ticket reference is kept as the audit link to the support system. `account_id` is a
plain id (no foreign key) and means nothing once the account is erased. The row is **kept after completion as the audit record** that the erasure
was asked for and carried out; the application role cannot delete it.

| Column | Meaning |
|---|---|
| `id` | UUID, the request (the aggregate id of its three events) |
| `market_id`, `tenant_id` | Scope (ADR-0003, ADR-0001) |
| `account_id` | The customer account (identity), no foreign key |
| `status` | `pending`, `executing`, `cancelled`, `completed` (CHECK) |
| `waiting_period_days` | The wait in force when requested (7 to 90); the request keeps it |
| `requested_at`, `scheduled_for` | UTC instants; `scheduled_for` is after `requested_at` |
| `claimed_at` | When the job claimed it; set while `executing` and kept once `completed` |
| `cancelled_at`, `cancel_reason` | Set with `cancelled` only; reason `customer`, `sign-in` or `admin` |
| `completed_at` | Set with `completed` only |
| `requested_by` | `customer` (default) or `admin` (package 5c, CHECK) |
| `admin_account_id`, `ticket_ref`, `reason` | Set with `requested_by = 'admin'` only (CHECK): the admin, the support ticket (1 to 64 characters, `[A-Za-z0-9][A-Za-z0-9._#/-]*`) and the reason (1 to 500). **Admin-entered text, possible personal data**: kept here, never in an event or an audit row; never rewritten after insert, except that `reason` is set to NULL when the request closes |
| `redacted_at` | When `reason` was redacted: set, with `reason` NULL, on an admin request once it is `cancelled` or `completed`; NULL otherwise (CHECK) |
| `cancelled_by_admin_id` | Set with `cancel_reason = 'admin'` only (CHECK): the admin who cancelled. The admin's cancel note (1 to 500 characters, possible personal data) is validated and never stored; the admin's id and the step-up proof are in the audit row |

State moves, each one conditional update (`WHERE status = <from>`), so two writers racing for a row
cannot both win it: `pending` to `cancelled` (the buyer or an admin), `pending` to `executing` (the job's claim,
before any irreversible step; also a stale `executing` claim older than 15 minutes, taken again),
`executing` to `pending` (a blocker found after the claim), `executing` to `completed`. A claimed
request cannot be cancelled (409 `customers.account-deletion-in-progress`).

## 2. Access paths

| Read or write | Statement shape | Index that serves it |
|---|---|---|
| The account's open request (view, cancel, one-open check) | `market_id, account_id`, status in (`pending`, `executing`) | partial unique `account_deletion_requests_one_open_idx (market_id, account_id) WHERE status IN ('pending','executing')` |
| Insert a request | `INSERT ... ON CONFLICT DO NOTHING` | the same unique index (one open request per account) |
| Executor: due requests | `market_id`, `status = 'pending'`, `scheduled_for <= now`, order by `scheduled_for, id`, limit 25 | partial `account_deletion_requests_market_id_scheduled_for_pending_idx (market_id, scheduled_for, id) WHERE status = 'pending'` |
| Executor: stale claims | `market_id`, `status = 'executing'`, `claimed_at <= now - 15 min`, order by `claimed_at, id` | partial `account_deletion_requests_market_id_claimed_at_executing_idx (market_id, claimed_at, id) WHERE status = 'executing'` |
| Claim, release, cancel, complete | `market_id, id` plus the status condition | primary key |
| Admin: pending list (package 5c) | `market_id`, `status = 'pending'`, keyset after `(scheduled_for, id)`, order by `scheduled_for, id` | the same partial `..._scheduled_for_pending_idx` as the executor's due query |
| Admin: cancel by request id | `market_id, id` | primary key |

There is no index on `(market_id, account_id, requested_at)`: no query reads an account's history.

## 3. CHECKs

| Constraint | Invariant |
|---|---|
| `..._market_id_check`, `..._tenant_id_check` | Shape of the scope columns |
| `..._status_check` | The four states |
| `..._waiting_period_days_check` | 7 to 90 days |
| `..._scheduled_for_check` | `scheduled_for > requested_at` |
| `..._cancel_reason_check` | `customer`, `sign-in` or `admin` |
| `..._requested_by_check`, `..._admin_columns_check` | `customer` or `admin`; a buyer's request has none of the admin columns; an admin request has its admin and ticket, and either its reason (open, `redacted_at` NULL) or no reason and a `redacted_at` (closed: `cancelled` or `completed`) |
| `..._ticket_ref_check`, `..._reason_check` | Ticket shape; a reason, when present, is 1 to 500 characters |
| `..._admin_cancel_check` | `cancel_reason = 'admin'` has `cancelled_by_admin_id`; any other cancel has none |
| `..._closing_columns_check` | Each state has exactly its columns: `pending` none of `claimed_at`, `cancelled_at`, `cancel_reason`, `completed_at`; `executing` a `claimed_at` only; `cancelled` its two cancel columns and no claim; `completed` a claim and `completed_at` |

The closed-once rule (a `cancelled` or `completed` row never changes again) is enforced in code
only: every update names the status it moves from. There is no trigger (see follow-ups in
`notes.md`).

## 4. Grants

`mondapac_app`: `SELECT`, `INSERT`, and `UPDATE` on the state columns only (`status`, `claimed_at`,
`cancelled_at`, `cancel_reason`, `completed_at`, `cancelled_by_admin_id`, `reason`, `redacted_at`; the last two only to redact: `reason` can only be written, and the CHECK only allows NULL). No `DELETE`; `requested_by`, `admin_account_id` and `ticket_ref` are never updatable. Mirrored in
`apps/api/test/db/expected-privileges.ts`.

## 5. Retention

Rows are kept as the record of an erasure. A buyer's request holds no personal data. An admin's request
holds possible personal data in `reason` only until the request closes (cancelled by the buyer or an
admin, or completed): the same transaction sets `reason` to NULL and `redacted_at`. The ticket
reference stays, and is possible personal data too, so it is entered by pattern (letters, digits and
`. _ # /  -`, no spaces) rather than as free text. A retention period for the rows has not been set
(follow-up in `notes.md`).
