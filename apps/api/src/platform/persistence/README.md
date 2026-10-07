# platform/persistence

Implements platform persistence design sections 3 to 9 and 12.3
(docs/design/domain/platform-persistence-and-events.md) and ADR-0025: identity slices 1a
(UnitOfWork, guard, model map) and 1b (outbox, relay, scheduler lock, `APP_ROLE`).

## What a module uses
- `UNIT_OF_WORK` (`platform/unit-of-work/unit-of-work.ts`): `run(market, work, options)`.
  - A read-write unit is one interactive transaction at READ COMMITTED, or SERIALIZABLE
    when asked.
  - An `err` result rolls back.
  - `40001` and `40P01` are retried, 3 attempts in all.
  - `55P03` becomes `TransactionConflictError` at once.
  - The HTTP filter answers 409 `conflict.retry` or `conflict.stale`.
  - A unit that is already open cannot open another (`NestedUnitOfWorkError`).
- `PrismaService.tx(market)` returns the open unit's `MarketTransaction`.
  - It is a frozen view of the model delegates only: no `$transaction` and no raw SQL.
  - It is refused outside a unit, and refused for another Market.
- Only `prisma.service.ts` may be imported from `modules/*/infrastructure`
  (dependency-cruiser rule `persistence-root-is-private`).
- A module touches only the models of its own `prisma/schema/<module>.prisma`. The check is
  `pnpm boundaries`.

## Read-only units (ADR-0025)
- `{ readOnly: true }` opens no transaction.
- `work` runs once on the guarded base client and is never retried.
- Writes are refused.
- Any query after the unit closes is refused (`unit-closed`).
- Isolation and timeout options are refused for read-only units.
- At start-up the API refuses to listen unless `default_transaction_isolation` is
  `read committed` (`databaseIsolationAccepted` in `check-database-role.ts`).

## Market guard
`market-guard.ts` is a Prisma client extension. It refuses any query that:
- runs with no open unit, or after the unit has closed;
- is raw SQL;
- has a `where`, selector or data that does not pin the unit's `marketId` and `tenantId`;
- is an upsert by id, or an upsert without a compound selector that contains `marketId`;
- is a nested write.

Models marked `/// @market-scope none: <reason>` are exempt.

The guard reads the model map: `apps/api/src/generated/model-map.ts`.
- It is written by `scripts/generate-model-map.mjs`, which runs as a Prisma generator on
  every `prisma generate`.
- It is checked against Prisma's DMMF.

## Start-up checks
`main.ts` refuses to listen when `DatabaseProbe.roleProblems()` returns any problem
(docs/design/data/platform.md 10.8). One of its reasons is `role_timeouts`: the login role's
own settings (`pg_roles.rolconfig`) must hold `statement_timeout` (at most 30 s),
`lock_timeout` (at most 3 s) and `idle_in_transaction_session_timeout` (at most 60 s), each
above zero. `scripts/db/bootstrap-dev.sql` sets them. A Compose volume created before that
change does not have them, and the API will not start on it until you run
`pnpm db:bootstrap` once.

## Configuration
- `DATABASE_POOL_MAX`: pool size. Integer from 1 to 100, default 10.
- The wait for a connection is fixed at 2 s (`connectionTimeoutMillis`).

## Logging
`reduceDatabaseError` reduces a database error to `{name, prismaCode, sqlState, constraint}`.
Rows, values and SQL are never logged.

## Events (slice 1b; P 5 and 6)
- Declare an event with `defineEvent` (kernel) in `modules/<m>/domain/events/`, re-export
  it from `contracts/`, and register it in the module's Nest module:
  `providers: [outboxWriterFor('<m>'), registerEvents('<m>', EVENTS)]`.
  - Payload fields come from `eventField` only: `id`, `enumOf`, `boolean`, `integer`,
    `instant`, `permissionKey`, `listOf`, `optional`. No kind takes free text.
  - `permissionKey` values are refused until the permission registry exists (slice 8a).
- A use case appends inside its read-write unit, after saving the aggregate:
  `await outbox.append(context, aggregate.pendingEvents)` (token `OUTBOX_WRITER`).
  - The writer stamps the event id, Market, tenant and correlation id.
  - It refuses (and so rolls the unit back) when no unit is open, in a read-only unit, for
    another Market, another module's type, a type not in the catalogue, a bad version, or a
    payload that does not match its definition.
- `outbox/` holds the writer, the relay and the in-process bus. It is the only folder that
  may name an outbox model (`pnpm boundaries`).
- The relay runs in the `worker` role only: per module outbox and hosted Market, it claims
  50 rows with `FOR UPDATE SKIP LOCKED`, publishes them to the `EventBus`, marks them, and
  commits. At least once, no order. Slice 1b has no subscriber; delivery comes in slice 3.
- `apps/api/test/contracts/event-catalogue.snapshot.json` lists every event type and its
  fields. A new type or a changed field list fails the contracts test until the snapshot
  changes (a changed list means: publish a new version).

## Scheduler and worker (slice 1b; P 7 and 8)
- A job is a `JobDefinition` in `modules/<m>/presentation/jobs/`, registered with
  `registerJobs('<m>', [job])`. It runs once per hosted Market with that Market's context
  and a new correlation id; it must be safe to run twice and at once.
- `AdvisoryJobLock` holds `pg_try_advisory_xact_lock` in its own transaction for the whole
  run, with `SET LOCAL idle_in_transaction_session_timeout = 0` (the login role's 60 s limit
  would end it otherwise).
- `APP_ROLE` (`api` or `worker`) is required, with no default. `main.ts` reads it and calls
  `startApi` or `startWorker`; both build the same module graph. The worker has no HTTP
  listener; SIGTERM stops the relay and the scheduler (up to 10 s), then closes the graph.
