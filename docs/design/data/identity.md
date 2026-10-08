# Physical data model — `identity` schema and its platform tables (G2)

**Author:** Mojtaba (database-designer) — 2026-10-03
**Status:** Approved at G2, 2026-10-03 (Ali, Hassan). Each migration still needs Mojtaba's sign-off; open: 11.4.
Reviews applied: Ali (cto) on A1 to A8; Hassan (security-tester) on H1 to H8 and his findings
that touch tables (cited as HF1 to HF15, as in D 14.2); Mohammad's answers to M1 to M11 (D 14.3).
Section 11 records each decision; only 11.4 is open.
**Ground truth:** `docs/design/domain/identity.md` (cited as **D**, for example "D 6.3");
`docs/design/domain/platform-persistence-and-events.md` (**P**; inputs PM1 to PM8);
`docs/design/domain/platform-foundations.md` (**PF**; sections 3.1 to 3.3 and 4);
`docs/modules/identity/brief.md` (sections 5, 6, 9, 10; rules R1 to R12; "AC 19"); ADR-0003,
ADR-0004 (decisions 3 to 7), ADR-0006, ADR-0009 (decisions 2, 6, 7), ADR-0015, ADR-0018; ADR-0023
(platform amendments, reserved on the board); `docs/design/data/platform.md` and its section 10
(role and grant note, approved 2026-10-03, on branch `docs/db-role-grant-note` as of ebe3ec6,
cited as "platform.md 10").
**Prisma models:** `prisma/schema/identity.prisma` (new) and two models in `platform.prisma`.
Nothing here exists yet; this document is the specification the migrations are written from.

## 1. Scope and table list

The physical design of everything D and P ask the database to hold in Phase 2, slice by slice,
with constraints, access paths, grants and the migration plan. It does not change the domain
model: where a mapping needed a choice, Mohammad answered it (D 14.3; recorded in 11.3).

ADR-0009 pattern: **none of V1, V2 or V3 is used.** `identity` has no revisioned content and no
effective-dated record (PF 3.8, decision A1), and it snapshots nothing. History that must be kept
is V4: the platform audit log, plus two append-only tables of this schema.

| Table | Holds (D 2.1) | ADR-0009 pattern | Created in |
|---|---|---|---|
| `identity.outbox` | Events of the module (ADR-0006 decision 2) | None: a queue whose rows never change except `published_at` | Slice 1b (M9) |
| `platform.subject_keys` | One wrapped data key per subject (PF 4) | None: live row that becomes a tombstone | Slice 1c |
| `identity.accounts` | `Account` | None: live record; its changes are audited (V4 in `platform.audit_log`) | Slice 1d |
| `identity.password_credentials` | `PasswordCredential` | None: only the current hash, by design | Slice 1d |
| `identity.sessions` | `Session` | None | Slice 2 |
| `identity.sign_in_throttles` | Throttle counters (D 6.8), the factor lock of HF2 included | None: transient counters | Slice 2 |
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
| `identity.invitations` | `Invitation` | None | Slice 7 (first admin); used by 8b, 9 and 11 |
| `identity.access_decisions` | `AccessDecision` | V4 append-only | Slice 9 |
| `platform.audit_log` (changed) | The `ANONYMOUS` actor type (section 6) | V4, existing | Slice 6 |

Every table is Market-scoped: all of them carry `market_id` and `tenant_id`, the two platform
tables included, so the guard of P 4 needs no exemption line in Phase 2. Slices 1a, 4, 8a, 8b,
10, 11 and 12 create no table (slice 6 changes one CHECK, section 6).

## 2. Conventions used by every table

| # | Convention |
|---|---|
| C1 | `market_id varchar(8) NOT NULL` and `tenant_id text NOT NULL`, no default (PF 3.3), each with a CHECK that mirrors the kernel pattern: `<table>_market_id_check CHECK (market_id ~ '^[A-Z][A-Z0-9_]{1,7}$')`, `<table>_tenant_id_check CHECK (tenant_id ~ '^[a-z][a-z0-9-]{1,31}$')`. Not repeated in the column tables below. `tenant_id` is in no key and no index |
| C2 | Ids are `uuid` (UUIDv7 from the application); instants are `timestamptz(6)` taken from `Clock`. No column default, no `now()`, no sequence, no enum type. Kinds and states are `text` with a CHECK |
| C3 | **A child cannot live in another Market than its parent (PM6, adopted).** Every parent has a unique index `(market_id, id)`, and every foreign key is `(market_id, <parent>_id)` → `(market_id, id)` with `ON UPDATE RESTRICT`. Cost: one extra unique index per parent. Measured: a child row with the other Market is refused; Prisma generates exactly this from a composite `@relation` |
| C4 | **Foreign keys stay inside the schema** (ADR-0004 decision 3). Three kinds of reference are plain ids with no foreign key even inside it: "who did it" columns (`*_by_account_id`), because history must outlive the actor's row, as `audit_log.actor_id` does; ids owned elsewhere (`basis_id`); and `invitations.role_id`, which may dangle by design (R12) |
| C5 | `version integer NOT NULL`, CHECK `>= 1`, insert writes 1 (PM5, P 10), on the roots that are loaded, changed and saved: `accounts`, `seller_access`, `seller_memberships`, `roles`, `role_assignments`, `one_time_links`, `invitations`, `second_factors`. **Not** on tables changed only by single guarded statements (A4, M1; D 2.1). A guarded statement on a versioned root (the TOTP step, 3.10) raises the version too, as P 10 asks of every change |
| C6 | Token hashes are `bytea` with CHECK `octet_length = 32` (SHA-256, D 6.2), unique per Market, looked up by equality only. Keyed hashes (throttle keys, recovery codes) have the same type and CHECK |
| C7 | Indexes lead with `market_id` (ADR-0004 decision 4). Primary keys on a single `uuid` stay as they are; a table that is 1:1 with its parent uses the primary key `(market_id, <parent>_id)`, which Prisma accepts as the 1:1 relation key with no extra index |
| C8 | Deleting a parent: `ON DELETE CASCADE` only for rows that have no meaning without it (credential, sessions, challenges, links, second factor, recovery codes, role keys); `ON DELETE RESTRICT` everywhere else, so those rows are removed by a use case, never by accident |
| C9 | Prisma model names start with `Identity` (`IdentityAccount`, `IdentityOutbox`): PM7 extended to every model, since model names are global; tables are mapped with `@@map` |
| C10 | **No raw SQL.** The guard refuses it inside a unit and identity has no raw helper in Phase 2 (P 4.2). Every guarded statement here is a Prisma `updateMany` (the condition in `where`; one row changed or none), `upsert` or `deleteMany`, with `market_id` at the top level of `where`; an `upsert` on a compound key (`marketId_kind_keyHash`) states `marketId` at the top level as well (spike 6: the guard of P 4.1 refuses the compound selector alone; Prisma still sends one native `INSERT … ON CONFLICT`) |
| C11 | **Isolation.** READ COMMITTED, except every unit that writes `role_assignments`, `seller_memberships.state` or `accounts.status`, inserts and deletes included: those run `serializable` (HF8; D 5.5; P 3.1 row 6). Consequences in 5.1 |

## 3. Tables

Columns of C1 are omitted. "Personal" marks personal data (ADR-0018 decision 6: declared from the
first migration). A named query says which design section runs it.

### 3.1 `identity.outbox` (slice 1b; PM1, PM2)

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

### 3.2 `platform.subject_keys` (slice 1c; PF 4)

| Column | Type | Null | Notes |
|---|---|---|---|
| `subject_id` | `uuid` | no | PK. An account id or a seller id (D 11.3). The table does not record which: the port takes an `Id`, and ids never repeat across kinds. The key on the subject alone is what refuses a second key for life (PF 4 row 5) |
| `key_version` | `integer` | no | CHECK `>= 1`; always 1 in Phase 2. Part of the wrap binding (PF 4 row 10) |
| `wrapped_key` | `text` | yes | The wrapped data key as a versioned text envelope; NULL once destroyed. CHECK `char_length <= 1024` until Kazem fixes the format (11.4) |
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
- No DELETE for the application, so every abandoned sign-up leaves a tombstone, kept without
  limit in Phase 2 (A7; revisited before the first deployed environment). H7: accepted as designed.
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

