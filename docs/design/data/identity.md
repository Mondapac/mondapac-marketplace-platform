# Physical data model — `identity` schema and its platform tables (G2)

**Author:** Mojtaba (database-designer) — 2026-10-03
**Status:** Draft — G2 review pending (Ali, Hassan; questions back to Mohammad in 11.3).
**Ground truth:** `docs/design/domain/identity.md` (cited as **D**, for example "D 6.3");
`docs/design/domain/platform-persistence-and-events.md` (**P**; inputs PM1 to PM8);
`docs/design/domain/platform-foundations.md` (**PF**; sections 3.1 to 3.3 and 4);
`docs/modules/identity/brief.md` (sections 5, 6, 9, 10; rules R1 to R12; "AC 19"); ADR-0003,
ADR-0004 (decisions 3 to 7), ADR-0006, ADR-0009 (decisions 2, 6, 7), ADR-0015, ADR-0018;
`docs/design/data/platform.md` and its section 10 (role and grant note, draft on branch
`docs/db-role-grant-note`, cited as "platform.md 10").
**Prisma models:** `prisma/schema/identity.prisma` (new) and two models in `platform.prisma`.
Nothing here exists yet; this document is the specification the migrations are written from.

## 1. Scope and table list

The physical design of everything D and P ask the database to hold in Phase 2, slice by slice,
with constraints, access paths, grants and the migration plan. It does not change the domain
model: where a mapping needed a choice, the choice is listed in 11.3 for Mohammad.

ADR-0009 pattern: **none of V1, V2 or V3 is used.** `identity` has no revisioned content and no
effective-dated record (PF 3.8, decision A1), and it snapshots nothing. History that must be kept
is V4: the platform audit log, plus two append-only tables of this schema.

| Table | Holds (D 2.1) | ADR-0009 pattern | Created in |
|---|---|---|---|
| `identity.outbox` | Events of the module (ADR-0006 decision 2) | None: a queue whose rows never change except `published_at` | Slice 1, PR 2 (11.3 M9) |
| `platform.subject_keys` | One wrapped data key per subject (PF 4) | None: live row that becomes a tombstone | Slice 1, PR 3 |
| `identity.accounts` | `Account` | None: live record; its changes are audited (V4 in `platform.audit_log`) | Slice 1, PR 4 |
| `identity.password_credentials` | `PasswordCredential` | None: only the current hash, by design | Slice 1, PR 4 |
| `identity.sessions` | `Session` | None | Slice 2 |
| `identity.sign_in_throttles` | Throttle counters (D 6.8) | None: transient counters | Slice 2 |
| `identity.sign_in_records` | Sign-in records (D 10.2, I8) | V4 append-only, with retention and without a hash chain | Slice 2 |
| `identity.one_time_links` | `OneTimeLink` | None | Slice 3 |
| `identity.inbox` | Handled deliveries (ADR-0006 decision 5) | None | Slice 3 |
| `platform.event_delivery` | Deliveries, retries, dead letters (ADR-0006 decision 4) | None: a work queue | Slice 3 |
| `identity.seller_access` | `SellerAccess` | None: current state; its history is `access_decisions` | Slice 5 |
| `identity.seller_memberships` | `SellerMembership` | None | Slice 5 |
| `identity.roles`, `identity.role_permissions` | `Role` and its keys | None: changes are audited with added and removed keys (R5) | Slice 5 (system rows); 8a (default); 10 (custom) |
| `identity.role_assignments` | `RoleAssignment` | None | Slice 5 |
| `identity.second_factors`, `identity.recovery_codes` | `SecondFactor` | None | Slice 7 |
| `identity.sign_in_challenges` | `SignInChallenge` | None | Slice 7 |
| `identity.invitations` | `Invitation` | None | Slice 7 (admin); used by 9 and 11 |
| `identity.access_decisions` | `AccessDecision` | V4 append-only | Slice 9 |
| `platform.audit_log` (changed) | The `ANONYMOUS` actor type (section 6) | V4, existing | Slice 6 |

Every table is Market-scoped: all of them carry `market_id` and `tenant_id`, the two platform
tables included, so the guard of P 4 needs no exemption line in Phase 2. Slices 4, 8b, 10, 11 and
12 create no table.

## 2. Conventions used by every table

| # | Convention |
|---|---|
| C1 | `market_id varchar(8) NOT NULL` and `tenant_id text NOT NULL`, no default (PF 3.3), each with a CHECK that mirrors the kernel pattern: `<table>_market_id_check CHECK (market_id ~ '^[A-Z][A-Z0-9_]{1,7}$')`, `<table>_tenant_id_check CHECK (tenant_id ~ '^[a-z][a-z0-9-]{1,31}$')`. Not repeated in the column tables below. `tenant_id` is in no key and no index |
| C2 | Ids are `uuid` (UUIDv7 from the application); instants are `timestamptz(6)` taken from `Clock`. No column default, no `now()`, no sequence, no enum type. Kinds and states are `text` with a CHECK |
| C3 | **A child cannot live in another Market than its parent (PM6, adopted).** Every parent has a unique index `(market_id, id)`, and every foreign key is `(market_id, <parent>_id)` → `(market_id, id)` with `ON UPDATE RESTRICT`. Cost: one extra unique index per parent. Measured: a child row with the other Market is refused; Prisma generates exactly this from a composite `@relation` |
| C4 | **Foreign keys stay inside the schema** (ADR-0004 decision 3). Three kinds of reference are plain ids with no foreign key even inside it: "who did it" columns (`*_by_account_id`), because history must outlive the actor's row, as `audit_log.actor_id` does; ids owned elsewhere (`basis_id`); and `invitations.role_id`, which may dangle by design (R12) |
| C5 | `version integer NOT NULL`, CHECK `>= 1`, insert writes 1 (PM5, P 10), on the roots that are loaded, changed and saved: `accounts`, `seller_access`, `seller_memberships`, `roles`, `role_assignments`, `one_time_links`, `invitations`, `second_factors`. **Not** on tables changed only by single guarded statements (11.3 M1) |
| C6 | Token hashes are `bytea` with CHECK `octet_length = 32` (SHA-256, D 6.2), unique per Market, looked up by equality only |
| C7 | Indexes lead with `market_id` (ADR-0004 decision 4). Primary keys on a single `uuid` stay as they are; a table that is 1:1 with its parent uses the primary key `(market_id, <parent>_id)`, which Prisma accepts as the 1:1 relation key with no extra index |
| C8 | Deleting a parent: `ON DELETE CASCADE` only for rows that have no meaning without it (credential, sessions, challenges, links, second factor, recovery codes, role keys); `ON DELETE RESTRICT` everywhere else, so those rows are removed by a use case, never by accident |
| C9 | Prisma model names start with `Identity` (`IdentityAccount`, `IdentityOutbox`): PM7 extended to every model, since model names are global; tables are mapped with `@@map` |

## 3. Tables

Columns of C1 are omitted. "Personal" marks personal data (ADR-0018 decision 6: declared from the
first migration). A named query says which design section runs it.

### 3.1 `identity.outbox` (slice 1; PM1, PM2)

