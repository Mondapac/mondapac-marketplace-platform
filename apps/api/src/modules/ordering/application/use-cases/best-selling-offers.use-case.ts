import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { BESTSELLER_WINDOW_DAYS, MAX_RANKED_OFFERS, type RankingFailure } from '../../contracts';
import type { SalesRankingReader } from '../ports/sales-ranking.reader';

export interface BestSellingOffersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly ranking: SalesRankingReader;
  readonly clock: Clock;
}

/**
 * `ordering.best-selling-offers`: the Offers with the most paid order lines over the last
 * {@link BESTSELLER_WINDOW_DAYS} days, for the storefront's best-sellers shelf. Rule `anonymous`
 * (the shelf is public): the answer is Offer ids in rank order, never a count, an amount, a
 * customer or a seller figure. One read-only unit; the window ends at the Clock's now.
 */
export class BestSellingOffersQuery extends UseCase<
  { readonly limit: number },
  readonly Id<'Offer'>[],
  RankingFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.best-selling-offers',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BestSellingOffersDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly limit: number },
  ): Promise<Result<readonly Id<'Offer'>[], RankingFailure>> {
    const limit = input?.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RANKED_OFFERS) {
      return err({ code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] });
    }
    const since = this.deps.clock.now().subtract({ hours: BESTSELLER_WINDOW_DAYS * 24 });
    return this.deps.unitOfWork.run<readonly Id<'Offer'>[], RankingFailure>(
      context.market,
      async () => ok(await this.deps.ranking.topOffers(context.market, since, limit)),
      { readOnly: true },
    );
  }
}
