import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SearchDependencies } from '../search-dependencies';
import { syncOffers, SYNC_BATCH } from '../sync-offers';

/** Stale documents deleted per unit. */
export const STALE_DELETE_BATCH = 500;

export interface RebuildCounts {
  readonly offers: number;
  readonly upserted: number;
  readonly deleted: number;
  readonly stale: number;
}

/**
 * `search.rebuild-offer-index`: the backfill and the safety net, for the context's Market. Pages
 * through every published Offer of catalog in id order, re-reads and upserts the sellable ones
 * (each page in its own unit), then deletes the documents this run did not touch: those of
 * Offers deleted, unlisted or moved away since, and those built with another text search
 * configuration. Rule `system`, run at worker start and every six hours by
 * `search.rebuild-index`. Safe to run twice and concurrently: each run deletes only what it
 * did not write itself, and only after every page succeeded. A failed page throws.
 */
export class RebuildOfferIndex extends UseCase<Record<string, never>, RebuildCounts, never> {
  static override readonly access: AccessDeclaration = {
    name: 'search.rebuild-offer-index',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RebuildOfferIndex');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SearchDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<RebuildCounts, never>> {
    const { market } = context;
    const startedAt = this.deps.clock.now();
    let offers = 0;
    let upserted = 0;
    let deleted = 0;
    let after: Id<'Offer'> | undefined;
    for (;;) {
      const ids = await this.deps.feed.publishedIds(context, {
        ...(after === undefined ? {} : { after }),
        limit: SYNC_BATCH,
      });
      if (ids === null) throw new Error('search: catalog ids unavailable');
      if (ids.length > 0) {
        const counts = await syncOffers(this.deps, context, ids);
        offers += ids.length;
        upserted += counts.upserted;
        deleted += counts.deleted;
      }
      if (ids.length < SYNC_BATCH) break;
      after = ids[ids.length - 1];
    }
    let stale = 0;
    for (;;) {
      const removed = await this.deps.unitOfWork.run(market, async () =>
        ok(await this.deps.documents.deleteIndexedBefore(market, startedAt, STALE_DELETE_BATCH)),
      );
      if (!removed.ok) throw new Error('search: the stale delete failed');
      stale += removed.value;
      if (removed.value < STALE_DELETE_BATCH) break;
    }
    const counts = { offers, upserted, deleted, stale };
    this.#logger.log({
      msg: 'search.index-rebuilt',
      ...counts,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(counts);
  }
}
