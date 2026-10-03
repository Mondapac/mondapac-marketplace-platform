# Platform persistence and events — UnitOfWork, market guard, outbox, relay, scheduler, `APP_ROLE`

**Author:** Mohammad (software-architect) — 2026-10-03
**Status:** Draft — G2 review pending
**Ground truth:** `docs/design/domain/platform-foundations.md` ("foundations" below: sections 3.6,
3.7, 4, 5, 6.4, 8; inputs I4, I5, I7, I14, I15); ADR-0003 (decisions 2, 3, 7), ADR-0004
(decisions 3 to 5, 7), ADR-0005 (decisions 5, 6), ADR-0006 (all), ADR-0008 (decisions 2, 5, 6),
ADR-0009 (decision 6), ADR-0014, ADR-0015 (decisions 1 to 5), ADR-0018 (decisions 2 to 4),
ADR-0020; `docs/design/data/platform.md` (section 1); `docs/modules/identity/brief.md` (sections
5, 6, 11); the code on branch `docs/identity-g2-design` (`apps/api/src/platform/persistence/`,
`platform/config/app-config.ts`, `main.ts`, `app.module.ts`, `prisma/`,
`scripts/check-prisma-boundaries.mjs`, `apps/api/.dependency-cruiser.cjs`, `apps/api/test/db/`).

## 1. Scope

A design, not an implementation: a signature appears only where it is the contract, SQL only
where the query shape is. It covers the platform infrastructure that ADR-0015 decision 3 makes
land with identity's slice 1 (customer registration), the first slice that emits an event.

- **Decided here:** the UnitOfWork (3), the `market_id` guard (4), the outbox (5), the relay and
  the event bus (6), the scheduler (7), `APP_ROLE` (8), the "model to owning module" rule (9), the
  aggregate version (10), the query-side inputs to the data design (11), placement and tests.
- **Not here:** the audit writer, the seal table and the sealer (their own design before slice 6,
  ADR-0015 decision 1); the internals of `SubjectKeyService` (foundations 4); the access-rule
  mechanism (foundations 6.4); anything of `identity`'s domain. For the first three this document
  fixes only how they meet the transaction (3.3, 3.4).
- **Contract with `docs/design/domain/identity.md`** (aligned 2026-10-03: see its 14.0):

| This document provides | The identity design decides |
|---|---|
| `UnitOfWork.run` and its commit rule (3.1); the nesting order (3.4) | Which use cases are read-only or serialisable; the access-rule mechanism (I2) |
| `PrismaService.tx(market)` and the guard (3.3, 4) | Its repositories and tables; every query carries the Market |
| `defineEvent`, `OutboxWriter.append`, who stamps what (5) | Its event catalogue: types, aggregate types, payload fields |
| `JobDefinition` and the runner (7) | Its jobs, their intervals and slices |
| The version convention and `StaleAggregateError` (10) | Its aggregates; the 409 codes inside the API error format (I12) |

Numbering: **PA** Ali, **PH** Hassan, **PN** identity, **PK** Kazem (in 16); **PM** Mojtaba (11).

## 2. ADR-0015 decision 3, the rows covered

