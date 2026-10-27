# Physical data model: `customers` account deletion requests

**Ground truth:** `docs/modules/customers/notes.md` (packages 5a and 5b); `docs/design/data/platform.md`
(10.2 grants).
**Files:** `prisma/schema/customers.prisma`,
`prisma/migrations/20261027002000_customers_account_deletion_requests/`.

This note covers `customers.account_deletion_requests` only (the address book and the
`account_deletion_settings` history are described in `notes.md`). The table carries `market_id` and
`tenant_id`, and every statement the application sends is scoped to the request's Market.

## 1. `account_deletion_requests`

One row per buyer request to delete their account. **No personal data**: the row holds ids, a status,
the waiting period and instants. `account_id` is a plain id (no foreign key) and means nothing once
the account is erased. The row is **kept after completion as the audit record** that the erasure
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
| `cancelled_at`, `cancel_reason` | Set with `cancelled` only; reason `customer` or `sign-in` |
| `completed_at` | Set with `completed` only |

State moves, each one conditional update (`WHERE status = <from>`), so two writers racing for a row
cannot both win it: `pending` to `cancelled` (the buyer), `pending` to `executing` (the job's claim,
before any irreversible step; also a stale `executing` claim older than 15 minutes, taken again),
`executing` to `pending` (a blocker found after the claim), `executing` to `completed`. A claimed
request cannot be cancelled (409 `customers.account-deletion-in-progress`).

## 2. Access paths

| Read or write | Statement shape | Index that serves it |
|---|---|---|
| The account's open request (view, cancel, one-open check) | `market_id, account_id`, status in (`pending`, `executing`) | partial unique `account_deletion_requests_one_pending_idx (market_id, account_id) WHERE status IN ('pending','executing')` |
| Insert a request | `INSERT ... ON CONFLICT DO NOTHING` | the same unique index (one open request per account) |
| Executor: due requests | `market_id`, `status = 'pending'`, `scheduled_for <= now`, order by `scheduled_for, id`, limit 25 | partial `account_deletion_requests_market_id_scheduled_for_pending_idx (market_id, scheduled_for, id) WHERE status = 'pending'` |
| Executor: stale claims | `market_id`, `status = 'executing'`, `claimed_at <= now - 15 min`, order by `claimed_at, id` | partial `account_deletion_requests_market_id_claimed_at_executing_idx (market_id, claimed_at, id) WHERE status = 'executing'` |
| Claim, release, cancel, complete | `market_id, id` plus the status condition | primary key |

There is no index on `(market_id, account_id, requested_at)`: no query reads an account's history.

## 3. CHECKs

| Constraint | Invariant |
|---|---|
| `..._market_id_check`, `..._tenant_id_check` | Shape of the scope columns |
| `..._status_check` | The four states |
| `..._waiting_period_days_check` | 7 to 90 days |
| `..._scheduled_for_check` | `scheduled_for > requested_at` |
| `..._cancel_reason_check` | `customer` or `sign-in` |
| `..._closing_columns_check` | Each state has exactly its columns: `pending` none of `claimed_at`, `cancelled_at`, `cancel_reason`, `completed_at`; `executing` a `claimed_at` only; `cancelled` its two cancel columns and no claim; `completed` a claim and `completed_at` |

The closed-once rule (a `cancelled` or `completed` row never changes again) is enforced in code
only: every update names the status it moves from. There is no trigger (see follow-ups in
`notes.md`).

## 4. Grants

`mondapac_app`: `SELECT`, `INSERT`, and `UPDATE` on the state columns only (`status`, `claimed_at`,
`cancelled_at`, `cancel_reason`, `completed_at`). No `DELETE`. Mirrored in
`apps/api/test/db/expected-privileges.ts`.

## 5. Retention

Rows are kept. They hold no personal data and are the record of an erasure. A retention period for
them has not been set (follow-up in `notes.md`).
