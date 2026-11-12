import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerCultureState } from '../../domain/seller-culture';
import { sellerActorOf } from '../draft/draft-support';
import { viewOf, type SellerCultureView } from '../cultures/seller-culture-views';
import type { CultureDirectory } from '../ports/culture-directory';
import type { SellerCultureRepository } from '../ports/seller-culture.repository';

export type SellerCulturesOwnFailure =
  { readonly code: 'access.denied' } | { readonly code: 'sellers.unavailable' };

export interface SellerCulturesOwnDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerCultures: SellerCultureRepository;
  readonly cultureDirectory: CultureDirectory;
}

/**
 * `sellers.seller-cultures-own` (multi-culture package 2; screen S1): the acting seller's cultures
 * with the status of each and the reviewer's reason. Rule `own-resources`, allowed before approval
 * (a new seller picks cultures at signup); the seller is the actor's and no input names one. A
 * culture directory that cannot answer is `sellers.unavailable`. One read-only unit, then one
 * directory call outside it.
 */
export class SellerCulturesOwn extends UseCase<
  Record<string, never>,
  { readonly cultures: readonly SellerCultureView[] },
  SellerCulturesOwnFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-cultures-own',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('SellerCulturesOwn');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerCulturesOwnDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<
    Result<{ readonly cultures: readonly SellerCultureView[] }, SellerCulturesOwnFailure>
  > {
    const result = await this.list(context);
    this.#logger.log({
      msg: 'sellers.seller-cultures-own',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async list(
    context: CallContext,
  ): Promise<
    Result<{ readonly cultures: readonly SellerCultureView[] }, SellerCulturesOwnFailure>
  > {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    let states: readonly SellerCultureState[];
    try {
      const read = await this.deps.unitOfWork.run<readonly SellerCultureState[], never>(
        market,
        async () => ok(await this.deps.sellerCultures.forSeller(market, owner.sellerId)),
        { readOnly: true },
      );
      if (!read.ok) return err({ code: 'sellers.unavailable' });
      states = read.value;
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
    const info = await this.deps.cultureDirectory.byIds(
      context,
      states.map((s) => s.cultureId),
    );
    // Fail closed: without the cultures the "needs a certificate" flag would be wrong.
    if (!info.ok) return err({ code: 'sellers.unavailable' });
    return ok({ cultures: states.map((state) => viewOf(state, info.value.get(state.cultureId))) });
  }
}
