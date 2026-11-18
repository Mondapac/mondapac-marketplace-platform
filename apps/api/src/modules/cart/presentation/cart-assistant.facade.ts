import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { ReadAssistantOfferUnits } from '../application/use-cases/read-assistant-offer-units.use-case';
import type { ViewAssistantCart } from '../application/use-cases/view-assistant-cart.use-case';
import type {
  AssistantCart,
  AssistantCartFailure,
  AssistantOfferUnits,
  CartAssistantFacade,
} from '../contracts';

/** A throw below is an unreadable store, never an answer (fail closed). */
const UNCHECKED = { code: 'cart.check-unavailable' } as const;

/** Passes the caller's `CallContext` unchanged to one use case each, so the gate runs. */
export class CartAssistantFacadeImplementation implements CartAssistantFacade {
  constructor(
    private readonly view: ViewAssistantCart,
    private readonly units: ReadAssistantOfferUnits,
  ) {}

  async ownCart(context: CallContext): Promise<Result<AssistantCart, AssistantCartFailure>> {
    try {
      return await this.view.execute(context, {});
    } catch {
      return err(UNCHECKED);
    }
  }

  async offerUnits(
    context: CallContext,
    offerId: string,
  ): Promise<Result<AssistantOfferUnits, AssistantCartFailure>> {
    try {
      return await this.units.execute(context, { offerId });
    } catch {
      return err(UNCHECKED);
    }
  }
}
