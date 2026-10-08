import type { MarketContext } from '@mondapac/shared-kernel';
import { Prisma } from '../../generated/prisma/client';
import { NamedStatementRefusedError } from '../unit-of-work/errors';

/**
 * The raw SQL of the platform (platform persistence design, "P", 4.2): a closed list of named
 * statements, each with a fixed text, the Market and tenant bound here from the open unit and
 * never from the caller, and every other value a bound parameter.
 *
 * The market guard cannot read SQL, so it refuses every raw operation except one object: a
 * `Prisma.Sql` that this file built and registered in {@link approved}. The set is private,
 * holds objects by identity, and is filled only by the builders below, so a module cannot
 * forge an entry: a hand-made `Prisma.sql` is a different object and is refused. Modules
 * reach the list through `PrismaService.namedQuery`, never this file.
 */
const approved = new WeakSet<object>();

/** True for a statement built by this file (the guard's one raw exemption). */
export function isApprovedStatement(args: unknown): boolean {
  return typeof args === 'object' && args !== null && approved.has(args);
}

function approve(statement: Prisma.Sql): Prisma.Sql {
  approved.add(statement);
  return statement;
}

/**
 * `SET LOCAL lock_timeout` for the `lockTimeoutMs` option (inventory data design 4.2 L7). The
 * number is checked here as well as at the option, because `SET` takes no parameter and the
 * value is part of the text.
 */
export function lockTimeoutStatement(milliseconds: number): Prisma.Sql {
  if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 3000) {
    throw new RangeError('lock timeout out of range');
  }
  return approve(Prisma.raw(`SET LOCAL lock_timeout = '${milliseconds}ms'`));
}

/** The most stock items one `inventory.lock-stock-items` call locks (inventory data design 4.3). */
export const MAX_LOCKED_STOCK_ITEMS = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One locked stock item: the columns a stock writer decides from (inventory data design 4.3). */
export interface LockedStockItem {
  readonly id: string;
  readonly offerId: string;
  readonly variantId: string;
  readonly sourceId: string;
  readonly sellerId: string;
  readonly onHand: number;
  readonly retiredAt: Date | null;
  readonly version: number;
}

/** The checked-in list: statement name to its input and its rows. */
export interface NamedStatements {
  /**
   * Locks stock items `FOR NO KEY UPDATE`, in ascending id order, in the unit's Market and
   * tenant (inventory data design 4.3). `ids` are deduplicated; one to 1,000 of them. The call
   * fails with `rows-missing` when fewer rows come back than distinct ids were given: stock
   * items are never deleted, so a short answer is another Market's id or a bug.
   */
  readonly 'inventory.lock-stock-items': {
    readonly params: { readonly ids: readonly string[] };
    readonly row: LockedStockItem;
  };
}

export type NamedStatementName = keyof NamedStatements;
export type NamedStatementParams<K extends NamedStatementName> = NamedStatements[K]['params'];
export type NamedStatementRow<K extends NamedStatementName> = NamedStatements[K]['row'];

/** What the open unit lets the runner do: a read-write unit's transaction, nothing else. */
export interface RawRunner {
  query(statement: Prisma.Sql): Promise<unknown>;
  execute(statement: Prisma.Sql): Promise<unknown>;
}

interface RawLockedRow {
  id: string;
  offer_id: string;
  variant_id: string;
  source_id: string;
  seller_id: string;
  on_hand: number;
  retired_at: Date | null;
  version: number;
}

async function lockStockItems(
  runner: RawRunner,
  market: MarketContext,
  params: NamedStatementParams<'inventory.lock-stock-items'>,
): Promise<LockedStockItem[]> {
  const name = 'inventory.lock-stock-items';
  if (!Array.isArray(params.ids)) throw new NamedStatementRefusedError(name, 'ids-malformed');
  const ids = [...new Set(params.ids as readonly unknown[])];
  if (ids.length === 0) throw new NamedStatementRefusedError(name, 'ids-empty');
  if (ids.length > MAX_LOCKED_STOCK_ITEMS) {
    throw new NamedStatementRefusedError(name, 'ids-too-many');
  }
  if (!ids.every((id): id is string => typeof id === 'string' && UUID.test(id))) {
    throw new NamedStatementRefusedError(name, 'ids-malformed');
  }
  const statement = approve(Prisma.sql`
    SELECT s.id, s.offer_id, s.variant_id, s.source_id, s.seller_id, s.on_hand, s.retired_at, s.version
      FROM "inventory"."stock_items" AS s
     WHERE s.market_id = ${market.marketId}
       AND s.tenant_id = ${market.tenantId}
       AND s.id = ANY(${ids}::uuid[])
     ORDER BY s.id
       FOR NO KEY UPDATE OF s`);
  const rows = (await runner.query(statement)) as RawLockedRow[];
  if (rows.length !== ids.length) throw new NamedStatementRefusedError(name, 'rows-missing');
  return rows.map((row) => ({
    id: row.id,
    offerId: row.offer_id,
    variantId: row.variant_id,
    sourceId: row.source_id,
    sellerId: row.seller_id,
    onHand: row.on_hand,
    retiredAt: row.retired_at,
    version: row.version,
  }));
}

/** Runs one named statement on the open read-write unit's transaction. */
export async function runNamedStatement<K extends NamedStatementName>(
  runner: RawRunner,
  market: MarketContext,
  name: K,
  params: NamedStatementParams<K>,
): Promise<NamedStatementRow<K>[]> {
  switch (name) {
    case 'inventory.lock-stock-items':
      return (await lockStockItems(
        runner,
        market,
        params as NamedStatementParams<'inventory.lock-stock-items'>,
      )) as NamedStatementRow<K>[];
    default:
      throw new Error('Unknown named statement');
  }
}

/** Runs the `lockTimeoutMs` statement; kept beside the other approved builder. */
export async function setLockTimeout(runner: RawRunner, milliseconds: number): Promise<void> {
  await runner.execute(lockTimeoutStatement(milliseconds));
}
