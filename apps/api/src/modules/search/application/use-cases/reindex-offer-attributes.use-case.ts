import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReindexDependencies } from '../reindex-dependencies';
import { syncOffers, SYNC_BATCH } from '../sync-offers';

export type ReindexCounts =
  | { readonly state: 'current' }
  | { readonly state: 'done'; readonly offers: number; readonly resumed: boolean };

/**
 * `search.reindex-offer-attributes`: re-reads every published Offer when what the index keeps of
 * attributes has changed (a definition's searchable or filter flag, options or names, a brand or
 * an alias), so search and the filters follow the change within minutes, not at the next
 * six-hourly rebuild. Compares catalog's stamp with the one the last full run was done for.
 * Progress (state, Offers done, cursor) is written after each page to `search.reindex_state`; a
 * run that failed or stopped resumes after its cursor when the stamp is still the same. Rule
 * `system`. It deletes nothing (the rebuild does). A failed page records `failed` and throws.
 */
export class ReindexOfferAttributes extends UseCase<Record<string, never>, ReindexCounts, never> {
  static override readonly access: AccessDeclaration = {
    name: 'search.reindex-offer-attributes',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ReindexOfferAttributes');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReindexDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<ReindexCounts, never>> {
    const { market } = context;
    const { progress, unitOfWork, clock } = this.deps;
    const unit = async <T>(work: () => Promise<T>): Promise<T> => {
      const done = await unitOfWork.run(market, async () => ok(await work()));
      if (!done.ok) throw new Error('search: the reindex unit failed');
      return done.value;
    };

    const stamp = await this.deps.stamp.current(context);
    if (stamp === null) throw new Error('search: catalog stamp unavailable');
    const state = await unit(() => progress.read(market));
    if (state !== null && state.doneStamp === stamp && state.status === 'idle') {
      return ok({ state: 'current' });
    }

    const resumes =
      state !== null &&
      state.targetStamp === stamp &&
      state.status !== 'idle' &&
      state.cursorOfferId !== null;
    let after: Id<'Offer'> | undefined = resumes ? (state.cursorOfferId ?? undefined) : undefined;
    let offers = resumes ? state.offersDone : 0;
    if (!resumes) await unit(() => progress.begin(market, stamp, clock.now()));

    try {
      for (;;) {
        const ids = await this.deps.feed.publishedIds(context, {
          ...(after === undefined ? {} : { after }),
          limit: SYNC_BATCH,
        });
        if (ids === null) throw new Error('search: catalog ids unavailable');
        if (ids.length > 0) {
          await syncOffers(this.deps, context, ids);
          offers += ids.length;
          const cursor = ids[ids.length - 1];
          if (cursor === undefined) break;
          after = cursor;
          const total = offers;
          await unit(() => progress.advance(market, total, cursor, clock.now()));
        }
        if (ids.length < SYNC_BATCH) break;
      }
    } catch (error) {
      await unit(() => progress.fail(market, 'sync-failed', clock.now()));
      throw error;
    }
    await unit(() => progress.finish(market, stamp, clock.now()));
    this.#logger.log({
      msg: 'search.attributes-reindexed',
      offers,
      resumed: resumes,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ state: 'done', offers, resumed: resumes });
  }
}
