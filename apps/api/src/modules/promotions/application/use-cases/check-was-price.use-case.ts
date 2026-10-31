import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';
import { checkWasPrice } from '../read-flow';

interface Input {
  readonly offerId: string;
  readonly variantId: string;
  readonly price: { readonly amountMinor: bigint; readonly currency: string };
}

/**
 * `promotions.check-was-price`: may this priced unit (an Offer's Variant) show a struck-through
 * earlier price? Yes only if it sold at that price on at least the Market's minimum of days in the
 * Market's window (AU 28 of the last 90), as `pricing` measures it. The system decides; no seller
 * input reaches the answer. Anonymous: the product page asks. Unknown history is "not eligible".
 */
export class CheckWasPrice extends UseCase<
  Input,
  { readonly eligible: boolean },
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.check-was-price',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<{ readonly eligible: boolean }, PromotionsFailure>> {
    return checkWasPrice(this.deps, context, input);
  }
}
