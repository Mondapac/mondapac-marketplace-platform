import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { MAX_BOUGHT_TOGETHER, type RankingFailure } from '../../contracts';
import type { OfferPairStore } from '../ports/offer-pairs.store';

export interface BoughtTogetherDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly pairs: OfferPairStore;
}

export interface BoughtTogetherInput {
  readonly offerId: Id<'Offer'>;
  readonly limit: number;
}

/**
 * `ordering.bought-together`: the Offers most often on the same paid order as one Offer, from the
 * nightly pair table. Rule `anonymous` (the shelf is public): Offer ids in rank order, never a
 * count. One read-only unit.
 */
export class BoughtTogetherQuery extends UseCase<
  BoughtTogetherInput,
  readonly Id<'Offer'>[],
  RankingFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.bought-together',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BoughtTogetherDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BoughtTogetherInput,
  ): Promise<Result<readonly Id<'Offer'>[], RankingFailure>> {
    const limit = input?.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BOUGHT_TOGETHER) {
      return err({ code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] });
    }
    return this.deps.unitOfWork.run<readonly Id<'Offer'>[], RankingFailure>(
      context.market,
      async () => ok(await this.deps.pairs.partnersOf(context.market, input.offerId, limit)),
      { readOnly: true },
    );
  }
}