### 3.3 `identity.accounts` and `identity.password_credentials` (slice 1d)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK. Also the subject id of the account's key |
| `population` | `text` | no | CHECK `customer`, `seller`, `admin`. Never changes (domain) |
| `email` | `text` | no | **Personal, plain** (D 11.2 option A). As typed, trimmed. CHECK length 3 to 254 |
| `email_normalized` | `text` | no | **Personal, plain.** Trimmed, NFC, lower-cased by the application; the uniqueness and lookup value |
| `display_name` | `text` | yes | **Personal, plain.** NULL only for a customer (`accounts_display_name_required_check`, N1 in 11.5): customer sign-up asks for email and password only (brief flow «د» item 1, `ux.md` A2). When present, the CHECK below: 1 to 100 characters, no outer spaces, no control or bidi formatting character (M10, HF13). URL-like text is refused by the domain only |
| `status` | `text` | no | CHECK `active`, `disabled` (D 3.1) |
| `email_verified_at` | `timestamptz(6)` | yes | NULL = unverified (D 3.2) |
| `existing_account_notice_at` | `timestamptz(6)` | yes | Last "you already have an account" mail (D 6.7) |
| `signed_up_at` | `timestamptz(6)` | no | The latest sign-up: written at creation by every path, replaced by a repeated sign-up (D 3.2). The anchor of the 7-day purge (M5). CHECK `>= created_at` |
| `version` | `integer` | no | C5 |
| `created_at` | `timestamptz(6)` | no | |

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
CONSTRAINT "accounts_display_name_check" CHECK (
  char_length("display_name") BETWEEN 1 AND 100
  AND "display_name" = btrim("display_name")
  AND "display_name" !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]')
CONSTRAINT "accounts_display_name_required_check" CHECK (
  "population" = 'customer' OR "display_name" IS NOT NULL)
