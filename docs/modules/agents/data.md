# agents: G2 physical data design

Author: Mojtaba (database-designer), 2026-11-06. Inputs: `design.md` sections 1-2 and 7, `brief.md` sections 6 and 11, ADR-0045, ADR-0004/0006/0007, `docs/design/data/platform.md` section 10. **Status:** draft for G2 review. No migration or Prisma file is written by this document.

Conventions (as in `commission_payouts`, `blog`, `sellers`): schema `agents`; Prisma models `Agents<Name>` with `@@map`/`@@schema("agents")`; ids `uuid` (UUIDv7, from the application); `market_id varchar(8)` and `tenant_id text` on every table, with the shared CHECKs `<t>_market_id_check` (`~ '^[A-Z][A-Z0-9_]{1,7}$'`) and `<t>_tenant_id_check` (`~ '^[a-z][a-z0-9-]{1,31}$'`); instants `timestamptz(6)` UTC; money `bigint` minor units plus `currency char(3)` (CHECK `~ '^[A-Z]{3}$'`); no FK leaves the schema (account, seller, order, refund ids are plain `uuid`). Same-Market is held by composite FKs on `(market_id, <id>)` to a `UNIQUE (market_id, <id>)` on the parent. PII is marked **[PII]**.

## 1. Tables