| Row (as numbered in foundations 2) | Item | Designed in | Lands |
|---|---|---|---|
| 1 (part) | `DomainEvent` | Envelope: foundations 3.6. Stamping, `PendingEvent`, `defineEvent`: 5 | Slice 1 |
| 4 (part) | Entry adapters for jobs and consumed events | 7; 6.4 | Job adapter: slice 1. Event adapter: slice 3, with the consume side (6.5) |
| 5 | UnitOfWork | 3 | Slice 1 |
| 5 | Outbox and relay | 5, 6.1, 6.2 | Slice 1 |
| 5 | Event bus | 6.3 to 6.5 | Port and publish path: slice 1. Delivery to subscribers: slice 3, the first subscription (identity's mail handlers; PA1) |
| 5 | Scheduler | 7 | Runner: slice 1. First job: slice 2 (`identity.purge-expired`; PN4) |
| 5 | `APP_ROLE` | 8 | Slice 1 |
| 6 | `market_id` Prisma query guard | 4 | Slice 1, no later than the first repository on a market-scoped model |
| 7 | "Model to owning module" rule | 9 | Slice 1, no later than the first module-owned Prisma model |

## 3. UnitOfWork
### 3.1 Port and guarantees
```ts
type UnitOfWorkOptions = { readOnly?: boolean; isolation?: 'serializable'; timeoutMs?: number };
interface UnitOfWork {
  run<T, E>(
    market: MarketContext,
    work: () => Promise<Result<T, E>>,
    options?: UnitOfWorkOptions, // defaults: read-write, READ COMMITTED, 5000 ms (at most 30000)
  ): Promise<Result<T, E>>;
}
```
| # | Guarantee |
|---|---|
| 1 | **One transaction, one connection.** Everything `work` does through `PrismaService.tx` (3.3) runs in one Prisma interactive transaction (ADR-0004 decision 5). Verified: one backend process serves every statement, and nothing is visible outside before commit |
| 2 | **Opened for one Market.** `run` throws on a `MarketContext` that was not minted (foundations 3.7, C2). The guard compares every query with this Market (4) |
| 3 | **Commit rule.** `ok` commits. `err` commits nothing and is returned unchanged (the recommendation of I4, adopted). An exception commits nothing and is rethrown. There is no partial commit. A refusal that must leave a trace (a failed-attempt counter) is therefore an `ok` outcome inside the unit, which the use case turns into its own error after the commit (PN1) |
| 4 | **No nesting.** `run` inside an open unit throws `NestedUnitOfWorkError`: no join, no savepoint, no second transaction. A facade call never joins the caller's transaction (ADR-0004 decision 5), and an inner transaction waiting for a second pooled connection starves the pool (verified: `P2028` after the wait limit with a pool of one) |
| 5 | **Work is short and repeatable.** No password hashing, no HTTP or mail call, no facade call and no model call inside `work`: a connection is pinned for its whole duration and `work` may run again (row 7). A use case does slow work and facade reads first, then opens at most one read-write unit. A read-only unit may come before the slow work when that work needs stored data (sign-in: read the hash, verify outside, then write; a mail handler: read, send, then record); the write unit re-checks what was read, through the version (10) |
| 6 | **Isolation.** READ COMMITTED, PostgreSQL's default (verified through the adapter). Invariants are protected by the version column (10), by unique constraints and, where an invariant spans rows (R3's "last admin"), by `isolation: 'serializable'` declared by that use case |
| 7 | **Retry.** On a serialisation failure (SQLSTATE `40001`) or a deadlock (`40P01`), `run` rolls back and runs `work` again: three attempts in all, a short random pause between them, then `TransactionConflictError`. Nothing else is retried. The two codes arrive in two different error shapes (14) |
| 8 | **Timeouts.** At most 2 s to obtain a connection and 5 s for the unit (Prisma's defaults, written down as platform constants); `timeoutMs` raises the second to at most 30 s. Prisma's timeout does not interrupt a running statement (verified): the statement finishes, then the unit fails with `P2028` and rolls back. The hard bound is therefore set in the database (PK1) |
| 9 | **Read-only.** With `readOnly: true` the guard refuses every write and the platform writers refuse to run. It is still a transaction (ADR-0004 decision 5) and sets nothing in the database (PA5) |

### 3.2 What `AsyncLocalStorage` carries
One `AsyncLocalStorage`, owned by `platform/persistence/` (ADR-0004 decision 5). Its store is the
open unit and nothing else: the transaction client, the `MarketContext` the unit was opened with
and the read-only flag. No actor, no correlation id, no `CallContext`, and no accessor for
modules: the Market in the store is what the guard and `tx(market)` compare against, never where
business code reads its Market (foundations 5.2, option A stands; PA4). `run` awaits `work`
inside the store's scope, because a Prisma query is lazy: it runs in the async context where it is
awaited, not where it was created (verified). A query that escapes the scope meets no open unit
and the guard refuses it, so the failure is closed.

### 3.3 Who obtains the transaction, and how
`PrismaService extends PrismaClient` cannot stay: a client with `$extends` applied is not an
instance of the class, and its transaction client is a different type (both verified). Two
providers replace it:

| Provider | Holds | Visible to |
|---|---|---|
| `PrismaRoot` | The base client, without the guard | `platform/persistence/` only. `PersistenceModule` does not export it, so Nest cannot inject it elsewhere (foundations 10) |
| `PrismaService` | The guarded client; one method, `tx(market: MarketContext): MarketTransaction` | Module `infrastructure/` and `platform/persistence/` |

`tx(market)` returns the open unit's transaction client; it throws `NoUnitOfWorkError` when none
is open and `MarketMismatchError` when `market` is not the unit's Market and tenant. Repositories
are typed against the exported `MarketTransaction` (`Prisma.TransactionClient` is assignable in
neither direction: verified with `tsc`). Module code has no other door to the database.

| Caller | How | Takes (foundations 5.2 rule 2) |
|---|---|---|
| A module's repository | `tx(market)` on every call; it never keeps the client | `MarketContext` |
| Outbox writer (5.2) | `tx(context.market)`; refuses a read-only unit | `CallContext` |
| Audit writer (own design, slice 6) | The same. Fixed here: it writes in the caller's unit and never opens one (ADR-0004 decision 7) | `CallContext` |
| `SubjectKeyService` store (foundations 4, row 8) | `createKey`, `destroyKey`: an open unit is required. `encrypt`, `decrypt`, `hmac`: the open unit when there is one, otherwise a read-only unit of their own | `MarketContext` |
| Relay, scheduler lock, `DatabaseProbe` | `PrismaRoot`, in short transactions of their own, never inside a unit | — |

### 3.4 Nesting with the access-rule mechanism
Outside to inside: entry adapter (builds the `CallContext`) → access-rule mechanism (minted
check, Market comparison, `AuthorisationCheck`; foundations 6.4) → use-case body →
`UnitOfWork.run`. The UnitOfWork is the inner one:

| # | Reason |
|---|---|
| 1 | Authorisation runs before the body (ADR-0018 decision 4); a denial opens no transaction and pins no connection |
| 2 | `Authenticator` and `AuthorisationCheck` read committed state (foundations 6.3 row 4) in a unit of their own. Inside the caller's unit they would join its transaction, against ADR-0004 decision 5, and row 4 of 3.1 would throw |
| 3 | The ownership check of R6 is part of the body and runs inside the unit, on the rows the unit then changes |
| 4 | Slow work stays outside the transaction (row 5 of 3.1). Slice 1 hashes a password |

**Toss-up T1: who calls `run` (PA2).**

| Option | For | Against |
|---|---|---|
| A (recommended; the identity design follows it). The use-case body calls `run` itself | Hashing and facade reads stay outside the transaction; visible in the code; a use case with no database work opens nothing | "At most one read-write `run` per use case" is a review rule. Softened: no database access exists outside a unit, and a nested `run` throws |
| B. The mechanism opens the unit from a static declaration | Cannot be forgotten | The whole body, hashing included, runs with a connection pinned; the mechanism of I2 grows |

## 4. `market_id` guard (I5)
### 4.1 Rule: equality with the unit's Market
ADR-0004 decision 3 asks for `market_id` in the `where`. Presence alone lets code that holds
another hosted Market's context read or write that Market inside this unit (the factory can mint
any hosted Market; foundations rule 5 of 8.2). The guard therefore requires **equality with the
Market the unit was opened for**, as the security-tester requires and Mojtaba recommends: stronger
than the ADR's wording and never weaker (PH1).

| Operation on a market-scoped model | Rule |
|---|---|
| `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`, `groupBy`, `update`, `updateMany`, `updateManyAndReturn`, `delete`, `deleteMany` | `where.marketId` is at the top level, as a plain value or `{ equals }`, and equals the unit's Market. Inside `OR` or `NOT`, or as `in` or `not`, it does not count. A read by id also names the Market |
| `create`, `createMany`, `createManyAndReturn` | Every row's `marketId` and `tenantId` equal the unit's. The tenant too: no key or constraint would catch a wrong one (foundations 3.3) |
| `upsert` | Both rules: `where` and `create` |
| `update`, `updateMany`, `updateManyAndReturn`, the `update` part of `upsert` | `data` sets neither `marketId` nor `tenantId`: a row never changes Market |
| Nested writes (a relation field in `data`) | Refused. Verified: an unguarded client stores a nested `create` that carries the other Market. A repository writes each table with its own statement in the same unit |
| Nested reads (`include`, `select`, relation filters) | Allowed: relations never leave a module schema (ADR-0004 decision 3) and the rows hang from a parent already filtered by Market. Database backstop: PM6 |
| Any model operation with no open unit; any write in a read-only unit; a model the map does not know | Refused |
| `$queryRaw`, `$executeRaw` and their `Unsafe` forms | Refused on the guarded client (4.2) |

