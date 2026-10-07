import type { MarketContext, Result } from '@mondapac/shared-kernel';

/**
 * Options of one unit (platform persistence design, "P", 3.1). Defaults: read-write, READ
 * COMMITTED (the database default; nothing is sent for it, ADR-0025 decision 2), 5000 ms.
 */
export interface UnitOfWorkOptions {
  /**
   * Opens no transaction (ADR-0025): `work` runs once on the guarded client, which refuses
   * every write. Refused together with `isolation` or `timeoutMs`.
   */
  readonly readOnly?: boolean;
  /** For invariants that span rows (P 3.1 row 6). */
  readonly isolation?: 'serializable';
  /** The read-write unit's timeout, at most {@link MAX_UNIT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * The transaction boundary of a use case (P 3; ADR-0004 decision 5 as amended by ADR-0023 and
 * ADR-0025). The use-case body calls `run` itself, after its authorisation and its slow work
 * (P 3.4, T1 option A); at most one read-write unit per use case.
 *
 * - `ok` commits; `err` commits nothing and is returned unchanged; an exception commits
 *   nothing and is rethrown (P 3.1 row 3).
 * - `run` inside an open unit throws `NestedUnitOfWorkError` (row 4).
 * - `work` may run up to three times on a serialisation failure or deadlock (row 7): it
 *   reloads what it changes and does nothing external (no hashing, HTTP, mail, facade or model
 *   call; row 5).
 */
export interface UnitOfWork {
  run<T, E>(
    market: MarketContext,
    work: () => Promise<Result<T, E>>,
    options?: UnitOfWorkOptions,
  ): Promise<Result<T, E>>;
}

/** Nest injection token of the {@link UnitOfWork} port. */
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

/** Prisma's default interactive-transaction timeout, the default of a read-write unit (P 3.1 row 8). */
export const DEFAULT_UNIT_TIMEOUT_MS = 5000;
/** The most a unit may ask for with `timeoutMs` (P 3.1 row 8). */
export const MAX_UNIT_TIMEOUT_MS = 30_000;
/** The longest wait for a pooled connection, in a transaction and for every statement (row 8). */
export const CONNECTION_WAIT_MS = 2000;
/** Attempts of a read-write unit on `40001` or `40P01` (row 7). */
export const UNIT_ATTEMPTS = 3;
