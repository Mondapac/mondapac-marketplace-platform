import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AssistantCartFailure,
  AssistantOfferUnits,
} from '../../contracts/cart-assistant.facade';
import { assistantOfferUnits } from '../assistant-operations';
import type { CartDependencies } from '../cart-operations';

/**
 * `read-assistant-offer-units`: what of one Offer could be added to a cart now, with each
 * unit's price and highest quantity, for the buyer assistant's add card. Rule `anonymous`: the
 * same public facts the product page and the guest add read; no cart is read or written.
 */
export class ReadAssistantOfferUnits extends UseCase<
  { readonly offerId: string },
  AssistantOfferUnits,
  AssistantCartFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.read-assistant-offer-units',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CartDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly offerId: string }) {
    return assistantOfferUnits(this.deps, context, input?.offerId);
  }
}
