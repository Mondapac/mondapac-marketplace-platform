import type { CallContext, Id } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SellerDeliveryQuotes } from '../../domain/delivery-quote';
import { quoteDeliveries, type DeliveryQuoteFailure } from '../delivery-quote-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/**
 * `shipping.quote-deliveries`: for each seller of the signed-in buyer's checkout, the delivery
 * methods open now and the price of each delivering method (the fleet's quote plus the Market's
 * margin), stored so checkout charges it. Rule `own-resources`: checkout asks under the signed-in
 * customer's context, with the stops of a saved address (SHP-02/03). Not exposed over HTTP by
 * shipping: ordering's checkout route answers it.
 */
export class QuoteDeliveries extends UseCase<
  { readonly sellers: unknown; readonly dropoff: unknown },
  ReadonlyMap<Id<'Seller'>, SellerDeliveryQuotes>,
  DeliveryQuoteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.quote-deliveries',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly sellers: unknown; readonly dropoff: unknown },
  ) {
    return quoteDeliveries(this.deps, context, input);
  }
}
