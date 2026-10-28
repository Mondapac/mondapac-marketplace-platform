import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';
import type { QuoteRequest, QuoteResult } from '../../contracts/promotions.facade';
import { quote } from '../quote-flow';

/**
 * `promotions.quote-discounts`: the discounts of one cart, calculated on the server from the
 * prices and shipping the platform supplies (rule `system`: the caller is another module, never a
 * browser, so no client amount is trusted). With the Market switch off, or no promotions
 * settings, the answer is the cart with no discount and `enabled: false`.
 */
export class QuoteDiscounts extends UseCase<QuoteRequest, QuoteResult, PromotionsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.quote-discounts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: QuoteRequest,
  ): Promise<Result<QuoteResult, PromotionsFailure>> {
    return quote(this.deps, context, input, false);
  }
}

export type { PromotionsFailure } from '../failures';