```

`accounts_display_name_check` is unchanged: a CHECK whose expression is NULL passes, so it
applies only to a name that is present, for every population. The second CHECK carries the
rule "a seller-side or admin account always has a display name" (D 2.1), at insert and at
update. A violation is a bug of the caller, never a user's mistake the API lets through: the
repository maps its name to `validation.failed`, never a 500 (N1).

The class is the C0 and C1 controls and the bidi marks, embeddings, overrides and isolates
(measured: tab, newline, DEL, NEL, U+202E, U+2066, U+200F, U+061C refused; Arabic script, accents
and U+200D accepted). `roles.name` has the same CHECK with 80 (3.9).

- `identity.purge-unverified-accounts` (D 3.1, daily): `WHERE market_id = $1 AND
  email_verified_at IS NULL AND signed_up_at < $2`, served by the partial index `(market_id,
  signed_up_at) WHERE email_verified_at IS NULL`, which holds only the unverified rows.
- **Erasure and the purge are a hard delete** (A2, under H5). The use case destroys the subject
  key, then deletes the account; C8 removes its credential, sessions, challenges, links and second
  factor. A membership, an assignment and a `seller_access` are removed first by the same use case
  (RESTRICT). The address becomes free again. What remains elsewhere is the account id as an
  opaque value (C4) and a key tombstone. In Phase 2 only the purge job deletes accounts, one
  `serializable` unit per account (C11), so a conflict retries one account, never a batch.
- First-admin routine (D 7.4): "the Market already has an admin account" is a probe of the unique
  `(market_id, population, email_normalized)` on its first two columns.

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
| `seller_id` | `uuid` | yes | Copy of the membership's seller, for revocation by seller (D 3.3, 3.5). CHECK `(population = 'seller') = (seller_id IS NOT NULL)`. FK to `seller_access` added in slice 5 |
| `token_hash` | `bytea` | no | C6. The token itself is never stored (ADR-0018 decision 2). Replaced in place when the current session is rotated at a password change or a factor activation (D 6.2); a sign-in always inserts a new row |
| `transport` | `text` | no | CHECK `cookie`, `bearer` (D 6.2) |
| `created_at`, `last_seen_at` | `timestamptz(6)` | no | `last_seen_at` is written at most once a minute and is in no index, so the update can stay on the heap page |
| `idle_timeout_seconds` | `integer` | no | CHECK `> 0`. Fixed at creation from the population's policy: admin 30 minutes, seller 12 hours, seller with "keep me signed in" and customer 14 days (D 6.1; M2) |
| `absolute_expires_at` | `timestamptz(6)` | no | CHECK `> created_at`. Admin 12 hours, seller 24 hours, 30 days with "keep me signed in" and for customers. No upper bound in a CHECK: policy values (5) |
| `revoked_at` | `timestamptz(6)` | yes | |
| `revoked_reason` | `text` | yes | A code (`sign-out`, `password-changed`, `seller-suspended`, …). CHECK code pattern; CHECK `(revoked_at IS NULL) = (revoked_reason IS NULL)` |

| Query | Index |
|---|---|
| Per-request read of the `Authenticator` (D 6.2): `WHERE market_id = $1 AND token_hash = $2`, then account, membership and seller access by key | Unique `(market_id, token_hash)`; the three follow-up reads use `accounts_pkey`, the active-membership index of 3.9 and `seller_access_pkey` |
| Revoke every session of an account (password reset, disable, second-factor reset, removal); at a password change or a factor activation every other one, and the current one is rotated | `(market_id, account_id)`; the rotation by primary key |
| Revoke every session of a seller (reject, suspend: D 3.3); the foreign-key check when a `seller_access` row is deleted | Partial `(market_id, seller_id) WHERE seller_id IS NOT NULL`. Not `AND revoked_at IS NULL`: the check PostgreSQL runs for the foreign key (`market_id = $1 AND seller_id = $2`) cannot prove that predicate and would scan the table. Customer sessions stay out of the index, and a revocation no longer changes a column of an index predicate, so it can be a HOT update |
| `identity.purge-expired`: `absolute_expires_at < now − 30 days` | `(market_id, absolute_expires_at)` |

No `version` (C5; M1): revocation is a set-based `UPDATE … WHERE revoked_at IS NULL`, and it must
not lose against the once-a-minute `last_seen_at` write. Expiry is decided at read time from `Clock`
(`last_seen_at`, `idle_timeout_seconds`, `absolute_expires_at`), never by the job. A revoked row
leaves when its absolute lifetime plus 30 days has passed (M6; H8). A rotation changes an indexed
column, so it is not a HOT update; it is rare. The re-confirmation instant of D 8.5 is a nullable
column added by that mini-review, not now.

### 3.5 `identity.sign_in_throttles` (slice 2; D 6.8)

| Column | Type | Null | Notes |
|---|---|---|---|
| `kind` | `text` | no | Closed CHECK list, the counters of D 6.8: `sign-in.account-origin`, `sign-in.account`, `sign-in.origin` (HF3), `second-factor.account` (HF2), `mail.account`, `mail.origin`. A new kind is a migration |
| `key_hash` | `bytea` | no | HMAC-SHA-256 under the throttle secret of what the kind counts: Market, population, normalised email, the account id for `second-factor.account`, the origin. The origin is the IPv4 address or the IPv6 /64 (HF3), cut by the application before hashing. CHECK `octet_length = 32`. PK `(market_id, kind, key_hash)` |
| `account_key` | `bytea` | yes | The keyed hash of (Market, population, normalised email) alone. CHECK `(account_key IS NULL) = (kind IN ('sign-in.origin', 'mail.origin'))` and length 32: every counter of an address carries it, so a password reset clears them all, the HF2 lock included (AC 13; D 3.7) |
| `window_started_at` | `timestamptz(6)` | no | Fixed windows with a block instant (M11) |
| `attempts` | `integer` | no | CHECK `>= 0`. Reserved and failed attempts in the window |
| `blocked_until` | `timestamptz(6)` | yes | Set by a failure that reaches the threshold |

- No address and no email is stored, only keyed hashes, also for unknown addresses. The secret:
  32 random bytes, required at boot, never logged (H4); rotating it only resets the counters.
- **Reserve before verifying (HF1).** The reservation unit (P 3.1 row 5; D 6.3 step 2) takes
  every counter that applies in a fixed order (kind, then key), so two units never wait on each
  other in a cycle. Per counter, two statements (C10): (1) `updateMany` where the key matches and
  `window_started_at <= $now − window`, setting `attempts = 0` and `window_started_at = $now` (an
  ended window restarts; `blocked_until` stays); (2) `upsert` on the primary key, creating with
  `attempts = 1`, otherwise `attempts: { increment: 1 }`; the returned row is the reservation. A
  returned `attempts` above the threshold, or a `blocked_until` after `$now`, refuses the attempt
  without hashing; the refused attempt keeps its count. The closing unit then, per counter, where
  the key matches and `window_started_at` equals the reserved one: on success `attempts:
  { decrement: 1 }` with `attempts > 0`; on a failure that reached the threshold, `blocked_until =
  $now + block`. A window restarted in between is left alone.
- Measured under READ COMMITTED: 20 concurrent reservation units on one key returned 1 to 20, each
  once, from an empty table and from an ended window (one restart); a release in another window
  changed no row. Spike 6 (2026-10-07) measured that Prisma 7.10 sends the `upsert` as one `INSERT … ON CONFLICT DO UPDATE … RETURNING` (its native upsert), also with `marketId` at the top level next to the compound key (C10): 20 concurrent units allowed exactly five, from an empty table, from an ended window and with three counters, in both Markets. No repeat on `P2002` is needed.
- Clearing at a reset: `deleteMany` by `(market_id, account_key)`, on the index `(market_id,
  account_key)`. A deadlock with a reservation of the same address is retried (`40P01`, P 3.1
  row 7).
- Purge: rows whose window started more than 48 hours ago and that are not blocked (the longest
  window and the longest block are 24 hours). No index (9).
- Every counter is kept per Market, origin counters included (A6; D 6.8 now says so). Challenge
  attempts are counted on the challenge (3.10). An unreachable table refuses the attempt (D 6.8).

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
  (section 7; H6). No trigger and no hash chain: unlike `audit_log` it has a retention, and the
  tamper-evident record of an admin's successful sign-in is its audit row (D 10.2).
- **Retention: 90 days, with the full address** (H3). `identity.purge-expired` deletes `WHERE
  market_id = $1 AND occurred_at < $now − 90 days`, one day of `occurred_at` per statement, on the
  index `(market_id, occurred_at)`. Safe to run twice and concurrently.
- Not added: `(market_id, account_id, occurred_at)`. No screen reads the records in Phase 2 (D
  5.3); it arrives with that screen or with erasure, whichever is first.
- Volume: attacker-driven but bounded by the throttles; section 9.

### 3.7 `identity.one_time_links` (slice 3; D 3.7, 6.6)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; the `linkId` of the event |
| `account_id` | `uuid` | no | FK to `accounts`, cascade |
| `purpose` | `text` | no | CHECK `verify-email`, `reset-password`, `enrol-second-factor` (HF6, D 3.6; used from slice 7), `confirm-second-factor-reset` (D 7.3; used from slice 12). All four are in the CHECK from slice 3, so no later slice alters it |
| `requested_at` | `timestamptz(6)` | no | |
| `token_hash` | `bytea` | yes | C6. NULL while `requested`: the mail handler stores it after the send |
| `issued_at`, `expires_at` | `timestamptz(6)` | yes | Set together with the hash; `expires_at` is `issued_at` plus the lifetime, computed by the application: reset and enrolment 60 minutes (SEL-05, HF6), verification and the owner's reset confirmation 24 hours (HF15) |
| `consumed_at` | `timestamptz(6)` | yes | |
| `version` | `integer` | no | C5 |

- **Unique `(market_id, account_id, purpose)`**: one row per account and purpose (M8, confirmed).
  A new request reuses the row (hash, instants and `consumed_at` reset, version raised), which is
  what "the hash is replaced" means (D 3.7): the database then guarantees "at most one usable
  link" (AC 19) with a plain unique key. It also answers "reset awaiting the owner" on the sellers
  list (D 8.6 row 8).
- Unique `(market_id, token_hash)`: the lookup when a token is presented. NULLs do not collide.
- CHECKs: `(token_hash IS NULL) = (issued_at IS NULL)`, `(issued_at IS NULL) = (expires_at IS
  NULL)`, `expires_at > issued_at`, `consumed_at IS NULL OR issued_at IS NOT NULL`.
- Single use is one conditional statement, `UPDATE … SET consumed_at = $now WHERE id = $1 AND
  market_id = $2 AND consumed_at IS NULL AND expires_at > $now`: one row changed or none. Email
  confirmation consumes it only when the password is correct (D 3.2), in the closing unit.
- The purge needs no index: at most four rows per account.

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
| `registered_at` | `timestamptz(6)` | yes | When `identity.seller-registered.v1` was recorded (M4, confirmed). NULL means the 7-day purge may still delete the row |
| `version`, `created_at` | | no | C5 |

Admin list of sellers by state (D 8.6 row 8): `(market_id, state, state_changed_at)`.

**`identity.seller_memberships`**: `id` PK; `account_id` FK to `accounts`, RESTRICT; `seller_id`
FK to `seller_access`, RESTRICT; `state` CHECK `active`, `removed`; `removed_at` with CHECK
`(state = 'removed') = (removed_at IS NOT NULL)`; `version`; `created_at`.
- **Partial unique `(market_id, account_id) WHERE state = 'active'`**: one active membership per
  account, the Phase 2 rule of ADR-0018 decision 3, and the `Authenticator`'s read. Removed rows
  stay, and a removed member who joins another team gets a new row. Lifting the rule later is
  dropping this one index. Measured.
- Plain `(market_id, account_id)`, `seller_memberships_market_id_account_id_idx`, declared in
  Prisma. The foreign-key check PostgreSQL runs when an account is deleted (purge, erasure) has no
  `state` condition and cannot use the partial index. Without this index it reads every membership
  of the Market, and in a `serializable` unit (C11) it predicate-locks all of them. The index also
  keeps the `Authenticator`'s membership read an index probe under a generic plan (8.4). Cost: one
  index on a table of 10² to 10⁴ rows.
- Team list, member count, holders of a seller: `(market_id, seller_id, state)`, with `market_id` in
  the predicate of every relation the read touches (spike 6 found a statement without it). The same index
  answers HF5 (a), "this seller never had a member": an `EXISTS` on `(market_id, seller_id)` in
  any state. Removed rows stay, so a seller that once had a member always answers yes.

**`identity.roles`**

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; unique `(market_id, id)` |
| `scope` | `text` | no | CHECK `platform`, `seller` (R2) |
| `kind` | `text` | no | CHECK `system`, `default`, `custom` |
| `seed_code`, `seed_version` | `text`, `integer` | yes | Set if and only if the kind is not `custom` (two CHECKs). `seed_code` CHECK `^[a-z][a-z0-9-]*$`; `seed_version` CHECK `>= 1` |
| `name` | `text` | yes | **Personal (free text), plain.** Set if and only if `custom`; the CHECK of `accounts.display_name` with 1 to 80 (M10, HF13). Never in an audit row, an event or a log (R5) |
| `name_normalized` | `text` | yes | **Personal.** Trimmed, NFC and lower-cased by the application; set if and only if `name` is. CHECK `roles_name_normalized_check`: the lower-case, trim and NFC conditions of `accounts_email_normalized_check`, and 1 to 80 characters |
| `seller_id` | `uuid` | yes | FK to `seller_access`, RESTRICT. CHECK `(scope = 'seller' AND kind = 'custom') = (seller_id IS NOT NULL)` (R9) |
| `version`, `created_at` | | no | C5 |

- Unique `(market_id, scope, seed_code)`: the seed routine's key, and what makes two workers
  seeding at once safe (the loser gets the constraint error and reads the row).
- Partial unique `(market_id, scope) WHERE kind = 'system'`: at most one system role per scope
  and Market. This is all the database carries of R3.
- **A custom role's name is unique within its seller, or within its Market's platform scope**
  (M10): two partial unique indexes, as for invitations, `(market_id, seller_id, name_normalized)
  WHERE kind = 'custom' AND seller_id IS NOT NULL` and `(market_id, name_normalized) WHERE kind =
  'custom' AND scope = 'platform'`. The repository maps both names to `role.name-taken` (D 8.6).
  Measured: the same name in one seller and twice in the platform scope refused; another seller,
  the platform scope and another Market accepted; a value that is not lower-cased refused.
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
- `(market_id, role_id)`: holders of a role (`LastHolderPolicy`, `role.in-use`, and HF5 (b): an
  active Platform Administrator exists), each followed by `accounts_pkey`; for a seller, the
  active members on `(market_id, seller_id, state)`, then this table on `(market_id, account_id)`.
- One Seller Owner per seller (HF5 (c)) is not a constraint: the seller system role is one row per
  Market, and an assignment carries no seller id (5).

### 3.10 Second factor, challenge, invitation (slice 7)

**`identity.second_factors`**: `id` PK, new for every enrolment (M3); `account_id` FK to
`accounts`, cascade, unique `(market_id, account_id)`; `state` CHECK `pending`, `active` (`none`
is no row); `secret_ciphertext text NOT NULL`, encrypted with the account's subject key (label
`identity.second-factor.secret`, D 7.5); `pending_secret_ciphertext text` nullable, a
replacement device's secret under the same key and label, kept until its first valid code swaps
it in while the old secret stays active (M13); `last_accepted_step integer` nullable, CHECK `>= 0`
(30-second steps fit 32 bits far beyond any horizon); `activated_at` with CHECK `(state =
'active') = (activated_at IS NOT NULL)`; `locked_at timestamptz(6)` nullable, the instant of the
last HF2 lock, written through the root so that its event sends the alert (the lock itself is the
`second-factor.account` counter, 3.5); `created_at`; `version`.
- An admin's factor is created `active` in the unit that accepts its invitation, once a valid
  code arrives; nothing is stored before that (D 3.4, HF6). Every other enrolment, a seller's first
  optional one included, starts from an `enrol-second-factor` link (3.7; decided by Hassan
  2026-10-03).
- **A time step is accepted once** (D 7.1): `updateMany` where `id`, `market_id`, `state =
  'active'` and `last_accepted_step IS NULL OR last_accepted_step < $step`, setting the step and
  raising `version` (C5). One row or none, so a code works once under concurrency, and a save of
  the root loaded earlier fails as stale instead of writing an older step back.

**`identity.recovery_codes`**: primary key `(market_id, second_factor_id, position)` with CHECK
`position BETWEEN 1 AND 10`, so "at most ten" is a constraint; FK to `second_factors`, cascade;
`code_hash bytea` (C6): `SubjectKeyService.hmac` under the account's key (H2) of a code of 10
Crockford base32 characters (D 7.3); `used_at` nullable. A typed code is hashed and compared
with the factor's rows by the primary key range; use is `updateMany` on that hash and `used_at IS
NULL`, with the root's version raised (P 10). Regeneration replaces the ten rows. Destroying the
account's key leaves the hashes unverifiable, as erasure intends.

**`identity.sign_in_challenges`**: `id` PK; `account_id` FK, cascade; `purpose` CHECK
`second-factor`, `second-factor-enrolment`; `token_hash` (C6), unique `(market_id, token_hash)`;
`attempts smallint` CHECK `>= 0` (the limit of five is policy); `credential_changed_at
timestamptz(6) NOT NULL`, the credential's `changed_at` at issue, which the closing unit compares
(HF11); `expires_at`; `consumed_at` nullable; `created_at`. Rows live minutes; no `version` (M1).
- **The attempt is reserved before the code is checked** (HF1): `updateMany` where `id`,
  `market_id`, `attempts < 5`, `consumed_at IS NULL` and `expires_at > $now`, with `attempts:
  { increment: 1 }`; no row changed means the challenge has ended. A failed code also counts on
  `second-factor.account` (HF2, 3.5), reserved in the same unit.
- **Voided** (HF11) when the password or the factor changes, the account is disabled or the
  seller suspended: the use case deletes the open challenges of the account, or of the seller's
  active members, in the unit of that change, on the index `(market_id, account_id)`, which also
  serves the cascade from `accounts`.

**`identity.invitations`**

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `kind` | `text` | no | CHECK `seller-owner`, `staff`, `admin` |
| `email`, `email_normalized` | `text` | yes | **Personal, plain**, present only while `pending`: CHECK `(state = 'pending') = (email_normalized IS NOT NULL)`, the same for `email`, and the email CHECK of 3.3. Acceptance and revocation set both to NULL |
| `display_name` | `text` | yes | **Personal, plain.** Only on a `seller-owner` invitation issued by an admin (D 3.4: the shop owner keeps the name entered in D6); CHECK `display_name IS NULL OR (kind = 'seller-owner' AND state = 'pending')`, the name rules of `accounts.display_name` (3.3); acceptance copies it to the account and sets it to NULL, revocation sets it to NULL |
| `role_id` | `uuid` | no | Plain id (C4): the role may be deleted while the invitation is pending, and acceptance then refuses (R12) |
| `seller_id` | `uuid` | yes | FK to `seller_access`, RESTRICT. CHECK `(kind = 'admin') = (seller_id IS NULL)` |
| `invited_by_account_id` | `uuid` | yes | C4; NULL for the first-admin routine, whose acceptance is refused once the Market has an active Platform Administrator (HF5 (b), 3.9) |
| `token_hash`, `expires_at` | `bytea`, `timestamptz(6)` | yes | Set together at dispatch (CHECK); a re-send replaces both. Lifetime 7 days, `admin` 72 hours (HF15) |
| `state` | `text` | no | CHECK `pending`, `accepted`, `revoked`. `expired` is not stored: it is `pending` past `expires_at`, decided at read time |
| `decided_at`, `accepted_account_id` | `timestamptz(6)`, `uuid` | yes | CHECK `(state = 'pending') = (decided_at IS NULL)`; CHECK `(state = 'accepted') = (accepted_account_id IS NOT NULL)` |
| `version`, `created_at` | | no | C5 |

- **One pending invitation per Market, scope and address** (D 3.4) is two partial unique
  indexes, because the platform scope has no seller: `(market_id, seller_id, email_normalized)
  WHERE state = 'pending' AND seller_id IS NOT NULL` and `(market_id, email_normalized) WHERE
  state = 'pending' AND seller_id IS NULL`. Measured, including a new invitation after a
  revocation. They also serve the lists of open invitations.
- **One pending `seller-owner` invitation per seller** (HF5 (a); brief s3): partial unique
  `(market_id, seller_id) WHERE kind = 'seller-owner' AND state = 'pending'`. Without it, two
  owner invitations to two addresses for one new seller both pass the issue guard and both can be
  accepted. Measured: the second refused; a new one after a revocation accepted (11.4 M12).
- Unique `(market_id, token_hash)` for acceptance and the preview (D 8.6 row 5).
- An expired pending row still holds its keys until the hourly job deletes it, so the issue use
  case replaces such a row in its own unit (M7, confirmed). A new `seller-owner` invitation may
  name a seller that never had a member (3.9).
- Acceptance writes `accounts`, `seller_memberships` and `role_assignments`, so it runs
  `serializable` (C11): two concurrent first-admin acceptances cannot both see "no administrator".

### 3.11 `identity.access_decisions` (slice 9)

`id` PK; `seller_id` FK to `seller_access`, RESTRICT; `decision` CHECK `approved`, `rejected`,
`suspended`, `reinstated`; `reason_ciphertext text` nullable, encrypted with the **seller's**
subject key (D 11.3); `basis_id uuid` nullable (C4; the submission id of `sellers`, D 8.4);
`decided_by_account_id` (C4; NULL for the system actor); `decided_at`.
- CHECK `(decision IN ('rejected', 'suspended')) = (reason_ciphertext IS NOT NULL)`: decision 9
  of the brief as far as a constraint can carry it. "Non-empty" is the domain's.
- Append-only by privilege: `INSERT` and `SELECT` only (H6). The tamper-evident trace is the audit
  row, which holds the decision id (D 10.1). Destroying the seller's key makes every reason
  unreadable while the rows stay. No other decision kind: "allow another application" is not in
  Phase 2 (M8).
- Status page and admin screens (latest decision of a seller): `(market_id, seller_id,
  decided_at)`.

## 4. What is never stored

| Never in the database | Instead |
|---|---|
| A session token, a link, invitation or challenge token, the CSRF token | The SHA-256 hash (C6); the CSRF token is derived per request (D 6.4) |
| A password, or anything derived from it but the PHC string | `password_credentials.password_hash` |
| A second-factor secret or a recovery code in clear | Ciphertext under the subject key; keyed hashes (`SubjectKeyService.hmac`, H2) |
| An unwrapped data key, or the wrapping key | `subject_keys.wrapped_key` only (PF 4 row 1) |
| The email typed at a failed sign-in for an unknown address | A keyed hash in `sign_in_throttles`; `sign_in_records.account_id` is NULL |
| A client address anywhere but `sign_in_records.origin` (full address, 90 days: H3) | Keyed hashes in throttle keys (the IPv4 address or the IPv6 /64, HF3). No address on sessions, links, invitations or audit rows; no user agent and no device label anywhere |
| The throttle secret | Stack configuration: 32 random bytes, required at boot, never logged (H4) |
| Roles, permission keys or seller state on a session | Read on every request (R4) |
| The reject or suspend reason in clear, or outside `access_decisions` | Ciphertext; the decision id in audit rows and events |
| Personal data in `outbox`, `event_delivery`, `inbox` | Ids, codes and permission keys (P 5.3) |
| An invited address after the invitation was accepted or revoked | NULL by CHECK (3.10) |

## 5. Invariants the database does not carry

| Invariant | Why not a constraint | Enforced by |
|---|---|---|
| The last Seller Owner of a seller, and the last full-access admin of a Market, cannot be removed, demoted or disabled (R3) | It counts rows of three tables | `LastHolderPolicy` in a `serializable` unit of work (D 5.5), every writer it counts serializable too (C11, 5.1) |
| A role's scope matches the account's population; a customer never has an assignment or a membership; a seller role is assigned only inside its seller (R2, R9) | Cross-table | `RoleAssignment` invariant, `GrantPolicy` |
| System roles hold no stored keys; system and default roles are read-only; default roles change only by seed (R3, R10) | The table cannot tell who writes | `Role` invariant; the seed routine |
| A stored key is of the role's scope and known to the registry (R2, R7) | The catalogue is code | `Role` invariant; unknown keys are dropped at resolution |
| R1 and R11 (nobody grants what they lack; protected keys) | Depends on the actor | `GrantPolicy` |
| In Phase 2 a seller has one Seller Owner: the seller system role is founded, never granted (brief s3; HF5 (c)) | The role is one row per Market; an assignment carries no seller id | `GrantPolicy`; the founding guards (D 5.5) |
| A `seller-owner` invitation names a new seller or one that never had a member; an `admin` invitation with no inviter is refused once an active Platform Administrator exists (HF5 (a), (b)) | Cross-table | Issue and acceptance guards (D 3.4), acceptance serializable; the database adds one pending owner invitation per seller (3.10) |
| Which state follows which (every state machine of D 3) | CHECKs here carry the value sets and the columns each state needs, never the transitions | The aggregates |
| Lifetimes, expiry, thresholds and limits (sessions per population, links, invitations, five challenge attempts, the throttle thresholds, three re-applications, 20 roles, 50 members) | Policy values, and time comes from `Clock` | Use cases, at read time |
| Exactly one credential per account; an admin session only after a second-factor proof; no challenge survives a password or factor change, a disable or a suspension (HF11) | "At least one" needs a deferred constraint; the others are behaviour | The `Account` aggregate; the sign-in use case; those use cases delete open challenges, and the closing unit compares `credential_changed_at` (3.10) |
| The copies on `sessions` (`population`, `seller_id`) equal the account and its membership | Would need wider keys on the parents | Session creation; population never changes |
| An account, a row's Market or a seller reference never changes | No trigger for it | The guard refuses any write of `market_id` (P 4.1); repositories |
| `invitations.role_id` points at an existing role; the inviter may still grant it | Dangling by design (R12) | Acceptance guards (D 3.4) |
| A `seller_id` is known to `sellers`; a `basis_id` is a submission | No cross-module foreign key | Events and the facade (D 8.3) |
| Non-ASCII case folding of emails and role names; URL-like text in names (HF13); non-empty reason text; no personal data in a payload | Not expressible | Application normalisation; the domain; `defineEvent` (P 5.3) |

### 5.1 Serializable writers (HF8)

PostgreSQL's serializable isolation takes predicate locks on the index pages a statement reads,
and on the whole table after a sequential scan, which the planner prefers while these tables are
small. Two unrelated units, two sign-ups whose addresses share an index page for example, can
then fail with `40001`, and the UnitOfWork runs the work again, three attempts in all (P 3.1 row
7). Therefore: the queries of these units are written for the indexes of section 3, with `market_id` in every relation's predicate; the purge takes one account per unit (3.3); the test of P 13 asserts each writer's isolation. Measured in spike 6 (2026-10-07; 20 concurrent units per wave, three attempts): the last-holder invariant held in every round, while READ COMMITTED broke it in 30 of 30. Unrelated writers conflicted on 2.4 % of attempts with 2 × 10⁴ memberships and on 16 % on a near-empty table. There the planner reads a seller's team through the partial unique index of 3.9 on `market_id` alone, so the predicate lock covers the Market's whole active membership. Five admins disabling each other at once exhausted three attempts in 1 to 5 of 100 units. Decision (Mojtaba): no larger retry budget and no query shaped against the planner. An exhausted unit is `TransactionConflictError`, answered 409 `conflict.retry` with nothing committed, and a P 13 test proves it for both error shapes. The small-table rate falls as the tables grow; it is revisited only if `conflict.retry` appears in production logs. The reservation unit and the
sign-in's closing unit write none of the three tables and stay READ COMMITTED.

## 6. `platform.audit_log`: the `ANONYMOUS` actor type

Decided (A3): **yes**, with both conditions below, before the writer's first row; it closes that
part of Q6 in `platform.md`. The audit writer derives the actor from the `CallContext` and accepts
none from its caller (PF 5.2 rule 2). Accepting an invitation, activating a factor inside an
admin's invitation acceptance or from an enrolment link, and confirming a reset by link all run
without a session (D 10.1), so the writer can only see the anonymous actor; `USER` would need a
second way to name an actor, which that rule forbids.

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

Under platform.md 10.2 as approved: hand-written in the `migration.sql` that creates the table,
in the block `-- Grants (database-designer): docs/design/data/identity.md section 7`, to the group
`mondapac_app` only, mirrored line by line in `down.sql` (every `REVOKE` before any `DROP`), and
nothing from its "Never" row. The second column below is each table's **Privileges line** (10.2).
`GRANT USAGE ON SCHEMA "identity"` is in the first migration of the schema (slice 1b). There is
no sequence and no function for the application; `subject_keys_guard_update()` is a trigger
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
| `identity.accounts`, `sessions`, `sign_in_throttles`, `one_time_links`, `seller_access`, `seller_memberships`, `roles`, `role_assignments`, `second_factors`, `sign_in_challenges`, `invitations` | `SELECT, INSERT, UPDATE, DELETE` | Ordinary tables; `DELETE` is used by the purge jobs, by erasure and by the use cases that remove a row (voided challenges, a reset factor, a cleared counter). On `accounts`, only the purge job in Phase 2 (A2, H5) |

**Column-level `UPDATE`** (A1; platform.md 10.2 as approved) is used on `outbox`, `subject_keys`
and `event_delivery`, under the four conditions of 10.2: it stands in place of table-level
`UPDATE` because this design names the columns; it covers exactly those columns (none of the
three has a Prisma `@updatedAt` column, so none is added); it never stands next to a table-level
`UPDATE` on the same table; and the test of 10.4 proves that every other column refuses
(`42501`), driven by the expected map of 10.5, which carries the column lists. Never column-level
`SELECT` or `INSERT`.

Api and worker share the group `mondapac_app` (platform.md 10.1), so the api also holds `UPDATE
(published_at)` and the delivery columns. A separate group is a new decision (10.1; PH4 of P).

## 8. Migration plan

### 8.1 Order (one PR with a migration open at a time, `docs/process/parallel-tracks.md` rule 6)

| # | Slice | Migration | Contains |
|---|---|---|---|
| 0 | Slice 0 item 7 | `app_role_grants` (platform.md 10.3) | Prerequisite of everything below |
| 1 | 1b | `identity_outbox` | `CREATE SCHEMA "identity"`, `outbox`, schema `USAGE` and table grants |
| 2 | 1c | `platform_subject_keys` | Table, trigger function, trigger, grants |
| 3 | 1d | `identity_accounts` | `accounts`, `password_credentials` |
| 4 | 2 | `identity_sessions` | `sessions`, `sign_in_throttles`, `sign_in_records` |
| 5 | 3 | `platform_event_delivery`, then `identity_links_inbox` | Two migrations in one PR: `event_delivery`; `one_time_links`, `inbox` |
| 6 | 5 | `identity_seller_access_roles` | `seller_access`, `seller_memberships`, `roles`, `role_permissions`, `role_assignments`; the foreign key `sessions.seller_id` |
| 7 | 6 | `platform_audit_anonymous` | Section 6, next to the audit design's own tables |
| 8 | 7 | `identity_second_factor_invitations` | `second_factors`, `recovery_codes`, `sign_in_challenges`, `invitations` |
| 9 | 9 | `identity_access_decisions` | `access_decisions` |

Nine slices carry a migration (D 12.1); slices 1a, 4, 8a, 8b, 10, 11 and 12 need none. Later,
each with its job: the `DELETE` grants and prune indexes of `inbox` and `event_delivery`.

### 8.2 Reversibility and safety

- Every `down.sql` mirrors its up in reverse: `REVOKE` first (platform.md 10.2), then child
  tables before parents, then hand-written functions. Partial indexes, CHECKs and triggers go
  with their table. No `IF EXISTS`, as in `platform.md` section 6.
- The down of migration 1 leaves the empty schema `identity` and revokes its `USAGE`, so the
  leftover check of platform.md 10.5 (guard 2) stays clean. The down of 6 drops the foreign key
  on `sessions` before the tables. The down of 7 fails once an `ANONYMOUS` row exists; that is
  correct, a down is for an empty or development database.
- All tables are new: no backfill, no lock that matters. The one statement on an existing table
  is the foreign key on `sessions` in migration 6; no deployed environment exists then (brief
  decision 2). On live data it would be `NOT VALID` followed by `VALIDATE`.
- My sign-off per migration follows the checklist form of `platform.md` section 8 and the five
  review points of its 10.2, plus: the hand-written block equals section 8.4 for that table.

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
- `accounts.display_name` is `String? @map("display_name")` in Prisma (N1). Prisma cannot
  express "nullable for one population"; `accounts_display_name_required_check` carries it, in
  the hand-written block like every CHECK.
- Hand-written, appended to the generated `migration.sql` under a marked block as in
  `platform.md` section 6: every CHECK; the function and trigger of 3.2; the grants; and the
  partial indexes:

```sql
CREATE INDEX "outbox_market_id_event_id_unpublished_idx" ON "identity"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;
CREATE INDEX "accounts_market_id_signed_up_at_unverified_idx" ON "identity"."accounts" ("market_id", "signed_up_at") WHERE "email_verified_at" IS NULL;
CREATE INDEX "sessions_market_id_seller_id_seller_idx" ON "identity"."sessions" ("market_id", "seller_id") WHERE "seller_id" IS NOT NULL;
CREATE INDEX "event_delivery_market_id_next_attempt_at_pending_idx" ON "platform"."event_delivery" ("market_id", "next_attempt_at") WHERE "status" = 'pending';
CREATE UNIQUE INDEX "seller_memberships_market_id_account_id_active_key" ON "identity"."seller_memberships" ("market_id", "account_id") WHERE "state" = 'active';
CREATE UNIQUE INDEX "roles_market_id_scope_system_key" ON "identity"."roles" ("market_id", "scope") WHERE "kind" = 'system';
CREATE UNIQUE INDEX "roles_market_id_seller_id_name_custom_key" ON "identity"."roles" ("market_id", "seller_id", "name_normalized") WHERE "kind" = 'custom' AND "seller_id" IS NOT NULL;
CREATE UNIQUE INDEX "roles_market_id_name_platform_custom_key" ON "identity"."roles" ("market_id", "name_normalized") WHERE "kind" = 'custom' AND "scope" = 'platform';
CREATE UNIQUE INDEX "invitations_market_id_seller_id_email_pending_key" ON "identity"."invitations" ("market_id", "seller_id", "email_normalized") WHERE "state" = 'pending' AND "seller_id" IS NOT NULL;
CREATE UNIQUE INDEX "invitations_market_id_email_pending_platform_key" ON "identity"."invitations" ("market_id", "email_normalized") WHERE "state" = 'pending' AND "seller_id" IS NULL;
CREATE UNIQUE INDEX "invitations_market_id_seller_id_owner_pending_key" ON "identity"."invitations" ("market_id", "seller_id") WHERE "kind" = 'seller-owner' AND "state" = 'pending';
```

- **Prisma and partial indexes (measured on 7.10.0).** With the default settings the drift check
  ignores a partial index it does not know, while it reports any other undeclared index (plain,
  or `NULLS NOT DISTINCT`) as drift. So: every non-partial index is declared in the schema, and
  the eleven above are invisible to Prisma, which neither creates nor checks them.
- **No named prepared statements** (spike 6; the rule is platform.md 10.9). Prisma sends `state =
  'active'` as a bind parameter. The adapter's default unnamed statements are planned with the
  values, so the partial indexes above are used (`seller_memberships`: 3 buffers, 0.05 ms). A named
  statement may switch to a generic plan, which cannot prove a partial index's predicate: measured
  325 buffers and 3.2 ms, reading the Market's whole active membership. Every partial index here
  depends on this rule.

| Option | For | Against |
|---|---|---|
| A (decided, A5). Hand-written, with a catalog test in `pnpm test:db` that compares the partial indexes found in `pg_indexes` with a checked-in list of their definitions | No preview feature in the toolchain; the same pattern as the CHECKs and triggers | A dropped or changed partial index is caught by the test only |
| B. Turn on the `partialIndexes` preview feature and declare them with `where: raw(…)` | The drift check covers them. Measured: with the feature on, the hand-written indexes of A match their declarations with no diff, so A can become B later without a migration | A preview feature under a pinned toolchain (ADR-0014): Ali's decision. `NULLS NOT DISTINCT` cannot be declared, which is why 3.9 and 3.10 use two indexes |

## 9. Volume, retention and jobs

Assumption (as `platform.md` section 4): one Market, Greater Brisbane, first year. Sizes were not
measured; at these row counts every table is far below the point where partitioning pays.

| Table | Rows expected | Growth control |
|---|---|---|
| `accounts` and their 1:1 rows | 10⁴ to 10⁵ customers, 10² to 10³ seller-side, tens of admins | Unverified accounts purged after 7 days |
| `sessions` | A few live rows per active account | Purged 30 days after the absolute expiry |
| `sign_in_records` | 10³ to 10⁴ a day, so at most about 10⁶ at 90 days | Daily-slice deletes. Revisit at 5 × 10⁷ rows: monthly range partitions on `occurred_at`, dropped whole |
| `sign_in_throttles` | One row per key and window: hundreds normally; under attack one per address or IPv6 /64 tried, for 48 hours | Hourly purge; an index `(market_id, window_started_at)` once it passes 10⁶ rows |
| `sign_in_challenges` | Hundreds, short-lived | Hourly purge |
| `one_time_links`, `invitations` | At most four per account; open invitations | Hourly purge of consumed, expired and decided rows |
| `outbox` | A few events per account plus admin actions: 10⁵ to 10⁶ a year | Kept (P 6.5); pruning or partitioning is decided at 10⁶ rows |
| `event_delivery`, `inbox` | The mail-causing events times their subscribers | The platform prune job, before the first deployed environment (P 7) |
| `subject_keys` | Accounts plus sellers plus one tombstone per purged sign-up | None in Phase 2 (A7; revisited before the first deployed environment); sign-up is rate-limited per origin |
| `seller_access`, memberships, roles, keys, assignments, `access_decisions` | 10² to 10⁴ | None needed |

| Job (PN4) | Per hosted Market, each statement with `market_id` at the top level |
|---|---|
| `identity.purge-expired`, hourly, slice 2 | Sessions past absolute expiry plus 30 days; throttle rows whose window started more than 48 hours ago and that are not blocked; sign-in records past 90 days. From slice 3: links consumed or expired for a day. From slice 7: expired challenges; pending invitations past `expires_at`; decided invitations older than 30 days |
| `identity.purge-unverified-accounts`, daily, slice 3 | Accounts of the partial index of 3.3 whose latest sign-up is older than 7 days: destroy the key, delete the account, one `serializable` unit per account (C11); from slice 5 also its assignment, membership and the `seller_access` whose `registered_at` is NULL |

Both delete only what is already invalid and are safe to run twice and at once. Autovacuum
defaults are enough at this volume; `sessions` and `sign_in_throttles` are the update-heavy
tables to watch first. Spike 6 measured 72.5 % HOT updates for the once-a-minute `last_seen_at` write at the default fillfactor (20,000 updates over 2 × 10⁵ rows, starting from freshly loaded full pages, so a lower bound): no fillfactor change. Revisit if `n_tup_hot_upd / n_tup_upd` on `sessions` stays below 50 % in production.

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
| N1 (2026-10-07, throwaway database, dropped): with `display_name` nullable, a customer row with NULL is accepted; a seller or admin row with NULL is refused at insert and at update (`accounts_display_name_required_check`); `''`, an outer space, U+202E and 101 characters are refused for every population (`accounts_display_name_check`). Repeated for AU and ZZ by the slice 1d `test:db` constraint test | 3.3, 11.5 |
| G2 changes, in a throwaway database (dropped): the name CHECK (the cases of 3.3); the two role-name indexes (the cases of 3.9); one pending owner invitation per seller, and a new one after a revocation; the closed `kind` list and the `account_key` CHECK; 20 concurrent reservation units, from an empty table and from an ended window; the release guard | 3.3, 3.5, 3.9, 3.10 |
| Spike 6 (Hossein with Mojtaba, 2026-10-07; PostgreSQL 16.15, Prisma 7.10 with adapter-pg; synthetic seed of 10⁵ accounts, 2 × 10⁵ sessions, 5 × 10³ sellers, 2 × 10⁴ memberships and 5 × 10⁴ throttle rows in AU and ZZ, analysed, warm cache). Authenticator and permission reads are index probes (10, 14 and 16 buffer hits, at most 0.2 ms), also for an unknown token and a cross-Market token (3 hits, no row). The last-holder count goes by index. Native upsert, with exactly five of 20 concurrent reservations allowed. Challenge: exactly five of 20 concurrent reservations allowed, consumed once. The `40001` rates and both error shapes; the K1 settings; generic plans and partial indexes; 72.5 % HOT. Report and raw output: shared folder `phase-2/spikes/spike6/` | 3.4, 3.5, 3.9, 5.1, 8.4, 9, 11.4 |

Not measured: PostgreSQL 17 (Compose and CI): spike 6's plans (01, 02, 09) are re-run there before
migration 6 is signed off. The real guard and UnitOfWork: their slices. The foreign-key check plans
behind 3.4 and 3.9: reasoned from how PostgreSQL proves a partial index's predicate; their `EXPLAIN`
goes into migration 6's review.

## 11. Review record and open points

### 11.1 Ali's decisions (A1 to A8)

| # | Point | Decision |
|---|---|---|
| A1 | Column-level `UPDATE` grants (7) | Accept; platform.md 10.2 and its tests amended on their branch before it merges (done, ebe3ec6). Decided by Ali 2026-10-03 |
| A2 | Erasure and the unverified purge as a hard delete of the account row (3.3) | Accept, subject to H5; in Phase 2 only the purge job deletes accounts. Decided by Ali 2026-10-03 |
| A3 | `ANONYMOUS` in the audit actor CHECK (6) | Accept with both conditions; it lands before the writer's first row. Decided by Ali 2026-10-03 |
| A4 | `version` only on the eight roots of C5 | Accept; D 2.1 says `Session` and `SignInChallenge` are not versioned. Decided by Ali 2026-10-03 |
| A5 | Partial indexes hand-written with a catalog test (8.4) | Option A now; B when Prisma's feature leaves preview. Decided by Ali 2026-10-03 |
| A6 | Origin throttle counters per Market (3.5) | Accept; D 6.8 changed to match. Decided by Ali 2026-10-03 |
| A7 | Key tombstones kept without limit in Phase 2 (3.2) | Accept; revisit before the first deployed environment. Decided by Ali 2026-10-03 |
| A8 | `Identity` model prefix (C9); `password_credentials` as its own table | Accept. Decided by Ali 2026-10-03 |

Also Ali's: `identity.outbox` lands in slice 1b (M9); slices are named 1a to 1d, 8a and 8b (8.1).

### 11.2 Hassan's answers (H1 to H8)

| # | Point | Decision |
|---|---|---|
| H1 | Plain email, display name and custom role names (D 11.2 option A) | Yes, with encrypted disks and backups. Decided by Hassan 2026-10-03 |
| H2 | Recovery-code hashes | `SubjectKeyService.hmac` under the account's key, 32 bytes (3.10). Decided by Hassan 2026-10-03 |
| H3 | `sign_in_records.origin` | The full address, kept 90 days (3.6). Decided by Hassan 2026-10-03 |
| H4 | Throttle-key secret | 32 random bytes, required at boot, never logged (3.5); where it lives is Kazem's (11.4). Decided by Hassan 2026-10-03 |
| H5 | `DELETE` on `accounts` for the application role | Yes, for the purge and erasure only (7). Decided by Hassan 2026-10-03 |
| H6 | `access_decisions` and `sign_in_records` append-only by privilege only | Yes, with the grants tested (platform.md 10.4, 10.5). Decided by Hassan 2026-10-03 |
| H7 | `subject_keys`: column-level `UPDATE`, one-way trigger, no `DELETE`, tombstones kept | Yes; the wrapped-key format stays Kazem's (11.4). Decided by Hassan 2026-10-03 |
| H8 | Revoked sessions kept until absolute expiry plus 30 days | Yes (3.4). Decided by Hassan 2026-10-03 |

His findings in the tables: HF1 (3.5, 3.10); HF2 (3.5, 3.10); HF3 (3.5); HF5 (3.9, 3.10, 5);
HF6 (3.7, 3.10); HF8 (C11, 5.1); HF11 (3.10); HF13 (3.3, 3.9); HF15 (3.7, 3.10); the TOTP step
rule and the backup codes (3.10); session lifetimes and rotation (3.4).

### 11.3 Mohammad's answers (M1 to M11; D 14.3)

| # | Point | Decision |
|---|---|---|
| M1 | No `version` on tables changed by single statements, `Session` and `SignInChallenge` included | Confirmed, with Ali's A4 (D 2.1). Decided by Mohammad 2026-10-03 |
| M2 | `sessions.idle_timeout_seconds` stored | Yes: idle timeout and absolute expiry fixed at creation (D 2.1, 6.1). Decided by Mohammad 2026-10-03 |
| M3 | `SecondFactor` has its own id, new at every enrolment | Yes, as every aggregate deleted and created again (D 2.1). Decided by Mohammad 2026-10-03 |
| M4 | `seller_access.origin` and `registered_at` | Confirmed as fields of `SellerAccess` (D 2.1, 8.2). Decided by Mohammad 2026-10-03 |
| M5 | Anchor of the 7-day purge | The latest sign-up, a field of its own: `accounts.signed_up_at` (3.3). Decided by Mohammad 2026-10-03 |
| M6 | Session rows deleted 30 days after the absolute expiry | Confirmed (D 6.1). Decided by Mohammad 2026-10-03 |
| M7 | `expired` not stored; a new `seller-owner` invitation for an ownerless seller | Confirmed; it may name that seller, which never had a member (HF5 (a)). Decided by Mohammad 2026-10-03 |
| M8 | One reused link row per account and purpose; "allow another application" | Confirmed; no decision row: it is not in Phase 2. Decided by Mohammad 2026-10-03 |
| M9 | `identity.outbox` before the first account | Slice 1b (Ali; D 12.1). Decided by Mohammad 2026-10-03 |
| M10 | Name limits; uniqueness of a custom role's name | 100 and 80 characters; unique per seller or platform scope after trimming, NFC and lower-casing, as a constraint (3.9). Decided by Mohammad 2026-10-03 |
| M11 | Fixed windows with a block instant | Confirmed (D 6.8). Decided by Mohammad 2026-10-03 |

### 11.4 Still open

| # | Point | Who |
|---|---|---|
| M12 | One pending `seller-owner` invitation per seller (3.10), answered `invitation.already-pending`. Decided by Mohammad 2026-10-03: D 3.4 names the rule | Closed |
| M13 | Device replacement keeps the new secret until its first valid code. Decided by Mohammad 2026-10-03: a nullable `pending_secret_ciphertext` on `second_factors` (3.10), added with the table in slice 7 | Closed |
| K1 | Format and maximum size of a wrapped key and of the wrapping-key identifier (3.2); where the throttle secret lives (H4) | Kazem |
| K1a | Role settings (PK1 of P): `statement_timeout` 30 s, `lock_timeout` 3 s, `idle_in_transaction_session_timeout` 60 s. Set with `ALTER ROLE <login> SET` (no `IN DATABASE`) on every application login. Never on `mondapac_app`, whose settings do not reach its members, and never on the migration role. Asserted by the role test of platform.md 10.4. Confirmed in spike 6 (2026-10-07). 3 s because the unit timeout is 5 s (P 3.1 row 8) and equal values race (measured 16 ms apart); order: pool wait 2 s, lock 3 s, unit 5 s, statement 30 s | Closed: Kazem accepted 3 s (2026-10-07); his change goes in platform.md 10.7 and `bootstrap-dev.sql` |
| S6 | Spike 6 (Hossein with Mojtaba, 2026-10-07): results in 3.4, 3.5, 3.9, 5.1, 8.4, 9 and 10 | Closed by Mojtaba 2026-10-07; PostgreSQL 17 re-run of the plans before migration 6 |
| D1 | Closed by Hassan 2026-10-03: every enrolment outside an admin's invitation acceptance, a seller's first optional one included, starts from a mailed `enrol-second-factor` link; no table changes | Closed |
| — | This revision | Final check by Ali and Hassan |

Owner: none. The 90-day retention reaches the owner only if a legal review asks for a longer one.

### 11.5 After G2: the customer display name (N1, 2026-10-07)

D 2.1 and 3.3 required a display name on every account, while customer sign-up asks for email
and password only (brief flow «د» item 1; `ux.md` A2, F1 step 2). Found by Hossein in slice 1d.

| Option | For | Against |
|---|---|---|
| b1 (chosen). `display_name` nullable; `accounts_display_name_required_check`: `population = 'customer' OR display_name IS NOT NULL`; `accounts_display_name_check` unchanged | One column, one extra CHECK; the rule for seller-side and admin accounts stays in the database; no migration later if customers gain an optional name | Prisma types the field as optional for every population; the domain factories carry the rule in code |
| b2 (rejected). A separate nullable column or table for customer names, or a placeholder value | — | A second place for one fact; a placeholder is fake personal data that would reach mails and lists |

The owner chose "no name" for customers on 2026-10-08, confirming b1. Mohammad (D 2.1) and
Mojtaba (this document) agreed; brief change-log row of 2026-10-07.

## 12. Follow-up changes

This document changes no other file. After G2:

| File | Change | When |
|---|---|---|
| `docs/design/data/platform.md` | Section 1 sentence on outbox, inbox and `event_delivery`; `ANONYMOUS` in sections 2, 3.2 and 6, and Q6; a pointer to 3.2 and 3.8 here. 10.2 and 10.5 are already amended (A1, ebe3ec6) | After G2, once `docs/db-role-grant-note` has merged; Mojtaba |
| `prisma/schema/base.prisma`, `identity.prisma`, `platform.prisma`; the migrations of 8.1 with `down.sql` | As specified; each needs my sign-off | Per slice; Hossein |
| The privilege map and the catalog tests of `pnpm test:db` | Section 7, column lists included (the column-level test of platform.md 10.4 reads them); the partial-index list of 8.4; "every outbox has the same columns" (P 13) | With each migration; Hossein |
| `docs/design/domain/identity.md` | M12 in 3.4; M13 in 3.6 | Done (Mohammad, 2026-10-03) |
| `docs/design/domain/platform-persistence-and-events.md` | PM1: the unique key leads with `market_id` (3.1); PM8: no clash, confirmed (10) | With the G2 approval; Mohammad |
| `docs/design/data/platform.md` | New 10.9 (prepared statements); K1a settings in 10.7; the settings assertions in the role test of 10.4 | 10.9: Done (PR #41). 10.7, 10.8 `role_timeouts` and 10.4: specified (PR #53, Kazem, 2026-10-07); the `role_timeouts` start-up check and the role-settings test are code in identity slice 1a (Hossein) |
| `docs/design/domain/platform-persistence-and-events.md` | Section 13, UnitOfWork row: the exhausted-retry test, at a statement and at COMMIT; the classifier keys on SQLSTATE; 55P03's answer (PN7) | Done (PR #41) |
| `scripts/db/bootstrap-dev.sql` | `ALTER ROLE mondapac_api SET` the three K1a values | Done (PR #53, Kazem, 2026-10-07) |
| `docs/design/domain/identity.md` | N1: 2.1, 3.2, 6.5, 6.7, 8.6, 9, 11.1 and 12.1 say that a customer account may have no display name | Done in identity slice 1d (Mohammad's text, 2026-10-07) |
| `docs/modules/identity/brief.md` | N1: a change-log row | Done in identity slice 1d (2026-10-07) |
| Migration `identity_accounts`; its `test:db` constraint test | N1: `display_name` nullable with `accounts_display_name_required_check`; the measured cases of section 10 for AU and ZZ | Identity slice 1d (Hossein); my sign-off |
