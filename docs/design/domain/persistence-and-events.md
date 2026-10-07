# Persistence and events — UnitOfWork, outbox, relay, event bus, scheduler, market guard

**Author:** Mohammad (software-architect) — 2026-10-03
**Status:** Draft for identity G2 review — not approved
**Ground truth:** ADR-0003 (decisions 2, 7, 9), ADR-0004 (decisions 3, 4, 5, 7), ADR-0005
(decisions 5, 6), ADR-0006 (all), ADR-0008 (decisions 2, 5, 6), ADR-0009 (decision 6), ADR-0015
(decisions 2, 3, 5), ADR-0018 (decisions 2, 3, 4, 9), ADR-0020 (decisions 6, 8);
`docs/design/domain/platform-foundations.md` (sections 2, 3.6, 3.7, 5, 7, 8; inputs I4, I5, I7,
I8, I14, I15); `docs/design/data/platform.md`; `docs/modules/identity/brief.md` (section 11
row 1; AC 12); the code in `apps/api/src/platform/persistence/`, `prisma/schema/`,
`prisma.config.ts`, `scripts/check-prisma-boundaries.mjs`, `apps/api/.dependency-cruiser.cjs`,
`eslint.config.mjs`, `apps/api/test/`.

## 1. Scope

This is the platform document that platform-foundations section 1 names for I4 and I5, plus
I14. It answers rows 5, 6 and 7 of platform-foundations section 2, all of which land in
identity slice 1 (brief section 11 row 1).

- **Decided here (binding once G2 approves):** the UnitOfWork (2), the market guard (3), the
  outbox and envelope stamping (4), relay, event bus, inbox, retries and dead-letter (5),
  `APP_ROLE` and the worker entry adapters (6), the scheduler (7), the model-ownership rule (8),
  the slice 1 items (9).
- **Logical only; physical design by Mojtaba in identity's G2 data design:** the outbox, inbox,
  delivery and job-state tables (10). Column names below are working names.
- **Not here:** what identity publishes or consumes (event names and payloads are identity G2;
  brief section 7), the audit writer (slice 6, its own design), the access-rule wrapper (I2).

Signatures appear only where the signature is the contract. "Throws" means a programmer or
infrastructure error; expected outcomes are `Result` values (platform-foundations 3.5).

## 2. UnitOfWork (ADR-0004 decision 5; I4)

### 2.1 Contract
```ts
// apps/api/src/platform/persistence/unit-of-work.ts — no Prisma type in this file
interface UnitOfWork {
  run<T, E>(ctx: CallContext, work: () => Promise<Result<T, E>>): Promise<Result<T, E>>;
  read<T>(market: MarketContext, work: () => Promise<T>): Promise<T>;
}
const UNIT_OF_WORK: unique symbol; // injection token; one bound instance per module (2.4)
```

| # | Rule |
|---|---|
| 1 | `run` opens one Prisma interactive transaction and binds it, the `CallContext` and the owning module to an `AsyncLocalStorage` scope private to `platform/persistence/`. Everything written by the work (module rows, outbox rows, subject-key rows, later audit rows) commits or rolls back together |
| 2 | **Opened with a context.** `run` takes the `CallContext` (the outbox writer and later the audit writer need the actor and correlation id: platform-foundations 5.2 rule 2); `read` takes a `MarketContext` only, like repositories. There is no overload without a context and no ambient default |
| 3 | **Refuses an unminted context.** Both throw `UnmintedContextError` unless `isMinted` holds for the context and each of its parts (C2, platform-foundations 3.7). This runs before a connection is taken |
| 4 | **An error `Result` commits nothing (recommended in I4; decided).** If `work` resolves to `{ ok: false }`, the transaction is rolled back (internally by throwing a private rollback signal inside the Prisma callback) and the same `Result` is returned. If `work` throws, the transaction rolls back and the error is rethrown unchanged. Only `{ ok: true }` commits |
| 5 | **Nesting: refused.** `run` inside an open `run` or `read` scope throws `NestedUnitOfWorkError`. ADR-0004 decision 5 says facade calls never join the caller's transaction, and a silently joined transaction is exactly that. Sequential units in one use case are allowed (2.3) |
| 6 | **`read` inside an open scope** opens its own non-transactional scope for its module and Market and does not see the caller's uncommitted rows. This is how a facade query called from inside another module's `run` behaves. Exception: platform stores (subject keys, platform-foundations 4 row 8) read through the open transaction by design |
| 7 | **Isolation: `READ COMMITTED`** (PostgreSQL default), set explicitly on every transaction. Concurrent updates of one aggregate are caught by the optimistic lock on `aggregate_version` (I7): an update `WHERE id = ? AND market_id = ? AND aggregate_version = ?` that touches 0 rows returns a `concurrency.conflict` error `Result`. Uniqueness (email per Market and population, ADR-0018 decision 3) is a unique constraint, not an isolation level |
| 8 | **Timeouts:** `maxWait` 2 s, `timeout` 5 s for `run` (Prisma interactive transaction options); job runs pass their own timeout (7.1). A timeout throws and rolls back. No I/O other than the database inside `run` (no mail, no HTTP): side effects leave through the outbox |
| 9 | **Logging:** the scope adds `module` and the correlation id to log lines; never values |

