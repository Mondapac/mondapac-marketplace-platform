# platform/persistence

Implements platform persistence design sections 3, 4, 9 and 12.3
(docs/design/domain/platform-persistence-and-events.md) and ADR-0025. This is identity
slice 1a. The outbox writer and the relay come in slice 1b.

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

## Configuration
- `DATABASE_POOL_MAX`: pool size. Integer from 1 to 100, default 10.
- The wait for a connection is fixed at 2 s (`connectionTimeoutMillis`).

## Logging
`reduceDatabaseError` reduces a database error to `{name, prismaCode, sqlState, constraint}`.
Rows, values and SQL are never logged.