| Column | Type | Null | Notes |
|---|---|---|---|
| `event_id` | `uuid` | no | PK. Written by the outbox writer |
| `type` | `text` | no | CHECK `^identity\.[a-z0-9-]+\.v[1-9][0-9]*$`: another module's type cannot be stored here |
| `occurred_at` | `timestamptz(6)` | no | |
| `aggregate_type` | `text` | no | CHECK `^[a-z][a-z0-9-]*$` |
| `aggregate_id` | `uuid` | no | |
| `aggregate_version` | `integer` | no | CHECK `>= 1` |
| `correlation_id` | `text` | no | CHECK as `audit_log_correlation_id_check` |
| `causation_id` | `uuid` | yes | |
| `payload` | `jsonb` | no | CHECK `jsonb_typeof = 'object'`. Ids, codes and permission keys only (P 5.3); the database cannot check that |
| `published_at` | `timestamptz(6)` | yes | The only column that ever changes |

- Unique `(market_id, aggregate_id, aggregate_version)` (I7). PM1 writes it without `market_id`;
  it leads here because of C7. An aggregate lives in one Market, so the guarantee is the same.
- Claim (P 6.1): partial index `(market_id, event_id) WHERE published_at IS NULL`. Measured again
  under the column-level grant: index scan, `FOR UPDATE SKIP LOCKED`, mark by `event_id = ANY`.
- No attempt, owner or error column; not pruned in Phase 2 (P 6.5). Every later module's outbox
  is this table under another schema, with its own module name in the `type` CHECK.

### 3.2 `platform.subject_keys` (slice 1, PR 3; PF 4)

| Column | Type | Null | Notes |
|---|---|---|---|
| `subject_id` | `uuid` | no | PK. An account id or a seller id (D 11.3). The table does not record which: the port takes an `Id`, and ids never repeat across kinds. The key on the subject alone is what refuses a second key for life (PF 4 row 5) |
| `key_version` | `integer` | no | CHECK `>= 1`; always 1 in Phase 2. Part of the wrap binding (PF 4 row 10) |
| `wrapped_key` | `text` | yes | The wrapped data key as a versioned text envelope; NULL once destroyed. CHECK `char_length <= 1024` until Kazem and Hassan fix the format (11.2, 11.4) |
| `wrapping_key_id` | `text` | no | Which regional wrapping key and version wrapped it (PF 4 row 2). CHECK length 1 to 128 |
| `created_at` | `timestamptz(6)` | no | |
| `rewrapped_at` | `timestamptz(6)` | yes | Last rotation of the wrapping key |
| `destroyed_at` | `timestamptz(6)` | yes | Set by `destroyKey` |

- CHECK `subject_keys_tombstone_check`: `(destroyed_at IS NULL) = (wrapped_key IS NOT NULL)`.
- `destroyKey` is one statement, `UPDATE … SET wrapped_key = NULL, destroyed_at = $1 WHERE
  subject_id = $2 AND market_id = $3 AND destroyed_at IS NULL`: a second call changes no row
  (idempotent, measured).