### 2.2 Options considered
| Topic | Option | For | Against | Choice |
|---|---|---|---|---|
| Error Result | A. Rollback on error `Result` | "Expected failure" never half-writes; outbox rows of a rejected command never escape | A record of the failure itself (I8) needs a second, sequential unit | **A** |
| | B. Commit whatever was written | One unit can record its own failure | Every use case must remember not to write before failing; an event of a rejected command could be published | — |
| Nesting | A. Refuse | Matches ADR-0004 decision 5; no hidden coupling | A module cannot call another module's writing facade inside its own unit (it must use an event, ADR-0008 decision 5) | **A** |
| | B. Join outer transaction | Convenient | Breaks ADR-0004 decision 5 and extraction | — |
| | C. Savepoint / new transaction | Isolates inner work | A second connection per call (pool exhaustion, self-deadlock) or partial commits | — |
| Isolation | `READ COMMITTED` + optimistic lock | No retry storms; the version column is needed for events anyway (I7) | Read skew possible inside one unit; repositories must not read-then-decide without the version check | **Chosen** |
| | `SERIALIZABLE` | Strongest | Serialization failures need generic retry, which conflicts with "an error Result commits nothing" semantics and with non-idempotent work | Revisit per use case only with a design note |

### 2.3 Consequences for identity (inputs to the identity design)
- A failed sign-in that must be recorded (brief section 9; I8) uses two sequential units: the
  attempt returns its error `Result` (nothing commits), then a second `run` writes the sign-in
  record. Never nested.
- Who calls `run`: the use case in `application/`, explicitly. Option B, the access-rule wrapper
  (I2) opening the unit implicitly, was rejected: queries want `read`, some use cases need two
  sequential units, and the wrapper must decide access before any transaction is opened
  (platform-foundations 6.4 row 4).

### 2.4 How repositories and platform stores get the transaction client
```ts
// apps/api/src/platform/persistence/scoped-prisma.ts — importable by modules/<m>/infrastructure/
interface ScopedPrisma { client(market: MarketContext): GuardedTransactionClient }
```
| # | Rule |
|---|---|
| 1 | A repository receives a `MarketContext` (platform-foundations 5.2 rule 2) and calls `client(market)`. It throws `NoUnitOfWorkError` if no scope is open, and `MarketScopeMismatchError` if `market` differs from the scope's Market (compared by `marketId` and `tenantId`). It returns the guarded client of the scope: the transaction client inside `run`, the guarded base client inside `read` |
| 2 | Every database access by a module goes through a scope, reads included. There is no unscoped client for modules: `PrismaService` becomes private to `platform/persistence/` (8.3) |
| 3 | The returned client refuses `$transaction`, `$connect`, `$disconnect` and `$extends`; only the UnitOfWork opens transactions |
| 4 | Each module's Nest module binds `UNIT_OF_WORK` and `ScopedPrisma` through a factory that fixes the owning module name (`PersistenceModule.forModule('identity')`), so a scope always knows its module (used by 3.4 and 4.3) |
| 5 | Platform stores (`SubjectKeyStore`, `OutboxWriter`, later the audit writer) live in `platform/persistence/` and read the scope directly; they also refuse to write without an open `run` scope |

## 3. The `market_id` guard (ADR-0004 decision 3; I5)

### 3.1 Presence or equality — decided: equality
| Option | For | Against |
|---|---|---|
| A. Presence: `market_id` appears in the top-level `where` (ADR-0004 decision 3 text) | Simple; catches a forgotten filter | `MarketContextFactory` can mint any hosted Market (platform-foundations rule 5 of 8.2); a value from input or a wrong variable passes. Does not cover `create` |
| **B (chosen). Equality with the scope's Market, in `where` and in written data** | Catches the wrong Market, not only a missing one; covers creates. Required by Hassan, recommended by Mojtaba | Needs the scope (2.4): every access must be in a unit, which this design requires anyway |

B is stricter than ADR-0004 decision 3 and contradicts nothing in it.

### 3.2 Coverage per operation (default deny)
The guard is a Prisma query extension (`$allModels.$allOperations` plus the client-level raw
operations), applied to the one client that modules can reach. A model is market-scoped if it
has a `marketId` field; the set comes from the generated model map (8.1). A model without
`marketId` must be on a named list in the generator (empty today: `AuditLog` is market-scoped),
otherwise generation fails.

