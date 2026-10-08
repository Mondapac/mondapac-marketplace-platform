import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerAccessStateCode } from '../../domain/seller-access';
import type { SellerAccessRepository } from '../ports/seller-access.repository';

const logger = new Logger('SellerAccessOf');

/** At most this many ids per call (identity design 8.1; the batch of sellers design 7.1). */
export const MAX_SELLER_IDS = 100;

/** The access of one registered seller (8.1): the state and the instant of its change. Never a reason. */
export interface SellerAccessSummary {
  readonly sellerId: Id<'Seller'>;
  readonly state: SellerAccessStateCode;
  readonly stateChangedAt: Temporal.Instant;
}

export type SellerAccessOfFailure = {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
};

export interface SellerAccessOfDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerAccess: SellerAccessRepository;
}

/**
 * The read behind `sellerAccessOf` (identity design 8.1, 8.3; ADR-0022), shared by its two use
 * cases (`anonymous` for request actors, `system` for handlers). One read-only unit. Only
 * registered sellers are answered (`seller-registered` recorded): an unknown id, an id of
 * another Market and a seller the purge may still delete are absent, which the caller reads as
 * "may not sell". Duplicates are answered once; more than 100 ids, or a malformed one, is
 * `validation.failed`.
 */
export async function readSellerAccess(
  deps: SellerAccessOfDependencies,
  context: CallContext,
  sellerIds: readonly string[],
): Promise<Result<readonly SellerAccessSummary[], SellerAccessOfFailure>> {
  if (!Array.isArray(sellerIds) || sellerIds.length > MAX_SELLER_IDS) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'length' }] });
  }
  const ids = new Set<Id<'Seller'>>();
  for (const value of sellerIds as readonly unknown[]) {
    const parsed = typeof value === 'string' ? parseId<'Seller'>(value) : null;
    if (parsed === null || !parsed.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] });
    }
    ids.add(parsed.value);
  }
  if (ids.size === 0) return ok([]);
  const { market } = context;
  const read = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.sellerAccess.findRegistered(market, [...ids])),
    { readOnly: true },
  );
  if (!read.ok) {
    // Fails closed (no seller may sell), but never silently (Mojtaba, slice 5 review).
    logger.warn({
      msg: 'identity.seller-access-of.read-failed',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok([]);
  }
  return ok(
    read.value.map((access) => ({
      sellerId: access.state.sellerId,
      state: access.state.state,
      stateChangedAt: access.state.stateChangedAt,
    })),
  );
}