### 4.2 Implementation, exemptions, raw SQL
| Topic | Decision |
|---|---|
| Mechanism | One Prisma client extension (`query.$allModels.$allOperations` plus the four raw hooks), applied once where `PrismaService` builds its client. The decision is a pure function of (map entry, operation, arguments, open unit), unit-tested without a database; a refusal throws `MarketGuardError`, so the unit rolls back. Verified on Prisma 7.10 with the `pg` adapter: the hook runs for operations on the interactive-transaction client, with the model, the operation and the full arguments (nested data included); it sees the `AsyncLocalStorage` store; its query runs in the same transaction; interleaved units keep their own store; the cost is under 0.1 ms per query |
| Scoped models | From the generated model map (9): a scoped model has both `marketId` and `tenantId` |
| Exemption | A model without `market_id` says so in its schema file with a documentation line `/// @market-scope none: <reason>`. The generator fails on a model that has neither the columns nor the line, or both. An exemption is thus one visible line in a file Mojtaba signs off; Phase 2 has none unless the identity data design names one. An exempt model still needs an open unit |
| Raw SQL | The guard cannot read SQL, so inside a unit raw SQL is refused in slice 1, for modules and platform alike. The platform's own raw statements (the relay's claim, the scheduler lock) run on `PrismaRoot` in transactions of their own and name the Market in the statement. The first repository that needs SQL Prisma cannot express, a row lock for example, brings a raw helper with it, approved by Mojtaba and Hassan: named statements on a checked-in list, the Market bound by the helper as the first parameter, each statement proven by a two-Market database test. Identity needs none in Phase 2: its "last holder" rules run `serializable` (PN5) |

## 5. Outbox