- The trigger below makes the tombstone one-way and freezes the identity columns, for every role,
  the owner included (Hassan's requirement, PF 4). Measured: reviving a tombstone fails with
  `23001`; a new key for a destroyed subject fails on the primary key; a rewrap of a live row and
  the destruction succeed.
- No DELETE for the application, so every abandoned sign-up leaves a tombstone (11.1 A7).
- Lookups are by primary key only; no secondary index. Not personal data: an opaque id and
  ciphertext.

```sql
CREATE FUNCTION "platform"."subject_keys_guard_update"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."destroyed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'platform.subject_keys: a destroyed key cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."subject_id", NEW."market_id", NEW."tenant_id", NEW."key_version", NEW."created_at")
     IS DISTINCT FROM
     (OLD."subject_id", OLD."market_id", OLD."tenant_id", OLD."key_version", OLD."created_at") THEN
    RAISE EXCEPTION 'platform.subject_keys: identity columns are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subject_keys_one_way"
  BEFORE UPDATE ON "platform"."subject_keys"
  FOR EACH ROW EXECUTE FUNCTION "platform"."subject_keys_guard_update"();
```

### 3.3 `identity.accounts` and `identity.password_credentials` (slice 1, PR 4)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK. Also the subject id of the account's key |
| `population` | `text` | no | CHECK `customer`, `seller`, `admin`. Never changes (domain) |
| `email` | `text` | no | **Personal, plain** (D 11.2 option A). As typed, trimmed. CHECK length 3 to 254 |
| `email_normalized` | `text` | no | **Personal, plain.** Trimmed, NFC, lower-cased by the application; the uniqueness and lookup value |
| `display_name` | `text` | no | **Personal, plain.** CHECK length 1 to 100 and no outer spaces (limit proposed, 11.3 M10) |
| `status` | `text` | no | CHECK `active`, `disabled` (D 3.1) |
| `email_verified_at` | `timestamptz(6)` | yes | NULL = unverified (D 3.2) |
| `existing_account_notice_at` | `timestamptz(6)` | yes | Last "you already have an account" mail (D 6.7) |
| `version` | `integer` | no | C5 |
| `created_at` | `timestamptz(6)` | no | Anchor of the 7-day purge (11.3 M5) |

- **Unique `(market_id, population, email_normalized)`**: ADR-0018 decision 3 and decision 5 of
  the brief as a constraint. Measured: the same address is accepted for the other population and
  for the other Market and refused twice in one. It is also the sign-in lookup (D 6.3 step 2) and
  the exact-email search of support (D 8.6 row 8): one index probe. The repository maps the
  constraint name to its domain error (P 10); it never reads first and inserts second.
- Unique `(market_id, id)`: the C3 target, and the keyset order of admin lists.
- CHECK on the normalised email, a backstop for a bug that stores the typed value (measured:
  ASCII upper case, an outer space and a decomposed accent are refused; non-ASCII upper case is
  **not**: full case folding stays the application's job):

```sql
CONSTRAINT "accounts_email_normalized_check" CHECK (
  "email_normalized" = lower("email_normalized" COLLATE "C")
  AND "email_normalized" = btrim("email_normalized")
  AND "email_normalized" IS NFC NORMALIZED
  AND char_length("email_normalized") BETWEEN 3 AND 254
  AND position('@' in "email_normalized") > 1)
```

- `identity.purge-unverified-accounts` (D 3.1, daily): `WHERE market_id = $1 AND
  email_verified_at IS NULL AND created_at < $2`, served by the partial index `(market_id,
  created_at) WHERE email_verified_at IS NULL`, which holds only the unverified rows.
- **Erasure and the purge are a hard delete.** The use case destroys the subject key, then
  deletes the account; C8 removes its credential, sessions, challenges, links and second factor.
  A membership, an assignment and a `seller_access` are removed first by the same use case
  (RESTRICT). The address becomes free again. What remains elsewhere is the account id as an
  opaque value (C4) and a key tombstone. Decision for Ali and Hassan: 11.1 A2.

`identity.password_credentials`: a table of its own, although the credential is an entity of
`Account`. "Never loaded with list queries" (D 2.1) then holds by structure: a query on
`accounts` cannot return a hash. Primary key `(market_id, account_id)` (C7), cascade from the
account. `password_hash text NOT NULL` with CHECK `^\$[a-z0-9-]+\$` and length at most 255: a PHC
string, so a raw password cannot be stored by mistake, and the algorithm stays replaceable
(ADR-0018 decision 1). `changed_at timestamptz(6) NOT NULL`. A change goes through the root and
raises `accounts.version`. The database guarantees at most one credential per account, not
exactly one (5).

### 3.4 `identity.sessions` (slice 2)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; the `sessionId` of `ActorContext` |
| `account_id` | `uuid` | no | FK to `accounts`, cascade |
| `population` | `text` | no | Copy, fixed at creation; CHECK as on accounts |
| `seller_id` | `uuid` | yes | Copy of the membership's seller, for revocation by seller (D 14.3). CHECK `(population = 'seller') = (seller_id IS NOT NULL)`. FK to `seller_access` added in slice 5 |
| `token_hash` | `bytea` | no | C6. The token itself is never stored (ADR-0018 decision 2) |
| `transport` | `text` | no | CHECK `cookie`, `bearer` (D 6.2) |
| `created_at`, `last_seen_at` | `timestamptz(6)` | no | `last_seen_at` is written at most once a minute and is in no index, so the update can stay on the heap page |
| `idle_timeout_seconds` | `integer` | no | CHECK `> 0`. Fixed at creation: "keep me signed in" differs per session (D 6.1; 11.3 M2) |
| `absolute_expires_at` | `timestamptz(6)` | no | CHECK `> created_at` |
| `revoked_at` | `timestamptz(6)` | yes | |
| `revoked_reason` | `text` | yes | A code (`sign-out`, `password-changed`, `seller-suspended`, …). CHECK code pattern; CHECK `(revoked_at IS NULL) = (revoked_reason IS NULL)` |

| Query | Index |
|---|---|
| Per-request read of the `Authenticator` (D 6.2): `WHERE market_id = $1 AND token_hash = $2`, then account, membership and seller access by key | Unique `(market_id, token_hash)`; the three follow-up reads use `accounts_pkey`, the active-membership index of 3.9 and `seller_access_pkey` |
| Revoke every session of an account (password change or reset, disable, second-factor change, removal) | `(market_id, account_id)` |
| Revoke every session of a seller (reject, suspend: D 3.3) | Partial `(market_id, seller_id) WHERE seller_id IS NOT NULL AND revoked_at IS NULL` |
| `identity.purge-expired`: `absolute_expires_at < now − 30 days` | `(market_id, absolute_expires_at)` |

No `version` (C5): revocation is a set-based `UPDATE … WHERE revoked_at IS NULL`, and it must not
lose against the once-a-minute `last_seen_at` write. Expiry is decided at read time from `Clock`
(`last_seen_at`, `idle_timeout_seconds`, `absolute_expires_at`), never by the job. A revoked row
leaves when its absolute lifetime plus 30 days has passed (11.3 M6). The re-confirmation instant
of D 8.5 is a nullable column added by that mini-review, not now.

### 3.5 `identity.sign_in_throttles` (slice 2; D 6.8)

| Column | Type | Null | Notes |
|---|---|---|---|
| `kind` | `text` | no | Which counter: for example `sign-in.account-origin`, `sign-in.account`, `mail.account`, `mail.origin`. CHECK code pattern |
| `key_hash` | `bytea` | no | Keyed hash of what the counter counts (Market, population, normalised email, origin, as the kind says). CHECK `octet_length = 32`. PK `(market_id, kind, key_hash)` |
| `account_key` | `bytea` | yes | The keyed hash of (Market, population, normalised email) alone, on kinds that involve an address, so that a password reset can clear every counter of that address (AC 13) |
| `window_started_at` | `timestamptz(6)` | no | |
| `attempts` | `integer` | no | CHECK `>= 0` |
| `blocked_until` | `timestamptz(6)` | yes | |

- No address and no email is stored, only keyed hashes, also for unknown addresses. The key is a
  stack-level secret: 11.2 H4.
- Write path, two statements in the unit that records the attempt: a guarded `UPDATE` that
  restarts the window (`WHERE … AND window_started_at <= $now − window`), then an upsert on the
  primary key that increments. Under READ COMMITTED the second of two concurrent writers waits
  and re-reads the row, so no increment is lost. Whether Prisma sends one `INSERT … ON CONFLICT`
  for it is checked in spike 6 with Hossein.
- Index `(market_id, account_key)` for the clearing. No index for the purge: rows live about an
  hour and the table stays small.
- Counters are per Market, origin counters included. D 6.8 says origin counters are not split by
  Market (I11): 11.1 A6.

### 3.6 `identity.sign_in_records` (slice 2; D 10.2, I8)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `population` | `text` | no | The sign-in page that was used |
| `account_id` | `uuid` | yes | Plain id (C4); NULL for an unknown address. **Never the typed email** |
| `outcome` | `text` | no | The code of D 6.3 (`signed-in`, `credentials.invalid`, `request.throttled`, …). CHECK code pattern, not a closed list |
| `occurred_at` | `timestamptz(6)` | no | |
| `origin` | `inet` | no | **Personal, plain**: the client address. The only place in the database that stores one |
| `session_id` | `uuid` | yes | Plain id; set on success |
| `correlation_id` | `text` | no | CHECK as on `audit_log` |

- Append-only for the application by privilege: `INSERT`, `SELECT` and `DELETE`, no `UPDATE`
  (section 7). No trigger and no hash chain: unlike `audit_log` it has a retention, and the
  tamper-evident record of an admin's successful sign-in is its audit row (D 10.2).
- **Retention: 90 days** (proposal, Hassan). `identity.purge-expired` deletes `WHERE market_id =
  $1 AND occurred_at < $now − 90 days`, in slices of one day of `occurred_at` per statement, on
  the index `(market_id, occurred_at)`. Safe to run twice and concurrently.
- Not added: `(market_id, account_id, occurred_at)`. No screen reads the records in Phase 2 (D
  5.3); it arrives with that screen or with erasure, whichever is first.
- Volume: attacker-driven but bounded by the throttles; section 9.

### 3.7 `identity.one_time_links` (slice 3; D 3.7, 6.6)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; the `linkId` of the event |
| `account_id` | `uuid` | no | FK to `accounts`, cascade |
| `purpose` | `text` | no | CHECK `verify-email`, `reset-password`, `confirm-second-factor-reset` (the last one is used from slice 12, D 7.3) |
| `requested_at` | `timestamptz(6)` | no | |
| `token_hash` | `bytea` | yes | C6. NULL while `requested`: the mail handler stores it after the send |
| `issued_at`, `expires_at` | `timestamptz(6)` | yes | Set together with the hash; `expires_at` is `issued_at` plus the lifetime (60 minutes for a reset, SEL-05), computed by the application |
| `consumed_at` | `timestamptz(6)` | yes | |
| `version` | `integer` | no | C5 |

- **Unique `(market_id, account_id, purpose)`**: one row per account and purpose. A new request
  reuses the row (hash, instants and `consumed_at` reset, version raised), which is what "the
  hash is replaced" means (D 3.7): the database then guarantees "at most one usable link" (AC 19)
  with a plain unique key.
- Unique `(market_id, token_hash)`: the lookup when a token is presented. NULLs do not collide.
- CHECKs: `(token_hash IS NULL) = (issued_at IS NULL)`, `(issued_at IS NULL) = (expires_at IS
  NULL)`, `expires_at > issued_at`, `consumed_at IS NULL OR issued_at IS NOT NULL`.
- Single use is one conditional statement, `UPDATE … SET consumed_at = $now WHERE id = $1 AND
  market_id = $2 AND consumed_at IS NULL AND expires_at > $now`: one row changed or none.
- The purge needs no index: at most three rows per account.

### 3.8 `identity.inbox` and `platform.event_delivery` (slice 3; PM3, PM4)

`identity.inbox`: primary key `(event_id, handler)` (ADR-0006 decision 5), C1, `processed_at
timestamptz(6) NOT NULL`, `handler` with CHECK `^identity\.[a-z0-9-]+$`. `runOnce` inserts with
"skip duplicates" and reads the count. No other index until the prune job exists (P 7, "before
the first deployed environment"): the index `(market_id, processed_at)` and the `DELETE` grant
arrive in that job's migration.

`platform.event_delivery`:

| Column | Type | Null | Notes |
|---|---|---|---|
| `event_id`, `subscriber` | `uuid`, `text` | no | PK `(event_id, subscriber)`. `subscriber` CHECK `^[a-z][a-z0-9-]*\.[a-z0-9-]+$` |
| `status` | `text` | no | CHECK `pending`, `delivered`, `dead` |
| `attempts` | `integer` | no | CHECK `>= 0` |
| `next_attempt_at` | `timestamptz(6)` | no | |
| `type`, `occurred_at`, `aggregate_type`, `aggregate_id`, `aggregate_version`, `correlation_id`, `causation_id`, `payload` | as in 3.1 | as in 3.1 | The envelope copy, so the dispatcher never reads a module schema. Never updated |
| `error_code` | `text` | yes | A code, never a message or a row value (P 12.3). CHECK code pattern |
| `created_at` | `timestamptz(6)` | no | |
| `delivered_at`, `dead_at` | `timestamptz(6)` | yes | CHECK `(status = 'delivered') = (delivered_at IS NOT NULL)` and the same for `dead` |

Claim (P 6.4): partial index `(market_id, next_attempt_at) WHERE status = 'pending'`. Fan-out is
an insert that ignores a repeated key. Not added until their readers exist: an index for dead
rows (the requeue routine) and one for pruning delivered rows.

### 3.9 Seller access, membership, roles (slice 5)

**`identity.seller_access`**

| Column | Type | Null | Notes |
|---|---|---|---|
| `seller_id` | `uuid` | no | PK, minted by `identity` (D 8.3); also the subject id of the seller's key. Unique `(market_id, seller_id)` for C3 |
| `origin` | `text` | no | CHECK `self`, `invitation` |
| `state` | `text` | no | CHECK `pending`, `approved`, `rejected`, `suspended` (D 3.3) |
| `state_changed_at` | `timestamptz(6)` | no | Returned by `sellerAccessOf` |
| `reapply_count` | `smallint` | no | CHECK `>= 0`; the limit is Market policy |
| `registered_at` | `timestamptz(6)` | yes | When `identity.seller-registered.v1` was recorded (11.3 M4). NULL means the 7-day purge may still delete the row |
| `version`, `created_at` | | no | C5 |

Admin list of sellers by state (D 8.6 row 8): `(market_id, state, state_changed_at)`.

**`identity.seller_memberships`**: `id` PK; `account_id` FK to `accounts`, RESTRICT; `seller_id`
FK to `seller_access`, RESTRICT; `state` CHECK `active`, `removed`; `removed_at` with CHECK
`(state = 'removed') = (removed_at IS NOT NULL)`; `version`; `created_at`.
- **Partial unique `(market_id, account_id) WHERE state = 'active'`**: one active membership per
  account, the Phase 2 rule of ADR-0018 decision 3, and the `Authenticator`'s read. Removed rows
  stay, and a removed member who joins another team gets a new row. Lifting the rule later is
  dropping this one index. Measured.
- Team list, member count, holders of a seller: `(market_id, seller_id, state)`.

**`identity.roles`**

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; unique `(market_id, id)` |
| `scope` | `text` | no | CHECK `platform`, `seller` (R2) |
| `kind` | `text` | no | CHECK `system`, `default`, `custom` |
| `seed_code`, `seed_version` | `text`, `integer` | yes | Set if and only if the kind is not `custom` (two CHECKs). `seed_code` CHECK `^[a-z][a-z0-9-]*$`; `seed_version` CHECK `>= 1` |
| `name` | `text` | yes | **Personal (free text), plain.** Set if and only if `custom`; CHECK length 1 to 80. Never in an audit row, an event or a log (R5) |
| `seller_id` | `uuid` | yes | FK to `seller_access`, RESTRICT. CHECK `(scope = 'seller' AND kind = 'custom') = (seller_id IS NOT NULL)` (R9) |
| `version`, `created_at` | | no | C5 |

- Unique `(market_id, scope, seed_code)`: the seed routine's key, and what makes two workers
  seeding at once safe (the loser gets the constraint error and reads the row).
- Partial unique `(market_id, scope) WHERE kind = 'system'`: at most one system role per scope
  and Market. This is all the database carries of R3.
- Custom roles of a seller (role editor, the limit of D 2.3): `(market_id, seller_id)`.

**`identity.role_permissions`**: keys as rows, not as an array. Primary key `(market_id,
role_id, permission_key)`; FK to `roles`, cascade; CHECK on the key pattern of PF 6.1. A row is
added or removed, never updated, so the application gets no `UPDATE`.

| Option | For | Against |
|---|---|---|
| Rows (chosen) | A duplicate key and a malformed key are impossible; an edit touches only the changed keys; set queries stay possible ("which roles hold a retired key") | Tens of small rows per role; the per-request read returns them as a key-range scan of one index |
| `text[]` on `roles` | One row per role | No per-element constraint without a function; every edit rewrites the role row |

System roles have no rows (D 2.3); nothing in the database stops one being written (5).

**`identity.role_assignments`**: `id` PK; `account_id` FK to `accounts`, RESTRICT; `role_id` FK
to `roles`, RESTRICT, which is "a role with assignments cannot be deleted" (D 2.3) as a
constraint; `assigned_by_account_id` (C4, NULL for a founding assignment); `assigned_at`;
`version`.
- Unique `(market_id, account_id)`: one role per account in Phase 2 (D 2.3), and the read of
  `AuthorisationCheck` on every request. Several roles later means dropping this key.
- `(market_id, role_id)`: holders of a role (`LastHolderPolicy`, `role.in-use`).

### 3.10 Second factor, challenge, invitation (slice 7)

**`identity.second_factors`**: `id` PK, new for every enrolment (11.3 M3); `account_id` FK to
`accounts`, cascade, unique `(market_id, account_id)`; `state` CHECK `pending`, `active` (`none`
is no row); `secret_ciphertext text NOT NULL`, encrypted with the account's subject key (label
`identity.second-factor.secret`, D 7.5); `last_accepted_step integer` nullable, CHECK `>= 0`
(30-second steps fit 32 bits far beyond any horizon); `activated_at` with CHECK `(state =
'active') = (activated_at IS NOT NULL)`; `created_at`; `version`.

**`identity.recovery_codes`**: primary key `(market_id, second_factor_id, position)` with CHECK
`position BETWEEN 1 AND 10`, so "at most ten" is a constraint; FK to `second_factors`, cascade;
`code_hash bytea` (C6; the hash function is Hassan's call, 11.2 H2); `used_at` nullable. Use is a
conditional update on `used_at IS NULL`.

**`identity.sign_in_challenges`**: `id` PK; `account_id` FK, cascade; `purpose` CHECK
`second-factor`, `second-factor-enrolment`; `token_hash` (C6), unique `(market_id, token_hash)`;
`attempts smallint` CHECK `>= 0` (the limit of five is policy); `expires_at`; `consumed_at`
nullable; `created_at`. Rows live minutes; no `version`, no purge index.

**`identity.invitations`**

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `kind` | `text` | no | CHECK `seller-owner`, `staff`, `admin` |
| `email`, `email_normalized` | `text` | yes | **Personal, plain**, present only while `pending`: CHECK `(state = 'pending') = (email_normalized IS NOT NULL)`, the same for `email`, and the email CHECK of 3.3. Acceptance and revocation set both to NULL |
| `role_id` | `uuid` | no | Plain id (C4): the role may be deleted while the invitation is pending, and acceptance then refuses (R12) |
| `seller_id` | `uuid` | yes | FK to `seller_access`, RESTRICT. CHECK `(kind = 'admin') = (seller_id IS NULL)` |
| `invited_by_account_id` | `uuid` | yes | C4; NULL for the first-admin routine |
| `token_hash`, `expires_at` | `bytea`, `timestamptz(6)` | yes | Set together at dispatch (CHECK); a re-send replaces both |
| `state` | `text` | no | CHECK `pending`, `accepted`, `revoked`. `expired` is not stored: it is `pending` past `expires_at`, decided at read time |
| `decided_at`, `accepted_account_id` | `timestamptz(6)`, `uuid` | yes | CHECK `(state = 'pending') = (decided_at IS NULL)`; CHECK `(state = 'accepted') = (accepted_account_id IS NOT NULL)` |
| `version`, `created_at` | | no | C5 |

- **One pending invitation per Market, scope and address** (D 14.3) is two partial unique
  indexes, because the platform scope has no seller: `(market_id, seller_id, email_normalized)
  WHERE state = 'pending' AND seller_id IS NOT NULL` and `(market_id, email_normalized) WHERE
  state = 'pending' AND seller_id IS NULL`. Measured, including a new invitation after a
  revocation. They also serve the lists of open invitations.
- Unique `(market_id, token_hash)` for acceptance and the preview (D 8.6 row 5).
- An expired pending row still holds its key until the hourly job deletes it, so the issue use
  case replaces such a row in its own unit (11.3 M7).

### 3.11 `identity.access_decisions` (slice 9)

`id` PK; `seller_id` FK to `seller_access`, RESTRICT; `decision` CHECK `approved`, `rejected`,
`suspended`, `reinstated`; `reason_ciphertext text` nullable, encrypted with the **seller's**
subject key (D 11.3); `basis_id uuid` nullable (C4; the submission id of `sellers`, D 8.4);
`decided_by_account_id` (C4; NULL for the system actor); `decided_at`.
- CHECK `(decision IN ('rejected', 'suspended')) = (reason_ciphertext IS NOT NULL)`: decision 9
  of the brief as far as a constraint can carry it. "Non-empty" is the domain's.
- Append-only by privilege: `INSERT` and `SELECT` only. The tamper-evident trace is the audit
  row, which holds the decision id (D 10.1). Destroying the seller's key makes every reason
  unreadable while the rows stay.
- Status page and admin screens (latest decision of a seller): `(market_id, seller_id,
  decided_at)`.

## 4. What is never stored

| Never in the database | Instead |
|---|---|
| A session token, a link, invitation or challenge token, the CSRF token | The SHA-256 hash (C6); the CSRF token is derived per request (D 6.4) |
| A password, or anything derived from it but the PHC string | `password_credentials.password_hash` |
| A second-factor secret or a recovery code in clear | Ciphertext under the subject key; hashes |
| An unwrapped data key, or the wrapping key | `subject_keys.wrapped_key` only (PF 4 row 1) |
| The email typed at a failed sign-in for an unknown address | A keyed hash in `sign_in_throttles`; `sign_in_records.account_id` is NULL |
| A client address anywhere but `sign_in_records.origin` (plain, 90 days) | Keyed hashes in throttle keys. No address on sessions, links, invitations or audit rows; no user agent and no device label anywhere |
| Roles, permission keys or seller state on a session | Read on every request (R4) |
| The reject or suspend reason in clear, or outside `access_decisions` | Ciphertext; the decision id in audit rows and events |
| Personal data in `outbox`, `event_delivery`, `inbox` | Ids, codes and permission keys (P 5.3) |
| An invited address after the invitation was accepted or revoked | NULL by CHECK (3.10) |

## 5. Invariants the database does not carry

| Invariant | Why not a constraint | Enforced by |
|---|---|---|
| The last Seller Owner of a seller, and the last full-access admin of a Market, cannot be removed, demoted or disabled (R3) | It counts rows of three tables | `LastHolderPolicy` in a `serializable` unit of work (D 5.5) |
| A role's scope matches the account's population; a customer never has an assignment or a membership; a seller role is assigned only inside its seller (R2, R9) | Cross-table | `RoleAssignment` invariant, `GrantPolicy` |
| System roles hold no stored keys; system and default roles are read-only; default roles change only by seed (R3, R10) | The table cannot tell who writes | `Role` invariant; the seed routine |
| A stored key is of the role's scope and known to the registry (R2, R7) | The catalogue is code | `Role` invariant; unknown keys are dropped at resolution |
| R1 and R11 (nobody grants what they lack; protected keys) | Depends on the actor | `GrantPolicy` |
| Which state follows which (every state machine of D 3) | CHECKs here carry the value sets and the columns each state needs, never the transitions | The aggregates |
| Lifetimes, expiry, thresholds and limits (60 minutes, five attempts, three re-applications, 20 roles, 50 members) | Policy values, and time comes from `Clock` | Use cases, at read time |
| Exactly one credential per account; an admin session only after a second-factor proof | "At least one" needs a deferred constraint; the second is behaviour | The `Account` aggregate; the sign-in use case |
| The copies on `sessions` (`population`, `seller_id`) equal the account and its membership | Would need wider keys on the parents | Session creation; population never changes |
| An account, a row's Market or a seller reference never changes | No trigger for it | The guard refuses any write of `market_id` (P 4.1); repositories |
| `invitations.role_id` points at an existing role; the inviter may still grant it | Dangling by design (R12) | Acceptance guards (D 3.4) |
| A `seller_id` is known to `sellers`; a `basis_id` is a submission | No cross-module foreign key | Events and the facade (D 8.3) |
| Non-ASCII case folding of emails; non-empty reason text; no personal data in a payload | Not expressible | Application normalisation; the domain; `defineEvent` (P 5.3) |

## 6. `platform.audit_log`: the `ANONYMOUS` actor type

Decision: **yes**, as D 10.1 asks, and it closes that part of Q6 in `platform.md`. The audit
writer derives the actor from the `CallContext` and accepts none from its caller (PF 5.2 rule 2).
Accepting an invitation, activating a factor inside an admin's first sign-in and confirming a
reset by link all run without a session, so the writer can only see the anonymous actor; `USER`
would need a second way to name an actor, which that rule forbids.

Conditions: an `ANONYMOUS` row is written only for a **successful** action whose credential
binds exactly one account or invitation, named in `target_id`; failed attempts go to
`sign_in_records`, so no attacker-driven volume enters a table that is never pruned (my concern
in I8). `audit_log_actor_check` already forces `actor_id` to be NULL for every type but `USER`,
and `audit_log_acting_as_check` then forces `acting_as_id` to be NULL: neither changes.

```sql
-- migration.sql (slice 6, with the audit writer's own migration; the table is still empty)
ALTER TABLE "platform"."audit_log"
  DROP CONSTRAINT "audit_log_actor_type_check",
  ADD CONSTRAINT "audit_log_actor_type_check"
    CHECK ("actor_type" IN ('USER', 'SYSTEM', 'ANONYMOUS'));
-- down.sql: the same statement with ('USER', 'SYSTEM'); it fails if an ANONYMOUS row exists
```

No grant changes. The append-only triggers do not fire on `ALTER TABLE`. After slice 6 has
written rows the same change would need `NOT VALID` and `VALIDATE`; that is why it lands first.

## 7. Grants

Under platform.md 10.2: hand-written in the migration that creates the table, to the group
`mondapac_app`, mirrored in `down.sql`, never `ALL`, `TRUNCATE`, `REFERENCES` or `TRIGGER`.
`GRANT USAGE ON SCHEMA "identity"` is in the first migration of the schema. There is no
sequence and no function for the application; `subject_keys_guard_update()` is a trigger
function and gets no grant.

| Table | Privileges of `mondapac_app` | Reason |
|---|---|---|
| `identity.outbox` | `SELECT, INSERT`, `UPDATE (published_at)` | PM2: the envelope is immutable to a compromised application |
| `platform.subject_keys` | `SELECT, INSERT`, `UPDATE (wrapped_key, wrapping_key_id, rewrapped_at, destroyed_at)` | PF 4: tombstone, no `DELETE`. Measured: another column fails with `42501` |
| `platform.event_delivery` | `SELECT, INSERT`, `UPDATE (status, attempts, next_attempt_at, error_code, delivered_at, dead_at)` | The envelope copy is immutable. `DELETE` arrives with the prune job |
| `identity.inbox` | `SELECT, INSERT` | `DELETE` arrives with the prune job |
| `identity.sign_in_records` | `SELECT, INSERT, DELETE` | Append-only with retention |
| `identity.access_decisions` | `SELECT, INSERT` | Append-only |
| `identity.role_permissions` | `SELECT, INSERT, DELETE` | A key row is never edited |
| `identity.password_credentials`, `identity.recovery_codes` | `SELECT, INSERT, UPDATE`; `recovery_codes` also `DELETE` (regeneration) | A credential is removed only by the cascade from its account: measured, the cascade needs no `DELETE` grant on the child |
| `identity.accounts`, `sessions`, `sign_in_throttles`, `one_time_links`, `seller_access`, `seller_memberships`, `roles`, `role_assignments`, `second_factors`, `sign_in_challenges`, `invitations` | `SELECT, INSERT, UPDATE, DELETE` | Ordinary tables; `DELETE` is used by the purge jobs, by erasure and by the use cases that remove a row |

**Column-level grants contradict my own draft.** The "Never" row of platform.md 10.2 lists
"column-level grants", and its privilege test (10.5) fails on any `attacl`. PM2 and PF 4 need
them. Proposed amendment (11.1 A1): column-level `UPDATE (<columns>)` is allowed when the data
design names the columns, never column-level `SELECT` or `INSERT`; the expected map of the test
gains the column list. Without the amendment these three tables get table-level `UPDATE` and the
immutability of their other columns rests on the application alone.

Api and worker share one login today (platform.md 10.7), so the api also holds `UPDATE
(published_at)` and the delivery columns. A separate worker group is PH4 of P.

## 8. Migration plan

### 8.1 Order (one PR with a migration open at a time, `docs/process/parallel-tracks.md` rule 6)

| # | Slice and PR | Migration | Contains |
|---|---|---|---|
| 0 | Slice 0 item 7 | `app_role_grants` (platform.md 10.3) | Prerequisite of everything below |
| 1 | 1, PR 2 | `identity_outbox` | `CREATE SCHEMA "identity"`, `outbox`, schema `USAGE` and table grants |
| 2 | 1, PR 3 | `platform_subject_keys` | Table, trigger function, trigger, grants |
| 3 | 1, PR 4 | `identity_accounts` | `accounts`, `password_credentials` |
| 4 | 2 | `identity_sessions` | `sessions`, `sign_in_throttles`, `sign_in_records` |
| 5 | 3 | `platform_event_delivery`, then `identity_links_inbox` | Two migrations in one PR: `event_delivery`; `one_time_links`, `inbox` |
| 6 | 5 | `identity_seller_access_roles` | `seller_access`, `seller_memberships`, `roles`, `role_permissions`, `role_assignments`; the foreign key `sessions.seller_id` |
| 7 | 6 | `platform_audit_anonymous` | Section 6, next to the audit design's own tables |
| 8 | 7 | `identity_second_factor_invitations` | `second_factors`, `recovery_codes`, `sign_in_challenges`, `invitations` |
| 9 | 9 | `identity_access_decisions` | `access_decisions` |

Slices 4, 8a, 8b, 10, 11 and 12 need no migration. Later, each with its job: the `DELETE` grants
and prune indexes of `inbox` and `event_delivery`.

### 8.2 Reversibility and safety

- Every `down.sql` mirrors its up in reverse: `REVOKE` first (platform.md 10.2), then child
  tables before parents, then hand-written functions. Partial indexes, CHECKs and triggers go
  with their table. No `IF EXISTS`, as in `platform.md` section 6.
- The down of migration 1 leaves the empty schema `identity` and revokes its `USAGE`, so the
  leftover check of platform.md 10.5 stays clean. The down of 6 drops the foreign key on
  `sessions` before the tables. The down of 7 fails once an `ANONYMOUS` row exists; that is
  correct, a down is for an empty or development database.
- All tables are new: no backfill, no lock that matters. The one statement on an existing table
  is the foreign key on `sessions` in migration 6; no deployed environment exists then (brief
  decision 2). On live data it would be `NOT VALID` followed by `VALIDATE`.
- My sign-off per migration follows the checklist form of `platform.md` section 8, plus: the
  hand-written block equals section 8.4 for that table, and the privilege map changed in the
  same PR.

### 8.3 Seed data

System and default roles carry `market_id` and `tenant_id`, and SQL knows neither the hosted
Markets nor the tenant constant: **no role row comes from a migration** (D 5.6, I9). The seed is
the versioned file per scope in `modules/identity/infrastructure/seed/`, applied by a `system`
use case per hosted Market at deploy and at worker start, as the application role. What the
schema gives it: the unique `(market_id, scope, seed_code)` makes a concurrent or repeated run
converge; `seed_version` tells a newer file from the stored row; the partial unique on system
roles refuses a second one; default roles are replaced key by key in one unit, with an audit row
per change, so default roles (slice 8a) need the audit writer of slice 6; system roles (slice 5)
are created without keys. A Market added to `HOSTED_MARKETS` gets its roles at the next start.
Tests run it for both fixtures. Nothing else in Phase 2 is seeded.

### 8.4 Prisma specifics

- One file per module: `prisma/schema/identity.prisma`, models named by C9, each with
  `@@schema("identity")`; `SubjectKey` and `EventDelivery` join `platform.prisma`.
  `base.prisma` gains `"identity"` in `schemas` (a shared file, in the PR of migration 1).
- Prisma expresses: tables, column types (`Bytes`, `@db.Inet`, `@db.JsonB`, `@db.SmallInt`,
  `@db.Timestamptz(6)`), primary and unique keys, plain indexes, and the composite foreign keys
  of C3 with their delete rules (generated SQL checked). Relations exist only inside the module
  file; nested reads work, nested writes are refused by the guard (P 4.1).
- Hand-written, appended to the generated `migration.sql` under a marked block as in
  `platform.md` section 6: every CHECK; the function and trigger of 3.2; the grants; and the
  partial indexes:

```sql
CREATE INDEX "outbox_market_id_event_id_unpublished_idx" ON "identity"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;
CREATE INDEX "accounts_market_id_created_at_unverified_idx" ON "identity"."accounts" ("market_id", "created_at") WHERE "email_verified_at" IS NULL;
CREATE INDEX "sessions_market_id_seller_id_live_idx" ON "identity"."sessions" ("market_id", "seller_id") WHERE "seller_id" IS NOT NULL AND "revoked_at" IS NULL;
CREATE INDEX "event_delivery_market_id_next_attempt_at_pending_idx" ON "platform"."event_delivery" ("market_id", "next_attempt_at") WHERE "status" = 'pending';
CREATE UNIQUE INDEX "seller_memberships_market_id_account_id_active_key" ON "identity"."seller_memberships" ("market_id", "account_id") WHERE "state" = 'active';
CREATE UNIQUE INDEX "roles_market_id_scope_system_key" ON "identity"."roles" ("market_id", "scope") WHERE "kind" = 'system';
CREATE UNIQUE INDEX "invitations_market_id_seller_id_email_pending_key" ON "identity"."invitations" ("market_id", "seller_id", "email_normalized") WHERE "state" = 'pending' AND "seller_id" IS NOT NULL;
CREATE UNIQUE INDEX "invitations_market_id_email_pending_platform_key" ON "identity"."invitations" ("market_id", "email_normalized") WHERE "state" = 'pending' AND "seller_id" IS NULL;
```

- **Prisma and partial indexes (measured on 7.10.0).** With the default settings the drift check
  ignores a partial index it does not know, while it reports any other undeclared index (plain,
  or `NULLS NOT DISTINCT`) as drift. So: every non-partial index is declared in the schema, and
  the eight above are invisible to Prisma, which neither creates nor checks them.

| Option | For | Against |
|---|---|---|
| A (recommended). Hand-written, with a catalog test in `pnpm test:db` that compares the partial indexes found in `pg_indexes` with a checked-in list of their definitions | No preview feature in the toolchain; the same pattern as the CHECKs and triggers | A dropped or changed partial index is caught by the test only |
| B. Turn on the `partialIndexes` preview feature and declare them with `where: raw(…)` | The drift check covers them. Measured: with the feature on, the hand-written indexes of A match their declarations with no diff, so A can become B later without a migration | A preview feature under a pinned toolchain (ADR-0014): Ali's decision. `NULLS NOT DISTINCT` cannot be declared, which is why 3.10 uses two indexes |

## 9. Volume, retention and jobs

Assumption (as `platform.md` section 4): one Market, Greater Brisbane, first year. Sizes were not
measured; at these row counts every table is far below the point where partitioning pays.

| Table | Rows expected | Growth control |
|---|---|---|
| `accounts` and their 1:1 rows | 10⁴ to 10⁵ customers, 10² to 10³ seller-side, tens of admins | Unverified accounts purged after 7 days |
| `sessions` | A few live rows per active account | Purged 30 days after the absolute expiry |
| `sign_in_records` | 10³ to 10⁴ a day, so at most about 10⁶ at 90 days | Daily-slice deletes. Revisit at 5 × 10⁷ rows: monthly range partitions on `occurred_at`, dropped whole |
| `sign_in_throttles`, `sign_in_challenges` | Hundreds, short-lived | Hourly purge |
| `one_time_links`, `invitations` | At most three per account; open invitations | Hourly purge of consumed, expired and decided rows |
| `outbox` | A few events per account plus admin actions: 10⁵ to 10⁶ a year | Kept (P 6.5); pruning or partitioning is decided at 10⁶ rows |
| `event_delivery`, `inbox` | The mail-causing events times their subscribers | The platform prune job, before the first deployed environment (P 7) |
| `subject_keys` | Accounts plus sellers plus one tombstone per purged sign-up | None in Phase 2 (11.1 A7); sign-up is rate-limited per origin |
| `seller_access`, memberships, roles, keys, assignments, `access_decisions` | 10² to 10⁴ | None needed |

| Job (PN4) | Per hosted Market, each statement with `market_id` at the top level |
|---|---|
| `identity.purge-expired`, hourly, slice 2 | Sessions past absolute expiry plus 30 days; throttle rows whose window ended a day ago and that are not blocked; sign-in records past 90 days. From slice 3: links consumed or expired for a day. From slice 7: expired challenges; pending invitations past `expires_at`; decided invitations older than 30 days |
| `identity.purge-unverified-accounts`, daily, slice 3 | Accounts of the partial index of 3.3 older than 7 days: destroy the key, delete the account; from slice 5 also its assignment, membership and the `seller_access` whose `registered_at` is NULL |

Both delete only what is already invalid and are safe to run twice and at once. Autovacuum
defaults are enough at this volume; `sessions` and `sign_in_throttles` are the update-heavy
tables to watch first. A lower fillfactor for `sessions` is not proposed without a measurement
(spike 6).

## 10. Evidence

Measured on 2026-10-03 on PostgreSQL 16.15 with Prisma 7.10.0, in a scratch copy of the
repository and in throwaway databases and roles (all dropped): a non-superuser owner, a
`NOLOGIN` group and one login member, as in platform.md 10.

| Verified | Used in |
|---|---|
| Prisma generates the composite foreign keys of C3 (`ON DELETE CASCADE` or `RESTRICT`, `ON UPDATE RESTRICT`) and the `(market_id, id)` unique index; a child in another Market is refused; a 1:1 relation needs the child's key to equal the foreign key columns | C3, C7 |
| The email CHECK and the uniqueness per Market and population, with the cases listed in 3.3 | 3.3 |
| Partial unique indexes: one active membership; one pending invitation per scope, again after a revocation | 3.9, 3.10 |
| `subject_keys`: second key refused; rewrap and destroy allowed; destroy twice changes no row; revive refused (`23001`); ungranted column `42501`; `DELETE` `42501` | 3.2, 7 |
| `outbox` under `SELECT, INSERT, UPDATE (published_at)`: claim with `FOR UPDATE SKIP LOCKED` on the partial index and mark succeed; changing `payload` and deleting fail (`42501`); a repeated aggregate version is refused | 3.1, 7 |
| A cascade from `accounts` deletes the credential although the application has no `DELETE` on the child | 7 |
| Drift check and partial indexes; the preview feature; `NULLS NOT DISTINCT` | 8.4 |
| Prisma Migrate holds the session advisory lock with key `72707369`; the two job keys of P 7 are `6283714585531761361` and `5423381668565611002` | PM8: no clash. A unit test asserts that no job key equals Prisma's |

Not measured: PostgreSQL 17 (Compose and CI); row sizes and query plans at volume (there is no
data yet: spike 6 and the first slices give `EXPLAIN (ANALYZE, BUFFERS)` output for the sign-in
and per-request reads); the throttle upsert through Prisma; anything through the real guard.

## 11. Open points

### 11.1 Decisions for Ali

| # | Decision | Recommendation |
|---|---|---|
| A1 | Column-level `UPDATE` grants (section 7) against the "Never" row of platform.md 10.2, which is still a draft in review | Amend 10.2 and its privilege test as written in section 7 |
| A2 | Erasure and the unverified purge are a hard delete of the account row, with FK-less actor references (C4), instead of a blanked tombstone row | Accept: no personal value is left to blank, and the address becomes usable again. It gives the application `DELETE` on `accounts` |
| A3 | `ANONYMOUS` in the audit actor CHECK, in slice 6 (section 6) | Accept, with the two conditions there |
| A4 | `version` only on the eight roots of C5, not on every aggregate table (P PM5, D 14.3) | Accept |
| A5 | Partial indexes hand-written with a catalog test (8.4 option A) | A now; B when the feature leaves preview |
| A6 | Origin throttle counters per Market, although I11 says "not split by Market" | Accept per Market: the generic limiter of slice 0 is the cross-Market control. The alternative is one model exempt from the guard |
| A7 | Key tombstones are kept without limit in Phase 2; pruning them is an owner-role task designed with the Market retention configuration | Accept |
| A8 | Model names prefixed `Identity` (C9); `password_credentials` as its own table | Accept |

### 11.2 Questions for Hassan

| # | Question |
|---|---|
| H1 | Plain `email`, `email_normalized`, `display_name` and custom role names (D 11.2 option A): accepted on the database side with grants and disk encryption as the protection. Confirm |
| H2 | Recovery codes: an unkeyed SHA-256 of a short code can be searched from a dump. Proposed: `SubjectKeyService.hmac` under the account's key (its first consumer, PF 4 row 4), still 32 bytes. A PHC hash would change the column to `text` |
| H3 | `sign_in_records.origin` as a plain `inet` for 90 days, with `DELETE` but no `UPDATE` for the application. Is the full address needed, or a truncated one? |
| H4 | The throttle keys need a stack-level HMAC secret, not a subject key (unknown addresses have no subject). Where it lives is Kazem's; rotating it only resets the counters |
| H5 | `DELETE` on `accounts` for the application role (A2): the cascade removes credential and sessions with it. Acceptable, or must erasure run under another role? |
| H6 | `access_decisions` and `sign_in_records` are append-only by privilege only, without the trigger that `audit_log` has. Enough? |
| H7 | `subject_keys`: column-level `UPDATE`, the one-way trigger, no `DELETE`, tombstones never pruned by the application (3.2). The wrapped-key format and its size bound |
| H8 | Revoked sessions stay as rows (token hash only) until absolute expiry plus 30 days |

### 11.3 Questions back to Mohammad (mapping choices; none changes the model)

| # | Point |
|---|---|
| M1 | No `version` on `sessions`, `sign_in_challenges`, `sign_in_throttles`, `sign_in_records`, `access_decisions`, `password_credentials`, `recovery_codes`, `role_permissions`: they change by single guarded statements or through their root. Confirm for `Session` and `SignInChallenge`, which D 2.1 lists as aggregates |
| M2 | `sessions.idle_timeout_seconds` is stored, because "keep me signed in" gives sessions of one population different idle timeouts. D 2.1 does not list it |
| M3 | `SecondFactor` needs its own id, new at every enrolment. If the account id were its aggregate id, a second enrolment would repeat `(aggregate_id, 1)` and the outbox key would refuse the event. The same holds for any aggregate that is deleted and created again |
| M4 | `seller_access.origin` and `registered_at` are my reading of "the `SellerAccess` records it" (D 8.2). Confirm |
| M5 | The 7-day purge counts from `accounts.created_at`. Does a repeated sign-up (D 3.2) restart it? |
| M6 | A revoked or idle-expired session row is deleted 30 days after its absolute expiry, not 30 days after the revocation (one purge index) |
| M7 | `expired` is not a stored invitation state. The issue use case must replace a pending row that is past its expiry, and the invited address is erased from the row at acceptance and revocation. An expired `seller-owner` invitation leaves a `seller_access` with no owner: can a new invitation name that seller id? |
| M8 | One `one_time_links` row per account and purpose, reused. Is "allow another application" (D 3.3) a decision row? If so its kind joins the CHECK of 3.11 |
| M9 | `identity.outbox` in PR 2 of slice 1, not PR 4: the relay, the model map and the catalog test need a real outbox model. D 12.1 puts it in PR 4 |
| M10 | Limits I proposed because the design has none: display name 100 characters, role name 80. Is a custom role name unique within its seller or scope? No constraint is planned |
| M11 | The throttle table supports fixed windows with a block instant (3.5). A sliding window would need rows per attempt |

### 11.4 For Kazem, and for the owner

Kazem: the format and maximum size of a wrapped key and of the wrapping-key identifier (3.2);
where the throttle secret lives (H4); `statement_timeout`, `lock_timeout` and
`idle_in_transaction_session_timeout` are role settings of the bootstrap file, not of a
migration (PK1 of P). Proposed starting values, to be confirmed in spike 6: 30 s (the largest
unit of work), 5 s and 60 s.

Owner: none. Every point above is technical; the retention of 90 days reaches the owner only if
Hassan or a legal review asks for a longer one.

## 12. Follow-up changes

This document changes no other file. After G2:

| File | Change | When |
|---|---|---|
| `docs/design/data/platform.md` | Section 1 sentence on outbox, inbox and `event_delivery`; `ANONYMOUS` in sections 2, 3.2 and 6, and Q6; a pointer to 3.2 and 3.8 here; 10.2 and 10.5 if A1 is accepted | With the G2 approval; Mojtaba |
| `prisma/schema/base.prisma`, `identity.prisma`, `platform.prisma`; the migrations of 8.1 with `down.sql` | As specified; each needs my sign-off | Per slice; Hossein |
| The privilege map and the catalog tests of `pnpm test:db` | Section 7; the partial-index list of 8.4; "every outbox has the same columns" (P 13) | With each migration; Hossein |
| `docs/design/domain/identity.md`, `platform-persistence-and-events.md` | Answers to 11.3; PM1 key order; PM8 confirmed | Inside G2; Mohammad |
