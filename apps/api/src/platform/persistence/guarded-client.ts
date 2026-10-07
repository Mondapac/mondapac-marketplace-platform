import type { Prisma } from '../../generated/prisma/client';
import { marketGuardExtension } from './market-guard';
import type { ModelMap } from './model-map';
import type { PrismaRoot } from './prisma-root';
import { unitStorage } from './unit-store';

/**
 * The guarded client (platform persistence design, "P", 3.3 and 4.2): the base client with
 * the market guard applied once. Read-write units open their interactive transactions on it,
 * read-only units query it directly (ADR-0025); both reach the database only through the
 * guard. Internal to `platform/persistence/`.
 */
export function createGuardedClient(root: PrismaRoot, map: ModelMap) {
  return root.$extends(marketGuardExtension(map, () => unitStorage.getStore()));
}

export type GuardedClient = ReturnType<typeof createGuardedClient>;

/** Nest token of the guarded client; not exported from the persistence module. */
export const GUARDED_CLIENT = Symbol('GUARDED_CLIENT');

/** The client property of each model (`auditLog`): the model delegates and nothing else. */
type ModelProperty = Uncapitalize<Prisma.ModelName>;

/**
 * What `PrismaService.tx(market)` hands a repository: the model delegates of the open unit's
 * client and nothing else. No `$transaction`, no raw SQL, no `$connect`, `$disconnect`, `$on`
 * or `$extends` (ADR-0025 condition (b)); a type test proves each `$` method is absent.
 * `Prisma.TransactionClient` is assignable to it in neither direction (P 3.3).
 */
export type MarketTransaction = Readonly<Pick<GuardedClient, ModelProperty>>;

/**
 * The run-time half of condition (b): a frozen object with no prototype that holds the model
 * delegates of `client` under their client properties, read from the model map. The same
 * view type serves read-write units (on the transaction client) and read-only units (on the
 * guarded base client).
 */
export function modelDelegatesOf(client: object, map: ModelMap): MarketTransaction {
  const view: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const entry of Object.values(map.models)) {
    view[entry.clientProperty] = (client as Record<string, unknown>)[entry.clientProperty];
  }
  return Object.freeze(view) as unknown as MarketTransaction;
}