**One outbox per module schema.** ADR-0006 decision 2 ("its own `<module>.outbox`") and ADR-0008
decision 2 (the outbox writer sits in the module's `infrastructure/`) decide it: there is no
single platform table. Every outbox has the same shape (PM1), so one platform writer and one relay
serve them all; the module's part is its table and one binding line.

### 5.1 Who stamps the envelope (foundations 3.6)
| Field | Stamped by | From |
|---|---|---|
| `type`, `aggregateType`, the shape of `payload` | The event definition (5.3) | Constants of the publishing module |
| `aggregateId`, `aggregateVersion`, `occurredAt`, the values of `payload` | The aggregate, when it records the event | Its own state. `occurredAt` is the instant the use case took from `Clock` and passed in: the one the row's own timestamps get |
| `eventId` | The outbox writer | `IdGenerator` |
| `market`, `correlationId` | The outbox writer | The `CallContext`, never the aggregate or the caller's data. A context whose Market is not the open unit's is refused |
| `causationId` | The outbox writer | `null`, or the consumed event's id handed over by an event-handling use case (6.4) |

The domain produces a `PendingEvent` (the first two rows); only the writer produces a
`DomainEvent`. Both are kernel types: `PendingEvent` is a helper of it (ADR-0020 decision 2).

### 5.2 Write path
```ts
interface OutboxWriter {
  append(context: CallContext, events: readonly PendingEvent[], causedBy?: Id): Promise<void>;
}
```
The use case calls it inside `work`, after the repository saved the aggregate. The writer is bound
per module (`OutboxWriterFactory.forModule(name)`: one line in the module's Nest module; a test
asserts that the name is the module's folder) and refuses: no open unit, or a read-only one; a
type that does not start with its module's name or is not in the event catalogue; a payload that
does not match its definition; a version outside 1 to 2^31−1. A refusal throws, so the unit rolls
back: an event is never dropped silently and never written without its state change (ADR-0006
decision 2). One row per event, inserted through the module's outbox model, so the guard checks
Market and tenant like any other row. Nothing else publishes: only the relay sees the bus (6.3).

### 5.3 No personal data in a payload (ADR-0009 decision 6, R5)
An event is declared with `defineEvent` (kernel) in the publishing module's `domain/` and
re-exported from its `contracts/` (ADR-0006 decision 6; `domain/` may import only the kernel,
ADR-0015 decision 4). A definition names the type, the version, the aggregate type and each
payload field with a kind from a closed vocabulary: `id`, `enumOf(values)`, `boolean`, `integer`,
`instant`, `permissionKey`, `listOf(kind)`, `optional(kind)`. No kind takes an arbitrary string.

| Layer | What it enforces |
|---|---|
| The vocabulary | A reason, a name, an email or a role name has no kind to be declared with. A new kind is a kernel change reviewed by the security-tester |
| The writer, at run time | Exactly the declared fields with the declared kinds; a `permissionKey` value must be known to the `PermissionRegistry` or its retired list (foundations 6.1) |
| `EventCatalogue` at boot (`platform/events/`) | Modules register their definitions, as with permissions: a duplicate type, or a first segment that is not the registering module, fails boot; sealed afterwards; the same in both roles |
| The contracts test | Builds the catalogue from the booted application and compares it with a checked-in snapshot of every type and its fields. A new type fails until the snapshot changes, so each one is seen in review (the pattern of C4). A changed field list of an existing version fails with "publish a new version" (ADR-0006 decision 6). This is how "no free-string payload field" is tested |
| Security review | Reads the snapshot diff. An `id` may still point at a person; that is allowed (identifiers only, brief section 6; PH2) |

## 6. Relay and event bus
### 6.1 Relay
A loop in the `worker` role (ADR-0006 decision 4). One pass visits every module outbox the model
map lists and, for each, every hosted Market (`MarketRegistry.hostedMarketIds()`; ADR-0003
decision 2), each in one short transaction on `PrismaRoot`:
```sql
SELECT <envelope columns> FROM "<module>".outbox
 WHERE market_id = $1 AND published_at IS NULL
 ORDER BY event_id LIMIT $2
   FOR UPDATE SKIP LOCKED;                          -- ADR-0006 decision 3
-- EventBus.publish(events, transaction)            -- 6.3
UPDATE "<module>".outbox SET published_at = $3 WHERE event_id = ANY($4);
```
`$3` is the `Clock` instant (foundations 3.2). A batch is 50 rows; a full batch is followed by the
next pass at once, an empty pass by a 500 ms pause (ADR-0006 targets under 1 s).

### 6.2 Delivery guarantees
| Topic | Guarantee |
|---|---|
| Loss | None: the row commits with the state change and stays unpublished until a transaction that published it commits |
| Crash between the use case's commit and the publish | The row is still unpublished; the next pass of any worker publishes it |
| Crash between publish and mark | In-process bus: both are in the relay's transaction and roll back together (ADR-0006 decision 4). A broker adapter publishes before the mark commits, so an event can be published twice |
| Delivery | At least once (ADR-0006 decision 3); consumers are idempotent (6.4) |
| Several workers | `SKIP LOCKED` gives concurrent relays disjoint rows (verified) |
| Selection | By `published_at IS NULL`, never by a cursor or a highest id: a transaction that commits late with an older id is still found |
| Order | **None is guaranteed** (ADR-0006 decision 3), per aggregate or per Market. A pass takes rows in `event_id` order, creation order to the millisecond (foundations 3.1): best effort only. Per aggregate, `aggregate_version` is unique and rises by one (10), so a consumer can drop a stale event and can see a gap |
| Market | Rows of a Market this stack does not host are never claimed; the worker looks for them at start and logs an error |
| Failure | A failed pass rolls back and is repeated; there is no per-row attempt count and no relay dead letter. The age of the oldest unpublished row per Market is logged when above 5 s (PK3) |
| Logs | Event id, type, Market, correlation id; never a payload |

### 6.3 `EventBus` port
`publish(events: readonly DomainEvent[], transaction: RelayTransaction): Promise<void>` is the
whole port: the swap point of ADR-0006 decision 8, in `platform/events/`. Only the relay calls it,
between claim and mark. The in-process adapter writes its delivery rows through `transaction`, an
opaque handle of `platform/persistence/`: that is what makes fan-out and mark one transaction. A
broker adapter ignores the handle and must tolerate a repeated `eventId`. Modules never see the
bus.

### 6.4 Consume side (built in slice 3: 6.5)
| Part | Specification |
|---|---|
| Subscription | Declared in the consuming module's `presentation/subscribers/`: a subscriber name `<module>.<handler>`, an event definition imported from the publisher's `contracts/`, a handler `(event, delivery, context)`. Registered at bootstrap, sealed, the same in both roles |
| Fan-out | `publish` inserts one `platform.event_delivery` row per event and subscriber (`pending`, no attempts, due now) with a copy of the envelope, so the dispatcher never reads a module schema. A repeated `(event_id, subscriber)` is ignored |
| Claim | Per hosted Market, the statement below in its own short transaction (shape verified). The claim counts the attempt and moves `next_attempt_at` forward by the back-off, so a handler that crashes needs no bookkeeping: the row comes due again |
| Entry adapter (foundations 5.1) | `MarketContextFactory.forMarket` on the envelope's Market, that Market's system actor, the envelope's correlation id, `createCallContext`. A Market not hosted here, another tenant or an unknown type is dead-lettered at once. The handler calls one use case whose access rule is `system` (foundations 6.2) |
| Idempotence (ADR-0006 decision 5) | The use case opens its unit with `UnitOfWork.runOnce(market, delivery, work)`: it inserts `(event_id, handler)` into the module's `inbox`, skips `work` when the row already exists, and marks the delivery `delivered`, all in the one transaction. A handler that returns without consuming its `delivery` has failed. External work (sending a mail) is done before `runOnce`, never inside it (3.1 row 5); a crash between the two repeats it, so such work is at least once |
| Back-off | `min(30 s × 2^(attempts − 1), 1 h)`, never less than the unit timeout |
| Dead letter | After 10 attempts (about three hours) the row becomes `dead` with an error code, never a message (12.3), and one error-level log line marked for alerting (ADR-0006 decision 4). Requeue is an operator routine, designed with the first consumer |
| Order | None: the handler compares `aggregate_version` with what its own read model stored |
```sql
UPDATE platform.event_delivery d
   SET attempts = d.attempts + 1, next_attempt_at = $2 + <back-off for d.attempts + 1>
 WHERE (d.event_id, d.subscriber) IN (
         SELECT event_id, subscriber FROM platform.event_delivery
          WHERE market_id = $1 AND status = 'pending' AND next_attempt_at <= $2
          ORDER BY next_attempt_at LIMIT $3 FOR UPDATE SKIP LOCKED)
RETURNING d.*;
```

### 6.5 What Phase 2 builds
| Part | Slice 1 | Later |
|---|---|---|
| `DomainEvent`, `PendingEvent`, `defineEvent`, `EventCatalogue`, the contracts test | Built | — |
| `OutboxWriter`, `identity.outbox` | Built | — |
| Relay, `EventBus` port, in-process adapter | Built. With no subscription the adapter has nothing to write; tests use a recording bus | — |
| `platform.event_delivery`, subscriptions, fan-out, dispatcher, back-off, dead letter, `<module>.inbox`, `runOnce`, the event entry adapter | Specified (6.4, PM3, PM4) | Slice 3, in the same change as the first subscription: identity's mail handlers subscribe to identity's own events (identity design, section 9). That slice confirms or corrects 6.4 |
| Outbox pruning | None: rows are kept; they hold identifiers only | With the first subscriber that needs history (a replay from the kept rows), or at one million rows |

Identity consumes no other module's event in Phase 2 (brief section 6), but subscribes to its
own to send mail. Splitting slice 1 (publish path) from slice 3 (delivery side) is a reading of
ADR-0015 decision 3 and ADR-0006 decision 4: **PA1**. Earlier events are not delivered later.

## 7. Scheduler
```ts
interface JobDefinition {
  readonly name: string; // '<module>.<job>'
  readonly every: Temporal.Duration; // a fixed interval; no cron, no wall-clock time
  readonly maxRunMs?: number; // default 60000, at most 600000
  run(context: CallContext): Promise<void>; // calls one use case whose access rule is `system`
}
```
| Topic | Decision |
|---|---|
| Where definitions live | In the owning module's `presentation/jobs/`: a job is an entry point like a controller, so foundations rule 9 of 8.2 covers it unchanged (PA6). Modules register with `JobRegistry` (`platform/scheduler/`) at bootstrap: the first segment is the module, a duplicate fails boot, sealed. A platform job sits beside the platform code it serves |
| Who runs | The `worker` role only (ADR-0006 decision 7). Each worker ticks every `every`, first after a random part of the interval |
| Per Market | A run iterates `MarketRegistry.hostedMarketIds()`. For each: `MarketContextFactory.forMarket`, the system actor, a newly generated correlation id, `createCallContext`, then `run(context)`. A failure is logged with job, Market and correlation id, and the next Market still runs (foundations 5.1) |
| Overlap across processes | One runner per job (ADR-0006 decision 7): the runner holds `pg_try_advisory_xact_lock(key)` in a transaction of its own on `PrismaRoot` for the whole run, and skips the tick when the lock is taken. The transaction-scoped form, because Prisma's pool gives no session affinity outside a transaction: a session lock taken through the pool was "released" on another connection and stayed held (verified). **PA3** |
| Lock key | The first 8 bytes of SHA-256 over `mondapac.job:<name>`, as a signed 64-bit integer (`node:crypto`) |
| Limits | The lock transaction ends at `maxRunMs`, and a lost connection ends it too. The lock saves cost and noise; it is not a correctness control: **every job is safe to run twice and concurrently** |
| Schedule state | None is stored: with N workers a job runs at most N times per interval, never two at once. No table |
| Zone-aware work | A "daily" rule is a frequent job whose use case finds the parties whose local boundary has passed (ADR-0005 decision 6). The runner knows no time zone |
| Batches | Bounded batches, one unit of work per batch (3.1 row 8), until nothing is left or the time is spent |
| Phase 2 | The runner lands in slice 1 (ADR-0015 decision 3). Validity never depends on a job: expiry is decided at read time against `Clock` (brief section 6), and a job only deletes what is already invalid: expired sessions, expired or used one-time links, expired invitations. Identity's jobs (its 12.2): `identity.purge-expired`, hourly, slice 2; `identity.purge-unverified-accounts`, daily, slice 3. No platform job in Phase 2 |
| Later | Pruning of delivered and inbox rows (before the first deployed environment); the audit sealer (own design, slice 6); CERT-14/15, SUB-06, HLT-03 at their modules' gates |

## 8. `APP_ROLE`
| Topic | Decision |
|---|---|
| Variable | Not in the code today: `AppConfig` has no role and `main.ts` always listens. `APP_ROLE`: `api` or `worker` (ADR-0006 decision 4, ADR-0008 decision 1). Required, validated by `loadAppConfig`, no default: a worker that silently started as `api` would relay nothing and nothing would fail (PA7) |
| `api` runs | The HTTP server: guards, controllers, docs. It writes outbox rows; it never relays, dispatches or schedules |
| `worker` runs | The relay and the scheduler; from slice 3 the dispatcher, later the audit sealer. No HTTP listener, so no API surface |
| Shared | **One module graph.** Both roles build the same `AppModule.register()`: every module, the guard array, both authorisation ports (foundations 6.3 row 1), and so the same sealed `PermissionRegistry` (foundations 6.1 row 2), `EventCatalogue` and `JobRegistry`. A use case behaves the same in both. One `DATABASE_URL` and one database role in Phase 2 (PH4) |
| Composition root | `main.ts` branches once. `api`: `NestFactory.create`, `configureApp`, `listen`. `worker`: `NestFactory.createApplicationContext`, shutdown hooks, `WorkerRuntime.start()`. Verified: the application context boots the full graph, runs the lifecycle hooks and has no HTTP server; controllers are constructed but nothing routes to them |
| Who reads the role | `main.ts` and `platform/worker/` only (rule 3 of 12.2). A module never branches on it |
| Starting and stopping | `main.ts` calls `WorkerRuntime.start()`; no lifecycle hook starts a loop, so building the graph in a test starts no timer. `stop()` runs on shutdown: no new pass, up to 10 s for the pass in flight. Safety never depends on a clean stop (6.2) |
| Tests | A test builds the graph with `testAppConfig({ APP_ROLE: 'worker' })` and drives `relay.runOnce()` and `scheduler.runJobOnce(name)` itself. One test per role boots through the real bootstrap function; the CI boot probe also starts a worker and stops it with SIGTERM (PK2) |
| Liveness | In Phase 2 a heartbeat log line per minute. A probe for the worker is decided before the first deployed environment (PK2) |

## 9. "Model to owning module" rule (I14)

| Topic | Decision |
|---|---|
| The map | A generator reads `prisma/schema/*.prisma` (the parser `scripts/check-prisma-boundaries.mjs` already has, moved to a shared file) and writes `apps/api/src/generated/model-map.ts` on `pnpm db:generate`, beside the generated client and git-ignored like it. Per model: owning module (the file name, as today), schema, table, client property name, `scoped` or `exempt` (4.2), relation fields. Per module: its outbox model and, later, its inbox model. Three readers: the guard, the outbox writer and relay, and the check below |
| The rule (ADR-0004 decision 3, ADR-0008 decision 6) | In `apps/api/src/modules/<m>/` and `apps/api/src/platform/`, every reference to a Prisma model names a model owned by the file's own module; `platform/` owns `platform.prisma`. A reference is a property of that name read from a client or transaction value, a `Prisma.<Model>…` type, or an import from the generated `models/` folder. The check parses files with the TypeScript compiler API (installed; no type information needed) and looks only at files that may import Prisma at all: `infrastructure/` and `platform/persistence/` (the existing dependency-cruiser rules keep it out of the rest) |
| The named exception | Files under `platform/persistence/outbox/` may reference the models mapped to the table `outbox` or `inbox` of any module schema, through the map, and nothing else of a module. The reverse holds too: those models are reserved for that folder, so even the owning module writes its outbox only through `OutboxWriter`. Two table names and one path, written in the script |
| Where it runs | In `scripts/check-prisma-boundaries.mjs`, under `pnpm boundaries` and so under `pnpm verify` and CI (ADR-0014 decision 7), with fixtures in `apps/api/test/boundary-fixtures/` asserted by `boundaries.spec.ts`. Not an ESLint rule: the map is generated data and this script already owns the Prisma checks. It also gains the schema-side checks: every model is scoped or declared exempt; `market_id` and `tenant_id` come together; every outbox model has the same fields |

## 10. Aggregate version (I7)

| Topic | Convention |
|---|---|
| Column | Every aggregate root table has `version`: a 32-bit integer, NOT NULL, no default; the insert writes 1 (foundations 3.6) |
| Domain | The aggregate carries `version`. Each state-changing operation raises it by exactly one and records at most one event, whose `aggregateVersion` is the new value: no two events of one aggregate share a version. A change to a child row goes through the root and raises it too |
| Save | One statement: update where `id`, `marketId` and `version` equal the loaded values, writing the new version. Zero rows changed is a stale write (verified: `updateMany` reports 0; `update` throws `P2025`) |
| How it surfaces | The repository throws `StaleAggregateError` (aggregate type and id, nothing else) and the unit rolls back (3.1 row 3). No automatic retry: the decision was made on state that is no longer current |
| At the edge | HTTP: one platform filter answers 409 with a code, for `StaleAggregateError` and `TransactionConflictError` alike; the codes belong to I12 (PN7). Job: logged; the next run picks the work up. Event delivery: retried by back-off |
| Creation races | Two inserts for one natural key are decided by a unique constraint; the repository maps the constraint name (Prisma `P2002`) to its own `Result` error. Never read-then-insert |

## 11. Inputs for Mojtaba (query side only; the tables are his)

| # | Object | What the queries need |
|---|---|---|
| PM1 | `<module>.outbox`, one per module, identical | The eleven envelope fields of ADR-0006 decision 1 (`event_id` as the key, `payload` as `jsonb`, `causation_id` nullable) plus a nullable `published_at`. Queries: insert in the caller's transaction; claim (6.1); mark by `event_id = ANY`; oldest unpublished per Market. Index: partial, `(market_id, event_id) WHERE published_at IS NULL` (verified on PostgreSQL 16, 200,000 rows of which 1,000 unpublished: index scan, no sort, 0.09 ms). Unique `(aggregate_id, aggregate_version)` (I7). No attempt, owner or error column. Not pruned in Phase 2 |
| PM2 | Grants on an outbox | Application role: `INSERT`, `SELECT` and `UPDATE (published_at)` only. Verified with a scratch role: the claim with `FOR UPDATE` and the mark work under the column-level grant; updating `payload` and deleting fail with `42501` |
| PM3 | `platform.event_delivery` (slice 3) | The columns of ADR-0006 decision 4 plus `market_id`, `tenant_id`, the envelope copy, an error code, and the timestamps pruning needs. Key `(event_id, subscriber)`. Queries: fan-out insert ignoring conflicts; claim (6.4); mark by key; list dead rows per Market; delete delivered rows past a retention. Index: partial, `(market_id, next_attempt_at) WHERE status = 'pending'` (verified with 100,000 rows: index scan, 0.8 ms for a claim of 20). Dead letters are rows of this table |
| PM4 | `<module>.inbox` (slice 3: `identity.inbox`) | Key `(event_id, handler)` (ADR-0006 decision 5), `market_id`, `tenant_id`, `processed_at`. Queries: insert ignoring a conflict and reporting whether a row was inserted; delete rows older than a horizon longer than the redelivery window (three hours) plus the retention of delivered rows |
| PM5 | Aggregate root tables | `version integer NOT NULL`, no default, CHECK `>= 1` (10) |
| PM6 | Child tables of a market-scoped parent | Recommended: the foreign key includes `market_id`, so a child cannot belong to another Market than its parent. It keeps nested reads safe (4.1) even if a write ever passed the guard |
| PM7 | Prisma models | One outbox model per module (`@@map("outbox")`), so migrations and the drift check stay Prisma's. Recommended: model names start with the module's name (`IdentityOutbox`), since model names are global. Exemptions: the line of 4.2 |
| PM8 | Scheduler | No table. Advisory lock keys are 64-bit hashes of `mondapac.job:<name>`. To confirm: no clash with the lock Prisma Migrate takes |

## 12. Placement and boundaries
### 12.1 Layout (slice 1)
```
packages/shared-kernel/src/domain-event.ts   DomainEvent, PendingEvent, defineEvent, field kinds
apps/api/src/platform/
  unit-of-work/   UnitOfWork port and token; the error classes of 3, 4 and 10 (no Prisma)
  events/         OutboxWriter and EventBus ports, EventCatalogue
  scheduler/      JobDefinition, JobRegistry, runner, lock key
  worker/         WorkerRuntime: starts and stops the relay and the scheduler
  persistence/    PrismaRoot, PrismaService, the guard, the UnitOfWork implementation,
                  outbox/ (writer, relay, in-process bus; slice 3: dispatcher and inbox writer)
apps/api/src/modules/<m>/domain/events/      event definitions, re-exported by contracts/
apps/api/src/modules/<m>/presentation/jobs/  job definitions; presentation/subscribers/ (slice 3)
scripts/          the model-map generator and the checks of 9
```
The ports sit outside `platform/persistence/` so that `application/` can import them and the rule
`persistence-internals-are-private` stays unchanged (the pattern of foundations 4, row 13).

### 12.2 Boundary rules (foundations rule 9 of 8.2 also covers `presentation/jobs/`, unchanged)
| # | Rule | Tool | What it forbids |
|---|---|---|---|
| 1 | Model ownership (9) | `check-prisma-boundaries.mjs` | A reference to another module's model; any reference to an outbox or inbox model outside `platform/persistence/outbox/` |
| 2 | `persistence-root-is-private` (new) | dependency-cruiser, plus the test on `PersistenceModule` exports (foundations 7, item 4) | `modules/*/infrastructure/` importing anything of `platform/persistence/` but `prisma.service.ts` |
| 3 | `app-role-is-read-in-two-places` (new) | ESLint | `appRole` read outside `main.ts` and `platform/worker/` |
| 4 | `no-raw-sql-or-transaction-in-modules` (new) | ESLint | `$queryRaw`, `$executeRaw`, their `Unsafe` forms and `$transaction` under `src/modules/`. The guard is the run-time control; the lint only fails earlier |

### 12.3 Database errors never reach a log or a response whole
Verified: a CHECK violation (`P2039`) carries the whole failing row in
`meta.driverAdapterError.cause.detail`, and a malformed id (`P2007`) puts the input value in the
message; pino's error serializer copies both. One function in `platform/persistence/` reduces any
Prisma or driver error to its name, Prisma code, SQLSTATE and constraint name, and the logger uses
it for every error it serialises. `meta` and `message` of a database error are never logged,
stored in a dead letter or returned. This answers the open check of I15 (PH3).

## 13. Testing

Database tests: `pnpm test:db`, as the application role, for AU and ZZ (ADR-0003 decision 9).

| What | Kind | Notes |
|---|---|---|
| The guard's decision function over a table of cases (every row of 4.1); `defineEvent` and payload validation; the lock key; the back-off; the conflict classifier on both error shapes | Unit | No database, no Nest |
| **A query without the Market fails.** For every scoped model in the generated map: no `where`; a `where` without `marketId`; the other fixture's Market; `create` with the other Market or another tenant; a nested write; a query with no open unit; raw SQL | Database | Driven by the map, so a new model is covered without a new test. Until identity's tables exist it runs on `AuditLog` |
| UnitOfWork: `ok` commits; `err` and a thrown error commit nothing; nested `run` throws; read-only refuses a write; two serialisable units in conflict both succeed after one retry; the timeout; a unit for AU cannot be used with ZZ's context | Database | Replaces the direct `prisma.auditLog` calls in `apps/api/test/db/platform.db-spec.ts` |
| Outbox: an `err` unit leaves no row; stamping (5.1); an undeclared field, another module's type and a ZZ context in an AU unit are refused | Database | Both fixtures |
| Relay: each row reaches a recording bus and is marked once; two relays at once never publish one row twice; rows of AU and ZZ go out with their own Market | Database | `relay.runOnce()` |
| **Crash between commit and publish.** A unit commits a state change and its outbox row. Relay A claims the row and its bus throws (and, in a second case, its transaction is aborted after publish): the row is still unpublished. Relay B publishes it. Assert: the row is marked once; the recording bus saw the event at least once and, in the second case, twice with the same `eventId` | Database | Proves "no loss" and documents "at least once" |
| Scheduler: two runners and one lock run the job once; a job that fails for AU still runs for ZZ; each run gets the system actor of its Market and its own correlation id | Database | `scheduler.runJobOnce(name)` |
| Version: two saves from one loaded version give one `StaleAggregateError`; HTTP answers 409 | Database, HTTP | With identity's first aggregate |
| Catalog: every `outbox` table has the same columns; a table with `market_id` has `tenant_id`. The event catalogue snapshot (5.3) | Database; contracts test | Extends the catalog test of foundations 9; one checked-in file |
| Roles: `api` and `worker` boot; a missing or unknown `APP_ROLE` fails boot; the worker opens no port; the registries are equal in both. One fixture per rule of 12.2; the error reducer of 12.3 with a failing-row value that must not appear | Unit, boot, fixtures | — |

## 14. Dependencies and evidence

**No new dependency.** Prisma 7 (client extensions, interactive transactions), `pg` through the
adapter, Node's standard library (`node:async_hooks`, `node:crypto`), the TypeScript compiler API
in a script (already installed) and PostgreSQL cover everything here; nothing is requested for the
bundled list of ADR-0018 decision 8.

My checks ran in a scratch copy on Node 24.21.0 (the guard run also on 24.9.0, the ADR-0014
minimum, which slice 0 found cannot run `pnpm install` under `engine-strict`: a question for
Ali, in identity 14.1) with Prisma 7.10.0, `@prisma/adapter-pg` 7.10.0, `pg` 8.23.1, NestJS 12
and PostgreSQL 16.15, on a throwaway database that was dropped afterwards.

| Verified | Used in |
|---|---|
| A client with `$extends` is not an `instanceof PrismaClient`; its transaction client has no `$extends`; `Prisma.TransactionClient` and the extended transaction client are assignable in neither direction (`tsc`, TypeScript 6.0.3) | 3.3 |
| A query extension runs for operations inside an interactive transaction, in that transaction, with the full arguments and with the `AsyncLocalStorage` store visible; interleaved transactions keep their own store. A query returned un-awaited from the transaction callback runs outside the store's scope | 3.2, 4.2 |
| A prototype guard refused all 20 bad cases of 4.1 and accepted the good ones, with no row written for the other Market; `findUnique` accepts `marketId` beside the id | 4 |
| Throwing rolls back; a sentinel carries an `err` result out; every statement of one transaction ran on one backend process. `SET TRANSACTION READ ONLY` works as the first statement (not used: PA5) | 3.1 |
| The transaction timeout does not interrupt a running statement: `P2028` came after the 1.5 s statement finished, and nothing was committed. A callback that returns after the timeout gets `P2028` at commit | 3.1 row 8 |
| A serialisation failure at commit is a bare `DriverAdapterError` (`cause.originalCode` `40001`), not a Prisma known-request error; a deadlock in a statement is `P2034` with `40P01` in `meta` | 3.1 row 7 |
| At run time the transaction client still has `$transaction`, and calling it joins the outer transaction silently. A second transaction with a pool of one fails with `P2028` after the wait limit | 3.1 row 4, rule 4 of 12.2 |
| A session advisory lock through the pool was taken on one connection, "released" on another (`false`) and stayed held. A transaction-scoped lock held in an interactive transaction excludes a second taker and frees on commit; the idle holder has no `backend_xmin`, so it does not hold back vacuum. A role-level `idle_in_transaction_session_timeout` kills that holder unless the lock transaction sets it to 0 with `SET LOCAL` | 7, PK1 |
| `FOR UPDATE SKIP LOCKED`: two concurrent claims were disjoint; a claim that fails before commit leaves its rows unpublished; both claim statements use their partial index | 6, 11 |
| An application context of the full `AppModule` boots, runs lifecycle hooks and has no HTTP server. Where database errors carry row values | 8, 12.3 |

**Not verified:** PostgreSQL 17 (compose and CI run 17; nothing above is specific to 16); the
real application role of foundations slice 0 item 7, which does not exist yet; the rules of 12.2
against fixtures; the map generator, the ownership check and `defineEvent` (not prototyped).

## 15. Trade-offs and what to revisit

| Choice | Cost accepted | Revisit when |
|---|---|---|
| No nesting of units | A use case cannot read another module's facade in the middle of its transaction | A real use case needs it: then a designed independent unit with a pool budget |
| The use case opens its own unit (T1) | "At most one read-write `run`" is a review rule | The access-rule mechanism can count runs cheaply |
| The guard refuses nested writes and raw SQL | Repositories write table by table; no row lock until the raw helper exists | The first repository that needs raw SQL (4.2) |
| The guard lives in the client, not in the database | A raw statement written later can still forget the Market; review and the two-Market test catch it | Hassan asks for a database control: row-level security with a per-transaction setting, as its own design with Mojtaba |
| Read-only work still opens a transaction | Two extra round trips per read-only unit, including the session and permission reads of every authenticated request (ADR-0018 decision 2) | Measurements show it (PA5) |
| READ COMMITTED by default | An invariant across rows needs a constraint or an explicit `serializable` | A defect is traced to it |
| One outbox per module, polled per Market | Idle polling is modules × Markets small queries every 500 ms | Many modules publish: wake the relay with `LISTEN`/`NOTIFY`, same tables |
| No ordering guarantee | Every consumer handles stale and missing versions | A consumer needs strict order per aggregate: a new ADR |
| The consume side lands in slice 3, not slice 1 (PA1) | 6.4 may change when slice 3 is built; an event published before a subscriber exists is not delivered to it | Slice 3 |
| Stateless scheduler; the lock is not a correctness control | A job may run once per worker per interval and must tolerate overlap | A job must run exactly once per period (payouts, Phase 5): a schedule-state table |
| Closed payload vocabulary | A new kind of field is a kernel change | `Money` in an event, with `Money`'s own trigger |
| `SubjectKeyService` works inside the unit (foundations 4, row 8) | With a deployed key service, unwrapping a key is a network call inside a transaction, the one exception to row 5 of 3.1 | The deployed `KeyWrapper` adapter is designed |

## 16. Open points

### (a) Decisions for Ali (cto)
| # | Question | Recommendation |
|---|---|---|
| PA1 | **Touches ADR-0015 decision 3 (row "UnitOfWork, outbox relay, event bus, scheduler, `APP_ROLE`") and ADR-0006 decision 4.** Is the row met when the bus port, the in-process adapter and the whole publish path land in slice 1, while delivery to subscribers (6.4) lands in slice 3 with identity's mail handlers, the first subscription? | Yes, recorded as a note on ADR-0015 decision 3 through an ADR, as ADR-0020 did: slices 1 and 2 have no subscriber, and ADR-0015 itself designs each foundation next to its first consumer. `event_delivery` and `identity.inbox` join Mojtaba's design now. Otherwise 6.4 is built in slice 1 with a test-only subscriber: one more PR in the largest slice |
| PA2 | T1 (3.4): who calls `UnitOfWork.run` | Option A, the use-case body |
| PA3 | **Touches ADR-0006 decision 7**, which names `pg_try_advisory_lock`. The design uses `pg_try_advisory_xact_lock` inside a transaction (7). The alternative that keeps the ADR's function is a dedicated `pg` connection held by the scheduler outside Prisma's pool | The transaction-scoped lock, confirmed as a reading of decision 7: one runner per job by advisory lock, and no connection handling of our own |
| PA4 | The `AsyncLocalStorage` store also holds the `MarketContext` the unit was opened with (3.2). Is that inside foundations 5.2 ("never the source of the Market for business code")? | Yes: it is a comparison value read only in `platform/persistence/`. Without it the guard can check presence only |
| PA5 | **Touches ADR-0004 decision 5.** Read-only work opens a transaction, as the decision says. A scope without a transaction would do the same job at READ COMMITTED and save two round trips per read | Keep the transaction now; decide again with measurements |
| PA6 | Job and subscriber definitions live in `presentation/` (ADR-0008 decision 2 lists controllers there) | Yes: they are entry points; no new folder kind |
| PA7 | `APP_ROLE` is required with no default (8). It changes `.env.example`, the CI boot probe and the start instructions (shared files) | Required |
| PA8 | Slice 1 as four PRs, in this order: (1) UnitOfWork, guard, model map and ownership check, tested on `AuditLog`; (2) events, outbox writer, relay, bus port, scheduler, `APP_ROLE`; (3) `SubjectKeyService`, `ActorContext` and `CallContext`, the access-rule mechanism with its CI check (identity design 5.2, 12.1); (4) identity's registration. Rule 13 of `CLAUDE.md` says one slice, one PR; ADR-0015's "in the same change as" is read as "no later than" | Four PRs; QC checks the triggers on the last |

### (b) Questions for Hassan (security-tester)
| # | Question |
|---|---|
| PH1 | Is the rule set of 4.1 enough for I5: equality on `where` and `create`, nested writes and raw SQL refused, no access outside a unit? Must `where` name the tenant as well? |
| PH2 | The payload vocabulary (5.3): is an `id` that points at a person acceptable without limit, and is the registry check on `permissionKey` enough for R5? |
| PH3 | The error reducer of 12.3: is name, Prisma code, SQLSTATE and constraint name the right set to keep? |
| PH4 | One database role for both `APP_ROLE`s in Phase 2. The worker needs `UPDATE (published_at)` on outboxes and the api does not: is a separate worker role required before the first deployed environment? |

### (c) Inputs to the identity design
| # | Input |
|---|---|
| PN1 | The commit rule (3.1 row 3): `err` commits nothing. A refusal that must persist something is an `ok` outcome of the unit. Followed: identity 6.3 (failed sign-in) |
| PN2 | The order of a use case (3.1 row 5): slow work and facade reads, then at most one read-write unit; a read-only unit may come first. Nothing external happens inside a unit. Decided: identity sends mail by subscribing to its own events (its section 9), which triggers 6.4 in slice 3; the alternative, a mail table read by a job, was not taken |
| PN3 | Repositories take a `MarketContext`, call `tx(market)` on every call and put `marketId` in every `where`, reads by id included; no nested writes (4.1). `Authenticator` and `AuthorisationCheck` each open their own unit and are never called inside one (3.4) |
| PN4 | Jobs: the name, interval and slice of each (answered: 7 and identity 12.2); validity never depends on a job; every job tolerates a double run |
| PN5 | A use case that needs a row lock or other raw SQL brings the raw helper (4.2) in its slice. Decided: identity's "last one" rules (R3) use `isolation: 'serializable'` instead (its 5.5) |
| PN6 | Events: declared with `defineEvent` in `domain/`, re-exported from `contracts/`, registered at bootstrap; payload kinds from 5.3 only; one event per version step (10); the module binds `OutboxWriterFactory.forModule('identity')`. Catalogue: identity 8.2 |
| PN7 | Which tables are aggregate roots (each gets `version`): identity 2.1. The two 409 codes (I12): `conflict.stale` and `conflict.retry` (identity 5.2) |

### (d) Points for Kazem (devops-engineer)
| # | Point |
|---|---|
| PK1 | `statement_timeout` and `idle_in_transaction_session_timeout` on the application role, with Mojtaba: the only bound that interrupts a running statement (3.1 row 8). The scheduler's lock transaction sets its own idle timeout to 0 (verified) |
| PK2 | The worker in the CI boot probe and in local development (`pnpm dev:worker`); a liveness probe for the worker before the first deployed environment |
| PK3 | Alerting on the outbox age line (6.2) and, later, on dead letters: log-based, Phase 7 |

## 17. Follow-up changes

This document changes no other file. After approval these change, each by its owner, in a PR of
its own where `docs/process/parallel-tracks.md` calls the file shared:

| File | Change | When |
|---|---|---|
| `docs/design/domain/platform-foundations.md` | Rows 5 to 7 of section 2 and inputs I4, I5, I7, I14 point here; the stamping sentence of 3.6; the layout of 8.1 | After G2 (Mohammad) |
| A new ADR (next free number on the board), drafted by Ali, with inline notes on ADR-0015 decision 3 and ADR-0006 decision 7 | PA1 and PA3, if accepted | With the G2 approval |
| `docs/design/data/platform.md` and identity's data design | Mojtaba: the outbox table and grants (PM1, PM2); the sentence of section 1 on outbox, inbox and `event_delivery` | Identity G2 |
| `apps/api/src/platform/persistence/` (`prisma.service.ts`, `persistence.module.ts`, `database-probe.ts`), new `platform/unit-of-work/`, `events/`, `scheduler/`, `worker/` | 3 to 8 | Slice 1 |
| `apps/api/src/platform/config/app-config.ts` and its spec, `apps/api/src/main.ts`, `apps/api/test/support/test-config.ts`, `apps/api/src/platform/logging/logging.module.ts` | `APP_ROLE`; the role branch; the error reducer of 12.3 | Slice 1 |
| `packages/shared-kernel/src/domain-event.ts`, `index.ts` | `DomainEvent`, `PendingEvent`, `defineEvent` | Slice 1 |
| `scripts/check-prisma-boundaries.mjs`, a new generator script, root `package.json` (shared: `db:generate`, `postinstall`, `dev:worker`), `apps/api/package.json` | The model map and the checks of 9; the worker script | Slice 1 |
| `apps/api/.dependency-cruiser.cjs`, `eslint.config.mjs` (shared), `apps/api/test/boundaries.spec.ts`, `apps/api/test/boundary-fixtures/`, `apps/api/test/db/platform.db-spec.ts` | Rules 1 to 4 of 12.2; audit rows are written inside a unit of work; the tests of 13 | Slice 1 |
| `prisma/schema/base.prisma` (`schemas`), `prisma/schema/identity.prisma`, a migration with `down.sql` | The first module schema and `identity.outbox` (Mojtaba signs off); `platform.event_delivery` and `identity.inbox` | Slice 1; slice 3 |
| `.env.example`, `.github/workflows/ci.yml`, the Commands text of `CLAUDE.md` (all shared) | `APP_ROLE`; the worker in the boot probe; `pnpm dev:worker` | Slice 1 (Kazem for CI) |