**`agent_profiles`** (AgentProfile root)
| Column | Type | Null | Notes |
|---|---|---|---|
| `agent_id` | uuid | no | PK `agent_profiles_pkey`; `UNIQUE (market_id, agent_id)` `agent_profiles_market_id_agent_id_key` (FK target) |
| `market_id`, `tenant_id` | varchar(8), text | no | |
| `account_id` | uuid | no | identity account, id only. `UNIQUE (market_id, account_id)` `agent_profiles_market_id_account_id_key`: one profile per account |
| `display_name` | text | no | **[PII]** CHECK `char_length BETWEEN 1 AND 120` |
| `time_zone` | text | no | IANA id, validated by the application; CHECK `<> ''` |
| `tax_id_scheme`, `tax_id_value` | text | yes | **[PII]** (a sole trader's ABN identifies a person). CHECK `agent_profiles_tax_id_check`: both null or both set; scheme `~ '^[a-z0-9-]{2,32}$'` |
| `version` | integer | no | optimistic lock, CHECK `>= 1` |
| `created_by` | uuid | no | admin account |
| `created_at`, `updated_at` | timestamptz(6) | no | |

No access state, no bank or payout column (design 1). Privileges: `SELECT, INSERT, UPDATE (display_name, time_zone, tax_id_scheme, tax_id_value, version, updated_at)`; no `DELETE`.

**`referral_codes`** (ReferralCode, every code ever issued)
| Column | Type | Null | Notes |
|---|---|---|---|
| `market_id`, `code` | varchar(8), text | no | PK `(market_id, code)`: a code is unique per Market **forever**, so a voided value is never reissued. CHECK `code ~ '^[A-Z2-7]{8,16}$'` (base32, >= 40 bits) |
| `tenant_id` | text | no | |
| `agent_id` | uuid | no | FK `(market_id, agent_id)` -> `agent_profiles` |
| `issued_at` | timestamptz(6) | no | |
| `voided_at` | timestamptz(6) | yes | CHECK `voided_at IS NULL OR voided_at >= issued_at` |

Partial unique `referral_codes_market_id_agent_id_active_key (market_id, agent_id) WHERE voided_at IS NULL`: one active code per agent. Privileges: `SELECT, INSERT, UPDATE (voided_at)`.

**`agent_rates`** (AgentRate, append-only)
| Column | Type | Null | Notes |
|---|---|---|---|
| `rate_record_id` | uuid | no | PK; `UNIQUE (market_id, rate_record_id, agent_id, basis, rate_bps)` (FK target that freezes the snapshot, see earnings) |
| `market_id`, `tenant_id`, `agent_id` | | no | FK `(market_id, agent_id)` -> `agent_profiles` |
| `basis` | text | no | CHECK `agent_rates_basis_check`: `IN ('net-sales','commission-share','gross')` |
| `rate_bps` | integer | no | CHECK `agent_rates_rate_bps_check`: `rate_bps > 0 AND rate_bps <= 10000`. The Market cap (`agents.rate-cap-bps.<basis>`) is config and stays in the domain; 10000 is only the hard ceiling |
| `effective_from` | timestamptz(6) | no | = recorded instant. `UNIQUE (market_id, agent_id, effective_from)` makes "greatest `effective_from <= T`" deterministic |
| `set_by` | uuid | no | |
| `reason` | text | no | CHECK `char_length BETWEEN 1 AND 500` |

Privileges: `SELECT, INSERT`.

**`shop_links`** (ShopLink history)
| Column | Type | Null | Notes |
|---|---|---|---|
| `link_id` | uuid | no | PK |
| `market_id`, `tenant_id`, `seller_id` | | no | seller id only (no FK) |
| `agent_id` | uuid | no | FK `(market_id, agent_id)` -> `agent_profiles`: agent and link share the Market |
| `valid_from` | timestamptz(6) | no | |
| `valid_to` | timestamptz(6) | yes | CHECK `shop_links_interval_check`: `valid_to IS NULL OR valid_to > valid_from` |
| `source` | text | no | CHECK `IN ('referral-code','admin')` |
| `start_reason` | text | yes | CHECK `shop_links_start_reason_check`: `source = 'referral-code' OR start_reason IS NOT NULL` |
| `started_by` | uuid | no | admin account or the system actor id |
| `end_reason` | text | yes | CHECK `IN ('unlinked','moved','agent-disabled')` |
| `ended_by` | uuid | yes | CHECK `shop_links_end_check`: `(valid_to IS NULL) = (end_reason IS NULL) AND (valid_to IS NULL) = (ended_by IS NULL)` |

**Non-overlap (Q8):** `ALTER TABLE "agents"."shop_links" ADD CONSTRAINT "shop_links_no_overlap_excl" EXCLUDE USING gist ("market_id" WITH =, "seller_id" WITH =, tstzrange("valid_from","valid_to",'[)') WITH &&);` exactly as `sellers.tax_registration_periods_no_overlap_excl`. `btree_gist` is verified present in schema `extensions` (migration `20261007220000_platform_btree_gist`; no grant needed, its down.sql refuses while this table exists, so agents' down runs first). `'[)'` lets a move close at T and open at T in one unit. Privileges: `SELECT, INSERT, UPDATE (valid_to, end_reason, ended_by)`; no `DELETE` (rows are never deleted).

**`unmatched_referrals`**: `unmatched_id uuid` PK; `market_id`, `tenant_id`, `seller_id uuid`; `entered_code text` (CHECK `char_length BETWEEN 1 AND 64`; raw seller input, rendered inert); `decision_id uuid` (from the approval event); `seen_at timestamptz(6)`; `resolved_at timestamptz(6) NULL`, `resolved_by uuid NULL`, `resolution_note text NULL` (CHECK all three null or all set). `UNIQUE (market_id, decision_id)`: one row per approval decision. Privileges: `SELECT, INSERT, UPDATE (resolved_at, resolved_by, resolution_note)`.

**`earnings`** (AgentEarning, immutable)
| Column | Type | Null | Notes |
|---|---|---|---|
| `earning_id` | uuid | no | PK |
| `market_id`, `tenant_id` | | no | |
| `agent_id`, `seller_id`, `order_id`, `seller_order_id` | uuid | no | FK `(market_id, agent_id)` -> `agent_profiles` |
| `rate_record_id`, `basis`, `rate_bps` | uuid, text, integer | no | FK `(market_id, rate_record_id, agent_id, basis, rate_bps)` -> `agent_rates`: the copied snapshot must equal the rate record of the same agent |
| `placed_at`, `delivered_at`, `final_at` | timestamptz(6) | no | CHECK `delivered_at >= placed_at AND final_at >= delivered_at` |
| `basis_amount`, `earning_amount` | bigint | no | CHECK `earnings_amounts_check`: `basis_amount >= 0 AND earning_amount >= 0 AND earning_amount <= basis_amount`; CHECK `earnings_floor_check`: `earning_amount = (basis_amount * rate_bps) / 10000` (integer division = floor for non-negative values; overflow of `bigint` needs a basis above 9.2e14 minor units) |
| `currency` | char(3) | no | the seller order's currency |
| `netted_refund_ids` | uuid[] | no | default `'{}'`; CHECK `array_position(netted_refund_ids, NULL) IS NULL` |
| `recorded_at` | timestamptz(6) | no | |

`UNIQUE (market_id, seller_order_id)` `earnings_market_id_seller_order_id_key` (idempotency, section 3); `UNIQUE (market_id, earning_id, agent_id, currency, basis_amount, earning_amount)` (FK target for reversals). Privileges: `SELECT, INSERT`.

**`earning_reversals`** (AgentEarningReversal, append-only)
| Column | Type | Null | Notes |
|---|---|---|---|
| `reversal_id` | uuid | no | PK |
| `market_id`, `tenant_id` | | no | |
| `earning_id`, `agent_id`, `currency`, `basis_amount`, `earning_amount` | | no | FK `(market_id, earning_id, agent_id, currency, basis_amount, earning_amount)` -> `earnings`: copies cannot drift |
| `refund_id` | uuid | no | `UNIQUE (market_id, refund_id)` |
| `seq` | integer | no | 1, 2, ... per earning; `UNIQUE (market_id, earning_id, seq)` serialises two concurrent refunds of one earning (the loser gets `23505` and retries from the inbox) |
| `refunded_basis`, `reversed` | bigint | no | CHECK `>= 0` |
| `cum_refunded_basis`, `cum_reversed` | bigint | no | running totals incl. this row. CHECK `earning_reversals_cap_check`: `cum_refunded_basis <= basis_amount AND cum_reversed <= earning_amount AND reversed <= cum_reversed AND refunded_basis <= cum_refunded_basis` |
| `is_remainder` | boolean | no | CHECK `earning_reversals_remainder_check`: `is_remainder = (cum_refunded_basis = basis_amount)` and `NOT is_remainder OR cum_reversed = earning_amount` |
| `recorded_at` | timestamptz(6) | no | |

Privileges: `SELECT, INSERT`.

**`issues`** (Issue root): `issue_id uuid` PK, `UNIQUE (market_id, issue_id)`; `market_id`, `tenant_id`; `agent_id` (FK -> `agent_profiles`), `seller_id uuid`; `title text` (CHECK 1-200), `description text` (CHECK 1-10000); `severity text` CHECK `IN ('low','medium','high')`; `status text` CHECK `issues_status_check`: `IN ('open','agent_responded','resolved','closed')`; `close_reason text NULL` CHECK `IN ('confirmed','withdrawn')`; `close_note text NULL`; CHECK `issues_close_check`: `(status = 'closed') = (close_reason IS NOT NULL) AND (close_reason <> 'withdrawn' OR close_note IS NOT NULL)`; `comment_count integer` (CHECK `>= 0`); `raised_by uuid`; `version integer` (CHECK `>= 1`); `created_at`, `updated_at`, `closed_at NULL` (CHECK `(status = 'closed') = (closed_at IS NOT NULL)`). Privileges: `SELECT, INSERT, UPDATE (status, close_reason, close_note, comment_count, version, updated_at, closed_at)`.

**`issue_status_changes`** (append-only; holds the reopen and withdrawn reasons and the agent's own transitions, which the admin audit log does not cover): `change_id uuid` PK; `market_id`, `tenant_id`, `issue_id` (FK `(market_id, issue_id)` -> `issues`); `from_status`, `to_status` (same CHECK list, `from_status <> to_status`); `reason text NULL` (CHECK required when `from_status = 'resolved' AND to_status = 'open'` or `to_status = 'closed' AND from_status <> 'resolved'`); `actor_type` CHECK `IN ('admin','agent')`; `actor_account_id uuid`; `occurred_at`. Privileges: `SELECT, INSERT`.

**`issue_comments`** (append-only): `comment_id uuid` PK; `market_id`, `tenant_id`, `issue_id` (FK `(market_id, issue_id)` -> `issues`); `seq integer` (CHECK `>= 1`), `UNIQUE (market_id, issue_id, seq)`; `author_type` CHECK `IN ('admin','agent')`; `author_account_id uuid`; `body text` (CHECK 1-4000 hard ceiling; the config limit is lower and domain-checked); `created_at`. Privileges: `SELECT, INSERT`.

**`outbox`**, **`inbox`**: the standard module pair, column for column as `blog`/`commission_payouts`, with `outbox_type_check ~ '^agents\.[a-z0-9-]+\.v[1-9][0-9]*$'`, `inbox_handler_check ~ '^agents\.[a-z0-9-]+$'`, the relay's partial index `outbox_market_id_event_id_unpublished_idx (market_id, event_id) WHERE published_at IS NULL`. Privileges: outbox `SELECT, INSERT, UPDATE (published_at)`; inbox `SELECT, INSERT, DELETE` (DELETE only for the purge, section 4).

ER sketch:
```
agent_profiles 1--* referral_codes      agent_profiles 1--* agent_rates 1--* earnings 1--* earning_reversals
agent_profiles 1--* shop_links (EXCLUDE per market+seller)      agent_profiles 1--* issues 1--* issue_comments
unmatched_referrals (standalone)        issues 1--* issue_status_changes        outbox, inbox (standard)
```

## 2. Indexes (volume assumed: 1k agents, 50k shops, 5M earnings per Market over 5 years)
| Query | Index |
|---|---|
| Earning by seller order (delivery idempotency, refund lookup) | `earnings_market_id_seller_order_id_key` (unique) |
| Link at instant T: `seller_id = ? AND valid_from <= T AND (valid_to IS NULL OR T < valid_to)` | the exclusion's gist index serves it when written as `tstzrange(valid_from, valid_to, '[)') @> T`; plus btree `shop_links_market_id_seller_id_valid_from_idx (market_id, seller_id, valid_from DESC)` for history lists and "has any history" |
| Agent's shops now / clipped intervals | `shop_links_market_id_agent_id_valid_from_idx (market_id, agent_id, valid_from DESC) INCLUDE (seller_id, valid_to)` |
| Rate in force at T | `agent_rates_market_id_agent_id_effective_from_key` (unique, scanned backward, LIMIT 1) |
| Agent dashboard monthly sums and admin per-seller/month: `agent_id = ? AND placed_at >= ? AND placed_at < ?` | `earnings_market_id_agent_id_placed_at_idx (market_id, agent_id, placed_at) INCLUDE (seller_id, earning_amount, currency, final_at)`: index-only scan, ~5k rows per agent-year |
| Reversals of those earnings | `earning_reversals_market_id_earning_id_seq_key` (unique) after a join on `earning_id`; `earning_reversals_market_id_agent_id_recorded_at_idx` for statement periods (AGT-10) |
| Issue comment polling `issue_id = ? AND seq > :cursor ORDER BY seq LIMIT n` | `issue_comments_market_id_issue_id_seq_key` (unique) |
| Agent's issues / admin issue list (keyset) | `issues_market_id_agent_id_updated_at_idx (market_id, agent_id, updated_at DESC, issue_id DESC)`; `issues_market_id_status_updated_at_idx (market_id, status, updated_at DESC, issue_id DESC)` |
| Unmatched referrals, open first | partial `unmatched_referrals_market_id_open_idx (market_id, seen_at DESC, unmatched_id DESC) WHERE resolved_at IS NULL` |

Not added: an index on `earnings.seller_id` alone (every read is agent-scoped); a GIN on `netted_refund_ids` (read only after the earning row is found by key); an index on `referral_codes.agent_id` beyond the partial unique (it serves the lookup).

## 3. Idempotency
- Delivery: inbox PK `(event_id, handler)` first; `earnings (market_id, seller_order_id)` unique second (`ON CONFLICT DO NOTHING`).
- Refund: inbox, then `earning_reversals (market_id, refund_id)` unique; `(market_id, earning_id, seq)` against races.
- Approval: inbox, then `unmatched_referrals (market_id, decision_id)` unique; a link is opened only when the seller has no row in `shop_links` (the exclusion stops a second open link).

## 4. Retention, growth, grants
- `earnings`, `earning_reversals`, `agent_rates`, `shop_links`, `issue_status_changes`: financial or audit history, kept for the Market's record-keeping period (AU: 5 years from config); no purge in the MVP. Partition `earnings` by `placed_at` only past ~50M rows.
- `issue_comments`: kept while the issue exists; no purge in the MVP. Bodies may hold personal data typed by admins or agents **[PII]**; erasure follows the platform erasure design when it lands.
- `inbox`: purge rows with `processed_at < now() - 90 days` in batches of 5k (`DELETE ... WHERE ctid IN (SELECT ... LIMIT 5000)`); safe because the unique business keys above are the second guard. The worker job belongs with the platform outbox/inbox maintenance (ADR-0015 trigger), not in agents. `outbox`: published rows follow the platform relay policy.
- Grants: `GRANT USAGE ON SCHEMA "agents" TO "mondapac_app";` once, then one `GRANT` per table with the Privileges lines above, to `mondapac_app` only (platform.md 10.3). `down.sql` revokes each in reverse order before dropping. The application login (`mondapac_api`) gets nothing directly.

## 5. Migration plan (one migration per build PR, brief section 11 order, each with `down.sql`, `pnpm db:check-reversible` green)
| PR | Migration | Tables |
|---|---|---|
| 0 (identity facade PR, cto Q8 (1)) | `identity_agent_population` (identity's) | swap `accounts_population_check`, `sessions_population_check`, `sign_in_records_population_check` (and any other identity `population` CHECK at that time) to add `'agent'` via `ADD ... NOT VALID` + `VALIDATE` + drop old; down restores the three-value CHECK (fails while an agent row exists, which is right) |
| 1 AGT-01 | `agents_profiles` | schema, `agent_profiles`, `referral_codes`, `outbox`, `inbox`, grants |
| 2 AGT-02..04 | `agents_links_rates` | `agent_rates`, `shop_links` (+ exclusion), `unmatched_referrals` |
| 3 AGT-05 | `agents_earnings` | `earnings`, `earning_reversals` |
| 4 AGT-06/07 | none expected | the earnings index ships in PR 3 |
| 5 AGT-08/09 | `agents_issues` | `issues`, `issue_status_changes`, `issue_comments` |
| 6 AGT-10 | none expected | |

Other modules' PRs: **ordering (cto Q7):** `seller_orders` has no placed instant (it is `orders.created_at`; the ordering data doc names it `placed_at`). I recommend ordering add `seller_orders.placed_at timestamptz(6)` (copied from the order at insert, set once, backfilled in 10k batches, then `SET NOT NULL` via a validated CHECK) and `CREATE INDEX CONCURRENTLY seller_orders_market_id_seller_id_placed_at_idx (market_id, seller_id, placed_at) INCLUDE (<net amount columns>)` in a hand-written migration. The alternative, joining `seller_orders` to `orders` on `created_at`, reads every order of 500 shops and is unlikely to hold p95 < 1 s; not measured yet: the 500 × 12 test decides, with EXPLAIN (ANALYZE, BUFFERS) in that PR for my sign-off.

## 6. Not enforceable in the schema, and disagreements
- Not enforceable: rate cap per Market and no back/future-dating (`effective_from` = Clock); agent population and Market of `account_id`; seller in the agent's Market; "linked at the moment of raising an issue"; no comment on a `closed` issue and the legal state transitions (domain + optimistic `version`; `issue_status_changes` records them); a reversal's `refund_id` not in `netted_refund_ids`; `final_at` equal to commission-payouts' anchor. A trigger could hold the closed-comment rule; I do not propose one (the issue row update in the same unit already serialises it).
- **D1, comment cursor:** design 5 polls `after=cursor`. A UUIDv7 or `created_at` cursor misses a comment committed late with a smaller key. I require a per-issue `seq` taken from `issues.comment_count + 1` in the same unit (the issue row update serialises writers), so the cursor is gap-free. The domain must bump `comment_count` (and `version`) on every comment, not only on transitions.
- **D2, reversal concurrency:** the remainder rule reads previous reversals; two refunds at once could both compute the remainder. The `seq` unique key plus running totals and the cap CHECKs make the database refuse that. `SELECT ... FOR UPDATE` on `earnings` is not available without an `UPDATE` grant (platform.md 10.4), so do not design for it.
- **D3, close reason:** the design names only `withdrawn`; the schema needs a value for a normal close of a `resolved` issue (`confirmed` proposed). Software-architect to confirm the name.
- **D4, month attribution of reversals** is not stated: by the earning's `placed_at` month or by the refund's `recorded_at`? It changes the dashboard query and AGT-10 statements; product-owner to decide before PR 3.
