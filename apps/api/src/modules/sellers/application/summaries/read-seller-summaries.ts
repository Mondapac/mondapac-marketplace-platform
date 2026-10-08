import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerSummary } from '../../domain/seller-summary';
import type { SellerFileRepository } from '../ports/seller-file.repository';

export type { SellerSummary };

/** At most this many ids per call (sellers design 7.1; Hassan L4). */
export const MAX_SELLER_SUMMARY_IDS = 100;

export interface SellerIdsRefused {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

export type SellerSummariesFailure = SellerIdsRefused | { readonly code: 'sellers.unavailable' };

/** What the caller of a summaries use case may see beyond the existence of a file. */
export interface SummaryVisibility {
  /**
   * The draft's zone, flagged provisional, for a seller with no approved revision (Hassan L4):
   * only the `system` use case sets it. The request-actor use case runs under the `anonymous`
   * rule, which hides who calls, so it never shows the provisional zone.
   */
  readonly provisionalZone: boolean;
}

export interface SellerSummariesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
}

const logger = new Logger('SellerSummaries');

/**
 * The shared request check of the facade methods that take a set of seller ids (sellers design
 * 7.1, 7.2): at most 100 ids, each a well-formed Seller id, duplicates collapsed in the order of
 * first occurrence. A larger or malformed call is refused whole, before any read.
 */
export function parseSellerIds(
  sellerIds: readonly string[],
): Result<Set<Id<'Seller'>>, SellerIdsRefused> {
  if (!Array.isArray(sellerIds) || sellerIds.length > MAX_SELLER_SUMMARY_IDS) {
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
  return ok(ids);
}

/**
 * The read behind `sellerSummaries` (sellers design 7.1), shared by its two use cases
 * (`anonymous` for request actors, `system` for handlers). One read-only unit on `sellers`' own
 * rows. One entry per distinct requested id, in the order of first occurrence, so the answer
 * does not depend on row order. An id of another Market and an unknown id are byte-identical
 * (`exists: false`; AC 1). More than 100 ids, or a malformed one, refuses the whole call before
 * any read. A read that fails is `sellers.unavailable`: never an empty answer that a caller
 * could read as "no such seller". Nothing reads the actor: the answer depends only on the
 * `visibility` its use case declares. Before slice 5 no revision is approved, so every zone is
 * the draft's and provisional.
 */
export async function readSellerSummaries(
  deps: SellerSummariesDependencies,
  context: CallContext,
  sellerIds: readonly string[],
  visibility: SummaryVisibility,
): Promise<Result<readonly SellerSummary[], SellerSummariesFailure>> {
  const parsed = parseSellerIds(sellerIds);
  if (!parsed.ok) return parsed;
  const ids = parsed.value;
  if (ids.size === 0) return ok([]);
  const { market } = context;
  try {
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const existing = await deps.files.existingIds(market, [...ids]);
        const zones = visibility.provisionalZone
          ? await deps.files.draftZones(market, [...existing])
          : new Map<Id<'Seller'>, string>();
        return ok({ existing, zones });
      },
      { readOnly: true },
    );
    if (!read.ok) throw new Error('the read unit failed');
    const { existing, zones } = read.value;
    return ok(
      [...ids].map((sellerId): SellerSummary => {
        const zone = existing.has(sellerId) ? zones.get(sellerId) : undefined;
        return zone === undefined
          ? { sellerId, exists: existing.has(sellerId) }
          : { sellerId, exists: true, operatingTimezone: { zone, provisional: true } };
      }),
    );
  } catch (error) {
    logger.error({
      msg: 'sellers.seller-summaries.read-failed',
      error: error instanceof Error ? error.name : 'unknown',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'sellers.unavailable' });
  }
}