| Operation (market-scoped model) | Required |
|---|---|
| `findUnique(OrThrow)`, `findFirst(OrThrow)`, `findMany`, `count`, `aggregate`, `groupBy`, `update`, `updateMany(AndReturn)`, `delete`, `deleteMany` | Top-level `where.marketId` is a string, or `{ equals: string }`, equal to the scope's `marketId`. Not inside `AND`/`OR`/`NOT`, not `in`, not `not`. `findUnique` uses Prisma's extended unique where (`{ id, marketId }`) |
| `create`, `createMany(AndReturn)` | Every `data` element has `marketId` equal to the scope's Market and `tenantId` equal to the scope's tenant |
| `upsert` | Both rules: `where` as above, `create` as above |
| `update*`, `upsert.update` data | `marketId` and `tenantId` absent: they are immutable |
| Nested writes | **Refused.** Any relation write operator (`create`, `createMany`, `connectOrCreate`, `connect`, `set`, `disconnect`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`) on a relation field inside `data` is rejected, using the relation fields listed in the generated map. Repositories write child rows with their own statements in the same unit. Nested **reads** (`include`, `select`, relation filters) are allowed: relations stay inside one schema (ADR-0004 decision 3) and the parent row's Market is checked |
| Any other or future operation name | Refused (a Prisma upgrade adding an operation fails closed and fails the guard's exhaustive test) |
| Non-market-scoped model | Passes (none exist today) |

Recommendation to Mojtaba (physical, his call): foreign keys inside a module schema include
`market_id` (composite with the parent key), so a child can never point at a parent of another
Market even through a bug in this guard.

### 3.3 Raw SQL policy
| Form | Rule | Enforced by |
|---|---|---|
| `$queryRawUnsafe`, `$executeRawUnsafe` | Forbidden everywhere | Guard throws in every scope; ESLint `no-restricted-properties` in all of `apps/api/src` |
| `$queryRaw`, `$executeRaw` (tagged) in `modules/` | Forbidden. A module that needs raw SQL gets a named exception in the ESLint rule, approved in its design, and the SQL must bind `market_id` from the `MarketContext` as a parameter (reviewed, not machine-checked) | ESLint `no-restricted-syntax` on these members under `src/modules/**`; guard refuses raw in a module scope unless the module is on the exception list |
| Tagged raw in `platform/persistence/` | Allowed for the relay and delivery claims (`FOR UPDATE SKIP LOCKED`, which Prisma cannot express), advisory locks, and `DatabaseProbe`. Identifiers (schema names) come only from the generated map and are validated against `^[a-z][a-z_]*$` before `Prisma.raw` | Review; the probe and claim files are listed in 8.3 |
| TypedSQL (`$queryRawTyped`) | Not used; refused by default deny | Guard |

### 3.4 Runtime ownership check (second layer for I14)
In a module scope the guard also refuses a model whose owning module (generated map) is not the
scope's module. Platform models (`platform` schema) are refused in module scopes: modules reach
them only through platform stores. Cost: one map lookup per query. It makes the static rule of
8.2 fail closed at run time too.

### 3.5 Failure mode
A violation throws `MarketGuardViolation` with `{ code, model, operation }` only, where `code`
is one of `market.where-missing`, `market.where-mismatch`, `market.data-mismatch`,
`market.immutable`, `nested-write.refused`, `raw.refused`, `model.not-owned`,
`operation.unknown`. Never the argument values (I15). It is a programmer error: the unit rolls
back, HTTP answers 500, the worker treats it like any exception (5.4). The guard **never adds**
`marketId` itself: auto-injection would turn a missing filter into silently correct-looking
code, against "unscoped queries fail" (ADR-0003).

### 3.6 `PrismaService extends PrismaClient` must change shape
`$extends` returns a new client object; a class that extends `PrismaClient` cannot become the
extended client. Decision:

| Provider (all in `platform/persistence/`) | What | Visible to |
|---|---|---|
| `BasePrismaClient` | `new PrismaClient({ adapter: new PrismaPg(...) })` built in a factory provider; disconnect on shutdown (today's `onModuleDestroy`) | `platform/persistence/` only: `DatabaseProbe`, relay and delivery claims, scheduler locks |
| Guarded client | `base.$extends(marketGuard(scopeStore, modelMap))`; transactions are opened on it, so the transaction client carries the extension | Only through `ScopedPrisma` and the UnitOfWork |
| `PrismaService` | Removed as a class (or kept as an alias of the base token during the PR); no module imports it after slice 1 | — |

**To verify in item P1** (Prisma 7.10 with `@prisma/adapter-pg`): the query extension runs for
operations on the interactive-transaction client of the extended client; client-level raw
operations reach the extension; `isolationLevel` is honoured through the adapter. If any fails,
the guard moves into a wrapper around the transaction client (same rules, same tests) and this
section is updated; no new dependency either way.

### 3.7 Tests (both fixtures, AU and ZZ)
- Unit: the guard function against a fake `query` callback, one case per row of 3.2 and 3.3,
  plus an exhaustive test over Prisma's operation list (any operation without a rule fails).
- Database (`pnpm test:db`, as the application role): in a ZZ unit, reading, updating and
  deleting an AU row by id is refused (`where-mismatch`); creating a row with `marketId: 'AU'`
  is refused; a missing `marketId` is refused; a nested create is refused; `marketId` in update
  data is refused; `$queryRawUnsafe` is refused; nothing was written in each case. The same
  cases with the fixtures swapped. `ScopedPrisma.client` outside a unit and with the other
  Market throws. Run for every entry of `TEST_MARKETS`.

## 4. Outbox (ADR-0006 decisions 1, 2, 6; I4, I7)

### 4.1 Table `<module>.outbox` (logical; slice 1 creates `identity.outbox`)
| Column | Meaning |
|---|---|
| `event_id` | PK, UUIDv7 from `IdGenerator` |
| `market_id`, `tenant_id` | From the scope's `MarketContext`; NOT NULL, no default (platform-foundations 3.3) |
| `type`, `aggregate_type`, `aggregate_id`, `aggregate_version` | Envelope fields (platform-foundations 3.6); `aggregate_version` 32-bit, >= 1 |
| `occurred_at` | From `Clock` |
| `correlation_id`, `causation_id` | `causation_id` null unless written while handling an event |
| `payload` | `jsonb` object, validated against the registered contract |
| `published_at` | Null until the relay has fanned the row out; set from `Clock` |

Index need: unpublished rows per Market in `(occurred_at, event_id)` order (a partial index on
`published_at IS NULL` leading with `market_id` is the likely shape; Mojtaba decides). Rows are
not immutable: the relay sets `published_at` and a purge job deletes old published rows (7.3).
No personal data by contract (4.4); AC 12.

### 4.2 Who stamps the envelope — decided: the outbox writer, except the version
| Field | Stamped by | Why |
|---|---|---|
| `type`, `aggregate_type`, `aggregate_id`, `payload` | The aggregate (domain) records a pending event | Domain facts |
| `aggregate_version` | The aggregate: the version after the change, the same value written to its optimistic-lock column (I7) | Only the aggregate knows it; no two events of one aggregate share a value |
| `event_id` | Outbox writer, `IdGenerator` | Keeps ids out of `domain/` |
| `occurred_at` | Outbox writer, `Clock.now()` at append | One time source; the domain has no clock access (rule 4 of 8.2) |
| `market_id`, `tenant_id`, `correlation_id` | Outbox writer, from the scope's `CallContext` | The domain cannot forge or forget them |
| `causation_id` | Outbox writer, from the scope: the event entry adapter (6.2) opens the unit with the consumed `event_id` as a platform-internal scope attribute | No change to the kernel `CallContext` |

| Option | For | Against |
|---|---|---|
| **A (chosen). Aggregate records facts + version; writer stamps the rest** | Domain stays free of time, ids and context; market and correlation cannot disagree with the unit | Domain events are "pending" until appended; `occurredAt` is the append instant, a few ms after the change |
| B. Aggregate builds the full envelope | One object end to end | `domain/` would need `Clock`, `IdGenerator` and the `CallContext`; forging market is possible |

```ts
// shared-kernel (slice 1): PendingDomainEvent = { type, aggregateType, aggregateId,
//   aggregateVersion, payload }; DomainEvent = the full envelope of platform-foundations 3.6
interface OutboxWriter { append(events: readonly PendingDomainEvent[]): Promise<void> } // platform
```
`append` throws unless a `run` scope is open (so the row is in the same transaction as the
state change, ADR-0006 decision 2), unless each `type` starts with the scope's module name and
is a registered contract, and unless the payload passes that contract's schema. It writes
through the module's `OutboxTable` adapter (a few lines in `modules/<m>/infrastructure/`
using the module's own Prisma model), so the guard and the ownership rule apply unchanged.

### 4.3 Contracts and the payload test (ADR-0006 decision 6; platform-foundations 3.6)
- Each publishing module declares `EventContract { type, schema }` constants in its
  `contracts/`, with `zod` schemas (`zod` is already an `apps/api` dependency) and registers
  them at bootstrap in a sealed `EventContractRegistry` in `platform/` (same rules as the
  permission registry, platform-foundations 6.1 rows 1 and 2: boot fails on a duplicate, a
  malformed type, or a type whose first segment is not the registering module).
- **Contracts test (no free strings).** Walks every registered schema. Allowed leaves:
  `z.uuid()` ids, `z.enum`/`z.literal`, `z.iso.datetime()` instants, booleans, integers with
  `|n| <= 2^53 - 1`, and objects/arrays of these. Any other string schema fails the test, as do
  `z.any`, `z.unknown`, records with free keys, and optional fields with no default meaning.
  Hassan reviews each contract (personal data cannot be detected by type alone).
  To verify in item P4: zod 4's schema introspection is stable enough for the walk; fallback is
  a declared field list next to each schema, checked against the schema in the same test.
- Versioning stays ADR-0006 decision 6 (`.v2` plus a period of publishing both).

### 4.4 Ordering guarantees
| Guarantee | Yes / no |
|---|---|
| Event committed iff state change committed | Yes (same transaction) |
| Delivery at least once | Yes |
| Order across aggregates, Markets or modules | No (ADR-0006 decision 3) |
| Order within one aggregate | No. The relay claims in `(occurred_at, event_id)` order as best effort; consumers use `aggregate_version` to drop stale events |
| Exactly once per handler | Effectively, through the inbox (5.3) |

## 5. Relay, event bus, inbox, retries, dead-letter (ADR-0006 decisions 3 to 5)

### 5.1 Relay
Runs only in the `worker` role (6.1). Every poll (500 ms; ADR-0006 target under 1 s), for each
registered outbox (generated map) and each hosted Market, in one transaction on the base client:

1. claim up to 100 rows `WHERE market_id = $market AND published_at IS NULL ORDER BY
   occurred_at, event_id FOR UPDATE SKIP LOCKED` (tagged raw, 3.3);
2. `EventBus.publish(envelopes)` — the MVP adapter inserts one delivery row per subscriber of
   each type, `ON CONFLICT DO NOTHING`, in the same transaction;
3. set `published_at` from `Clock`; commit.

Per-Market iteration keeps "every query names its Market" true for platform code too; the cost
is one small query per Market per poll. Several workers are safe (`SKIP LOCKED`). Events of a
type with no subscriber are marked published with no delivery row (expected in slice 1:
nothing consumes identity's events yet).

### 5.2 Event bus (in process, no broker)
```ts
interface EventBus { publish(events: readonly DomainEvent[]): Promise<void> } // port, platform
```
MVP adapter: the durable in-process bus of ADR-0006 decision 4 (fan-out to
`platform.event_delivery`). Subscribers are declared by consuming modules
(`{ type, handler: '<module>.<name>', handle(ctx, event) }`) and registered at bootstrap in a
sealed `SubscriberRegistry` (same seal rules as 4.3; a handler name starts with its module).
Handlers import event types only from the publisher's `contracts/` (ADR-0006 decision 6). A
broker later is another `EventBus` adapter (ADR-0006 decision 8); outbox and inbox do not change.

### 5.3 Delivery worker and inbox
| Step | What happens |
|---|---|
| Claim | Per hosted Market, a short transaction: up to 20 rows `WHERE market_id = $m AND status = 'pending' AND next_attempt_at <= $now (Clock) AND (locked_until IS NULL OR locked_until < $now) FOR UPDATE SKIP LOCKED`; set `attempts = attempts + 1`, `locked_until = now + 60 s`; commit. Counting the attempt **before** running bounds a handler that crashes the process (poison event) |
| Context | The event entry adapter (6.2) resolves the envelope's Market through `MarketContextFactory`, mints the system actor and a `CallContext` with the envelope's correlation id |
| Run | One `run` unit for the consuming module, with `causation_id` = the event id. First statement: insert `(event_id, handler)` into `<module>.inbox` through the module's `InboxTable` adapter (`createMany` with `skipDuplicates`; 0 rows = already processed: skip the handler). Then the handler. Then mark the delivery `done` (platform store, same transaction, only if `locked_until` still matches the claim) |
| Inbox | `<module>.inbox(event_id, handler, market_id, tenant_id, processed_at)`, PK `(event_id, handler)` (ADR-0006 decision 5). It looks redundant while the delivery row is completed in the same transaction; it is kept because it is what makes handlers idempotent under a broker (decision 8) and costs one insert |

### 5.4 Outcomes, retries, dead-letter
| Outcome | Result |
|---|---|
| Handler returns `{ ok: true }` | Commit; delivery `done` |
| Handler returns an error `Result` | The unit rolls back (2.1 rule 4); a second short transaction marks the delivery `rejected` (terminal, no retry) with the error `code`, logged at `warn`. An expected refusal (for example a stale `aggregate_version`) is not a failure to retry |
| Handler throws, or the unit times out | Rollback; delivery stays `pending` with `next_attempt_at = now + min(10 s * 2^(attempts-1), 1 h)` plus up to 20 % jitter, `last_error_code` = the error's class name only (never `message`: driver errors carry values, I15) |
| `attempts` reaches 10 | `status = 'dead'`, `dead_at` set; an `error`-level log line `event.dead-lettered` with `event_id`, `type`, `handler`, `market_id` (no payload). This log line is the alert until metrics exist (Kazem) |
| Envelope Market not hosted here | Dead-lettered at once, code `market.not-hosted` (platform-foundations 5.1) |
| Handler name no longer registered (removed by a deploy) | Dead-lettered at once, code `subscriber.unknown` |
| Lease expired (worker died) | Row becomes claimable again; the inbox prevents double effects |

Redrive (setting a dead row back to `pending`) is an operator routine (I10 pattern), not in
slice 1; until then a documented SQL statement run with the owner role (runbook: Kazem).

## 6. `APP_ROLE` and the worker entry adapters (ADR-0006 decisions 4 and 7; platform-foundations 5.1)

### 6.1 Roles
| | `api` | `worker` |
|---|---|---|
| HTTP listener, guards, controllers | Yes | No: `NestFactory.createApplicationContext` |
| Modules, registries (permissions, event contracts, subscribers, jobs) | All, sealed at boot | All, sealed at boot: the same catalogue in both (platform-foundations 6.1 row 2) |
| Relay (5.1), delivery worker (5.3), scheduler (7) | No | Yes |
| `UnitOfWork`, guard, outbox writer | Yes | Yes |

- `APP_ROLE` is a required variable with no default, values `api` | `worker`, validated in
  `loadAppConfig` like `HOSTED_MARKETS`; `.env.example` documents it with `api`. A missing value
  refuses to start (fail closed, same reasoning as A5's rejection of a defaulted tenant).
- One image, one `main.ts` that branches on the role; `AppModule.register({ role })` adds the
  `WorkerModule` (relay, delivery, scheduler) only for `worker`.
- Several worker replicas are safe (`SKIP LOCKED`, advisory locks). Shutdown: on `SIGTERM` stop
  claiming, finish in-flight units, then disconnect.
- Each process has its own connection pool; an interactive transaction holds one connection for
  its duration. Pool sizes per role are configuration for Kazem (Phase 7); defaults stay.
- Worker liveness has no HTTP endpoint in Phase 2; how a deployed worker is probed is Kazem's
  decision with `infra/` (Phase 7). Local: a root `dev:worker` script.

### 6.2 Entry adapters (platform-foundations 5.1, rows 2 and 3)
| Entry | Context | Failure |
|---|---|---|
| Scheduled job | One run per Market of `MarketRegistry.hostedMarketIds()`, each: `MarketContextFactory.forMarket` → `systemActor(market)` → a newly generated correlation id → `createCallContext` | One Market's failure (error or throw) is logged and the next Market still runs |
| Consumed event | The envelope's `market_id` through the factory (an unhosted Market is dead-lettered, 5.4), the system actor (ADR-0018 decision 4: events carry no actor), the envelope's correlation id (generated by us, never caller-chosen: ADR-0020 decision 8) | 5.4 |

Both adapters live in `platform/` and are the only callers of `systemActor` besides tests (rule
5 of 8.2). Handlers and jobs are use cases: they declare the `system` access rule (6.2 of
platform-foundations), which no HTTP actor satisfies.

## 7. Scheduler (ADR-0006 decision 7; ADR-0005 decision 6)

### 7.1 Mechanism
| Option | For | Against |
|---|---|---|
| A. Session-level `pg_try_advisory_lock` per job | ADR-0006 decision 7 wording | With a connection pool the lock and unlock can land on different connections; a lock can leak with a pooled connection |
| B. A lease table only (`SKIP LOCKED`) | Durable state | Not what the ADR names; reinvents the lock |
| **C (chosen). Transaction-level `pg_try_advisory_xact_lock(job key, market key)` as the first statement of each per-Market run's unit, plus one state row read and written under that lock** | Same function family as the ADR; the lock is released by commit or rollback, so no leak; the state row makes a run at most once per period across replicas | One small table; each run is one transaction, so a job processes a bounded batch per run |

Flow per job and Market, in the `worker` role, checked every 30 s: open a `run` unit for the
system `CallContext` with the job's timeout → take the xact lock (false: another worker has it,
skip) → read `platform.job_state(job, market_id)` → if `last_started_at` is within the job's
period, skip → do the work (bounded batch) → write `last_started_at`, `last_finished_at`,
`last_outcome` (`ok` or the error code) → commit. A thrown run rolls back, including the state
row, so the next check retries. No new runtime service (ADR-0018 consequences).

```ts
interface JobDefinition {
  readonly name: string;                 // '<module>.<subject>.<verb>', starts with the module
  readonly every: Temporal.Duration;     // Phase 2: interval schedules only
  readonly timeout: Temporal.Duration;   // unit timeout, default 60 s
  run(ctx: CallContext): Promise<Result<void, { readonly code: string }>>;
}
```
Jobs are registered at bootstrap in a sealed `JobRegistry` (seal rules as in 4.3). Zone-aware
local-time schedules (ADR-0005 decision 6: "at 09:00 in the owning party's zone") are added with
their first consumer (certification, Phase 3); no Phase 2 job needs one. Lock keys are derived
from the job name and Market code by a fixed hash in `platform/`; a collision only serialises
two runs, never skips one wrongly, because the state row is per job and Market.

### 7.2 Jobs
| Job | Slice | Owner | Work per run |
|---|---|---|---|
| `platform.outbox.purge` | 1 | platform | Delete outbox rows published more than 7 days ago, per registered outbox, batch 5 000 |
| `platform.event-delivery.purge` | 1 | platform | Delete `done` and `rejected` deliveries older than 30 days; `dead` rows are kept until redriven or cleared by an operator |
| Expired and revoked sessions purge | 2 | identity | Lifetimes are identity G2 (ADR-0018 decision 9) |
| Expired single-use links purge (email verification, reset, invitations) | 3, 4, 8 | identity | Lifetimes are identity G2; a used or expired link must stay unusable whether or not the row is purged |
| Sign-in record retention | 7 | identity | Only if I8 puts sign-in records in an identity-owned table; the retention period is set in identity's G2 data design |
| Login throttle counters | 2 | identity | Only if I11 keeps counters in PostgreSQL |

The two platform purges make slice 1 the first consumer of the scheduler, as brief section 11
row 1 requires. The retention values (7 and 30 days) are technical and reversible; they are
constants in `platform/` and change by PR.

## 8. "Model to owning module" rule (I14; ADR-0004 decision 3; ADR-0008 decision 6)

### 8.1 Generated map
`scripts/generate-model-map.mjs`, run by `pnpm db:generate` right after `prisma generate`,
reads `prisma/schema/*.prisma` with the same parsing as `scripts/check-prisma-boundaries.mjs`
(file name = module = schema, already enforced) and writes
`apps/api/src/generated/model-map.ts` (git-ignored with the Prisma client):
`{ model, delegate, module, schema, marketScoped, relationFields }` per model, and the list of
`<module>.outbox` / `<module>.inbox` tables. `platform.prisma` maps to the pseudo-module
`platform`. The generator fails on a model without `marketId` that is not on its named list
(3.2). Used by the ESLint rule, the guard (3.2, 3.4) and the relay (5.1).

### 8.2 Tool and placement
| Option | For | Against |
|---|---|---|
| dependency-cruiser | Already runs in `pnpm boundaries` | Sees imports, not `client.identityAccount` member access: cannot express the rule |
| Custom text script | No type information needed | Delegate names such as `account` collide with ordinary properties: false positives and misses |
| **Custom type-aware ESLint rule (chosen)**, local plugin in `tools/eslint-rules/`, no new dependency | typescript-eslint's type services are already on (`projectService: true`); it reports only member access on the Prisma client or transaction-client types | One local rule to maintain, with fixtures |

Rule `model-owned-by-module`: in `src/modules/<m>/**`, a delegate access on a Prisma client type
whose model's module is not `<m>` is an error; platform models are errors in all of
`src/modules/`. In `src/platform/**`, only `platform` models, except the **named exception**:
the relay, delivery and purge files in `platform/persistence/events/` may access any module's
outbox and inbox (in practice through tagged raw SQL, 3.3; the exception covers both forms). It
runs in `pnpm lint` (part of `pnpm verify` and CI); fixtures under
`apps/api/test/boundary-fixtures/` (a module-alpha repository touching a beta model, a module
touching `AuditLog`, the platform exception file) are asserted in
`apps/api/test/boundaries.spec.ts`, as for the existing ESLint rules. The run-time check of 3.4
is the second layer.

### 8.3 Changes to existing boundary rules
| Rule | Change |
|---|---|
| `persistence-internals-are-private` (dependency-cruiser) | `modules/<m>/infrastructure/` may import only `persistence.module.ts`, `scoped-prisma.ts` and `unit-of-work.ts`; `application/` only `unit-of-work.ts` (no Prisma type in it); everyone else as today (ADR-0015 decision 5). `PrismaService` / the base client becomes private to `platform/persistence/`. Existing fixtures `infrastructure/uses-prisma-service.ts` change from allowed to reported |
| `prisma-only-in-infrastructure` | Unchanged (the generated types are still imported by repositories) |
| ESLint, new | `no-restricted-properties` on `$queryRawUnsafe`/`$executeRawUnsafe` everywhere; `no-restricted-syntax` on `$queryRaw`/`$executeRaw` in `src/modules/**` (3.3) |

## 9. Slice placement and items (identity slice 1)

All items are in slice 1 (platform-foundations section 2 rows 5 to 7; brief section 11 row 1),
start after slice 0 items 1 to 7 are merged (role separation first: every new table gets
explicit grants to the application role), and each is its own PR. One migration PR open at a
time.

| # | Item | Size | Owner / review | Depends on |
|---|---|---|---|---|
| P1 | `platform/persistence` restructure: base client provider, guarded client, ALS scope, `UnitOfWork`, `ScopedPrisma`, `PersistenceModule.forModule`, `DatabaseProbe` on the base client; boundary change 8.3; the three "to verify" points of 3.6 | M | Hossein; Hassan reviews | Slice 0 |
| P2 | Model map generator (8.1) and the market guard (3), with the unit and database tests of 3.7 | M | Hossein; **Hassan reviews the guard (mandatory)**; Mojtaba checks the map against the schema rules | P1 |
| P3 | ESLint `model-owned-by-module` and raw-SQL restrictions, fixtures | S–M | Hossein | P2 |
| P4 | Kernel `PendingDomainEvent`/`DomainEvent`; `OutboxWriter`, `EventContractRegistry`, contracts test | M | Hossein; Hassan reviews the contracts test | P1 |
| P5 | Migration: `identity.outbox`, `identity.inbox`, `platform.event_delivery`, `platform.job_state`, grants and `down.sql` | M | Mojtaba designs and signs off (identity G2 data design); Hossein generates | Slice 0 item 7; P1 |
| P6 | Relay, `EventBus` port and durable in-process adapter, `SubscriberRegistry`, delivery worker, inbox adapter, retries and dead-letter | L | Hossein; Hassan reviews | P4, P5 |
| P7 | `APP_ROLE`, worker composition, entry adapters of 6.2, `dev:worker` script, `.env.example`, CI boot probe for both roles | M | Hossein; Kazem for CI and scripts | P6 |
| P8 | `JobRegistry`, scheduler, the two platform purge jobs | M | Hossein | P5, P7 |

`identity.inbox` is created in slice 1 although identity consumes nothing yet (an empty table,
negligible cost): it lets P6 test the consumer path end to end with a test-only subscriber
registered in the test module, and it fixes the pattern for every later module.

### 9.1 Tests (in addition to 3.7)
| What | Kind |
|---|---|
| `run`: ok commits; error `Result` commits nothing (module row, outbox row, subject-key row all absent); throw rolls back and rethrows; nested `run` throws; `read` inside `run` does not see uncommitted rows; unminted context refused (literal, spread, JSON copy); isolation level asserted (`SHOW transaction_isolation` inside a unit) | Database, both fixtures |
| `append` outside `run` throws; a type of another module throws; an unregistered type throws; payload schema violation throws; stamped fields equal the scope's context, `FixedClock` time and `SequenceIdGenerator` id | Unit + database |
| Contracts test: a fixture contract with a free `z.string()` fails it | Unit |
| Relay: rows of AU and ZZ are both fanned out, each delivery carries its own Market; two concurrent relays never fan out a row twice; crash between claim and commit loses nothing | Database |
| Delivery: duplicate delivery runs the handler once (inbox); error `Result` → `rejected`; throw → backoff then `dead` after 10, with the log line and no payload; unhosted Market → `dead` at once; handler runs with a system actor of the envelope's Market | Database, both fixtures |
| Scheduler: two concurrent runners execute a job once per Market per period; a failure in AU does not stop ZZ; state row rolled back on throw | Database |
| `APP_ROLE`: missing or unknown value refuses to start; `api` starts no relay or scheduler; `worker` opens no port; composition root binds the real Clock and IdGenerator in both roles | Unit + CI boot probe |
| No personal data (AC 12): the contracts test, plus a database assertion over every slice 1 test's outbox rows that payloads hold only ids, enums, instants | Database |

### 9.2 Dependencies
None. Prisma 7 (query extensions, interactive transactions, extended unique where), `pg`,
`zod` and `node:async_hooks` are already declared or built in. Nothing here needs Node 24
specifically; the container's Node 22 can run the experiments, but the PR evidence is on the
ADR-0014 minimum (24.9) as usual.

## 10. Tables for Mojtaba (physical design in identity's G2 data design)

| Table | Logical content | Access paths that need an index |
|---|---|---|
| `<module>.outbox` (slice 1: `identity.outbox`) | 4.1 | Relay claim: unpublished, per Market, `(occurred_at, event_id)`; purge: published before T |
| `<module>.inbox` (slice 1: `identity.inbox`) | `event_id`, `handler`, `market_id`, `tenant_id`, `processed_at`; PK `(event_id, handler)` | PK only; retention/purge is open (Q3 below) |
| `platform.event_delivery` | ADR-0006 decision 4 columns (`event_id`, `subscriber`, `status`, `attempts`, `next_attempt_at`) plus `market_id`, `tenant_id`, `event_type`, `envelope` (`jsonb` copy, so the worker reads one table and outbox retention is independent), `locked_until`, `last_error_code`, `completed_at`, `dead_at`; PK `(event_id, subscriber)`; `status` CHECK `pending`/`done`/`rejected`/`dead` | Claim: pending, per Market, `next_attempt_at`; purge: terminal before T; dead list per Market |
| `platform.job_state` | `job`, `market_id`, `tenant_id`, `last_started_at`, `last_finished_at`, `last_outcome`; PK `(job, market_id)` | PK only |

All instants from `Clock` (no SQL `now()`), market and tenant columns per platform-foundations
3.3, CHECKs mirroring the code patterns (`type`, `job` and handler names, correlation id). Grants:
the application role needs `INSERT, SELECT, UPDATE, DELETE` on these four (they are queues and
state, not history), which differs from `audit_log`.

## 11. Risks and trade-offs

| Choice | Cost accepted | Revisit when |
|---|---|---|
| Every module query inside a scope | Reads also go through `read`; one more call per query path | Never for writes; for reads only with evidence of real friction |
| Nested `run` refused | No synchronous cross-module write in one transaction | Never in the monolith (ADR-0004 decision 5); a saga uses events |
| Equality guard, nested writes refused | Repositories write children one statement at a time; guard code to maintain across Prisma upgrades (exhaustive test catches new operations) | Measured statement overhead matters |
| Writer stamps `occurredAt` | Append instant, not the domain decision instant (ms apart, same unit) | A consumer needs the exact decision time: put it in the payload |
| Polling relay and worker (500 ms) | Idle queries per Market per poll | Many Markets per stack or latency needs: `LISTEN/NOTIFY` as a wake-up, same tables |
| Inbox kept beside delivery rows | One extra insert per handled event | Never: it is the broker-swap guarantee |
| Lease-based delivery claim | A crashed handler waits up to 60 s before retry | Handlers that need a longer lease declare one |
| xact advisory lock + state row | A job's work is one transaction per run, bounded batch | A job needs long-running work: split into batches across runs |
| Envelope copied into delivery rows | Storage per subscriber | Volume makes it matter: read back from the outbox instead |
| Worker without HTTP | No liveness endpoint in Phase 2 | Phase 7 `infra/` |

Main risk: the guard is the only run-time defence against a wrong-Market query; a gap in it is
silent. Mitigations: default deny on operations, the database tests on two Markets, Hassan's
mandatory review of P2, composite foreign keys (3.2 recommendation), and the run-time ownership
check (3.4).

## 12. ADR impact

No new ADR and no amendment is needed; every choice is inside an Accepted decision:

| ADR | Relation |
|---|---|
| ADR-0004 decision 3 | The guard is stricter (equality, create data, raw policy); the Prisma client becomes reachable by modules only through `ScopedPrisma`: stricter than "imported only from infrastructure" |
| ADR-0004 decision 5 | Implemented as written; "facade calls never join" becomes "nested `run` is refused" |
| ADR-0006 decision 4 | `platform.event_delivery` gains physical columns beyond the five listed; the listed ones are kept |
| ADR-0006 decision 7 | Uses the transaction-level variant `pg_try_advisory_xact_lock` of the named function, plus a state row. **For Ali to confirm** that this needs no wording note; if he wants one, it is a one-line inline note, not a new decision |
| ADR-0015 decision 5 | Unchanged for code outside infrastructure and persistence |
| ADR-0018 decision 4 | Handlers and jobs run as the system actor with the `system` rule |

## 13. Inputs to reviewers

| # | For | Question or check |
|---|---|---|
| Q1 | Hassan | Equality guard, refused nested writes, raw policy and error codes (3); the no-free-string contract walk (4.3); dead-letter logging without payload (5.4) |
| Q2 | Mojtaba | The four tables of 10; composite FKs with `market_id` inside a module schema (3.2); whether `envelope jsonb` in delivery rows is acceptable or he prefers read-back from the outbox |
| Q3 | Mojtaba, Hossein | Inbox retention: keep `(event_id, handler)` for ever (small rows) or purge after the delivery retention (30 days) plus a margin; recommended: purge after 90 days, since redelivery after that is impossible once the delivery row is gone |
| Q4 | Hossein | The three Prisma checks of 3.6 and the zod introspection of 4.3, in P1 and P4; typing of the extended client in repositories |
| Q5 | Kazem | `APP_ROLE` in CI boot probes and Docker Compose; `dev:worker`; worker probe in Phase 7; the dead-letter log line as the alert until metrics exist |
| Q6 | Ali | ADR-0006 decision 7 wording (12) |
| Q7 | Identity G2 (sibling designs) | Two sequential units for a recorded failed sign-in (2.3); event names and payloads; lifetimes and retention of 7.2 |

**Owner decisions:** none. Every choice here is technical and reversible (ADR-0013 decision 5);
no dependency is requested.
